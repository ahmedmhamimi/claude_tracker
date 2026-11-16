/**
 * Everything the person sees about TokenLens Pro on claude.ai (ISOLATED world):
 * the unlock dialog (opened only when someone clicks a locked feature), small
 * inline "locked" cards, the one-line plan status inside the menu, and three
 * calm one-time toasts (trial started, trial ended, "Pro is free now").
 * Since 6.4 Pro is free: every unlock leads to one visit to VamimiAI
 * (CTS_License.unlockWithVamimi), and existing Gumroad keys still work. Nothing
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
    'history.range': ['Your full usage history', 'The free plan shows the last {freeDays} days. Pro shows 7 and 30 days, plus every time you reached your limit.'],
    'handoff':       ['Continue in a new chat', 'Long chats get slow and forget things. Pro carries the important part into a fresh chat in one click.'],
    'pace':          ['Your pace', 'See whether you will reach your 5-hour limit before it resets, at the pace you are going.'],
    'generic':       ['TokenLens Pro', 'Search every chat, save them all, see your full usage history and continue long chats in a new one.'],
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

  // The one action every locked feature leads to: one visit to VamimiAI.
  // Opens it in a new tab; the service worker unlocks Pro once it has loaded.
  let unlocking = false;
  async function unlock(featureId, campaign) {
    if (unlocking) return;
    unlocking = true;
    try { await Lic.unlockWithVamimi(campaign || ('unlock_' + String(featureId || 'generic').replace(/\W/g, '_'))); }
    finally { unlocking = false; }
  }

  const VM_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3.5" width="7" height="5" rx="1.6"/><rect x="14" y="3.5" width="7" height="5" rx="1.6"/><rect x="8.5" y="15.5" width="7" height="5" rx="1.6"/><path d="M6.5 8.5v2.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V8.5"/><path d="M12 12.5v3"/></svg>';

  async function show(featureId, ctx) {
    if (dlg) return;
    const st = Lic.state();
    if (st.pro) return;                                          // nothing to unlock
    const reason = REASONS[featureId] || REASONS.generic;
    const m = UI.mount('cts-paywall-host', `
      .scrim { position: fixed; inset: 0; background: rgba(20,18,16,.42); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
               z-index: 2147483002; display: grid; place-items: center; }
      .dlg { background: var(--bg); border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow); width: min(420px, calc(100vw - 24px));
             max-height: calc(100vh - 24px); overflow: auto; padding: 22px 22px 18px; }
      .dlg h3 { font: 400 24px/1.15 var(--serif); letter-spacing: -.01em; margin: 0 0 6px; }
      .kick { display: inline-flex; align-items: center; gap: 6px; color: var(--btn); font-weight: 600; font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase; margin: 0 0 8px; }
      ul.facts { list-style: none; margin: 12px 0; padding: 0; display: grid; gap: 4px; }
      ul.facts li { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
      .free { display: flex; align-items: baseline; gap: 8px; margin: 14px 0 6px; }
      .free b { font: 400 30px/1 var(--serif); }
      .fine { color: var(--muted); font-size: 12px; margin: 4px 0; line-height: 1.45; }
      .btn.big { width: 100%; min-height: 42px; font-weight: 600; margin-block: 4px; border-radius: 11px; }
      .btn.vm { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
      .btn.vm svg { width: 17px; height: 17px; }
      .done { text-align: center; padding: 8px 0 2px; }
      .done b { display: block; font: 400 22px var(--serif); margin-bottom: 4px; }`);
    const body = h('div', { class: 'dlg fade', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'TokenLens Pro' });
    const scrim = h('div', { class: 'scrim' }, body);
    m.root.appendChild(scrim);
    const prevFocus = document.activeElement;
    document.documentElement.appendChild(m.host);
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('mousedown', e => { if (e.target === scrim) close(); });
    dlg = { host: m.host, onKey, prevFocus, body };
    markPrompt();

    const s = await stats();
    if (!dlg) return;                                            // closed while the numbers loaded
    const chatsLine = (ctx && ctx.count ? ctx.count : s.chats) ? L('chatsFound', '{n} chats are ready to save.', { n: ctx && ctx.count ? ctx.count : s.chats }) : '';
    const sentence = L('why_' + featureId, reason[1], { free: Core.FREE.searchResults, freeDays: Core.FREE.historyDays, chatsLine }).trim();

    const facts = [];
    if (s.chats) facts.push(L('factChats', '{n} chats indexed on this device', { n: UI.fmt.num(s.chats) }));
    if (s.days > 1) facts.push(L('factDays', '{n} days of usage history saved', { n: s.days }));

    const trialLine = st.revoked ? L('revokedLine', 'Your license is no longer active (refunded or disputed).') : L('trialOver', 'Your free trial has ended.');
    const vmBtn = h('button', { class: 'btn big vm', type: 'button' });
    vmBtn.append(UI.svg(VM_ICON), h('span', { text: L('vmUnlockBtn', 'Unlock Pro free with VamimiAI') }));
    vmBtn.addEventListener('click', Safe.wrap('paywall', () => { vmBtn.disabled = true; unlock(featureId); }));

    body.append(
      h('p', { class: 'kick', text: 'TokenLens Pro' }),
      h('h3', { text: L('hd_' + featureId, reason[0]) }),
      h('p', { text: sentence }),
      facts.length ? h('ul', { class: 'facts' }, facts.map(t => h('li', { text: t }))) : null,
      h('div', { class: 'free' }, h('b', { text: L('freeWord', 'Free') }), h('span', { class: 'muted', text: L('freeNote', 'forever. No account, no payment.') })),
      vmBtn,
      h('p', { class: 'fine', text: L('vmUnlockFine', 'Opens VamimiAI, a site that turns text into diagrams, made by the maker of TokenLens. Pro unlocks for good as soon as it loads.') }),
      h('button', { class: 'btn ghost big', type: 'button', text: L('notNow', 'Not now'), on: { click: close } }),
      st.tier === 'free' ? h('p', { class: 'fine', text: trialLine }) : null,
      h('p', { class: 'fine' }, h('a', { href: '#', text: L('haveKey', 'I have a license key'), style: 'color: inherit', on: { click: e => { e.preventDefault(); close(); Lic.openUnlock(); } } })));
    vmBtn.focus();
  }

  // When Pro arrives (from this tab or another), replace the dialog with a thank-you and say so once.
  Lic.onChange(() => Safe.run('paywall', () => {
    const st = Lic.state();
    if (!st.vamimi) return;
    if (dlg && dlg.body) {
      dlg.body.textContent = '';
      dlg.body.append(h('div', { class: 'done' },
        h('b', { text: L('vmUnlockedTitle', 'TokenLens Pro is unlocked') }),
        h('p', { class: 'muted', text: L('vmUnlockedBody', 'Thanks for checking out VamimiAI. Everything in TokenLens is yours now, for good.') })),
        h('button', { class: 'btn big', type: 'button', text: L('done', 'Done'), on: { click: close } }));
    }
  }));

  function card(featureId, text, ctx) {
    return h('div', { class: 'card' },
      h('p', { text }),
      h('button', { class: 'btn big', type: 'button', text: L('unlockFreeBtn', 'Unlock Pro free'), on: { click: () => show(featureId, ctx) } }));
  }

  function status() {
    const st = Lic.state();
    let text, btn = null;
    if (st.tier === 'licensed') text = L('stLicensed', 'TokenLens Pro is active. Thank you!');
    else if (st.tier === 'vamimi') text = L('stVamimi', 'TokenLens Pro is active, unlocked with VamimiAI.');
    else if (st.tier === 'trial') { text = L('stTrial', 'Free trial: day {d} of {t}', { d: st.trial.day, t: CFG.TRIAL_DAYS }); btn = L('stKeepFree', 'Keep Pro free'); }
    else { text = L('stFree', 'Free plan'); btn = L('unlockFreeBtn', 'Unlock Pro free'); }
    return h('div', { class: 'row', style: 'margin-block: 8px 0; justify-content: space-between' },
      h('span', { class: 'muted', text }),
      btn ? h('button', { class: 'btn ghost small', type: 'button', text: btn, on: { click: () => (st.tier === 'trial' ? unlock('generic', 'unlock_trial') : show('generic')) } }) : null);
  }

  // ─── calm one-time toasts ─────────────────────────────────────────────────
  // Three moments, each at most once, never while typing or streaming, never
  // on the same day as another TokenLens prompt (cts_prompt_last):
  //   intro   - a new trial starts: what Pro is.
  //   ended   - the trial ran out: keep it free with one visit to VamimiAI.
  //   freeNow - people whose trial ended before 6.4 (and who never bought):
  //             Pro is free now.
  const KEY = 'cts_pw';
  const getFlags = () => new Promise(res => { const ran = Safe.chromeCall('paywall', () => { chrome.storage.local.get([KEY, 'cts_show_welcome', 'cts_prompt_last'], v => { void chrome.runtime.lastError; res(v || {}); }); return true; }); if (ran !== true) res({}); });
  const setFlags = o => Safe.chromeCall('paywall', () => chrome.storage.local.set({ [KEY]: o }));
  let busy = false;

  async function nudge() {
    if (busy || Safe.isInvalidated() || !UI.isCalm() || UI.toastVisible() || document.visibilityState !== 'visible') return;
    if (['cts-welcome-host', 'cts-review-host', 'cts-feedback-host', 'cts-vamimi-host', 'cts-paywall-host'].some(id => document.getElementById(id))) return;
    busy = true;
    try {
      await Lic.ready;
      const st = Lic.state();
      if (st.licensed || st.vamimi) return;
      const raw = await getFlags();
      if (raw.cts_show_welcome === true) return;                  // let the first-run splash go first
      const pl = raw.cts_prompt_last;
      if (pl && pl.kind !== 'paywall' && Date.now() - (pl.ts || 0) < DAY) return;
      const f = Object.assign({ intro: false, ending: '', ended: false, freeNow: false }, raw[KEY] || {});
      let shown = false;
      const unlockAction = (campaign) => ({ label: L('unlockFreeBtn', 'Unlock Pro free'), onClick: () => unlock('generic', campaign) });

      if (st.tier === 'trial' && !f.intro) {
        shown = UI.toast({ text: L('introToastFree', 'TokenLens Pro is on for {t} days: search all your chats, save them all and see your full usage history. After that it stays free with one visit to VamimiAI.', { t: CFG.TRIAL_DAYS }), timeoutMs: 25000,
          actions: [{ label: L('introCta', 'Take a look'), onClick: () => document.dispatchEvent(new CustomEvent('cts2:open-panel', { detail: { screen: 'menu' } })) }] });
        if (shown) f.intro = true;
      } else if (st.tier === 'free' && !st.revoked && !f.ended) {
        const s = await stats();
        const bits = [];
        if (s.chats) bits.push(L('endChats', '{n} indexed chats', { n: UI.fmt.num(s.chats) }));
        if (s.days) bits.push(L('endDays', '{n} days of history', { n: s.days }));
        const saved = bits.length ? L('endSaved', ' Your {what} are saved.', { what: bits.join(' and ') }) : '';
        shown = UI.toast({ text: L('endedToastFree', 'Your Pro trial has ended.{saved} Keep Pro free, for good, with one visit to VamimiAI.', { saved }), timeoutMs: 30000, actions: [unlockAction('unlock_trial_ended')] });
        if (shown) { f.ended = true; f.freeNow = true; }
      } else if (st.tier === 'free' && !st.revoked && f.ended && !f.freeNow) {
        shown = UI.toast({ text: L('freeNowToast', 'Good news: TokenLens Pro is free now. Unlock it for good with one visit to VamimiAI.'), timeoutMs: 30000, actions: [unlockAction('unlock_free_now')] });
        if (shown) f.freeNow = true;
      }
      if (shown) { setFlags(f); markPrompt(); }
    } finally { busy = false; }
  }

  setInterval(() => Safe.run('paywall', nudge), 20000);
  setTimeout(() => Safe.run('paywall', nudge), 6000);

  window.CTS_Paywall = { show, card, status, stats, close };
})();
