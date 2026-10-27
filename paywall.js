/**
 * Everything the person sees about TokenLens Pro on claude.ai (ISOLATED world):
 * the unlock dialog (opened only when someone clicks a locked feature), small
 * inline "locked" cards, the one-line plan status inside the menu, and three
 * calm one-time toasts (trial started, trial ending, trial ended). Nothing
 * here interrupts typing or a streaming reply, and nothing opens by itself
 * except those toasts. Copy uses the person's own numbers (chats indexed,
 * days of history, limit hits) because that is what makes the offer concrete.
 *
 * - CTS_Paywall.show(featureId, ctx?) -> Promise<void>: opens the unlock dialog worded for that feature; ctx may carry {count}.
 * - CTS_Paywall.card(featureId, text, ctx?) -> Element: inline card with an unlock button, for use inside panel screens.
 * - CTS_Paywall.status() -> Element: one-line plan status ("Free trial: day 3 of 7", "TokenLens Pro", "Free plan") with an action button.
 * - CTS_Paywall.stats() -> Promise<{chats, days, hits}>: the person's own numbers (from the local store).
 * - CTS_Paywall.close() -> void: closes the dialog if open.
 *
 * @requires safe.js, license.js, license-core.js, ui-kit.js, client.js, history.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe, UI = window.CTS_UI, h = UI.h, Lic = window.CTS_License, Core = window.CTS_LicenseCore, CFG = Core.CONFIG;
  const DAY = 864e5;
  const L = (k, fb, subs) => {
    let v = UI.T('ix_' + k);
    if (v === 'ix_' + k) v = fb;
    return subs ? v.replace(/\{(\w+)\}/g, (_, n) => (subs[n] != null ? subs[n] : '')) : v;
  };

  // featureId -> [heading, sentence]. {n} is filled from the person's numbers or ctx.
  const REASONS = {
    'export.pdf':    ['Save as PDF', 'PDF, Text and JSON saves are part of TokenLens Pro. Markdown stays free.'],
    'export.txt':    ['Save as Text', 'PDF, Text and JSON saves are part of TokenLens Pro. Markdown stays free.'],
    'export.json':   ['Save as JSON', 'PDF, Text and JSON saves are part of TokenLens Pro. Markdown stays free.'],
    'bulk':          ['Save all your chats', 'Download every chat in one ZIP. {chatsLine}'],
    'search.full':   ['Every search result', 'The free plan shows the top {free} results. Pro shows all of them.'],
    'history.range': ['Your full usage history', 'The free plan shows the last {freeDays} days. Pro shows 7 and 30 days, plus every time you hit your limit.'],
    'alerts.full':   ['Alerts on both limits', 'Pro warns you at 80% and 95% on your 5-hour and 7-day limits. Free warns once, at 95% of the 5-hour limit.'],
    'handoff':       ['Continue in a new chat', 'Long chats get slow and forget things. Pro carries the important part into a fresh chat in one click.'],
    'themes':        ['Color themes', 'Pick a color theme and a compact layout for all TokenLens surfaces.'],
    'generic':       ['TokenLens Pro', 'Search every chat, save them all, see your usage history, and never get caught by a limit.'],
  };

  let dlg = null;

  async function stats() {
    const Client = window.CTS_Client, H = window.CTS_History;
    const out = { chats: 0, days: 0, hits: 0 };
    try {
      const cov = (await Client.data('index.coverage')) || {};
      out.chats = Math.max(cov.indexed || 0, cov.total || 0);
      const snaps = (await Client.data('snap.list')) || [];
      const off = -new Date().getTimezoneOffset() * 60000;
      out.days = new Set(snaps.map(s => Math.floor((s.t + off) / DAY))).size;
      out.hits = H ? H.limitHits(snaps).length : 0;
    } catch (_) {}
    return out;
  }

  function close() {
    if (!dlg) return;
    document.removeEventListener('keydown', dlg.onKey, true);
    dlg.host.remove();
    const f = dlg.prevFocus; dlg = null;
    if (f && f.focus) Safe.run('paywall', () => f.focus());
  }

  const markPrompt = () => Safe.chromeCall('paywall', () => chrome.storage.local.set({ cts_prompt_last: { kind: 'paywall', ts: Date.now() } }));

  async function show(featureId, ctx) {
    if (dlg) return;
    const st = Lic.state();
    const reason = REASONS[featureId] || REASONS.generic;
    const m = UI.mount('cts-paywall-host', `
      .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 2147483002; display: grid; place-items: center; }
      .dlg { background: var(--bg); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); width: min(420px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; padding: 18px; }
      .dlg h3 { font-size: 19px; margin: 0 0 4px; }
      .kick { color: var(--btn); font-weight: 600; font-size: 12px; letter-spacing: .02em; text-transform: uppercase; margin: 0 0 4px; }
      ul.facts { list-style: none; margin: 10px 0; padding: 0; display: grid; gap: 4px; }
      ul.facts li { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
      .price { display: flex; align-items: baseline; gap: 8px; margin: 12px 0 4px; }
      .price b { font: 400 28px var(--serif); }
      .fine { color: var(--muted); font-size: 12px; margin: 2px 0; }
      .btn.big { width: 100%; min-height: 38px; font-weight: 600; margin-block: 4px; }`);
    const body = h('div', { class: 'dlg fade', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'TokenLens Pro' });
    const scrim = h('div', { class: 'scrim' }, body);
    m.root.appendChild(scrim);
    const prevFocus = document.activeElement;
    document.documentElement.appendChild(m.host);
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('mousedown', e => { if (e.target === scrim) close(); });
    dlg = { host: m.host, onKey, prevFocus };
    markPrompt();

    const s = await stats();
    if (!dlg) return;                                            // closed while the numbers loaded
    const chatsLine = (ctx && ctx.count ? ctx.count : s.chats) ? L('chatsFound', '{n} chats are ready to save.', { n: ctx && ctx.count ? ctx.count : s.chats }) : '';
    const sentence = L('why_' + featureId, reason[1], { free: Core.FREE.searchResults, freeDays: Core.FREE.historyDays, chatsLine }).trim();

    const facts = [];
    if (s.chats) facts.push(L('factChats', '{n} chats indexed on this device', { n: UI.fmt.num(s.chats) }));
    if (s.days) facts.push(L('factDays', '{n} days of usage history saved', { n: s.days }));
    if (s.hits) facts.push(L('factHits', 'You hit your limit {n} times', { n: s.hits }));

    const trialLine = st.tier === 'trial'
      ? L('trialLine', 'Free trial: day {d} of {t}. Everything is unlocked right now.', { d: st.trial.day, t: CFG.TRIAL_DAYS })
      : st.revoked ? L('revokedLine', 'Your license is no longer active (refunded or disputed).') : L('trialOver', 'Your free trial has ended.');

    body.append(
      h('p', { class: 'kick', text: 'TokenLens Pro' }),
      h('h3', { text: L('hd_' + featureId, reason[0]) }),
      h('p', { text: sentence }),
      facts.length ? h('ul', { class: 'facts' }, facts.map(t => h('li', { text: t }))) : null,
      h('p', { class: 'fine', text: trialLine }),
      h('div', { class: 'price' }, h('b', { text: CFG.PRICE_LABEL }), h('span', { class: 'muted', text: L('priceNote', 'one-time. Yours forever, all updates included.') })),
      h('button', { class: 'btn big', type: 'button', text: L('buyBtn', 'Unlock Pro for {p}', { p: CFG.PRICE_LABEL }), on: { click: () => { Lic.openCheckout(); body.querySelector('.after').hidden = false; } } }),
      h('p', { class: 'fine after', hidden: true, text: L('afterBuy', 'After you pay, Gumroad emails you a license key. Come back and paste it in.') }),
      h('button', { class: 'btn ghost big', type: 'button', text: L('haveKey', 'I have a license key'), on: { click: () => { close(); Lic.openUnlock(); } } }),
      h('button', { class: 'btn ghost big', type: 'button', text: L('notNow', 'Not now'), on: { click: close } }),
      h('p', { class: 'fine', text: L('refundNote', '{d}-day refund, no questions asked. Your chats never leave your browser.', { d: CFG.REFUND_DAYS }) }));
    const first = body.querySelector('.btn.big');
    if (first) first.focus();
  }

  function card(featureId, text, ctx) {
    return h('div', { class: 'card' },
      h('p', { text }),
      h('button', { class: 'btn big', type: 'button', text: L('unlockBtn', 'Unlock Pro') + ' · ' + CFG.PRICE_LABEL, on: { click: () => show(featureId, ctx) } }));
  }

  function status() {
    const st = Lic.state();
    let text, btn = null;
    if (st.tier === 'licensed') text = L('stLicensed', 'TokenLens Pro is active. Thank you!');
    else if (st.tier === 'trial') { text = L('stTrial', 'Free trial: day {d} of {t}', { d: st.trial.day, t: CFG.TRIAL_DAYS }); btn = L('stKeep', 'Keep Pro'); }
    else { text = L('stFree', 'Free plan'); btn = L('stUnlock', 'Unlock Pro'); }
    return h('div', { class: 'row', style: 'margin-block: 8px 0; justify-content: space-between' },
      h('span', { class: 'muted', text }),
      btn ? h('button', { class: 'btn ghost small', type: 'button', text: btn, on: { click: () => show('generic') } }) : null);
  }

  // ─── calm one-time toasts ─────────────────────────────────────────────────
  const KEY = 'cts_pw';
  const getFlags = () => new Promise(res => { const ran = Safe.chromeCall('paywall', () => { chrome.storage.local.get([KEY, 'cts_show_welcome'], v => { void chrome.runtime.lastError; res(v || {}); }); return true; }); if (ran !== true) res({}); });
  const setFlags = o => Safe.chromeCall('paywall', () => chrome.storage.local.set({ [KEY]: o }));
  let busy = false;

  async function nudge() {
    if (busy || Safe.isInvalidated() || !UI.isCalm() || UI.toastVisible() || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      await Lic.ready;
      const st = Lic.state();
      if (st.tier === 'licensed') return;
      const raw = await getFlags();
      if (raw.cts_show_welcome === true) return;                  // let the first-run splash go first
      const f = Object.assign({ intro: false, ending: '', ended: false }, raw[KEY] || {});
      const today = Core.localDay(Date.now());
      let shown = false;

      if (st.tier === 'trial' && !f.intro) {
        shown = UI.toast({ text: L('introToast', 'TokenLens Pro is free to try for {t} days: search all your chats, save them all, see your usage history and get limit alerts.', { t: CFG.TRIAL_DAYS }), timeoutMs: 25000,
          actions: [{ label: L('introCta', 'Take a look'), onClick: () => document.dispatchEvent(new CustomEvent('cts2:open-panel', { detail: { screen: 'menu' } })) }] });
        if (shown) f.intro = true;
      } else if (st.tier === 'trial' && st.trial.daysLeft <= 1 && f.ending !== today) {
        const text = st.trial.daysLeft === 1
          ? L('endingTomorrow', 'Your free trial ends tomorrow. Keep search, Save all, history and alerts for {p}, once.', { p: CFG.PRICE_LABEL })
          : L('endingToday', 'Last day of your free trial. Keep search, Save all, history and alerts for {p}, once.', { p: CFG.PRICE_LABEL });
        shown = UI.toast({ text, timeoutMs: 25000, actions: [{ label: L('seePro', 'See Pro'), onClick: () => show('generic') }] });
        if (shown) f.ending = today;
      } else if (st.tier === 'free' && !f.ended && !st.revoked) {
        const s = await stats();
        const bits = [];
        if (s.chats) bits.push(L('endChats', '{n} indexed chats', { n: UI.fmt.num(s.chats) }));
        if (s.days) bits.push(L('endDays', '{n} days of history', { n: s.days }));
        const saved = bits.length ? L('endSaved', ' Your {what} are saved.', { what: bits.join(' and ') }) : '';
        shown = UI.toast({ text: L('endedToast', 'Your free trial has ended.{saved} Unlock Pro for {p}, one time, to keep using them.', { saved, p: CFG.PRICE_LABEL }), timeoutMs: 30000,
          actions: [{ label: L('stUnlock', 'Unlock Pro'), onClick: () => show('generic') }] });
        if (shown) f.ended = true;
      }
      if (shown) { setFlags(f); markPrompt(); }
    } finally { busy = false; }
  }

  setInterval(() => Safe.run('paywall', nudge), 20000);
  setTimeout(() => Safe.run('paywall', nudge), 6000);

  window.CTS_Paywall = { show, card, status, stats, close };
})();
