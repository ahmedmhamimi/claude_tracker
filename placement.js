/**
 * Where each TokenLens 6.0 feature lives on claude.ai (ISOLATED world).
 * Nothing here is a menu of everything: each feature sits where a person
 * already looks for that kind of thing.
 *
 *   Save this chat (PDF / Markdown / Text / JSON)  -> top bar, left of Share (chat pages only)
 *   Continue in a new chat                         -> composer stats row (handoff-ui.js, #ct-row-right)
 *   Search my chats / Save all chats / History /
 *   Settings + the live "at this pace" line        -> a small strip under the usage bars in the sidebar
 *
 * Both surfaces are drawn in closed shadow roots, re-attached whenever claude.ai
 * re-renders around them, and hidden when their feature is switched off.
 *
 * TokenLens Pro: the "at this pace" line is a Pro feature. On the free plan it appears
 * only when the person is heading for their limit, as a clickable teaser ("See when 🔒")
 * that opens the unlock dialog; it never shows the actual time.
 *
 * - (no exports)
 *
 * @requires safe.js, features.js, ui-kit.js, panel.js, recorder.js, license.js, paywall.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe, F = window.CTS_Features, UI = window.CTS_UI, T = UI.T, h = UI.h;
  const W = k => window[k];
  const L = (k, fb) => { const v = T('ix_' + k); return v === 'ix_' + k ? fb : v; };

  const SVG = (inner) => UI.svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>');
  const ICONS = {
    save:     '<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M5 19h14"/>',
    find:     '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.2-4.2"/>',
    bulk:     '<rect x="4" y="5" width="16" height="4" rx="1"/><path d="M6 9v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>',
    history:  '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3-4 3 2 4-6"/>',
    settings: '<path d="M5 8h14"/><circle cx="9" cy="8" r="2"/><path d="M5 16h14"/><circle cx="15" cy="16" r="2"/>',
  };

  const chatId = () => { const m = location.pathname.match(/\/chat\/([A-Za-z0-9-]{8,64})/); return m ? m[1] : null; };
  const inTopBar = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < 100; };
  const open = (screen, anchor) => { const P = W('CTS_Panel'); if (P) P.toggle(screen, anchor); };

  // ─── Top bar: save this chat ──────────────────────────────────────────────
  const TOP_CSS = `
    :host { display: inline-flex; align-items: center; margin-inline: 2px; }
    button { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; background: transparent;
             border: 0; border-radius: 8px; color: var(--text); cursor: pointer; opacity: .85; }
    button:hover { background: var(--surface); opacity: 1; }
    svg { width: 18px; height: 18px; }
  `;
  let top = null, topBornAt = 0;

  function makeTop() {
    const m = UI.mount('cts-save-top', TOP_CSS);
    const label = L('saveThisChat', 'Save this chat');
    const btn = h('button', { type: 'button', 'aria-label': label, title: label });
    btn.appendChild(SVG(ICONS.save));
    btn.addEventListener('click', Safe.wrap('placement', () => open('save', m.host)));
    m.root.appendChild(btn);
    topBornAt = Date.now();
    return { host: m.host, node: null };
  }

  function findShare() {
    return Array.from(document.querySelectorAll('button')).find(b => /^share$/i.test((b.textContent || '').trim()) && inTopBar(b)) || null;
  }

  function syncTop() {
    const want = F.isEnabled('export') && !!chatId();
    if (!want) { if (top) { top.host.remove(); top = null; } return; }
    if (!top) top = makeTop();
    if (top.host.isConnected && top.node && top.node.isConnected && top.host.nextElementSibling === top.node) return;
    const share = findShare();
    if (share) {
      let node = share;
      for (let i = 0; i < 3; i++) {
        const p = node.parentElement;
        if (!p || p === document.body) break;
        if (p.children.length > 1) break;
        node = node.parentElement;
      }
      if (node.parentElement) { node.parentElement.insertBefore(top.host, node); top.node = node; }
      return;
    }
    // No Share button (incognito, narrow layouts): fall back to our own slot in the composer row.
    if (Date.now() - topBornAt > 2500) {
      const slot = document.querySelector('#ct-row-right');
      if (slot && top.host.parentElement !== slot) { slot.appendChild(top.host); top.node = null; }
    }
  }

  // ─── Sidebar strip: search, save all, history, settings, pace ─────────────
  const TOOLS_CSS = `
    :host { display: block; margin: 4px 12px 10px; }
    .pace { margin: 0 2px 6px; font-size: 11.5px; color: var(--muted); }
    .pace[data-locked="1"] { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .t { display: flex; align-items: center; gap: 6px; min-width: 0; background: transparent; color: var(--text); border: 1px solid var(--line);
         border-radius: 8px; padding: 6px 8px; cursor: pointer; font-size: 12px; text-align: start; }
    .t:hover { border-color: var(--btn); background: var(--card); }
    .t span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .t svg { width: 15px; height: 15px; flex: none; }
  `;
  let tools = null;

  function makeTools() {
    const m = UI.mount('cts-sidebar-tools', TOOLS_CSS);
    const pace = h('p', { class: 'pace', 'aria-live': 'polite', hidden: true });
    pace.addEventListener('click', Safe.wrap('placement', () => { if (pace.dataset.locked === '1' && W('CTS_License')) W('CTS_License').gate('pace'); }));
    const grid = h('div', { class: 'grid' });
    const defs = [
      ['find', 'library', L('tFind', 'Search chats'), L('tFindD', 'Search everything in all your chats')],
      ['bulk', 'export', L('tBulk', 'Save all'), L('tBulkD', 'Save every chat as files')],
      ['history', 'history', L('tHistory', 'History'), L('tHistoryD', 'Your usage over the last days')],
      ['settings', null, L('tSettings', 'Settings'), L('tSettingsD', 'TokenLens settings')],
    ];
    const buttons = defs.map(([screen, feature, text, tip]) => {
      const b = h('button', { class: 't', type: 'button', title: tip, 'aria-label': tip });
      b.appendChild(SVG(ICONS[screen]));
      b.appendChild(h('span', { text }));
      b.addEventListener('click', Safe.wrap('placement', () => open(screen, m.host)));
      grid.appendChild(b);
      return { b, feature };
    });
    m.root.append(pace, grid);

    const refresh = () => {
      buttons.forEach(x => { x.b.hidden = !!(x.feature && !F.isEnabled(x.feature)); });
      if (!F.isEnabled('history')) { pace.hidden = true; pace.textContent = ''; }
    };
    const refreshPace = async () => {
      if (!F.isEnabled('history') || !W('CTS_Recorder')) return;
      const p = await W('CTS_Recorder').getPace().catch(() => null);
      const Lic = W('CTS_License'), locked = !!(p && p.willReach && Lic && !Lic.allows('pace'));
      const text = !(p && p.willReach) ? '' : locked ? L('paceLocked2', 'At this pace you may reach your limit before it resets. See when') + ' 🔒'
        : T('paceLine', [W('CTS_Recorder').fmtMinutes(p.minutesBeforeReset)]);
      if (pace.textContent !== text) pace.textContent = text;
      pace.dataset.locked = locked ? '1' : '0';
      pace.hidden = !text;
    };
    refresh(); refreshPace();
    return { host: m.host, refresh, refreshPace };
  }

  function syncTools() {
    const quota = document.getElementById('ct-quota');
    if (!quota || !quota.parentElement) { if (tools && tools.host.isConnected) tools.host.remove(); return; }
    if (!tools) tools = makeTools();
    if (quota.nextElementSibling !== tools.host) quota.after(tools.host);
    // Follow the usage box when the sidebar is collapsed to icons.
    tools.host.style.display = quota.classList.contains('sidebar-hidden') ? 'none' : '';
    tools.refresh();
  }

  // ─── Keep both in place ───────────────────────────────────────────────────
  const tick = () => Safe.run('placement', () => { syncTop(); syncTools(); });
  setInterval(tick, 1200);
  setInterval(() => Safe.run('placement', () => tools && tools.refreshPace()), 30000);
  window.addEventListener('popstate', tick);
  F.onChange(tick);
  if (W('CTS_License')) W('CTS_License').onChange(() => Safe.run('placement', () => tools && tools.refreshPace()));
  tick();
})();
