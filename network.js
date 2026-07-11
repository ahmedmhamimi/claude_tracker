/**
 * All network interception and API communication for the extension.
 * Installs the global fetch hook on first load; orchestrates all outbound and
 * inbound data flows between the browser and claude.ai.
 *
 * - initNetworkInterceptor() -> void: installs window.fetch hook (called once at parse)
 * - triggerUsageFetch() -> Promise<void>: polls /usage endpoint and routes to quota.js
 * - fetchConversationData() -> Promise<void>: fetches conversation JSON and routes to content.js
 * - sniffStream(response, t0) -> Response: taps an SSE completion stream, populates CTS state
 * - getConvoId() -> string|null: extracts active conversation UUID from URL or state
 */

(function () {
  'use strict';

  // ─── Helpers ─────────────────────────────────────────────────────────────

  // fetch's `headers` option can arrive as a Headers instance, an array of
  // [key, value] pairs, or a plain object. `{ ...headersInstance }` silently
  // produces {} for the Headers case (its entries live behind iterator
  // methods, not own enumerable props), which was making every "authed"
  // request downstream go out with no auth headers at all — and since every
  // caller wraps its fetch in try/catch, the resulting non-200 responses
  // failed silently instead of surfacing as an error.
  function normalizeHeaders(h) {
    try {
      if (h instanceof Headers) return Object.fromEntries(h.entries());
      if (Array.isArray(h)) return Object.fromEntries(h);
      if (typeof h === 'object') return { ...h };
    } catch (_) {}
    return {};
  }

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
          break;
        }

        if (first) {
          window.CTS.latencies.push(Date.now() - t0);
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
            }

            if (j.type === 'content_block_delta' && j.delta?.text) {
              window.CTS.streamOutputChars += j.delta.text.length;
            }

            if (j.type === 'message_delta' && j.delta?.stop_reason) {
              window.CTS.stopReasonHistory.unshift(j.delta.stop_reason);
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
      // Only update 5h from the /usage endpoint — 7d.utilization from this endpoint
      // returns the same count-based artifact (value of 1) that causes false 100% spikes.
      // 7d is updated exclusively via SSE message_limit events which carry the real fraction.
      // The 7d reset timestamp is still captured here if we don't have it yet.
      const d7 = data.seven_day;
      if (d7?.resets_at && !window.CTS.targetTimestamps['7d']) {
        const ts7 = Math.floor(Date.parse(d7.resets_at) / 1000);
        if (!isNaN(ts7)) window.CTS.targetTimestamps['7d'] = ts7;
      }
      window.CTS_Quota.syncQuotaUI({ '5h': pick(data.five_hour), '7d': null });
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
          if (!window.CTS.orgId) window.CTS.orgId = m[1];
          if (opts.headers && !Object.keys(window.CTS.authHeaders).length) {
            window.CTS.authHeaders = normalizeHeaders(opts.headers);
          }
          if (!window.CTS.fetchedUpfront && window.CTS.orgId) {
            window.CTS.fetchedUpfront = true;
            setTimeout(triggerUsageFetch, 600);
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
    getConvoId,
  };

})();
