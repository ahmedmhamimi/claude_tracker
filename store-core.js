/**
 * TokenLens storage core (service worker side; pure over an adapter so Node
 * can test it). Owns the schema, migrations, usage snapshots, the search index
 * lifecycle, folders, bookmarks, export jobs and the data-management actions.
 * The real adapter (IndexedDB) is store-idb.js; MemoryAdapter is for tests.
 *
 * - CTS_StoreCore.STORES / SCHEMA_VERSION / MIGRATIONS
 * - CTS_StoreCore.MemoryAdapter: in-memory adapter with the same async API as the IndexedDB one
 * - CTS_StoreCore.migrate(adapter, migrations?) -> Promise<number>: runs pending migrations, returns the schema version
 * - CTS_StoreCore.createStore(adapter, deps) -> store: deps {History, Search, Folders, now, newId}
 *     store.init() / addSnapshot / listSnapshots / addCost / listCosts / upsertConversation (op 'conv.ingest' takes raw JSON) / upsertMeta / search /
 *     coverage / markMissing / cleanup / listConversations / folders* / setFolder / setParent / bookmarks* / job* /
 *     usageInfo / exportAll / deleteAll / flushIndex / handle(op, data)
 *
 * Adapter API (all async): get(store,key) put(store,value) delete(store,key) getAll(store) clear(store) count(store)
 * Everything runs through one promise chain so interleaved messages never race.
 */

