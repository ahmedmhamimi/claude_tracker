/**
 * Review prompt. Asks for a Chrome Web Store review at a good moment, once or
 * twice in total, never in the way.
 *
 * Runs in the ISOLATED world; draws in a shadow root styled by theme.js.
 *
 * WHEN it asks (all must hold):
 *   - the person has used TokenLens on 3+ separate days (a day only counts
 *     after ~20s of real, visible use) and installed 3+ days ago
 *   - they are at the start of a fresh chat (/new), composer empty, not typing
 *   - they have headroom: 5h usage <= 50%, so it never lands while they are
 *     frustrated by a limit
 *   - the welcome splash is not on screen, and nothing else was shown today
 *   - they have not already reviewed, said "never", or been asked 4 times
 *
 * HOW it asks: five stars is the whole interaction.
 *   4-5 stars -> opens the store review page (we cannot pre-fill a rating there)
 *   1-3 stars -> a gentle "what's missing?" form, with a public review always
 *                one click away (we never hide the public path)
 *   "Not now" -> asks again in 14 days; a second "not now" is the last time
 *
 * QA: chrome.storage.local.set({ cts_review_preview: true }) shows the card on
 * the next fresh-chat page, ignoring the rules above, then clears itself.
 */

(function () {
  'use strict';

  if (window.top !== window) return;

  const Theme = window.CTS_Theme;
  const ROOT = document.documentElement;

  const STORE_ID = 'mkgepcpfamjfipjnldkjlakffmnlkojg';
  const REVIEW_URL = 'https://chromewebstore.google.com/detail/' + STORE_ID + '/reviews';
  const FEEDBACK_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSebfiCqmt3fijuJQe60k0HmC7HwpdWN2ruyx0AmpOckBHWg8g/viewform?usp=publish-editor';

  const DAY = 864e5;
  const RULES = {
    minDays: 3,            // distinct days of real use
    minAgeDays: 3,         // since first seen
    maxUtil: 50,           // % of 5h window used; above this, not a calm moment
    activeSeconds: 20,     // visible seconds before a day counts as "used"
    dwellSeconds: 4,       // seconds the moment must hold before we show
    idleMs: 3000,          // no typing/clicking for this long
    snoozeDays: 14,
    maxShows: 4,
    autoHideMs: 45000,
  };

  const t = (key, fallback, subs) => {
    try { return chrome.i18n.getMessage(key, subs) || fallback; } catch (_) { return fallback; }
  };
  const todayKey = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const get = keys => chrome.storage.local.get(keys);
  const set = obj => chrome.storage.local.set(obj);

  // ─── Day counting ───────────────────────────────────────────────────────────

  async function recordDay() {
    const s = await get(['cts_days', 'cts_first_seen', 'cts_installed_at']);
    const days = Array.isArray(s.cts_days) ? s.cts_days.slice() : [];
    const key = todayKey();
    const patch = {};
    if (!days.includes(key)) { days.push(key); patch.cts_days = days.slice(-60); }
    if (!s.cts_first_seen) patch.cts_first_seen = s.cts_installed_at || Date.now();
    if (Object.keys(patch).length) await set(patch);
  }

  // ─── Eligibility ────────────────────────────────────────────────────────────

  function util5h(s) {
    if (typeof s.cts_5h_util !== 'number') return null;
    const expired = s.cts_ts_5h != null && s.cts_ts_5h <= Math.floor(Date.now() / 1000);
    return expired ? 0 : s.cts_5h_util;
  }

  function eligible(s) {
    const st = s.cts_review || {};
    if (st.state === 'done' || st.state === 'never') return false;
    if ((st.shown || 0) >= RULES.maxShows) return false;
    if (st.nextAt && Date.now() < st.nextAt) return false;
    if (st.lastDay === todayKey()) return false;
    const days = Array.isArray(s.cts_days) ? s.cts_days.length : 0;
    if (days < RULES.minDays) return false;
    if (!s.cts_first_seen || Date.now() - s.cts_first_seen < RULES.minAgeDays * DAY) return false;
    const u = util5h(s);
    if (u == null || u > RULES.maxUtil) return false;
    return true;
  }

  let lastInput = 0;
  ['keydown', 'pointerdown'].forEach(ev =>
    document.addEventListener(ev, () => { lastInput = Date.now(); }, { capture: true, passive: true }));

  function momentIsRight() {
    if (!/^\/(new)?\/?$/.test(location.pathname)) return false;           // a fresh chat only
    if (document.visibilityState !== 'visible') return false;
    if (!document.getElementById('ct-toolbar-quota')) return false;       // app UI is up
    if (ROOT.dataset.ctsWelcome === 'active') return false;
    if (document.getElementById('cts-welcome-host') || document.getElementById('cts-review-host')) return false;
    if (Date.now() - lastInput < RULES.idleMs) return false;
    const box = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
    if (box && ((box.textContent || box.value || '').trim() !== '')) return false;
    return true;
  }

  // ─── Loop ───────────────────────────────────────────────────────────────────

  let activeSecs = 0, dayRecorded = false, dwell = 0, claimed = false;

  async function tick() {
    if (document.visibilityState !== 'visible' || !document.getElementById('ct-toolbar-quota')) { dwell = 0; return; }

    activeSecs++;
    if (!dayRecorded && activeSecs >= RULES.activeSeconds) { dayRecorded = true; await recordDay(); }
    if (claimed) return;

    if (!momentIsRight()) { dwell = 0; return; }

    const s = await get(['cts_review', 'cts_days', 'cts_first_seen', 'cts_5h_util', 'cts_ts_5h', 'cts_review_preview']);
    if (s.cts_review_preview === true) {
      dwell++;
      if (dwell >= 2) { await set({ cts_review_preview: false }); present(Math.max(3, (s.cts_days || []).length)); }
      return;
    }
    if (!eligible(s)) { dwell = 0; return; }

    dwell++;
    if (dwell < RULES.dwellSeconds) return;

    // Claim before showing so two open tabs can't both ask.
    claimed = true;
    const fresh = await get(['cts_review']);
    const st = fresh.cts_review || {};
    if (st.lastDay === todayKey()) { claimed = false; return; }
    await set({ cts_review: { ...st, lastDay: todayKey(), shown: (st.shown || 0) + 1 } });
    present((s.cts_days || []).length);
  }

  setInterval(() => { tick().catch(() => {}); }, 1000);

  // ─── Outcomes ───────────────────────────────────────────────────────────────

  async function patchState(patch) {
    const s = await get(['cts_review']);
    await set({ cts_review: { ...(s.cts_review || {}), ...patch } });
  }
  const outcome = {
    done: (rating) => patchState({ state: 'done', rating, doneAt: Date.now() }),
    // "Not now" / close: ask again in 14 days; the second time is the last.
    later: async () => {
      const s = await get(['cts_review']);
      const d = ((s.cts_review || {}).dismissals || 0) + 1;
      await patchState(d >= 2 ? { state: 'never', dismissals: d } : { dismissals: d, nextAt: Date.now() + RULES.snoozeDays * DAY });
    },
    // Ignored or started typing: not a "no", just not the moment. Tomorrow at the earliest.
    quiet: () => patchState({ nextAt: Date.now() + 2 * DAY }),
  };

  // ─── Card ───────────────────────────────────────────────────────────────────

  const CSS = `
    ${Theme.TOKENS}
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; }
    button { font: inherit; color: inherit; }

    .wrap {
      position: fixed; right: 28px; bottom: 28px;
      width: min(392px, calc(100vw - 24px));
      font-family: var(--sans); color: var(--text);
    }
    .card {
      position: relative; padding: 22px 22px 14px;
      background: var(--card); border: 1px solid var(--line); border-radius: 20px;
      box-shadow: var(--shadow);
      opacity: 0; transform: translateY(18px);
      transition: opacity .5s ease, transform .6s cubic-bezier(.2,.8,.2,1);
    }
    .in .card { opacity: 1; transform: none; }
    .out .card { opacity: 0; transform: translateY(10px); transition-duration: .3s; }

    .brand { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--muted); }
    .x {
      position: absolute; top: 12px; right: 12px; width: 30px; height: 30px;
      display: grid; place-items: center; border: 0; border-radius: 8px;
      background: transparent; color: var(--muted); cursor: pointer; transition: background .15s, color .15s;
    }
    .x:hover { background: var(--surface); color: var(--text); }

    h2 {
      margin-top: 14px; padding-right: 8px;
      font-family: var(--serif); font-weight: 400; font-size: 27px; line-height: 1.14; letter-spacing: -.018em;
      text-wrap: balance;
    }
    .body { margin-top: 9px; font-size: 14px; line-height: 1.52; color: var(--muted); text-wrap: pretty; }

    .stars {
      display: flex; justify-content: space-between; align-items: center;
      margin-top: 18px; padding: 8px 12px;
      background: var(--surface); border-radius: 14px;
    }
    .star {
      appearance: none; border: 0; background: transparent; padding: 3px; line-height: 0;
      border-radius: 10px; cursor: pointer; transition: transform .18s cubic-bezier(.3,1.6,.5,1);
    }
    .star svg { width: 40px; height: 40px; display: block; }
    .star path { fill: var(--star-off); stroke: var(--star-off); stroke-width: 1.3; stroke-linejoin: round; transition: fill .16s, stroke .16s; }
    .star.on path { fill: var(--star); stroke: var(--star); }
    .star:hover { transform: scale(1.12) rotate(-4deg); }
    .star:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

    .cap { height: 22px; margin-top: 9px; font-family: var(--serif); font-style: italic; font-size: 17px; color: var(--accent); }

    .foot {
      display: flex; justify-content: space-between; align-items: center; gap: 12px;
      margin-top: 8px; padding-top: 10px; border-top: 1px solid var(--line);
      font-size: 12.5px; color: var(--muted);
    }
    .link {
      appearance: none; border: 0; background: transparent; cursor: pointer; padding: 6px 4px;
      color: var(--muted); text-decoration: underline; text-underline-offset: 3px;
    }
    .link:hover { color: var(--text); }

    .btn {
      display: block; width: 100%; margin-top: 16px; padding: 13px 18px;
      border: 0; border-radius: 12px; cursor: pointer;
      font-size: 15px; font-weight: 600; color: var(--on-btn); background: var(--btn);
      transition: background .18s;
    }
    .btn:hover { background: var(--btn-hover); }
    .btn:focus-visible, .link:focus-visible, .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .alt { display: block; margin: 8px auto 0; }

    .view[hidden] { display: none; }
    .done-stars { display: flex; gap: 4px; margin-top: 14px; }
    .done-stars svg { width: 26px; height: 26px; }
    .done-stars path { fill: var(--star); stroke: var(--star); stroke-width: 1.3; stroke-linejoin: round; }

    /* a quiet burst when someone says yes */
    .burst { position: absolute; left: 0; right: 0; top: 40%; height: 0; pointer-events: none; }
    .burst i {
      position: absolute; left: 50%; top: 0; width: 6px; height: 6px; border-radius: 50%;
      background: var(--star); opacity: 0;
      animation: pop .9s cubic-bezier(.15,.7,.3,1) forwards;
    }
    @keyframes pop {
      0% { opacity: 1; transform: translate(0, 0) scale(1); }
      100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(.3); }
    }

    .cjk h2 { font-size: 23px; line-height: 1.35; letter-spacing: 0; text-wrap: wrap; padding-right: 30px; }
    .rm, .rm * { transition: none !important; animation: none !important; }
    .rm .card { opacity: 1; transform: none; }
    @media (max-width: 480px) { .wrap { right: 12px; bottom: 12px; } }
  `;

  const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.75 5.75 6.3.85-4.6 4.4 1.15 6.3L12 17.1 6.4 20.1l1.15-6.3-4.6-4.4 6.3-.85z"/></svg>';
  const CLOSE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LABELS = [
    ['reviewStar1', 'Not for me'], ['reviewStar2', 'It\u2019s okay'], ['reviewStar3', 'Pretty good'],
    ['reviewStar4', 'Really good'], ['reviewStar5', 'Love it'],
  ].map(([k, fb]) => t(k, fb));

  async function present(days) {
    await Theme.loadFonts();
    if (document.getElementById('cts-review-host')) return;

    const host = document.createElement('div');
    host.id = 'cts-review-host';
    host.style.cssText = 'position:fixed;inset:auto 0 0 auto;z-index:2147483646;';
    const disposeTheme = Theme.attach(host);
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap${reduceMotion ? ' rm' : ''}${/^(ja|zh)/i.test(chrome.i18n.getUILanguage()) ? ' cjk' : ''}">
        <section class="card" role="dialog" aria-labelledby="ttl">
          <button class="x" type="button" aria-label="${t('closeLabel', 'Close')}">${CLOSE}</button>
          <div class="brand">${Theme.mark(22)}<span>TokenLens</span></div>

          <div class="view" id="v-ask">
            <h2 id="ttl"></h2>
            <p class="body" id="ask-body"></p>
            <div class="stars" role="group" aria-label="${t('reviewTitle', 'Rate TokenLens')}"></div>
            <div class="cap" id="cap" aria-live="polite"></div>
            <div class="foot"><span id="stat"></span><button class="link" id="later" type="button"></button></div>
          </div>

          <div class="view" id="v-thanks" hidden>
            <h2 id="thanks-title"></h2>
            <div class="done-stars">${STAR.repeat(5)}</div>
            <p class="body" id="thanks-body"></p>
          </div>

          <div class="view" id="v-low" hidden>
            <h2 id="low-title"></h2>
            <p class="body" id="low-body"></p>
            <button class="btn" id="low-form" type="button"></button>
            <button class="link alt" id="low-public" type="button"></button>
          </div>

          <div class="burst" aria-hidden="true"></div>
        </section>
      </div>`;

    const $ = sel => root.querySelector(sel);
    const wrap = $('.wrap');
    $('#ttl').textContent = t('reviewTitle', 'Is TokenLens keeping you in flow?');
    $('#ask-body').textContent = t('reviewBody', 'Reviews are how other people find TokenLens. If it has earned it, five stars goes a long way.');
    $('#stat').textContent = t('reviewStat', 'Days with TokenLens: ' + days, [String(days)]);
    $('#later').textContent = t('reviewNotNow', 'Not now');
    $('#thanks-title').textContent = t('reviewThanksTitle', 'Thank you. Truly.');
    $('#thanks-body').textContent = t('reviewThanksBody', 'Your review page just opened in a new tab. It takes about 20 seconds, and it helps more than you\u2019d think.');
    $('#low-title').textContent = t('reviewLowTitle', 'Thanks for being honest.');
    $('#low-body').textContent = t('reviewLowBody', 'Tell us what\u2019s missing and we\u2019ll work on it. It takes a minute.');
    $('#low-form').textContent = t('reviewLowCta', 'Tell us what\u2019s missing');
    $('#low-public').textContent = t('reviewPublicAnyway', 'Write a public review instead');

    // stars
    const starsEl = $('.stars');
    const stars = LABELS.map((label, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'star';
      b.innerHTML = STAR;
      b.setAttribute('aria-label', `${i + 1} / 5 \u2014 ${label}`);
      starsEl.appendChild(b);
      return b;
    });
    const cap = $('#cap');
    const light = n => stars.forEach((s, i) => s.classList.toggle('on', i < n));

    // One gentle invitation: the stars fill to five, hold, and let go.
    let sweepTimers = [], interacted = false;
    const stopSweep = () => { sweepTimers.forEach(clearTimeout); sweepTimers = []; };
    function sweep() {
      if (reduceMotion) return;
      for (let i = 1; i <= 5; i++) sweepTimers.push(setTimeout(() => !interacted && light(i), 900 + i * 130));
      sweepTimers.push(setTimeout(() => { if (!interacted) light(0); }, 900 + 5 * 130 + 700));
    }

    stars.forEach((s, i) => {
      const enter = () => { interacted = true; stopSweep(); light(i + 1); cap.textContent = LABELS[i]; };
      const leave = () => { light(0); cap.textContent = ''; };
      s.addEventListener('pointerenter', enter);
      s.addEventListener('focus', enter);
      s.addEventListener('pointerleave', leave);
      s.addEventListener('blur', leave);
      s.addEventListener('click', () => choose(i + 1, s));
    });

    // view switching
    const showView = id => root.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== id; });
    let closed = false, autoHide = null;

    function close(after) {
      if (closed) return;
      closed = true;
      clearTimeout(autoHide);
      stopSweep();
      document.removeEventListener('keydown', onTyping, true);
      wrap.classList.add('out');
      setTimeout(() => { host.remove(); disposeTheme(); if (after) after(); }, reduceMotion ? 0 : 320);
    }

    function burst(fromEl) {
      if (reduceMotion) return;
      const b = $('.burst');
      const card = $('.card').getBoundingClientRect();
      const r = fromEl.getBoundingClientRect();
      b.style.left = (r.left + r.width / 2 - card.left - card.width / 2) + 'px';
      for (let k = 0; k < 14; k++) {
        const i = document.createElement('i');
        const a = (k / 14) * Math.PI * 2 + Math.random() * .4;
        const d = 54 + Math.random() * 46;
        i.style.setProperty('--dx', Math.cos(a) * d + 'px');
        i.style.setProperty('--dy', Math.sin(a) * d + 'px');
        i.style.width = i.style.height = (4 + Math.random() * 5) + 'px';
        b.appendChild(i);
      }
    }

    function choose(n, el) {
      interacted = true; stopSweep(); light(n);
      clearTimeout(autoHide);
      outcome.done(n);   // any rating ends the asking; never nag someone who answered
      if (n >= 4) {
        window.open(REVIEW_URL, '_blank', 'noopener');
        burst(el);
        setTimeout(() => showView('v-thanks'), reduceMotion ? 0 : 380);
        autoHide = setTimeout(() => close(), 9000);
      } else {
        showView('v-low');
        $('#low-form').addEventListener('click', () => { window.open(FEEDBACK_URL, '_blank', 'noopener'); close(); });
        $('#low-public').addEventListener('click', () => { window.open(REVIEW_URL, '_blank', 'noopener'); close(); });
      }
    }

    $('#later').addEventListener('click', () => { outcome.later(); close(); });
    $('.x').addEventListener('click', () => {
      // closing before choosing counts as "not now"; after choosing it is just closing
      if (!$('#v-ask').hidden) outcome.later();
      close();
    });

    // Starting to type means they came here to work: step aside, no hard feelings.
    const onTyping = e => {
      if (e.target && host.contains(e.target)) return;
      if (e.key && e.key.length === 1 && !e.metaKey && !e.ctrlKey) { outcome.quiet(); close(); }
    };
    document.addEventListener('keydown', onTyping, true);

    // Gone on its own if ignored, unless they are hovering over it.
    const arm = () => { autoHide = setTimeout(() => { outcome.quiet(); close(); }, RULES.autoHideMs); };
    arm();
    host.addEventListener('pointerenter', () => clearTimeout(autoHide));
    host.addEventListener('pointerleave', () => { if (!closed && !$('#v-ask').hidden) { clearTimeout(autoHide); arm(); } });

    document.documentElement.appendChild(host);
    requestAnimationFrame(() => requestAnimationFrame(() => { wrap.classList.add('in'); sweep(); }));
  }
})();
