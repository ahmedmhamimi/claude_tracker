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
    // bridge.js (ISOLATED world) and this MAIN-world bundle both run at
    // document_start with no guaranteed ordering, so the dataset attribute
    // may not exist yet on an early call. Only treat the cache as final once
    // it actually has keys in it — an empty read means "too early", not
    // "no translations exist", so we retry the parse on the next call
    // instead of locking in {} forever.
    if (!_i18nCache || !Object.keys(_i18nCache).length) {
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
  const tipAttr = key =>
  i18n(key).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

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

  #ct-toolbar-quota {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 0 10px; flex: 0 0 auto; overflow: visible;
  font-family: var(--ct-mono); font-size: 11px; font-weight: 700;
  color: var(--ct-muted); white-space: nowrap;
  pointer-events: auto;
  }
  .ct-tq-sep { opacity: 0.25; font-size: 10px; }
  .ct-tq-block {
    display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
  }
  @media (max-width: 768px) {
    #ct-toolbar-quota { gap: 6px; padding: 0 6px; }
    .ct-tq-block { flex-shrink: 1; gap: 4px; }
    .ct-tq-bar { width: 32px; }
    .ct-tq-reset { display: none; }
  }
  .ct-tq-label { color: var(--ct-muted); font-size: 10px; }
  .ct-tq-bar {
    width: 52px; height: 4px; border-radius: 2px;
    background: var(--ct-bg-progress); overflow: hidden; flex-shrink: 0;
  }
  .ct-tq-fill { height: 100%; width: 0%; border-radius: 2px; background: var(--ct-accent);
    transition: width 0.5s cubic-bezier(.4,0,.2,1); }
    .ct-tq-pct { font-size: 10px; color: var(--ct-muted); }
    .ct-tq-reset { font-size: 10px; color: var(--ct-muted); opacity: 0.6; }

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
        <div id="ct-peak" class="offpeak" data-ct-tip="${tipAttr('peakTip')}"><span class="ct-peak-dot"></span><span id="ct-peak-t">${i18n('offPeakText')}</span></div>
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
