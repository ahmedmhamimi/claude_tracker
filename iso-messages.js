/**
 * Validation for messages crossing the MAIN <-> ISOLATED boundary (pure).
 * Page scripts can fire the same CustomEvents as TokenLens, so everything
 * arriving from MAIN is untrusted: parsed defensively, type allow-listed,
 * size-capped, numerically clamped, and reduced to known fields only.
 *
 * - CTS_Messages.parseUp(detail) -> {t, id, d}|null: validates a 'cts2:up' event detail (JSON string)
 * - CTS_Messages.parseDown(detail) -> {t, id, d}|null: validates a 'cts2:down' event detail (used in MAIN)
 * - CTS_Messages.MAX_CHARS -> number: size cap for one message
 * - CTS_Messages.makeId() -> string: random request id
 */

(function (root) {
  'use strict';

  const MAX_CHARS = 8 * 1024 * 1024;
  const UUID = /^[A-Za-z0-9-]{8,64}$/;
  const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);
  const strOrNull = (v, n) => (typeof v === 'string' ? v.slice(0, n || 500) : null);

  const UP = {
    usage: d => ({ t: num(d.t, 0, 4e12), u5h: num(d.u5h, 0, 100), u7d: num(d.u7d, 0, 100), r5h: num(d.r5h, 0, 4e9), r7d: num(d.r7d, 0, 4e9), limitHit: !!d.limitHit }),
    analysis: d => ({ t: num(d.t, 0, 4e12), convId: UUID.test(d.convId || '') ? d.convId : null, totalTokens: num(d.totalTokens, 0, 1e9),
      assistantCount: num(d.assistantCount, 0, 1e6), quotaDelta5h: num(d.quotaDelta5h, 0, 100), msgSeq: num(d.msgSeq, 0, 1e6),
      ctxWindow: num(d.ctxWindow, 0, 1e8), streaming: !!d.streaming }),
    convraw: d => (d.json && typeof d.json === 'object' && !Array.isArray(d.json) ? { id: UUID.test(d.id || '') ? d.id : null, json: d.json } : null),
    convlist: d => (Array.isArray(d.items) ? { items: d.items.slice(0, 5000).filter(x => x && UUID.test(x.uuid || ''))
      .map(x => ({ uuid: x.uuid, name: strOrNull(x.name, 300), created_at: strOrNull(x.created_at, 40), updated_at: strOrNull(x.updated_at, 40) })) } : null),
    'fetch-res': d => ({ status: num(d.status, 0, 999), json: d.json && typeof d.json === 'object' ? d.json : null, error: strOrNull(d.error, 80) }),
  };

  const DOWN = {
    'fetch-conv': d => (UUID.test(d.convId || '') ? { convId: d.convId } : null),
    'fetch-list': () => ({}),
    'fetch-usage': () => ({}),
    settings: d => (d.settings && typeof d.settings === 'object' && JSON.stringify(d.settings).length < 20000 ? { settings: d.settings } : null),
  };

  function parse(detail, table) {
    if (typeof detail !== 'string' || detail.length > MAX_CHARS) return null;
    let m; try { m = JSON.parse(detail); } catch (_) { return null; }
    if (!m || m.v !== 1 || typeof m.t !== 'string' || !Object.prototype.hasOwnProperty.call(table, m.t)) return null;
    if (!m.d || typeof m.d !== 'object') return null;
    const d = table[m.t](m.d);
    if (!d) return null;
    return { t: m.t, id: typeof m.id === 'string' && m.id.length <= 64 ? m.id : null, d };
  }

  function makeId() {
    const a = new Uint8Array(12);
    (root.crypto || require('crypto').webcrypto).getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  const api = { parseUp: d => parse(d, UP), parseDown: d => parse(d, DOWN), MAX_CHARS, makeId };
  root.CTS_Messages = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
