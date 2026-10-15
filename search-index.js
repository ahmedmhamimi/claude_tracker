/**
 * Full-text search index (pure; runs in the service worker, tested in Node).
 * Case-insensitive and diacritic-folding via a LENGTH-PRESERVING fold, so
 * match offsets map straight back onto the original text. CJK runs are
 * indexed as bigrams. Terms are ANDed; "quoted phrases" are verified against
 * the stored text. Ranking: title match first, then BM25, then recency.
 *
 * - CTS_Search.fold(str) -> string: lowercase + strip diacritics, same length as input
 * - CTS_Search.tokenize(str) -> [{term, start, end}]
 * - CTS_Search.parseQuery(q) -> {terms:string[], phrases:string[]}
 * - CTS_Search.SearchIndex: class (persisted record = {id, len, tf:{term: packed int}}, so rebuilds are cheap)
 *     addDoc(id, {title, messages:[{role,text}], updatedAt, folderId}) -> record  (record is what the SW persists)
 *     loadRecord(record, meta) -> void: rebuilds a doc from a persisted record
 *     exportSnapshot() -> object / importSnapshot(obj) -> void: compact typed-array persistence (drops dead docs)
 *     revOf(id) -> number|null: revision stamp of an indexed doc
 *     removeDoc(id) / setMeta(id, {folderId, updatedAt, title}) / has(id) / size() / deadRatio()
 *     search(q, {only:Set|null, folderIds:Set|null, role:'user'|'assistant'|null, from, to, limit}, getMessages) -> [{id, score, titleMatch, snippet}] (array.truncated=true if the phrase-verification time budget ran out)
 *       getMessages(id) -> [{role,text}]|null supplies stored text for phrases and snippets
 */

