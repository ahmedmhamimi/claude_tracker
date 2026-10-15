/**
 * ISOLATED-world side of the 6.0 message channel (document_start).
 * Gives the isolated feature modules a small event bus fed by validated
 * MAIN-world messages, a request/response helper for asking the MAIN world
 * to fetch from claude.ai, and keeps the MAIN world's copy of the feature
 * switches in step with chrome.storage.
 *
 * - CTS_Bus.on(type, fn) -> void: subscribe to 'usage' | 'analysis' | 'convraw' | 'convlist'
 * - CTS_Bus.ready() -> void: called once by boot.js after every module has subscribed; releases MAIN's queue
 * - CTS_Bus.request(type, data, timeoutMs) -> Promise<object>: ask MAIN for 'fetch-conv' / 'fetch-list'
 * - CTS_Bus.saveSettings(patchFn) -> Promise<object>: read-modify-write cts_settings and notify MAIN
 * - CTS_Bus.getSettings() -> object: current cts_settings
 *
 * @requires safe.js, features.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe, Features = window.CTS_Features;
  const handlers = {};
  const pending = new Map();
  let settings = {};
  let windowStart = 0, windowCount = 0;

  // The MAIN world shares a realm with page scripts, so cap how fast it can talk to us.
  const underRateCap = () => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; windowCount = 0; }
    return ++windowCount <= 40;
  };

  function dispatchDown(t, id, d) {
    document.dispatchEvent(new CustomEvent('cts2:down', { detail: JSON.stringify({ v: 1, t, id, d }) }));
  }

  // Messages.js is loaded at idle in the same world; bridge2 runs earlier, so resolve lazily.
  document.addEventListener('cts2:up', e => Safe.run('bridge', () => {
    if (!underRateCap() || !window.CTS_Messages) return;
    const m = window.CTS_Messages.parseUp(e.detail);
    if (!m) return;
    if (m.t === 'fetch-res') {
      const p = m.id && pending.get(m.id);
      if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m.d); }
      return;
    }
    (handlers[m.t] || []).forEach(fn => Safe.run('bridge', () => fn(m.d)));
  }));

  function request(type, data, timeoutMs) {
    return new Promise(resolve => {
      const id = window.CTS_Messages.makeId();
      const timer = setTimeout(() => { pending.delete(id); resolve({ status: 0, json: null, error: 'timeout' }); }, timeoutMs || 30000);
      pending.set(id, { resolve, timer });
      dispatchDown(type, id, data || {});
    });
  }

  function pushSettings() { dispatchDown('settings', null, { settings: publicSettings() }); }
  // Only switches, thresholds and numbers go to MAIN; there is nothing else in cts_settings today.
  const publicSettings = () => settings;

  function applySettings(s) {
    settings = s && typeof s === 'object' ? s : {};
    Features.setSettings(settings);
  }

  function loadSettings() {
    Safe.chromeCall('bridge', () => chrome.storage.local.get(['cts_settings'], items => {
      applySettings(items && items.cts_settings);
    }));
    Safe.chromeCall('bridge', () => chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.cts_settings) { applySettings(ch.cts_settings.newValue); pushSettings(); }
    }));
  }

  function saveSettings(patchFn) {
    return new Promise(resolve => Safe.chromeCall('bridge', () => chrome.storage.local.get(['cts_settings'], items => {
      const next = JSON.parse(JSON.stringify((items && items.cts_settings) || {}));
      try { patchFn(next); } catch (_) {}
      chrome.storage.local.set({ cts_settings: next }, () => { applySettings(next); pushSettings(); resolve(next); });
    })) || resolve(settings));
  }

  function ready() {
    document.documentElement.dataset.ctsx2 = '1';
    document.dispatchEvent(new CustomEvent('cts2:ready'));
    pushSettings();
  }

  window.CTS_Bus = {
    on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    ready, request, saveSettings, getSettings: () => settings,
  };

  loadSettings();
})();
