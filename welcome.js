/**
 * First-run welcome splash. Shown exactly once, right after a fresh install.
 *
 * Runs in the ISOLATED world (it needs chrome.storage / chrome.i18n and the
 * bundled font) and draws inside a shadow root so claude.ai's CSS can't touch
 * it. Look and feel come from theme.js (warm paper + terracotta, follows
 * claude.ai's light/dark mode).
 *
 * Flow:
 *   background.js sets cts_show_welcome = true on install and opens Claude.
 *   This script waits until the app UI is actually on screen (the MAIN-world
 *   widget #ct-toolbar-quota exists and the tab is visible), claims the flag so
 *   only one tab ever shows it, plays the sequence, and on close hands focus to
 *   the message box and pulses the real widget.
 *
 * While the splash is up, <html data-cts-welcome="active">; when it is gone
 * (or was never going to show) it is "done". ui.js and review.js wait on it.
 */

(function () {
  'use strict';

  if (window.top !== window) return;

  const ROOT = document.documentElement;
  const Theme = window.CTS_Theme;
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

  // Resolves with { rem, ts }: % of the 5-hour window still left and when it
  // resets, or null if no reading lands within `timeoutMs`. The MAIN-world code
  // writes cts_5h_util as soon as its first usage request succeeds.
  function waitForUsage(timeoutMs) {
    const read = items => {
      if (typeof items.cts_5h_util !== 'number') return null;
      const ts = items.cts_ts_5h;
      const expired = ts != null && ts <= Math.floor(Date.now() / 1000);
      const used = expired ? 0 : items.cts_5h_util;
      return { rem: Math.max(0, Math.min(100, Math.round(100 - used))), ts: expired ? null : ts };
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
          const r = read(items);
          if (r) settle(r);
        });
      };
      const timer = setTimeout(() => settle(null), timeoutMs);
      chrome.storage.onChanged.addListener(onChange);
      chrome.storage.local.get(['cts_5h_util', 'cts_ts_5h'], items => {
        const r = read(items);
        if (r) settle(r);
      });
    });
  }

  function formatReset(ts) {
    const s = ts - Math.floor(Date.now() / 1000);
    if (s <= 0) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  }

  // ─── Markup ─────────────────────────────────────────────────────────────────

  const CSS = `
    ${Theme.TOKENS}
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; }
    button { font: inherit; }

    .stage {
      --lens: clamp(250px, min(32vw, 64vh), 440px);
      position: fixed; inset: 0; overflow: auto;
      display: grid; grid-template-rows: auto 1fr;
      padding: 26px clamp(22px, 5vw, 72px) 32px;
      background: var(--bg); color: var(--text);
      font-family: var(--sans);
      opacity: 0; transition: opacity .55s ease;
    }
    .stage.in { opacity: 1; }

    /* top bar */
    .top { display: flex; align-items: center; justify-content: space-between; }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 600; letter-spacing: -.005em; }
    .x {
      width: 38px; height: 38px; display: grid; place-items: center;
      border: 0; border-radius: 10px; background: transparent; color: var(--muted); cursor: pointer;
      transition: background .15s, color .15s;
    }
    .x:hover { background: var(--surface); color: var(--text); }

    /* body */
    main {
      width: 100%; max-width: 1160px; margin: 0 auto; align-self: center;
      display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, .8fr);
      align-items: center; gap: clamp(32px, 6vw, 104px);
    }
    .copy { text-align: left; }

    h1 {
      font-family: var(--serif); font-weight: 400;
      font-size: clamp(40px, 5vw, 76px); line-height: 1.04; letter-spacing: -.022em;
      max-width: 14em; text-wrap: balance;
    }
    h1 .ln { display: block; }
    .body {
      margin-top: clamp(16px, 2.6vh, 26px); max-width: 31em;
      font-size: clamp(16px, 1.45vw, 19px); line-height: 1.58; color: var(--muted); text-wrap: pretty;
    }
    .go {
      margin-top: clamp(24px, 4.2vh, 40px);
      appearance: none; border: 0; cursor: pointer;
      padding: 15px 26px; border-radius: 12px;
      font-size: 16px; font-weight: 600; letter-spacing: -.005em;
      color: var(--on-btn); background: var(--btn);
      transition: background .18s, transform .18s;
    }
    .go:hover { background: var(--btn-hover); transform: translateY(-1px); }
    .go:active { transform: none; }
    .go:focus { outline: none; }
    .kbd .go:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .fine { margin-top: 18px; display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
    .fine svg { flex: none; }

    /* the lens: the one memorable thing */
    .lens { position: relative; width: var(--lens); height: var(--lens); justify-self: center; }
    .lens svg.ring { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
    .tick-dim { stroke: var(--tick); stroke-linecap: round; fill: none; }
    .tick-lit { stroke: var(--accent); stroke-linecap: round; opacity: 0; transition: opacity .25s ease; }
    .tick-lit.on { opacity: 1; }
    .face { fill: var(--card); stroke: var(--line); stroke-width: 1.2; }
    .tip { fill: var(--accent); opacity: 0; transition: opacity .5s ease; }
    .tip.on { opacity: 1; }

    .readout { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; text-align: center; }
    .num {
      font-family: var(--serif); font-weight: 400;
      font-size: calc(var(--lens) * .3); line-height: .92; letter-spacing: -.03em;
      font-variant-numeric: lining-nums tabular-nums;
    }
    .num .pc { font-size: .4em; margin-left: .05em; vertical-align: .72em; color: var(--muted); letter-spacing: 0; }
    .cap {
      margin-top: calc(var(--lens) * .02); max-width: calc(var(--lens) * .5); text-wrap: balance;
      font-size: clamp(11.5px, calc(var(--lens) * .042), 14.5px); line-height: 1.3; color: var(--muted);
    }
    .sub { margin-top: calc(var(--lens) * .035); font-family: var(--serif); font-style: italic; font-size: clamp(13px, calc(var(--lens) * .05), 17px); color: var(--accent); }

    /* the copy fades in once, as a block, after the ring starts to light */
    .reveal { opacity: 0; transform: translateY(8px); transition: opacity .8s ease, transform .8s cubic-bezier(.2,.7,.2,1); }
    .shown .reveal { opacity: 1; transform: none; }

    .cjk h1 { font-weight: 500; letter-spacing: 0; line-height: 1.28; font-size: clamp(34px, 4.6vw, 62px); word-break: keep-all; overflow-wrap: anywhere; }

    .stage.leaving { opacity: 0; transition: opacity .4s ease; }

    .rm, .rm * { transition: none !important; animation: none !important; }
    .rm .reveal { opacity: 1; transform: none; }

    @media (max-width: 860px) {
      .stage { --lens: clamp(220px, min(70vw, 40vh), 340px); }
      main { grid-template-columns: 1fr; gap: 28px; align-self: start; padding-top: 8px; }
      .lens { order: -1; }
      h1 { font-size: clamp(34px, 9vw, 52px); }
    }
    @media (max-height: 640px) and (min-width: 861px) {
      .fine { display: none; }
      h1 { font-size: clamp(34px, 4.6vw, 56px); }
    }
  `;

  function ringSVG() {
    let dim = '', lit = '';
    for (let i = 0; i < TICKS; i++) {
      const major = i % MAJOR_EVERY === 0;
      const len = major ? 24 : 13;
      const w = major ? 3.6 : 2.4;
      const line = cls =>
        `<line class="${cls}" x1="0" y1="-152" x2="0" y2="${-(152 - len)}" stroke-width="${w}" transform="rotate(${i * 360 / TICKS})"/>`;
      dim += line('tick-dim');
      lit += line('tick-lit');
    }
    return `
      <svg class="ring" viewBox="-170 -170 340 340" aria-hidden="true">
        <circle class="face" r="114"/>
        <g>${dim}</g>
        <g>${lit}</g>
        <circle class="tip" id="tip" r="5.5" cx="0" cy="-165"/>
      </svg>`;
  }

  const LOCK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const CLOSE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  // Japanese/Chinese have no spaces to break on: offer a break after each
  // sentence mark so a headline never splits in the middle of a phrase.
  function setHeadline(el, text) {
    if (isCJK) {
      text.split(/(?<=[。！？，、])/).forEach(part => {
        el.appendChild(document.createTextNode(part));
        el.appendChild(document.createElement('wbr'));
      });
      return;
    }
    // Latin scripts: each sentence is its own line, so a line never ends mid-thought.
    text.split(/(?<=[.!?\u00a1\u00bf])\s+/).forEach(sentence => {
      const line = document.createElement('span');
      line.className = 'ln';
      line.textContent = sentence;
      el.appendChild(line);
    });
  }

  // ─── Sequence ───────────────────────────────────────────────────────────────

  async function show() {
    ROOT.dataset.ctsWelcome = 'active';

    const host = document.createElement('div');
    host.id = 'cts-welcome-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const disposeTheme = Theme.attach(host);
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>${CSS}</style>
      <div class="stage${isCJK ? ' cjk' : ''}${reduceMotion ? ' rm' : ''}" role="dialog" aria-modal="true" aria-labelledby="ttl">
        <header class="top">
          <div class="brand">${Theme.mark(26)}<span>TokenLens</span></div>
          <button class="x" type="button">${CLOSE}</button>
        </header>
        <main>
          <section class="copy">
            <h1 id="ttl" class="reveal"></h1>
            <p class="body reveal"></p>
            <button class="go reveal" type="button"></button>
            <p class="fine reveal">${LOCK}<span id="fine"></span></p>
          </section>
          <div class="lens">
            ${ringSVG()}
            <div class="readout">
              <div class="num" id="num"><span id="n">5h</span></div>
              <div class="cap" id="cap"></div>
              <div class="sub" id="sub"></div>
            </div>
          </div>
        </main>
      </div>`;

    const $ = sel => root.querySelector(sel);
    const stage = $('.stage');
    setHeadline($('#ttl'), t('welcomeTitle', 'Stay in your flow. We\u2019ll watch the clock.'));
    $('.body').textContent = t('welcomeBody', 'TokenLens shows how much of your 5-hour limit is left, right where you chat, so a limit never catches you off guard.');
    $('.go').textContent = t('welcomeCta', 'Start chatting');
    $('#fine').textContent = t('privacyLine', 'Runs only on claude.ai. Nothing leaves your browser.');
    $('#cap').textContent = t('welcomeWindow', 'your 5-hour window');
    $('.x').setAttribute('aria-label', t('closeLabel', 'Close'));

    const litTicks = Array.from(root.querySelectorAll('.tick-lit'));
    const tip = $('#tip');
    const startedAt = performance.now();

    // Font first, so the headline never flashes in a fallback face.
    await Theme.loadFonts();
    document.documentElement.appendChild(host);

    const button = $('.go');
    button.focus({ preventScroll: true });

    // Keep keyboard focus inside the splash and let Esc close it.
    const onKey = e => {
      stage.classList.add('kbd');
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'Tab') { e.preventDefault(); (e.shiftKey ? $('.x') : button).focus(); }
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
        disposeTheme();
        finish();
        handBack();
      }, reduceMotion ? 0 : 420);
    }
    button.addEventListener('click', close);
    $('.x').addEventListener('click', close);

    requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.add('in')));

    // Wait (briefly) for the real number. Never hold the show for it.
    const usage = await waitForUsage(1600);
    const sinceStart = performance.now() - startedAt;
    if (!reduceMotion && sinceStart < 700) await new Promise(r => setTimeout(r, 700 - sinceStart));

    lightUp(usage);
    setTimeout(() => stage.classList.add('shown'), reduceMotion ? 0 : 450);

    function lightUp(u) {
      const nEl = $('#n');
      const num = $('#num');
      let count = TICKS;

      if (!u) {
        // No reading yet (offline, or a brand-new account): light the whole ring
        // and name the window instead of inventing a number.
        nEl.textContent = '5h';
      } else {
        $('#cap').textContent = t('welcomeLeft', 'of your 5-hour limit left');
        count = u.rem === 0 ? 0 : Math.max(1, Math.round(u.rem / 100 * TICKS));
        const pc = document.createElement('span');
        pc.className = 'pc';
        pc.textContent = '%';
        num.appendChild(pc);
        const reset = u.ts ? formatReset(u.ts) : '';
        if (reset) $('#sub').textContent = `${t('quotaResetsIn', 'resets in')} ${reset}`;
      }

      const STEP = 24;
      litTicks.slice(0, count).forEach((el, i) =>
        setTimeout(() => el.classList.add('on'), reduceMotion ? 0 : i * STEP));

      // A small marker where "left" ends and "used" begins, like a clock hand.
      if (u && count > 0 && count < TICKS) {
        tip.setAttribute('transform', `rotate(${(count - 1) * 360 / TICKS})`);
        setTimeout(() => tip.classList.add('on'), reduceMotion ? 0 : count * STEP + 150);
      }

      if (!u) return;
      if (reduceMotion || u.rem === 0) { nEl.textContent = String(u.rem); return; }
      // Linear and the same length as the ring's sweep, so the number is always
      // exactly what the lit ticks show.
      const dur = Math.max(1, count * STEP), t0 = performance.now();
      const step = now => {
        const k = Math.min(1, (now - t0) / dur);
        nEl.textContent = String(Math.round(u.rem * k));
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
