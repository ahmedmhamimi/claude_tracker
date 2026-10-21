/**
 * Group C runtime (ISOLATED): "Continue in a new chat".
 * Addresses the per-chat length (context) limit ONLY; no text here claims it
 * saves usage quota. Nothing is ever sent automatically: carried text is put
 * in the composer (after a confirmation bar in the new chat) for the user to
 * edit and send.
 *
 *   hint     one-time-per-chat inline toast at the configured context % (calm moments only)
 *   dialog   Mode 1 carry over (recent / balanced / compact, live token preview, budget enforced)
 *            Mode 2 summarize first (inserts a request into THIS chat's composer; costs one message)
 *   new chat payload in chrome.storage.local, 10 min expiry, one-time use, confirmation bar, then composer.js
 *   link     new chat id -> previous chat id stored locally for "continued from"
 *
 * - CTS_HandoffUI.open() -> Promise<void>: opens the dialog for the current chat (opens the Pro unlock dialog instead when the plan does not include it)
 * - store.get/set/remove(...) -> Promise: chrome.storage.local helpers that now resolve AFTER the storage callback (get() used to resolve {} immediately, so the new chat never offered the carried text; set() could race the navigation to /new).
 * - CTS_HandoffUI.contextInfo() -> {tokens, window, pct}|null
 *
 * @requires safe.js, features.js, conversation.js, handoff.js, composer.js, exporter.js, client.js, ui-kit.js, bridge2.js, license.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe, F = window.CTS_Features, Conv = window.CTS_Conversation, HO = window.CTS_Handoff, Cmp = window.CTS_Composer;
  const UI = window.CTS_UI, T = UI.T, h = UI.h, Client = window.CTS_Client, Exp = window.CTS_Exporter;
  let lastRaw = null, last = null, awaiting = null, dialogOpen = false;

  const store = {
    get: keys => new Promise(res => { const ran = Safe.chromeCall('handoff', () => { chrome.storage.local.get(keys, v => { void chrome.runtime.lastError; res(v || {}); }); return true; }); if (ran !== true) res({}); }),
    set: o => new Promise(res => { const ran = Safe.chromeCall('handoff', () => { chrome.storage.local.set(o, () => { void chrome.runtime.lastError; res(); }); return true; }); if (ran !== true) res(); }),
    remove: k => new Promise(res => { const ran = Safe.chromeCall('handoff', () => { chrome.storage.local.remove(k, () => { void chrome.runtime.lastError; res(); }); return true; }); if (ran !== true) res(); }),
  };

  const labels = () => ({ user: T('roleYou'), assistant: T('roleClaude'), headerTitle: T('handoffHdrTitle'), headerLine: T('handoffHdrLine'), previousChat: T('handoffHdrPrev'), end: T('handoffHdrEnd') });
  const windowSize = () => F.getSetting('handoff.windowOverride', 0) || (last && last.ctxWindow) || 200000;
  const contextInfo = () => (last ? { tokens: last.totalTokens, window: windowSize(), pct: HO.contextPct(last.totalTokens, windowSize()) } : null);
  const budget = () => HO.budgetFor(windowSize(), F.getSetting('handoff.budgetPct', 30));

  async function currentConversation() {
    const id = Exp.currentChatId(); if (!id) return null;
    if (lastRaw && lastRaw.id === id) return Conv.normalize(lastRaw.json, { id });
    const r = await Client.fetchConv(id, 0);
    return r.status === 200 && r.json ? Conv.normalize(r.json, { id }) : null;
  }

  // ─── hand-off to a new chat ───────────────────────────────────────────────
  async function carryToNewChat(text, conv) {
    await store.set({ cts_handoff: HO.makePayload(text, { id: conv.id, title: conv.title }, Date.now()) });
    location.assign('/new');
  }

  // ─── dialog ───────────────────────────────────────────────────────────────
  async function open() {
    if (!F.isEnabled('handoff') || dialogOpen) return;
    if (window.CTS_License && !window.CTS_License.gate('handoff')) return;   // free plan: show the unlock dialog instead
    dialogOpen = true;
    const m = UI.mount('cts-handoff-host', `
      .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 2147483001; display: grid; place-items: center; }
      .dlg { background: var(--bg); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); width: min(560px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; padding: 16px; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface); border-radius: 8px; padding: 8px; max-height: 160px; overflow: auto; margin: 6px 0; font-size: 11px; }
      label.opt { display: flex; gap: 8px; align-items: flex-start; padding-block: 4px; }
      .err { color: var(--btn); font-weight: 600; }
      input[type=range] { width: 100%; }`);
    const prevFocus = document.activeElement;
    const body = h('div', { class: 'dlg fade', role: 'dialog', 'aria-modal': 'true', 'aria-label': T('handoffTitle') });
    const scrim = h('div', { class: 'scrim' }, body);
    m.root.appendChild(scrim);
    document.documentElement.appendChild(m.host);
    const close = () => { dialogOpen = false; m.host.remove(); document.removeEventListener('keydown', onKey, true); if (prevFocus && prevFocus.focus) Safe.run('handoff', () => prevFocus.focus()); };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const f = Array.from(body.querySelectorAll('button, input, select, textarea')).filter(x => !x.disabled);
        if (!f.length) return;
        const a = m.root.activeElement, first = f[0], lastEl = f[f.length - 1];
        if (e.shiftKey && (a === first || !a)) { e.preventDefault(); lastEl.focus(); } else if (!e.shiftKey && a === lastEl) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('mousedown', e => { if (e.target === scrim) close(); });

    body.appendChild(h('h3', { text: T('handoffTitle') }));
    body.appendChild(h('p', { class: 'muted', text: T('handoffLoading') }));
    const conv = await Safe.run('handoff', currentConversation);
    body.textContent = '';
    body.appendChild(h('h3', { text: T('handoffTitle') }));
    if (!conv || !conv.messages.length) { body.appendChild(h('p', { text: T('handoffFailed') })); body.appendChild(h('button', { class: 'btn', type: 'button', text: T('close'), on: { click: close } })); body.querySelector('button').focus(); return; }

    body.appendChild(h('p', { class: 'muted', text: T('handoffNoteQuota') }));
    let mode = 'balanced', pct = Math.min(100, Math.max(10, HO.maxRecentPct(conv, budget(), labels()) || 10));
    const preview = h('div', { 'aria-live': 'polite' });
    const go = h('button', { class: 'btn', type: 'button', text: T('handoffOpen') });
    const slider = h('input', { type: 'range', min: '10', max: '100', step: '5', value: String(pct), 'aria-label': T('handoffSlider') });
    const sliderRow = h('div', { hidden: true }, h('span', { class: 'muted', text: T('handoffSlider') }), slider);
    const summaryBox = h('div', { hidden: true }, h('p', { text: T('handoffSummaryNote') }));

    // Planning a very large chat can take a few hundred ms: cache per (mode, pct) and debounce the slider.
    const cache = new Map();
    const planFor = () => { const k = mode + ':' + (mode === 'recent' ? slider.value : ''); if (!cache.has(k)) cache.set(k, HO.plan(conv, { mode, pct: +slider.value, budget: budget(), labels: labels() })); return cache.get(k); };
    const refresh = () => {
      preview.textContent = '';
      sliderRow.hidden = mode !== 'recent'; summaryBox.hidden = mode !== 'summary';
      if (mode === 'summary') { go.textContent = T('handoffSummaryInsert'); go.disabled = false; return; }
      go.textContent = T('handoffOpen');
      const r = planFor();
      if (r.error === 'empty') { preview.appendChild(h('p', { class: 'err', text: T('handoffEmpty') })); go.disabled = true; return; }
      preview.appendChild(h('p', { text: T('handoffPreview', [UI.fmt.num(r.tokens), UI.fmt.num(r.chatTokens), String(r.carried), String(r.total)]) }));
      if (r.error === 'over-budget') { preview.appendChild(h('p', { class: 'err', text: T('handoffOverBudget', [UI.fmt.num(budget())]) })); go.disabled = true; }
      else go.disabled = false;
      preview.appendChild(h('pre', { text: r.text.slice(0, 700) + (r.text.length > 700 ? '\n…' : '') }));
      go._plan = r;
    };
    const opt = (id, key) => h('label', { class: 'opt' }, h('input', { type: 'radio', name: 'mode', value: id, checked: id === mode, on: { change: () => { mode = id; refresh(); } } }), h('span', { text: T(key) }));
    body.appendChild(h('div', {}, opt('balanced', 'handoffModeBalanced'), opt('compact', 'handoffModeCompact'), opt('recent', 'handoffModeRecent'), sliderRow, opt('summary', 'handoffModeSummary')));
    let sliderTimer = 0;
    slider.addEventListener('input', () => { pct = +slider.value; clearTimeout(sliderTimer); sliderTimer = setTimeout(() => Safe.run('handoff', refresh), 150); });
    body.appendChild(summaryBox); body.appendChild(preview);
    go.addEventListener('click', Safe.wrap('handoff', async () => {
      if (mode === 'summary') {
        close();
        const res = await Cmp.insertText(T('handoffSummaryPrompt'));
        awaiting = { convId: conv.id, count: last ? last.assistantCount : 0 };
        if (!res.ok) UI.toast({ text: res.manual ? T('handoffPasteManually') : T('handoffInsertFailed'), timeoutMs: 8000 });
        return;
      }
      if (go._plan && go._plan.ok) { const text = go._plan.text; close(); await carryToNewChat(text, conv); }
    }));
    body.appendChild(h('div', { class: 'row end' }, h('button', { class: 'btn ghost', type: 'button', text: T('cancel'), on: { click: close } }), go));
    refresh();
    go.focus();
  }

  // ─── incoming payload in the new chat ─────────────────────────────────────
  async function checkIncoming() {
    if (!F.isEnabled('handoff')) return;
    const p = (await store.get(['cts_handoff'])).cts_handoff;
    if (!p) return;
    if (!HO.isFresh(p, Date.now())) { await store.remove('cts_handoff'); return; }
    if (!/^\/(new)?$/.test(location.pathname)) return; // only offer in a fresh chat; payload stays until it expires
    UI.toast({ text: T('handoffInsertQ'), actions: [
      { label: T('handoffInsert'), onClick: Safe.wrap('handoff', async () => {
        await store.remove('cts_handoff');                                    // one-time use
        const res = await Cmp.insertText(p.text);
        if (res.ok) { await store.set({ cts_handoff_pending: { fromId: p.fromId, t: Date.now() } }); }
        else UI.toast({ text: res.manual ? T('handoffPasteManually') : T('handoffInsertFailed'), timeoutMs: 10000 });
      }) },
    ], onClose: () => { store.remove('cts_handoff'); } });
  }

  // ─── bus ──────────────────────────────────────────────────────────────────
  window.CTS_Bus.on('convraw', d => { if (d.id) lastRaw = { id: d.id, json: d.json }; });

  async function maybeHint() {
    if (!F.isEnabled('handoff') || !last || !last.convId) return;
    const info = contextInfo();
    if (!info || info.pct < F.getSetting('handoff.hintAt', 80)) return;
    const shown = (await store.get(['cts_hint_shown'])).cts_hint_shown || {};
    if (shown[last.convId]) return;
    const convId = last.convId;
    const tryShow = () => Safe.run('handoff', () => {
      if (!F.isEnabled('handoff') || Exp.currentChatId() !== convId) return;
      if (!UI.isCalm() || UI.toastVisible()) { setTimeout(tryShow, 3000); return; }
      const ok = UI.toast({ text: T('handoffHint', [String(info.pct)]), timeoutMs: 20000, actions: [{ label: T('handoffBtn'), onClick: () => open() }] });
      if (!ok) { setTimeout(tryShow, 3000); return; }
      const keys = Object.keys(shown); if (keys.length > 200) delete shown[keys[0]];
      shown[convId] = 1; store.set({ cts_hint_shown: shown });
    });
    tryShow();
  }

  window.CTS_Bus.on('analysis', d => Safe.run('handoff', async () => {
    last = d;
    // Mode 2: the reply to our summary request just finished
    if (awaiting && d.convId === awaiting.convId && d.assistantCount > awaiting.count && lastRaw && lastRaw.id === d.convId) {
      const conv = Conv.normalize(lastRaw.json, { id: d.convId });
      const reply = [...conv.messages].reverse().find(x => x.role === 'assistant' && x.text.trim());
      awaiting = null;
      if (reply) {
        const pseudo = { id: conv.id, title: conv.title, updatedAt: conv.updatedAt, createdAt: conv.createdAt, meta: { estTokens: 0 }, messages: [{ role: 'assistant', text: reply.text }] };
        const plan = HO.plan(pseudo, { mode: 'recent', pct: 100, labels: Object.assign(labels(), { assistant: T('handoffSummaryLabel') }) });
        UI.toast({ text: T('handoffSummaryReady'), actions: [{ label: T('handoffStartNew'), onClick: () => carryToNewChat(plan.text, conv) }] });
      }
      return;
    }
    // parent-child link for a chat started from carried context
    const pend = (await store.get(['cts_handoff_pending'])).cts_handoff_pending;
    if (pend && d.convId && d.convId !== pend.fromId && Date.now() - pend.t < 30 * 60 * 1000) {
      await Client.call('conv.setParent', { id: d.convId, parentId: pend.fromId }); await store.remove('cts_handoff_pending');
    }
    await maybeHint();
  }));

  // ─── composer-row entry point (our own slot, only when it exists) ─────────
  function ensureRowButton() {
    if (!F.isEnabled('handoff') || !last) return;
    const slot = document.querySelector('#ct-row-right');
    if (!slot || slot.querySelector('#cts-handoff-btn')) return;
    const b = document.createElement('button');
    b.id = 'cts-handoff-btn'; b.type = 'button'; b.textContent = T('handoffBtn'); b.title = T('handoffBtnTip');
    ['background:none', 'border:1px solid currentColor', 'border-radius:8px', 'padding:1px 8px', 'font:inherit', 'font-size:11px', 'cursor:pointer', 'color:inherit', 'opacity:.8'].forEach(r => { const [k, v] = r.split(':'); b.style[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v; });
    b.addEventListener('click', Safe.wrap('handoff', open));
    slot.appendChild(b);
  }
  setInterval(() => Safe.run('handoff', ensureRowButton), 5000);

  Safe.run('handoff', checkIncoming);
  window.CTS_HandoffUI = { open, contextInfo };
})();