(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORES = {
    snapshots: { keyPath: 't' }, msgcosts: { keyPath: 'id', autoIncrement: true }, convs: { keyPath: 'id' },
    texts: { keyPath: 'id' }, terms: { keyPath: 'id' }, folders: { keyPath: 'id' }, bookmarks: { keyPath: 'id' },
    exportjobs: { keyPath: 'id' }, meta: { keyPath: 'key' },
  };
  const DAY = 864e5;
  const MAX_TEXT_CHARS = 2 * 1024 * 1024;

  // Each migration upgrades schema N -> N+1. v1 only creates the stores (done by the adapter on open).
  const MIGRATIONS = [async function v1(/* adapter */) { /* stores created at open */ }];

  class MemoryAdapter {
    constructor() { this.d = {}; this.auto = 0; Object.keys(STORES).forEach(s => { this.d[s] = new Map(); }); }
    async get(s, k) { const v = this.d[s].get(k); return v === undefined ? undefined : structuredClone(v); }
    async put(s, v) {
      const kp = STORES[s].keyPath; v = structuredClone(v);
      if (v[kp] === undefined && STORES[s].autoIncrement) v[kp] = ++this.auto;
      this.d[s].set(v[kp], v); return v[kp];
    }
    async delete(s, k) { this.d[s].delete(k); }
    async getAll(s) { return Array.from(this.d[s].values(), v => structuredClone(v)); }
    async clear(s) { this.d[s].clear(); }
    async count(s) { return this.d[s].size; }
  }

  async function migrate(adapter, migrations) {
    migrations = migrations || MIGRATIONS;
    const rec = await adapter.get('meta', 'schemaVersion');
    let v = rec ? rec.value : 0;
    for (; v < migrations.length; v++) { await migrations[v](adapter); await adapter.put('meta', { key: 'schemaVersion', value: v + 1 }); }
    return v;
  }

  function createStore(adapter, deps) {
    const { History, Search, Folders, Conv } = deps;
    const now = deps.now || (() => Date.now());
    const newId = deps.newId || (() => Math.random().toString(36).slice(2) + now().toString(36));
    let index = new Search.SearchIndex();
    let chain = Promise.resolve();
    let dirty = false;
    const serial = fn => { const p = chain.then(fn, fn); chain = p.then(() => {}, () => {}); return p; };

    const metaGet = async k => { const r = await adapter.get('meta', k); return r ? r.value : undefined; };
    const metaSet = (k, value) => adapter.put('meta', { key: k, value });
    const ms = s => { const t = Date.parse(s); return isFinite(t) ? t : 0; };

    // ─── init: schema, index restore ──────────────────────────────────────
    async function loadIndex() {
      index = new Search.SearchIndex();
      const snap = await metaGet('indexSnapshot');
      if (snap) { try { index.importSnapshot(snap); } catch (_) { index = new Search.SearchIndex(); } }
      const convs = await adapter.getAll('convs');
      const known = new Set();
      for (const c of convs) {
        if (c.status === 'missing') { index.removeDoc(c.id); continue; }
        known.add(c.id);
        if (c.status === 'ok' && index.revOf(c.id) !== c.rev) {
          const rec = await adapter.get('terms', c.id);   // only docs newer than the snapshot are read
          if (rec) index.loadRecord(rec, { title: c.title, updatedAt: c.updatedMs, folderId: c.folderId, rev: c.rev });
        } else if (c.status === 'meta' && !index.has(c.id)) {
          index.addDoc(c.id, { title: c.title, messages: [], updatedAt: c.updatedMs, folderId: c.folderId });
        } else if (index.has(c.id)) index.setMeta(c.id, { title: c.title, updatedAt: c.updatedMs, folderId: c.folderId });
      }
      for (const d of index.docs) if (d.alive && !known.has(d.id)) index.removeDoc(d.id);
    }

    async function init() { await migrate(adapter); await loadIndex(); }

    async function flushIndex(force) {
      if (!dirty && !force) return false;
      await metaSet('indexSnapshot', index.exportSnapshot()); dirty = false; return true;
    }

    // ─── usage history ────────────────────────────────────────────────────
    async function maintenance(t) {
      const snaps = await adapter.getAll('snapshots');
      const { dropTs } = History.compact(snaps, t);
      for (const k of dropTs) await adapter.delete('snapshots', k);
      for (const c of await adapter.getAll('msgcosts')) if (t - c.t > 90 * DAY) await adapter.delete('msgcosts', c.id);
      if (index.deadRatio() > 0.25) { await flushIndex(true); await loadIndex(); }
      await metaSet('lastMaintenance', t);
      return dropTs.length;
    }

    async function addSnapshot(raw) {
      const s = History.cleanSnap(raw); if (!s) return { written: false, reason: 'invalid' };
      const last = await metaGet('lastSnap');
      if (!History.shouldRecord(last, s, s.t)) return { written: false, reason: 'unchanged' };
      await adapter.put('snapshots', s); await metaSet('lastSnap', s);
      const lm = await metaGet('lastMaintenance');
      if (!lm || s.t - lm > DAY) await maintenance(s.t);
      return { written: true };
    }
    const listSnapshots = async () => (await adapter.getAll('snapshots')).sort((a, b) => a.t - b.t);

    async function addCost(r) {
      if (!r || typeof r.t !== 'number' || typeof r.convTokensEst !== 'number' || typeof r.quotaDelta5h !== 'number') return { written: false };
      await adapter.put('msgcosts', { t: Math.round(r.t), convId: String(r.convId || '').slice(0, 64), convTokensEst: Math.round(r.convTokensEst), quotaDelta5h: Math.round(r.quotaDelta5h) });
      return { written: true };
    }
    const listCosts = async () => (await adapter.getAll('msgcosts')).sort((a, b) => a.t - b.t);

    // ─── conversations / index ────────────────────────────────────────────
    async function upsertConversation(c) {
      if (!c || typeof c.id !== 'string' || !Array.isArray(c.messages)) return { ok: false };
      const prev = await adapter.get('convs', c.id);
      let budget = MAX_TEXT_CHARS;
      const msgs = [];
      for (const m of c.messages) {
        const t = String(m.text || ''); if (!t.trim()) continue;
        const cut = t.slice(0, Math.max(0, budget)); budget -= cut.length;
        msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text: cut });
        if (budget <= 0) break;
      }
      const rev = ((prev && prev.rev) || 0) + 1;
      const meta = Object.assign({ folderId: null, parentId: null }, prev || {}, {
        id: c.id, title: String(c.title || (prev && prev.title) || '').slice(0, 300), createdAt: c.createdAt || null, updatedAt: c.updatedAt || null,
        updatedMs: ms(c.updatedAt) || now(), indexedAt: now(), status: 'ok', stale: false, rev,
        msgCount: msgs.length, estTokens: (c.meta && c.meta.estTokens) || 0, textLen: msgs.reduce((n, m) => n + m.text.length, 0),
      });
      const rec = index.addDoc(c.id, { title: meta.title, messages: msgs, updatedAt: meta.updatedMs, folderId: meta.folderId });
      index.setMeta(c.id, { updatedAt: meta.updatedMs });
      index.docs[index.byId.get(c.id)].rev = rev;
      await adapter.put('texts', { id: c.id, messages: msgs });
      await adapter.put('terms', Object.assign({ rev }, rec));
      await adapter.put('convs', meta);
      dirty = true;
      return { ok: true, rev };
    }

    async function upsertMeta(items) {
      let added = 0, updated = 0;
      for (const it of (items || [])) {
        if (!it || typeof it.uuid !== 'string') continue;
        const prev = await adapter.get('convs', it.uuid);
        const um = ms(it.updated_at);
        if (!prev) {
          await adapter.put('convs', { id: it.uuid, title: String(it.name || '').slice(0, 300), createdAt: it.created_at || null, updatedAt: it.updated_at || null, updatedMs: um, indexedAt: null,
            status: 'meta', stale: false, rev: 0, msgCount: 0, estTokens: 0, textLen: 0, folderId: null, parentId: null });
          index.addDoc(it.uuid, { title: it.name || '', messages: [], updatedAt: um }); dirty = true; added++;
        } else {
          const next = Object.assign({}, prev);
          if (it.name && it.name !== prev.title) next.title = String(it.name).slice(0, 300);
          if (um && um > (prev.updatedMs || 0)) { next.updatedMs = um; next.updatedAt = it.updated_at; if (prev.status === 'ok') next.stale = true; }
          if (prev.status === 'missing') next.status = prev.rev ? 'ok' : 'meta';
          if (JSON.stringify(next) !== JSON.stringify(prev)) {
            await adapter.put('convs', next); updated++;
            if (index.has(it.uuid)) index.setMeta(it.uuid, { title: next.title, updatedAt: next.updatedMs }); dirty = true;
          }
        }
      }
      return { added, updated };
    }

    const listConversations = async () => (await adapter.getAll('convs')).sort((a, b) => (b.updatedMs || 0) - (a.updatedMs || 0));

    async function coverage() {
      const all = await adapter.getAll('convs');
      const live = all.filter(c => c.status !== 'missing');
      return { indexed: live.filter(c => c.status === 'ok' && !c.stale).length, stale: live.filter(c => c.stale).length, total: live.length, missing: all.length - live.length };
    }

    async function markMissing(id) {
      const c = await adapter.get('convs', id); if (!c) return { ok: false };
      c.status = 'missing'; await adapter.put('convs', c); index.removeDoc(id); dirty = true; return { ok: true };
    }

    async function cleanup() {
      let n = 0;
      for (const c of await adapter.getAll('convs')) if (c.status === 'missing') {
        await adapter.delete('convs', c.id); await adapter.delete('texts', c.id); await adapter.delete('terms', c.id);
        for (const b of await adapter.getAll('bookmarks')) if (b.convId === c.id) await adapter.delete('bookmarks', b.id);
        index.removeDoc(c.id); n++;
      }
      dirty = dirty || n > 0; return { removed: n };
    }

    // ─── search (two-phase so texts can be read asynchronously) ───────────
    async function search(q, f) {
      f = f || {};
      const parsed = Search.parseQuery(q);
      if (!parsed.terms.length && !parsed.phrases.length) return { results: [], truncated: false };
      const folders = await adapter.getAll('folders');
      const base = { role: f.role || null, from: f.from || 0, to: f.to || 0, folderIds: f.folderId ? Folders.descendants(folders, f.folderId) : null };
      const phraseTerms = []; parsed.phrases.forEach(p => Search.tokenize(p).forEach(t => phraseTerms.push(t.term)));
      const stage1Q = { terms: parsed.terms.concat(phraseTerms.filter(t => !parsed.terms.includes(t))), phrases: [] };
      const cand = index.search(stage1Q, Object.assign({}, base, { limit: parsed.phrases.length ? 300 : 60 }), null);
      const cache = new Map();
      for (const r of cand) { const t = await adapter.get('texts', r.id); if (t) cache.set(r.id, t.messages); }
      const final = index.search(parsed, Object.assign({}, base, { limit: f.limit || 50, only: new Set(cand.map(r => r.id)) }), id => cache.get(id) || null);
      const convs = new Map((await adapter.getAll('convs')).map(c => [c.id, c]));
      const results = final.map(r => {
        const c = convs.get(r.id) || {};
        return { id: r.id, title: c.title || '', updatedAt: c.updatedAt || null, status: c.status || 'meta', folderId: c.folderId || null,
          folderPath: c.folderId ? Folders.path(folders, c.folderId).join(' / ') : '', score: r.score, titleMatch: r.titleMatch, snippet: r.snippet };
      });
      return { results, truncated: !!final.truncated };
    }
    const getTexts = async id => { const t = await adapter.get('texts', id); return t ? t.messages : null; };

    // ─── folders ──────────────────────────────────────────────────────────
    const loadFolders = () => adapter.getAll('folders');
    async function saveFolders(next, prev) {
      const ids = new Set(next.map(f => f.id));
      for (const f of prev) if (!ids.has(f.id)) await adapter.delete('folders', f.id);
      for (const f of next) await adapter.put('folders', f);
    }
    async function folderOp(kind, d) {
      const list = await loadFolders();
      let r;
      if (kind === 'create') r = Folders.create(list, { id: newId(), name: d.name, parentId: d.parentId });
      else if (kind === 'rename') r = Folders.rename(list, d.id, d.name);
      else if (kind === 'move') r = Folders.move(list, d.id, d.parentId);
      else if (kind === 'remove') {
        const convs = await adapter.getAll('convs'); const cf = {};
        convs.forEach(c => { if (c.folderId) cf[c.id] = c.folderId; });
        const out = Folders.remove(list, d.id, cf);
        for (const c of convs) { const nf = out.chatFolders[c.id] || null; if ((c.folderId || null) !== nf) { c.folderId = nf; await adapter.put('convs', c); if (index.has(c.id)) index.setMeta(c.id, { folderId: nf }); } }
        dirty = true; r = { list: out.list };
      }
      if (r.error) return { ok: false, error: r.error };
      await saveFolders(r.list, list);
      return { ok: true, folders: r.list };
    }

    async function setFolder(ids, folderId) {
      if (folderId) { const f = (await loadFolders()).find(x => x.id === folderId); if (!f) return { ok: false, error: 'no-folder' }; }
      let n = 0;
      for (const id of (ids || []).slice(0, 5000)) {
        let c = await adapter.get('convs', id);
        if (!c) c = { id, title: '', createdAt: null, updatedAt: null, updatedMs: 0, indexedAt: null, status: 'meta', stale: false, rev: 0, msgCount: 0, estTokens: 0, textLen: 0, parentId: null };
        c.folderId = folderId || null; await adapter.put('convs', c);
        if (index.has(id)) index.setMeta(id, { folderId: c.folderId }); n++;
      }
      dirty = true; return { ok: true, moved: n };
    }

    async function setParent(id, parentId) {
      const c = await adapter.get('convs', id);
      const next = c || { id, title: '', createdAt: null, updatedAt: null, updatedMs: 0, indexedAt: null, status: 'meta', stale: false, rev: 0, msgCount: 0, estTokens: 0, textLen: 0, folderId: null };
      if (next.parentId) return { ok: true, kept: true };
      next.parentId = parentId; await adapter.put('convs', next); return { ok: true };
    }

    // ─── bookmarks ────────────────────────────────────────────────────────
    async function bookmarkAdd(b) {
      if (!b || !b.convId) return { ok: false };
      const rec = { id: newId(), convId: String(b.convId), msgId: b.msgId ? String(b.msgId) : null, note: String(b.note || '').slice(0, 500), excerpt: String(b.excerpt || '').slice(0, 600), t: now() };
      await adapter.put('bookmarks', rec); return { ok: true, bookmark: rec };
    }

    // ─── export jobs (resume after cancel) ────────────────────────────────
    const jobSave = async j => { await adapter.put('exportjobs', Object.assign({}, j, { id: 'job:' + j.jobId, kind: 'job' })); return { ok: true }; };
    const jobGet = async jobId => (await adapter.get('exportjobs', 'job:' + jobId)) || null;
    const jobPutEntry = async d => {
      await adapter.put('exportjobs', { id: 'entry:' + d.jobId + ':' + d.convId, kind: 'entry', jobId: d.jobId, convId: d.convId, files: d.files || [],
        title: String(d.title || '').slice(0, 300), createdAt: d.createdAt || null, updatedAt: d.updatedAt || null });
      return { ok: true };
    };
    const jobEntries = async jobId => (await adapter.getAll('exportjobs')).filter(r => r.kind === 'entry' && r.jobId === jobId);
    async function jobDelete(jobId) { for (const r of await adapter.getAll('exportjobs')) if (r.jobId === jobId || r.id === 'job:' + jobId) await adapter.delete('exportjobs', r.id); return { ok: true }; }
    const jobLatest = async () => (await adapter.getAll('exportjobs')).filter(r => r.kind === 'job').sort((a, b) => b.created - a.created)[0] || null;

    // ─── data management ──────────────────────────────────────────────────
    async function usageInfo() {
      const counts = {}; for (const s of Object.keys(STORES)) counts[s] = await adapter.count(s);
      const convs = await adapter.getAll('convs');
      const textBytes = convs.reduce((n, c) => n + (c.textLen || 0) * 2, 0);
      return { counts, approxBytes: textBytes, indexedDocs: index.size() };
    }
    async function exportAll() {
      const snaps = await listSnapshots();
      return { schema: 'tokenlens.data/1', exportedAt: new Date(now()).toISOString(),
        note: 'Snapshots, per-message cost records, conversation list metadata (titles, dates), folders, bookmarks. The search index and message texts are derived data and not included.',
        snapshots: snaps, msgcosts: await listCosts(), conversations: convs2export(await adapter.getAll('convs')), folders: await loadFolders(), bookmarks: await adapter.getAll('bookmarks') };
    }
    const convs2export = list => list.map(c => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, status: c.status, folderId: c.folderId, parentId: c.parentId, estTokens: c.estTokens, msgCount: c.msgCount }));
    async function deleteAll() {
      for (const s of Object.keys(STORES)) await adapter.clear(s);
      index = new Search.SearchIndex(); dirty = false;
      await metaSet('schemaVersion', SCHEMA_VERSION);
      return { ok: true };
    }

    const OPS = {
      'snap.add': d => addSnapshot(d), 'snap.list': () => listSnapshots(), 'cost.add': d => addCost(d), 'cost.list': () => listCosts(),
      'conv.upsert': d => upsertConversation(d),
      // Raw JSON in, normalized here: keeps big-chat parsing off the claude.ai page thread.
      'conv.ingest': async d => {
        if (!Conv || !d || typeof d.id !== 'string' || !d.json || typeof d.json !== 'object') return { ok: false };
        const n = Conv.normalize(d.json, { id: d.id, titleHint: typeof d.titleHint === 'string' ? d.titleHint : undefined });
        if (!n.id) return { ok: false };
        return upsertConversation({ id: n.id, title: n.title, createdAt: n.createdAt, updatedAt: n.updatedAt, meta: { estTokens: n.meta.estTokens },
          messages: n.messages.filter(m => m.role !== 'unknown').map(m => ({ role: m.role, text: m.text })) });
      }, 'conv.meta': d => upsertMeta(d && d.items), 'conv.list': () => listConversations(),
      'conv.texts': d => getTexts(d && d.id), 'conv.missing': d => markMissing(d && d.id), 'conv.cleanup': () => cleanup(),
      'conv.setFolder': d => setFolder(d && d.ids, d && d.folderId), 'conv.setParent': d => setParent(d && d.id, d && d.parentId),
      'index.coverage': () => coverage(), 'search': d => search(d && d.q, d && d.filters),
      'folder.list': () => loadFolders(), 'folder.create': d => folderOp('create', d || {}), 'folder.rename': d => folderOp('rename', d || {}),
      'folder.move': d => folderOp('move', d || {}), 'folder.remove': d => folderOp('remove', d || {}),
      'bookmark.add': d => bookmarkAdd(d), 'bookmark.list': async () => adapter.getAll('bookmarks'), 'bookmark.remove': async d => { await adapter.delete('bookmarks', d && d.id); return { ok: true }; },
      'job.save': d => jobSave(d), 'job.get': d => jobGet(d && d.jobId), 'job.putEntry': d => jobPutEntry(d || {}), 'job.entries': d => jobEntries(d.jobId),
      'job.delete': d => jobDelete(d && d.jobId), 'job.latest': () => jobLatest(),
      'data.usage': () => usageInfo(), 'data.export': () => exportAll(), 'data.deleteAll': () => deleteAll(), 'index.flush': () => flushIndex(true),
    };

    // Single entry point used by the service worker router: one op at a time, errors become {ok:false}.
    function handle(op, data) {
      if (!Object.prototype.hasOwnProperty.call(OPS, op)) return Promise.resolve({ ok: false, error: 'unknown-op' });
      return serial(async () => { try { return { ok: true, data: await OPS[op](data) }; } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 120) }; } });
    }

    return { init, handle, flushIndex: () => serial(() => flushIndex(true)), _index: () => index, _adapter: adapter };
  }

  const api = { STORES, SCHEMA_VERSION, MIGRATIONS, MemoryAdapter, migrate, createStore };
  root.CTS_StoreCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
