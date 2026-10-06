/**
 * Feature-request prompt. Asks people who have been using TokenLens for a
 * while: "What should we build next?" and sends them to the Google Form.
 *
 * Runs in the ISOLATED world; draws in a shadow root styled by theme.js, and
 * shares its timing machinery (day counting) with review.js.
 *
 * WHO is asked (all must hold):
 *   - Established: 30+ days since install AND 6+ separate days of real use.
 *     People who were already using TokenLens before this prompt existed have no
 *     recorded install date (see background.js flagFeedback): they are treated
 *     as established once they show 3+ days of real use after the update.
 *   - Not right after an update: every updated install waits 1 to 3 days (random,
 *     so 800 people don't all get asked the same hour).
 *   - Not already answered, not told "never", asked fewer than 2 times in total.
 *
 * WHEN it appears (all must hold):
 *   - a fresh chat (/new), composer empty, nobody typing or clicking for 4s,
 *     and the page has been open for 25 visible seconds
 *   - they have headroom: 5h usage <= 40%, so it never lands next to a limit
 *   - no other TokenLens surface is up (welcome, review card, what's new, hint)
 *     and no other prompt (review) was shown in the last 4 days
 *   - nothing was shown today
 *
 * HOW it behaves:
 *   - bottom-right card, never steals focus, never blocks the page
 *   - starts typing -> it quietly steps aside and tries again in 3 days, without
 *     counting as an ask (max 4 of these, then it counts as "maybe later")
 *   - ignored for 40s (unless hovered) -> same quiet exit
 *   - "Maybe later" -> asks again in 45 days; a second "later" is the last time
 *   - "Don't ask again" -> never again
 *   - clicking through to the form ends the asking for good
 *
 * QA: chrome.storage.local.set({ cts_feedback_preview: true }) shows the card
 * on the next fresh-chat page, ignoring the rules above, then clears itself.
 */

