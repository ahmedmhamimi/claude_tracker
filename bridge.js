/**
 * ISOLATED-world bridge for chrome.* APIs.
 *
 * Runs at document_start in the default ISOLATED world so chrome.i18n and
 * chrome.storage are available. Stamps results onto document.documentElement
 * dataset attributes — the DOM is shared between worlds, so MAIN-world scripts
 * can read them synchronously (i18n) or poll asynchronously (storage).
 *
 * Also proxies chrome.storage.local.set on behalf of MAIN-world scripts:
 * listen for 'cts:storage:set' CustomEvents dispatched on document.
 */

(function () {
  'use strict';

  // ─── i18n bridge ─────────────────────────────────────────────────────────
  // Collect every message key used across the extension and bake them into a
  // single JSON blob on the root element. MAIN-world scripts read this once
  // and cache it locally, so there is no per-call DOM access overhead.
  //
  // For messages with named placeholders ($COUNT$, $PCT$, etc.) we store the
  // raw template. The MAIN-world i18n() helper replaces $WORD$ tokens in-order
  // with any substitution arguments passed at call time.

  const ALL_KEYS = [
    'extName', 'extShortName', 'extDescription', 'actionTitle',
    'popupH1', 'popupSubtitle', 'popupWishText', 'popupFooter',
    'badgeTip', 'tokSuffix',
    'quota5hLabel', 'quota5hTip', 'quotaResetsIn',
    'wmTip', 'wmHeaderText', 'wmActualLabel', 'wmWithoutLabel',
    'quota7dLabel', 'quota7dTip',
    'ctxPillLabel', 'ctxPillTip',
    'spdPillTip', 'turnsPillTip', 'costPillTip', 'latPillTip',
    'ghostTurns', 'ghostCost', 'ghostLatency',
    'peakTip', 'offPeakText', 'onPeakText',
    'toolbar5hTip', 'toolbar7dTip',
    'chipOut', 'chipCached', 'chipLimitHit',
    'magicPanelTitle', 'magicBtnLabel', 'magicBtnTip', 'magicPillTip',
    'magicTokensSaved', 'magicMeasuredSub',
    'magicEstSavings', 'magicEstSub',
    'magicDesc', 'magicSelectAll', 'magicDeselectAll',
    'magicSectionInput', 'magicSectionOutput',
    'magicEstLabel', 'magicReset', 'magicSave',
    'impactSilent', 'impactNotice', 'impactTradeoff',
    'techWhitespaceLabel', 'techWhitespaceTip',
    'techContractionsLabel', 'techContractionsTip',
    'techFillersLabel', 'techFillersTip',
    'techNumbersLabel', 'techNumbersTip',
    'techCodeCommentsLabel', 'techCodeCommentsTip',
    'techJsonMinifyLabel', 'techJsonMinifyTip',
    'techNoMarkdownOutputLabel', 'techNoMarkdownOutputTip',
    'techNoPreambleLabel', 'techNoPreambleTip',
    'techExpertModeLabel', 'techExpertModeTip',
    'techStripHistoryMarkdownLabel', 'techStripHistoryMarkdownTip',
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
  // 'claude_tracker_settings' is the Magic panel's persisted technique
  // toggles (compressor.js reads/writes this key — see its loadSettings/
  // saveSettings). It lives in chrome.storage.local rather than the page's
  // own localStorage so it survives clearing claude.ai's site data.
  //
  // 'cts_magic_intro_seen' is a one-time flag: true once the Magic button's
  // first-run ring-ping + callout (magic.js) has been shown. Lives here for
  // the same reason — it must survive reloads so the intro really only
  // fires once per install, not once per tab.

  chrome.storage.local.get(
    ['cts_5h_util', 'cts_7d_util', 'cts_ts_5h', 'cts_ts_7d', 'cts_org_id', 'claude_tracker_settings',
    'cts_magic_intro_seen'],
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

})();
