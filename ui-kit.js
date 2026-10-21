/**
 * Shared UI toolkit for the 6.0 surfaces (ISOLATED world). Everything is drawn
 * in shadow roots using theme.js tokens plus palette/density overrides, and is
 * built with createElement/textContent only: conversation text is untrusted and
 * is never parsed as HTML.
 *
 * - CTS_UI.T(key, subs?) -> string: chrome.i18n lookup, falls back to the key
 * - CTS_UI.h(tag, props, ...children) -> Element: props {class, text, on:{evt:fn}, any attribute}
 * - CTS_UI.svg(string) -> Element: parses chart SVG with DOMParser (no innerHTML)
 * - CTS_UI.mount(id, extraCss) -> {host, root}: closed shadow root on documentElement with tokens, palette, density
 * - CTS_UI.applyLook(host) -> void: palette/density/reduced-motion from settings; custom palette/density only while the plan includes 'themes' (Pro)
 * - CTS_UI.PALETTES, CTS_UI.contrast(fg, bg) -> number (WCAG ratio)
 * - CTS_UI.toast({text, actions:[{label,onClick}], timeoutMs, id}) -> boolean: never stacks; false if another toast is showing
 * - CTS_UI.isCalm() -> boolean: not typing in the composer and no reply streaming
 * - CTS_UI.fmt: {date, dateTime, bytes, num, relReset}
 *
 * @requires safe.js, features.js, theme.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe;

  const T = (key, subs) => {
    try { return chrome.i18n.getMessage(key, subs) || key; } catch (e) { Safe.run('ui', () => { throw e; }); return key; }
  };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    Object.keys(props || {}).forEach(k => {
      const v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') Object.keys(v).forEach(ev => el.addEventListener(ev, Safe.wrap('ui', v[ev])));
      else if (/^on|html$/i.test(k)) return; // no inline handlers, no HTML strings
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    kids.flat().forEach(c => { if (c != null && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  function svg(str) {
    const doc = new DOMParser().parseFromString(str, 'image/svg+xml');
    return document.importNode(doc.documentElement, true);
  }

  // ─── Palettes (accent family only; surfaces come from theme.js) ───────────
  // 'warm' is theme.js's own set. Others override the button/accent colours.
  const PALETTES = {
    warm:   { light: { btn: '#B9573A', onBtn: '#FFFFFF', accent: '#C6613F', bg: '#F5F4EE', text: '#1F1E1D', muted: '#66645C' },
              dark:  { btn: '#D97757', onBtn: '#1F1E1D', accent: '#D97757', bg: '#1F1E1D', text: '#FAF9F5', muted: '#B5B2A8' } },
    ocean:  { light: { btn: '#2B6595', onBtn: '#FFFFFF', accent: '#2B6595' }, dark: { btn: '#7DB1DE', onBtn: '#10202D', accent: '#7DB1DE' } },
    forest: { light: { btn: '#3B7248', onBtn: '#FFFFFF', accent: '#3B7248' }, dark: { btn: '#86C595', onBtn: '#12251A', accent: '#86C595' } },
    mono:   { light: { btn: '#3A3A38', onBtn: '#FFFFFF', accent: '#3A3A38' }, dark: { btn: '#D8D6CF', onBtn: '#1F1E1D', accent: '#D8D6CF' } },
  };

  function lum(hex) {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  const paletteCss = Object.keys(PALETTES).filter(k => k !== 'warm').map(k => {
    const p = PALETTES[k];
    return `:host([data-palette="${k}"]){--btn:${p.light.btn};--btn-hover:${p.light.btn};--on-btn:${p.light.onBtn};--accent:${p.light.accent}}
:host([data-palette="${k}"][data-theme="dark"]){--btn:${p.dark.btn};--btn-hover:${p.dark.btn};--on-btn:${p.dark.onBtn};--accent:${p.dark.accent}}`;
  }).join('\n');

  const BASE_CSS = `
    :host { all: initial; font-family: var(--sans); color: var(--text); font-size: 13px; line-height: 1.45; --pad: 12px; --gap: 10px; }
    :host([data-density="compact"]) { --pad: 8px; --gap: 6px; font-size: 12px; }
    *, *::before, *::after { box-sizing: border-box; }
    button, input, select, textarea { font: inherit; color: inherit; }
    :focus-visible { outline: 2px solid var(--btn); outline-offset: 2px; }
    .btn { background: var(--btn); color: var(--on-btn); border: 0; border-radius: 8px; padding: 6px 12px; cursor: pointer; min-height: 30px; }
    .btn:hover { filter: brightness(1.06); }
    .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); }
    .btn.small { padding: 3px 8px; min-height: 24px; font-size: 12px; }
    .btn[disabled] { opacity: .5; cursor: default; }
    input[type=text], input[type=search], input[type=number], input[type=date], select, textarea { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; min-height: 30px; }
    .muted { color: var(--muted); }
    .row.end { justify-content: flex-end; margin-block-start: 10px; }
    .row { display: flex; gap: var(--gap); align-items: center; flex-wrap: wrap; }
    .grow { flex: 1 1 auto; min-width: 0; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: var(--pad); margin-block: var(--gap); }
    h3 { font-family: var(--serif); font-weight: 400; font-size: 15px; margin: 0 0 6px; }
    .bar { height: 8px; background: var(--surface); border-radius: 4px; overflow: hidden; }
    .bar > i { display: block; height: 100%; background: var(--btn); }
    ul.list { list-style: none; margin: 0; padding: 0; }
    @media (prefers-reduced-motion: no-preference) { .fade { animation: fade .18s ease-out; } @keyframes fade { from { opacity: 0; transform: translateY(4px); } } }
    ${paletteCss}
  `;

  function applyLook(host) {
    const f = window.CTS_Features;
    const p = f.getSetting('theme.palette', 'auto'), d = f.getSetting('theme.density', 'regular');
    const lic = window.CTS_License;
    const on = f.isEnabled('themes') && (!lic || lic.allows('themes'));
    host.setAttribute('data-palette', on && PALETTES[p] ? p : 'warm');
    host.setAttribute('data-density', on && d === 'compact' ? 'compact' : 'regular');
  }

  function mount(id, extraCss) {
    const host = document.createElement('div');
    host.id = id;
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = window.CTS_Theme.TOKENS + BASE_CSS + (extraCss || '');
    root.appendChild(style);
    window.CTS_Theme.attach(host);
    applyLook(host);
    window.CTS_Features.onChange(() => applyLook(host));
    return { host, root };
  }

  // ─── Calm moment ──────────────────────────────────────────────────────────
  let lastKeyAt = 0;
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) lastKeyAt = Date.now();
  }, true);
  const isStreaming = () => document.documentElement.dataset.ctsStream === '1';
  const isCalm = () => !isStreaming() && Date.now() - lastKeyAt > 3000;

  // ─── Toast (single slot) ──────────────────────────────────────────────────
  let toastState = null;
  function toast(o) {
    if (toastState) return false;
    const m = mount('cts-toast-host', `
      .t { position: fixed; inset-block-end: 20px; inset-inline-end: 20px; max-width: min(380px, calc(100vw - 40px)); z-index: 2147483000;
           background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; box-shadow: var(--shadow); }
      .t p { margin: 0 0 8px; } .t .row { justify-content: flex-end; }`);
    const close = () => { if (toastState) { clearTimeout(toastState.timer); toastState.host.remove(); toastState = null; } if (o.onClose) Safe.run('ui', o.onClose); };
    const box = h('div', { class: 't fade', role: 'status', 'aria-live': 'polite' },
      h('p', { text: o.text }),
      h('div', { class: 'row' }, (o.actions || []).map(a => h('button', { class: 'btn small' + (a.ghost ? ' ghost' : ''), type: 'button', text: a.label, on: { click: () => { close(); if (a.onClick) a.onClick(); } } })),
        h('button', { class: 'btn small ghost', type: 'button', text: T('dismiss'), on: { click: close } })));
    m.root.appendChild(box);
    document.documentElement.appendChild(m.host);
    toastState = { host: m.host, timer: o.timeoutMs ? setTimeout(close, o.timeoutMs) : 0 };
    return true;
  }
  const toastVisible = () => !!toastState;

  // ─── Formatting ───────────────────────────────────────────────────────────
  const lang = () => { try { return chrome.i18n.getUILanguage(); } catch (_) { return undefined; } };
  const fmt = {
    date: t => new Date(t).toLocaleDateString(lang(), { year: 'numeric', month: 'short', day: 'numeric' }),
    dateTime: t => new Date(t).toLocaleString(lang(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    num: n => Number(n).toLocaleString(lang()),
    bytes: n => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'),
  };

  window.CTS_UI = { T, h, svg, mount, applyLook, PALETTES, contrast, toast, toastVisible, isCalm, isStreaming, fmt };
  if (typeof module !== 'undefined') module.exports = window.CTS_UI;
})();
