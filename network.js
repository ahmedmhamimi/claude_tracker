/**
 * All network interception and API communication for the extension.
 * Installs the global fetch hook on first load; orchestrates all outbound and
 * inbound data flows between the browser and claude.ai.
 *
 * Built to survive terrible conditions (weak/flaky connection, low RAM):
 *   - EVERY request the extension makes has a hard timeout (AbortController),
 *     so a stalled connection can never wedge the poller (the old code could
 *     leave probeInFlight=true forever, silently disabling all later polls).
 *   - Usage polling retries FOREVER with exponential backoff + jitter, and
 *     wakes instantly on 'online' / connection-change / tab-visible.
 *   - Every chat request (completed, cut off, stalled, failed, aborted, or the
 *     tab crashed mid-stream) marks the quota as "owed a re-sync". The sync is
 *     persisted, so even a crashed / OOM-killed tab reconciles on next load.
 *   - The stream tap can never break the page's own request, cancels its tee
 *     branch when it stops reading (no unbounded buffering), and only parses
 *     the few SSE events it actually needs.
 *   - Heavy optional work (conversation JSON, chat list) is throttled or
 *     skipped on slow networks / low-memory devices, and never competes with
 *     the quota sync.
 *
 * - initNetworkInterceptor() -> void: installs window.fetch hook (called once at parse)
 * - triggerUsageFetch(opts?) -> Promise<boolean>: polls /usage and routes to quota.js.
 *       opts.force bypasses the poll-rate/backoff gate (used by reconcile & wake-ups)
 * - fetchConversationData() -> Promise<void>: fetches conversation JSON and routes to content.js
 * - fetchConversationList() -> Promise<void>: fetches the chat list and routes sidebar date badges
 * - sniffStream(response, t0) -> Response: taps an SSE completion stream, populates CTS state
 * - getConvoId() -> string|null: extracts active conversation UUID from URL or state
 */

