/**
 * First-run welcome splash. Shown exactly once, right after a fresh install.
 *
 * Runs in the ISOLATED world (it needs chrome.storage / chrome.i18n and the
 * extension's bundled font) and draws inside a shadow root so claude.ai's CSS
 * can't touch it and ours can't leak out.
 *
 * Flow:
 *   background.js sets cts_show_welcome = true on install and opens Claude.
 *   This script waits until the app UI is actually on screen (the MAIN-world
 *   widget #ct-toolbar-quota exists and the tab is visible), claims the flag so
 *   only one tab ever shows it, plays the sequence, and on close hands focus to
 *   the message box and pulses the real widget.
 *
 * While the splash is up, <html data-cts-welcome="active">; when it is gone
 * (or was never going to show) it is "done". ui.js holds its drag-hint bubble
 * until then.
 */

(function () {
  'use strict';

  if (window.top !== window) return;

  const ROOT = document.documentElement;
  const finish = () => { ROOT.dataset.ctsWelcome = 'done'; };
  const t = (key, fallback) => {
    try { return chrome.i18n.getMessage(key) || fallback; } catch (_) { return fallback; }
  };

  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isCJK = /^(ja|zh)/i.test((() => { try { return chrome.i18n.getUILanguage(); } catch (_) { return 'en'; } })());

  const TICKS = 60;          // 5 hours x 12 marks (one every 5 minutes)
  const MAJOR_EVERY = 12;    // a long mark at every hour

  // ─── Gate: only when flagged, and only when the app is really on screen ─────

  let cancelled = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cts_show_welcome && changes.cts_show_welcome.newValue === false) {
      cancelled = true;
    }
  });

  chrome.storage.local.get(['cts_show_welcome'], ({ cts_show_welcome }) => {
    if (cts_show_welcome !== true) return finish();
    waitForApp().then(claimAndShow);
  });

  function waitForApp() {
    const ready = () =>
      document.visibilityState === 'visible' &&
      !!document.getElementById('ct-toolbar-quota') &&
      !/^\/(login|signin|sign-in|signup|sign-up|auth|logout|oauth)(\/|$)/i.test(location.pathname);

    return new Promise(resolve => {
      if (ready()) return resolve();
      const iv = setInterval(() => {
        if (cancelled) { clearInterval(iv); return; }
        if (ready()) { clearInterval(iv); resolve(); }
      }, 400);
    });
  }

  function claimAndShow() {
    if (cancelled) return finish();
    // Re-read, then clear the flag before showing: if two tabs race, whichever
    // writes first wins and the other sees false.
    chrome.storage.local.get(['cts_show_welcome'], ({ cts_show_welcome }) => {
      if (cts_show_welcome !== true) return finish();
      chrome.storage.local.set({ cts_show_welcome: false, cts_welcome_seen: true }, show);
    });
  }

  // ─── Live usage (the number inside the lens) ────────────────────────────────

  // Resolves with the % of the 5-hour window still left, or null if no reading
  // lands within `timeoutMs`. The MAIN-world code writes cts_5h_util as soon as
  // its first usage request succeeds, usually within a second or two.
  function waitForRemaining(timeoutMs) {
    const toRemaining = items => {
      if (typeof items.cts_5h_util !== 'number') return null;
      const ts = items.cts_ts_5h;
      const expired = ts != null && ts <= Math.floor(Date.now() / 1000);
      const used = expired ? 0 : items.cts_5h_util;
      return Math.max(0, Math.min(100, Math.round(100 - used)));
    };

    return new Promise(resolve => {
      let done = false;
      const settle = v => {
        if (done) return;
        done = true;
        chrome.storage.onChanged.removeListener(onChange);
        clearTimeout(timer);
        resolve(v);
      };
      const onChange = (changes, area) => {
        if (area !== 'local' || !changes.cts_5h_util) return;
        chrome.storage.local.get(['cts_5h_util', 'cts_ts_5h'], items => {
          const r = toRemaining(items);
          if (r != null) settle(r);
        });
      };
      const timer = setTimeout(() => settle(null), timeoutMs);
      chrome.storage.onChanged.addListener(onChange);
      chrome.storage.local.get(['cts_5h_util', 'cts_ts_5h'], items => {
        const r = toRemaining(items);
        if (r != null) settle(r);
      });
    });
  }

  // ─── Font ───────────────────────────────────────────────────────────────────
  // @font-face does not register from inside a shadow root, so the faces are
  // added to the document through the FontFace API under a private family name.

  async function loadFonts() {
    const faces = [
      ['normal', 'fonts/instrument-serif-latin-400-normal.woff2'],
      ['italic', 'fonts/instrument-serif-latin-400-italic.woff2'],
    ];
    try {
      await Promise.race([
        Promise.all(faces.map(async ([style, path]) => {
          const face = new FontFace('TokenLens Serif', `url(${chrome.runtime.getURL(path)})`, { style, weight: '400' });
          await face.load();
          document.fonts.add(face);
        })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('font timeout')), 1200)),
      ]);
    } catch (_) { /* fall back to the system serif stack */ }
  }

  // ─── Markup ─────────────────────────────────────────────────────────────────

  const CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; }

    .stage {
      --serif: 'TokenLens Serif', 'Iowan Old Style', 'Palatino Linotype', Georgia, 'Noto Serif', 'Noto Serif CJK JP', 'Noto Serif CJK SC', serif;
      --sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Hiragino Sans', 'Noto Sans CJK JP', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      --lens: clamp(210px, min(44vh, 78vw), 340px);
      position: fixed; inset: 0; overflow: auto;
      display: grid; place-items: center;
      padding: clamp(20px, 4vh, 48px) 24px;
      color: #FFF1DF;
      font-family: var(--sans);
      background: #0C1236;
      opacity: 0;
      transition: opacity .8s ease;
    }
    .stage.in { opacity: 1; }

    .sky {
      position: absolute; inset: 0;
      background: radial-gradient(90% 75% at 50% 36%, #223389 0%, #151F5C 52%, #0C1236 100%);
    }
    .dawn {
      position: absolute; left: -15%; right: -15%; bottom: -34%; height: 90%;
      background: radial-gradient(50% 56% at 50% 60%, rgba(255,152,84,.64) 0%, rgba(255,120,72,.28) 38%, rgba(255,120,72,0) 72%);
      transform: translateY(38%); opacity: 0;
      transition: transform 4.6s cubic-bezier(.16,.8,.2,1), opacity 2.6s ease;
    }
    .in .dawn { transform: none; opacity: 1; }

    main {
      position: relative; z-index: 1;
      display: flex; flex-direction: column; align-items: center;
      text-align: center; max-width: 42rem;
    }

    /* The lens: the one memorable thing. It starts out of focus and resolves. */
    .lens {
      position: relative; width: var(--lens); height: var(--lens);
      filter: blur(28px); opacity: 0; transform: scale(1.22);
      transition: filter 2s cubic-bezier(.2,.7,.2,1), opacity 1.3s ease, transform 2s cubic-bezier(.2,.7,.2,1);
    }
    .focus .lens { filter: blur(0); opacity: 1; transform: none; }
    .lens svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }

    .tick-dim { stroke: rgba(176,194,255,.24); stroke-linecap: round; fill: none; }
    .glow { filter: drop-shadow(0 0 5px rgba(255,160,92,.55)); }
    .tick-lit { stroke: var(--c); stroke-linecap: round; opacity: 0; transition: opacity .3s ease; }
    .tick-lit.on { opacity: 1; }

    .readout {
      position: absolute; inset: 0;
      display: grid; place-content: center; justify-items: center; gap: calc(var(--lens) * .015);
    }
    .num {
      font-family: var(--serif); font-weight: 400;
      font-size: calc(var(--lens) * .28); line-height: .9;
      letter-spacing: -.02em; color: #FFF4E6;
      font-variant-numeric: lining-nums tabular-nums;
    }
    .num .pc { font-size: .42em; margin-left: .04em; vertical-align: .62em; opacity: .85; }
    .cap {
      max-width: calc(var(--lens) * .5); text-wrap: balance;
      font-size: clamp(11px, calc(var(--lens) * .042), 14px); line-height: 1.3;
      color: rgba(224,232,255,.72);
    }

    .rise {
      opacity: 0; transform: translateY(14px); filter: blur(6px);
      transition: opacity .9s ease, transform .9s cubic-bezier(.2,.7,.2,1), filter .9s ease;
    }
    .show-h .r-h, .show-p .r-p, .show-b .r-b, .show-f .r-f { opacity: 1; transform: none; filter: none; }

    h1 {
      margin-top: clamp(18px, 3.6vh, 36px);
      font-family: var(--serif); font-weight: 400; font-style: italic;
      font-size: clamp(34px, 5.2vw, 64px); line-height: 1.05; letter-spacing: -.012em;
      color: #FFF1DF; max-width: 21ch; text-wrap: balance;
    }
    p.body {
      margin-top: 16px; max-width: 34em;
      font-size: clamp(15px, 1.5vw, 18px); line-height: 1.55;
      color: rgba(228,234,255,.8); text-wrap: pretty;
    }
    .go {
      margin-top: clamp(22px, 4vh, 34px);
      appearance: none; border: 0; cursor: pointer;
      padding: 15px 30px; border-radius: 999px;
      font: 600 16px/1 var(--sans); color: #1B2158;
      background: linear-gradient(180deg, #FFE8C6, #FFCF94);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.4), 0 10px 34px rgba(255,150,80,.38);
      transition: transform .25s ease, box-shadow .25s ease, opacity .9s ease, filter .9s ease;
    }
    .go.rise { transition: opacity .9s ease, transform .9s cubic-bezier(.2,.7,.2,1), filter .9s ease, box-shadow .25s ease; }
    .show-b .go:hover { transform: translateY(-2px); box-shadow: inset 0 0 0 1px rgba(255,255,255,.5), 0 14px 44px rgba(255,150,80,.5); }
    .go:focus { outline: none; }
    .kbd .go:focus-visible { outline: 2px solid #9DBBFF; outline-offset: 4px; }
    .fine { margin-top: 20px; font-size: 12.5px; color: rgba(205,216,255,.55); }

    .cjk h1 { font-style: normal; font-weight: 500; letter-spacing: 0; line-height: 1.3; max-width: 16em; font-size: clamp(28px, 4.2vw, 50px); word-break: keep-all; overflow-wrap: anywhere; }

    .stage.leaving {
      opacity: 0; transform: scale(1.05); filter: blur(10px);
      transition: opacity .55s ease, transform .55s ease, filter .55s ease;
    }

    .rm, .rm * { transition: none !important; animation: none !important; }
    .rm .rise { opacity: 1; transform: none; filter: none; }
    .rm .lens { filter: none; opacity: 1; transform: none; }
    .rm .dawn { transform: none; opacity: 1; }

    @media (max-height: 640px) {
      .fine { display: none; }
      h1 { font-size: clamp(28px, 4.6vw, 44px); }
    }
  `;

  function lerp(a, b, k) { return Math.round(a + (b - a) * k); }
  function tickColor(k) {   // ember -> candlelight across the ring
    return `rgb(${lerp(255, 255, k)}, ${lerp(150, 232, k)}, ${lerp(84, 190, k)})`;
  }

  function ringSVG() {
    let dim = '', lit = '';
    for (let i = 0; i < TICKS; i++) {
      const major = i % MAJOR_EVERY === 0;
      const len = major ? 24 : 12;
      const w = major ? 3.4 : 2.2;
      const line = (cls, extra) =>
        `<line class="${cls}" x1="0" y1="-152" x2="0" y2="${-(152 - len)}" stroke-width="${w}" transform="rotate(${i * 360 / TICKS})" ${extra || ''}/>`;
      dim += line('tick-dim');
      lit += line('tick-lit', `style="--c:${tickColor(i / (TICKS - 1))}"`);
    }
    return `
      <svg viewBox="-170 -170 340 340" aria-hidden="true">
        <defs>
          <radialGradient id="glass" cx="34%" cy="28%" r="82%">
            <stop offset="0" stop-color="#fff" stop-opacity=".17"/>
            <stop offset=".5" stop-color="#fff" stop-opacity=".04"/>
            <stop offset="1" stop-color="#fff" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <circle r="167" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="1"/>
        <g>${dim}</g>
        <g class="glow">${lit}</g>
        <circle r="116" fill="url(#glass)"/>
        <circle r="116" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="1.5"/>
        <path d="M -82 -62 A 102 102 0 0 1 -26 -98" fill="none" stroke="rgba(255,255,255,.42)" stroke-width="3" stroke-linecap="round"/>
      </svg>`;
  }

  // Japanese/Chinese have no spaces to break on: offer a break after each
  // sentence mark so a headline never splits in the middle of a phrase.
  function setHeadline(el, text) {
    if (!isCJK) { el.textContent = text; return; }
    text.split(/(?<=[。！？，、])/).forEach(part => {
      el.appendChild(document.createTextNode(part));
      el.appendChild(document.createElement('wbr'));
    });
  }

  // ─── Sequence ───────────────────────────────────────────────────────────────

  async function show() {
    ROOT.dataset.ctsWelcome = 'active';

    const host = document.createElement('div');
    host.id = 'cts-welcome-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>${CSS}</style>
      <div class="stage${isCJK ? ' cjk' : ''}${reduceMotion ? ' rm' : ''}" role="dialog" aria-modal="true" aria-labelledby="ttl">
        <div class="sky"></div>
        <div class="dawn"></div>
        <main>
          <div class="lens">
            ${ringSVG()}
            <div class="readout">
              <div class="num" id="num" aria-live="off"><span id="n">5h</span></div>
              <div class="cap" id="cap"></div>
            </div>
          </div>
          <h1 id="ttl" class="rise r-h"></h1>
          <p class="body rise r-p"></p>
          <button class="go rise r-b" type="button"></button>
          <p class="fine rise r-f"></p>
        </main>
      </div>`;

    const $ = sel => root.querySelector(sel);
    const stage = $('.stage');
    setHeadline($('#ttl'), t('welcomeTitle', 'Stay in your flow. We\u2019ll watch the clock.'));
    $('.body').textContent = t('welcomeBody', 'TokenLens shows how much of your 5-hour limit is left, right where you chat, so a limit never catches you off guard.');
    $('.go').textContent = t('welcomeCta', 'Start chatting');
    $('.fine').textContent = t('privacyLine', 'Runs only on claude.ai. Nothing leaves your browser.');
    $('#cap').textContent = t('welcomeWindow', 'your 5-hour window');

    const litTicks = Array.from(root.querySelectorAll('.tick-lit'));
    const startedAt = performance.now();

    // Fonts first, so the headline never flashes in a fallback face.
    await loadFonts();
    document.documentElement.appendChild(host);

    const button = $('.go');
    button.focus({ preventScroll: true });

    // Keep keyboard focus inside the splash and let Esc close it.
    const onKey = e => {
      stage.classList.add('kbd');
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'Tab') { e.preventDefault(); button.focus(); }
    };
    document.addEventListener('keydown', onKey, true);

    let closing = false;
    function close() {
      if (closing) return;
      closing = true;
      document.removeEventListener('keydown', onKey, true);
      stage.classList.add('leaving');
      setTimeout(() => {
        host.remove();
        finish();
        handBack();
      }, reduceMotion ? 0 : 560);
    }
    button.addEventListener('click', close);

    // Begin: sky fades up, the lens starts to focus.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      stage.classList.add('in');
      setTimeout(() => stage.classList.add('focus'), 150);
    }));

    // Meanwhile wait (briefly) for the real number. Never hold the show for it.
    const remaining = await waitForRemaining(1600);
    const sinceStart = performance.now() - startedAt;
    if (!reduceMotion && sinceStart < 1000) await new Promise(r => setTimeout(r, 1000 - sinceStart));

    lightUp(remaining);

    const at = (ms, cls) => setTimeout(() => stage.classList.add(cls), reduceMotion ? 0 : ms);
    at(900,  'show-h');
    at(1500, 'show-p');
    at(2000, 'show-b');
    at(2500, 'show-f');

    function lightUp(rem) {
      const nEl = $('#n');
      const num = $('#num');
      if (rem == null) {
        // No reading yet (offline, or a brand-new account): light the whole ring
        // and name the window instead of inventing a number.
        litTicks.forEach((el, i) => setTimeout(() => el.classList.add('on'), reduceMotion ? 0 : i * 20));
        nEl.textContent = '5h';
        return;
      }
      $('#cap').textContent = t('welcomeLeft', 'of your 5-hour limit left');
      const count = rem === 0 ? 0 : Math.max(1, Math.round(rem / 100 * TICKS));
      litTicks.slice(0, count).forEach((el, i) =>
        setTimeout(() => el.classList.add('on'), reduceMotion ? 0 : i * 22));

      const pc = document.createElement('span');
      pc.className = 'pc';
      pc.textContent = '%';
      num.appendChild(pc);

      if (reduceMotion || rem === 0) { nEl.textContent = String(rem); return; }
      const dur = 1500, t0 = performance.now();
      const step = now => {
        const k = Math.min(1, (now - t0) / dur);
        nEl.textContent = String(Math.round(rem * (1 - Math.pow(1 - k, 3))));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }

  // After the splash: drop the person straight into the message box and point
  // at the real widget so the lens they just saw connects to something on screen.
  function handBack() {
    try {
      const box = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
      if (box) box.focus({ preventScroll: true });
    } catch (_) {}
    const widget = document.getElementById('ct-toolbar-quota');
    if (widget) {
      widget.classList.add('ct-hint-pulse');
      setTimeout(() => widget.classList.remove('ct-hint-pulse'), 6000);
    }
  }
})();
