/**
 * VamimiAI on claude.ai (ISOLATED world). VamimiAI (https://www.vamimi.com) is
 * a website by the maker of TokenLens that turns text into diagrams. This
 * module is the whole hand-off between the two, in four quiet pieces:
 *
 *   1. "Diagram" button - a labelled pill in each assistant reply's action
 *      bar (copy / retry / thumbs). Clicking it opens VamimiAI in a new tab
 *      next to this one with the reply, and the question that prompted it,
 *      already in VamimiAI's message box. Nothing is sent anywhere until the
 *      person presses Send over there.
 *        Only replies with something to draw get it: a list, table, heading
 *        or code block, or at least CFG.minChars of text.
 *
 *   2. "Meet VamimiAI" - a one-time announcement. background.js decides who
 *      is due (vmClaim): people updating from before 6.3 on their next calm
 *      moment, fresh installs only after 3 distinct days of use, never while
 *      the welcome splash is pending and never within a day of another
 *      TokenLens prompt. Exactly one tab claims it.
 *
 *   3. Spotlight - once the announcement has been shown, the newest Diagram
 *      button glows, shakes twice and gets a pointer bubble, on at most
 *      CFG.spotlightPages page loads. It ends for good when the button is
 *      used or the bubble is dismissed.
 *
 *   4. A permanent, quiet "VamimiAI - Text to diagrams" link under the
 *      TokenLens tools in the sidebar (and one in the toolbar popup).
 *
 * HOW THE TEXT TRAVELS
 *   In the URL *fragment* (after "#"), which browsers never send to a server:
 *     #prefill=z.<base64url(deflate-raw(UTF-8 text))>
 *   or, without CompressionStream, the plain form "t.<uri-encoded>" (VamimiAI
 *   reads both - keep in step with its frontend/static/js/core/prefill.js).
 *   Only a reply still too long after compression is cut, at a paragraph
 *   break, with a visible note. The tab is opened by background.js (origin-
 *   locked to VamimiAI), because compressing is async and would lose the
 *   click's user activation, so window.open would be blocked as a popup.
 *
 * Every visit carries utm_source=tokenlens&utm_medium=extension and a
 * campaign naming the surface: diagram_button, announcement, sidebar, popup.
 *
 * - CTS_Vamimi.appUrl(campaign) -> string
 * - CTS_Vamimi.spotlightNow() -> void
 * - CTS_Vamimi.preview() -> void: shows the announcement now (QA)
 *
 * QA: chrome.storage.local.set({ cts_vm_preview: true }) shows the
 * announcement on the next claude.ai page load, then clears itself.
 *
 * @requires safe.js, features.js, theme.js, ui-kit.js
 */

