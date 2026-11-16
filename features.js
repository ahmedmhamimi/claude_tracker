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
 * - CTS_Features.DEFAULTS -> object: every default setting (ui switches, theme, handoff ...)
 * - CTS_Features.ui(key) -> boolean: settings.ui[key] with its default (a surface switch)
 * - CTS_Features.onChange(cb) -> void: called after setSettings()
 *
 * Every entry point, hook and UI surface must call isEnabled() first.
 */

(function (root) {
  'use strict';

  const LIST = [
    { id: 'history',  labelKey: 'featHistory',  defaultEnabled: true  },
    { id: 'export',   labelKey: 'featExport',   defaultEnabled: true  },
    { id: 'handoff',  labelKey: 'featHandoff',  defaultEnabled: true  },
    { id: 'library',  labelKey: 'featLibrary',  defaultEnabled: true  },
    { id: 'themes',   labelKey: 'featThemes',   defaultEnabled: true  },
    { id: 'vamimi',   labelKey: 'featVamimi',   defaultEnabled: true  },
    { id: 'snippets', labelKey: 'featSnippets', defaultEnabled: false },
  ];

  const DEFAULTS = {
    features: {},                 // id -> boolean overrides
    handoff: { hintAt: 80, budgetPct: 30, windowOverride: 0 }, // windowOverride 0 = auto
    theme: { palette: 'auto', density: 'regular', accent: '' },   // palette: auto|warm|ocean|forest|violet|rose|mono|custom; accent: '#rrggbb' for custom
    // What TokenLens shows (6.4). Every surface can be switched off on its own.
    ui: {
      sidebar: true,      // usage box at the top of the sidebar (#ct-quota)
      floating: true,     // floating usage card (#ct-toolbar-quota) and its reopen icon
      composer: true,     // 5h / 7d row above the message box (#ct-row)
      badges: true,       // peak / cache badges in the floating card
      chips: true,        // per-reply stats (latency, speed, % of limit, tokens)
      dates: true,        // "created on" dates next to sidebar chat titles
      tools: true,        // Search / Save all / History / Settings strip in the sidebar
      vmLink: true,       // VamimiAI shortcut in the sidebar
      levelColors: false, // opt-in: bars turn amber at 75% and red at 90% (default: always the accent)
    },
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

  const ui = key => getSetting('ui.' + key, true) !== false;

  const api = {
    LIST, DEFAULTS, isEnabled, getSetting, setSettings, ui,
    disable: (id, reason) => { sessionOff[id] = reason || true; },
    onChange: cb => listeners.push(cb),
    getSessionDisabled: () => Object.assign({}, sessionOff),
  };

  root.CTS_Features = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
