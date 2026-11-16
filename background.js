/**
 * Service worker: install onboarding + uninstall feedback.
 *
 * On a fresh install:
 *   1. Flag the first-run welcome splash (shown once by welcome.js).
 *   2. Look for open claude.ai tabs.
 *        - Found: reload every one of them (tabs that predate the install have
 *          no TokenLens in them until they reload) and jump straight to one.
 *        - None:  open Claude and jump straight to it.
 * Always register the uninstall survey, so we learn why people leave.
 *
 * Also loads the TokenLens Pro license worker (license-core.js, license-sw.js:
 * Gumroad activation, restore and weekly re-check). It is imported in its own
 * try/catch, so a failure there can never affect onboarding or the 6.0 store.
 *
 * - flagWhatsNew() -> Promise<void>: marks the one-time "what's new" bubble for updated installs.
 * - onFreshInstall() -> Promise<void>: sets first-run flags, then reloads or opens a claude.ai tab.
 * - pickTarget(tabs) -> tab: the claude.ai tab to land on.
 * - focusTab(tab) / focusWindow(windowId) -> Promise<void>: bring a tab / window to the front.
 * - flagFeedback() -> Promise<void>: stamps when the feature-request prompt may first appear.
 */

// TokenLens 6.0 store + message router (history, search, export index).
// Wrapped so a failure here can never break install/uninstall handling below.
try {
  importScripts(
    'shared.js', 'conversation.js', 'history.js', 'search-index.js',
    'folders.js', 'store-core.js', 'store-idb.js', 'sw-router.js'
  );
} catch (e) {
  console.warn('TokenLens: 6.0 store failed to load', e);
}

// TokenLens Pro (Gumroad license worker). Separate try/catch: independent of everything above and below.
try {
  importScripts('license-core.js', 'license-sw.js');
} catch (e) {
  console.warn('TokenLens: license worker failed to load', e);
}

const UNINSTALL_SURVEY_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSebfiCqmt3fijuJQe60k0HmC7HwpdWN2ruyx0AmpOckBHWg8g/viewform?usp=publish-editor';

const CLAUDE_MATCH = 'https://claude.ai/*';
const CLAUDE_NEW = 'https://claude.ai/new';

// Which existing Claude tab to land on after the reload:
//   'recent' - the one the person used most recently (default)
//   'last'   - the last one in tab order
const TARGET_TAB = 'recent';

// Runs every time the service worker starts, which keeps the URL registered
// across browser restarts and extension updates.
chrome.runtime.setUninstallURL(UNINSTALL_SURVEY_URL);

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'update') {
    flagWhatsNew().catch(() => {});
    flagFeedback().catch(() => {});
    flagVamimi(details.previousVersion).catch(() => {});
    return;
  }
  if (details.reason !== 'install') return;
  onFreshInstall().catch(() => {
    // Never leave the person with nothing: fall back to a plain new tab.
    chrome.tabs.create({ url: CLAUDE_NEW, active: true });
  });
});

// ─── "What's new" for existing users ────────────────────────────────────────
// cts_whatsnew_hide: 'pending' -> ui.js should show the one-time bubble that
//                                 explains the new hide (X) button.
//                    'done'    -> shown, or never meant for this person.
//
// Fresh installs are stamped 'done' (see onFreshInstall): they discover the
// button through the normal welcome + hint flow. Only an *update* of an install
// that has no stamp yet (i.e. someone who had TokenLens before this feature
// existed) is flagged 'pending'. Later updates leave an existing stamp alone,
// so the bubble can never come back.
async function flagWhatsNew() {
  const s = await chrome.storage.local.get(['cts_whatsnew_hide', 'cts_show_welcome']);
  if (s.cts_whatsnew_hide !== undefined) return;
  // Still hasn't seen the welcome splash: effectively new, so skip the notice.
  const value = s.cts_show_welcome === true ? 'done' : 'pending';
  await chrome.storage.local.set({ cts_whatsnew_hide: value });
}

