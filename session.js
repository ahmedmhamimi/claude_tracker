/**
 * Per-conversation session metrics: latency ring, token speed, cost accumulation,
 * and turn counting. Resets all accumulators on conversation navigation.
 * Persists per-conversation stats to sessionStorage so navigating away and back
 * restores turns, cost, and latency data correctly.
 *
 * - CTS_Session.resetForConvo(convoId) -> void: saves current convo stats, loads or resets for new convoId
 * - CTS_Session.recordTurn(lastInputTokens, lastOutputTokens) -> void: adds cost/latency/speed for one completed turn
 * - CTS_Session.getStatsConvoId() -> string|null: returns the convoId for which stats are currently tracked
 */

(function () {
  'use strict';

  const SESS_PREFIX = 'cts_cv_';

  let _statsConvoId = null;

  // ─── Persistence ─────────────────────────────────────────────────────────

  function _saveConvoStats(convoId) {
    if (!convoId) return;
    try {
      sessionStorage.setItem(SESS_PREFIX + convoId, JSON.stringify({
        sessionMsgCount:   window.CTS.sessionMsgCount,
        sessionCostEst:    window.CTS.sessionCostEst,
        latencies:         window.CTS.latencies,
        lastLatencyMs:     window.CTS.lastLatencyMs,
        lastSpeedTps:      window.CTS.lastSpeedTps,
        sessionConvTokens: window.CTS.sessionConvTokens,
        stopReasonHistory: window.CTS.stopReasonHistory,
      }));
    } catch (_) {}
  }

  function _loadConvoStats(convoId) {
    if (!convoId) return false;
    try {
      const raw = sessionStorage.getItem(SESS_PREFIX + convoId);
      if (!raw) return false;
      const d = JSON.parse(raw);
      window.CTS.sessionMsgCount   = d.sessionMsgCount   ?? 0;
      window.CTS.sessionCostEst    = d.sessionCostEst    ?? 0;
      window.CTS.latencies         = Array.isArray(d.latencies)         ? d.latencies         : [];
      window.CTS.lastLatencyMs     = d.lastLatencyMs     ?? null;
      window.CTS.lastSpeedTps      = d.lastSpeedTps      ?? null;
      window.CTS.sessionConvTokens = d.sessionConvTokens ?? 0;
      window.CTS.stopReasonHistory = Array.isArray(d.stopReasonHistory) ? d.stopReasonHistory : [];
      return true;
    } catch (_) { return false; }
  }

  // ─── Reset ────────────────────────────────────────────────────────────────

  function resetForConvo(convoId) {
    if (!convoId || convoId === _statsConvoId) return;
    // Snapshot current convo before switching
    _saveConvoStats(_statsConvoId);
    _statsConvoId = convoId;
    // Restore saved stats for the new convo, or start fresh
    if (!_loadConvoStats(convoId)) {
      window.CTS.sessionMsgCount   = 0;
      window.CTS.sessionCostEst    = 0;
      window.CTS.latencies         = [];
      window.CTS.lastLatencyMs     = null;
      window.CTS.lastSpeedTps      = null;
      window.CTS.sessionConvTokens = 0;
      window.CTS.stopReasonHistory = [];
    }
  }

  // ─── Turn Recorder ────────────────────────────────────────────────────────

  function recordTurn(lastInputTokens, lastOutputTokens) {
    const meta = window.CTS.currentModelMeta;
    if (meta && lastOutputTokens != null && lastInputTokens != null) {
      window.CTS.sessionCostEst +=
        ((lastInputTokens  / 1e6) * meta.pIn) +
        ((lastOutputTokens / 1e6) * meta.pOut);
    }
  }

  // ─── Accessor ────────────────────────────────────────────────────────────

  function getStatsConvoId() {
    return _statsConvoId;
  }

  // ─── Exports ─────────────────────────────────────────────────────────────

  window.CTS_Session = {
    resetForConvo,
    recordTurn,
    getStatsConvoId,
  };

})();

