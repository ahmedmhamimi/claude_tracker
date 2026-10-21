/**
 * Group A runtime (ISOLATED): records usage snapshots and per-message cost
 * records, shows threshold alerts, and serves the pace estimate.
 *
 * - CTS_Recorder.getPace() -> Promise<null|{...}>: current pace projection (null = stay silent). Callers decide whether the plan may show it (feature 'pace').
 * - alertConfig() -> object: alert thresholds for the current plan. Pro (trial or license): 80% and 95% on the 5-hour and 7-day windows. Free: one alert, 95% of the 5-hour window.
 * - store.get(keys) -> Promise<object>: chrome.storage.local read that resolves with the stored values (it used to resolve {} immediately, so fired alerts were forgotten on every page load).
 * - CTS_Recorder.latest() -> {usage}: most recent reading seen by this tab
 * - CTS_Recorder.fmtMinutes(n) -> string: localized "40 min" / "1 h 20 min"
 *
 * Writes nothing when nothing changed (page-level check here, authoritative
 * check again in the store). Alerts fire once per window per threshold, one
 * at a time, only in a calm moment, as an in-page toast (no notifications permission).
 *
 * @requires safe.js, features.js, history.js, client.js, ui-kit.js, bridge2.js, license.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe, F = window.CTS_Features, H = window.CTS_History, UI = window.CTS_UI, Client = window.CTS_Client;
  let usage = null;
  let firedCache = null;
  let alertTimer = 0;
  const recordedCosts = new Set();
  let paceCache = { at: 0, snaps: null };

  const store = {
    get: keys => new Promise(res => { const ran = Safe.chromeCall('history', () => { chrome.storage.local.get(keys, v => { void chrome.runtime.lastError; res(v || {}); }); return true; }); if (ran !== true) res({}); }),
    set: obj => Safe.chromeCall('history', () => chrome.storage.local.set(obj)),
  };

  async function recordSnapshot(snap) {
    const run = async () => {
      const last = (await store.get(['cts_snap_last'])).cts_snap_last || null;
      if (!H.shouldRecord(last, snap, snap.t)) return;
      store.set({ cts_snap_last: { t: snap.t, u5h: snap.u5h, u7d: snap.u7d } });
      await Client.call('snap.add', snap);
      paceCache.at = 0;
    };
    if (navigator.locks && navigator.locks.request) await navigator.locks.request('cts-recorder', run); else await run();
  }

  // ─── alerts ───────────────────────────────────────────────────────────────
  async function loadFired() { if (!firedCache) firedCache = (await store.get(['cts_alerts_fired'])).cts_alerts_fired || {}; return firedCache; }

  // Free plan keeps ONE alert (95% of the 5-hour window); Pro adds 80% and the 7-day window. Thresholds stay user-configurable via settings.
  function alertConfig() {
    const cfg = F.getSetting('alerts');
    if (!window.CTS_License || window.CTS_License.allows('alerts.full')) return cfg;
    return { w5h: Object.assign({}, cfg && cfg.w5h, { t80: false }), w7d: Object.assign({}, cfg && cfg.w7d, { t80: false, t95: false }) };
  }

  async function evaluateAlerts() {
    if (!F.isEnabled('alerts') || !usage) return;
    if (window.CTS_License) await window.CTS_License.ready;       // never judge a Pro buyer by the free rules just because storage was still loading
    const fired = await loadFired();
    const { alert, newFired } = H.nextAlert(usage, alertConfig(), fired, Date.now());
    if (!alert) return;
    const tryShow = () => {
      if (!F.isEnabled('alerts')) { alertTimer = 0; return; }
      if (UI.isCalm() && !UI.toastVisible()) {
        alertTimer = 0;
        const win = UI.T(alert.win === '5h' ? 'win5h' : 'win7d');
        const shown = UI.toast({ text: UI.T('alertText', [win, String(Math.round(alert.util))]), timeoutMs: 15000,
          actions: [{ label: UI.T('openPanel'), onClick: () => document.dispatchEvent(new CustomEvent('cts2:open-panel')) }] });
        if (shown) { firedCache = newFired; store.set({ cts_alerts_fired: newFired }); }
      } else alertTimer = setTimeout(() => Safe.run('alerts', tryShow), 2000);
    };
    if (!alertTimer) tryShow();
  }

  // ─── pace ─────────────────────────────────────────────────────────────────
  const fmtMinutes = n => (n < 60 ? UI.T('dMin', [String(n)]) : UI.T('dHrMin', [String(Math.floor(n / 60)), String(n % 60)]));

  async function getPace() {
    if (!F.isEnabled('history')) return null;
    if (!paceCache.snaps || Date.now() - paceCache.at > 30000) { paceCache = { at: Date.now(), snaps: (await Client.data('snap.list')) || [] }; }
    return H.pace(paceCache.snaps, Date.now());
  }

  // ─── bus subscriptions ────────────────────────────────────────────────────
  window.CTS_Bus.on('usage', d => Safe.run('history', async () => {
    usage = d;
    if (F.isEnabled('history')) { const snap = H.cleanSnap(d); if (snap) await recordSnapshot(snap); }
    await Safe.run('alerts', evaluateAlerts);
  }));

  // 'analysis' only fires after a reply finished streaming, so each event is one completed message.
  window.CTS_Bus.on('analysis', d => Safe.run('history', async () => {
    if (!F.isEnabled('history') || d.quotaDelta5h == null || !d.convId || d.totalTokens == null) return;
    const key = d.convId + ':' + d.msgSeq + ':' + d.assistantCount;
    if (recordedCosts.has(key)) return;
    recordedCosts.add(key);
    await Client.call('cost.add', { t: d.t || Date.now(), convId: d.convId, convTokensEst: d.totalTokens, quotaDelta5h: d.quotaDelta5h });
  }));

  window.CTS_Recorder = { getPace, fmtMinutes, latest: () => ({ usage }), alertConfig };
})();