async function onFreshInstall() {
  // The flag must be in storage before any Claude page (re)loads, so the
  // welcome splash is picked up by the tab the person lands on.
  await chrome.storage.local.set({
    cts_show_welcome: true,
    cts_installed_at: Date.now(),
    cts_whatsnew_hide: 'done', // new users never get the "what's new" notice
    // VamimiAI announcement: a new user's first days belong to TokenLens.
    cts_vm_ann: { status: 'waiting', minDays: VM_NEW_USER_DAYS },
  });

  const tabs = await chrome.tabs.query({ url: CLAUDE_MATCH });

  if (!tabs.length) {
    const tab = await chrome.tabs.create({ url: CLAUDE_NEW, active: true });
    await focusWindow(tab.windowId);
    return;
  }

  const target = pickTarget(tabs);

  // Go there first so the person never waits, then refresh everything. The
  // target is reloaded first so it is the tab that shows the welcome splash.
  await focusTab(target);
  const ordered = [target, ...tabs.filter(t => t.id !== target.id)];
  await Promise.all(ordered.map(t => chrome.tabs.reload(t.id).catch(() => {})));
}

function pickTarget(tabs) {
  if (TARGET_TAB === 'last') return tabs[tabs.length - 1];
  // lastAccessed exists on Chrome 121+; without it fall back to the last tab.
  if (tabs.every(t => typeof t.lastAccessed !== 'number')) return tabs[tabs.length - 1];
  return tabs.reduce((best, t) => ((t.lastAccessed || 0) > (best.lastAccessed || 0) ? t : best));
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await focusWindow(tab.windowId);
}

async function focusWindow(windowId) {
  if (windowId == null) return;
  try {
    const win = await chrome.windows.get(windowId);
    const patch = { focused: true };
    if (win.state === 'minimized') patch.state = 'normal';
    await chrome.windows.update(windowId, patch);
  } catch (e) { /* window gone or not focusable: the tab is still active */ }
}

// ─── Feature-request prompt: who counts as "established" ────────────────────
// feedback.js asks long-time users "what should we build next?". Chrome gives an
// extension no install date, so we rely on what we recorded ourselves:
//   - installs from the welcome-splash era have cts_installed_at,
//   - everyone who has had review.js has cts_first_seen.
// People who predate both have neither. For them, evidence that the extension
// actually ran before (a cached org id / usage reading / the drag hint) marks
// them as `cts_fb_legacy`: established, pending a few real days of use after
// this update. Without any such evidence they are treated as brand new.
//
// Every updated install also gets `cts_fb_after`: 1 to 3 days from now, random
// so ~800 people are not all asked at the same moment right after the update.
// Stamped once, ever: later updates leave it alone.
const DAY_MS = 864e5;

async function flagFeedback() {
  const s = await chrome.storage.local.get([
    'cts_fb_since', 'cts_installed_at', 'cts_first_seen',
    'cts_org_id', 'cts_5h_util', 'cts_hint_seen',
  ]);
  if (s.cts_fb_since) return;

  const now = Date.now();
  const patch = {
    cts_fb_since: now,
    cts_fb_after: now + (1 + Math.random() * 2) * DAY_MS,
  };
  const tracked = s.cts_installed_at || s.cts_first_seen;
  if (!tracked) {
    const priorUse = !!s.cts_org_id || typeof s.cts_5h_util === 'number' || s.cts_hint_seen === true;
    if (priorUse) patch.cts_fb_legacy = true;
    else patch.cts_installed_at = now;          // never really used it: counts from today
  }
  await chrome.storage.local.set(patch);
}


// ─── VamimiAI (vamimi.js) ───────────────────────────────────────────────────
// cts_vm_ann: { status: 'waiting' | 'shown', minDays, shownAt? }
//   Claimed (and shown) once claude.ai has been used on `minDays` distinct days
//   (cts_days, recorded by review.js). People updating from before VM_SINCE are
//   established users and see it at their next calm moment (minDays 0); a
//   fresh install waits VM_NEW_USER_DAYS days. Never while the welcome splash
//   is pending, never within VM_GAP_MS of another TokenLens prompt, and only
//   ever in one tab (claims are serialised here).
// cts_vm_spot: { armed, pages, done } - the Diagram button's spotlight, armed
//   by the announcement when it is claimed, never before.
const VM_ORIGIN = 'https://www.vamimi.com';
const VM_SINCE = '6.3';  // announcement: installs older than this are 'established'
const VM_NEW_USER_DAYS = 3;
const VM_GAP_MS = DAY_MS;

