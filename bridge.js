/**
 * ISOLATED-world bridge for chrome.* APIs.
 *
 * Runs at document_start in the default ISOLATED world so chrome.i18n and
 * chrome.storage are available. Stamps results onto document.documentElement
 * dataset attributes — the DOM is shared between worlds, so MAIN-world scripts
 * can read them synchronously (i18n) or poll asynchronously (storage).
 *
 * Also:
 *  - proxies chrome.storage.local.set on behalf of MAIN-world scripts
 *    (listen for 'cts:storage:set' CustomEvents dispatched on document), and
 *  - answers the popup's 'cts:status' ping so the popup can tell whether
 *    TokenLens is actually running in this tab.
 */

(function () {
  'use strict';

  // ─── i18n bridge ─────────────────────────────────────────────────────────
  // Collect every message key used by MAIN-world scripts and bake them into a
  // single JSON blob on the root element. MAIN-world scripts read this once
  // and cache it locally, so there is no per-call DOM access overhead.
  //
  // For messages with named placeholders ($COUNT$, $PCT$, etc.) we store the
  // raw template. The MAIN-world i18n() helper replaces $WORD$ tokens in-order
  // with any substitution arguments passed at call time.

  const ALL_KEYS = [
    'extName', 'extShortName', 'extDescription', 'actionTitle',
    'quota5hLabel', 'quota5hTip', 'quotaResetsIn',
    'quota7dLabel', 'quota7dTip',
    'ctxPillLabel', 'ctxPillTip',
    'spdPillTip', 'turnsPillTip', 'costPillTip', 'latPillTip',
    'ghostTurns', 'ghostCost', 'ghostLatency',
    'peakTip', 'offPeakText', 'onPeakText',
    'toolbar5hTip', 'toolbar7dTip',
    'chipOut', 'chipCached', 'chipLimitHit',
    'cacheTip', 'uncachedText', 'chipCachedTip', 'chipLatTip',
    'chipMaxedTip', 'chipOutTip', 'chipSpdTip', 'msgQuotaTip',
  ];

  const msgs = {};
  ALL_KEYS.forEach(k => {
    // Call without substitution args to get the raw template string.
    const m = chrome.i18n.getMessage(k);
    msgs[k] = m || k; // fall back to key if somehow missing
  });

  document.documentElement.dataset.ctsi18n = JSON.stringify(msgs);

  // ─── storage read bridge ─────────────────────────────────────────────────
  // chrome.storage.local.get is async; stamp the result when ready.
  // state.js polls for dataset.ctsstorage to appear instead of relying on a
  // promise that would require chrome.* access from MAIN world.
  //
  // 'cts_hint_seen' is a one-time flag for the draggable-widget onboarding
  // hint (ui.js's initHintBubble). It lives in chrome.storage.local rather
  // than the page's localStorage because claude.ai clears its own site data
  // on logout, which used to make the hint reappear on every fresh login.
  //
  // 'cts_show_welcome' is set by background.js on a fresh install. While it is
  // true the first-run splash (welcome.js) has not been shown yet, so the hint
  // bubble holds back until the splash is done.

  chrome.storage.local.get(
    ['cts_5h_util', 'cts_7d_util', 'cts_ts_5h', 'cts_ts_7d', 'cts_org_id',
     'cts_hint_seen', 'cts_show_welcome', 'cts_widget_hidden'],
    items => {
      document.documentElement.dataset.ctsstorage = JSON.stringify(items || {});
    }
  );

  // ─── storage write bridge ────────────────────────────────────────────────
  // MAIN-world scripts dispatch 'cts:storage:set' on document with a plain
  // object as event.detail. We forward it straight to chrome.storage.local.set.

  document.addEventListener('cts:storage:set', e => {
    if (e.detail && typeof e.detail === 'object') {
      chrome.storage.local.set(e.detail);
    }
  });

  // ─── popup status ping ───────────────────────────────────────────────────
  // popup.js sends { type: 'cts:status' } to the active tab. Getting any reply
  // proves the extension is running in that tab; no reply means the tab was
  // opened before TokenLens was installed/updated and needs a reload.

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'cts:status') {
      sendResponse({
        ok: true,
        ui: !!document.getElementById('ct-toolbar-quota'),
      });
    }
  });

})();
