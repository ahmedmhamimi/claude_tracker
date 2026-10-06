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
 */

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
