/**
 * TokenLens menu (ISOLATED world): a small popover, not a big panel.
 * It shows 3-4 big choices per step, one step at a time, with a Back button.
 * It never dims or blocks the page and does not close when you click elsewhere;
 * close it with the X, Escape, or the top-bar button.
 *
 *   menu     -> My usage | Find an old chat | Save chats | Settings
 *   usage    -> 5h / 7d bars, pace, long-chat helper, "show last days" chart
 *   find     -> one-time "read my chats" step, then a search box
 *   save     -> this chat as Markdown / PDF / Text, or all chats
 *   settings -> 3 switches + delete my data
 *
 * Openers (see placement.js): the top-bar Save button (next to Share), the sidebar
 * tools strip (Search / Save all / History / Settings), the 'cts2:open-panel'
 * event (detail.screen optional), and alert toasts.
 *
 * - CTS_Panel.open(screen?, anchorEl?) / toggle(screen, anchorEl) / close() / isOpen()
 *
 * @requires safe.js, features.js, ui-kit.js, client.js, exporter.js, indexer.js, history.js, charts.js, recorder.js, bridge2.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe, F = window.CTS_Features, UI = window.CTS_UI, T = UI.T, h = UI.h;
  const W = k => window[k];
  // New wording: uses a locale string if one exists, otherwise the English default.
  const L = (k, fb) => { const v = T('ix_' + k); return v === 'ix_' + k ? fb : v; };
  const DAY = 864e5;
  const ALIAS = { usage: 'usage', history: 'usage', library: 'find', find: 'find', export: 'save', save: 'save', bulk: 'bulk', settings: 'settings', menu: 'menu' };

  let ui = null, prevFocus = null, current = 'menu', job = null, anchorEl = null;

  const CSS = `
    .pop { position: fixed; z-index: 2147483000; width: min(340px, calc(100vw - 24px)); max-height: calc(100vh - 80px); display: flex; flex-direction: column;
           background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); overflow: hidden; }
    header.top { display: flex; align-items: center; gap: 4px; padding: 10px 10px 6px 12px; }
    header.top h2 { font: 400 17px var(--serif); margin: 0; flex: 1; }
    .ib { background: none; border: 0; border-radius: 6px; padding: 4px 8px; cursor: pointer; color: var(--muted); font-size: 14px; }
    .ib:hover { background: var(--surface); color: var(--text); }
    main { padding: 2px 14px 14px; overflow: auto; flex: 1; }
    .choice { display: flex; gap: 12px; align-items: center; width: 100%; text-align: start; background: var(--card); border: 1px solid var(--line);
              border-radius: 10px; padding: 10px 12px; margin-block: 6px; cursor: pointer; }
    .choice:hover { border-color: var(--btn); }
    .choice .ic { font-size: 20px; line-height: 1; }
    .choice b { display: block; font-weight: 600; }
    .choice .d { display: block; color: var(--muted); font-size: 12px; }
    .big { width: 100%; margin-block: 4px; min-height: 36px; }
    .step { margin: 4px 0 8px; }
    .sw { display: flex; gap: 10px; align-items: flex-start; padding-block: 8px; border-block-end: 1px solid var(--line); cursor: pointer; }
    .sw input { margin-block-start: 3px; }
    .sw .d { display: block; color: var(--muted); font-size: 12px; }
    .res { padding: 7px 0; border-block-end: 1px solid var(--line); }
    .res button.title { background: none; border: 0; padding: 0; text-align: start; cursor: pointer; font-weight: 600; color: var(--text); }
    .res button.title:hover { text-decoration: underline; }
    .snip { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    mark { background: color-mix(in srgb, var(--btn) 28%, transparent); color: inherit; border-radius: 2px; }
    input[type=search] { width: 100%; }
    .warn { color: var(--btn); font-weight: 600; }
  `;

  const isOpen = () => !!ui;

  function close() {
    if (!ui) return;
    document.removeEventListener('keydown', ui.onKey, true);
    window.removeEventListener('resize', ui.place);
    ui.host.remove(); ui = null; anchorEl = null;
    if (prevFocus && prevFocus.focus) Safe.run('panel', () => prevFocus.focus());
  }

  // ─── small helpers ────────────────────────────────────────────────────────
  const choice = (icon, title, desc, onClick) => h('button', { class: 'choice', type: 'button', on: { click: onClick } },
    h('span', { class: 'ic', text: icon }), h('span', {}, h('b', { text: title }), desc ? h('span', { class: 'd', text: desc }) : null));

  const bar = (label, pct, reset) => {
    const el = h('div', { class: 'step' }, h('div', { class: 'row' }, h('span', { class: 'grow', text: label }), h('b', { text: Math.round(pct) + '%' })),
      h('div', { class: 'bar', role: 'progressbar', 'aria-label': label, 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i')),
      reset ? h('div', { class: 'muted', text: reset }) : null);
    el.querySelector('.bar > i').style.width = Math.max(0, Math.min(100, pct)) + '%';
    return el;
  };

  // Row of three buttons: one click saves the current chat as a file.
  function saveRow(msg) {
    const Exp = W('CTS_Exporter'), id = Exp.currentChatId();
    if (!id) return h('p', { class: 'muted', text: L('openChatFirst', 'Open a chat to save just that one.') });
    const row = h('div', { class: 'row' });
    [['pdf', 'PDF'], ['md', L('fMd', 'Markdown')], ['txt', L('fTxt', 'Text')], ['json', 'JSON']].forEach(([f, name]) =>
      row.appendChild(h('button', { class: 'btn grow', type: 'button', text: name, on: { click: async e => {
        const b = e.currentTarget; b.disabled = true; msg.textContent = T('expWorking');
        const r = await Exp.exportOne(id, f);
        msg.textContent = r.ok ? T('expDone', [r.name]) : T(r.error === 'rate' ? 'expRate' : r.error === 'not-found' ? 'expGone' : 'expFailed');
        b.disabled = false;
      } } })));
    return row;
  }

  // ─── screens ──────────────────────────────────────────────────────────────
  const screens = {};

  screens.menu = { title: () => 'TokenLens', render(c, go) {
    const msg = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
    c.append(
      choice('📊', L('mUsage', 'My usage'), L('mUsageD', 'How much of my limit is left'), () => go('usage')),
      choice('🔎', L('mFind', 'Find an old chat'), L('mFindD', 'Search everything I wrote or Claude said'), () => go('find')),
      h('div', { class: 'card' }, h('b', { text: '💾 ' + L('saveThis', 'Save this chat as:') }), h('div', { class: 'step' }, saveRow(msg)), msg),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost small grow', type: 'button', text: L('saveAll', 'Save all my chats'), on: { click: () => go('bulk') } }),
        h('button', { class: 'btn ghost small grow', type: 'button', text: '⚙️ ' + L('mSettings', 'Settings'), on: { click: () => go('settings') } })));
  } };

  screens.usage = { title: () => L('mUsage', 'My usage'), async render(c) {
    const u = W('CTS_Recorder').latest().usage;
    if (u && u.u5h != null) {
      const rs = ts => (ts ? T('usageResets', [UI.fmt.dateTime(ts * 1000)]) : '');
      c.append(bar(T('win5h'), u.u5h, rs(u.r5h)), bar(T('win7d'), u.u7d, rs(u.r7d)));
    } else c.appendChild(h('p', { class: 'muted', text: T('usageNoReading') }));
    const pace = h('p', { class: 'muted', 'aria-live': 'polite' }); c.appendChild(pace);
    W('CTS_Recorder').getPace().then(p => { if (p && p.willReach) pace.textContent = T('paceLine', [W('CTS_Recorder').fmtMinutes(p.minutesBeforeReset)]); }).catch(() => {});

    const info = F.isEnabled('handoff') && W('CTS_HandoffUI') && W('CTS_HandoffUI').contextInfo();
    if (info) c.appendChild(h('div', { class: 'card' }, h('p', { text: L('longChat', 'This chat is ') + info.pct + L('longChat2', '% full (about ') + UI.fmt.num(info.tokens) + L('longChat3', ' tokens). Long chats get slower and forget things.') }),
      h('button', { class: 'btn big', type: 'button', text: T('handoffBtn'), on: { click: () => { close(); W('CTS_HandoffUI').open(); } } })));

    if (!F.isEnabled('history')) return;
    const more = h('div', {});
    const showBtn = h('button', { class: 'btn ghost big', type: 'button', text: L('showDays', 'Show my last days') });
    showBtn.addEventListener('click', Safe.wrap('panel', async () => {
      showBtn.remove();
      const snaps = (await W('CTS_Client').data('snap.list')) || [];
      if (!snaps.length) { more.appendChild(h('p', { class: 'muted', text: T('historyEmpty') })); return; }
      const H = W('CTS_History'), Ch = W('CTS_Charts'), now = Date.now();
      let range = 7;
      const box = h('div', {});
      const draw = () => {
        box.textContent = '';
        box.appendChild(h('div', { class: 'row' }, [7, 30].map(n => h('button', { class: 'btn small' + (n === range ? '' : ' ghost'), type: 'button', 'aria-pressed': String(n === range), text: T('rangeDays', [String(n)]), on: { click: () => { range = n; draw(); } } }))));
        const dl = d => UI.fmt.date(d * DAY + 12 * 36e5);
        box.appendChild(UI.svg(Ch.dailyPeakChart(H.dailyPeaks(snaps, range, now), { label: T('chartPeaks'), fmtTitle: d => `${dl(d.day)}: ${T('win5h')} ${d.peak5h}% · ${T('win7d')} ${d.peak7d}%` })));
        const hits = H.limitHits(snaps).filter(x => now - x.t < 90 * DAY).length;
        box.appendChild(h('p', { class: 'muted', text: hits ? T('limitHitsCount', [String(hits)]) : T('limitHitsNone') }));
      };
      draw(); more.appendChild(box);
    }));
    c.append(showBtn, more);
  } };

  screens.find = { title: () => L('mFind', 'Find an old chat'), async render(c) {
    const Client = W('CTS_Client'), Idx = W('CTS_Indexer');
    const convs = (await Client.data('conv.list')) || [];
    const cov = (await Client.data('index.coverage')) || { indexed: 0, total: 0 };
    const prog = h('p', { class: 'muted', 'aria-live': 'polite' });

    const runIndex = async btn => {
      btn.disabled = true;
      job = Idx.startIndexAll(p => { prog.textContent = T('libIndexProgress', [String(p.current || 0), String(p.total)]); });
      const cancel = h('button', { class: 'btn ghost big', type: 'button', text: T('cancel'), on: { click: () => job && job.cancel() } });
      c.appendChild(cancel);
      const sum = await job.done; job = null; cancel.remove();
      prog.textContent = sum.stopped === 'rate' ? T('libStoppedRate') : sum.stopped === 'errors' ? T('libStoppedErrors') : sum.stopped === 'cancelled' ? T('libStoppedCancel', [String(sum.done)]) : T('libIndexDone', [String(sum.done)]);
      go('find');
    };

    if (!cov.indexed) {                                  // first time: read the chats automatically
      c.append(h('p', { text: L('findIntro', 'Reading your chats once so you can search them. This stays on your computer.') }), prog);
      const dummy = h('button', { hidden: true });
      c.appendChild(dummy);
      Safe.run('panel', () => runIndex(dummy));
      return;
    }
    // step 2: search
    const q = h('input', { type: 'search', 'aria-label': L('findLabel', 'Search my chats'), placeholder: T('libSearchPh') });
    const status = h('p', { class: 'muted', 'aria-live': 'polite' });
    const list = h('div', {});
    const moreBtn = h('button', { class: 'btn ghost big', type: 'button', hidden: true, text: L('showMore', 'Show more') });
    c.append(q, status, list, moreBtn);
    if (cov.total > cov.indexed) {
      const b = h('button', { class: 'btn ghost small', type: 'button', text: L('readMore', 'Read ') + (cov.total - cov.indexed) + L('readMore2', ' newer chats') });
      b.addEventListener('click', Safe.wrap('panel', () => runIndex(b)));
      c.append(b, prog);
    }

    const snippetNode = sn => {
      const p = h('div', { class: 'snip' }); if (!sn) return p;
      let pos = 0; const t = sn.text;
      if (sn.ellipsisStart) p.appendChild(document.createTextNode('… '));
      sn.ranges.forEach(r => { p.appendChild(document.createTextNode(t.slice(pos, r.s))); p.appendChild(h('mark', { text: t.slice(r.s, r.e) })); pos = r.e; });
      p.appendChild(document.createTextNode(t.slice(pos)));
      if (sn.ellipsisEnd) p.appendChild(document.createTextNode(' …'));
      return p;
    };
    let rows = [], shown = 0, seq = 0, timer = 0;
    const paint = () => {
      rows.slice(shown, shown + 5).forEach(r => list.appendChild(h('div', { class: 'res' },
        h('button', { class: 'title', type: 'button', text: r.title || T('untitled'), on: { click: () => location.assign('/chat/' + r.id) } }),
        r.updatedAt ? h('span', { class: 'muted', text: '  ' + UI.fmt.date(Date.parse(r.updatedAt)) }) : null, snippetNode(r.snippet))));
      shown = Math.min(rows.length, shown + 5); moreBtn.hidden = shown >= rows.length;
    };
    moreBtn.addEventListener('click', paint);
    const run = async () => {
      const my = ++seq, text = q.value.trim(); list.textContent = ''; shown = 0;
      if (!text) {
        rows = convs.filter(x => x.status !== 'missing').sort((a, b) => (b.updatedMs || 0) - (a.updatedMs || 0)).map(x => ({ id: x.id, title: x.title, updatedAt: x.updatedAt }));
        status.textContent = L('recent', 'Your most recent chats'); paint(); return;
      }
      const res = await Client.data('search', { q: text, filters: { folderId: null, role: null, from: 0, to: 0 } });
      if (my !== seq) return;
      if (!res) { status.textContent = T('libUnavailable'); return; }
      rows = res.results; status.textContent = rows.length ? T('libResultCount', [String(rows.length)]) : T('libNoResults'); paint();
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => Safe.run('panel', run), 200); });
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { const b = list.querySelector('button.title'); if (b) b.click(); } });
    run(); q.focus();
  } };

  screens.save = { title: () => L('saveThis', 'Save this chat as:'), render(c) {
    const msg = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
    c.append(saveRow(msg), msg);
  } };

  screens.bulk = { title: () => L('saveAll2', 'Save all my chats'), async render(c, go) {
    const Exp = W('CTS_Exporter'), Client = W('CTS_Client');
    const prog = h('p', { class: 'muted', 'aria-live': 'polite' });
    const barEl = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true }, h('i'));
    const cancel = h('button', { class: 'btn ghost big', type: 'button', text: T('cancel'), hidden: true });
    const start = h('button', { class: 'btn', type: 'button', hidden: true });
    const setProg = p => { const pct = p.total ? Math.round((p.done + p.failed) / p.total * 100) : 0; barEl.hidden = false; barEl.setAttribute('aria-valuenow', String(pct)); barEl.firstChild.style.width = pct + '%'; prog.textContent = T('expProgress', [String(p.done + p.failed), String(p.total), String(p.failed)]); };
    const go2 = async (ids, resume) => {
      if (job) return;
      start.disabled = true; cancel.hidden = false;
      job = Exp.startBulk({ ids, formats: ['md'], resume, onProgress: setProg });
      cancel.onclick = () => job && job.cancel();
      const sum = await job.done; job = null; cancel.hidden = true; start.disabled = false;
      prog.textContent = sum.stopped === 'rate' ? T('expStoppedRate') : sum.stopped === 'errors' ? T('expStoppedErrors') : sum.stopped === 'cancelled' ? T('expCancelled', [String(sum.count)]) : T('expBulkDone', [String(sum.count), String(sum.failed)]);
    };
    start.addEventListener('click', Safe.wrap('panel', async () => {
      prog.textContent = T('expListing');
      const list = await Client.fetchList();
      if (list.status === 200 && Array.isArray(list.json)) await Client.call('conv.meta', { items: list.json.map(x => ({ uuid: x.uuid, name: x.name || x.title || null, created_at: x.created_at, updated_at: x.updated_at })) });
      const convs = (await Client.data('conv.list')) || [];
      go2(convs.filter(x => x.status !== 'missing').map(x => x.id), false);
    }));
    c.append(h('p', { text: L('bulkIntro', 'Saving every chat as a Markdown file. It runs slowly on purpose so claude.ai is not overloaded. You can stop any time.') }), cancel, barEl, prog);
    const pending = await Exp.pendingJob();
    if (pending) {
      c.appendChild(h('div', { class: 'card' }, h('p', { text: T('expResumeText', [String(pending.done.length + pending.failed.length), String(pending.ids.length)]) }),
        h('button', { class: 'btn big', type: 'button', text: T('expResume'), on: { click: () => go2(pending.ids, true) } }),
        h('button', { class: 'btn ghost big', type: 'button', text: L('startOver', 'Start over'), on: { click: async () => { await Exp.discardJob(pending.jobId); go('bulk'); } } })));
      return;
    }
    start.click();
  } };

  screens.settings = { title: () => L('mSettings', 'Settings'), render(c, go) {
    const Bus = W('CTS_Bus');
    const set = (path, value) => Bus.saveSettings(s => { const p = path.split('.'); let o = s; p.slice(0, -1).forEach(k => { o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}; }); o[p[p.length - 1]] = value; });
    const sw = (feat, title, desc) => h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: F.isEnabled(feat), on: { change: e => set('features.' + feat, e.target.checked) } }),
      h('span', {}, h('b', { text: title }), h('span', { class: 'd', text: desc })));
    c.append(
      sw('alerts', L('sAlerts', 'Warn me near my limit'), L('sAlertsD', 'A small message at 80% and 95%')),
      sw('handoff', L('sLong', 'Tell me when a chat is too long'), L('sLongD', 'Suggests continuing in a new chat')),
      sw('history', L('sHist', 'Remember my usage'), L('sHistD', 'Lets you see the last days')));
    const box = h('div', { class: 'step' });
    const ask = () => {
      box.textContent = '';
      box.append(h('p', { class: 'warn', text: L('delAsk', 'Delete everything TokenLens saved? This cannot be undone.') }),
        h('button', { class: 'btn big', type: 'button', text: L('delYes', 'Yes, delete it'), on: { click: async () => {
          await W('CTS_Client').call('data.deleteAll');
          const keys = ['cts_settings', 'cts_alerts_fired', 'cts_errlog', 'cts_snap_last', 'cts_handoff', 'cts_handoff_pending', 'cts_hint_shown', 'cts_print', 'cts_ack_index', 'cts_ack_export'];
          await new Promise(res => Safe.chromeCall('panel', () => chrome.storage.local.remove(keys, res)) || res());
          Bus.saveSettings(s => { Object.keys(s).forEach(k => delete s[k]); });
          box.textContent = ''; box.appendChild(h('p', { class: 'muted', text: T('setDeleted') }));
        } } }),
        h('button', { class: 'btn ghost big', type: 'button', text: T('cancel'), on: { click: reset } }));
    };
    const reset = () => { box.textContent = ''; box.appendChild(h('button', { class: 'btn ghost big', type: 'button', text: L('delAll', 'Delete my saved data'), on: { click: ask } })); };
    reset(); c.appendChild(box);
  } };

  // ─── shell ────────────────────────────────────────────────────────────────
  function go(name) {
    if (!ui) return;
    if (!screens[name]) name = 'menu';
    current = name;
    const s = screens[name];
    ui.title.textContent = s.title();
    ui.back.hidden = name === 'menu';
    ui.back.onclick = () => go(s.back || 'menu');
    ui.body.textContent = '';
    Safe.run('panel', () => { const r = s.render(ui.body, go); if (r && r.catch) r.catch(() => {}); });
  }

  function open(screen, anchor) {
    const name = ALIAS[screen] || 'menu';
    if (anchor) anchorEl = anchor;
    if (ui) { ui.anchor = anchorEl; go(name); ui.place(); return; }
    prevFocus = document.activeElement;
    const m = UI.mount('cts-panel-host', CSS);
    const back = h('button', { class: 'ib', type: 'button', 'aria-label': L('back', 'Back'), text: '←', hidden: true });
    const title = h('h2');
    const closeBtn = h('button', { class: 'ib', type: 'button', 'aria-label': T('close'), text: '✕', on: { click: close } });
    const body = h('main', { 'aria-live': 'polite' });
    const pop = h('div', { class: 'pop fade', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'TokenLens' }, h('header', { class: 'top' }, back, title, closeBtn), body);
    m.root.appendChild(pop);
    // Sit next to whatever opened us: under a top-bar button, or to the right of the sidebar strip.
    const place = () => {
      const a = anchorEl && anchorEl.isConnected ? anchorEl : document.getElementById('ct-panel-launcher');
      const r = a && a.getBoundingClientRect();
      pop.style.top = pop.style.right = pop.style.left = pop.style.maxHeight = '';
      if (r && r.height && r.left < window.innerWidth / 2) {
        const top = Math.max(12, Math.min(Math.round(r.top), window.innerHeight - 200));
        pop.style.top = top + 'px';
        pop.style.left = Math.min(Math.round(r.right + 12), Math.max(12, window.innerWidth - 352)) + 'px';
        pop.style.maxHeight = (window.innerHeight - top - 12) + 'px';
      } else {
        pop.style.top = (r && r.height ? Math.round(r.bottom + 8) : 56) + 'px';
        pop.style.right = (r && r.height ? Math.max(12, Math.round(window.innerWidth - r.right - 24)) : 12) + 'px';
      }
    };
    const onKey = e => { if (e.key === 'Escape' && m.root.activeElement) { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    ui = { host: m.host, root: m.root, body, title, back, onKey, place, anchor: anchorEl };
    document.documentElement.appendChild(m.host);
    place(); go(name);
  }

  // Open on `screen` from `anchor`; a second press of the same opener closes it again.
  function toggle(screen, anchor) {
    const name = ALIAS[screen] || 'menu';
    if (ui && current === name && ui.anchor === anchor) close(); else open(screen, anchor);
  }

  // ─── openers ──────────────────────────────────────────────────────────────
  document.addEventListener('cts2:open-panel', e => Safe.run('panel', () => {
    let screen = 'usage';
    try { const d = e && e.detail; const o = typeof d === 'string' ? JSON.parse(d) : d; if (o && typeof o.screen === 'string') screen = o.screen; } catch (_) {}
    open(screen);
  }));
  // Legacy top-bar launchers (ids on the host element; the root is closed, so only the host id is visible here).
  const LAUNCHERS = { 'ct-panel-launcher': 'menu', 'ct-save-launcher': 'save' };
  document.addEventListener('click', e => Safe.run('panel', () => {
    const ids = (e.composedPath ? e.composedPath() : []).map(n => n && n.id);
    const id = Object.keys(LAUNCHERS).find(k => ids.includes(k));
    if (!id) return;
    e.preventDefault(); e.stopPropagation();
    toggle(LAUNCHERS[id], document.getElementById(id));
  }), true);
  Safe.chromeCall('panel', () => chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender && sender.id === chrome.runtime.id && msg && msg.cts === 'open-panel') Safe.run('panel', () => open('menu'));
  }));

  window.CTS_Panel = { open, toggle, close, isOpen, registerTab: () => {}, SHORTCUTS: [] };
})();
