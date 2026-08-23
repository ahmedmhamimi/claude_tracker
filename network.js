/**
 * All network interception and API communication for the extension.
 * Installs the global fetch hook on first load; orchestrates all outbound and
 * inbound data flows between the browser and claude.ai.
 *
 * - initNetworkInterceptor() -> void: installs window.fetch hook (called once at parse)
 * - triggerUsageFetch() -> Promise<void>: polls /usage endpoint and routes to quota.js
 * - fetchConversationData() -> Promise<void>: fetches conversation JSON and routes to content.js
 * - fetchConversationList() -> Promise<void>: fetches the chat list (uuid + created_at) and routes sidebar date badges to content.js
 * - sniffStream(response, t0) -> Response: taps an SSE completion stream, populates CTS state
 * - getConvoId() -> string|null: extracts active conversation UUID from URL or state
 */

(function () {
  'use strict';

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function getConvoId() {
    const m = window.location.pathname.match(/\/chat\/([a-f0-9\-]{36})/i);
    if (m) return m[1];
    return window.CTS.convoId || null;
  }

  // ─── Stream Sniffer ──────────────────────────────────────────────────────

  function sniffStream(response, t0) {
    const cloned  = response.clone();
    const reader  = cloned.body.getReader();
    const decoder = new TextDecoder();

    (async () => {
      let buf = '', first = true, streamT0 = null;
      window.CTS.streamOutputChars = 0;
      window.CTS.isStreaming        = true;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          window.CTS.isStreaming = false;
          if (streamT0 && window.CTS.streamOutputChars > 0) {
            window.CTS.lastSpeedTps = Math.round(
              Math.ceil(window.CTS.streamOutputChars / 4) /
              ((Date.now() - streamT0) / 1000)
            );
          }
          // Trigger conversation fetch → applyAnalysis → badge update
          setTimeout(fetchConversationData, 600);
          // A brand-new chat won't have a sidebar date badge yet (it wasn't
          // in the last list fetch) — refresh so it picks one up.
          setTimeout(fetchConversationList, 800);
          break;
        }

        if (first) {
          window.CTS.latencies.push(Date.now() - t0);
          // Keep this an actual ring buffer (per state.js's own doc comment)
          // instead of growing unbounded for the life of the tab, which was
          // both a slow memory leak and made the displayed "average" latency
          // drift toward a lifetime average instead of a recent one.
          if (window.CTS.latencies.length > 50) window.CTS.latencies.shift();
          window.CTS.lastLatencyMs = Date.now() - t0;
          first = false;
        }

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line.startsWith('data:')) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());

            if (j.type === 'message_start' && j.message?.model) {
              const meta = window.CTS_Shared.getModelMeta(j.message.model);
              window.CTS.currentModelMeta       = meta;
              window.CTS.lastConfirmedModelMeta = meta;
              streamT0 = Date.now();
              window.CTS.sessionMsgCount++;
              // Snapshot the 5h utilization as it stood right before this
              // message's usage is counted, so message_limit below can
              // compute exactly how many points this one turn consumed.
              window.CTS.preMessage5hUtil = window.CTS.current5hUtil;
            }

            if (j.type === 'content_block_delta' && j.delta?.text) {
              window.CTS.streamOutputChars += j.delta.text.length;
            }

            if (j.type === 'message_delta' && j.delta?.stop_reason) {
              window.CTS.stopReasonHistory.unshift(j.delta.stop_reason);
              // Only stopReasonHistory[0] (the newest) is ever read anywhere
              // in the extension — cap it instead of growing forever.
              if (window.CTS.stopReasonHistory.length > 20) window.CTS.stopReasonHistory.length = 20;
            }

            if (j.type === 'message_limit' && j.message_limit?.windows) {
              const h5  = j.message_limit.windows['5h'];
              const h7d = j.message_limit.windows['7d'];
              if (h5 && h5.utilization >= 1) window.CTS.isLimitHit = true;

              // 7d guard: utilization===1 from SSE is a transient count artifact that
              // spikes the bar to 100%. Real fractional updates (0–<1) are passed through.
              // triggerUsageFetch confirms any genuine 100% state independently.
              let safe7d = null;
              if (h7d) {
                let raw7d = h7d.utilization;
                if (raw7d > 1 && raw7d <= 100) raw7d /= 100;
                if (raw7d < 1) safe7d = { utilization: h7d.utilization, resetsAt: h7d.resets_at };
                // Always capture reset timestamp even when blocking the utilization
                if (h7d.resets_at && !window.CTS.targetTimestamps['7d']) {
                  const ts7 = Math.floor(Date.parse(h7d.resets_at) / 1000);
                  if (!isNaN(ts7)) window.CTS.targetTimestamps['7d'] = ts7;
                }
              }

              window.CTS_Quota.syncQuotaUI({
                '5h': h5 ? { utilization: window.CTS.isLimitHit ? 100 : h5.utilization, resetsAt: h5.resets_at } : null,
                '7d': safe7d,
              });

              // Per-message quota usage: how many percentage points of the
              // 5h window this turn consumed, using the real API-reported
              // utilization (not a token/cost estimate). Only meaningful
              // once we actually had a pre-message baseline to diff against
              // — the very first message of a session has none yet.
              if (h5 && window.CTS.preMessage5hUtil != null) {
                const delta = window.CTS.current5hUtil - window.CTS.preMessage5hUtil;
                window.CTS.lastMsgQuotaDelta = delta >= 0 ? delta : null;
              } else {
                window.CTS.lastMsgQuotaDelta = null;
              }
            }
          } catch (_) {}
        }

        buf = lines[lines.length - 1];
      }
    })();

    return response;
  }

  // ─── Usage Poller ─────────────────────────────────────────────────────────

  async function triggerUsageFetch() {
    if (!window.CTS.orgId || window.CTS.probeInFlight) return;
    window.CTS.probeInFlight = true;
    try {
      const res = await window.__originalFetch(
        `https://claude.ai/api/organizations/${window.CTS.orgId}/usage`,
        { method: 'GET', headers: { ...window.CTS.authHeaders } }
      );
      if (res.status !== 200) return;
      const data = await res.json();
      const pick = o => o ? { utilization: o.utilization, resetsAt: o.resets_at || o.resetsAt } : null;
      // 7d.utilization from this endpoint can return a count-based artifact
      // of exactly 1 (100%) that doesn't reflect real usage — the same
      // artifact the SSE message_limit handler above guards against. We
      // apply that identical filter here instead of discarding 7d outright:
      // otherwise, once the 7d reset countdown hits zero and schedules this
      // very fetch to unstick the display, there is nothing else that can
      // ever refresh it — it would sit on "refreshing…" until the user
      // happens to send a new message and get a live stream back.
      const d7 = data.seven_day;
      let safe7d = null;
      if (d7) {
        let raw7d = d7.utilization;
        if (raw7d > 1 && raw7d <= 100) raw7d /= 100;
        if (raw7d != null && raw7d < 1) safe7d = { utilization: d7.utilization, resetsAt: d7.resets_at };
        if (d7.resets_at && !window.CTS.targetTimestamps['7d']) {
          const ts7 = Math.floor(Date.parse(d7.resets_at) / 1000);
          if (!isNaN(ts7)) window.CTS.targetTimestamps['7d'] = ts7;
        }
      }
      window.CTS_Quota.syncQuotaUI({ '5h': pick(data.five_hour), '7d': safe7d });
    } catch (_) {}
    finally { window.CTS.probeInFlight = false; }
  }

  // ─── Conversation Fetcher ─────────────────────────────────────────────────

  async function fetchConversationData() {
    if (!window.CTS.orgId || window.CTS.convFetchInFlight) return;
    const cid = getConvoId();
    if (!cid) return;
    window.CTS.convFetchInFlight = true;
    try {
      const res = await window.__originalFetch(
        `https://claude.ai/api/organizations/${window.CTS.orgId}/chat_conversations/${cid}?tree=True&rendering_mode=raw`,
        { method: 'GET', headers: { ...window.CTS.authHeaders } }
      );
      if (res.status === 200) {
        window.CTS_Content.applyAnalysis(
          window.CTS_Shared.analyseConversation(await res.json()),
                                         cid
        );
      }
    } catch (_) {}
    finally { window.CTS.convFetchInFlight = false; }
  }

  // ─── Conversation List Fetcher ──────────────────────────────────────────
  // Powers the sidebar "created on" date badges. This is the same list
  // endpoint the app itself uses to populate the sidebar, so it returns
  // every conversation's uuid + created_at in one call — no need to hit the
  // (much heavier) per-conversation endpoint for each row.

  async function fetchConversationList() {
    if (!window.CTS.orgId || window.CTS.convoListFetchInFlight) return;
    window.CTS.convoListFetchInFlight = true;
    try {
      const res = await window.__originalFetch(
        `https://claude.ai/api/organizations/${window.CTS.orgId}/chat_conversations`,
        { method: 'GET', headers: { ...window.CTS.authHeaders } }
      );
      if (res.status !== 200) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        const map = {};
        data.forEach(c => {
          const ts = c && (c.created_at || c.updated_at);
          if (c && c.uuid && ts) map[c.uuid] = ts;
        });
        window.CTS.convoDateMap = map;
        window.CTS.lastConvoListFetch = Date.now();
        if (window.CTS_Content && window.CTS_Content.injectSidebarDates) {
          window.CTS_Content.injectSidebarDates();
        }
      }
    } catch (_) {}
    finally { window.CTS.convoListFetchInFlight = false; }
  }

  // ─── Fetch Hook ──────────────────────────────────────────────────────────

  function initNetworkInterceptor() {
    // Preserve the raw fetch before any hook
    if (!window.__originalFetch) window.__originalFetch = window.fetch;
    const originalFetch = window.__originalFetch;

    window.fetch = async function (resource, options = {}) {
      const url = (typeof resource === 'string') ? resource : (resource?.url ?? '');
      const opts = options;

      // ── Capture org ID and auth headers ───────────────────────────────────
      if (url.includes('/api/organizations/')) {
        const m = url.match(/\/api\/organizations\/([a-f0-9\-]{36})/i);
        if (m) {
          const isFirstCapture = !window.CTS.orgId;
          // orgId was previously "capture once, never touch again" — fine as
          // long as switching org/workspace always forces a full page
          // reload, but if the app ever supports switching without one, this
          // tab would silently keep polling/tracking the *old* org forever.
          // Detecting a genuine change and resetting is a strict improvement
          // either way: a no-op if such switches never happen, and correct
          // if they do.
          const orgChanged = !isFirstCapture && window.CTS.orgId !== m[1];

          if (orgChanged) {
            window.CTS.authHeaders       = {};
            window.CTS.fetchedUpfront    = false;
            window.CTS.sessionCostEst    = 0;
            window.CTS.sessionMsgCount   = 0;
            window.CTS.sessionSpeeds     = [];
            window.CTS.latencies         = [];
            window.CTS.stopReasonHistory = [];
            window.CTS.lastLatencyMs     = null;
            window.CTS.lastSpeedTps      = null;
            window.CTS.convoCacheMap     = {};
            window.CTS.cachedUntilTs     = null;
            window.CTS.isLimitHit        = false;
          }
          if (isFirstCapture || orgChanged) window.CTS.orgId = m[1];

          if (opts.headers && !Object.keys(window.CTS.authHeaders).length) {
            window.CTS.authHeaders = { ...opts.headers };
          }
          if (!window.CTS.fetchedUpfront && window.CTS.orgId) {
            window.CTS.fetchedUpfront = true;
            setTimeout(triggerUsageFetch, 600);
          }

          if (orgChanged) {
            // We know for certain this tab now belongs to a different org —
            // no need to consult the page-load cache check below, just clear
            // the quota display immediately.
            window.CTS.current5hUtil = 0;
            window.CTS.current7dUtil = 0;
            window.CTS.targetTimestamps = { '5h': null, '7d': null };
            try { sessionStorage.removeItem('cts_7d_util'); } catch (_) {}
            window.CTS_StorageSet({
              cts_5h_util: 0, cts_7d_util: 0,
              cts_ts_5h: null, cts_ts_7d: null,
              cts_org_id: window.CTS.orgId,
            });
            if (window.ClaudeTrackerUI) {
              window.ClaudeTrackerUI.updateQuotaBars('5h', 0, null);
              window.ClaudeTrackerUI.updateQuotaBars('7d', 0, null);
            }
          }

          // The 5h/7d numbers on screen right now may have been painted
          // speculatively from chrome.storage.local before we knew which
          // account this tab belongs to (see state.js). Now that the real
          // orgId is known, check whether that cached snapshot actually
          // belonged to a *different* account (e.g. a fresh account with
          // its own limits, signed in after a different account had already
          // cached its usage on this browser) and, if so, drop it instead of
          // leaving someone else's usage on screen until the next SSE event.
          if (isFirstCapture) {
            (window.CTS._storageReady || Promise.resolve()).then(() => {
              const restoredOrgId = window.CTS._restoredOrgId;
              if (restoredOrgId && restoredOrgId !== window.CTS.orgId) {
                window.CTS.current5hUtil = 0;
                window.CTS.current7dUtil = 0;
                window.CTS.targetTimestamps = { '5h': null, '7d': null };
                window.CTS.isLimitHit = false;
                try { sessionStorage.removeItem('cts_7d_util'); } catch (_) {}
                window.CTS_StorageSet({
                  cts_5h_util: 0, cts_7d_util: 0,
                  cts_ts_5h: null, cts_ts_7d: null,
                  cts_org_id: window.CTS.orgId,
                });
                if (window.ClaudeTrackerUI) {
                  window.ClaudeTrackerUI.updateQuotaBars('5h', 0, null);
                  window.ClaudeTrackerUI.updateQuotaBars('7d', 0, null);
                }
              }
            });
          }
        }
      }

      // ── Capture conversation ID from completion URL ────────────────────────
      if (url.includes('/completion')) {
        const cm = url.match(/\/chat_conversations\/([a-f0-9\-]{36})\/completion/i);
        if (cm) window.CTS.convoId = cm[1];
        try {
          const b = opts.body ? JSON.parse(opts.body) : null;
          if (b?.model) window.CTS.currentModelMeta = window.CTS_Shared.getModelMeta(b.model);
        } catch (_) {}
      }

      const t0       = Date.now();
      const response = await originalFetch.apply(this, [resource, opts]);

      // ── Stream: tap completion response ───────────────────────────────────
      if (url.includes('/completion')) {
        return sniffStream(response, t0);
      }

      return response;
    };
  }

  // Self-install on parse
  initNetworkInterceptor();

  // ─── Exports ─────────────────────────────────────────────────────────────

  window.CTS_Network = {
    triggerUsageFetch,
    fetchConversationData,
    fetchConversationList,
    getConvoId,
  };

})();
