/**
 * Inline controls (ISOLATED world): every TokenLens surface carries its own
 * small "⋯" button, right next to it, instead of hiding its options behind
 * Settings. Hover a surface and the button appears at its corner; click it
 * for that surface's options:
 *
 *   sidebar box / floating card / composer row -> hide it, color bars by
 *                                                 level, bar color
 *   floating card                              -> also peak & cache badges
 *   peak & cache badges, reply stats, chat dates, sidebar shortcuts,
 *   VamimiAI link, Diagram buttons             -> hide them
 *
 * Hiding shows a toast with Undo. Hidden surfaces come back from TokenLens
 * menu > Settings (the toolbar popup links there too), which still lists
 * every switch.
 *
 * One fixed-position button and one popover for the whole page, both in
 * closed shadow roots. Nothing is injected into claude.ai's DOM or into the
 * surfaces themselves, so it works the same for MAIN-world widgets and for
 * shadow-hosted ones, and survives claude.ai re-rendering them.
 *
 * - CTS_InlineControls.SURFACES -> object: surface key -> {sel, label, ...}
 *
 * @requires safe.js, features.js, ui-kit.js, bridge2.js (CTS_Bus.saveSettings), panel.js
 */

(function () {
  'use strict';

  if (window.top !== window) return;
  const Safe = window.CTS_Safe, F = window.CTS_Features, UI = window.CTS_UI;
  if (!Safe || !F || !UI || !F.ui) return;
  const h = UI.h;
  const L = (k, fb) => { const v = UI.T('ix_' + k); return v === 'ix_' + k ? fb : v; };

  // where: corner of the surface the button sits on, plus an offset (px).
  // bars: offers the bar options (level colors, bar color).
  const SURFACES = {
    // The peak & cache badges have no hover control of their own: their switch
    // lives in the floating card's menu (one place, not two). hover: false
    // keeps the key for settings, the collapsed chip and the card's toggle.
    badges:   { sel: '#ct-tq-badges',      label: () => L('uiBadges', 'Peak and cache badges'),       where: ['tl', -10, -10], hover: false },
    // The card already has its own close (x) button, so its menu has no
    // "Hide this"; the button sits at the card's top-right corner.
    floating: { sel: '#ct-toolbar-quota',  label: () => L('uiFloating', 'Floating usage card'),       where: ['tr', -10, -10], bars: true, extra: ['badges'], noHide: true },
    sidebar:  { sel: '#ct-quota',          label: () => L('uiSidebar', 'Usage box in the sidebar'),   where: ['tr', -2, -4], bars: true },
    composer: { sel: '#ct-row',            label: () => L('uiComposer', 'Usage bar above the message box'), where: ['tl', -6, -6], bars: true },
    chips:    { sel: '.ct-chips',          label: () => L('uiChips', 'Stats under each reply'),       where: ['r', 4, 0] },
    dates:    { sel: '.ct-chat-date',      label: () => L('uiDates', 'Dates next to chat titles'),    where: ['l', -26, 0] },
    tools:    { sel: '#cts-sidebar-tools', label: () => L('uiTools', 'Sidebar shortcuts'),           where: ['tr', -2, -10] },
    vmLink:   { sel: '#cts-vm-link',       label: () => L('uiVmLink', 'VamimiAI shortcut in the sidebar'), where: ['tl', -6, -6] },
    diagram:  { sel: '.cts-vm-host',       label: () => L('uiDiagram', 'Diagram button on replies'), where: ['r', 4, 0], feature: 'vamimi' },
  };
  const ORDER = Object.keys(SURFACES);

  const isOn = key => (SURFACES[key].feature ? F.isEnabled(SURFACES[key].feature) : F.ui(key));
  const Bus = () => window.CTS_Bus;
  function setOn(key, on) {
    const s = SURFACES[key];
    return Bus().saveSettings(st => {
      if (s.feature) { st.features = Object.assign({}, st.features, { [s.feature]: on }); return; }
      st.ui = Object.assign({}, st.ui, { [key]: on });
    });
  }
  const setSetting = (path, value) => Bus().saveSettings(st => {
    const p = path.split('.'); let o = st;
    p.slice(0, -1).forEach(k => { o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}; });
    o[p[p.length - 1]] = value;
  });

  // ─── The one hover button ─────────────────────────────────────────────────
  const BTN_CSS = `
    :host { all: initial; }
    button { position: fixed; z-index: 2147482990; width: 22px; height: 22px; padding: 0; display: grid; place-items: center;
             border-radius: 50%; border: 1px solid var(--line); background: var(--card); color: var(--muted); cursor: pointer;
             box-shadow: 0 2px 8px rgba(0,0,0,.14); opacity: 0; transform: scale(.85); pointer-events: none;
             transition: opacity .12s ease, transform .12s ease, color .12s ease; }
    button.vis { opacity: 1; transform: none; pointer-events: auto; }
    button:hover, button[aria-expanded="true"] { color: var(--text); border-color: var(--btn); }
    button:focus-visible { outline: 2px solid var(--btn); outline-offset: 2px; }
    svg { width: 14px; height: 14px; }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;
  let btnHost = null, btn = null, current = null, hideTimer = 0;

  function ensureButton() {
    if (btnHost && btnHost.isConnected) return;
    const m = UI.mount('cts-ic-btn', BTN_CSS);
    btn = h('button', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    btn.appendChild(UI.svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/></svg>'));
    btn.addEventListener('click', Safe.wrap('inline', e => { e.stopPropagation(); if (menu && menu.key === current.key) closeMenu(); else openMenu(current); }));
    btn.addEventListener('pointerenter', () => clearTimeout(hideTimer));
    btn.addEventListener('pointerleave', () => scheduleHide());
    m.root.appendChild(btn);
    document.documentElement.appendChild(m.host);
    btnHost = m.host;
  }

  function place(el, where) {
    const r = el.getBoundingClientRect();
    const [corner, dx, dy] = where;
    const size = 22;
    let x, y;
    if (corner === 'tl') { x = r.left + dx; y = r.top + dy; }
    else if (corner === 'tr') { x = r.right - size - dx; y = r.top + dy; }
    else if (corner === 'bl') { x = r.left + dx; y = r.bottom - size - dy; }
    else if (corner === 'r') { x = r.right + dx; y = r.top + r.height / 2 - size / 2 + dy; }
    else { x = r.left + dx; y = r.top + r.height / 2 - size / 2 + dy; }      // 'l'
    btn.style.left = Math.max(4, Math.min(innerWidth - size - 4, Math.round(x))) + 'px';
    btn.style.top = Math.max(4, Math.min(innerHeight - size - 4, Math.round(y))) + 'px';
  }

  function show(key, el) {
    if (document.documentElement.classList.contains('ct-dragging') || document.querySelector('#ct-toolbar-quota.ct-dragging')) return;
    ensureButton();
    clearTimeout(hideTimer);
    current = { key, el };
    const label = SURFACES[key].label();
    btn.setAttribute('aria-label', L('icOptions', 'Options') + ': ' + label);
    btn.title = label;
    place(el, SURFACES[key].where);
    btn.classList.add('vis');
  }

  function scheduleHide(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!menu && btn) { btn.classList.remove('vis'); current = null; } }, ms == null ? 350 : ms);
  }

  // Which surface is under the pointer? Innermost registered one wins
  // (badges inside the floating card, Diagram button inside a reply).
  function surfaceFor(path) {
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      if (node === btnHost || (menu && node === menu.host)) return 'self';
      for (const key of ORDER) {
        if (SURFACES[key].hover === false || !isOn(key)) continue;
        try { if (node.matches(SURFACES[key].sel)) return { key, el: node }; } catch (_) {}
      }
    }
    return null;
  }

  document.addEventListener('pointerover', Safe.wrap('inline', e => {
    if (e.pointerType === 'touch') return;
    const hit = surfaceFor(e.composedPath ? e.composedPath() : []);
    if (hit === 'self') { clearTimeout(hideTimer); return; }
    if (hit) { if (!menu) show(hit.key, hit.el); else clearTimeout(hideTimer); return; }
    if (current) scheduleHide();
  }), true);
  addEventListener('scroll', () => { if (!menu && btn) { btn.classList.remove('vis'); current = null; } }, { capture: true, passive: true });

  // Chat dates are drawn with pointer-events: none (purely decorative); let
  // them take hover so their own control can appear next to them.
  const st = document.createElement('style');
  st.textContent = '.ct-chat-date { pointer-events: auto !important; }';
  (document.head || document.documentElement).appendChild(st);

  // ─── The popover ──────────────────────────────────────────────────────────
  const MENU_CSS = `
    .m { position: fixed; z-index: 2147482995; min-width: 230px; max-width: 280px; padding: 6px; border-radius: 12px;
         background: var(--bg); color: var(--text); border: 1px solid var(--line); box-shadow: var(--shadow); font-size: 13px; }
    .t { padding: 6px 8px 4px; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
    .it { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 8px; border: 0; border-radius: 8px; background: none;
          color: inherit; font: inherit; text-align: start; cursor: pointer; }
    .it:hover, .it:focus-visible { background: var(--surface); outline: none; }
    .it svg { width: 15px; height: 15px; flex: none; color: var(--muted); }
    .it .sp { flex: 1; }
    .ck { flex: none; width: 30px; height: 18px; border-radius: 99px; background: var(--line); position: relative; transition: background .15s ease; }
    .ck::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff;
                 box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s ease; }
    .it[aria-checked="true"] .ck { background: var(--btn); }
    .it[aria-checked="true"] .ck::after { transform: translateX(12px); }
    .sep { height: 1px; margin: 4px 6px; background: var(--line); }
    .sw { display: flex; flex-wrap: wrap; gap: 7px; padding: 6px 8px 8px; }
    .dot { position: relative; width: 22px; height: 22px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; background: var(--c);
           box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
    .dot[aria-checked="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--c); }
    .dot.custom { background: conic-gradient(#E5484D, #E0A030, #3F9D5C, #3B82C4, #8B5CF6, #E05A8A, #E5484D); overflow: hidden; }
    .dot.custom[aria-checked="true"] { background: var(--c); }
    .dot input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: 0; padding: 0; }
    .lnk { color: var(--muted); font-size: 12px; }
    @media (prefers-reduced-motion: reduce) { .ck, .ck::after { transition: none; } }
  `;
  const EYE_OFF = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.2 2.3-2.3 3.5M6.6 6.6C4.4 8 2.8 10.1 2 12c1 2.5 5 7 10 7 1.6 0 3.1-.5 4.4-1.2"/></svg>';
  const GEAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8h14"/><circle cx="9" cy="8" r="2"/><path d="M5 16h14"/><circle cx="15" cy="16" r="2"/></svg>';
  const PRESETS = [
    ['auto', 'Claude', '#D97757'], ['ocean', 'Ocean', '#2B6595'], ['forest', 'Forest', '#3B7248'],
    ['violet', 'Violet', '#6D4BD8'], ['rose', 'Rose', '#C2416E'], ['mono', 'Mono', '#6B6A66'],
  ];

  let menu = null;

  function closeMenu(refocus) {
    if (!menu) return;
    removeEventListener('keydown', menu.onKey, true);
    document.removeEventListener('pointerdown', menu.onDown, true);
    menu.host.remove();
    menu = null;
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
    scheduleHide(600);
  }

  function openMenu(cur) {
    closeMenu();
    if (!cur) return;
    const s = SURFACES[cur.key];
    const m = UI.mount('cts-ic-menu', MENU_CSS);
    const box = h('div', { class: 'm', role: 'menu', 'aria-label': s.label() });
    const item = (icon, text, onClick, extra) => {
      const b = h('button', Object.assign({ class: 'it', type: 'button', role: 'menuitem' }, extra || {}));
      if (icon) b.appendChild(UI.svg(icon));
      b.append(h('span', { class: 'sp', text }));
      b.addEventListener('click', Safe.wrap('inline', onClick));
      return b;
    };
    const toggle = (text, get, set) => {
      const b = item(null, text, () => { const v = !get(); b.setAttribute('aria-checked', String(v)); set(v); }, { role: 'menuitemcheckbox', 'aria-checked': String(get()) });
      b.appendChild(h('span', { class: 'ck', 'aria-hidden': 'true' }));
      return b;
    };

    box.append(h('div', { class: 't', text: s.label() }));
    if (!s.noHide) box.append(item(EYE_OFF, L('icHide', 'Hide this'), () => hideSurface(cur.key)));
    (s.extra || []).forEach(k => box.append(toggle(L('icShow', 'Show') + ': ' + SURFACES[k].label(), () => isOn(k), v => setOn(k, v))));

    if (s.bars) {
      box.append(h('div', { class: 'sep' }));
      box.append(toggle(L('uiLevel', 'Color bars by level'), () => F.ui('levelColors'), v => setSetting('ui.levelColors', v)));
      let pal = F.getSetting('theme.palette', 'auto'); if (pal === 'warm') pal = 'auto';
      const acc = /^#[0-9a-f]{6}$/i.test(F.getSetting('theme.accent', '') || '') ? F.getSetting('theme.accent') : '#D97757';
      const sw = h('div', { class: 'sw', role: 'radiogroup', 'aria-label': L('sTheme', 'Bar color') });
      const dots = [];
      const mark = k => dots.forEach(d => d.setAttribute('aria-checked', String(d.dataset.k === k)));
      PRESETS.forEach(([k, name, col]) => {
        const d = h('button', { class: 'dot', type: 'button', role: 'radio', 'aria-checked': String(pal === k), title: L('pal' + name, name), 'aria-label': L('pal' + name, name), style: '--c:' + col, 'data-k': k,
          on: { click: () => { mark(k); setSetting('theme.palette', k); } } });
        dots.push(d); sw.append(d);
      });
      const pick = h('input', { type: 'color', value: acc, 'aria-label': L('palCustom', 'Your own color') });
      const custom = h('label', { class: 'dot custom', role: 'radio', 'aria-checked': String(pal === 'custom'), title: L('palCustom', 'Your own color'), style: '--c:' + acc, 'data-k': 'custom' }, pick);
      pick.addEventListener('change', Safe.wrap('inline', () => {
        custom.style.setProperty('--c', pick.value); mark('custom');
        Bus().saveSettings(st => { st.theme = Object.assign({}, st.theme, { palette: 'custom', accent: pick.value }); });
      }));
      dots.push(custom); sw.append(custom);
      box.append(h('div', { class: 't', text: L('icBarColor', 'Bar color') }), sw);
    }

    box.append(h('div', { class: 'sep' }));
    box.append(item(GEAR, L('icAll', 'All settings'), () => { closeMenu(); if (window.CTS_Panel) window.CTS_Panel.open('settings'); }, { class: 'it lnk' }));

    m.root.appendChild(box);
    document.documentElement.appendChild(m.host);
    // Beside the button, kept on screen.
    const r = btn.getBoundingClientRect();
    const bw = box.offsetWidth || 240, bh = box.offsetHeight || 200;
    let left = r.right + 6, top = r.top;
    if (left + bw > innerWidth - 8) left = r.left - bw - 6;
    if (left < 8) left = Math.max(8, Math.min(innerWidth - bw - 8, r.left));
    if (top + bh > innerHeight - 8) top = Math.max(8, innerHeight - bh - 8);
    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(top) + 'px';

    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); closeMenu(true); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(box.querySelectorAll('.it'));
        const i = items.indexOf(m.root.activeElement);
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      }
    };
    const onDown = e => {
      const path = e.composedPath ? e.composedPath() : [];
      if (path.includes(m.host) || path.includes(btnHost)) return;
      closeMenu();
    };
    addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    menu = { host: m.host, key: cur.key, onKey, onDown };
    btn.setAttribute('aria-expanded', 'true');
    const first = box.querySelector('.it');
    if (first) first.focus({ preventScroll: true });
  }

  function hideSurface(key) {
    closeMenu();
    if (btn) { btn.classList.remove('vis'); current = null; }
    setOn(key, false).then(() => {
      UI.toast({
        text: SURFACES[key].label() + ': ' + L('icHidden2', 'hidden. Click \u201cShow\u201d in its place to bring it back.'),
        timeoutMs: 9000,
        actions: [{ label: L('icUndo', 'Undo'), onClick: () => setOn(key, true) }],
      });
    });
  }

  // ─── Collapsed in place ───────────────────────────────────────────────────
  // A hidden surface is not gone: it collapses to a small "Show …" chip in
  // the exact spot it occupied, one click brings it back. The surface stays
  // in the DOM (CSS hides it, see ui.js applyPrefs), so the chip is simply
  // inserted right before it and follows it wherever claude.ai moves it.
  // Chat dates are many small badges, so they collapse to one chip above the
  // chat list. The floating card's chip floats where the card was.
  const GHOST = {
    sidebar:  { text: () => L('ghSidebar', 'Show usage'),          when: el => !el.classList.contains('sidebar-hidden') },
    floating: { text: () => L('ghFloating', 'Show usage card'),    fixed: true },
    composer: { text: () => L('ghComposer', 'Show usage bar'),     when: el => el.classList.contains('ct-has-data') },
    badges:   { text: () => L('ghBadges', 'Show badges'),          inside: true },
    chips:    { text: () => L('ghChips', 'Stats') },
    dates:    { text: () => L('ghDates', 'Show dates'),            single: true },
    tools:    { text: () => L('ghTools', 'Show shortcuts') },
    vmLink:   { text: () => L('ghVmLink', 'Show VamimiAI') },
    diagram:  { text: () => L('ghDiagram', 'Diagram'),             icon: true },
  };
  const EYE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
  const GHOST_CSS = `
    :host { all: initial; display: inline-flex; vertical-align: middle; }
    :host([data-block]) { display: flex; margin: 6px 12px; }
    :host([data-fixed]) { position: fixed; z-index: 9997; }
    button { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px 0 8px; border-radius: 999px; cursor: pointer;
             font: 600 11.5px/1 var(--sans); color: var(--muted); background: transparent; border: 1px dashed var(--line);
             opacity: .75; transition: opacity .15s ease, color .15s ease, border-color .15s ease, background .15s ease; white-space: nowrap; }
    :host([data-fixed]) button { background: var(--card); border-style: solid; box-shadow: 0 4px 14px rgba(0,0,0,.12); opacity: .9; }
    button:hover, button:focus-visible { opacity: 1; color: var(--text); border-color: var(--btn); border-style: solid; background: var(--card); outline: none; }
    svg { width: 14px; height: 14px; flex: none; }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;
  const ghosts = new Map();   // element -> {host, key}

  function makeGhost(key) {
    const g = GHOST[key];
    const m = UI.mount('', GHOST_CSS);
    m.host.removeAttribute('id');
    m.host.className = 'cts-ghost';
    m.host.setAttribute('data-key', key);
    const label = g.text();
    const b = h('button', { type: 'button', title: SURFACES[key].label(), 'aria-label': L('icShow', 'Show') + ': ' + SURFACES[key].label() });
    b.appendChild(UI.svg(EYE));
    b.appendChild(h('span', { text: label }));
    b.addEventListener('click', Safe.wrap('inline', e => { e.preventDefault(); e.stopPropagation(); setOn(key, true).then(syncGhosts); }));
    m.root.appendChild(b);
    return m.host;
  }

  function anchorsFor(key) {
    const g = GHOST[key];
    let els = Array.from(document.querySelectorAll(SURFACES[key].sel));
    if (key === 'dates') {
      // one chip, just above the first chat in the sidebar list
      const first = document.querySelector('[data-testid="sidebar"] a[href^="/chat/"], aside a[href^="/chat/"], nav a[href^="/chat/"]');
      return first ? [first] : [];
    }
    if (g.when) els = els.filter(g.when);
    return els;
  }

  function placeFixed(host, card) {
    const cs = getComputedStyle(card);
    host.style.top = cs.top !== 'auto' ? cs.top : '68px';
    if (card.style.left) { host.style.left = cs.left; host.style.right = 'auto'; }
    else { host.style.right = cs.right !== 'auto' ? cs.right : '20px'; host.style.left = 'auto'; }
  }

  function syncGhosts() {
    const want = new Set();
    ORDER.forEach(key => {
      if (isOn(key)) return;
      const g = GHOST[key];
      anchorsFor(key).forEach(el => {
        want.add(el);
        let rec = ghosts.get(el);
        if (!rec || rec.key !== key) { if (rec) rec.host.remove(); rec = { host: makeGhost(key), key }; ghosts.set(el, rec); }
        const host = rec.host;
        if (g.fixed) {
          host.setAttribute('data-fixed', '');
          placeFixed(host, el);
          if (host.parentNode !== document.documentElement) document.documentElement.appendChild(host);
        } else if (g.inside) {
          if (host.parentNode !== el) el.appendChild(host);
        } else {
          if (key === 'sidebar' || key === 'composer' || key === 'tools' || key === 'vmLink' || key === 'dates') host.setAttribute('data-block', '');
          if (host.nextSibling !== el && el.parentNode) el.parentNode.insertBefore(host, el);
        }
      });
    });
    ghosts.forEach((rec, el) => {
      if (!want.has(el) || !el.isConnected) { rec.host.remove(); ghosts.delete(el); }
    });
  }

  if (F.onChange) F.onChange(() => Safe.run('inline', syncGhosts));
  setInterval(() => Safe.run('inline', syncGhosts), 1200);
  setTimeout(() => Safe.run('inline', syncGhosts), 300);

  window.CTS_InlineControls = { SURFACES, syncGhosts };
})();
