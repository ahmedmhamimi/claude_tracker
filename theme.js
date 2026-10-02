/**
 * Shared look for TokenLens's own surfaces (welcome splash, review card).
 *
 * Runs in the ISOLATED world and exposes window.CTS_Theme to the other
 * isolated-world scripts (welcome.js, review.js). Everything drawn here lives
 * in a shadow root, so claude.ai's CSS can't touch it and ours can't leak.
 *
 * The palette is deliberately Claude-adjacent: warm paper neutrals, one
 * terracotta accent, an editorial serif for headlines and the system sans for
 * UI text. It follows claude.ai's light/dark mode so the surfaces never look
 * like a foreign object dropped on the page.
 */

(function () {
  'use strict';

  const TOKENS = `
    :host {
      --bg: #F5F4EE;
      --card: #FAF9F5;
      --surface: #EDEAE0;
      --line: rgba(31, 30, 29, .14);
      --tick: #D9D4C6;
      --text: #1F1E1D;
      --muted: #66645C;
      --accent: #C6613F;
      --btn: #B9573A;
      --btn-hover: #A84C30;
      --on-btn: #FFFFFF;
      --star: #CD6744;
      --star-off: #D6D1C3;
      --shadow: 0 1px 2px rgba(31, 30, 29, .06), 0 18px 40px -12px rgba(31, 30, 29, .22);
      --serif: 'TokenLens Serif', 'Iowan Old Style', 'Palatino Linotype', Georgia, 'Noto Serif', 'Noto Serif CJK JP', 'Noto Serif CJK SC', serif;
      --sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Hiragino Sans', 'Noto Sans CJK JP', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    }
    :host([data-theme="dark"]) {
      --bg: #1F1E1D;
      --card: #2B2A28;
      --surface: #353430;
      --line: rgba(250, 249, 245, .14);
      --tick: #46443F;
      --text: #FAF9F5;
      --muted: #B7B4A8;
      --accent: #D97757;
      --btn: #D97757;
      --btn-hover: #E58A6C;
      --on-btn: #1F1E1D;
      --star: #D97757;
      --star-off: #4A4844;
      --shadow: 0 1px 2px rgba(0, 0, 0, .3), 0 18px 40px -12px rgba(0, 0, 0, .6);
    }
  `;

  function isDark() {
    const r = document.documentElement;
    const mode = (r.dataset.mode || '').toLowerCase();
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    if (r.classList.contains('dark')) return true;
    if (r.classList.contains('light')) return false;
    return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // Keeps host[data-theme] in step with claude.ai's mode. Returns a disposer.
  function attach(host) {
    const apply = () => host.setAttribute('data-theme', isDark() ? 'dark' : 'light');
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode', 'data-theme'] });
    const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
    if (mq && mq.addEventListener) mq.addEventListener('change', apply);
    return () => {
      mo.disconnect();
      if (mq && mq.removeEventListener) mq.removeEventListener('change', apply);
    };
  }

  // Editorial serif, bundled (SIL OFL). @font-face doesn't register from inside
  // a shadow root, so the faces go on the document via the FontFace API.
  let _fonts = null;
  function loadFonts() {
    if (_fonts) return _fonts;
    const faces = [
      ['normal', 'fonts/newsreader-latin-400-normal.woff2'],
      ['italic', 'fonts/newsreader-latin-400-italic.woff2'],
    ];
    _fonts = Promise.race([
      Promise.all(faces.map(async ([style, path]) => {
        const face = new FontFace('TokenLens Serif', `url(${chrome.runtime.getURL(path)})`, { style, weight: '400' });
        await face.load();
        document.fonts.add(face);
      })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('font timeout')), 1500)),
    ]).catch(() => { /* system serif fallback is already in the stack */ });
    return _fonts;
  }

  // The TokenLens mark: a small ring of ticks, most of them lit.
  function mark(size, lit) {
    const total = 12, on = lit == null ? 9 : lit;
    let s = '';
    for (let i = 0; i < total; i++) {
      s += `<line x1="0" y1="-11" x2="0" y2="-${i % 3 === 0 ? 7 : 8.2}" stroke="${i < on ? 'var(--accent)' : 'var(--tick)'}" stroke-width="2" stroke-linecap="round" transform="rotate(${i * 30})"/>`;
    }
    return `<svg width="${size}" height="${size}" viewBox="-12 -12 24 24" aria-hidden="true" style="display:block">${s}</svg>`;
  }

  window.CTS_Theme = { TOKENS, isDark, attach, loadFonts, mark };
})();
