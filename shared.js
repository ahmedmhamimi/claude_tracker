/**
 * Shared constants, pure utilities, and stateless analysis functions.
 * - MODEL_META: object — model-id → {ctx, pIn, pOut}
 * - MODEL_ALIASES: object — display-name alias → canonical model-id
 * - getModelMeta(s) -> object|null: resolves any model string to its meta entry
 * - formatCost(usd) -> string|null: formats a USD float for display
 * - formatTokens(n) -> string: formats a token count with k suffix
 * - extractText(msg) -> string: pulls plain text out of a chat message object
 * - estimateTokens(text) -> number: heuristic BPE token estimate for plain text
 * - analyseConversation(data) -> object|null: derives token counts from raw convo data
 * - getPeakStatus() -> {inPeak, msUntil}: current Anthropic peak-hour status in PT
 */

(function (root) {
  'use strict';

  // ─── Model Registry ────────────────────────────────────────────────────────

  const MODEL_META = {
    'claude-sonnet-4-6':  { ctx: 1000000, pIn:  3.00, pOut: 15.00 },
    'claude-opus-4-7':    { ctx: 1000000, pIn: 15.00, pOut: 75.00 },
    'claude-opus-4-6':    { ctx: 1000000, pIn: 15.00, pOut: 75.00 },
    'claude-sonnet-4-5':  { ctx: 200000,  pIn:  3.00, pOut: 15.00 },
    'claude-haiku-4-5':   { ctx: 200000,  pIn:  0.80, pOut:  4.00 },
    'claude-sonnet-4':    { ctx: 200000,  pIn:  3.00, pOut: 15.00 },
    'claude-opus-4':      { ctx: 200000,  pIn: 15.00, pOut: 75.00 },
    'claude-3-5-sonnet':  { ctx: 200000,  pIn:  3.00, pOut: 15.00 },
    'claude-3-5-haiku':   { ctx: 200000,  pIn:  0.80, pOut:  4.00 },
    'claude-3-opus':      { ctx: 200000,  pIn: 15.00, pOut: 75.00 },
  };

  const MODEL_ALIASES = {
    'sonnet 4.6':  'claude-sonnet-4-6',
    'opus 4.6':    'claude-opus-4-6',
    'opus 4.7':    'claude-opus-4-7',
    'sonnet 4.5':  'claude-sonnet-4-5',
    'haiku 4.5':   'claude-haiku-4-5',
    'sonnet 4':    'claude-sonnet-4',
    'opus 4':      'claude-opus-4',
  };

  // ─── Model Resolver ────────────────────────────────────────────────────────

  function getModelMeta(s) {
    if (!s) return null;
    const l = s.toLowerCase();
    for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
      if (l.includes(alias)) return MODEL_META[canonical] || null;
    }
    for (const k of Object.keys(MODEL_META)) {
      if (l.includes(k)) return MODEL_META[k];
    }
    return { ctx: 200000, pIn: 3.00, pOut: 15.00 };
  }

  // ─── Formatters ───────────────────────────────────────────────────────────

  function formatCost(usd) {
    if (!usd || isNaN(usd) || usd === 0) return null;
    if (usd < 0.0001) return '<$0.0001';
    return '$' + usd.toFixed(4);
  }

  function formatTokens(n) {
    if (n == null) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  // ─── Message Text Extractor ────────────────────────────────────────────────

  function extractText(msg) {
    if (Array.isArray(msg.content)) return msg.content.map(c => c.text || '').join('');
    return msg.text || '';
  }

  // ─── Token Estimator ──────────────────────────────────────────────────────
  // Used only for context-window progress bar (totalTokens / ctx).
  // NOT used for savings calculations — savings are measured from char deltas.

  function estimateTokens(text) {
    if (!text || !text.trim()) return 0;
    let tokens = 0;
    text = text.replace(/```[\s\S]*?```/g, m => { tokens += Math.ceil(m.length / 3); return ''; });
    text = text.replace(/`[^`]+`/g, m => { tokens += Math.ceil(m.length / 3); return ''; });
    text = text.replace(/https?:\/\/\S+/g, m => { tokens += Math.ceil(m.length / 2); return ''; });
    text = text.replace(/\b\d[\d,.]*\b/g, m => { tokens += Math.ceil(m.length / 2); return ''; });
    const mdMatches = text.match(/(\*\*|__|#{1,6}|>\s|^\s*[-*]\s)/gm) || [];
    tokens += mdMatches.length;
    text = text.replace(/(\*\*|__|#{1,6}|>\s|^\s*[-*]\s)/gm, '');
    tokens += Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3);
    return tokens;
  }

  // ─── Conversation Analyser ────────────────────────────────────────────────

  function analyseConversation(data) {
    if (!data || !Array.isArray(data.chat_messages)) return null;
    const messages = data.chat_messages;
    let totalTokens = 0;
    messages.forEach(m => { totalTokens += estimateTokens(extractText(m)); });
    const humanMsgs = messages.filter(m => m.sender === 'human');
    const lastHuman = humanMsgs[humanMsgs.length - 1];
    const lastInputTokens = lastHuman ? estimateTokens(extractText(lastHuman)) : null;
    const assistantMsgs = messages.filter(m => m.sender === 'assistant');
    if (!assistantMsgs.length) return { totalTokens, lastInputTokens, lastOutputTokens: null, assistantCount: 0 };
    const lastOutputTokens = estimateTokens(extractText(assistantMsgs[assistantMsgs.length - 1]));
    return { totalTokens, lastInputTokens, lastOutputTokens, assistantCount: assistantMsgs.length };
  }

  // ─── Peak Status ──────────────────────────────────────────────────────────
  // Anthropic peak hours: Mon–Fri 05:00–11:00 PT.

  function getPeakStatus() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const mar1 = new Date(Date.UTC(y, 2, 1));
    const dstStart = new Date(Date.UTC(y, 2, 1 + ((7 - mar1.getUTCDay()) % 7) + 7, 10));
    const nov1 = new Date(Date.UTC(y, 10, 1));
    const dstEnd = new Date(Date.UTC(y, 10, 1 + ((7 - nov1.getUTCDay()) % 7), 9));
    const isDst = now >= dstStart && now < dstEnd;

    const ptOffsetMs = (isDst ? -7 : -8) * 60 * 60 * 1000;
    const ptDate = new Date(now.getTime() + ptOffsetMs);

    const dayOfWeek = ptDate.getUTCDay();
    const hour = ptDate.getUTCHours();
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const minuteOfDay = hour * 60 + ptDate.getUTCMinutes();

    const inPeak = isWeekday && minuteOfDay >= 300 && minuteOfDay < 660;
    let msUntil = 0;

    if (inPeak) {
      const end = new Date(ptDate);
      end.setUTCHours(11, 0, 0, 0);
      msUntil = end.getTime() - ptDate.getTime();
    } else {
      let cand = new Date(ptDate);
      cand.setUTCHours(5, 0, 0, 0);
      if (cand.getTime() <= ptDate.getTime()) cand.setUTCDate(cand.getUTCDate() + 1);
      while (cand.getUTCDay() === 0 || cand.getUTCDay() === 6) cand.setUTCDate(cand.getUTCDate() + 1);
      msUntil = cand.getTime() - ptDate.getTime();
    }
    return { inPeak, msUntil };
  }

  // ─── Export ───────────────────────────────────────────────────────────────

  root.CTS_Shared = {
    MODEL_META,
    MODEL_ALIASES,
    getModelMeta,
    formatCost,
    formatTokens,
    extractText,
    estimateTokens,
    analyseConversation,
    getPeakStatus,
  };

})(window);
