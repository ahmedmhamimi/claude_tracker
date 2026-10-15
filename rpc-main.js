/**
 * MAIN-world fetcher for the user-started bulk jobs (export, index my history).
 * Only the MAIN world holds claude.ai's captured auth headers, so it makes the
 * requests on behalf of the ISOLATED world. It answers only two request
 * types, only for claude.ai URLs built by CTS_Endpoints.buildUrl, one at a
 * time, at most one every 800 ms and 60 per minute, so a page script that
 * fires the same events gains nothing it could not do with its own session.
 * Also receives the settings mirror used by features.js in this world.
 *
 * - (no exports) listens for 'cts2:down'; replies with 'cts2:up' type 'fetch-res'
 *
 * @requires safe.js, features.js, endpoints.js, messages.js, hooks.js, state.js
 */

(function () {
  'use strict';

  const MIN_GAP_MS = 800, MAX_PER_MIN = 60;
  let chain = Promise.resolve();
  let lastAt = 0;
  const stamps = [];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function throttled(fn) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 60000) stamps.shift();
    if (stamps.length >= MAX_PER_MIN) return { status: 429, json: null, error: 'rate-cap' };
    const wait = Math.max(0, lastAt + MIN_GAP_MS - Date.now());
    if (wait) await sleep(wait);
    lastAt = Date.now(); stamps.push(lastAt);
    return fn();
  }

  async function get(url) {
    const S = window.CTS;
    if (!S.orgId || !window.__originalFetch) return { status: 0, json: null, error: 'no-session' };
    try {
      const res = await window.__originalFetch(url, { method: 'GET', headers: Object.assign({}, S.authHeaders) }); // cts-lint:claude-host
      let json = null;
      if (res.status === 200) { try { json = await res.json(); } catch (_) { return { status: 200, json: null, error: 'bad-json' }; } }
      return { status: res.status, json };
    } catch (_) { return { status: 0, json: null, error: 'network' }; }
  }

  function handle(m) {
    const S = window.CTS;
    if (m.t === 'settings') { window.CTS_Features.setSettings(m.d.settings); return; }
    if (!m.id) return;
    const E = window.CTS_Endpoints;
    chain = chain.then(() => throttled(() => {
      if (m.t === 'fetch-conv') return get(E.buildUrl('conv', { org: S.orgId, id: m.d.convId }));
      if (m.t === 'fetch-list') return get(E.buildUrl('convList', { org: S.orgId }));
      if (m.t === 'fetch-usage') return get(E.buildUrl('usage', { org: S.orgId }));
      return { status: 0, json: null, error: 'unsupported' };
    })).then(r => window.CTS_Hooks.sendRaw('fetch-res', m.id, r)).catch(() => {});
  }

  document.addEventListener('cts2:down', e => window.CTS_Safe.run('rpc', () => {
    const m = window.CTS_Messages.parseDown(e.detail);
    if (m) handle(m);
  }));
})();
