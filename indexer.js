/**
 * Group D runtime (ISOLATED): feeds the library index.
 *   - automatic: every conversation JSON the extension ALREADY fetches (after a reply
 *     finishes) is normalized and upserted; the chat list adds titles/dates.
 *   - user-started "Index my history": throttled (>= 1 s between requests),
 *     cancellable, resumable (it only fetches chats not yet indexed), stops on rate limiting.
 *
 * - CTS_Indexer.startIndexAll(onProgress) -> {cancel(), done: Promise<summary>}
 * - CTS_Indexer.coverage() -> Promise<{indexed, stale, total, missing}|null>
 *
 * @requires safe.js, features.js, client.js, bridge2.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe, F = window.CTS_Features, Client = window.CTS_Client;
  const MIN_GAP_MS = 1000;
  const titles = new Map();
  let lastListSig = '';
  const timers = new Map();

  // The raw JSON goes to the service worker, which normalizes it: parsing a very large chat
  // (measured ~125 ms for 5.8 MB) would otherwise stall the claude.ai page thread.
  const ingest = (json, id) => Client.call('conv.ingest', { id, json, titleHint: titles.get(id) });

  // ─── automatic ────────────────────────────────────────────────────────────
  window.CTS_Bus.on('convraw', d => Safe.run('library', () => {
    if (!F.isEnabled('library') || !F.getSetting('indexing.autoUpsert', true) || !d.id) return;
    clearTimeout(timers.get(d.id));
    timers.set(d.id, setTimeout(() => Safe.run('library', () => {
      timers.delete(d.id);
      ingest(d.json, d.id);
    }), 1500));
  }));

  window.CTS_Bus.on('convlist', d => Safe.run('library', () => {
    if (!F.isEnabled('library')) return;
    d.items.forEach(x => { if (x.name) titles.set(x.uuid, x.name); });
    const sig = d.items.length + ':' + (d.items[0] && d.items[0].updated_at) + ':' + (d.items[d.items.length - 1] && d.items[d.items.length - 1].uuid);
    if (sig === lastListSig) return;
    lastListSig = sig;
    Client.call('conv.meta', { items: d.items });
  }));

  // ─── user-started job ─────────────────────────────────────────────────────
  function startIndexAll(onProgress) {
    let cancelled = false;
    const progress = p => { try { onProgress && onProgress(p); } catch (_) {} };
    const done = (async () => {
      const sum = { done: 0, total: 0, failed: 0, missing: 0, stopped: '' };
      const list = await Client.fetchList();
      if (list.status === 200 && Array.isArray(list.json)) {
        list.json.forEach(x => { if (x && x.name) titles.set(x.uuid, x.name); });
        await Client.call('conv.meta', { items: list.json.map(c => ({ uuid: c.uuid, name: c.name || c.title || null, created_at: c.created_at || null, updated_at: c.updated_at || null })) });
      } else if (list.status === 429) { sum.stopped = 'rate'; return sum; }
      const convs = (await Client.data('conv.list')) || [];
      const todo = convs.filter(c => c.status === 'meta' || c.stale).map(c => c.id);
      sum.total = todo.length; progress(Object.assign({}, sum));
      let consecutiveFails = 0;
      for (const id of todo) {
        if (cancelled) { sum.stopped = 'cancelled'; break; }
        const r = await Client.fetchConv(id, MIN_GAP_MS);
        if (r.status === 200 && r.json) {
          const res = await ingest(r.json, id);
          if (res && res.ok && res.data && res.data.ok) { sum.done++; consecutiveFails = 0; } else sum.failed++;
        } else if (r.status === 404) { await Client.call('conv.missing', { id }); sum.missing++; consecutiveFails = 0; }
        else if (r.status === 429) { sum.stopped = 'rate'; break; }
        else { sum.failed++; if (++consecutiveFails >= 3) { sum.stopped = 'errors'; break; } }
        progress(Object.assign({}, sum, { current: sum.done + sum.failed + sum.missing }));
      }
      return sum;
    })();
    return { cancel: () => { cancelled = true; }, done };
  }

  window.CTS_Indexer = { startIndexAll, coverage: () => Client.data('index.coverage') };
})();