function vmOlder(a, b) {
  const pa = String(a || '0').split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

async function flagVamimi(previousVersion) {
  const s = await chrome.storage.local.get(['cts_vm_ann']);
  if (s.cts_vm_ann) return;
  const established = vmOlder(previousVersion, VM_SINCE);
  await chrome.storage.local.set({ cts_vm_ann: { status: 'waiting', minDays: established ? 0 : VM_NEW_USER_DAYS } });
}

let vmQueue = Promise.resolve();

async function vmClaim() {
  const s = await chrome.storage.local.get(['cts_vm_ann', 'cts_days', 'cts_show_welcome', 'cts_prompt_last']);
  const st = s.cts_vm_ann || { status: 'waiting', minDays: VM_NEW_USER_DAYS };
  if (st.status === 'shown') return { claimed: false, final: true };
  if (s.cts_show_welcome === true) return { claimed: false };
  const days = Array.isArray(s.cts_days) ? s.cts_days.length : 0;
  if (days < (st.minDays || 0)) return { claimed: false };
  const pl = s.cts_prompt_last;
  const now = Date.now();
  if (pl && pl.kind !== 'vamimi' && now - (pl.ts || 0) < VM_GAP_MS) return { claimed: false };
  await chrome.storage.local.set({
    cts_vm_ann: Object.assign({}, st, { status: 'shown', shownAt: now }),
    cts_vm_spot: { armed: true, pages: 0, done: false },
    cts_prompt_last: { kind: 'vamimi', ts: now },
  });
  return { claimed: true, final: true };
}

// Opens VamimiAI in a new tab right after the claude.ai tab the request came
// from. Only VamimiAI's own origin is ever opened. -> the created tab | null
async function vmOpenTab(rawUrl, sender) {
  let url;
  try { url = new URL(rawUrl); } catch (_) { return null; }
  if (url.origin !== VM_ORIGIN) return null;
  const tab = sender && sender.tab;
  return chrome.tabs.create({
    url: url.toString(),
    active: true,
    ...(tab ? { index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId } : {}),
  });
}

async function vmOpen(rawUrl, sender) {
  return { ok: !!(await vmOpenTab(rawUrl, sender)) };
}

const vmUrl = campaign => {
  const u = new URL(VM_ORIGIN + '/');
  u.searchParams.set('utm_source', 'tokenlens');
  u.searchParams.set('utm_medium', 'extension');
  u.searchParams.set('utm_campaign', String(campaign || 'unlock_pro').replace(/[^\w-]/g, '').slice(0, 40) || 'unlock_pro');
  return u.toString();
};

// "Unlock Pro free": opens VamimiAI and unlocks TokenLens Pro for good once
// that page has loaded (or has stayed open for VM_UNLOCK_MS), so the unlock
// follows a real visit rather than a click that was closed straight away.
// Written to local AND sync so a reinstall or a second computer keeps it.
const VM_UNLOCK_MS = 6000;

async function vmUnlock(campaign, sender) {
  const already = (await chrome.storage.local.get(['cts_vm_unlock'])).cts_vm_unlock;
  const tab = await vmOpenTab(vmUrl(campaign), sender);
  if (already && already.at) return { ok: true, already: true };
  if (!tab) return { ok: false };
  return new Promise(resolve => {
    let settled = false;
    const finish = async ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (ok) {
        const rec = { at: Date.now(), campaign: String(campaign || 'unlock_pro').slice(0, 40) };
        await chrome.storage.local.set({ cts_vm_unlock: rec });
        try { await chrome.storage.sync.set({ cts_vm_unlock: rec }); } catch (_) { /* sync full or off */ }
      }
      resolve({ ok });
    };
    const onUpdated = (id, info) => { if (id === tab.id && info.status === 'complete') finish(true); };
    const onRemoved = id => { if (id === tab.id) finish(false); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const timer = setTimeout(() => finish(true), VM_UNLOCK_MS);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.cts !== 'vamimi') return false;
  if (!sender || sender.id !== chrome.runtime.id) { sendResponse({ ok: false }); return false; }
  let job;
  if (msg.op === 'claim') job = (vmQueue = vmQueue.then(vmClaim, vmClaim));
  else if (msg.op === 'open') job = vmOpen(msg.url, sender);
  else if (msg.op === 'unlock') job = vmUnlock(msg.campaign, sender);
  else return false;
  job.then(r => sendResponse(r), () => sendResponse({ ok: false, claimed: false }));
  return true; // async response
});
