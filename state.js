/**
 * Single mutable runtime state object (window.CTS) for the entire extension.
 * - CTS: object — all shared runtime state; mutated in-place by all modules
 *
 * Fields:
 *   orgId              string|null     — detected organisation UUID
 *   convoId            string|null     — active conversation UUID
 *   authHeaders        object          — captured auth headers for API calls
 *   fetchedUpfront     boolean         — whether initial usage fetch has fired
 *   targetTimestamps   object          — {5h, 7d} reset Unix timestamps
 *   activeResetTriggers object         — {5h, 7d} debounce flags for reset polls
 *   current5hUtil      number          — latest 5h utilization % (0–100)
 *   current7dUtil      number          — latest 7d utilization % (0–100)
 *   isLimitHit         boolean         — whether the 5h limit has been reached
 *   UIInjected         boolean         — whether DOM components have been injected
 *   coreUIInjected     boolean         — whether one-time UI init (CSS/observers/badge) has run; never reset, unlike UIInjected
 *   isStreaming        boolean         — whether a response stream is active
 *   probeInFlight      boolean         — whether a usage probe request is pending
 *   convFetchInFlight  boolean         — whether a conversation fetch is pending
 *   currentModelMeta   object|null     — meta for the model currently in use
 *   lastConfirmedModelMeta object|null — meta confirmed from SSE message_start
 *   streamOutputChars  number          — char count of current stream output
 *   cachedUntilTs      number|null     — timestamp until which prompt cache is valid
 *   sessionCostEst     number          — accumulated USD cost estimate this session
 *   lastActivityTime   number          — epoch ms of last user interaction
 *   inactivityArmed    boolean         — debounce flag for inactivity fetch
 *   sessionMsgCount    number          — assistant response count this session
 *   latencies          number[]        — TTFT ring buffer
 *   sessionSpeeds      number[]        — t/s readings this session
 *   stopReasonHistory  string[]        — stop_reason values, newest first
 *   lastLatencyMs      number|null     — TTFT of last response
 *   lastSpeedTps       number|null     — t/s of last response
 *   convoCacheMap      object          — convoId → cache tracking state
 *   sessionConvTokens  number          — total token count from last conversation fetch
 */

(function (root) {
  'use strict';

  if (root.CTS) return; // already initialised (guard against double-injection)

  root.CTS = {
    // Identity & auth
    orgId:               null,
    convoId:             null,
    authHeaders:         {},
    fetchedUpfront:      false,

    // Quota windows
    targetTimestamps:    { '5h': null, '7d': null },
    activeResetTriggers: { '5h': false, '7d': false },
    current5hUtil:       0,
    current7dUtil:       0,
    isLimitHit:          false,

    // UI state
    UIInjected:          false,
    coreUIInjected:      false,

    // Streaming state
    isStreaming:         false,
    probeInFlight:       false,
    convFetchInFlight:   false,
    streamOutputChars:   0,

    // Model tracking
    currentModelMeta:       null,
    lastConfirmedModelMeta: null,

    // Cache state
    cachedUntilTs:       null,
    convoCacheMap:       {},

    // Session accumulation
    sessionCostEst:      0,
    sessionMsgCount:     0,
    sessionSpeeds:       [],
    latencies:           [],
    stopReasonHistory:   [],
    lastLatencyMs:       null,
    lastSpeedTps:        null,
    lastActivityTime:    Date.now(),
    inactivityArmed:     false,

    // Analysis scratch
    sessionConvTokens:   0,
  };

  // Restore last-known-good 7d utilization so page refreshes don't flash 0%
  // while waiting for the first SSE event to confirm the real value.
  try {
    const _7d = sessionStorage.getItem('cts_7d_util');
    if (_7d !== null) root.CTS.current7dUtil = parseInt(_7d, 10) || 0;
  } catch (_) {}

  // Restore quota utilization and reset timestamps from chrome.storage.local so
  // navigating to a new chat doesn't flash 0% bars while waiting for the first fetch.
  //
  // bridge.js (ISOLATED world) performs the actual chrome.storage.local.get and
  // stamps the result onto document.documentElement.dataset.ctsstorage as JSON.
  // We poll for that attribute here rather than calling chrome.storage directly,
  // because content scripts running in the MAIN world have no chrome.* access.
  // _storageReady resolves once the restore is complete (or on timeout).
  root.CTS._storageRestored = false;
  root.CTS._storageReady = new Promise(resolve => {
    const POLL_INTERVAL = 30;  // ms
    const POLL_TIMEOUT  = 3000; // ms — give up after this and resolve with whatever we have
    const start = Date.now();

    function tryRead() {
      const raw = document.documentElement.dataset.ctsstorage;
      if (raw !== undefined) {
        try {
          const items  = JSON.parse(raw);
          const nowSec = Math.floor(Date.now() / 1000);

          // A restored reset timestamp already in the past means that window
          // rolled over while this tab was closed/idle. Trusting the paired
          // utilization % in that case paints a stale number (e.g. a 100%
          // snapshot from the window that just expired) with nothing to
          // correct it: the API won't supply a fresh resets_at for the new
          // window until the next message anchors it, so the countdown has
          // no real target and gets stuck on "refreshing…" indefinitely.
          // Treat an expired snapshot as fully stale — drop both the % and
          // the timestamp — so current5hUtil/targetTimestamps stay at their
          // fresh defaults (0 / null) until triggerUsageFetch() or the next
          // SSE event supplies honest data for the new window.
          const fiveHExpired  = items.cts_ts_5h != null && items.cts_ts_5h <= nowSec;
          const sevenDExpired = items.cts_ts_7d != null && items.cts_ts_7d <= nowSec;

          if (!fiveHExpired) {
            if (items.cts_5h_util != null) root.CTS.current5hUtil = items.cts_5h_util;
            if (items.cts_ts_5h  != null) root.CTS.targetTimestamps['5h'] = items.cts_ts_5h;
          }
          // bridge wins over sessionStorage for 7d since it survives new tabs
          if (!sevenDExpired) {
            if (items.cts_7d_util != null) root.CTS.current7dUtil = items.cts_7d_util;
            if (items.cts_ts_7d  != null) root.CTS.targetTimestamps['7d'] = items.cts_ts_7d;
          }
        } catch (_) {}
        root.CTS._storageRestored = true;
        resolve();
      } else if (Date.now() - start < POLL_TIMEOUT) {
        setTimeout(tryRead, POLL_INTERVAL);
      } else {
        // Bridge didn't respond in time — resolve so the rest of the extension
        // doesn't stall. Bars will populate once the first SSE event arrives.
        root.CTS._storageRestored = true;
        resolve();
      }
    }
    tryRead();
  });

  // ── storage write helper ────────────────────────────────────────────────
  // MAIN world cannot call chrome.storage.local.set directly. Dispatch a
  // CustomEvent that bridge.js (ISOLATED world) intercepts and forwards.
  // Usage: window.CTS_StorageSet({ cts_5h_util: 42, ... })
  root.CTS_StorageSet = function (items) {
    document.dispatchEvent(new CustomEvent('cts:storage:set', { detail: items }));
  };

})(window);
