/**
 * Quota UI synchronisation: maps raw API utilisation data to DOM progress bars
 * and drives countdown timers for the 5h and 7d reset windows.
 *
 * - CTS_Quota.syncQuotaUI(limits) -> void: ingests {5h, 7d} utilization objects, updates all bar elements
 * - CTS_Quota.startCountdownTick() -> void: starts the 1 s interval that updates reset countdowns and speed pill
 */

(function () {
  'use strict';

  // ─── Quota Sync ───────────────────────────────────────────────────────────

  function syncQuotaUI(limits) {
    if (!limits) return;

    ['5h', '7d'].forEach(win => {
      const d = limits[win];
      if (!d || d.utilization == null) return;

      let raw = d.utilization;
      if (raw > 1 && raw <= 100) raw /= 100;
      raw = Math.max(0, Math.min(1, raw));
      if (window.CTS.isLimitHit && win === '5h') raw = 1;

      const pct = Math.round(raw * 100);
      if (win === '5h') window.CTS.current5hUtil = pct;
      if (win === '7d') {
        window.CTS.current7dUtil = pct;
        try { sessionStorage.setItem('cts_7d_util', String(pct)); } catch (_) {}
      }

      let ts = d.resetsAt;
      if (typeof ts === 'string') ts = Math.floor(Date.parse(ts) / 1000);
      if (ts && !isNaN(ts)) window.CTS.targetTimestamps[win] = ts;

      window.ClaudeTrackerUI.updateQuotaBars(win, pct, ts);
    });

    // Persist so navigating to a new chat restores bars immediately without
    // waiting for the next fetch/SSE event. Tagging with orgId lets a later
    // account switch detect that this snapshot belongs to a different
    // account and discard it instead of leaking stale numbers across accounts.
    window.CTS_StorageSet({
      cts_5h_util: window.CTS.current5hUtil,
      cts_7d_util: window.CTS.current7dUtil,
      cts_ts_5h:   window.CTS.targetTimestamps['5h'],
      cts_ts_7d:   window.CTS.targetTimestamps['7d'],
      cts_org_id:  window.CTS.orgId || null,
    });
  }

  // ─── Countdown Tick ───────────────────────────────────────────────────────

  let _tickStarted = false;

  function startCountdownTick() {
    if (_tickStarted) return;
    _tickStarted = true;
    setInterval(() => {
      _tickPeak();
      _tickResetTimers();
      _tickSpeedPill();
      _tickStreamingAttr();
      _tickUIHealthCheck();
      if (window.CTS_Content) window.CTS_Content.updateInlineStats();
    }, 1000);
  }

  function _tickPeak() {
    const { inPeak, msUntil } = window.CTS_Shared.getPeakStatus();
    const badge = document.getElementById('ct-peak');
    const label = document.getElementById('ct-peak-t');
    if (!badge || !label) return;

    badge.className = inPeak ? 'peak' : 'offpeak';
    if (inPeak) {
      const s   = Math.max(0, Math.floor(msUntil / 1000));
      const h   = Math.floor(s / 3600);
      const m   = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      label.textContent = 'peak · ' + (h > 0 ? h + 'h ' + m + 'm' : m + 'm ' + sec + 's');
    } else {
      label.textContent = 'off-peak';
    }

    try {
      const isDst = (() => {
        const now = new Date(); const y = now.getUTCFullYear();
        const dstS = new Date(Date.UTC(y, 2,  1 + ((7 - new Date(Date.UTC(y, 2,  1)).getUTCDay()) % 7) + 7, 10));
        const dstE = new Date(Date.UTC(y, 10, 1 + ((7 - new Date(Date.UTC(y, 10, 1)).getUTCDay()) % 7), 9));
        return now >= dstS && now < dstE;
      })();
      const ptOffsetH   = isDst ? -7 : -8;
      const localOffsetH = -new Date().getTimezoneOffset() / 60;
      const diffH       = localOffsetH - ptOffsetH;
      const peakStartH  = (5  + diffH + 24) % 24;
      const peakEndH    = (11 + diffH + 24) % 24;
      const fmtH = h => { const ampm = h < 12 ? 'AM' : 'PM'; const h12 = h % 12 || 12; return h12 + ':00 ' + ampm; };
      const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const tip = (inPeak ? 'PEAK HOURS (now active)' : 'OFF-PEAK (now active)') +
      '\n\nPeak: Mon–Fri  ' + fmtH(peakStartH) + ' – ' + fmtH(peakEndH) +
      (tzName ? ' (' + tzName + ')' : '') +
      '\n\nDuring peak hours, Claude may respond\nmore slowly due to higher server load.\nUsage limits reset faster off-peak.';
      badge.setAttribute('data-ct-tip', tip);
    } catch (_) {}
  }

  function _tickResetTimers() {
    ['5h', '7d'].forEach(win => {
      const target    = window.CTS.targetTimestamps[win];
      const displayEl = document.getElementById('ct-tr' + win);
      const toolbarEl = document.getElementById('ct-tq-tr-' + win);
      if (!target) return;

      const diff = target - Math.floor(Date.now() / 1000);

      if (diff <= 0) {
        if (displayEl) displayEl.textContent = 'refreshing…';
        if (toolbarEl) toolbarEl.textContent  = '';
        if (!window.CTS.activeResetTriggers[win]) {
          window.CTS.activeResetTriggers[win] = true;
          setTimeout(() => {
            window.CTS_Network.triggerUsageFetch();
            window.CTS.activeResetTriggers[win] = false;
            window.CTS.isLimitHit = false;
          }, 1500);
        }
        return;
      }

      const d   = Math.floor(diff / 86400);
      const h   = Math.floor((diff % 86400) / 3600);
      const m   = Math.floor((diff % 3600) / 60);
      const s   = diff % 60;
      const txt = win === '5h'
      ? (h > 0 ? h + 'h ' + m + 'm ' + s + 's' : m + 'm ' + s + 's')
      : (d > 0 ? d + 'd ' + h + 'h' : h > 0 ? h + 'h ' + m + 'm' : m + 'm ' + s + 's');

      if (displayEl) displayEl.textContent = txt;
      if (toolbarEl) toolbarEl.textContent  = txt;
    });
  }

  function _tickSpeedPill() {
    const pill = document.getElementById('ct-p-spd');
    const text = document.getElementById('ct-p-spd-t');
    if (pill && text && window.CTS.lastSpeedTps) {
      text.textContent   = `${window.CTS.lastSpeedTps} t/s`;
      pill.style.display = 'inline-flex';
      pill.className     = 'ct-pill' + (window.CTS.isStreaming ? ' stream' : '');
    }
  }

  function _tickStreamingAttr() {
    document.body.setAttribute('data-cts', window.CTS.isStreaming ? '1' : '0');
  }

  function _tickUIHealthCheck() {
    // See matching comment in content.js's mutationObserver: ct-quota's
    // absence only signals a real problem when a sidebar nav exists to put
    // it in. Checking unconditionally caused the incognito freeze; checking
    // never (the first fix) silently broke the legitimate retry needed when
    // an SPA transition brings a sidebar back without a full page reload.
    const sidebarPresent = !!(
      document.querySelector('nav.flex-col') ||
      document.querySelector('[class*="sidebar"] nav') ||
      document.querySelector('nav')
    );
    const sidebarMissingQuota = sidebarPresent && !document.getElementById('ct-quota');

    if (!document.getElementById('ct-toolbar-quota') || !document.getElementById('ct-row') || sidebarMissingQuota) {
      window.CTS.UIInjected = false;
      if (window.CTS_Content) window.CTS_Content.tryInjectUI();
    }
  }

  // ─── Exports ─────────────────────────────────────────────────────────────

  window.CTS_Quota = {
    syncQuotaUI,
 startCountdownTick,
  };

})();
