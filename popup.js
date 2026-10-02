/**
 * Popup: a live status panel, not a poster.
 *
 *  - Asks the active tab whether TokenLens is actually running there
 *    (bridge.js answers the 'cts:status' ping).
 *  - Shows the last known 5-hour / 7-day usage from chrome.storage.local.
 *  - Offers the one action that fixes the current state: reload the tab, or
 *    open Claude.
 *
 * External script on purpose: MV3 extension pages block inline scripts, so the
 * old inline localisation code in popup.html never ran.
 */

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const msg = (key, fallback) => chrome.i18n.getMessage(key) || fallback;

  // Static labels
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const m = chrome.i18n.getMessage(el.dataset.i18n);
    if (m) el.textContent = m;
  });
  document.documentElement.lang = chrome.i18n.getUILanguage();
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  const CLAUDE_URL = 'https://claude.ai/new';
  let usage = null;

  function setStatus(state, text) {
    const el = $('status');
    el.dataset.state = state;
    $('status-text').textContent = text;
  }

  function setAction(label, handler) {
    const b = $('action');
    if (!label) { b.hidden = true; return; }
    b.textContent = label;
    b.onclick = handler;
    b.hidden = false;
  }

  function formatReset(ts) {
    const s = ts - Math.floor(Date.now() / 1000);
    if (s <= 0) return '';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    const span = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
    return `${msg('quotaResetsIn', 'resets in')} ${span}`;
  }

  function renderUsage() {
    if (!usage || typeof usage.cts_5h_util !== 'number') {
      $('usage').hidden = true;
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    [['5h', usage.cts_5h_util, usage.cts_ts_5h], ['7d', usage.cts_7d_util, usage.cts_ts_7d]].forEach(([w, util, ts]) => {
      const expired = ts != null && ts <= now;
      const pct = expired || typeof util !== 'number' ? 0 : Math.max(0, Math.min(100, Math.round(util)));
      $('pct-' + w).textContent = pct + '%';
      const fill = $('fill-' + w);
      fill.style.width = pct + '%';
      fill.classList.toggle('hot', pct >= 85);
      $('reset-' + w).textContent = !expired && ts ? formatReset(ts) : msg('popupNoWindow', 'No active window');
    });
    $('usage').hidden = false;
    $('loading').hidden = true;
  }

  async function init() {
    usage = await chrome.storage.local.get(['cts_5h_util', 'cts_7d_util', 'cts_ts_5h', 'cts_ts_7d']);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onClaude = !!(tab && tab.url && /^https:\/\/claude\.ai(\/|$)/.test(tab.url));

    if (!onClaude) {
      setStatus('open', msg('popupOpen', 'Open Claude to see your usage.'));
      setAction(msg('popupOpenBtn', 'Open Claude'), () => {
        chrome.tabs.create({ url: CLAUDE_URL });
        window.close();
      });
      renderUsage();
      return;
    }

    let running = false;
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'cts:status' });
      running = !!(reply && reply.ok);
    } catch (_) { running = false; }

    if (!running) {
      // The tab was open before TokenLens was installed or updated, so the
      // content scripts were never injected into it.
      setStatus('reload', msg('popupReload', 'Reload this tab to turn TokenLens on.'));
      setAction(msg('popupReloadBtn', 'Reload tab'), () => {
        chrome.tabs.reload(tab.id);
        window.close();
      });
      renderUsage();
      return;
    }

    setStatus('active', msg('popupActive', 'Active on this tab'));
    setAction(null);
    if (usage && typeof usage.cts_5h_util === 'number') renderUsage();
    else $('loading').hidden = false;
  }

  // Live updates while the popup is open: new readings, and a ticking countdown.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    chrome.storage.local.get(['cts_5h_util', 'cts_7d_util', 'cts_ts_5h', 'cts_ts_7d']).then(v => { usage = v; renderUsage(); });
  });
  setInterval(renderUsage, 30000);

  init();
})();
