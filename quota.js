/**
 * Quota UI synchronisation: maps raw API utilisation data to DOM progress bars
 * and drives countdown timers for the 5h and 7d reset windows.
 *
 * - CTS_Quota.syncQuotaUI(limits) -> void: ingests {5h, 7d} utilization objects, updates all bar elements
 * - CTS_Quota.startCountdownTick() -> void: starts the 1 s interval that updates reset countdowns and speed pill
 */

(function () {
  'use strict';

  let _lastSnapKey = '';

  // ─── Stale indicator ─────────────────────────────────────────────────────
  // When the numbers on screen are last-known (offline, flaky link, or a cached
  // snapshot not yet confirmed), mark them with a trailing "~" and dim them,
  // instead of showing them as if they were live. Pure CSS off one attribute.

  const STALE_CSS = `
    [data-ct-stale="1"] .ct-tq-pct::after,
    [data-ct-stale="1"] .ct-bar-pct::after,
    [data-ct-stale="1"] [id^="ct-p-"][id$="-pct"]::after { content: "\\00a0~"; opacity: .7; }
    [data-ct-stale="1"] .ct-tq-fill,
    [data-ct-stale="1"] .ct-progress-fill,
    [data-ct-stale="1"] [id^="ct-p-"][id$="-fill"] { opacity: .6; }
  `;

  function ensureStaleCSS() {
    if (document.getElementById('ct-stale-style')) return;
    const parent = document.head || document.documentElement;
    if (!parent) return;
    const st = document.createElement('style');
    st.id = 'ct-stale-style';
    st.textContent = STALE_CSS;
    parent.appendChild(st);
  }

  function isStaleNow() {
    return !!window.CTS._stale || (!!window.CTS.cacheReady && !window.CTS.dataReady);
  }

  function applyStaleAttrs() {
    const on = isStaleNow();
    ['ct-quota', 'ct-toolbar-quota', 'ct-row'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const has = el.getAttribute('data-ct-stale') === '1';
      if (on && !has) el.setAttribute('data-ct-stale', '1');
      else if (!on && has) el.removeAttribute('data-ct-stale');
    });
  }

  function setStale(stale, reason) {
    const c = window.CTS;
    if (!!c._stale === !!stale && c._staleReason === (reason || null)) return;
    c._stale = !!stale;
    c._staleReason = stale ? (reason || null) : null;
    ensureStaleCSS();
    applyStaleAttrs();
  }

  // ─── Quota Sync ───────────────────────────────────────────────────────────

  function syncQuotaUI(limits) {
    if (!limits) return;
    // A real reading has arrived: stop showing the loading state, even if the
    // account has no active window yet (a brand-new user legitimately sits at 0%).
    window.CTS.dataReady = true;

    ['5h', '7d'].forEach(win => {
      const d = limits[win];
      if (!d || d.utilization == null) return;

      let raw = d.utilization;
      if (raw > 1 && raw <= 100) raw /= 100;
      raw = Math.max(0, Math.min(1, raw));
      // isLimitHit is meant to hold the 5h bar at 100% only up until the real
      // reset time passes — not indefinitely. Cross-checking against the
      // known reset timestamp here means a stuck flag (tab backgrounded
      // through the rollover, timer throttled, etc.) can no longer make this
      // function discard genuinely fresh, correct data from every periodic
      // fetch forever: once real time has passed the reset, we trust the
      // freshly-fetched utilization instead of the flag.
      const knownReset5h = window.CTS.targetTimestamps['5h'];
      if (knownReset5h && knownReset5h <= Math.floor(Date.now() / 1000)) {
        window.CTS.isLimitHit = false;
      }
      if (window.CTS.isLimitHit && win === '5h') raw = 1;

      const pct = Math.round(raw * 100);
      let ts = d.resetsAt;
      if (typeof ts === 'string') ts = Math.floor(Date.parse(ts) / 1000);
      if (ts && !isNaN(ts)) window.CTS.targetTimestamps[win] = ts;

      if (win === '5h') {
        window.CTS.current5hUtil = pct;
        // Mirrors the 7d sessionStorage cache below so a fresh document load
        // (new tab, reload, full navigation) has an instant, synchronous
        // value to paint before the async chrome.storage.local restore
        // (bridge.js) resolves. See state.js's restore comment for why this
        // matters — 5h previously had no such fast-path at all.
        // Also mirror the reset timestamp alongside it: state.js's sync
        // restore needs this to know whether the cached % is still valid
        // for the window it was captured in, or belongs to one that has
        // already rolled over.
        try {
          sessionStorage.setItem('cts_5h_util', String(pct));
          localStorage.setItem('cts_global_5h_util', String(pct));
          if (ts && !isNaN(ts)) {
            sessionStorage.setItem('cts_ts_5h', String(ts));
            localStorage.setItem('cts_global_ts_5h', String(ts));
          }
        } catch (_) {}
      }
      if (win === '7d') {
        window.CTS.current7dUtil = pct;
        try {
          sessionStorage.setItem('cts_7d_util', String(pct));
          localStorage.setItem('cts_global_7d_util', String(pct));
          if (ts && !isNaN(ts)) {
            sessionStorage.setItem('cts_ts_7d', String(ts));
            localStorage.setItem('cts_global_ts_7d', String(ts));
          }
        } catch (_) {}
      }

      window.ClaudeTrackerUI.updateQuotaBars(win, pct, ts);
    });

    // Persist so navigating to a new chat restores bars immediately without
    // waiting for the next fetch/SSE event. Tagging with orgId lets a later
    // account switch detect that this snapshot belongs to a different
    // account and discard it instead of leaking stale numbers across accounts.
    // Skip the write when nothing changed (saves a cross-world message and a
    // chrome.storage write on every poll — matters on weak machines).
    const snap = {
      cts_5h_util: window.CTS.current5hUtil,
      cts_7d_util: window.CTS.current7dUtil,
      cts_ts_5h:   window.CTS.targetTimestamps['5h'],
      cts_ts_7d:   window.CTS.targetTimestamps['7d'],
      cts_org_id:  window.CTS.orgId || null,
    };
    const snapKey = JSON.stringify(snap);
    if (snapKey !== _lastSnapKey) {
      _lastSnapKey = snapKey;
      window.CTS_StorageSet(snap);
    }

    // A live reading just landed: whatever was on screen is no longer a
    // stale cached snapshot.
    window.CTS.cacheReady = false;
    setStale(false);
    window.ClaudeTrackerUI.markReady();
  }

  // ─── Countdown Tick ───────────────────────────────────────────────────────

  let _tickStarted = false;

  function startCountdownTick() {
    if (_tickStarted) return;
    _tickStarted = true;
    ensureStaleCSS();
    setInterval(() => {
      // Reset-window rollover detection must keep running in the background;
      // everything cosmetic only runs while the tab is actually visible, which
      // keeps the 1s timer nearly free on low-RAM / low-CPU machines.
      _tickResetTimers();
      if (document.hidden) return;
      _tickPeak();
      _tickCache();
      _tickStreamingAttr();
      _tickUIHealthCheck();
      applyStaleAttrs();
      if (window.CTS_Content) window.CTS_Content.updateInlineStats();
    }, 1000);
  }

  function _tickPeak() {
    const { inPeak, msUntil } = window.CTS_Shared.getPeakStatus();
    const badge = document.getElementById('ct-peak');
    const label = document.getElementById('ct-peak-t');
    if (!badge || !label) return;

    const wantCls = inPeak ? 'peak' : 'offpeak';
    if (badge.className !== wantCls) badge.className = wantCls;
    let _txt;
    if (inPeak) {
      const s   = Math.max(0, Math.floor(msUntil / 1000));
      const h   = Math.floor(s / 3600);
      const m   = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      _txt = 'peak · ' + (h > 0 ? h + 'h ' + m + 'm' : m + 'm ' + sec + 's');
    } else {
      _txt = 'off-peak';
    }
    if (label.textContent !== _txt) label.textContent = _txt;

    // The tooltip only changes when peak status flips (or the minute rolls
    // over) — rebuilding + re-setting it every second was pure waste.
    const tipKey = (inPeak ? 'p' : 'o') + Math.floor(Date.now() / 60000);
    if (badge.getAttribute('data-ct-tipkey') === tipKey) return;
    badge.setAttribute('data-ct-tipkey', tipKey);

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

  function _tickCache() {
    const badge = document.getElementById('ct-cache');
    const label = document.getElementById('ct-cache-t');
    if (!badge || !label) return;

    // Same signal used for the per-message "cached" chip: Anthropic's
    // prompt cache checkpoint lasts 1 hour from a conversation's first
    // reply. window.CTS.cachedUntilTs is that expiry timestamp, set in
    // content.js's applyAnalysis(). Not a real API flag — inferred from
    // "this conversation has replied before, and it's within the hour."
    const untilTs = window.CTS.cachedUntilTs;
    const isCached = !!(untilTs && untilTs > Date.now());

    const wantCls = isCached ? 'cached' : 'uncached';
    if (badge.className !== wantCls) badge.className = wantCls;
    let _txt;
    if (isCached) {
      const s   = Math.max(0, Math.floor((untilTs - Date.now()) / 1000));
      const m   = Math.floor(s / 60);
      const sec = s % 60;
      _txt = 'cached · ' + (m > 0 ? m + 'm ' + sec + 's' : sec + 's');
    } else {
      _txt = 'not cached';
    }
    if (label.textContent !== _txt) label.textContent = _txt;
    if (badge.getAttribute('data-ct-cachekey') === wantCls) return; // tooltip text is static per state
    badge.setAttribute('data-ct-cachekey', wantCls);

    const tip = (isCached ? 'CACHED (now active)' : 'NOT CACHED') +
    '\n\nHow this is worked out:\nAnthropic caches a conversation\'s prompt for\n1 hour after its first reply. If it has already\nreplied once and that hour has not passed,\nthis is marked cached.\n\nThis is inferred, not read from a real\ncache-hit flag — Claude.ai does not expose one.\nWhen cached, replies are typically\nfaster and cheaper to generate.';
    badge.setAttribute('data-ct-tip', tip);
  }

  function _tickResetTimers() {
    ['5h', '7d'].forEach(win => {
      const target    = window.CTS.targetTimestamps[win];
      const displayEl = document.getElementById('ct-tr' + win);
      const toolbarEl = document.getElementById('ct-tq-tr-' + win);
      if (!target) return;

      const diff = target - Math.floor(Date.now() / 1000);

      if (diff <= 0) {
        // Has a live reading been confirmed since this window rolled over? If
        // so and the API still offers no new reset time, the new window simply
        // hasn't started yet (it starts with the next message) — show a dash
        // rather than claiming to be "refreshing…" forever.
        const settled = (window.CTS._lastUsageOkAt || 0) > target * 1000;
        if (displayEl) displayEl.textContent = settled ? '\u2014' : 'refreshing…';
        if (toolbarEl) toolbarEl.textContent  = '';

        // Handle each rollover exactly ONCE (keyed by the timestamp that
        // passed), instead of re-zeroing the bar, rewriting storage and
        // re-fetching every couple of seconds until a new resets_at appears.
        // Failures are retried by network.js's own persistent backoff.
        if (window.CTS.activeResetTriggers[win] !== target) {
          window.CTS.activeResetTriggers[win] = target;

          // The window has actually rolled over, so drop the bar to 0% right
          // away rather than leaving the stale pre-reset number on screen
          // until the (possibly slow or failing) fetch resolves.
          const key = win === '5h' ? '5h' : '7d';
          window.CTS[win === '5h' ? 'current5hUtil' : 'current7dUtil'] = 0;
          try {
            sessionStorage.setItem('cts_' + key + '_util', '0');
            localStorage.setItem('cts_global_' + key + '_util', '0');
            sessionStorage.removeItem('cts_ts_' + key);
            localStorage.removeItem('cts_global_ts_' + key);
          } catch (_) {}
          window.ClaudeTrackerUI.updateQuotaBars(win, 0, null);
          // isLimitHit tracks the 5h window only: a 7d rollover must not
          // un-flag it, and a 5h rollover must.
          if (win === '5h') window.CTS.isLimitHit = false;
          // targetTimestamps[win] is deliberately left as the just-passed
          // value (the "!target" guard above would otherwise stop this
          // block from ever running again); network.js overwrites it with
          // the fresh resets_at as soon as the API supplies one.
          window.CTS_StorageSet({
            cts_5h_util: window.CTS.current5hUtil,
            cts_7d_util: window.CTS.current7dUtil,
          });
          _lastSnapKey = '';
          if (window.CTS_Network) window.CTS_Network.triggerUsageFetch({ force: true });
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

      if (displayEl && displayEl.textContent !== txt) displayEl.textContent = txt;
      if (toolbarEl && toolbarEl.textContent !== txt) toolbarEl.textContent = txt;
    });
  }

  function _tickStreamingAttr() {
    const v = window.CTS.isStreaming ? '1' : '0';
    if (document.body.getAttribute('data-cts') !== v) document.body.setAttribute('data-cts', v);
  }

  function _tickUIHealthCheck() {
    // Keep the reopen icon mounted (claude.ai re-renders its top bar).
    if (window.ClaudeTrackerUI && window.ClaudeTrackerUI.syncLauncher) window.ClaudeTrackerUI.syncLauncher();
    // See matching comment in content.js's mutationObserver: ct-quota's
    // absence only signals a real problem when a sidebar exists to put it
    // in. Checking unconditionally caused the incognito freeze; checking
    // never (the first fix) silently broke the legitimate retry needed when
    // an SPA transition brings a sidebar back without a full page reload.
    //
    // This used to duplicate that detection with its own `nav`-only
    // selectors, which pre-dated Anthropic's Aug 2026 sidebar redesign
    // (content.js's getSidebarRoot() comment: the redesign dropped <nav>
    // entirely in favour of `[data-testid="sidebar"]`/`aside.dframe-sidebar`).
    // The two detectors had drifted apart: on the new markup this one could
    // find no sidebar at all and simply never re-trigger tryInjectUI(),
    // silently disabling this health check's half of the self-healing path.
    // Reuse content.js's own detector instead so there's exactly one
    // definition of "what counts as the sidebar" for both call sites.
    const sidebarPresent = !!(window.CTS_Content && window.CTS_Content.getSidebarRoot
      ? window.CTS_Content.getSidebarRoot()
      : document.querySelector('nav'));
    const sidebarMissingQuota = sidebarPresent && !document.getElementById('ct-quota');

    if (!document.getElementById('ct-toolbar-quota') || window.CTS_RowMissing() || sidebarMissingQuota) {
      window.CTS.UIInjected = false;
      if (window.CTS_Content) window.CTS_Content.tryInjectUI();
    }
  }

  // ─── Exports ─────────────────────────────────────────────────────────────

  window.CTS_Quota = {
    syncQuotaUI,
    startCountdownTick,
    setStale,
  };

})();
