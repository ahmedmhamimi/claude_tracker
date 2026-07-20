/**
 * CSS injection, theme detection, tooltip engine, and all DOM constructor functions.
 * No business logic, no network calls — pure view layer.
 *
 * - ClaudeTrackerUI.init() -> void: injects CSS, sets up theme observer, initialises tooltip engine
 * - ClaudeTrackerUI.buildQuotaContainer() -> HTMLElement: builds the sidebar quota panel DOM node
 * - ClaudeTrackerUI.buildComposerRow() -> HTMLElement: builds the composer stats row DOM node
 * - ClaudeTrackerUI.buildToolbarQuota() -> HTMLElement: builds the inline toolbar quota strip
 * - ClaudeTrackerUI.buildGhost() -> HTMLElement: builds the floating ghost stats overlay
 * - ClaudeTrackerUI.updateQuotaBars(win, pct, ts) -> void: updates progress bar fills for a given window
 * - ClaudeTrackerUI.renderChips(lastMessageNode, chipsData, cached) -> void: appends per-response chip row after assistant message
 */

window.ClaudeTrackerUI = (function () {
  'use strict';

  // ─── i18n helpers ─────────────────────────────────────────────────────────
  // Reads from the JSON blob stamped by bridge.js (ISOLATED world) onto the
  // root element. Lazy-initialised on first call; bridge stamps i18n data
  // synchronously at document_start so it is always populated by UI build time.
  let _i18nCache = null;
  const i18n = (key, ...subs) => {
    if (!_i18nCache) {
      try { _i18nCache = JSON.parse(document.documentElement.dataset.ctsi18n || '{}'); }
      catch (_) { _i18nCache = {}; }
    }
    let msg = _i18nCache[key] || key;
    // Replace $PLACEHOLDER$ tokens in-order with provided substitution args.
    if (subs.length) {
      let i = 0;
      msg = msg.replace(/\$[A-Z_]+\$/gi, () => (subs[i] !== undefined ? subs[i++] : ''));
    }
    return msg;
  };
  // Escape a getMessage() result for use inside an HTML attribute value.
  // Optional `fallback` routes through withFallback() for keys that don't
  // have a messages.json entry yet (see hintTitle/hintBody below).
  const tipAttr = (key, fallback) =>
  (fallback !== undefined ? withFallback(key, fallback) : i18n(key))
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
  // Same lookup as i18n(), but falls back to a hardcoded default instead of
  // the raw key when no messages.json entry exists yet for `key`.
  const withFallback = (key, fallback, ...subs) => {
    const val = i18n(key, ...subs);
    return val === key ? fallback : val;
  };

  // ─── CSS Themes ───────────────────────────────────────────────────────────

  const DARK_THEME_CSS = `
  :root {
    --ct-border: rgba(255, 255, 255, 0.12);
    --ct-text: #ffffff;
    --ct-muted: rgba(255, 255, 255, 0.62);
    --ct-accent: #e8622a;
    --ct-green: #4ade80;
    --ct-orange: #e8622a;
    --ct-red: #ef4444;
    --ct-blue: #e8622a;
    --ct-purple: #c084fc;
    --ct-surface: transparent;
    --ct-bg-progress: rgba(255, 255, 255, 0.10);
    --ct-mono: 'SF Mono', 'Fira Code', ui-monospace, monospace;
    --ct-ghost-bg: rgba(40, 36, 30, 0.95);
    --ct-accent-rgb: 232, 98, 42;
  }
  `;

  const LIGHT_THEME_CSS = `
  :root {
    --ct-border: rgba(0, 0, 0, 0.10);
    --ct-text: #000000;
    --ct-muted: #555555;
    --ct-accent: #d97706;
    --ct-green: #15803d;
    --ct-orange: #d97706;
    --ct-red: #b91c1c;
    --ct-blue: #d97706;
    --ct-purple: #6d28d9;
    --ct-surface: transparent;
    --ct-bg-progress: #e5e7eb;
    --ct-mono: 'SF Mono', 'Fira Code', ui-monospace, monospace;
    --ct-ghost-bg: rgba(255, 255, 255, 0.92);
    --ct-accent-rgb: 217, 119, 6;
  }
  `;

  const STRUCTURAL_CSS = `
  #ct-ctx-bar {
  position: absolute; left: 0; right: 0; top: 0;
  height: 3px; border-radius: 3px 3px 0 0;
  background: var(--ct-bg-progress);
  overflow: hidden; opacity: 0;
  transition: opacity 0.4s; pointer-events: none; z-index: 10;
  }
  #ct-ctx-bar.vis { opacity: 1; }
  #ct-ctx-bar-fill {
  height: 100%; width: 0%;
  background: var(--ct-blue);
  transition: width 0.5s cubic-bezier(.4,0,.2,1);
  }

  #ct-row {
  display: flex; flex-direction: row; align-items: center;
  gap: 8px; padding: 4px 16px 6px;
  overflow: hidden; min-width: 0; box-sizing: border-box; width: 100%;
  flex-wrap: nowrap;
  }
  #ct-row-left {
  display: flex; align-items: center; gap: 8px; flex-wrap: nowrap;
  overflow: hidden; min-width: 0; flex: 1;
  }
  #ct-row-right {
  display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; flex-shrink: 0;
  }
  #ct-row-peak {
  display: flex; align-items: center;
  }

  .ct-pill {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--ct-mono); font-size: 11px; font-weight: 700;
    color: var(--ct-muted); white-space: nowrap;
    cursor: default; user-select: none;
  }
  .ct-pill-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: currentColor; flex-shrink: 0;
  }
  .ct-pill.warn   { color: var(--ct-orange); }
  .ct-pill.danger { color: var(--ct-red); }
  .ct-pill.ok     { color: var(--ct-green); }
  .ct-pill.stream .ct-pill-dot { animation: ct-stream 0.6s infinite alternate; }

  @keyframes ct-stream { from{opacity:.2} to{opacity:1} }
  @keyframes ct-throb  { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(.6);opacity:.4} }

  #ct-quota {
  display: flex; flex-direction: column; gap: 12px;
  padding: 4px 0px 14px 0px; margin: 8px 12px;
  background: transparent;
  border-bottom: 1px solid var(--ct-border);
  opacity: 0; transition: opacity 0.4s ease-in-out;
  cursor: default; user-select: none;
  min-width: 160px; box-sizing: border-box; overflow: visible;
  flex-shrink: 0; width: calc(100% - 24px);
  }
  #ct-quota.vis { opacity: 1; }
  #ct-quota.sidebar-hidden { display: none !important; }

  .ct-quota-row { display: flex; flex-direction: column; gap: 6px; }

  .ct-quota-header {
    display: flex; justify-content: space-between; align-items: baseline;
    font-family: var(--ct-mono); font-size: 11.5px; font-weight: 700; color: var(--ct-text);
    white-space: nowrap; gap: 6px;
  }
  .ct-quota-header span { overflow: hidden; text-overflow: ellipsis; }

  .ct-progress-wrap {
    display: flex; align-items: center; gap: 8px;
  }
  .ct-progress-bg {
    flex: 1;
    height: 8px; background: var(--ct-bg-progress);
    border-radius: 4px; overflow: hidden; position: relative;
  }
  .ct-bar-pct {
    font-family: var(--ct-mono); font-size: 10px; font-weight: 800;
    color: var(--ct-muted); white-space: nowrap; min-width: 28px; text-align: right;
  }
  .ct-progress-fill {
    height: 100%; width: 0%; border-radius: 4px;
    background-color: var(--ct-accent) !important;
    transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .ct-quota-footer {
    display: flex; justify-content: space-between; gap: 6px;
    font-family: var(--ct-mono); font-size: 10px; font-weight: 700; color: var(--ct-muted);
    white-space: nowrap;
  }

  #ct-peak {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--ct-mono); font-size: 9.5px; font-weight: 800;
  letter-spacing: .05em; text-transform: uppercase;
  padding: 3px 10px; border-radius: 20px; border: 2px solid transparent;
  white-space: nowrap;
  }
  #ct-peak.peak    { background: rgba(239,68,68,.12); border-color: var(--ct-red); color: var(--ct-red); }
  #ct-peak.offpeak { background: rgba(74,222,128,.12); border-color: var(--ct-green); color: var(--ct-green); }
  .ct-peak-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  #ct-peak.peak .ct-peak-dot { animation: ct-throb 1.2s infinite; }

  .ct-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .ct-chip {
    font-family: var(--ct-mono); font-size: 10px; font-weight: 700; color: var(--ct-muted);
    background: var(--ct-surface); border: 2px solid var(--ct-border);
    border-radius: 4px; padding: 2px 8px;
    display: inline-flex; align-items: center; gap: 5px;
  }
  .ct-chip.fast    { color: var(--ct-green); border-color: var(--ct-green); }
  .ct-chip.slow    { color: var(--ct-orange); border-color: var(--ct-orange); }
  .ct-chip.cached  { color: var(--ct-purple); border-color: var(--ct-purple); }
  .ct-chip.maxed   { color: var(--ct-red); border-color: var(--ct-red); }

  /* Floating quota card — lives on its own, detached from the composer.
   * Anchored fixed to the viewport (top-right on desktop, tucked above the
   * composer on narrow viewports) so it never competes for space with the
   * message box or the toolbar buttons around it. */
  #ct-toolbar-quota {
  position: fixed; top: 68px; right: 20px; z-index: 9997;
  display: flex; flex-direction: column; gap: 9px;
  min-width: 178px;
  padding: 11px 14px 12px;
  border-radius: 14px;
  background: var(--ct-ghost-bg);
  border: 1px solid var(--ct-border);
  backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  box-shadow: 0 10px 30px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06);
  font-family: var(--ct-mono); color: var(--ct-muted); white-space: nowrap;
  opacity: 0; transform: translateY(-8px) scale(0.98);
  transform-origin: 0 0;
  transition: opacity 0.35s ease, transform 0.35s cubic-bezier(.2,.8,.3,1);
  pointer-events: auto;
  }
  #ct-toolbar-quota.vis { opacity: 1; transform: translateY(0) scale(1); }
  #ct-toolbar-quota:hover {
  box-shadow: 0 14px 38px rgba(0,0,0,0.18), 0 3px 10px rgba(0,0,0,0.08);
  }
  #ct-toolbar-quota, #ct-toolbar-quota * { cursor: grab; }
  #ct-toolbar-quota.ct-dragging,
  #ct-toolbar-quota.ct-dragging * {
  cursor: grabbing !important;
  }
  #ct-toolbar-quota.ct-dragging {
  transition: none !important;
  user-select: none;
  box-shadow: 0 18px 44px rgba(0,0,0,0.22), 0 4px 12px rgba(0,0,0,0.1);
  }
  #ct-toolbar-quota #ct-peak { align-self: flex-start; }

  #ct-tq-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; width: 100%;
  }
  .ct-collapse-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; padding: 0; margin: 0; flex-shrink: 0;
    border: none; border-radius: 5px; background: transparent;
    color: var(--ct-muted); cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .ct-collapse-toggle:hover { background: var(--ct-bg-progress); color: var(--ct-text); }
  .ct-collapse-toggle svg {
    width: 11px; height: 11px; display: block;
    transition: transform 0.25s cubic-bezier(.4,0,.2,1);
  }
  #ct-toolbar-quota.ct-collapsed .ct-collapse-toggle svg { transform: rotate(-90deg); }
  #ct-toolbar-quota.ct-collapsed .ct-tq-block { display: none; }

  .ct-tq-sep { display: none; }
  .ct-tq-block {
    display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  }
  .ct-tq-label {
    color: var(--ct-muted); font-size: 9.5px; font-weight: 800;
    letter-spacing: .04em; width: 16px; flex-shrink: 0;
  }
  .ct-tq-bar {
    width: 74px; height: 5px; border-radius: 3px;
    background: var(--ct-bg-progress); overflow: hidden; flex-shrink: 0;
  }
  .ct-tq-fill { height: 100%; width: 0%; border-radius: 3px; background: var(--ct-accent);
    transition: width 0.5s cubic-bezier(.4,0,.2,1); }
    .ct-tq-pct {
      font-size: 10px; font-weight: 800; color: var(--ct-text);
      min-width: 26px; text-align: right; flex-shrink: 0;
    }
    .ct-tq-reset {
      font-size: 9.5px; color: var(--ct-muted); opacity: 0.65;
      margin-left: auto; flex-shrink: 0;
    }
    @media (max-width: 768px) {
      #ct-toolbar-quota {
      top: auto; bottom: 96px; right: 14px; left: 14px;
      min-width: 0; flex-direction: row; align-items: center; gap: 14px;
      padding: 9px 12px;
      }
      #ct-toolbar-quota #ct-peak { align-self: center; }
      .ct-tq-block { gap: 6px; }
      .ct-tq-bar { width: 44px; }
      .ct-tq-reset { display: none; }
    }

    .ct-resize-handle {
      position: absolute;
      width: 13px; height: 13px;
      opacity: 0; transition: opacity 0.2s ease;
      z-index: 2;
    }
    #ct-toolbar-quota:hover .ct-resize-handle,
    #ct-toolbar-quota.ct-resizing .ct-resize-handle { opacity: 0.7; }
    .ct-resize-handle:hover { opacity: 1 !important; }
    #ct-toolbar-quota.ct-resizing { transition: none !important; }

    .ct-resize-handle[data-corner="br"] {
      right: 2px; bottom: 2px; cursor: nwse-resize !important;
      background-image:
      linear-gradient(135deg, transparent 0 42%, var(--ct-muted) 42% 50%, transparent 50% 62%,
                      var(--ct-muted) 62% 70%, transparent 70% 82%, var(--ct-muted) 82% 90%, transparent 90%);
    }
    .ct-resize-handle[data-corner="tl"] {
      left: 2px; top: 2px; cursor: nwse-resize !important;
      background-image:
      linear-gradient(135deg, transparent 0 42%, var(--ct-muted) 42% 50%, transparent 50% 62%,
                      var(--ct-muted) 62% 70%, transparent 70% 82%, var(--ct-muted) 82% 90%, transparent 90%);
    }
    .ct-resize-handle[data-corner="tr"] {
      right: 2px; top: 2px; cursor: nesw-resize !important;
      background-image:
      linear-gradient(45deg, transparent 0 42%, var(--ct-muted) 42% 50%, transparent 50% 62%,
                      var(--ct-muted) 62% 70%, transparent 70% 82%, var(--ct-muted) 82% 90%, transparent 90%);
    }
    .ct-resize-handle[data-corner="bl"] {
      left: 2px; bottom: 2px; cursor: nesw-resize !important;
      background-image:
      linear-gradient(45deg, transparent 0 42%, var(--ct-muted) 42% 50%, transparent 50% 62%,
                      var(--ct-muted) 62% 70%, transparent 70% 82%, var(--ct-muted) 82% 90%, transparent 90%);
    }

    #ct-row-quota {
    display: none;
    align-items: center; gap: 14px;
    flex-wrap: nowrap; overflow: hidden;
    }
    #ct-row-quota.vis { display: inline-flex; }
    .ct-inline-quota {
      display: inline-flex; align-items: center; gap: 7px;
      font-family: var(--ct-mono); font-size: 11px; font-weight: 700;
      color: var(--ct-muted); white-space: nowrap; min-width: 0;
    }
    .ct-inline-quota-label { flex-shrink: 0; }
    .ct-inline-quota-bar {
      width: 72px; height: 5px; border-radius: 3px;
      background: var(--ct-bg-progress); overflow: hidden; flex-shrink: 0;
    }
    .ct-inline-quota-fill {
      height: 100%; width: 0%; border-radius: 3px;
      background: var(--ct-accent);
      transition: width 0.5s cubic-bezier(.4,0,.2,1);
    }
    .ct-inline-quota-pct { min-width: 26px; text-align: right; flex-shrink: 0; }
    .ct-inline-quota-reset { color: var(--ct-muted); opacity: 0.7; flex-shrink: 0; }

    #ct-ghost {
    position: fixed; bottom: 85px; right: 25px;
    display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
    z-index: 9999; pointer-events: none; opacity: 0; transition: opacity 0.4s;
    }
    #ct-ghost.vis { opacity: 1; }
    .ct-ghost-item {
      font-family: var(--ct-mono); font-size: 10.5px; font-weight: 700; color: var(--ct-text);
      background: var(--ct-ghost-bg); border: 2px solid var(--ct-border);
      border-radius: 6px; padding: 4px 10px;
      backdrop-filter: blur(12px); letter-spacing: .02em;
    }
    .ct-ghost-item b { color: var(--ct-accent) !important; font-weight: 800; }

    [data-ct-tip] { cursor: default; }
    #ct-tooltip {
    position: fixed; z-index: 2147483647; pointer-events: none;
    background: #1a1a1a; color: #f0ede8;
    font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
    font-size: 10.5px; font-weight: 600; line-height: 1.6;
    padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.14);
    white-space: pre-wrap; word-break: break-word;
    max-width: 260px; width: max-content;
    box-shadow: 0 6px 24px rgba(0,0,0,0.5);
    opacity: 0; transition: opacity 0.12s ease;
    }
    #ct-tooltip.vis { opacity: 1; }

    /* One-time onboarding hint — points at the movable/resizable widget. */
    #ct-hint {
    position: fixed; z-index: 9998;
    max-width: 220px;
    padding: 11px 26px 12px 13px;
    border-radius: 12px;
    background: var(--ct-ghost-bg);
    border: 1px solid var(--ct-border);
    backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
    box-shadow: 0 10px 30px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
    font-family: var(--ct-mono); color: var(--ct-muted);
    font-size: 11px; font-weight: 600; line-height: 1.55;
    opacity: 0; transform: translateY(6px) scale(0.94);
    transform-origin: top right;
    pointer-events: none;
    transition: opacity 0.5s cubic-bezier(.2,.8,.3,1), transform 0.5s cubic-bezier(.2,.8,.3,1);
    }
    #ct-hint.vis {
    opacity: 1; transform: translateY(0) scale(1);
    pointer-events: auto;
    }
    /* Kept on a separate class from .vis and applied only after the
     * entrance transition finishes. A CSS animation and a CSS transition
     * on the same property (transform) racing from the same trigger causes
     * the animation to win instantly, killing the transition — that was
     * the source of the bubble "popping" into place instead of easing in. */
    #ct-hint.ct-hint-bob-active {
    animation: ct-hint-bob 2.6s ease-in-out infinite;
    }
    #ct-hint-arrow {
    position: absolute; top: -7px; right: 28px;
    width: 13px; height: 13px;
    background: var(--ct-ghost-bg);
    border-left: 1px solid var(--ct-border);
    border-top: 1px solid var(--ct-border);
    transform: rotate(45deg);
    border-radius: 2px 0 0 0;
    }
    #ct-hint-close {
    position: absolute; top: 7px; right: 7px;
    width: 16px; height: 16px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 50%;
    color: var(--ct-muted); font-size: 11px; line-height: 1;
    cursor: pointer; background: transparent;
    transition: background 0.15s ease, color 0.15s ease;
    }
    #ct-hint-close:hover { background: var(--ct-bg-progress); color: var(--ct-text); }
    #ct-hint-title {
    display: flex; align-items: center; gap: 6px;
    font-weight: 800; color: var(--ct-text); margin-bottom: 3px;
    }
    #ct-hint-icon { font-size: 12px; filter: saturate(1.3); }
    #ct-hint-body { color: var(--ct-muted); }

    /* Used when there isn't room below the widget — bubble sits above it
     *  instead, so the arrow and entrance direction both flip to match. */
    #ct-hint.ct-hint-above { transform-origin: bottom right; }
    #ct-hint.ct-hint-above:not(.vis) { transform: translateY(-6px) scale(0.94); }
    #ct-hint.ct-hint-above #ct-hint-arrow {
    top: auto; bottom: -7px;
    border-left: none; border-top: none;
    border-right: 1px solid var(--ct-border);
    border-bottom: 1px solid var(--ct-border);
    border-radius: 0 0 2px 0;
    }

    @keyframes ct-hint-bob {
      0%, 100% { transform: translateY(0) scale(1); }
      50%      { transform: translateY(-3px) scale(1); }
    }
    @keyframes ct-hint-pulse-ring {
      0%   { box-shadow: 0 0 0 0 rgba(var(--ct-accent-rgb), 0.45); }
      70%  { box-shadow: 0 0 0 9px rgba(var(--ct-accent-rgb), 0); }
      100% { box-shadow: 0 0 0 0 rgba(var(--ct-accent-rgb), 0); }
    }
    #ct-toolbar-quota.ct-hint-pulse { animation: ct-hint-pulse-ring 1.8s ease-out 3; }
    `;

    // ─── Theme Detection ──────────────────────────────────────────────────────

    function detectAndApplyTheme() {
      let styleTag = document.getElementById('ct-styles');
      if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'ct-styles';
        (document.head || document.documentElement).appendChild(styleTag);
      }

      const hasDarkClass =
      document.documentElement.classList.contains('dark') ||
      document.body.classList.contains('dark') ||
      document.documentElement.getAttribute('data-theme') === 'dark';

      let isDarkByColor = false;
      if (!hasDarkClass) {
        const bg = window.getComputedStyle(document.body).backgroundColor;
        const m  = bg.match(/\d+/g);
        if (m && m.length >= 3) {
          const luminance = (parseInt(m[0]) * 299 + parseInt(m[1]) * 587 + parseInt(m[2]) * 114) / 1000;
          isDarkByColor = luminance < 128;
        }
      }

      const isDark = hasDarkClass || isDarkByColor;
      styleTag.textContent = (isDark ? DARK_THEME_CSS : LIGHT_THEME_CSS) + STRUCTURAL_CSS;
    }

    // ─── Storage helper ───────────────────────────────────────────────────────
    // Prefers chrome.storage.local (extension storage). ui.js appears to run in
    // the page's MAIN world (see the i18n comment above — that's the whole
    // reason bridge.js has to stamp data across rather than ui.js calling
    // chrome.i18n directly), and MAIN-world scripts normally have no access to
    // chrome.* APIs at all, only page globals like localStorage. This falls
    // back to localStorage — same mechanism already used for widget
    // position/scale above — so persistence still works either way; if
    // chrome.storage turns out to be reachable here after all, it's used.
    const hasChromeStorage = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);

    function storageGet(key) {
      return new Promise(resolve => {
        if (hasChromeStorage) {
          try {
            chrome.storage.local.get(key, result => resolve(result ? result[key] : undefined));
            return;
          } catch (_) { /* fall through to localStorage */ }
        }
        try { resolve(localStorage.getItem(key)); } catch (_) { resolve(null); }
      });
    }

    function storageSet(key, value) {
      if (hasChromeStorage) {
        try { chrome.storage.local.set({ [key]: value }); return; } catch (_) { /* fall through */ }
      }
      try { localStorage.setItem(key, value); } catch (_) {}
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    let _uiInitDone = false;

    return {

      init() {
        detectAndApplyTheme();

        // Everything below (observers, interval, global listeners) must run
        // exactly once, ever. init() has no caller-side guard against being
        // invoked repeatedly — and on layouts where downstream injection
        // logic never reaches a stable terminal state (e.g. Incognito chat,
        // which has no sidebar <nav> for content.js to mount the quota panel
        // in), it WAS being called on every DOM mutation. Each call created
        // two new permanent MutationObservers, a new uncleared setInterval,
        // and three new document-level capture listeners — an unbounded leak
        // that pinned the JS thread and froze the tab within seconds.
        if (_uiInitDone) return;
        _uiInitDone = true;

        const htmlObserver = new MutationObserver(detectAndApplyTheme);
        htmlObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });

        const bodyObserver = new MutationObserver(detectAndApplyTheme);
        bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

        setInterval(detectAndApplyTheme, 1000);

        // Tooltip engine
        let tip = document.getElementById('ct-tooltip');
        if (!tip) {
          tip = document.createElement('div');
          tip.id = 'ct-tooltip';
          document.body.appendChild(tip);
        }
        let hideTimer = null;

        document.addEventListener('mouseover', e => {
          const el = e.target.closest('[data-ct-tip]');
          if (!el) return;
          clearTimeout(hideTimer);
          tip.textContent = el.getAttribute('data-ct-tip');
          tip.classList.add('vis');
          positionTip(el);
        }, true);

        document.addEventListener('mousemove', e => {
          const el = e.target.closest('[data-ct-tip]');
          if (el) positionTip(el);
        }, true);

          document.addEventListener('mouseout', e => {
            const el = e.target.closest('[data-ct-tip]');
            if (el) hideTimer = setTimeout(() => tip.classList.remove('vis'), 80);
          }, true);

            function positionTip(el) {
              const r  = el.getBoundingClientRect();
              const tw = Math.min(300, window.innerWidth - 24);
              tip.style.left = '0'; tip.style.top = '-9999px'; tip.style.maxWidth = tw + 'px';
              const th  = tip.offsetHeight || 80;
              let top   = r.top - th - 10;
              let left  = r.left + r.width / 2;
              if (top < 8) top = r.bottom + 10;
              left = Math.max(8, Math.min(left - tip.offsetWidth / 2, window.innerWidth - tip.offsetWidth - 8));
              tip.style.left = left + 'px';
              tip.style.top  = top  + 'px';
            }

            // ─── Draggable floating widget ─────────────────────────────────────
            // Lets the user grab #ct-toolbar-quota and reposition it anywhere in
            // the viewport. Position is persisted in localStorage so it survives
            // reloads/navigations, and re-clamped on resize so it can't end up
            // off-screen.
            (function initDraggable() {
              const STORAGE_KEY = 'ct-widget-pos';
              const DRAG_ID = 'ct-toolbar-quota';
              let dragEl = null, startX = 0, startY = 0, startLeft = 0, startTop = 0, moved = false;

              function clamp(el, left, top) {
                const maxLeft = window.innerWidth - el.offsetWidth - 4;
                const maxTop  = window.innerHeight - el.offsetHeight - 4;
                return {
                  left: Math.max(4, Math.min(left, Math.max(4, maxLeft))),
             top:  Math.max(4, Math.min(top,  Math.max(4, maxTop))),
                };
              }

              function placeAt(el, left, top) {
                const c = clamp(el, left, top);
                el.style.left   = c.left + 'px';
                el.style.top    = c.top  + 'px';
                el.style.right  = 'auto';
                el.style.bottom = 'auto';
                el.classList.add('ct-positioned');
              }

              function applyStoredPosition(el) {
                try {
                  const raw = localStorage.getItem(STORAGE_KEY);
                  if (!raw) return;
                  const pos = JSON.parse(raw);
                  if (typeof pos.left === 'number' && typeof pos.top === 'number') {
                    placeAt(el, pos.left, pos.top);
                  }
                } catch (_) { /* ignore malformed/missing stored position */ }
              }

              function currentLeftTop(el) {
                // getBoundingClientRect() reflects the *visual* (post-transform)
                // box, which is larger/smaller than the real layout box once the
                // widget has been resized. Reading the used left/top instead
                // keeps drag math anchored to the widget's actual position
                // rather than its scaled appearance.
                const cs = getComputedStyle(el);
                let left = parseFloat(cs.left);
                let top  = parseFloat(cs.top);
                if (isNaN(left) || isNaN(top)) {
                  const rect = el.getBoundingClientRect();
                  if (isNaN(left)) left = rect.left;
                  if (isNaN(top))  top  = rect.top;
                }
                return { left, top };
              }

              document.addEventListener('pointerdown', e => {
                if (e.button !== 0) return; // left click / primary touch only
                if (e.target.closest('.ct-resize-handle')) return; // handled by initResizable
                if (e.target.closest('.ct-collapse-toggle')) return; // handled by initCollapsible
                const el = e.target.closest('#' + DRAG_ID);
                if (!el) return;
                dragEl = el;
                moved = false;
                const pos = currentLeftTop(el);
                startX = e.clientX; startY = e.clientY;
                startLeft = pos.left; startTop = pos.top;
                el.classList.add('ct-dragging');
                if (el.setPointerCapture) {
                  try { el.setPointerCapture(e.pointerId); } catch (_) {}
                }
                e.preventDefault();
              });

              document.addEventListener('pointermove', e => {
                if (!dragEl) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) moved = true;
                if (!moved) return;
                placeAt(dragEl, startLeft + dx, startTop + dy);
              });

              function endDrag() {
                if (!dragEl) return;
                dragEl.classList.remove('ct-dragging');
                if (moved) {
                  const pos = currentLeftTop(dragEl);
                  try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: pos.left, top: pos.top }));
                  } catch (_) {}
                }
                dragEl = null;
              }
              document.addEventListener('pointerup', endDrag);
              document.addEventListener('pointercancel', endDrag);

              window.addEventListener('resize', () => {
                const el = document.getElementById(DRAG_ID);
                if (el && el.classList.contains('ct-positioned')) {
                  const pos = currentLeftTop(el);
                  placeAt(el, pos.left, pos.top);
                }
              });

              // The widget is created asynchronously by content.js, so keep
              // watching until it shows up (and re-apply if it's ever rebuilt).
              const tryApply = () => {
                const el = document.getElementById(DRAG_ID);
                if (el && !el.classList.contains('ct-positioned')) applyStoredPosition(el);
              };
                tryApply();
                new MutationObserver(tryApply).observe(document.documentElement, { childList: true, subtree: true });
            })();

            // ─── Resizable floating widget ─────────────────────────────────────
            // Grips in all four corners of #ct-toolbar-quota let the user scale
            // the whole card up or down, anchored at the corner OPPOSITE the one
            // being dragged (grab bottom-left -> top-right stays put, growth is
            // only down/left).
            //
            // Rather than toggling CSS transform-origin per corner (which snaps
            // the box to a new anchor the instant you switch corners, even
            // before the mouse moves — the "teleport" bug), transform-origin is
            // fixed at 0 0 permanently and every corner's anchoring is expressed
            // instead as an explicit `translate(tx, ty) scale(s)`. At the start
            // of every drag, tx/ty/s are read from whatever is CURRENTLY applied
            // (not recomputed from a clean slate), so the very first frame of a
            // drag always renders identically to the frame before it — no jump,
            // no matter which corner was used last. Position (left/top) is never
            // touched here; only the drag-to-move logic above does that.
            (function initResizable() {
              const STORAGE_KEY = 'ct-widget-scale';
              const DRAG_ID = 'ct-toolbar-quota';
              const HANDLE_CLASS = 'ct-resize-handle';
              const MIN_SCALE = 0.7, MAX_SCALE = 1.6, DEFAULT_SCALE = 1;
              // How much scale change one pixel of drag distance produces.
              // Small on purpose so a normal drag feels gradual, not explosive.
              const SENSITIVITY = 220;

              // Per-corner sign for turning mouse movement into "grow" vs
              // "shrink" — positive means dragging away from the anchored
              // opposite corner.
              const CORNER_SIGN = {
                br: { x: 1,  y: 1  },
                bl: { x: -1, y: 1  },
                tr: { x: 1,  y: -1 },
                tl: { x: -1, y: -1 },
              };
              // Anchor point for each handle, as a fraction of the widget's own
              // (unscaled) width/height — i.e. the corner that stays fixed while
              // that handle is dragged.
              const CORNER_ANCHOR = {
                br: { x: 0, y: 0 }, // dragging br anchors top-left
                bl: { x: 1, y: 0 }, // dragging bl anchors top-right
                tr: { x: 0, y: 1 }, // dragging tr anchors bottom-left
                tl: { x: 1, y: 1 }, // dragging tl anchors bottom-right
              };

              let resizeEl = null, startX = 0, startY = 0, sign = CORNER_SIGN.br;
              let startScale = DEFAULT_SCALE, startTx = 0, startTy = 0, anchorX = 0, anchorY = 0;

              // Reads whatever translate()/scale() is currently applied (if
              // none is set yet, that's equivalent to translate(0,0) scale(1)).
              function readTransform(el) {
                const t = el.style.transform || '';
                const mTranslate = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(t);
                const mScale = /scale\(\s*([\d.]+)\s*\)/.exec(t);
                return {
                  tx: mTranslate ? parseFloat(mTranslate[1]) : 0,
             ty: mTranslate ? parseFloat(mTranslate[2]) : 0,
             s: mScale ? parseFloat(mScale[1]) : DEFAULT_SCALE,
                };
              }

              function writeTransform(el, tx, ty, s) {
                el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
                el.dataset.ctScaled = '1';
              }

              function resetScale(el) {
                el.style.transform = '';
                delete el.dataset.ctScaled;
                try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
              }

              function applyStoredScale(el) {
                try {
                  const raw = localStorage.getItem(STORAGE_KEY);
                  if (!raw) return;
                  const data = JSON.parse(raw);
                  if (typeof data.tx === 'number' && typeof data.ty === 'number' && typeof data.s === 'number') {
                    writeTransform(el, data.tx, data.ty, data.s);
                  }
                } catch (_) { /* ignore malformed/missing stored scale */ }
              }

              document.addEventListener('pointerdown', e => {
                if (e.button !== 0) return;
                const handle = e.target.closest('.' + HANDLE_CLASS);
                if (!handle) return;
                const el = document.getElementById(DRAG_ID);
                if (!el) return;
                const corner = handle.dataset.corner || 'br';
                const anchorFrac = CORNER_ANCHOR[corner] || CORNER_ANCHOR.br;
                const current = readTransform(el);

                resizeEl = el;
                startX = e.clientX; startY = e.clientY;
                sign = CORNER_SIGN[corner] || CORNER_SIGN.br;
                startScale = current.s;
                startTx = current.tx;
                startTy = current.ty;
                // Anchor point in the box's own unscaled coordinate space.
                // offsetWidth/Height reflect the layout (pre-transform) size,
                // so this stays correct no matter the current scale.
                anchorX = anchorFrac.x * el.offsetWidth;
                anchorY = anchorFrac.y * el.offsetHeight;

                el.classList.add('ct-resizing');
                if (handle.setPointerCapture) {
                  try { handle.setPointerCapture(e.pointerId); } catch (_) {}
                }
                e.preventDefault();
                e.stopPropagation(); // don't also trigger the drag-to-move handler
              });

              document.addEventListener('pointermove', e => {
                if (!resizeEl) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                const delta = (sign.x * dx + sign.y * dy) / 2;
                const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, startScale + delta / SENSITIVITY));
                // Keeps (anchorX, anchorY) fixed on screen as scale changes:
                // at scale === startScale this reduces exactly to
                // (startTx, startTy) — i.e. zero movement at drag start.
                const tx = startTx + (startScale - scale) * anchorX;
                const ty = startTy + (startScale - scale) * anchorY;
                writeTransform(resizeEl, tx, ty, scale);
              });

              function endResize() {
                if (!resizeEl) return;
                resizeEl.classList.remove('ct-resizing');
                try {
                  const t = readTransform(resizeEl);
                  localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
                } catch (_) {}
                resizeEl = null;
              }
              document.addEventListener('pointerup', endResize);
              document.addEventListener('pointercancel', endResize);

              document.addEventListener('dblclick', e => {
                const handle = e.target.closest('.' + HANDLE_CLASS);
                if (!handle) return;
                const el = document.getElementById(DRAG_ID);
                if (el) resetScale(el);
              });

                const tryApply = () => {
                  const el = document.getElementById(DRAG_ID);
                  if (el && !el.dataset.ctScaled) applyStoredScale(el);
                };
                  tryApply();
                  new MutationObserver(tryApply).observe(document.documentElement, { childList: true, subtree: true });
            })();

            // ─── Collapsible widget metrics ────────────────────────────────────
            // A toggle in the widget header hides the 5h/7d metric rows down to
            // just the peak/off-peak pill, and remembers the choice for next
            // time via storageGet/storageSet (see the Storage helper section
            // below the theme detector — chrome.storage.local when reachable,
            // localStorage otherwise).
            (function initCollapsible() {
              const STORAGE_KEY = 'ct-widget-collapsed';
              const DRAG_ID = 'ct-toolbar-quota';
              const COLLAPSED_CLASS = 'ct-collapsed';

              function applyState(el, collapsed) {
                el.classList.toggle(COLLAPSED_CLASS, collapsed);
                const btn = el.querySelector('#ct-collapse-toggle');
                if (btn) {
                  btn.setAttribute('aria-expanded', String(!collapsed));
                  btn.setAttribute('data-ct-tip', tipAttr(collapsed ? 'expandWidgetTip' : 'collapseWidgetTip', collapsed ? 'Expand' : 'Collapse'));
                }
              }

              document.addEventListener('click', e => {
                const btn = e.target.closest('.ct-collapse-toggle');
                if (!btn) return;
                e.preventDefault();
                e.stopPropagation();
                const el = document.getElementById(DRAG_ID);
                if (!el) return;
                const collapsed = !el.classList.contains(COLLAPSED_CLASS);
                applyState(el, collapsed);
                storageSet(STORAGE_KEY, collapsed ? '1' : '0');
              });

              // The widget is created asynchronously by content.js, so keep
              // watching until it shows up (and re-apply if it's ever rebuilt).
              const tryApply = () => {
                const el = document.getElementById(DRAG_ID);
                if (el && !el.dataset.ctCollapseInit) {
                  el.dataset.ctCollapseInit = '1';
                  storageGet(STORAGE_KEY).then(val => applyState(el, val === '1'));
                }
              };
              tryApply();
              new MutationObserver(tryApply).observe(document.documentElement, { childList: true, subtree: true });
            })();

            // ─── One-time onboarding hint ──────────────────────────────────────
            // The floating quota widget is draggable and resizable, but nothing
            // about its appearance says so. The very first time it shows up in
            // the page, point a small bubble at it; once dismissed (or once the
            // user actually drags/resizes it, or after it's been on screen a
            // while) it is marked as seen and never shown again.
            //
            // The seen-flag is bridged through chrome.storage.local (see
            // bridge.js: 'cts_hint_seen' in its storage-read list, plus the
            // 'cts:storage:set' write proxy) rather than kept in this page's
            // own localStorage. This file runs in the MAIN world and has no
            // direct chrome.* access, but claude.ai clears its own localStorage
            // on logout as part of purging session state — a plain localStorage
            // flag here got wiped by that and made the hint reappear on every
            // fresh login. chrome.storage.local belongs to the extension, not
            // the page, so the site's own cleanup can't touch it.
            (async function initHintBubble() {
              const SEEN_KEY = 'cts_hint_seen';
              const DRAG_ID = 'ct-toolbar-quota';
              // Widget's own show transition (see #ct-toolbar-quota.vis) is
              // 0.35s. Waiting past that before we measure its position means
              // we never grab a rect mid-transition, which was the source of
              // the bubble appearing to "lag" or jump right after showing up.
              const SETTLE_DELAY = 450;
              const GAP = 10;

              // bridge.js stamps document.documentElement.dataset.ctsstorage
              // once its (async) chrome.storage.local.get resolves. That can
              // land after this script has already started running, so poll
              // briefly for it rather than assuming it's there on first check.
              async function readSeenFlag() {
                const POLL_INTERVAL = 30;
                const POLL_TIMEOUT = 2000;
                const start = Date.now();
                while (Date.now() - start < POLL_TIMEOUT) {
                  const raw = document.documentElement.dataset.ctsstorage;
                  if (raw !== undefined) {
                    try { return JSON.parse(raw)[SEEN_KEY] === true; }
                    catch (_) { return false; }
                  }
                  await new Promise(r => setTimeout(r, POLL_INTERVAL));
                }
                // Bridge never showed up (e.g. chrome.storage unreachable for
                // some reason) — fail open rather than silently never showing
                // the hint at all.
                return false;
              }

              let alreadySeen = true;
              try { alreadySeen = await readSeenFlag(); } catch (_) { alreadySeen = true; }
              if (alreadySeen) return;

              let armed = false; // widget found + visible, waiting to show
              let shown = false;

              function markSeen() {
                try {
                  document.dispatchEvent(new CustomEvent('cts:storage:set', {
                    detail: { [SEEN_KEY]: true }
                  }));
                } catch (_) {}
              }

              function dismiss(bubble, widget) {
                if (!bubble || bubble.dataset.ctDismissed) return;
                bubble.dataset.ctDismissed = '1';
                bubble.classList.remove('vis');
                if (widget) widget.classList.remove('ct-hint-pulse');
                markSeen();
                setTimeout(() => bubble.remove(), 400);
              }

              function showHint(widget) {
                if (shown) return;
                shown = true;

                const bubble = document.createElement('div');
                bubble.id = 'ct-hint';
                bubble.innerHTML = `
                <div id="ct-hint-arrow"></div>
                <div id="ct-hint-close" role="button" aria-label="Dismiss">\u2715</div>
                <div id="ct-hint-title"><span id="ct-hint-icon">\u270b</span>${withFallback('hintTitle', 'You can move this')}</div>
                <div id="ct-hint-body">${withFallback('hintBody', 'Drag it anywhere on screen, or grab a corner to resize.')}</div>
                `;
                // Start fully hidden and un-transitioned so the very first
                // position() below never gets animated to — only the later
                // class toggle (after layout has settled) triggers the
                // fade/rise transition, keeping the entrance smooth.
                bubble.style.visibility = 'hidden';
                document.body.appendChild(bubble);

                // Positions the bubble under the widget by default. If there
                // isn't enough room below (e.g. narrow-viewport layout where
                // the widget docks near the bottom of the screen), it flips
                // to sit above instead — it never overlaps the widget.
                function position() {
                  const r = widget.getBoundingClientRect();
                  const bw = bubble.offsetWidth || 220;
                  const bh = bubble.offsetHeight || 72;
                  const fitsBelow = r.bottom + GAP + bh + 8 <= window.innerHeight;

                  let top = fitsBelow ? r.bottom + GAP : r.top - GAP - bh;
                  let left = Math.max(8, Math.min(r.right - bw, window.innerWidth - bw - 8));

                  bubble.classList.toggle('ct-hint-above', !fitsBelow);
                  bubble.style.top  = top + 'px';
                  bubble.style.left = left + 'px';
                }

                position();
                bubble.style.visibility = '';

                // Two rAFs: the first lets the browser paint the bubble in
                // its pre-transition (invisible) state, the second then
                // flips the class so the opacity/transform change is always
                // picked up as an animated transition, never an instant pop.
                requestAnimationFrame(() => {
                  position();
                  requestAnimationFrame(() => {
                    bubble.classList.add('vis');
                    widget.classList.add('ct-hint-pulse');

                    // Start the idle "bob" loop only once the entrance
                    // transition has actually finished, not the instant
                    // .vis is added. Starting a CSS animation on `transform`
                    // while a transition on `transform` is still mid-flight
                    // makes the browser cut the transition short and snap
                    // to its end state — that was the "laggy"/non-smooth pop.
                    let bobStarted = false;
                    const startBob = () => {
                      if (bobStarted) return;
                      bobStarted = true;
                      bubble.classList.add('ct-hint-bob-active');
                    };
                    bubble.addEventListener('transitionend', function onEnd(e) {
                      if (e.target !== bubble || e.propertyName !== 'transform') return;
                      bubble.removeEventListener('transitionend', onEnd);
                      startBob();
                    });
                    // Safety net in case transitionend never fires (tab
                    // backgrounded, reduced-motion overrides, etc).
                    setTimeout(startBob, 550);
                  });
                });

                window.addEventListener('resize', position);

                bubble.querySelector('#ct-hint-close').addEventListener('click', e => {
                  e.stopPropagation();
                  dismiss(bubble, widget);
                });

                // Interacting with the widget itself (dragging or resizing)
                // counts as "got it" and dismisses the hint immediately.
                widget.addEventListener('pointerdown', () => dismiss(bubble, widget), { once: true });

                // Otherwise fade it out on its own after a few seconds so it
                // never lingers and gets in the way.
                setTimeout(() => dismiss(bubble, widget), 8000);
              }

              const tryShow = () => {
                if (armed) return;
                const el = document.getElementById(DRAG_ID);
                // Wait until the widget itself has finished announcing its
                // own entrance (the .vis class content.js/this module adds
                // once it's ready) before arming the settle timer — showing
                // the hint while the widget is still fading/scaling in was
                // the other half of the "laggy" feel.
                if (!el || !el.classList.contains('vis')) return;
                armed = true;
                observer.disconnect();
                setTimeout(() => showHint(el), SETTLE_DELAY);
              };
              const observer = new MutationObserver(tryShow);
              tryShow();
              if (!armed) {
                observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
              }
            })();
      },

      buildQuotaContainer() {
        const el = document.createElement('div');
        el.id = 'ct-quota';
        el.innerHTML = `
        <div class="ct-quota-row">
        <div class="ct-quota-header" data-ct-tip="${tipAttr('quota5hTip')}">
        <span>${i18n('quota5hLabel')}</span>
        </div>
        <div class="ct-progress-wrap">
        <div class="ct-progress-bg"><div id="ct-fill-5h" class="ct-progress-fill"></div></div>
        <span class="ct-bar-pct" id="ct-bar-pct-5h">0%</span>
        </div>
        <div class="ct-quota-footer"><span>${i18n('quotaResetsIn')}</span><span id="ct-tr5h">\u2014</span></div>
        </div>
        <div class="ct-quota-row">
        <div class="ct-quota-header" data-ct-tip="${tipAttr('quota7dTip')}">
        <span>${i18n('quota7dLabel')}</span>
        </div>
        <div class="ct-progress-wrap">
        <div class="ct-progress-bg"><div id="ct-fill-7d" class="ct-progress-fill"></div></div>
        <span class="ct-bar-pct" id="ct-bar-pct-7d">0%</span>
        </div>
        <div class="ct-quota-footer"><span>${i18n('quotaResetsIn')}</span><span id="ct-tr7d">\u2014</span></div>
        </div>
        `;
        return el;
      },

      buildComposerRow() {
        const row = document.createElement('div');
        row.id = 'ct-row';
        row.innerHTML = `
        <div id="ct-row-left">
        <div class="ct-pill" id="ct-p-ctx" data-ct-tip="${tipAttr('ctxPillTip')}">
        <span class="ct-pill-dot"></span><span id="ct-p-ctx-t">${i18n('ctxPillLabel')}</span>
        </div>
        <div class="ct-pill" id="ct-p-spd" style="display:none" data-ct-tip="${tipAttr('spdPillTip')}">
        <span class="ct-pill-dot"></span><span id="ct-p-spd-t">\u2014</span>
        </div>
        <div class="ct-pill ct-stat-pill" id="ct-p-turns" style="display:none" data-ct-tip="${tipAttr('turnsPillTip')}">
        <span class="ct-pill-dot"></span><span id="ct-p-turns-t">\u2014</span>
        </div>
        <div class="ct-pill ct-stat-pill" id="ct-p-cost" style="display:none" data-ct-tip="${tipAttr('costPillTip')}">
        <span class="ct-pill-dot"></span><span id="ct-p-cost-t">\u2014</span>
        </div>
        <div class="ct-pill ct-stat-pill" id="ct-p-lat" style="display:none" data-ct-tip="${tipAttr('latPillTip')}">
        <span class="ct-pill-dot"></span><span id="ct-p-lat-t">\u2014</span>
        </div>
        </div>
        <div id="ct-row-right"></div>
        `;

        return row;
      },

      buildGhost() {
        const g = document.createElement('div');
        g.id = 'ct-ghost';
        g.innerHTML = `
        <div class="ct-ghost-item" id="ct-g-turns" style="display:none">${i18n('ghostTurns')}&nbsp;<b id="ct-g-tv">0</b></div>
        <div class="ct-ghost-item" id="ct-g-cost"  style="display:none">${i18n('ghostCost')}&nbsp;<b id="ct-g-cv">\u2014</b></div>
        <div class="ct-ghost-item" id="ct-g-lat"   style="display:none">${i18n('ghostLatency')}&nbsp;<b id="ct-g-lv">\u2014</b></div>
        `;
        return g;
      },

      updateQuotaBars(win, pct, ts) {
        const fillEl = document.getElementById(`ct-fill-${win}`);
        const barPct = document.getElementById(`ct-bar-pct-${win}`);
        if (fillEl) fillEl.style.width = pct + '%';
        if (barPct) barPct.textContent  = pct + '%';

        const tFill = document.getElementById(`ct-tq-fill-${win}`);
        const tPct  = document.getElementById(`ct-tq-pct-${win}`);
        if (tFill) tFill.style.width = pct + '%';
        if (tPct)  tPct.textContent  = pct + '%';
      },

      buildToolbarQuota() {
        const el = document.createElement('div');
        el.id = 'ct-toolbar-quota';
        el.innerHTML = `
        <div id="ct-tq-header">
        <div id="ct-peak" class="offpeak" data-ct-tip="${tipAttr('peakTip')}"><span class="ct-peak-dot"></span><span id="ct-peak-t">${i18n('offPeakText')}</span></div>
        <button type="button" id="ct-collapse-toggle" class="ct-collapse-toggle" aria-expanded="true" data-ct-tip="${tipAttr('collapseWidgetTip', 'Collapse')}">
        <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        </button>
        </div>
        <span class="ct-tq-sep">\u00b7</span>
        <div class="ct-tq-block" data-ct-tip="${tipAttr('toolbar5hTip')}">
        <span class="ct-tq-label">5h</span>
        <div class="ct-tq-bar">
        <div id="ct-tq-fill-5h" class="ct-tq-fill"></div>
        </div>
        <span class="ct-tq-pct" id="ct-tq-pct-5h">0%</span>
        <span class="ct-tq-reset" id="ct-tq-tr-5h"></span>
        </div>
        <span class="ct-tq-sep">\u00b7</span>
        <div class="ct-tq-block" data-ct-tip="${tipAttr('toolbar7dTip')}">
        <span class="ct-tq-label">7d</span>
        <div class="ct-tq-bar"><div id="ct-tq-fill-7d" class="ct-tq-fill"></div></div>
        <span class="ct-tq-pct" id="ct-tq-pct-7d">0%</span>
        <span class="ct-tq-reset" id="ct-tq-tr-7d"></span>
        </div>
        <div class="ct-resize-handle" data-corner="tl" title="Drag to resize \u2022 double-click to reset"></div>
        <div class="ct-resize-handle" data-corner="tr" title="Drag to resize \u2022 double-click to reset"></div>
        <div class="ct-resize-handle" data-corner="bl" title="Drag to resize \u2022 double-click to reset"></div>
        <div class="ct-resize-handle" data-corner="br" title="Drag to resize \u2022 double-click to reset"></div>
        `;
        return el;
      },

      renderChips(lastMessageNode, chipsData, cached) {
        if (!lastMessageNode || lastMessageNode.querySelector('.ct-chips')) return;
        const container = document.createElement('div');
        container.className = 'ct-chips';

        if (chipsData.latMs != null) {
          const item = document.createElement('div');
          item.className = 'ct-chip ' + (chipsData.latMs < 800 ? 'fast' : chipsData.latMs > 2000 ? 'slow' : '');
          item.textContent = `\u23f1\ufe0f ${chipsData.latMs}ms`;
          container.appendChild(item);
        }
        if (chipsData.tps != null) {
          const item = document.createElement('div');
          item.className = 'ct-chip';
          item.textContent = `\u26a1 ${chipsData.tps} t/s`;
          container.appendChild(item);
        }
        if (chipsData.outputTok != null) {
          const item = document.createElement('div');
          item.className = 'ct-chip';
          item.textContent = `#\ufe0f\u20e3 ${chipsData.outputTok} ${i18n('chipOut')}`;
          container.appendChild(item);
        }
        if (cached) {
          const item = document.createElement('div');
          item.className = 'ct-chip cached';
          item.textContent = `\ud83d\udcbe ${i18n('chipCached')}`;
          container.appendChild(item);
        }
        if (chipsData.stopReason && chipsData.stopReason !== '\u2014' && chipsData.stopReason !== 'end_turn') {
          const item = document.createElement('div');
          item.className = 'ct-chip maxed';
          item.textContent = `\ud83d\uded1 ${i18n('chipLimitHit')}`;
          container.appendChild(item);
        }

        const insertionPoint =
        lastMessageNode.querySelector('[class*="prose"]') ||
        lastMessageNode.querySelector('p:last-of-type') ||
        lastMessageNode;
        insertionPoint.insertAdjacentElement('afterend', container);
      },

    };

})();
