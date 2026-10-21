/**
 * TokenLens Pro state for the claude.ai pages (ISOLATED world). Tracks the
 * 7-active-day free trial (all features), reads the stored Gumroad license,
 * and answers "may this feature run?" for every other module. It never talks
 * to Gumroad itself: activation and re-checks happen in the service worker
 * (license-sw.js); this module only asks it to re-check when due.
 *
 * Feature ids: 'export.md' is always free. Everything else ('export.pdf',
 * 'export.txt', 'export.json', 'bulk', 'search.full', 'history.range',
 * 'alerts.full', 'pace', 'handoff', 'themes') needs a license or an active trial.
 *
 * - CTS_License.ready -> Promise<void>: resolves once license + trial are loaded; await it before async gating decisions.
 * - CTS_License.allows(featureId) -> boolean: true for free features, and for everything while licensed or in trial.
 * - CTS_License.gate(featureId, ctx?) -> boolean: allows() plus, when locked, shows the paywall (CTS_Paywall.show) for that feature.
 * - CTS_License.state() -> {licensed, pro, tier, trial, revoked, price}: current summary (tier 'licensed'|'trial'|'free').
 * - CTS_License.openUnlock() -> Promise: opens the unlock page (buy / paste key) through the service worker.
 * - CTS_License.openCheckout() -> void: opens the Gumroad checkout in a new tab.
 * - CTS_License.onChange(cb) -> void: cb() after the tier or trial day changes.
 * - CTS_License.free -> {exportFormats, searchResults, historyDays}: the free-tier limits.
 *
 * @requires safe.js, license-core.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe, Core = window.CTS_LicenseCore, CFG = Core.CONFIG;
  const listeners = [];
  let lic = null, trial = null, summary = Core.summarize(null, null, Date.now()), loaded = false, lastSig = '';

  // chrome.storage callbacks return undefined, so the "did it run?" signal must be explicit.
  const area = (name, op, arg) => new Promise(res => {
    const ran = Safe.chromeCall('license', () => {
      chrome.storage[name][op](arg, v => { void chrome.runtime.lastError; res(v || {}); });
      return true;
    });
    if (ran !== true) res({});
  });
  const send = msg => new Promise(res => {
    const ran = Safe.chromeCall('license', () => {
      chrome.runtime.sendMessage(Object.assign({ cts: 'lic' }, msg), r => { void chrome.runtime.lastError; res(r || { ok: false }); });
      return true;
    });
    if (ran !== true) res({ ok: false });
  });

  function recompute() {
    summary = Core.summarize(lic, trial, Date.now());
    const sig = [summary.tier, summary.trial.day, summary.revoked].join('|');
    if (sig !== lastSig) { lastSig = sig; listeners.slice().forEach(cb => Safe.run('license', cb)); }
  }

  async function load() {
    const [local, sync] = await Promise.all([area('local', 'get', ['cts_license', 'cts_trial']), area('sync', 'get', ['cts_trial'])]);
    lic = local.cts_license || null;
    trial = Core.mergeTrial(local.cts_trial, sync.cts_trial);
    loaded = true;
    recompute();
    return { local, sync };
  }

  // Count today as a trial day once the tab is really visible. Both areas are written so a reinstall cannot restart the trial.
  async function touchToday() {
    if (document.visibilityState !== 'visible') return;
    const run = async () => {
      const { local, sync } = await load();
      const next = Core.advanceTrial(trial, Date.now());
      const same = rec => JSON.stringify(Core.mergeTrial(rec, null)) === JSON.stringify(next);
      if (!same(local.cts_trial)) await area('local', 'set', { cts_trial: next });
      if (!same(sync.cts_trial)) await area('sync', 'set', { cts_trial: next });
      trial = next;
      recompute();
    };
    if (navigator.locks && navigator.locks.request) await navigator.locks.request('cts-trial', run); else await run();
  }

  const ready = (async () => {
    await touchToday();
    if (!loaded) await load();
    Safe.run('license', () => setTimeout(() => send({ op: 'recheck' }), 4000));   // the service worker decides whether a check is actually due
  })().catch(() => { loaded = true; });

  Safe.chromeCall('license', () => chrome.storage.onChanged.addListener((ch, areaName) => {
    if (areaName === 'local' && (ch.cts_license || ch.cts_trial)) Safe.run('license', () => load());
  }));
  document.addEventListener('visibilitychange', () => Safe.run('license', touchToday));
  setInterval(() => Safe.run('license', touchToday), 5 * 60 * 1000);

  const allows = id => {
    if (id === 'export.md') return true;
    return loaded && summary.pro;
  };

  function gate(id, ctx) {
    if (allows(id)) return true;
    Safe.run('license', () => { if (window.CTS_Paywall) window.CTS_Paywall.show(id, ctx); });
    return false;
  }

  window.CTS_License = {
    ready, allows, gate,
    state: () => Object.assign({ price: CFG.PRICE_LABEL }, summary),
    openUnlock: () => send({ op: 'open-unlock' }),
    openCheckout: () => { window.open(CFG.CHECKOUT_URL, '_blank', 'noopener'); },
    onChange: cb => listeners.push(cb),
    free: Core.FREE,
  };
})();
