/**
 * Last ISOLATED script: wires the safe wrapper to the feature registry, keeps
 * a persisted ring buffer of scrubbed errors (no conversation content), and
 * releases the MAIN world's message queue once every module has subscribed.
 *
 * - (no exports)
 *
 * @requires safe.js, features.js, bridge2.js, recorder.js, indexer.js, handoff-ui.js, panel.js, placement.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe;
  let log = null, timer = 0;

  Safe.configure({
    features: window.CTS_Features,
    sink: entry => {
      // Persist (debounced) so the diagnostics report can show errors from earlier page loads too.
      const write = () => { timer = 0; Safe.chromeCall('boot', () => chrome.storage.local.set({ cts_errlog: log.slice(-50) })); };
      const go = () => { log.push(entry); if (log.length > 50) log.shift(); if (!timer) timer = setTimeout(write, 2000); };
      if (log) go(); else Safe.chromeCall('boot', () => chrome.storage.local.get(['cts_errlog'], r => { log = r.cts_errlog || []; go(); }));
    },
  });

  Safe.onInvalidated(() => {
    // The old content script outlived an extension update; the existing widget already tells users to reload.
    document.documentElement.dataset.ctsx2 = '0';
  });

  window.CTS_Bus.ready();
})();
