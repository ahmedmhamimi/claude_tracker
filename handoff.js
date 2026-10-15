/**
 * Context hand-off logic (pure): turns a normalized conversation into text that
 * can be carried into a new chat. This addresses the per-chat length (context)
 * limit only; it does not raise or reset the 5-hour / 7-day usage quota.
 *
 * Rules: deterministic; keeps message order; never splits a code fence (a
 * fence is kept whole or trimmed with its closing fence intact); never cuts a
 * message mid-word; refuses (rather than silently trims) when the result would
 * exceed the token budget.
 *
 * - CTS_Handoff.plan(conv, opts) -> {ok, text, tokens, chatTokens, carried, total, budget, error?}
 *     opts: {mode:'recent'|'balanced'|'compact', pct (recent only, 10-100), budget (tokens), labels, trimMarker}
 * - CTS_Handoff.maxRecentPct(conv, budget, labels) -> number: largest pct (10-100) that fits the budget, 0 if none
 * - CTS_Handoff.budgetFor(ctxWindow, pct) -> number: tokens
 * - CTS_Handoff.contextPct(tokens, ctxWindow) -> number
 * - CTS_Handoff.collapse(text, capTokens) -> string: head+tail trimming of one message
 * - CTS_Handoff.makePayload(text, from, now) / isFresh(payload, now): one-time hand-off payload with 10-minute expiry
 * - CTS_Handoff.TRIM_MARKER, TTL_MS
 */

