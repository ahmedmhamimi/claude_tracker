/**
 * Service-worker side of TokenLens Pro. Talks to Gumroad's license API (the
 * only network call TokenLens makes besides claude.ai) to activate a license
 * key, to restore it on another signed-in browser, and to re-check it every
 * few days so refunded / charged-back purchases stop unlocking Pro.
 * Only the license key and the product id are ever sent. No chat content.
 *
 * Loaded by background.js via importScripts inside try/catch. Messages are
 * {cts: 'lic', op} and only accepted from this extension (claude.ai content
 * scripts or the extension's own pages); activate/restore only from extension pages.
 *
 * Storage: chrome.storage.local.cts_license = {key, status: 'active'|'revoked', reason?, activatedAt, lastOk, lastTry, uses}
 *          chrome.storage.sync.cts_license_key = key (lets the buyer's other signed-in browsers restore without a new activation)
 *
 * - verify(key, increment) -> Promise<{ok, uses?, purchase?, reason?}>: one Gumroad verify call; reason in 'permission'|'network'|'invalid'|'refunded'|'chargeback'.
 * - activate(key) -> Promise<{ok, reason?}>: checks the activation cap, verifies with increment, stores the license.
 * - restore() -> Promise<{ok, reason?}>: verifies the key synced from another browser WITHOUT counting a new activation.
 * - recheck() -> Promise<{ok, checked?, revoked?}>: re-verifies when due (every 7 days); revokes only on a definite refund/chargeback/invalid answer.
 * - deactivate() -> Promise<{ok}>: removes the license from this browser only.
 * - openUnlock() -> Promise<void>: opens (or focuses) the unlock page.
 *
 * @requires license-core.js
 */

(function () {
  'use strict';

  const C = self.CTS_LicenseCore;
  if (!C) return;
  const CFG = C.CONFIG;
  const origins = { origins: [CFG.HOST_ORIGIN] };

  const getLic = async () => (await chrome.storage.local.get(['cts_license'])).cts_license || null;
  const setLic = lic => chrome.storage.local.set({ cts_license: lic });
  const syncKey = key => chrome.storage.sync.set({ cts_license_key: key }).catch(() => {});
  const dropSyncKey = () => chrome.storage.sync.remove('cts_license_key').catch(() => {});

  async function hasPermission() {
    try { return await chrome.permissions.contains(origins); } catch (_) { return false; }
  }

  async function verify(key, increment) {
    if (!(await hasPermission())) return { ok: false, reason: 'permission' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    let res, json = null;
    try {
      res = await fetch(CFG.VERIFY_URL, {
        method: 'POST', cache: 'no-store', credentials: 'omit', signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ product_id: CFG.PRODUCT_ID, license_key: key, increment_uses_count: increment ? 'true' : 'false' }).toString(),
      });
      try { json = await res.json(); } catch (_) { json = null; }
    } catch (_) {
      return { ok: false, reason: 'network' };
    } finally { clearTimeout(timer); }

    if (res.ok && json && json.success === true) {
      const p = json.purchase || {};
      if (p.refunded === true) return { ok: false, reason: 'refunded' };
      if (p.chargebacked === true || (p.disputed === true && p.dispute_won !== true)) return { ok: false, reason: 'chargeback' };
      return { ok: true, uses: Number(json.uses) || 0, purchase: p };
    }
    if (json && json.success === false) return { ok: false, reason: 'invalid' };   // Gumroad answers 404 + success:false for unknown keys
    return { ok: false, reason: 'network' };                                       // 5xx, 429, HTML error page, anything unexpected: never punish the buyer
  }

  async function activate(key) {
    key = String(key || '').trim();
    if (!C.keyLooksValid(key)) return { ok: false, reason: 'invalid' };
    const peek = await verify(key, false);                       // read the use count first, so a rejected key does not burn an activation
    if (!peek.ok) return peek;
    if (peek.uses >= CFG.MAX_ACTIVATIONS) return { ok: false, reason: 'limit' };
    const done = await verify(key, true);
    if (!done.ok) return done;
    const now = Date.now();
    await setLic({ key, status: 'active', activatedAt: now, lastOk: now, lastTry: now, uses: done.uses });
    await syncKey(key);
    return { ok: true };
  }

  async function restore() {
    let key = '';
    try { key = (await chrome.storage.sync.get(['cts_license_key'])).cts_license_key || ''; } catch (_) {}
    if (!C.keyLooksValid(key)) return { ok: false, reason: 'none' };
    const r = await verify(key, false);                          // no increment: this is the same buyer's other browser
    if (!r.ok) return r;
    const now = Date.now();
    await setLic({ key, status: 'active', activatedAt: now, lastOk: now, lastTry: now, uses: r.uses });
    return { ok: true };
  }

  async function recheck() {
    const lic = await getLic();
    const now = Date.now();
    if (!lic || lic.status !== 'active' || !lic.key) return { ok: true, checked: false };
    if (now - (lic.lastOk || 0) < CFG.RECHECK_MS || now - (lic.lastTry || 0) < 60 * 60 * 1000) return { ok: true, checked: false };
    const r = await verify(lic.key, false);
    if (r.ok) { await setLic(Object.assign({}, lic, { lastOk: now, lastTry: now, uses: r.uses })); return { ok: true, checked: true }; }
    if (r.reason === 'refunded' || r.reason === 'chargeback' || r.reason === 'invalid') {
      await setLic(Object.assign({}, lic, { status: 'revoked', reason: r.reason, lastTry: now }));
      await dropSyncKey();
      return { ok: true, checked: true, revoked: true };
    }
    await setLic(Object.assign({}, lic, { lastTry: now }));      // offline / Gumroad down / permission removed: keep Pro until the grace window ends
    return { ok: true, checked: false };
  }

  async function deactivate() {
    await chrome.storage.local.remove('cts_license');
    await dropSyncKey();
    return { ok: true };
  }

  async function openUnlock() {
    const url = chrome.runtime.getURL('unlock.html');
    const tabs = await chrome.tabs.query({ url });
    if (tabs.length) { await chrome.tabs.update(tabs[0].id, { active: true }); try { await chrome.windows.update(tabs[0].windowId, { focused: true }); } catch (_) {} return; }
    await chrome.tabs.create({ url });
  }

  const OPS = { activate, restore, recheck, deactivate, 'open-unlock': openUnlock };
  const EXT_ONLY = new Set(['activate', 'restore', 'deactivate']);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.cts !== 'lic' || typeof msg.op !== 'string' || !OPS[msg.op]) return false;
    if (!sender || sender.id !== chrome.runtime.id) { sendResponse({ ok: false, reason: 'forbidden' }); return false; }
    const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));   // the unlock page runs in a tab, so sender.tab is set for it too
    const fromClaude = !!sender.tab && /^https:\/\/claude\.ai\//.test(sender.url || sender.tab.url || '');
    if (!(fromExtensionPage || fromClaude) || (EXT_ONLY.has(msg.op) && !fromExtensionPage)) { sendResponse({ ok: false, reason: 'forbidden' }); return false; }
    Promise.resolve().then(() => OPS[msg.op](msg.key)).then(r => sendResponse(r === undefined ? { ok: true } : r), () => sendResponse({ ok: false, reason: 'network' }));
    return true;
  });
})();
