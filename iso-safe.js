/**
 * Safe wrapper: nothing a TokenLens feature does may break the core widget or
 * claude.ai itself. Loaded in BOTH worlds (each world gets its own copy).
 * No DOM access. chrome.* is only touched through injected callbacks.
 *
 * - CTS_Safe.run(featureId, fn) -> any|undefined: runs fn, swallows sync errors and promise rejections
 * - CTS_Safe.wrap(featureId, fn) -> function: returns fn wrapped with run() (for event listeners)
 * - CTS_Safe.chromeCall(featureId, fn) -> any|undefined: like run(), but treats "Extension context invalidated" as a quiet state
 * - CTS_Safe.isInvalidated() -> boolean: true once the extension was updated/reloaded under this tab
 * - CTS_Safe.onInvalidated(cb) -> void: callback fired once (UI shows the "reload this tab" wording)
 * - CTS_Safe.getErrors() -> object[]: last 50 entries {t, f, m}; never contains conversation content
 * - CTS_Safe.getDisabled() -> object: {featureId: {t, reason}} for features tripped this session
 * - CTS_Safe.configure({now, features, sink}) -> void: injectable clock, feature registry, error sink (tests / persistence)
 *
 * Trip rule: 3 errors from one feature within 10 minutes disables it for the
 * rest of the session (via the registry, so every entry point stops at once).
 */

(function (root) {
  'use strict';

  const MAX_ERRORS = 50;
  const TRIP_COUNT = 3;
  const TRIP_WINDOW_MS = 10 * 60 * 1000;

  let now = () => Date.now();
  let features = null;     // registry exposing disable(id, reason)
  let sink = null;         // optional (entry) => void, e.g. persists to chrome.storage
  let invalidated = false;
  const invalidatedCbs = [];
  const errors = [];
  const recent = {};       // featureId -> [timestamps]
  const disabled = {};     // featureId -> {t, reason}

  function configure(opts) {
    opts = opts || {};
    if (typeof opts.now === 'function') now = opts.now;
    if (opts.features) features = opts.features;
    if (typeof opts.sink === 'function') sink = opts.sink;
  }

  // Error text can embed fragments of whatever was being parsed (JSON.parse
  // quotes the bad token). Strip quoted fragments and cap the length so a
  // crash report can never carry conversation text.
  function scrub(msg) {
    return String(msg == null ? '' : msg)
      .replace(/(["'`])[^\n]*?\1/g, '"…"')
      .replace(/\s+/g, ' ')
      .slice(0, 160);
  }

  function isInvalidatedError(e) {
    return !!(e && /Extension context invalidated/i.test(String(e.message || e)));
  }

  function markInvalidated() {
    if (invalidated) return;
    invalidated = true;
    invalidatedCbs.splice(0).forEach(cb => { try { cb(); } catch (_) {} });
  }

  function report(featureId, e) {
    if (isInvalidatedError(e)) { markInvalidated(); return; }
    const t = now();
    const entry = { t, f: String(featureId || 'unknown'), m: scrub(e && e.message ? e.message : e) };
    errors.push(entry);
    if (errors.length > MAX_ERRORS) errors.shift();
    try { if (sink) sink(entry); } catch (_) {}

    const list = (recent[entry.f] = (recent[entry.f] || []).filter(x => t - x < TRIP_WINDOW_MS));
    list.push(t);
    if (list.length >= TRIP_COUNT && !disabled[entry.f]) {
      disabled[entry.f] = { t, reason: TRIP_COUNT + ' errors in 10 minutes' };
      try { if (features && features.disable) features.disable(entry.f, disabled[entry.f].reason); } catch (_) {}
    }
  }

  function run(featureId, fn) {
    if (disabled[featureId]) return undefined;
    try {
      const r = fn();
      if (r && typeof r.then === 'function') {
        return r.then(undefined, e => { report(featureId, e); });
      }
      return r;
    } catch (e) {
      report(featureId, e);
      return undefined;
    }
  }

  function wrap(featureId, fn) {
    return function () {
      const self = this, args = arguments;
      return run(featureId, () => fn.apply(self, args));
    };
  }

  const chromeCall = run; // run() already routes invalidation errors to the quiet path

  const api = {
    run, wrap, chromeCall, configure,
    isInvalidated: () => invalidated,
    onInvalidated: cb => { if (invalidated) { try { cb(); } catch (_) {} } else invalidatedCbs.push(cb); },
    getErrors: () => errors.slice(),
    getDisabled: () => Object.assign({}, disabled),
    _scrub: scrub,
  };

  root.CTS_Safe = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
