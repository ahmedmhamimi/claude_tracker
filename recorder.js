/**
 * Group A runtime (ISOLATED): records usage snapshots and per-message cost
 * records, and serves the pace estimate. TokenLens is a monitor: it shows
 * where usage stands and never interrupts with warnings (the 80% / 95%
 * alert toasts were removed in 6.4).
 *
 * - CTS_Recorder.getPace() -> Promise<null|{...}>: current pace projection (null = stay silent). Callers decide whether the plan may show it (feature 'pace').
 * - store.get(keys) -> Promise<object>: chrome.storage.local read that resolves with the stored values.
 * - CTS_Recorder.latest() -> {usage}: most recent reading seen by this tab
 * - CTS_Recorder.fmtMinutes(n) -> string: localized "40 min" / "1 h 20 min"
 *
 * Writes nothing when nothing changed (page-level check here, authoritative
 * check again in the store).
 *
 * @requires safe.js, features.js, history.js, client.js, ui-kit.js, bridge2.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe, F = window.CTS_Features, H = window.CTS_History, UI = window.CTS_UI, Client = window.CTS_Client;
  let usage = null;
  const recordedCosts = new Set();
  const MAX_COST_KEYS = 500;      // bounded memory on a tab that stays open for days
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

  // Leftover from the removed alert toasts: forget which ones had fired.
  Safe.chromeCall('history', () => chrome.storage.local.remove('cts_alerts_fired'));

  // ─── "Claude isn't sharing usage" note ──────────────────────────────────────
  // network.js (MAIN) writes cts_quota_none when a reply finished and neither
  // the stream nor /usage carried a number. The bars already show dashes;
  // this says why, once, in a calm moment, at most once a week per account.
  const TOLD_KEY = 'cts_quota_none_told', WEEK = 7 * 864e5;
  let unavailPending = false;
  async function maybeTellUnavailable() {
    const s = await store.get(['cts_quota_none', TOLD_KEY]);
    const qn = s.cts_quota_none;
    if (!qn || !qn.org) { unavailPending = false; return; }
    const told = s[TOLD_KEY] || {};
    if (told[qn.org] && Date.now() - told[qn.org] < WEEK) { unavailPending = false; return; }
    if (document.visibilityState !== 'visible' || !UI.isCalm() || UI.toastVisible()) { unavailPending = true; return; }
    const shown = UI.toast({
      text: UI.T('vm_unavailToast') !== 'vm_unavailToast' ? UI.T('vm_unavailToast') : 'Claude isn\u2019t sending usage numbers for this account right now, so TokenLens can\u2019t show your 5-hour and 7-day limits (that\u2019s why they show a dash, not 0%). Everything else works, and the numbers come back on their own.',
      timeoutMs: 20000,
    });
    if (shown) { told[qn.org] = Date.now(); store.set({ [TOLD_KEY]: told }); unavailPending = false; } else unavailPending = true;
  }
  Safe.chromeCall('history', () => chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.cts_quota_none && ch.cts_quota_none.newValue) Safe.run('history', maybeTellUnavailable);
  }));
  setInterval(() => { if (unavailPending) Safe.run('history', maybeTellUnavailable); }, 5000);
  setTimeout(() => Safe.run('history', maybeTellUnavailable), 8000);

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
  }));

  // 'analysis' only fires after a reply finished streaming, so each event is one completed message.
  window.CTS_Bus.on('analysis', d => Safe.run('history', async () => {
    if (!F.isEnabled('history') || d.quotaDelta5h == null || !d.convId || d.totalTokens == null) return;
    const key = d.convId + ':' + d.msgSeq + ':' + d.assistantCount;
    if (recordedCosts.has(key)) return;
    if (recordedCosts.size >= MAX_COST_KEYS) recordedCosts.delete(recordedCosts.values().next().value);
    recordedCosts.add(key);
    await Client.call('cost.add', { t: d.t || Date.now(), convId: d.convId, convTokensEst: d.totalTokens, quotaDelta5h: d.quotaDelta5h });
  }));

  window.CTS_Recorder = { getPace, fmtMinutes, latest: () => ({ usage }) };
})();
