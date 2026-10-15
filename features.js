/**
 * Feature registry: the one place every TokenLens 6.0 feature is declared.
 * Loaded in BOTH worlds. No DOM and no chrome.* access: settings arrive
 * through setSettings() (ISOLATED: from chrome.storage; MAIN: from the
 * bridge's dataset stamp) so features can be switched without editing them.
 *
 * - CTS_Features.LIST -> object[]: {id, labelKey, defaultEnabled}
 * - CTS_Features.isEnabled(id) -> boolean: false if switched off, session-disabled by safe.js, or unknown
 * - CTS_Features.disable(id, reason) -> void: session-only disable (used by safe.js)
 * - CTS_Features.setSettings(obj) -> void: replaces the cts_settings object
 * - CTS_Features.getSetting(path, fallback) -> any: reads settings.a.b with a default from DEFAULTS
 * - CTS_Features.DEFAULTS -> object: every default setting (thresholds etc.)
 * - CTS_Features.onChange(cb) -> void: called after setSettings()
 *
 * Every entry point, hook and UI surface must call isEnabled() first.
 */

(function (root) {
  'use strict';

  const LIST = [
    { id: 'history',  labelKey: 'featHistory',  defaultEnabled: true  },
    { id: 'alerts',   labelKey: 'featAlerts',   defaultEnabled: true  },
    { id: 'export',   labelKey: 'featExport',   defaultEnabled: true  },
    { id: 'handoff',  labelKey: 'featHandoff',  defaultEnabled: true  },
    { id: 'library',  labelKey: 'featLibrary',  defaultEnabled: true  },
    { id: 'themes',   labelKey: 'featThemes',   defaultEnabled: true  },
    { id: 'snippets', labelKey: 'featSnippets', defaultEnabled: false },
  ];

  const DEFAULTS = {
    features: {},                 // id -> boolean overrides
    alerts: {
      w5h: { t80: true, t95: true, v80: 80, v95: 95 },
      w7d: { t80: true, t95: true, v80: 80, v95: 95 },
    },
    handoff: { hintAt: 80, budgetPct: 30, windowOverride: 0 }, // windowOverride 0 = auto
    theme: { palette: 'auto', density: 'regular' },
    shortcut: { enabled: false, combo: 'Alt+Shift+L' },
    indexing: { autoUpsert: true },
  };

  let settings = {};
  const sessionOff = {};
  const listeners = [];

  function deepGet(obj, path) {
    return String(path).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  }

  function getSetting(path, fallback) {
    const v = deepGet(settings, path);
    if (v !== undefined) return v;
    const d = deepGet(DEFAULTS, path);
    return d !== undefined ? d : fallback;
  }

  function isEnabled(id) {
    const f = LIST.find(x => x.id === id);
    if (!f) return false;
    if (sessionOff[id]) return false;
    const o = settings && settings.features && settings.features[id];
    return typeof o === 'boolean' ? o : f.defaultEnabled;
  }

  function setSettings(obj) {
    settings = obj && typeof obj === 'object' ? obj : {};
    listeners.forEach(cb => { try { cb(); } catch (_) {} });
  }

  const api = {
    LIST, DEFAULTS, isEnabled, getSetting, setSettings,
    disable: (id, reason) => { sessionOff[id] = reason || true; },
    onChange: cb => listeners.push(cb),
    getSessionDisabled: () => Object.assign({}, sessionOff),
  };

  root.CTS_Features = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