(function (root) {
  'use strict';

  const K1 = 1.2, B = 0.75;
  const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
  const WORD = /[\p{L}\p{N}]+/gu;

  // Per UTF-16 unit: strip the combining marks off the NFD base, lowercase if
  // that keeps the length (so 'İ' stays as is), never change string length.
  const foldCache = new Map();
  function foldChar(ch) {
    let r = foldCache.get(ch);
    if (r !== undefined) return r;
    const base = ch.normalize('NFD')[0] || ch;
    const l = base.toLowerCase();
    r = l.length === 1 ? l : base;
    if (foldCache.size < 20000) foldCache.set(ch, r);
    return r;
  }
  function fold(s) {
    s = String(s == null ? '' : s);
    let ascii = true;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) { ascii = false; break; }
    if (ascii) return s.toLowerCase();
    let out = '';
    for (let i = 0; i < s.length; i++) out += foldChar(s[i]);
    return out;
  }

  function tokenizeFolded(f) {
    const out = [];
    WORD.lastIndex = 0;
    let m;
    while ((m = WORD.exec(f))) {
      const w = m[0], start = m.index;
      if (CJK.test(w)) {
        const chars = Array.from(w); let off = start;
        if (chars.length === 1) { out.push({ term: w, start, end: start + w.length }); continue; }
        for (let i = 0; i < chars.length - 1; i++) {
          const len = chars[i].length + chars[i + 1].length;
          out.push({ term: chars[i] + chars[i + 1], start: off, end: off + len });
          off += chars[i].length;
        }
      } else if (w.length >= 2) out.push({ term: w.length > 40 ? w.slice(0, 40) : w, start, end: start + w.length });
    }
    return out;
  }
  const tokenize = s => tokenizeFolded(fold(s));

  function parseQuery(q) {
    q = String(q || '');
    const phrases = [];
    const rest = q.replace(/"([^"]+)"/g, (_, p) => { if (p.trim()) phrases.push(p.trim()); return ' '; });
    const seen = new Set(), terms = [];
    tokenize(rest).forEach(t => { if (!seen.has(t.term)) { seen.add(t.term); terms.push(t.term); } });
    return { terms, phrases };
  }

  const pack = (t, u, a) => (Math.min(t, 1023) << 20) | (Math.min(u, 1023) << 10) | Math.min(a, 1023);
  const unpackT = p => (p >> 20) & 1023, unpackU = p => (p >> 10) & 1023, unpackA = p => p & 1023;

  class SearchIndex {
    constructor() {
      this.postings = new Map(); // term -> flat [docIdx, packed, ...] (docs added since the last snapshot load)
      this.frozen = new Map();   // term -> Int32Array view of the same layout (docs loaded from a snapshot)
      this.docs = [];            // docIdx -> {id, len, folderId, updatedAt, title(folded), alive}
      this.byId = new Map();     // id -> docIdx
      this.alive = 0; this.totalLen = 0;
    }
    size() { return this.alive; }
    has(id) { return this.byId.has(id); }
    deadRatio() { return this.docs.length ? 1 - this.alive / this.docs.length : 0; }

    _insert(rec, meta) {
      const idx = this.docs.length;
      this.docs.push({ id: rec.id, len: rec.len, folderId: meta.folderId || null, updatedAt: meta.updatedAt || 0, title: fold(meta.title || ''), rev: meta.rev || 0, alive: true });
      this.byId.set(rec.id, idx); this.alive++; this.totalLen += rec.len;
      for (const term in rec.tf) {
        let p = this.postings.get(term);
        if (!p) { p = []; this.postings.set(term, p); }
        p.push(idx, rec.tf[term]); // tf values are already packed ints (title<<20 | user<<10 | assistant)
      }
    }

    addDoc(id, doc) {
      const tf = Object.create(null); let len = 0;
      const bump = (term, slot) => { (tf[term] || (tf[term] = [0, 0, 0]))[slot]++; };
      (doc.messages || []).forEach(m => {
        const slot = m.role === 'assistant' ? 1 : 0;
        const toks = tokenize(m.text); len += toks.length;
        for (let i = 0; i < toks.length; i++) bump(toks[i].term, slot);
      });
      tokenize(doc.title).forEach(t => bump(t.term, 2));
      const packed = Object.create(null);
      for (const term in tf) packed[term] = pack(tf[term][2], tf[term][0], tf[term][1]);
      const rec = { id, len, tf: packed };
      this.removeDoc(id);
      this._insert(rec, doc);
      return rec;
    }

    loadRecord(rec, meta) { this.removeDoc(rec.id); this._insert(rec, meta || {}); }

    removeDoc(id) {
      const idx = this.byId.get(id);
      if (idx === undefined) return;
      const d = this.docs[idx]; d.alive = false; this.alive--; this.totalLen -= d.len;
      this.byId.delete(id);
    }

    setMeta(id, m) {
      const d = this.docs[this.byId.get(id)];
      if (!d) return;
      if ('folderId' in m) d.folderId = m.folderId || null;
      if ('updatedAt' in m) d.updatedAt = m.updatedAt || 0;
      if ('title' in m) d.title = fold(m.title || '');
    }

    _termPostings(term, prefix) {
      const out = [];
      if (!prefix) {
        const a = this.frozen.get(term), b = this.postings.get(term);
        if (a) out.push(a); if (b) out.push(b);
        return out;
      }
      for (const [k, p] of this.frozen) if (k.startsWith(term)) out.push(p);
      for (const [k, p] of this.postings) if (k.startsWith(term)) out.push(p);
      return out;
    }

    // Compact binary snapshot (dead docs dropped, doc indexes remapped). One
    // structured-clone-able object, so a service worker restart loads a single
    // blob instead of re-inserting millions of postings.
    exportSnapshot() {
      const remap = new Int32Array(this.docs.length).fill(-1); const docs = [];
      this.docs.forEach((d, i) => { if (d.alive) { remap[i] = docs.length; docs.push({ id: d.id, len: d.len, folderId: d.folderId, updatedAt: d.updatedAt, title: d.title, rev: d.rev }); } });
      const keys = new Set([...this.frozen.keys(), ...this.postings.keys()]);
      const terms = [], offsets = [0]; let total = 0; const chunks = [];
      for (const k of keys) {
        const lists = [this.frozen.get(k), this.postings.get(k)].filter(Boolean);
        const flat = [];
        for (const p of lists) for (let i = 0; i < p.length; i += 2) { const r = remap[p[i]]; if (r >= 0) flat.push(r, p[i + 1]); }
        if (!flat.length) continue;
        terms.push(k); chunks.push(flat); total += flat.length; offsets.push(total);
      }
      const data = new Int32Array(total); let o = 0;
      chunks.forEach(c => { data.set(c, o); o += c.length; });
      return { v: 1, docs, terms, offsets: Int32Array.from(offsets), data };
    }

    importSnapshot(snap) {
      if (!snap || snap.v !== 1 || !snap.data || !snap.offsets) throw new Error('bad-snapshot');
      this.postings = new Map(); this.frozen = new Map(); this.docs = []; this.byId = new Map(); this.alive = 0; this.totalLen = 0;
      snap.docs.forEach((d, i) => { this.docs.push(Object.assign({ alive: true }, d)); this.byId.set(d.id, i); this.alive++; this.totalLen += d.len; });
      snap.terms.forEach((t, i) => this.frozen.set(t, snap.data.subarray(snap.offsets[i], snap.offsets[i + 1])));
    }

    revOf(id) { const i = this.byId.get(id); return i === undefined ? null : this.docs[i].rev; }

    search(query, opts, getMessages) {
      opts = opts || {};
      const q = typeof query === 'string' ? parseQuery(query) : query;
      const phraseTerms = [];
      q.phrases.forEach(p => tokenize(p).forEach(t => phraseTerms.push(t.term)));
      const termList = q.terms.concat(phraseTerms.filter(t => !q.terms.includes(t)));
      if (!termList.length && !q.phrases.length) return [];
      if (!termList.length) return []; // phrase made only of ignorable tokens

      const N = this.alive || 1, avg = this.totalLen / N || 1;
      const role = opts.role === 'user' ? 'u' : opts.role === 'assistant' ? 'a' : null;
      // Only the LAST free-text term is treated as a prefix (type-ahead); phrase terms stay exact.
      const lastFree = q.terms.length ? q.terms[q.terms.length - 1] : null;

      // per term: Map docIdx -> {tf, inTitle}
      const per = termList.map(term => {
        const m = new Map();
        const lists = this._termPostings(term, term === lastFree && term.length >= 3);
        for (const p of lists) for (let i = 0; i < p.length; i += 2) {
          const di = p[i], d = this.docs[di];
          if (!d.alive) continue;
          const pk = p[i + 1], u = unpackU(pk), a = unpackA(pk), t = unpackT(pk);
          const tf = role === 'u' ? u : role === 'a' ? a : u + a;
          if (!tf && !(t && !role)) continue;
          const cur = m.get(di);
          if (cur) { cur.tf += tf; cur.t = cur.t || t > 0; } else m.set(di, { tf, t: t > 0 });
        }
        return m;
      });

      // AND: drive from the rarest term
      let order = per.map((m, i) => i).sort((x, y) => per[x].size - per[y].size);
      const driver = per[order[0]];
      const df = per.map(m => m.size);
      const hits = [];
      for (const [di] of driver) {
        const d = this.docs[di];
        if (opts.only && !opts.only.has(d.id)) continue;
        if (opts.folderIds && !(d.folderId && opts.folderIds.has(d.folderId))) continue;
        if (opts.from && d.updatedAt < opts.from) continue;
        if (opts.to && d.updatedAt > opts.to) continue;
        let score = 0, titleAll = true, ok = true;
        for (let k = 0; k < per.length; k++) {
          const e = per[k].get(di);
          if (!e) { ok = false; break; }
          const idf = Math.log(1 + (N - df[k] + 0.5) / (df[k] + 0.5));
          score += idf * (e.tf * (K1 + 1)) / (e.tf + K1 * (1 - B + B * d.len / avg));
          if (e.t) score += idf * 1.5; else titleAll = false;
        }
        if (ok) hits.push({ di, id: d.id, score, titleMatch: titleAll, updatedAt: d.updatedAt });
      }

      hits.sort((x, y) => (y.titleMatch - x.titleMatch) || (y.score - x.score) || (y.updatedAt - x.updatedAt));

      const limit = opts.limit || 50;
      const out = [];
      // Phrase verification scans stored text, which is the only slow step; it
      // gets a time budget and the result says when it ran out ('truncated').
      const deadline = Date.now() + (opts.budgetMs || 150);
      const phraseRes = q.phrases.map(p => {
        const esc = fold(p).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[^\\p{L}\\p{N}]+');
        return new RegExp(esc, 'u');
      });
      for (const h of hits) {
        if (out.length >= limit) break;
        let msgs = null, snip = null;
        if (phraseRes.length || getMessages) { msgs = getMessages ? getMessages(h.id) : null; }
        if (phraseRes.length) {
          if (Date.now() > deadline) { out.truncated = true; break; }
          if (!msgs) continue; // cannot verify a phrase without text
          const usable = msgs.filter(m => !opts.role || m.role === opts.role);
          const foldedMsgs = usable.map(m => fold(m.text));
          const allIn = phraseRes.every(re => foldedMsgs.some(f => re.test(f)));
          const titleIn = phraseRes.every(re => re.test(this.docs[h.di].title));
          if (!allIn && !titleIn) continue;
        }
        if (msgs) snip = makeSnippet(msgs, opts.role, termList, phraseRes);
        out.push({ id: h.id, score: h.score, titleMatch: h.titleMatch, snippet: snip });
      }
      return out;
    }
  }

  // First message that contains a phrase / query term, ~160 chars around it.
  function makeSnippet(msgs, role, terms, phraseRes) {
    const tset = new Set(terms);
    const lastT = terms[terms.length - 1];
    const isHit = w => tset.has(w) || (lastT && lastT.length >= 3 && w.startsWith(lastT));
    for (const m of msgs) {
      if (role && m.role !== role) continue;
      const f = fold(m.text);
      let at = -1;
      for (const re of phraseRes) { const r = re.exec(f); if (r) { at = r.index; break; } }
      const toks = tokenizeFolded(f);
      if (at < 0) { const t = toks.find(x => isHit(x.term)); if (t) at = t.start; }
      if (at < 0) continue;
      let s = Math.max(0, at - 60), e = Math.min(m.text.length, at + 100);
      // never start/end mid-word
      for (let n = 0; n < 15 && s > 0 && /\S/.test(m.text[s - 1]) && /\S/.test(m.text[s]); n++) s--;
      for (let n = 0; n < 15 && e < m.text.length && /\S/.test(m.text[e - 1]) && /\S/.test(m.text[e]); n++) e++;
      const text = m.text.slice(s, e);
      const ranges = [];
      toks.forEach(t => { if (t.start >= s && t.end <= e && isHit(t.term)) ranges.push({ s: t.start - s, e: t.end - s }); });
      phraseRes.forEach(re => { const g = new RegExp(re.source, 'gu'); let r; const ff = f.slice(s, e); while ((r = g.exec(ff))) { ranges.push({ s: r.index, e: r.index + r[0].length }); if (!r[0]) g.lastIndex++; } });
      return { text, ranges: mergeRanges(ranges), role: m.role, ellipsisStart: s > 0, ellipsisEnd: e < m.text.length };
    }
    return null;
  }
  function mergeRanges(r) {
    r.sort((a, b) => a.s - b.s || a.e - b.e);
    const out = [];
    r.forEach(x => { const l = out[out.length - 1]; if (l && x.s <= l.e) l.e = Math.max(l.e, x.e); else out.push({ s: x.s, e: x.e }); });
    return out;
  }

  const api = { fold, tokenize, parseQuery, SearchIndex };
  root.CTS_Search = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
