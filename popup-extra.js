/**
 * Popup additions for 6.0: a compact 7-day peak-usage chart (from the local
 * history held by the service worker) and an "Open panel" button that asks the
 * active claude.ai tab to open the in-page panel. Runs after popup.js.
 *
 * - (no exports) page script
 *
 * @requires history.js, charts.js
 */

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const msg = (k, fb) => chrome.i18n.getMessage(k) || fb;
  const ask = (op, data) => new Promise(res => chrome.runtime.sendMessage({ cts: 1, op, data }, r => res(chrome.runtime.lastError || !r ? null : r)));

  async function init() {
    document.querySelectorAll('#trend [data-i18n], #open-panel').forEach(el => { const m = el.dataset.i18n && chrome.i18n.getMessage(el.dataset.i18n); if (m) el.textContent = m; });
    const { cts_settings: s } = await chrome.storage.local.get(['cts_settings']);
    const off = id => s && s.features && s.features[id] === false;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = () => $('status').dataset.state === 'active';
    const syncButton = () => { $('open-panel').hidden = !active(); };
    new MutationObserver(syncButton).observe($('status'), { attributes: true });
    syncButton();
    $('open-panel').addEventListener('click', async () => {
      try { await chrome.tabs.sendMessage(tab.id, { cts: 'open-panel' }); } catch (_) {}
      window.close();
    });

    if (off('history')) return;
    const r = await ask('snap.list');
    if (!r || !r.ok || !r.data || !r.data.length) return;
    const series = window.CTS_History.dailyPeaks(r.data, 7, Date.now());
    const doc = new DOMParser().parseFromString(window.CTS_Charts.dailyPeakChart(series, { w: 300, h: 90, label: msg('chartPeaks', 'Daily peak usage') }), 'image/svg+xml');
    $('trend-chart').appendChild(document.importNode(doc.documentElement, true));
    $('trend').hidden = false;
  }
  init();
})();