(function (root) {
  'use strict';

  const Conv = (typeof require === 'function' && typeof module !== 'undefined') ? require('./conversation.js') : root.CTS_Conversation;
  const est = t => Conv.estimateTokens(t);
  const TRIM_MARKER = '[... trimmed ...]';
  const TTL_MS = 10 * 60 * 1000;
  const CODE_KEEP_CHARS = 4000;
  const CAPS = { balancedAssistant: 1500, compactAssistant: 600, compactUser: 1000 };

  const DEFAULT_LABELS = {
    user: 'You', assistant: 'Claude',
    headerTitle: 'Carried context from a previous chat',
    headerLine: 'This is carried context from an earlier chat, not a new request. Continue the conversation from it.',
    previousChat: 'Previous chat', end: 'End of carried context',
  };

  const isFenceOpen = l => /^\s{0,3}(`{3,})/.exec(l);

  // ─── trimming helpers ─────────────────────────────────────────────────────
  function cutHead(s, n) { // keep at most n chars from the start, ending on whitespace
    if (s.length <= n) return s;
    if (/\s/.test(s[n])) return s.slice(0, n).trimEnd();
    const i = s.slice(0, n).search(/\s\S*$/);
    return i > 0 ? s.slice(0, i).trimEnd() : '';
  }
  function cutTail(s, n) { // keep at most n chars from the end, starting on a word start
    if (s.length <= n) return s;
    const start = s.length - n;
    if (/\s/.test(s[start - 1])) return s.slice(start).trimStart();
    const m = /\s/.exec(s.slice(start));
    return m ? s.slice(start + m.index).trimStart() : '';
  }

  function trimCode(code, maxChars, from) {
    const lines = code.split('\n');
    const open = isFenceOpen(lines[0]);
    const fence = open ? open[1] : '```';
    const openLine = open ? lines[0] : fence;
    let body = open ? lines.slice(1) : lines;
    if (body.length && new RegExp('^\\s{0,3}`{' + fence.length + ',}\\s*$').test(body[body.length - 1])) body = body.slice(0, -1);
    const picked = []; let used = 0;
    const seq = from === 'tail' ? body.slice().reverse() : body;
    for (const l of seq) { if (used + l.length + 1 > maxChars && picked.length) break; picked.push(l); used += l.length + 1; }
    if (from === 'tail') picked.reverse();
    const inner = from === 'tail' ? [TRIM_MARKER].concat(picked) : picked.concat([TRIM_MARKER]);
    return [openLine].concat(inner, [fence]).join('\n');
  }

  function collapse(text, capTokens) {
    text = String(text || '');
    if (est(text) <= capTokens) return text;
    const ratio = text.length / Math.max(1, est(text));
    const budget = Math.max(200, Math.floor(capTokens * ratio));
    const headB = Math.floor(budget * 0.6), tailB = budget - headB;
    const blocks = Conv.splitFences(text);

    const head = []; let used = 0, stop = blocks.length, headCut = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i], len = b.text.length;
      if (used + len <= headB || (b.type === 'code' && len <= CODE_KEEP_CHARS && used < headB)) { head.push(b.text); used += len; continue; }
      const room = headB - used;
      if (b.type === 'text') { const c = cutHead(b.text, Math.max(0, room)); if (c) head.push(c); headCut = c.length; }
      else if (room > 80) head.push(trimCode(b.text, Math.min(room, CODE_KEEP_CHARS), 'head'));
      stop = i; break;
    }
    if (stop === blocks.length) return text; // everything fit after all

    const tail = []; used = 0;
    // The block where the head stopped may be one long text: its remainder can still
    // contribute an ending (otherwise a single-block message would lose its last words).
    for (let i = blocks.length - 1; i >= stop; i--) {
      let b = blocks[i];
      if (i === stop) { if (b.type !== 'text') break; b = { type: 'text', text: b.text.slice(headCut).trimStart() }; if (!b.text) break; }
      const len = b.text.length;
      if (used + len <= tailB || (b.type === 'code' && len <= CODE_KEEP_CHARS && used < tailB)) { tail.unshift(b.text); used += len; continue; }
      const room = tailB - used;
      if (b.type === 'text') { const c = cutTail(b.text, Math.max(0, room)); if (c) tail.unshift(c); }
      else if (room > 80) tail.unshift(trimCode(b.text, Math.min(room, CODE_KEEP_CHARS), 'tail'));
      break;
    }
    return head.join('\n\n').trimEnd() + '\n\n' + TRIM_MARKER + (tail.length ? '\n\n' + tail.join('\n\n').trimStart() : '');
  }

  // ─── modes ────────────────────────────────────────────────────────────────
  function selectMessages(msgs, mode, pct, trimmed) {
    const usable = msgs.filter(m => (m.text || '').trim());
    if (mode === 'recent') {
      const k = Math.max(1, Math.ceil(usable.length * Math.max(10, Math.min(100, pct || 100)) / 100));
      return usable.slice(usable.length - k).map(m => ({ role: m.role, text: m.text.trim() }));
    }
    if (mode === 'balanced') {
      return usable.map(m => ({ role: m.role, text: m.role === 'assistant' ? collapse(m.text.trim(), CAPS.balancedAssistant) : m.text.trim() }));
    }
    // compact: every user message + the final assistant answer of each exchange
    const out = [];
    usable.forEach((m, i) => {
      if (m.role === 'user') out.push({ role: 'user', text: collapse(m.text.trim(), CAPS.compactUser) });
      else if (m.role === 'assistant') {
        const next = usable[i + 1];
        if (!next || next.role !== 'assistant') out.push({ role: 'assistant', text: collapse(m.text.trim(), CAPS.compactAssistant) });
      }
    });
    return out;
  }

  const fmtDate = s => { const t = Date.parse(s); return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''; };

  function frame(conv, selected, labels) {
    const l = Object.assign({}, DEFAULT_LABELS, labels || {});
    const date = fmtDate(conv.updatedAt) || fmtDate(conv.createdAt);
    const head = `[${l.headerTitle}]\n${l.previousChat}: "${conv.title}"${date ? ' (' + date + ')' : ''}\n${l.headerLine}\n\n---\n\n`;
    const body = selected.map(m => `### ${m.role === 'user' ? l.user : l.assistant}\n${m.text}`).join('\n\n');
    return head + body + `\n\n---\n[${l.end}]\n\n`;   // trailing blank line: the cursor lands on a fresh line for the user's next message
  }

  function plan(conv, opts) {
    opts = opts || {};
    const mode = opts.mode || 'balanced';
    const chatTokens = conv && conv.meta ? conv.meta.estTokens : 0;
    const base = { ok: false, text: '', tokens: 0, chatTokens, carried: 0, total: conv && conv.messages ? conv.messages.length : 0, budget: opts.budget || 0 };
    if (!conv || !Array.isArray(conv.messages)) return Object.assign(base, { error: 'empty' });
    const selected = selectMessages(conv.messages, mode, opts.pct, true);
    if (!selected.length) return Object.assign(base, { error: 'empty' });
    const text = frame(conv, selected, opts.labels);
    const tokens = est(text);
    const res = Object.assign(base, { text, tokens, carried: selected.length });
    if (opts.budget && tokens > opts.budget) return Object.assign(res, { ok: false, error: 'over-budget' });
    return Object.assign(res, { ok: true });
  }

  function maxRecentPct(conv, budget, labels) {
    for (let p = 100; p >= 10; p -= 5) { if (plan(conv, { mode: 'recent', pct: p, budget, labels }).ok) return p; }
    return 0;
  }

  const budgetFor = (ctxWindow, pct) => Math.floor((ctxWindow || 200000) * (pct || 30) / 100);
  const contextPct = (tokens, ctxWindow) => (ctxWindow ? Math.min(100, Math.round(tokens / ctxWindow * 100)) : 0);

  function makePayload(text, from, now) {
    return { v: 1, text: String(text), fromId: from && from.id || null, title: from && from.title || '', created: now, expires: now + TTL_MS };
  }
  const isFresh = (p, now) => !!(p && p.v === 1 && typeof p.text === 'string' && p.text && typeof p.expires === 'number' && now < p.expires && now >= p.created - 1000);

  const api = { plan, maxRecentPct, budgetFor, contextPct, collapse, makePayload, isFresh, TRIM_MARKER, TTL_MS, DEFAULT_LABELS };
  root.CTS_Handoff = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
