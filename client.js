/**
 * Thin client for the service-worker store (ISOLATED world) plus the throttled
 * claude.ai fetch helper shared by bulk export and "Index my history".
 * Every chrome.* call is guarded: after an extension update the old content
 * script keeps running but chrome.runtime throws "Extension context
 * invalidated"; we degrade silently (CTS_Safe shows the reload wording).
 *
 * - CTS_Client.call(op, data) -> Promise<{ok, data?, error?}>: message the SW store
 * - CTS_Client.data(op, data) -> Promise<any|null>: data on success, null on failure
 * - CTS_Client.fetchConv(id, minGapMs) -> Promise<{status, json, error}>: asks MAIN to fetch one conversation, honouring a minimum gap
 * - CTS_Client.fetchList() / fetchUsage() -> Promise<{status, json, error}>
 * - CTS_Client.sleep(ms)
 *
 * @requires safe.js, bridge2.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function call(op, data) {
    return new Promise(resolve => {
      const r = Safe.chromeCall('client', () => {
        chrome.runtime.sendMessage({ cts: 1, op, data }, res => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: String(chrome.runtime.lastError.message).slice(0, 80) });
          else resolve(res || { ok: false, error: 'no-response' });
        });
        return true;
      });
      if (r === undefined) resolve({ ok: false, error: 'unavailable' });
    });
  }
  const data = async (op, d) => { const r = await call(op, d); return r && r.ok ? r.data : null; };

  let lastFetchAt = 0;
  async function gapped(minGap) {
    const wait = lastFetchAt + (minGap || 0) - Date.now();
    if (wait > 0) await sleep(wait);
    lastFetchAt = Date.now();
  }
  async function fetchConv(id, minGapMs) { await gapped(minGapMs); return window.CTS_Bus.request('fetch-conv', { convId: id }, 30000); }
  async function fetchList() { await gapped(0); return window.CTS_Bus.request('fetch-list', {}, 30000); }
  async function fetchUsage() { await gapped(0); return window.CTS_Bus.request('fetch-usage', {}, 30000); }

  window.CTS_Client = { call, data, fetchConv, fetchList, fetchUsage, sleep };
})();
