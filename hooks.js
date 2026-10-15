/**
 * MAIN-world hook emitter. Existing files call one guarded line
 * (CTS_Hooks.emit('usage'), etc.); this module turns that into a small,
 * validated message for the ISOLATED world, where the 6.0 features live.
 * It does no work until the ISOLATED side announces it is ready, queues at
 * most 100 messages before that, and sends nothing for disabled features.
 * Nothing sent here can trigger an action; it only offers data the page
 * already holds. Messages travel as JSON strings in 'cts2:up' CustomEvents.
 *
 * - CTS_Hooks.emit(type, a, b) -> void: types 'usage' | 'analysis' | 'convraw' | 'convlist'
 * - CTS_Hooks.markReady() -> void: flushes the queue (called when 'cts2:ready' fires)
 * - CTS_Hooks.sendRaw(type, id, data) -> void: used by rpc-main.js for request replies
 *
 * @requires safe.js, features.js, state.js
 */

(function (root) {
  'use strict';

  const MAX_QUEUE = 100;
  const MAX_JSON_CHARS = 8 * 1024 * 1024;
  const FEATURES_FOR = { usage: ['history', 'alerts'], analysis: ['history', 'handoff', 'library'], convraw: ['library'], convlist: ['library'] };

  let ready = false;
  const queue = [];

  // Feature switches reach this world via the bridge's dataset stamp (cts_settings).
  let settingsLoaded = false;
  function loadSettingsOnce() {
    if (settingsLoaded) return;
    const raw = document.documentElement.dataset.ctsstorage;
    if (raw === undefined) return; // bridge not ready yet; try again on the next emit
    settingsLoaded = true;
    try { const s = JSON.parse(raw).cts_settings; if (s && typeof s === 'object') root.CTS_Features.setSettings(s); } catch (_) {}
  }

  const wanted = type => {
    loadSettingsOnce();
    return (FEATURES_FOR[type] || []).some(f => root.CTS_Features && root.CTS_Features.isEnabled(f));
  };

  function build(type, a, b) {
    const S = root.CTS;
    if (!S) return null;
    const now = Date.now();
    switch (type) {
      case 'usage':
        return { t: now, u5h: S.current5hUtil, u7d: S.current7dUtil, r5h: S.targetTimestamps['5h'], r7d: S.targetTimestamps['7d'], limitHit: !!S.isLimitHit };
      case 'analysis': {
        if (!a) return null;
        const meta = S.currentModelMeta;
        return { t: now, convId: b || S.convoId || null, totalTokens: a.totalTokens, assistantCount: a.assistantCount,
          quotaDelta5h: S.lastMsgQuotaDelta, msgSeq: S.sessionMsgCount, ctxWindow: meta && meta.ctx || null,
          streaming: !!S.isStreaming };
      }
      case 'convraw':
        return a && typeof a === 'object' ? { id: b || null, json: a } : null;
      case 'convlist':
        return Array.isArray(a) ? { items: a.slice(0, 5000).map(c => ({ uuid: c && c.uuid, name: c && (c.name || c.title) || null, created_at: c && c.created_at || null, updated_at: c && c.updated_at || null })).filter(x => typeof x.uuid === 'string') } : null;
      default: return null;
    }
  }

  function dispatch(msg) {
    const json = JSON.stringify(msg);
    if (json.length > MAX_JSON_CHARS) return;
    document.dispatchEvent(new CustomEvent('cts2:up', { detail: json }));
  }

  function emit(type, a, b) {
    if (!wanted(type)) return;
    root.CTS_Safe.run('hooks', () => {
      const d = build(type, a, b);
      if (!d) return;
      const msg = { v: 1, t: type, d };
      if (!ready) { queue.push(msg); if (queue.length > MAX_QUEUE) queue.shift(); return; }
      dispatch(msg);
    });
  }

  function markReady() {
    ready = true;
    root.CTS_Safe.run('hooks', () => queue.splice(0).forEach(dispatch));
  }

  function sendRaw(type, id, data) { root.CTS_Safe.run('hooks', () => dispatch({ v: 1, t: type, id, d: data })); }

  // The ISOLATED side stamps dataset.ctsx2 = '1' and fires 'cts2:ready' once its listeners exist.
  document.addEventListener('cts2:ready', markReady);
  if (document.documentElement.dataset.ctsx2 === '1') markReady();

  // Streaming flag for the ISOLATED side's calm-moment check: written only when it changes.
  setInterval(() => root.CTS_Safe.run('hooks', () => {
    const v = root.CTS && root.CTS.isStreaming ? '1' : '0';
    if (document.documentElement.dataset.ctsStream !== v) document.documentElement.dataset.ctsStream = v;
  }), 1000);

  const api = { emit, markReady, sendRaw };
  root.CTS_Hooks = api;
})(window);