(function () {
  'use strict';

  const PENDING_KEY = 'cts_pending_sync';

  // ─── Environment profile ─────────────────────────────────────────────────

  function isSlowNet() {
    try {
      const c = navigator.connection;
      if (!c) return false;
      return !!c.saveData ||
        /^(slow-2g|2g|3g)$/.test(c.effectiveType || '') ||
        (c.rtt > 1200) ||
        (c.downlink > 0 && c.downlink < 0.7);
    } catch (_) { return false; }
  }

  function isLowEndDevice() {
    try {
      return (navigator.deviceMemory && navigator.deviceMemory <= 2) ||
             (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);
    } catch (_) { return false; }
  }

  // "Lite": do less optional work, never hold big payloads.
  const isLite = () => isSlowNet() || isLowEndDevice();
  // Slow links get twice as long before we give up on a request.
  const timeoutMs = base => (isSlowNet() ? base * 2 : base);
  const isOffline = () => navigator.onLine === false;

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function getConvoId() {
    const m = window.location.pathname.match(/\/chat\/([a-f0-9\-]{36})/i);
    if (m) return m[1];
    return window.CTS.convoId || null;
  }

  function headersToObject(h) {
    try {
      if (!h) return {};
      if (typeof Headers !== 'undefined' && h instanceof Headers) return Object.fromEntries(h.entries());
      if (Array.isArray(h)) return Object.fromEntries(h);
      return { ...h };
    } catch (_) { return {}; }
  }

  /**
   * GET + parse JSON with a hard deadline covering BOTH the headers and the
   * body (the abort signal stays attached until the body is fully read).
   * Never throws. -> { ok, status, data?, retryAfter?, tooBig? }
   */
  async function getJSON(url, baseMs, maxBytes) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs(baseMs));
    try {
      const res = await window.__originalFetch(url, {
        method: 'GET',
        headers: { ...window.CTS.authHeaders },
        signal: ctrl.signal,
      });
      if (res.status !== 200) {
        let retryAfter = 0;
        try {
          const h = res.headers.get('retry-after');
          if (h) retryAfter = /^\d+$/.test(h) ? parseInt(h, 10) * 1000 : Math.max(0, (Date.parse(h) - Date.now()) || 0);
        } catch (_) {}
        try { if (res.body) res.body.cancel(); } catch (_) {}
        return { ok: false, status: res.status, retryAfter: Math.min(retryAfter, 300000) };
      }
      if (maxBytes) {
        const len = parseInt(res.headers.get('content-length') || '0', 10);
        if (len > maxBytes) { ctrl.abort(); return { ok: false, status: 200, tooBig: true }; }
      }
      return { ok: true, status: 200, data: await res.json() };
    } catch (e) {
      return { ok: false, status: 0, error: e };
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Usage sync state ────────────────────────────────────────────────────

  const US = {
    failures:  0,     // consecutive failed usage fetches
    authFails: 0,     // consecutive 401/403s
    timer:     null,  // the single persistent-retry timer
    lastTry:   0,
    lastOk:    0,
    startedAt: 0,
    rerun:     false, // a forced fetch arrived while one was in flight
  };
  let lastStreamEndAt = 0;
  let reqInFlight     = 0;
  let reconcileTimers = [];

  // A re-sync is "owed" from the moment a chat request is sent until a usage
  // reading is confirmed AFTER that request has fully ended. Persisted so a
  // crashed/killed tab (common on low RAM) still reconciles on next load.
  try { if (localStorage.getItem(PENDING_KEY)) window.CTS._pendingSync = true; } catch (_) {}

  function markPending() {
    window.CTS._pendingSync = true;
    try { localStorage.setItem(PENDING_KEY, String(Date.now())); } catch (_) {}
  }

  function setStaleSafe(stale, reason) {
    try { if (window.CTS_Quota && window.CTS_Quota.setStale) window.CTS_Quota.setStale(stale, reason); } catch (_) {}
  }

  function markStale(reason) {
    const now = Date.now();
    // Don't flicker on one blip: only flag once the reading is genuinely old
    // (or we never had one, or we know we're offline).
    if (reason === 'offline' || !US.lastOk || now - US.lastOk > 15000) setStaleSafe(true, reason);
  }

  function armRetry(minMs) {
    if (US.timer) clearTimeout(US.timer);
    const base = US.authFails >= 3
      ? 300000
      : Math.min(60000, 1500 * Math.pow(2, Math.min(US.failures, 6)));
    const delay = Math.max(minMs || 0, base) * (0.8 + Math.random() * 0.4);
    US.timer = setTimeout(() => { US.timer = null; triggerUsageFetch({ force: true }); }, delay);
  }

  function scheduleReconcile() {
    reconcileTimers.forEach(clearTimeout);
    reconcileTimers = [500, 5000].map(ms => setTimeout(() => triggerUsageFetch({ force: true }), ms));
  }

  function beginRequest() {
    const c = window.CTS;
    reqInFlight++;
    markPending();
    c.preMessage5hUtil = c.current5hUtil;
    c._gotLimitEvent = false;
  }

  // Exactly once per request, whatever way it ended.
  function endRequest() {
    reqInFlight = Math.max(0, reqInFlight - 1);
    lastStreamEndAt = Date.now();
    scheduleReconcile();
  }

  function afterUsageSuccess() {
    const c = window.CTS;
    if (!c._pendingSync) return;
    const settled = reqInFlight === 0 && !c.isStreaming &&
                    (!lastStreamEndAt || Date.now() - lastStreamEndAt >= 3000);
    if (settled) {
      c._pendingSync = false;
      try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
      // The stream never delivered its own message_limit event (cut off), so
      // derive this turn's quota cost from the confirmed before/after readings.
      if (c._deltaPending && c.preMessage5hUtil != null) {
        const d = c.current5hUtil - c.preMessage5hUtil;
        if (d >= 0) c.lastMsgQuotaDelta = d;
        c._deltaPending = false;
      }
    } else if (reqInFlight === 0 && !c.isStreaming) {
      // Too soon after the stream ended for the server count to be final.
      const wait = Math.max(500, 3200 - (Date.now() - lastStreamEndAt));
      setTimeout(() => triggerUsageFetch({ force: true }), wait);
    }
  }

  // ─── Stream Sniffer ──────────────────────────────────────────────────────

  function readWithStall(reader, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('cts-stall')), ms);
      reader.read().then(
        v => { clearTimeout(t); resolve(v); },
        e => { clearTimeout(t); reject(e); }
      );
    });
  }

  function sniffStream(response, t0) {
    const c = window.CTS;
    let reader;
    try {
      reader = response.clone().body.getReader();
    } catch (_) {
      // Could not tap the stream. The page's own copy is untouched; just make
      // sure the quota is reconciled afterwards.
      endRequest();
      return response;
    }
    const decoder = new TextDecoder();
    const STALL_MS = isSlowNet() ? 120000 : 90000;

    (async () => {
      let buf = '', first = true, streamT0 = null;
      let sawStart = false, sawStop = false, outcome = 'done';
      c.streamOutputChars = 0;
      c.isStreaming       = true;

      function handleLine(raw) {
        const line = raw.trim();
        if (!line.startsWith('data:')) return;
        // Cheap pre-filter: skip JSON.parse for pings / block start/stop etc.
        if (!(line.includes('content_block_delta') || line.includes('message_start') ||
              line.includes('message_delta') || line.includes('message_limit') ||
              line.includes('message_stop'))) return;
        let j;
        try { j = JSON.parse(line.slice(5).trim()); } catch (_) { return; }

        if (j.type === 'message_start' && j.message?.model) {
          const meta = window.CTS_Shared.getModelMeta(j.message.model);
          c.currentModelMeta       = meta;
          c.lastConfirmedModelMeta = meta;
          streamT0 = Date.now();
          sawStart = true;
          c.sessionMsgCount++;
          // Snapshot the 5h utilization as it stood right before this
          // message's usage is counted (message_limit computes the delta).
          c.preMessage5hUtil = c.current5hUtil;
        }

        if (j.type === 'content_block_delta' && j.delta?.text) {
          c.streamOutputChars += j.delta.text.length;
        }

        if (j.type === 'message_delta' && j.delta?.stop_reason) {
          c.stopReasonHistory.unshift(j.delta.stop_reason);
          if (c.stopReasonHistory.length > 20) c.stopReasonHistory.length = 20;
        }

        if (j.type === 'message_stop') sawStop = true;

        if (j.type === 'message_limit' && j.message_limit?.windows) {
          c._gotLimitEvent = true;
          const h5  = j.message_limit.windows['5h'];
          const h7d = j.message_limit.windows['7d'];
          if (h5 && h5.utilization >= 1) c.isLimitHit = true;

          // 7d guard: utilization===1 from SSE is a transient count artifact that
          // spikes the bar to 100%. Real fractional updates (0–<1) are passed through.
          // triggerUsageFetch confirms any genuine 100% state independently.
          let safe7d = null;
          if (h7d) {
            let raw7d = h7d.utilization;
            if (raw7d > 1 && raw7d <= 100) raw7d /= 100;
            if (raw7d < 1) safe7d = { utilization: h7d.utilization, resetsAt: h7d.resets_at };
            if (h7d.resets_at) {
              const ts7 = Math.floor(Date.parse(h7d.resets_at) / 1000);
              if (!isNaN(ts7)) c.targetTimestamps['7d'] = ts7;
            }
          }

          window.CTS_Quota.syncQuotaUI({
            '5h': h5 ? { utilization: c.isLimitHit ? 100 : h5.utilization, resetsAt: h5.resets_at } : null,
            '7d': safe7d,
          });

          // Per-message quota usage from the real API-reported utilization.
          if (h5 && c.preMessage5hUtil != null) {
            const delta = c.current5hUtil - c.preMessage5hUtil;
            c.lastMsgQuotaDelta = delta >= 0 ? delta : null;
          } else {
            c.lastMsgQuotaDelta = null;
          }
        }
      }

      try {
        while (true) {
          let r;
          try {
            r = await readWithStall(reader, STALL_MS);
          } catch (e) {
            outcome = (e && e.message === 'cts-stall') ? 'stall' : 'error';
            break;
          }
          if (r.done) break;

          if (first) {
            const lat = Date.now() - t0;
            c.latencies.push(lat);
            // Real ring buffer: bounded memory, "average" reflects recent turns.
            if (c.latencies.length > 50) c.latencies.shift();
            c.lastLatencyMs = lat;
            first = false;
          }

          buf += decoder.decode(r.value, { stream: true });
          // Runaway-line guard: never let a malformed stream grow this unbounded.
          if (buf.length > 2000000) buf = buf.slice(-65536);

          let start = 0, nl;
          while ((nl = buf.indexOf('\n', start)) !== -1) {
            handleLine(buf.slice(start, nl));
            start = nl + 1;
          }
          buf = start ? buf.slice(start) : buf;
        }
      } catch (_) {
        outcome = 'error';
      } finally {
        c.isStreaming = false;
        // Stop reading → also stop the tee from buffering the rest of the
        // stream in memory on our behalf. (Cancelling one tee branch never
        // cancels the page's own branch.)
        if (outcome !== 'done') { try { reader.cancel().catch(() => {}); } catch (_) {} }

        const interrupted = outcome !== 'done' || (sawStart && !sawStop);
        c.lastStreamInterrupted = interrupted;
        // Cut off before the server's own quota event reached us: the usage
        // reading we confirm next must also yield this turn's delta.
        if (!c._gotLimitEvent) c._deltaPending = true;

        if (!interrupted && streamT0 && c.streamOutputChars > 0) {
          const secs = (Date.now() - streamT0) / 1000;
          if (secs > 0.2) c.lastSpeedTps = Math.round(Math.ceil(c.streamOutputChars / 4) / secs);
        }

        // Quota first: this is the thing that must never be lost. The server
        // counts a message even if our connection dropped mid-reply.
        endRequest();

        // Optional extras run after, and are skipped when they'd only compete
        // with a struggling connection.
        if (!interrupted) {
          const lite = isLite();
          setTimeout(fetchConversationData, lite ? 4000 : 1500);
          setTimeout(fetchConversationList, lite ? 6000 : 2500);
        }
      }
    })();

    return response;
  }

  // ─── Usage Poller ─────────────────────────────────────────────────────────

  function applyUsage(data) {
    const pick = o => o ? { utilization: o.utilization, resetsAt: o.resets_at || o.resetsAt } : null;
    // 7d.utilization from this endpoint can return a count-based artifact of
    // exactly 1 (100%) that doesn't reflect real usage — the same artifact the
    // SSE message_limit handler guards against. Apply the identical filter.
    const d7 = data.seven_day;
    let safe7d = null;
    if (d7) {
      let raw7d = d7.utilization;
      if (raw7d > 1 && raw7d <= 100) raw7d /= 100;
      if (raw7d != null && raw7d < 1) safe7d = { utilization: d7.utilization, resetsAt: d7.resets_at };
      // Always take the API's resets_at when present, so the countdown target
      // can advance past a rollover.
      if (d7.resets_at) {
        const ts7 = Math.floor(Date.parse(d7.resets_at) / 1000);
        if (!isNaN(ts7)) window.CTS.targetTimestamps['7d'] = ts7;
      }
    }
    window.CTS_Quota.syncQuotaUI({ '5h': pick(data.five_hour), '7d': safe7d });
  }

  async function triggerUsageFetch(opts) {
    const force = !!(opts && typeof opts === 'object' && opts.force);
    const c = window.CTS;
    if (!c.orgId) return false;
    const now = Date.now();

    if (c.probeInFlight) {
      // Watchdog: a request can never legitimately outlive its own timeout.
      if (now - US.startedAt > timeoutMs(12000) + 5000) {
        c.probeInFlight = false;
      } else {
        if (force) US.rerun = true;
        return false;
      }
    }

    if (!force) {
      if (now - US.lastTry < 1500) return false;
      // While failing, the backoff timer owns retries — don't pile on.
      if (US.failures > 0) return false;
      // Healthy: poll gently (much gentler on slow / low-end setups).
      if (US.lastOk && now - US.lastOk < (isLite() ? 20000 : 5000)) return false;
    }

    if (isOffline()) {
      markStale('offline');
      // One quiet slow retry timer; the 'online' event wakes us instantly.
      if (!US.timer) { US.failures = Math.max(US.failures, 3); armRetry(); }
      return false;
    }

    c.probeInFlight = true;
    US.startedAt = US.lastTry = now;
    let r;
    try {
      r = await getJSON(`https://claude.ai/api/organizations/${c.orgId}/usage`, 12000);
    } catch (_) { r = { ok: false, status: 0 }; }
    c.probeInFlight = false;

    let ok = false;
    if (r.ok && r.data) {
      try { applyUsage(r.data); ok = true; } catch (_) { ok = false; }
    }

    if (ok) {
      US.failures = 0;
      US.authFails = 0;
      US.lastOk = Date.now();
      c._lastUsageOkAt = US.lastOk;
      if (US.timer) { clearTimeout(US.timer); US.timer = null; }
      setStaleSafe(false);
      afterUsageSuccess();
    } else {
      US.failures++;
      if (r.status === 401 || r.status === 403) US.authFails++; else US.authFails = 0;
      markStale(r.status ? 'http' : 'net');
      armRetry(r.retryAfter || 0);
    }

    if (US.rerun) {
      US.rerun = false;
      setTimeout(() => triggerUsageFetch({ force: true }), ok ? 300 : 1000);
    }
    return ok;
  }

  // ─── Wake-up hooks: retry the instant conditions improve ─────────────────

  window.addEventListener('online', () => {
    US.failures = 0;
    triggerUsageFetch({ force: true });
  });
  window.addEventListener('offline', () => markStale('offline'));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (window.CTS.orgId && (US.failures > 0 || !US.lastOk || Date.now() - US.lastOk > 30000)) {
      triggerUsageFetch({ force: true });
    }
  });

  try {
    if (navigator.connection && navigator.connection.addEventListener) {
      let _connT = null;
      navigator.connection.addEventListener('change', () => {
        clearTimeout(_connT);
        _connT = setTimeout(() => {
          if (US.failures > 0 || !US.lastOk) { US.failures = 0; triggerUsageFetch({ force: true }); }
        }, 800);
      });
    }
  } catch (_) {}

  // ─── Conversation Fetcher ─────────────────────────────────────────────────

  const _convFetchedAt = {};

  async function fetchConversationData() {
    const c = window.CTS;
    if (!c.orgId || c.convFetchInFlight || isOffline()) return;
    const cid = getConvoId();
    if (!cid) return;
    const lite = isLite();
    // Optional extra: never compete with a quota sync that is struggling, and
    // on weak setups don't re-download a big conversation every few seconds.
    if (lite && US.failures > 0) return;
    if (lite && Date.now() - (_convFetchedAt[cid] || 0) < 15000) return;

    c.convFetchInFlight = true;
    try {
      _convFetchedAt[cid] = Date.now();
      const r = await getJSON(
        `https://claude.ai/api/organizations/${c.orgId}/chat_conversations/${cid}?tree=True&rendering_mode=raw`,
        20000,
        lite ? 4000000 : 0
      );
      if (r.ok && r.data) {
        window.CTS_Content.applyAnalysis(window.CTS_Shared.analyseConversation(r.data), cid);
      }
    } catch (_) {}
    finally { c.convFetchInFlight = false; }
  }

  // ─── Conversation List Fetcher ──────────────────────────────────────────
  // Powers the sidebar "created on" date badges. Purely cosmetic, so it is
  // skipped when offline / hidden, and rare on slow or low-memory setups.

  async function fetchConversationList() {
    const c = window.CTS;
    if (!c.orgId || c.convoListFetchInFlight || isOffline() || document.hidden) return;
    if (isLite() && Date.now() - (c.lastConvoListFetch || 0) < 300000) return;
    if (US.failures > 0) return;
    c.convoListFetchInFlight = true;
    try {
      const r = await getJSON(`https://claude.ai/api/organizations/${c.orgId}/chat_conversations`, 20000, isLite() ? 4000000 : 0);
      if (!r.ok) return;
      const data = r.data;
      if (Array.isArray(data)) {
        const map = {};
        data.forEach(x => {
          const ts = x && (x.created_at || x.updated_at);
          if (x && x.uuid && ts) map[x.uuid] = ts;
        });
        c.convoDateMap = map;
        c.lastConvoListFetch = Date.now();
        if (window.CTS_Content && window.CTS_Content.injectSidebarDates) {
          window.CTS_Content.injectSidebarDates();
        }
      }
    } catch (_) {}
    finally { c.convoListFetchInFlight = false; }
  }

  // ─── Fetch Hook ──────────────────────────────────────────────────────────

  function captureOrg(url, resource, options) {
    const c = window.CTS;
    const m = url.match(/\/api\/organizations\/([a-f0-9\-]{36})/i);
    if (!m) return;

    // A provisional orgId (restored from storage so we can fetch usage before
    // claude.ai's own first request) counts as "not captured yet".
    const wasProvisional = !!c._orgProvisional;
    const isFirstCapture = !c.orgId || wasProvisional;
    const orgChanged     = !isFirstCapture && c.orgId !== m[1];

    if (orgChanged) {
      c.authHeaders       = {};
      c.fetchedUpfront    = false;
      c.sessionCostEst    = 0;
      c.sessionMsgCount   = 0;
      c.sessionSpeeds     = [];
      c.latencies         = [];
      c.stopReasonHistory = [];
      c.lastLatencyMs     = null;
      c.lastSpeedTps      = null;
      c.convoCacheMap     = {};
      c.cachedUntilTs     = null;
      c.isLimitHit        = false;
    }
    if (isFirstCapture || orgChanged) {
      c.orgId = m[1];
      c._orgProvisional = false;
      if (wasProvisional) { US.failures = 0; US.authFails = 0; }
    }

    if (!Object.keys(c.authHeaders).length) {
      let h = headersToObject(options && options.headers);
      if (!Object.keys(h).length && resource && typeof resource === 'object') h = headersToObject(resource.headers);
      if (Object.keys(h).length) c.authHeaders = h;
    }
    if (!c.fetchedUpfront && c.orgId) {
      c.fetchedUpfront = true;
      setTimeout(() => triggerUsageFetch({ force: true }), 600);
    }

    if (orgChanged) {
      c.current5hUtil = 0;
      c.current7dUtil = 0;
      c.targetTimestamps = { '5h': null, '7d': null };
      c.cacheReady = false;
      ['cts_5h_util', 'cts_7d_util', 'cts_ts_5h', 'cts_ts_7d'].forEach(k => {
        try { sessionStorage.removeItem(k); } catch (_) {}
        try { localStorage.removeItem('cts_global_' + k.slice(4)); } catch (_) {}
      });
      window.CTS_StorageSet({
        cts_5h_util: 0, cts_7d_util: 0,
        cts_ts_5h: null, cts_ts_7d: null,
        cts_org_id: c.orgId,
      });
      if (window.ClaudeTrackerUI) {
        window.ClaudeTrackerUI.updateQuotaBars('5h', 0, null);
        window.ClaudeTrackerUI.updateQuotaBars('7d', 0, null);
      }
    }

    // The 5h/7d numbers on screen may have been painted speculatively from
    // storage before we knew which account this tab belongs to. If that
    // snapshot belonged to a different account, drop it.
    if (isFirstCapture) {
      (c._storageReady || Promise.resolve()).then(() => {
        const restoredOrgId = c._restoredOrgId;
        if (restoredOrgId && restoredOrgId !== c.orgId) {
          c.current5hUtil = 0;
          c.current7dUtil = 0;
          c.targetTimestamps = { '5h': null, '7d': null };
          c.isLimitHit = false;
          c.cacheReady = false;
          ['cts_5h_util', 'cts_7d_util', 'cts_ts_5h', 'cts_ts_7d'].forEach(k => {
            try { sessionStorage.removeItem(k); } catch (_) {}
            try { localStorage.removeItem('cts_global_' + k.slice(4)); } catch (_) {}
          });
          window.CTS_StorageSet({
            cts_5h_util: 0, cts_7d_util: 0,
            cts_ts_5h: null, cts_ts_7d: null,
            cts_org_id: c.orgId,
          });
          if (window.ClaudeTrackerUI) {
            window.ClaudeTrackerUI.updateQuotaBars('5h', 0, null);
            window.ClaudeTrackerUI.updateQuotaBars('7d', 0, null);
          }
          triggerUsageFetch({ force: true });
        }
      });
    }
  }

  function initNetworkInterceptor() {
    // Preserve the raw fetch before any hook
    if (!window.__originalFetch) window.__originalFetch = window.fetch;
    const originalFetch = window.__originalFetch;

    window.fetch = async function (resource, options) {
      const args = arguments;
      let isCompletion = false;
      let url = '';

      // All instrumentation is best-effort: nothing in here may ever stop the
      // page's own request from being sent.
      try {
        url = (typeof resource === 'string') ? resource : (resource && resource.url) || String(resource || '');

        if (url.includes('/api/organizations/')) captureOrg(url, resource, options);

        if (url.includes('/completion')) {
          const method = String((options && options.method) || (resource && resource.method) || 'GET').toUpperCase();
          if (method !== 'GET') {
            isCompletion = true;
            const cm = url.match(/\/chat_conversations\/([a-f0-9\-]{36})\/completion/i);
            if (cm) window.CTS.convoId = cm[1];
            try {
              const body = options && typeof options.body === 'string' ? options.body : null;
              const b = body ? JSON.parse(body) : null;
              if (b && b.model) window.CTS.currentModelMeta = window.CTS_Shared.getModelMeta(b.model);
            } catch (_) {}
            beginRequest();
          }
        }
      } catch (_) {}

      const t0 = Date.now();
      let response;
      try {
        response = await originalFetch.apply(this, args);
      } catch (err) {
        // Network failure on the chat request. The server may or may not have
        // processed it; reconcile either way, then let the page see the error.
        if (isCompletion) endRequest();
        throw err;
      }

      if (!isCompletion) return response;

      try {
        // Rate-limit / server error / bodiless: nothing to tap, but the quota
        // may have changed (or just hit the cap) — re-sync from the source.
        if (!response.ok || !response.body) {
          endRequest();
          return response;
        }
        return sniffStream(response, t0);
      } catch (_) {
        return response;
      }
    };
  }

  // Self-install on parse
  initNetworkInterceptor();

  // A previous tab died mid-request (crash / OOM / closed) or a sync never
  // finished: pay that debt as soon as we can, without waiting for a poll.
  if (window.CTS._pendingSync) {
    [1500, 6000, 20000].forEach(ms => setTimeout(() => {
      if (window.CTS._pendingSync) triggerUsageFetch({ force: true });
    }, ms));
  }

  // ─── Exports ─────────────────────────────────────────────────────────────

  window.CTS_Network = {
    triggerUsageFetch,
    fetchConversationData,
    fetchConversationList,
    getConvoId,
    isLite,
  };

})();