(function () {
  'use strict';

  if (window.top !== window) return;

  const Safe = window.CTS_Safe, UI = window.CTS_UI;
  if (!Safe || !UI) return;
  const h = UI.h;
  const ROOT = document.documentElement;

  const CFG = {
    appUrl: 'https://www.vamimi.com/',
    utm: { source: 'tokenlens', medium: 'extension' },
    minChars: 200,
    maxQuestionChars: 1500,
    maxUrlChars: 1900000,     // under Chrome's 2 MB URL ceiling
    spotlightPages: 3,
    coachMs: 9000,
    scanMs: 1200,
  };
  const SPOT_KEY = 'cts_vm_spot';

  // i18n with an English fallback (keys are prefixed vm_ in messages.json).
  const L = (k, fb, subs) => {
    let v = '';
    try { v = chrome.i18n.getMessage('vm_' + k) || ''; } catch (_) {}
    v = v || fb;
    if (subs) Object.keys(subs).forEach(s => { v = v.split('{' + s + '}').join(subs[s]); });
    return v;
  };

  const store = {
    get: keys => new Promise(res => {
      const ran = Safe.chromeCall('vamimi', () => { chrome.storage.local.get(keys, v => { void chrome.runtime.lastError; res(v || {}); }); return true; });
      if (ran !== true) res({});
    }),
    set: obj => Safe.chromeCall('vamimi', () => chrome.storage.local.set(obj)),
  };
  const send = msg => new Promise(res => {
    const ran = Safe.chromeCall('vamimi', () => { chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; res(r || null); }); return true; });
    if (ran !== true) res(null);
  });

  const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="3.5" width="7" height="5" rx="1.6"/><rect x="14" y="3.5" width="7" height="5" rx="1.6"/><rect x="8.5" y="15.5" width="7" height="5" rx="1.6"/>' +
    '<path d="M6.5 8.5v2.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V8.5"/><path d="M12 12.5v3"/></svg>';
  const icon = () => UI.svg(ICON);

  function appUrl(campaign) {
    const url = new URL(CFG.appUrl);
    url.searchParams.set('utm_source', CFG.utm.source);
    url.searchParams.set('utm_medium', CFG.utm.medium);
    url.searchParams.set('utm_campaign', campaign || 'diagram_button');
    return url.toString();
  }

  // ─── Reading a reply as plain text (markdown-ish) ─────────────────────────

  const SKIP_SEL = 'button, svg, style, script, noscript, textarea, input, [aria-hidden="true"], .ct-chips, .cts-vm-host, [data-testid^="action-bar-"], [id^="cts-"], [id^="ct-"]';
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|FIGURE|FIGCAPTION|BLOCKQUOTE|UL|OL|DL|DT|DD|TABLE|THEAD|TBODY|TFOOT|DETAILS|SUMMARY|HR)$/;

  function toText(root, skipEl) {
    let out = '';
    const tail = () => { const m = out.match(/\n*$/); return m ? m[0].length : 0; };
    const nl = n => { if (!out) return; const t = tail(); if (t < n) out += '\n'.repeat(n - t); };
    const listStack = [];

    function walk(node) {
      if (node.nodeType === 3) {
        const s = node.nodeValue.replace(/\s+/g, ' ');
        if (!s.trim() && /\n$|^$/.test(out)) return;
        out += (/\n$|^$/.test(out) ? s.replace(/^ /, '') : s);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (el === skipEl || (el.matches && el.matches(SKIP_SEL))) return;
      const tag = el.tagName;

      if (/^H[1-6]$/.test(tag)) { nl(2); out += '#'.repeat(+tag[1]) + ' '; el.childNodes.forEach(walk); nl(2); return; }
      if (tag === 'BR') { out += '\n'; return; }
      if (tag === 'PRE') {
        nl(2);
        const code = el.querySelector('code');
        const lang = code && (code.className.match(/language-([\w+-]+)/) || [])[1];
        out += '```' + (lang || '') + '\n' + (el.textContent || '').replace(/\n+$/, '') + '\n```';
        nl(2); return;
      }
      if (tag === 'UL' || tag === 'OL') {
        nl(listStack.length ? 1 : 2);
        listStack.push({ ordered: tag === 'OL', n: 0 });
        el.childNodes.forEach(walk);
        listStack.pop();
        nl(listStack.length ? 1 : 2); return;
      }
      if (tag === 'LI') {
        nl(1);
        const top = listStack[listStack.length - 1] || { ordered: false, n: 0 };
        top.n++;
        out += '  '.repeat(Math.max(0, listStack.length - 1)) + (top.ordered ? top.n + '. ' : '- ');
        el.childNodes.forEach(walk);
        nl(1); return;
      }
      if (tag === 'TR') {
        nl(1);
        const cells = Array.from(el.children).filter(c => /^T[DH]$/.test(c.tagName));
        out += '| ' + cells.map(c => toText(c, null).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()).join(' | ') + ' |';
        if (el.parentElement && el.parentElement.tagName === 'THEAD' || (cells.length && cells.every(c => c.tagName === 'TH'))) {
          out += '\n|' + cells.map(() => ' --- |').join('');
        }
        nl(1); return;
      }
      if (tag === 'HR') { nl(2); out += '---'; nl(2); return; }
      if (tag === 'STRONG' || tag === 'B') { out += '**'; el.childNodes.forEach(walk); out += '**'; return; }
      if (tag === 'CODE') { out += '`' + (el.textContent || '') + '`'; return; }

      const block = BLOCK.test(tag) || tag === 'P';
      if (block) nl(tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'TABLE' ? 2 : 1);
      el.childNodes.forEach(walk);
      if (block) nl(tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'TABLE' ? 2 : 1);
    }

    walk(root);
    return out.replace(/\*\*\s*\*\*/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ─── Finding replies ──────────────────────────────────────────────────────

  const ROWS = '[data-testid="transcript-row"]';
  const BAR_ITEM = '[data-testid^="action-bar-"]';

  function barOf(row) {
    const item = row.querySelector(BAR_ITEM);
    if (!item) return null;
    return item.tagName === 'DIV' && item.querySelector('button') ? item : item.closest('div');
  }

  function hasSomethingToDraw(row, bar) {
    const sel = 'ul li, ol li, table, h1, h2, h3, h4, pre';
    const rich = Array.from(row.querySelectorAll(sel)).some(el => !bar.contains(el));
    if (rich) return true;
    return toText(row, bar).length >= CFG.minChars;
  }

  function questionFor(row) {
    const rows = Array.from(document.querySelectorAll(ROWS));
    for (let i = rows.indexOf(row) - 1; i >= 0; i--) {
      if (!rows[i].querySelector(BAR_ITEM)) return toText(rows[i], null);
    }
    return '';
  }

  // ─── Building the VamimiAI URL ────────────────────────────────────────────

  function buildRequest(question, answer) {
    const max = CFG.maxQuestionChars;
    const q = question.length > max ? question.slice(0, max).trimEnd() + '…' : question;
    const parts = [L('prompt', 'Turn this into a clear diagram. Pick the best type (flowchart, timeline, mind map, table, comparison and so on) for the content.')];
    if (q) parts.push(L('question', 'The question:') + '\n' + q);
    parts.push(L('answer', 'The answer:') + '\n' + answer);
    return parts.join('\n\n');
  }

  async function encode(text) {
    if (typeof CompressionStream === 'undefined') return 't.' + encodeURIComponent(text);
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return 'z.' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function buildUrl(question, answer, campaign, request) {
    const base = appUrl(campaign || 'diagram_button') + '#prefill=';
    const make = request || buildRequest;
    let body = answer;
    for (let attempt = 0; attempt < 8; attempt++) {
      const url = base + (await encode(make(question, body)));
      if (url.length <= CFG.maxUrlChars) return url;
      let cut = Math.floor(body.length * (CFG.maxUrlChars / url.length) * 0.9);
      const para = body.lastIndexOf('\n\n', cut);
      if (para > cut * 0.8) cut = para;
      body = body.slice(0, cut).trimEnd() + '\n\n' + L('trimmed', '[The rest of this reply was cut to fit.]');
    }
    return base + (await encode(make(question.slice(0, 200), body.slice(0, 200000))));
  }

  // The whole chat on screen, as "You: ... / Claude: ..." turns.
  function chatText() {
    const you = L('you', 'You'), claude = 'Claude';
    return Array.from(document.querySelectorAll(ROWS)).map(row => {
      const isReply = !!row.querySelector(BAR_ITEM);
      const t = toText(row, isReply ? barOf(row) : null);
      return t ? '**' + (isReply ? claude : you) + ':**\n' + t : '';
    }).filter(Boolean).join('\n\n');
  }

  // "Turn this chat into a diagram" (menu / save row): the whole conversation.
  async function diagramChat(campaign) {
    const text = chatText();
    if (!text) return openUrl(appUrl(campaign || 'menu'));
    const req = (_q, body) => L('chatPrompt', 'Turn this conversation into a clear diagram. Pick the best type (flowchart, timeline, mind map, table, comparison and so on) for what it covers.') + '\n\n' + body;
    return openUrl(await buildUrl('', text, campaign || 'chat_diagram', req));
  }

  async function openUrl(url) {
    const r = await send({ cts: 'vamimi', op: 'open', url });
    return !!(r && r.ok);
  }

  // ─── 1. The Diagram button ────────────────────────────────────────────────

  const BTN_CSS = `
    :host { display: inline-flex; align-items: center; vertical-align: middle; margin-inline: 4px 2px; }
    button {
      position: relative; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px 0 9px;
      border-radius: 999px; cursor: pointer; white-space: nowrap;
      font: 600 12px/1 var(--sans); letter-spacing: .01em; color: var(--accent);
      background: color-mix(in srgb, var(--accent) 9%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent);
      transition: background .18s ease, border-color .18s ease, transform .18s ease, box-shadow .25s ease;
    }
    button:hover { background: color-mix(in srgb, var(--accent) 16%, transparent); border-color: color-mix(in srgb, var(--accent) 60%, transparent); }
    button:active { transform: scale(.97); }
    button[disabled] { opacity: .7; cursor: progress; }
    button.ok { color: #2f8f5b; border-color: color-mix(in srgb, #2f8f5b 45%, transparent); background: color-mix(in srgb, #2f8f5b 10%, transparent); }
    :host([data-theme="dark"]) button.ok { color: #6ccb92; border-color: color-mix(in srgb, #6ccb92 45%, transparent); background: color-mix(in srgb, #6ccb92 12%, transparent); }
    svg { width: 15px; height: 15px; flex: none; }
    .spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    button.spot { animation: glow 1.8s ease-in-out 3, shake .55s ease-in-out .35s 2; }
    @keyframes glow {
      0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
      50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 22%, transparent), 0 0 18px 2px color-mix(in srgb, var(--accent) 35%, transparent); }
    }
    @keyframes shake { 0%, 100% { transform: translateX(0) } 20% { transform: translateX(-2px) rotate(-2deg) } 40% { transform: translateX(2px) rotate(2deg) } 60% { transform: translateX(-1.5px) } 80% { transform: translateX(1.5px) } }
    @media (prefers-reduced-motion: reduce) { button, button.spot { animation: none; transition: none; } button.spot { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent); } }
  `;

  const buttons = new Set();   // live {host, btn, row}

  function makeButton(row, bar) {
    const m = UI.mount('', BTN_CSS);
    m.host.removeAttribute('id');
    m.host.className = 'cts-vm-host';
    const label = L('label', 'Diagram');
    const tip = L('title', 'Turn this reply into a diagram (opens VamimiAI in a new tab)');
    const btn = h('button', { type: 'button', title: tip, 'aria-label': tip });
    const ic = icon();
    const text = h('span', { text: label });
    btn.append(ic, text);
    m.root.appendChild(btn);

    const rec = { host: m.host, btn, row };
    btn.addEventListener('click', Safe.wrap('vamimi', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      endSpotlight(true);
      const restore = () => { btn.disabled = false; btn.className = ''; text.textContent = label; };
      try {
        const answer = toText(row, barOf(row));
        const url = await buildUrl(questionFor(row), answer);
        const ok = await openUrl(url);
        if (ok) {
          btn.className = 'ok'; text.textContent = L('opened', 'Opened in VamimiAI');
          store.get(['cts_vm_used']).then(s => store.set({ cts_vm_used: (s.cts_vm_used || 0) + 1 }));
        } else {
          text.textContent = L('failed', 'Couldn’t open VamimiAI. Try again');
        }
      } catch (e) {
        text.textContent = L('failed', 'Couldn’t open VamimiAI. Try again');
        Safe.run('vamimi', () => { throw e; });
      }
      setTimeout(restore, 2600);
    }));
    return rec;
  }

  function place(rec, bar) {
    const items = bar.querySelectorAll(BAR_ITEM);
    let anchor = items[items.length - 1];
    while (anchor && anchor.parentElement && anchor.parentElement !== bar) anchor = anchor.parentElement;
    if (anchor && anchor.parentElement === bar) {
      if (anchor.nextSibling !== rec.host) anchor.after(rec.host);
    } else if (rec.host.parentElement !== bar) {
      bar.appendChild(rec.host);
    }
  }

  function scanReplies() {
    // The Diagram buttons can be switched off in Settings (feature 'vamimi').
    // Switched off: the buttons stay in place but hidden, so the inline
    // controls can collapse each one to a small "Diagram" chip (one click
    // brings them back, see inline-controls.js).
    const F = window.CTS_Features;
    const off = !!(F && F.isEnabled && !F.isEnabled('vamimi'));
    if (off) hideCoach();
    buttons.forEach(r => { const want = off ? 'none' : ''; if (r.host.style.display !== want) r.host.style.display = want; });
    const rows = document.querySelectorAll(ROWS);
    rows.forEach(row => {
      const bar = barOf(row);
      if (!bar) return;
      let rec = row.__ctsVm;
      if (rec && rec.host.isConnected && row.contains(rec.host)) { place(rec, bar); return; }
      // Only re-read a row whose text changed since we last judged it
      // (streaming replies and short ones were walked on every scan).
      const sig = (row.textContent || '').length;
      if (!rec && row.__ctsVmSig === sig) return;
      row.__ctsVmSig = sig;
      if (!rec && !hasSomethingToDraw(row, bar)) return;
      rec = rec || makeButton(row, bar);
      if (off) rec.host.style.display = 'none';
      row.__ctsVm = rec;
      buttons.add(rec);
      place(rec, bar);
    });
    buttons.forEach(r => { if (!r.row.isConnected) buttons.delete(r); });
    if (!off && (spot.wantNow || spot.thisPage)) maybeSpotlight();
  }

  function newestButton() {
    let best = null;
    buttons.forEach(r => {
      if (!r.host.isConnected) return;
      if (!best || (best.host.compareDocumentPosition(r.host) & Node.DOCUMENT_POSITION_FOLLOWING)) best = r;
    });
    return best;
  }

  // ─── 3. Spotlight ─────────────────────────────────────────────────────────

  const spot = { state: null, thisPage: false, shownThisPage: false, wantNow: false, counted: false };

  async function loadSpot() {
    const s = await store.get([SPOT_KEY]);
    spot.state = s[SPOT_KEY] || null;
    const st = spot.state;
    spot.thisPage = !!(st && st.armed && !st.done && (st.pages || 0) < CFG.spotlightPages);
  }

  function inView(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }

  function maybeSpotlight() {
    if (spot.shownThisPage || annOpen) return;   // never behind the announcement
    const rec = newestButton();
    if (!rec) return;
    if (!spot.wantNow && !inView(rec.host)) return;
    spot.shownThisPage = true;
    spot.wantNow = false;
    runSpotlight(rec);
    if (spot.state && spot.thisPage && !spot.counted) {
      spot.counted = true;                        // one page load counts once
      const st = Object.assign({}, spot.state, { pages: (spot.state.pages || 0) + 1 });
      if (st.pages >= CFG.spotlightPages) st.done = true;
      spot.state = st;
      store.set({ [SPOT_KEY]: st });
    }
  }

  let coach = null;
  function runSpotlight(rec) {
    rec.btn.classList.remove('spot');
    void rec.btn.offsetWidth;
    rec.btn.classList.add('spot');
    setTimeout(() => rec.btn.classList.remove('spot'), 6000);
    showCoach(rec);
  }

  const COACH_CSS = `
    .b { position: fixed; z-index: 2147483200; max-width: 260px; display: flex; align-items: flex-start; gap: 8px;
         padding: 10px 10px 10px 12px; border-radius: 12px; background: var(--text); color: var(--bg);
         font: 500 12.5px/1.4 var(--sans); box-shadow: 0 12px 32px -8px rgba(0,0,0,.35);
         opacity: 0; transform: translateY(4px); transition: opacity .2s ease, transform .2s ease; }
    .b.vis { opacity: 1; transform: none; }
    .b::after { content: ""; position: absolute; bottom: -5px; left: var(--ax, 22px); width: 10px; height: 10px; background: inherit; transform: rotate(45deg); border-radius: 2px; }
    .b.below::after { bottom: auto; top: -5px; }
    .x { flex: none; width: 20px; height: 20px; margin: -2px -2px 0 0; border: 0; border-radius: 6px; background: transparent; color: inherit; opacity: .7; cursor: pointer; font-size: 15px; line-height: 1; }
    .x:hover { opacity: 1; background: rgba(127,127,127,.25); }
    @media (prefers-reduced-motion: reduce) { .b { transition: none; } }
  `;

  function showCoach(rec) {
    hideCoach();
    const m = UI.mount('cts-vm-coach', COACH_CSS);
    const box = h('div', { class: 'b', role: 'status' },
      h('span', { text: L('coach', 'New: turn this reply into a diagram') }),
      h('button', { class: 'x', type: 'button', 'aria-label': L('dismiss', 'Dismiss'), text: '×', on: { click: () => { hideCoach(); endSpotlight(true); } } }));
    m.root.appendChild(box);
    ROOT.appendChild(m.host);
    let raf = 0;
    const position = () => {
      raf = 0;
      if (!rec.host.isConnected) return hideCoach();
      const r = rec.host.getBoundingClientRect();
      const bw = box.offsetWidth || 220, bh = box.offsetHeight || 40;
      const below = r.top < bh + 16;
      const left = Math.max(8, Math.min(innerWidth - bw - 8, r.left + r.width / 2 - 28));
      box.style.left = left + 'px';
      box.style.top = (below ? r.bottom + 10 : r.top - bh - 10) + 'px';
      box.classList.toggle('below', below);
      box.style.setProperty('--ax', Math.max(10, Math.min(bw - 20, r.left + r.width / 2 - left - 5)) + 'px');
    };
    const onMove = () => { if (!raf) raf = requestAnimationFrame(position); };
    addEventListener('scroll', onMove, true);
    addEventListener('resize', onMove);
    position();
    requestAnimationFrame(() => box.classList.add('vis'));
    coach = { host: m.host, off: () => { removeEventListener('scroll', onMove, true); removeEventListener('resize', onMove); }, timer: setTimeout(hideCoach, CFG.coachMs) };
  }

  function hideCoach() {
    if (!coach) return;
    clearTimeout(coach.timer); coach.off(); coach.host.remove(); coach = null;
  }

  function endSpotlight(forGood) {
    hideCoach();
    spot.thisPage = false; spot.wantNow = false;
    if (forGood && spot.state && !spot.state.done) {
      spot.state = Object.assign({}, spot.state, { done: true });
      store.set({ [SPOT_KEY]: spot.state });
    }
  }

  // Announcement "Show me the button": scroll to the newest one and light it
  // up, or - with no reply on screen yet - say what to do and spotlight the
  // first reply that qualifies.
  function spotlightNow() {
    spot.shownThisPage = false;
    const rec = newestButton();
    if (rec) {
      try { rec.host.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } catch (_) {}
      setTimeout(() => { spot.wantNow = true; maybeSpotlight(); }, 450);
      return;
    }
    spot.wantNow = true;
    UI.toast({ text: L('hint', 'Ask Claude something. The {label} button will appear under its reply.', { label: L('label', 'Diagram') }), timeoutMs: 9000 });
  }

  // ─── 2. The one-time announcement ─────────────────────────────────────────

  const ANN_CSS = `
    .scrim { position: fixed; inset: 0; z-index: 2147483300; background: rgba(20, 18, 16, .42);
             backdrop-filter: blur(6px) saturate(1.1); -webkit-backdrop-filter: blur(6px) saturate(1.1);
             animation: fadeIn .28s ease both; }
    .stage { position: fixed; inset: 0; z-index: 2147483301; display: grid; place-items: center; padding: 20px; pointer-events: none; }
    .vm-card { pointer-events: auto; width: min(460px, 100%); max-height: calc(100vh - 40px); overflow: auto; position: relative;
            background: var(--card); color: var(--text); border: 1px solid var(--line); border-radius: 20px;
            box-shadow: 0 1px 0 rgba(255,255,255,.04) inset, 0 30px 80px -20px rgba(0,0,0,.45), 0 8px 24px -12px rgba(0,0,0,.25);
            animation: rise .42s cubic-bezier(.2,.8,.25,1) both; }
    .close { position: absolute; top: 12px; right: 12px; z-index: 2; width: 30px; height: 30px; border-radius: 9px; border: 0; cursor: pointer;
             background: rgba(255,255,255,.18); color: #fff; font-size: 18px; line-height: 1; backdrop-filter: blur(4px); }
    .close:hover { background: rgba(255,255,255,.3); }

    .hero { position: relative; height: 172px; overflow: hidden; border-radius: 19px 19px 0 0;
            background: radial-gradient(120% 140% at 0% 0%, #E9875F 0%, #C6613F 38%, #7A3A2A 100%); }
    :host([data-palette="ocean"]) .hero { background: radial-gradient(120% 140% at 0% 0%, #6FA8D8 0%, #2B6595 40%, #16334D 100%); }
    :host([data-palette="forest"]) .hero { background: radial-gradient(120% 140% at 0% 0%, #7DC08E 0%, #3B7248 40%, #1B3522 100%); }
    :host([data-palette="mono"]) .hero { background: radial-gradient(120% 140% at 0% 0%, #8A8884 0%, #3A3A38 45%, #1A1A19 100%); }
    .grain { position: absolute; inset: 0; opacity: .5; mix-blend-mode: overlay;
             background-image: radial-gradient(rgba(255,255,255,.35) 1px, transparent 1px); background-size: 14px 14px; }
    .sheen { position: absolute; inset: -40% -10%; background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,.22) 50%, transparent 60%);
             animation: sheen 2.4s ease .5s 1 both; }
    .demo { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 16px; padding: 0 28px; }
    .reply { width: 132px; padding: 12px; border-radius: 12px; background: rgba(255,255,255,.95); box-shadow: 0 10px 24px -8px rgba(0,0,0,.35); }
    .reply i { display: block; height: 6px; margin: 0 0 7px; border-radius: 3px; background: #D9D4C6; width: var(--w); animation: grow .4s ease var(--d) both; transform-origin: left; }
    .reply small { display: block; margin-top: 3px; font: 600 9.5px/1 var(--sans); color: #8A8577; letter-spacing: .06em; text-transform: uppercase; }
    .arrow { flex: none; animation: fadeIn .3s ease .75s both; }
    .flow { display: flex; flex-direction: column; align-items: center; gap: 0; }
    .node { display: block; padding: 6px 12px; border-radius: 8px; background: #fff; color: #7A3A2A; font: 700 10.5px/1 var(--sans);
            box-shadow: 0 6px 16px -6px rgba(0,0,0,.4); animation: pop .35s cubic-bezier(.3,1.5,.5,1) var(--d) both; }
    .node.end { background: #1F1E1D; color: #fff; }
    .link { display: block; width: 2px; height: 12px; background: rgba(255,255,255,.85); animation: grow .2s ease var(--d) both; transform-origin: top; }

    .body { padding: 22px 26px 22px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font: 600 11px/1 var(--sans);
             letter-spacing: .02em; color: var(--accent); background: color-mix(in srgb, var(--accent) 11%, transparent); }
    .badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    h2 { margin: 12px 0 4px; font: 400 30px/1.1 var(--serif); letter-spacing: -.02em; }
    .sub { margin: 0; font-size: 15px; color: var(--text); }
    .desc { margin: 8px 0 0; color: var(--muted); font-size: 13.5px; line-height: 1.5; }
    ol { list-style: none; margin: 18px 0 0; padding: 0; display: grid; gap: 10px; counter-reset: s; }
    li { display: flex; align-items: center; gap: 12px; font-size: 13.5px; counter-increment: s; }
    li::before { content: counter(s); flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%;
                 font: 700 12px/1 var(--sans); color: var(--on-btn); background: var(--btn); }
    .pill { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px 0 7px; margin: 0 2px; vertical-align: middle; border-radius: 999px;
            font: 600 11.5px/1 var(--sans); color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, transparent);
            border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent); }
    .pill svg { width: 13px; height: 13px; }
    .cta { display: block; width: 100%; margin-top: 22px; min-height: 44px; border: 0; border-radius: 12px; cursor: pointer;
           font: 600 14.5px/1 var(--sans); color: var(--on-btn); background: var(--btn);
           box-shadow: 0 1px 0 rgba(255,255,255,.18) inset, 0 8px 20px -8px color-mix(in srgb, var(--btn) 70%, transparent);
           transition: transform .15s ease, filter .15s ease; }
    .cta:hover { filter: brightness(1.06); }
    .cta:active { transform: translateY(1px); }
    .visit { display: block; margin: 12px auto 0; padding: 4px 6px; border: 0; background: none; cursor: pointer; color: var(--muted);
             font: 500 13px/1.2 var(--sans); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line); }
    .visit:hover { color: var(--text); text-decoration-color: currentColor; }
    .privacy { display: flex; align-items: center; justify-content: center; gap: 6px; margin: 14px 0 0; font-size: 11.5px; color: var(--muted); }
    .privacy svg { width: 13px; height: 13px; flex: none; }

    @keyframes fadeIn { from { opacity: 0 } }
    @keyframes rise { from { opacity: 0; transform: translateY(14px) scale(.98) } }
    @keyframes grow { from { transform: scaleX(0); opacity: 0 } }
    .link { animation-name: growY; } @keyframes growY { from { transform: scaleY(0); opacity: 0 } }
    @keyframes pop { from { transform: scale(.6); opacity: 0 } }
    @keyframes sheen { from { transform: translateX(-60%) } to { transform: translateX(60%) } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  `;

  let annOpen = false;

  function showAnnouncement() {
    if (annOpen) return;
    annOpen = true;
    const m = UI.mount('cts-vamimi-host', ANN_CSS);
    const prevFocus = document.activeElement;
    const label = L('label', 'Diagram');

    const pill = () => { const p = h('span', { class: 'pill' }); p.append(icon(), h('span', { text: label })); return p; };
    const s2 = L('step2', 'Click {label} under the reply', { label: '\u0000' }).split('\u0000');
    const step2 = h('li', null, h('span', null, s2[0] || '', pill(), s2[1] || ''));

    const lockSvg = UI.svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>');
    const arrow = UI.svg('<svg class="arrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 16" width="40" height="16" aria-hidden="true"><path d="M2 8h32M28 3l6 5-6 5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>');

    const node = (text, d, end) => h('b', { class: 'node' + (end ? ' end' : ''), style: '--d:' + d + 'ms', text });
    const link = d => h('span', { class: 'link', style: '--d:' + d + 'ms' });
    const reply = h('div', { class: 'reply' },
      h('i', { style: '--d:300ms;--w:88%' }), h('i', { style: '--d:380ms;--w:70%' }),
      h('i', { style: '--d:460ms;--w:80%' }), h('i', { style: '--d:540ms;--w:56%' }),
      h('small', { text: L('demo1', 'Reply') }));
    const flow = h('div', { class: 'flow' },
      node(L('demo2', 'Step') + ' 1', 900), link(1060), node(L('demo2', 'Step') + ' 2', 1160), link(1320), node(L('demo3', 'Diagram'), 1420, true));

    const close = h('button', { class: 'close', type: 'button', 'aria-label': L('close', 'Close'), text: '×' });
    const cta = h('button', { class: 'cta', type: 'button', text: L('cta', 'Show me the button') });
    // Not Pro yet? The same visit unlocks TokenLens Pro for good.
    const Lic = window.CTS_License;
    const canUnlock = !!(Lic && Lic.unlockWithVamimi && !Lic.state().pro);
    const visit = h('button', { class: 'visit', type: 'button', text: canUnlock ? L('visitUnlock', 'Or visit vamimi.com and unlock TokenLens Pro free') : L('visit', 'Or visit vamimi.com') });

    const card = h('section', { class: 'vm-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'vm-t', 'aria-describedby': 'vm-s' },
      close,
      h('div', { class: 'hero', 'aria-hidden': 'true' }, h('div', { class: 'grain' }), h('div', { class: 'sheen' }), h('div', { class: 'demo' }, reply, arrow, flow)),
      h('div', { class: 'body' },
        h('span', { class: 'badge', text: L('badge', 'New from the maker of TokenLens') }),
        h('h2', { id: 'vm-t', text: L('annTitle', 'Meet VamimiAI') }),
        h('p', { class: 'sub', id: 'vm-s', text: L('annSub', 'A website that turns text into diagrams.') }),
        h('p', { class: 'desc', text: L('annBody', 'Flowcharts, timelines, mind maps and tables, made from any Claude reply in one click.') }),
        h('ol', null,
          h('li', { text: L('step1', 'Ask Claude anything') }),
          step2,
          h('li', { text: L('step3', 'VamimiAI opens with the reply ready. Press Send to get your diagram.') })),
        cta, visit,
        (() => { const p = h('p', { class: 'privacy' }); p.append(lockSvg, h('span', { text: L('privacy', 'Nothing is sent until you press Send on VamimiAI.') })); return p; })()));

    const scrim = h('div', { class: 'scrim' });
    m.root.append(scrim, h('div', { class: 'stage' }, card));
    ROOT.appendChild(m.host);

    const done = () => {
      if (!annOpen) return;
      annOpen = false;
      removeEventListener('keydown', onKey, true);
      m.host.remove();
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (_) {}
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); done(); }
      if (e.key === 'Tab') {
        const f = [close, cta, visit];
        const i = f.indexOf(m.root.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    };
    addEventListener('keydown', onKey, true);
    close.addEventListener('click', done);
    scrim.addEventListener('click', done);
    cta.addEventListener('click', Safe.wrap('vamimi', () => { done(); spotlightNow(); }));
    visit.addEventListener('click', Safe.wrap('vamimi', () => {
      if (canUnlock) Lic.unlockWithVamimi('announcement'); else openUrl(appUrl('announcement'));
      done();
    }));
    setTimeout(() => cta.focus(), 60);

    // The spotlight is armed by the announcement (background.js stamped it).
    loadSpot();
  }

  // When is a calm moment for it? The same rules the other TokenLens prompts use.
  let lastInput = 0;
  ['keydown', 'pointerdown'].forEach(ev => document.addEventListener(ev, () => { lastInput = Date.now(); }, { capture: true, passive: true }));
  const OTHER_SURFACES = ['cts-welcome-host', 'cts-review-host', 'cts-feedback-host', 'ct-whatsnew', 'ct-hint', 'cts-toast-host', 'cts-paywall-host'];

  function momentIsRight() {
    if (document.visibilityState !== 'visible') return false;
    if (!document.getElementById('ct-toolbar-quota')) return false;          // TokenLens UI is up
    if (ROOT.dataset.ctsWelcome === 'active') return false;
    if (OTHER_SURFACES.some(id => document.getElementById(id))) return false;
    if (Date.now() - lastInput < 3000) return false;
    if (!UI.isCalm()) return false;
    return true;
  }

  let annFinal = false, dwell = 0, claiming = false;
  async function annTick() {
    if (annFinal || annOpen || claiming) return;
    if (!momentIsRight()) { dwell = 0; return; }
    if (++dwell < 3) return;
    claiming = true;
    try {
      const s = await store.get(['cts_vm_preview']);
      if (s.cts_vm_preview === true) {
        store.set({ cts_vm_preview: false });
        annFinal = true; showAnnouncement(); return;
      }
      const r = await send({ cts: 'vamimi', op: 'claim' });
      if (!r) return;
      if (r.final) annFinal = true;
      if (r.claimed) { annFinal = true; setTimeout(showAnnouncement, 400); }
    } finally { claiming = false; dwell = 0; }
  }

  // ─── 4. The permanent sidebar link ────────────────────────────────────────

  const LINK_CSS = `
    :host { display: block; margin: 0 12px 10px; }
    a { display: flex; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 10px; color: var(--text); text-decoration: none;
        border: 1px solid transparent; transition: background .15s ease, border-color .15s ease; }
    a:hover { background: var(--card); border-color: var(--line); }
    a:focus-visible { outline: 2px solid var(--btn); outline-offset: 1px; }
    .tile { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; color: #fff;
            background: linear-gradient(135deg, #E9875F, #B9573A); box-shadow: 0 4px 10px -4px rgba(185,87,58,.6); }
    :host([data-palette="ocean"]) .tile { background: linear-gradient(135deg, #6FA8D8, #2B6595); box-shadow: 0 4px 10px -4px rgba(43,101,149,.6); }
    :host([data-palette="forest"]) .tile { background: linear-gradient(135deg, #7DC08E, #3B7248); box-shadow: 0 4px 10px -4px rgba(59,114,72,.6); }
    :host([data-palette="mono"]) .tile { background: linear-gradient(135deg, #8A8884, #3A3A38); box-shadow: none; }
    .tile svg { width: 16px; height: 16px; }
    .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; line-height: 1.2; }
    .txt b { font-size: 13px; font-weight: 600; }
    .txt small { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .go { flex: none; width: 14px; height: 14px; color: var(--muted); opacity: 0; transform: translateX(-3px); transition: opacity .15s ease, transform .15s ease; }
    a:hover .go, a:focus-visible .go { opacity: 1; transform: none; }
  `;
  let sideLink = null;

  function makeLink() {
    const m = UI.mount('cts-vm-link', LINK_CSS);
    const a = h('a', { href: appUrl('sidebar'), target: '_blank', rel: 'noopener', title: L('linkTip', 'Open VamimiAI, which turns text into diagrams (new tab)') });
    const tile = h('span', { class: 'tile', 'aria-hidden': 'true' }); tile.appendChild(icon());
    const go = UI.svg('<svg class="go" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>');
    a.append(tile, h('span', { class: 'txt' }, h('b', { text: 'VamimiAI' }), h('small', { text: L('linkSub', 'Text to diagrams') })), go);
    m.root.appendChild(a);
    return m.host;
  }

  function syncLink() {
    const quota = document.getElementById('ct-quota');
    if (!quota || !quota.parentElement) { if (sideLink && sideLink.isConnected) sideLink.remove(); return; }
    if (!sideLink) sideLink = makeLink();
    const after = document.getElementById('cts-sidebar-tools') || quota;
    if (after.parentElement && after.nextElementSibling !== sideLink) after.after(sideLink);
    sideLink.style.display = quota.classList.contains('sidebar-hidden') ? 'none' : '';
  }

  // ─── Loop ─────────────────────────────────────────────────────────────────

  let scanQueued = false;
  const scanSoon = () => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; Safe.run('vamimi', () => { scanReplies(); syncLink(); }); }, 250);
  };

  function start() {
    loadSpot();
    Safe.run('vamimi', () => { scanReplies(); syncLink(); });
    setInterval(() => Safe.run('vamimi', () => { scanReplies(); syncLink(); }), CFG.scanMs);
    setInterval(() => { annTick().catch(() => {}); }, 1000);
    try {
      new MutationObserver(scanSoon).observe(document.body || ROOT, { childList: true, subtree: true });
    } catch (_) {}
    addEventListener('scroll', () => { if (spot.thisPage && !spot.shownThisPage) scanSoon(); }, { passive: true, capture: true });
  }

  window.CTS_Vamimi = { appUrl, spotlightNow, preview: showAnnouncement, diagramChat, open: c => openUrl(appUrl(c)), icon, _toText: toText, _buildUrl: buildUrl };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