(function () {
  'use strict';

  if (window.top !== window) return;

  const Theme = window.CTS_Theme;
  if (!Theme) return;
  const ROOT = document.documentElement;

  const FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSe5xRRieZw2c9fnKvfW-7CzAEV-8PpreD0ZDogBMphiPAhb0g/viewform?usp=publish-editor';

  const DAY = 864e5;
  const RULES = {
    tenureDays: 30,        // since install, for people we have a date for
    minDays: 6,            // distinct days of real use for those people
    legacyMinDays: 3,      // for people who predate install tracking
    maxUtil: 40,           // % of 5h window used; above this, not a calm moment
    pageSeconds: 25,       // visible seconds on this page before we may show
    dwellSeconds: 5,       // seconds the moment must hold before we show
    idleMs: 4000,          // no typing/clicking for this long
    snoozeDays: 45,        // after "maybe later"
    quietDays: 3,          // after stepping aside because they started working
    maxQuiet: 4,
    maxShows: 2,
    gapDays: 4,            // minimum distance from any other TokenLens prompt
    autoHideMs: 40000,
  };

  const t = (key, fallback) => {
    try { return chrome.i18n.getMessage(key) || fallback; } catch (_) { return fallback; }
  };
  const todayKey = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const get = keys => chrome.storage.local.get(keys);
  const set = obj => chrome.storage.local.set(obj);

  // ─── Eligibility ────────────────────────────────────────────────────────────

  function util5h(s) {
    if (typeof s.cts_5h_util !== 'number') return null;
    const expired = s.cts_ts_5h != null && s.cts_ts_5h <= Math.floor(Date.now() / 1000);
    return expired ? 0 : s.cts_5h_util;
  }

  function established(s) {
    const days = Array.isArray(s.cts_days) ? s.cts_days.length : 0;
    if (s.cts_fb_legacy === true) return days >= RULES.legacyMinDays;
    const marks = [s.cts_installed_at, s.cts_first_seen].filter(n => typeof n === 'number' && n > 0);
    if (!marks.length) return false;                       // no evidence of tenure: don't guess
    return Date.now() - Math.min(...marks) >= RULES.tenureDays * DAY && days >= RULES.minDays;
  }

  function eligible(s) {
    const st = s.cts_feedback || {};
    if (st.state === 'done' || st.state === 'never') return false;
    if ((st.shown || 0) >= RULES.maxShows) return false;
    if (st.nextAt && Date.now() < st.nextAt) return false;
    if (st.lastDay === todayKey()) return false;

    if (s.cts_show_welcome === true) return false;          // hasn't even seen the welcome yet
    if (s.cts_whatsnew_hide === 'pending') return false;    // one announcement at a time
    if (s.cts_fb_after && Date.now() < s.cts_fb_after) return false;   // just updated: give it a day or two

    const pl = s.cts_prompt_last;
    if (pl && pl.kind !== 'feedback' && Date.now() - pl.ts < RULES.gapDays * DAY) return false;

    if (!established(s)) return false;

    const u = util5h(s);
    if (u == null || u > RULES.maxUtil) return false;
    return true;
  }

  let lastInput = 0;
  ['keydown', 'pointerdown'].forEach(ev =>
    document.addEventListener(ev, () => { lastInput = Date.now(); }, { capture: true, passive: true }));

  const OTHER_SURFACES = ['cts-welcome-host', 'cts-review-host', 'cts-feedback-host', 'ct-whatsnew', 'ct-hint'];

  function momentIsRight() {
    if (!/^\/(new)?\/?$/.test(location.pathname)) return false;           // a fresh chat only
    if (document.visibilityState !== 'visible') return false;
    if (!document.getElementById('ct-toolbar-quota')) return false;       // app UI is up
    if (ROOT.dataset.ctsWelcome === 'active') return false;
    if (OTHER_SURFACES.some(id => document.getElementById(id))) return false;
    if (Date.now() - lastInput < RULES.idleMs) return false;
    const box = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
    if (box && ((box.textContent || box.value || '').trim() !== '')) return false;
    return true;
  }

  // ─── Loop ───────────────────────────────────────────────────────────────────

  let pageSecs = 0, dwell = 0, claimed = false;

  async function tick() {
    if (claimed) return;
    if (document.visibilityState !== 'visible' || !document.getElementById('ct-toolbar-quota')) { dwell = 0; return; }
    pageSecs++;
    if (pageSecs < RULES.pageSeconds) return;
    if (!momentIsRight()) { dwell = 0; return; }

    const s = await get(['cts_feedback', 'cts_days', 'cts_first_seen', 'cts_installed_at', 'cts_fb_legacy', 'cts_fb_after',
                         'cts_prompt_last', 'cts_5h_util', 'cts_ts_5h', 'cts_whatsnew_hide', 'cts_show_welcome',
                         'cts_feedback_preview']);
    if (s.cts_feedback_preview === true) {
      dwell++;
      if (dwell >= 2) { claimed = true; await set({ cts_feedback_preview: false }); present(); }
      return;
    }
    if (!eligible(s)) { dwell = 0; return; }

    dwell++;
    if (dwell < RULES.dwellSeconds) return;

    // Claim before showing so two open tabs can't both ask: re-read, and only the
    // first writer proceeds.
    claimed = true;
    const fresh = await get(['cts_feedback', 'cts_prompt_last']);
    const st = fresh.cts_feedback || {};
    const pl = fresh.cts_prompt_last;
    if (st.lastDay === todayKey() || (pl && pl.kind !== 'feedback' && Date.now() - pl.ts < RULES.gapDays * DAY)) {
      claimed = false; dwell = 0; return;
    }
    await set({
      cts_feedback: { ...st, lastDay: todayKey(), shown: (st.shown || 0) + 1 },
      cts_prompt_last: { ts: Date.now(), kind: 'feedback' },
    });
    present();
  }

  setInterval(() => { tick().catch(() => {}); }, 1000);

  // ─── Outcomes ───────────────────────────────────────────────────────────────

  async function patchState(patch) {
    const s = await get(['cts_feedback']);
    await set({ cts_feedback: { ...(s.cts_feedback || {}), ...patch } });
  }
  const outcome = {
    // They went to the form: never ask again.
    done: () => patchState({ state: 'done', doneAt: Date.now() }),
    never: () => patchState({ state: 'never' }),
    // "Maybe later" / close: ask again in 45 days; the second time is the last.
    later: async () => {
      const s = await get(['cts_feedback']);
      const d = ((s.cts_feedback || {}).dismissals || 0) + 1;
      await patchState(d >= 2
        ? { state: 'never', dismissals: d }
        : { dismissals: d, nextAt: Date.now() + RULES.snoozeDays * DAY });
    },
    // Started typing, or ignored it: not a "no", just not the moment. It doesn't
    // count as an ask, up to a point.
    quiet: async () => {
      const s = await get(['cts_feedback']);
      const st = s.cts_feedback || {};
      const q = (st.quiet || 0) + 1;
      if (q > RULES.maxQuiet) return outcome.later();
      await patchState({ quiet: q, shown: Math.max(0, (st.shown || 1) - 1), nextAt: Date.now() + RULES.quietDays * DAY });
    },
  };

  // ─── Card ───────────────────────────────────────────────────────────────────

  const CSS = `
    ${Theme.TOKENS}
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; }
    button { font: inherit; color: inherit; }

    .wrap {
      position: fixed; right: 28px; bottom: 28px;
      width: min(400px, calc(100vw - 24px));
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

    /* the invitation: a make-believe message box that finishes its own sentence */
    .field {
      display: flex; align-items: center; gap: 12px; width: 100%;
      margin-top: 16px; padding: 12px 12px 12px 16px; text-align: left;
      background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
      cursor: pointer; transition: border-color .18s, box-shadow .18s, transform .18s;
    }
    .field:hover { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
    .field:active { transform: scale(.995); }
    .field .txt { flex: 1; min-width: 0; font-size: 14.5px; line-height: 1.4; }
    .pre { display: block; color: var(--muted); }
    .typed { display: block; min-height: 2.8em; color: var(--text); font-family: var(--serif); font-size: 17px; line-height: 1.4; }
    .caret { display: inline-block; width: 1.5px; height: 1.05em; margin-left: 1px; vertical-align: -.15em; background: var(--accent); animation: blink 1.05s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .go {
      flex: none; width: 36px; height: 36px; border-radius: 50%;
      display: grid; place-items: center;
      background: var(--btn); color: var(--on-btn); transition: background .18s, transform .18s;
    }
    .field:hover .go { background: var(--btn-hover); transform: translateX(2px); }

    .foot {
      display: flex; justify-content: space-between; align-items: center; gap: 12px;
      margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line);
      font-size: 12.5px; color: var(--muted);
    }
    .link {
      appearance: none; border: 0; background: transparent; cursor: pointer; padding: 6px 4px;
      color: var(--muted); text-decoration: underline; text-underline-offset: 3px;
    }
    .link:hover { color: var(--text); }
    .link.soft { text-decoration: none; opacity: .8; }
    .field:focus-visible, .link:focus-visible, .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .view[hidden] { display: none; }
    .spark { display: flex; gap: 6px; margin-top: 14px; color: var(--accent); }

    /* a quiet burst when someone says yes */
    .burst { position: absolute; left: 0; right: 0; top: 56%; height: 0; pointer-events: none; }
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
    .rm .caret { display: none; }
    @media (max-width: 480px) { .wrap { right: 12px; bottom: 12px; } }
  `;

  const CLOSE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  const ARROW = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11M11 5.5l4.5 4.5L11 14.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const SPARK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z"/></svg>';

  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function present() {
    await Theme.loadFonts();
    if (document.getElementById('cts-feedback-host')) return;

    const host = document.createElement('div');
    host.id = 'cts-feedback-host';
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
            <div class="field" id="field" role="button" tabindex="0">
              <div class="txt" aria-hidden="true">
                <span class="pre" id="pre"></span>
                <span class="typed"><span id="typed"></span><span class="caret"></span></span>
              </div>
              <span class="go" aria-hidden="true">${ARROW}</span>
            </div>
            <div class="foot">
              <button class="link soft" id="never" type="button"></button>
              <button class="link" id="later" type="button"></button>
            </div>
          </div>

          <div class="view" id="v-thanks" hidden>
            <h2 id="thanks-title"></h2>
            <div class="spark" aria-hidden="true">${SPARK}${SPARK}${SPARK}</div>
            <p class="body" id="thanks-body"></p>
          </div>

          <div class="burst" aria-hidden="true"></div>
        </section>
      </div>`;

    const $ = sel => root.querySelector(sel);
    const wrap = $('.wrap');
    const prefix = t('fbPrefix', 'I wish TokenLens could');
    const examples = [
      t('fbEx1', 'do that thing I keep wishing for'),
      t('fbEx2', 'stop doing that one annoying thing'),
      t('fbEx3', 'have a button for\u2026'),
      t('fbEx4', 'surprise me'),
    ];
    const cta = t('fbTitle', 'What should we build next?');
    $('#ttl').textContent = cta;
    $('#ask-body').textContent = t('fbBody', 'TokenLens grows one idea at a time, and most of them come from people like you. A feature, a bugfix, a tiny annoyance: one sentence is plenty.');
    $('#pre').textContent = prefix;
    $('#later').textContent = t('fbLater', 'Maybe later');
    $('#never').textContent = t('fbNever', 'Don\u2019t ask again');
    $('#thanks-title').textContent = t('fbThanksTitle', 'Idea received.');
    $('#thanks-body').textContent = t('fbThanksBody', 'The form is open in a new tab. A real person reads every answer.');
    $('#field').setAttribute('aria-label', cta + ' \u2014 ' + prefix + '\u2026');

    // The sentence finishes itself, one wish after another.
    const typedEl = $('#typed');
    let typeTimer = null, ex = 0, pos = 0, typing = true;
    function stepType() {
      const full = examples[ex];
      if (typing) {
        pos++;
        typedEl.textContent = full.slice(0, pos);
        if (pos >= full.length) { typing = false; typeTimer = setTimeout(stepType, 1700); return; }
        typeTimer = setTimeout(stepType, 48 + Math.random() * 40);
      } else {
        pos -= 2;
        if (pos <= 0) { pos = 0; typedEl.textContent = ''; typing = true; ex = (ex + 1) % examples.length; typeTimer = setTimeout(stepType, 380); return; }
        typedEl.textContent = full.slice(0, pos);
        typeTimer = setTimeout(stepType, 22);
      }
    }
    if (reduceMotion) typedEl.textContent = examples[0];
    else typeTimer = setTimeout(stepType, 900);

    const showView = id => root.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== id; });
    let closed = false, autoHide = null;

    function close(after) {
      if (closed) return;
      closed = true;
      clearTimeout(autoHide);
      clearTimeout(typeTimer);
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

    function choose() {
      if (!$('#v-ask') || $('#v-ask').hidden) return;
      clearTimeout(autoHide);
      clearTimeout(typeTimer);
      outcome.done();   // going to the form ends the asking; never nag someone who answered
      window.open(FORM_URL, '_blank', 'noopener');
      burst($('.go'));
      setTimeout(() => showView('v-thanks'), reduceMotion ? 0 : 380);
      autoHide = setTimeout(() => close(), 8000);
    }

    const field = $('#field');
    field.addEventListener('click', choose);
    field.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
    });
    $('#later').addEventListener('click', () => { outcome.later(); close(); });
    $('#never').addEventListener('click', () => { outcome.never(); close(); });
    $('.x').addEventListener('click', () => {
      // closing before answering counts as "maybe later"; after answering it is just closing
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
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('in')));
  }
})();
