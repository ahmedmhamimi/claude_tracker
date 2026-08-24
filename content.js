/**
 * Extension entry point: DOM observation, UI injection orchestration, and
 * post-response analysis pipeline.
 *
 * - CTS_Content.tryInjectUI() -> void: injects all UI components if the composer is present and not yet injected
 * - CTS_Content.applyAnalysis(result, convoId) -> void: processes conversation analysis output, updates context bar, chips
 * - CTS_Content.updateInlineStats() -> void: refreshes turn count, cost, and latency pills in the composer row
 * - CTS_Content.injectSidebarDates() -> void: stamps each sidebar chat-list row with its creation date
 * - startControlTicks() -> void: alias that delegates to CTS_Quota.startCountdownTick
 */

(function () {
  'use strict';

  // ─── Model Detection ──────────────────────────────────────────────────────

  function detectModelFromDOM() {
    const selectors = [
      '[data-testid*="model"] button',
      'button[aria-label*="model" i]',
      'button[aria-label*="claude" i]',
      '[class*="model-selector"] button',
      'button[class*="model"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const txt = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
      if (!txt) continue;
      const meta = window.CTS_Shared.getModelMeta(txt);
      if (meta) return meta;
    }
    return null;
  }

  // ─── Inline Stats ─────────────────────────────────────────────────────────

  function updateInlineStats() {
    const onChatPage  = /\/chat\/[a-f0-9\-]{36}/i.test(window.location.pathname);
    const currentCid  = window.CTS_Network.getConvoId();

    window.CTS_Session.resetForConvo(currentCid);

    const show = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = (onChatPage && visible) ? '' : 'none';
    };
      const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      };

        const hasTurns = window.CTS.sessionMsgCount > 0;
        show('ct-p-turns', hasTurns);
        if (hasTurns) setText('ct-p-turns-t', window.CTS.sessionMsgCount + (window.CTS.sessionMsgCount === 1 ? ' turn' : ' turns'));

        const costText = window.CTS_Shared.formatCost(window.CTS.sessionCostEst);
    show('ct-p-cost', !!costText);
    if (costText) setText('ct-p-cost-t', costText);

    const hasLat = window.CTS.latencies.length > 0;
    show('ct-p-lat', hasLat);
    if (hasLat) {
      const avg = Math.round(window.CTS.latencies.reduce((a, b) => a + b, 0) / window.CTS.latencies.length);
      setText('ct-p-lat-t', avg + 'ms avg');
    }
  }

  // ─── Apply Analysis ───────────────────────────────────────────────────────

  function applyAnalysis(result, convoId) {
    if (!result) return;
    const { totalTokens, lastInputTokens, lastOutputTokens, assistantCount } = result;

    const meta = window.CTS.lastConfirmedModelMeta
    || window.CTS.currentModelMeta
    || detectModelFromDOM()
    || { ctx: 200000 };
    const ctx = meta.ctx;
    const pct = Math.min(100, Math.round((totalTokens / ctx) * 100));

    window.CTS.sessionConvTokens = totalTokens;

    // Context pill
    const ctxPill = document.getElementById('ct-p-ctx');
    const ctxText = document.getElementById('ct-p-ctx-t');
    if (ctxPill) {
      const ctxK = ctx >= 1000000 ? '1,000,000' : '200,000';
      ctxPill.setAttribute('data-ct-tip',
                           'Estimated context window usage.\nTokens counted from message text:\n· Code blocks: chars ÷ 3\n· URLs & numbers: chars ÷ 2\n· Regular words: count × 1.3\nModel limit: ' + ctxK + ' tokens.');
    }
    if (ctxText && ctxPill) {
      ctxText.textContent = `${window.CTS_Shared.formatTokens(totalTokens)}/${Math.round(ctx / 1000)}k · ${pct}%`;
      ctxPill.className   = 'ct-pill' + (pct > 85 ? ' danger' : pct > 60 ? ' warn' : '');
    }

    // Cost accumulation
    window.CTS_Session.recordTurn(lastInputTokens, lastOutputTokens);

    // Prompt cache tracking
    const activeCid = convoId || window.CTS_Network.getConvoId();
    if (activeCid) {
      if (!window.CTS.convoCacheMap[activeCid]) {
        window.CTS.convoCacheMap[activeCid] = {
          baselineCount: assistantCount,
          lastSeenCount: assistantCount,
          cachedUntil:   null,
        };
        // Bounded so a tab left open across many conversations doesn't
        // accumulate one entry per convoId forever. UUID keys preserve
        // insertion order, so the oldest entry is always first here.
        const keys = Object.keys(window.CTS.convoCacheMap);
        if (keys.length > 30) delete window.CTS.convoCacheMap[keys[0]];
      }
      const cState = window.CTS.convoCacheMap[activeCid];
      if (assistantCount > cState.lastSeenCount) {
        cState.lastSeenCount = assistantCount;
        if (assistantCount - cState.baselineCount >= 1) {
          cState.cachedUntil = Date.now() + (60 * 60 * 1000);
        }
      }
      if (activeCid === window.CTS_Network.getConvoId()) {
        window.CTS.cachedUntilTs = (cState.cachedUntil && cState.cachedUntil > Date.now())
        ? cState.cachedUntil
        : null;
      }
    }

    // Per-response chips
    // Anthropic's Aug 2026 DOM update dropped the assistant-message testid;
    // assistant turns are now [data-testid="transcript-row"] rows that
    // contain an action bar (copy/retry/thumbs), which user rows never have.
    const allRows = document.querySelectorAll('[data-testid="transcript-row"]');
    const assistantRows = Array.from(allRows).filter(
      row => row.querySelector('[data-testid^="action-bar-"]')
    );
    if (assistantRows.length > 0) {
      const payload = {
        latMs:      window.CTS.lastLatencyMs,
        tps:        window.CTS.lastSpeedTps,
        outputTok:  lastOutputTokens,
        quotaPct:   window.CTS.lastMsgQuotaDelta,
        stopReason: window.CTS.stopReasonHistory[0],
      };
      window.ClaudeTrackerUI.renderChips(
        assistantRows[assistantRows.length - 1],
        payload,
        !!(window.CTS.cachedUntilTs && window.CTS.cachedUntilTs > Date.now())
      );
    }

    updateInlineStats();
  }

  // ─── Sidebar Root ─────────────────────────────────────────────────────────
  // Anthropic's sidebar redesign (Aug 2026) dropped the <nav> element
  // entirely — the sidebar is now `<aside class="dframe-sidebar">` wrapping
  // a `div[data-testid="sidebar"]` body. data-testid is a test hook, so it's
  // the most likely selector to survive the next visual refactor; the old
  // `nav`-based selectors are kept as trailing fallbacks in case any layout
  // (e.g. a different surface/breakpoint) still uses the old markup.
  function getSidebarRoot() {
    return document.querySelector('[data-testid="sidebar"]')
    || document.querySelector('aside.dframe-sidebar')
    || document.querySelector('nav.flex-col')
    || document.querySelector('[class*="sidebar"] nav')
    || document.querySelector('nav');
  }

  // ─── Sidebar Observer ─────────────────────────────────────────────────────

  let _sidebarObserver = null;

  function setupSidebarObserver() {
    if (_sidebarObserver) { _sidebarObserver.disconnect(); _sidebarObserver = null; }
    const nav = getSidebarRoot();
    if (!nav) return;

    function checkCollapsed() {
      const quota = document.getElementById('ct-quota');
      const collapsed = nav.getBoundingClientRect().width < 230;
      if (quota) quota.classList.toggle('sidebar-hidden', collapsed);
    }

    _sidebarObserver = new MutationObserver(checkCollapsed);
    _sidebarObserver.observe(nav, { attributes: true, attributeFilter: ['class', 'style'] });
    if (nav.parentElement) {
      _sidebarObserver.observe(nav.parentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    checkCollapsed();

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(checkCollapsed);
      ro.observe(nav);
    }
  }

  // ─── Sidebar Chat Dates ───────────────────────────────────────────────────
  // Stamps a small "created on" badge onto each chat row in the sidebar list.
  // Dates come from window.CTS.convoDateMap (uuid -> created_at), populated by
  // CTS_Network.fetchConversationList(). Rows are matched by the /chat/<uuid>
  // href every sidebar list item links to, so this doesn't depend on any
  // particular internal class name — just the one thing guaranteed to be
  // stable: where the link points.

  function findChatRows() {
    const sidebar = getSidebarRoot();
    if (!sidebar) return [];
    return Array.from(sidebar.querySelectorAll('a[href^="/chat/"]'));
  }

  // Heuristic title-node finder: walks the link's subtree for the deepest
  // element that has its own text and no element children — i.e. the actual
  // label, whatever the site happens to call its class. Picking this out
  // specifically (instead of truncating the whole row) means we only ever
  // touch the one node that actually needs to give up space for the badge.
  function findTitleEl(a) {
    let best = null;
    const stack = [a];
    while (stack.length) {
      const el = stack.pop();
      const text = (el.textContent || '').trim();
      if (el.children.length === 0 && text) {
        if (!best || text.length > best.textContent.trim().length) best = el;
      }
      for (const child of el.children) stack.push(child);
    }
    return best;
  }

  // Must match the .ct-chat-date `right` value in ui.js — the gap that
  // clears Claude's own row-actions button on hover. Used below to compute
  // how much space the title actually needs to give up, on top of it.
  const DATE_RIGHT_OFFSET = 34;
  const DATE_TITLE_GAP = 4; // breathing room between title text and date

  function injectSidebarDates() {
    const map = window.CTS.convoDateMap;
    if (!map || !Object.keys(map).length) return;

    findChatRows().forEach(a => {
      const m = a.getAttribute('href').match(/\/chat\/([a-f0-9-]{36})/i);
      if (!m) return;
      const iso = map[m[1]];
      if (!iso) return;

      const isInit = !a.dataset.ctDateInit;
      if (isInit) {
        a.dataset.ctDateInit = '1';
        if (getComputedStyle(a).position === 'static') a.style.position = 'relative';

        const titleEl = findTitleEl(a);
        if (titleEl) {
          titleEl.style.display = 'block';
          titleEl.style.overflow = 'hidden';
          titleEl.style.textOverflow = 'ellipsis';
          titleEl.style.whiteSpace = 'nowrap';
          titleEl.style.boxSizing = 'border-box';
        }
      }

      let badge = a.querySelector(':scope > .ct-chat-date');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'ct-chat-date';
        a.appendChild(badge);
      }

      const label = window.CTS_Shared.formatChatDate(iso);
      if (badge.textContent !== label) {
        badge.textContent = label;

        // Reserve exactly as much title space as this label actually needs
        // (plus the fixed kebab-button clearance and a small gap) — measured
        // per-row rather than a fixed guess, so short labels like "Aug 24"
        // don't truncate the title any more than they have to, while longer
        // ones (older chats grow a year, e.g. "Aug 24, 2025") still get the
        // room they need automatically.
        const titleEl = findTitleEl(a);
        if (titleEl) {
          titleEl.style.paddingRight =
            (DATE_RIGHT_OFFSET + badge.offsetWidth + DATE_TITLE_GAP) + 'px';
        }
      }
      const full = new Date(iso).toLocaleString();
      if (badge.title !== full) badge.title = full;
    });
  }

  let _sidebarDatesQueued = false;
  function scheduleSidebarDates() {
    if (_sidebarDatesQueued) return;
    _sidebarDatesQueued = true;
    requestAnimationFrame(() => {
      _sidebarDatesQueued = false;
      injectSidebarDates();
    });
  }

  // ─── UI Injection ─────────────────────────────────────────────────────────

  // Cheap, cheap-to-maintain guard against the obvious signed-out routes
  // (login/signup/auth screens). Not exhaustive on its own — see the
  // stability check below — but avoids even looking for a composer on
  // pages we already know aren't the real app.
  function isAuthOrMarketingPage() {
    const p = window.location.pathname.toLowerCase();
    return /^\/(login|signin|sign-in|signup|sign-up|auth|logout|oauth)(\/|$)/.test(p);
  }

  // Guards against building the UI on a composer-shaped element that only
  // exists for a moment on the signed-out shell (e.g. while the page is
  // still hydrating, right before the router redirects a signed-out visitor
  // away). We don't know that page's exact markup, so instead of trying to
  // blacklist selectors, we just refuse to trust a newly-seen composer until
  // it's still present and attached ~300ms later. A real app composer easily
  // survives that; a transient pre-redirect match never does — which is what
  // was causing the widget to flash in and vanish within a second for
  // signed-out users.
  let _pendingComposer = null;
  let _confirmedComposer = null;

  function tryInjectUI() {
    if (window.CTS.UIInjected && document.getElementById('ct-row')) return;

    if (isAuthOrMarketingPage()) {
      _pendingComposer = null;
      _confirmedComposer = null;
      return;
    }

    const composer = document.querySelector('div[contenteditable="true"]')
    || document.querySelector('textarea[placeholder]');
    if (!composer) {
      _pendingComposer = null;
      _confirmedComposer = null;
      return;
    }

    if (composer !== _confirmedComposer) {
      if (composer !== _pendingComposer) {
        _pendingComposer = composer;
        setTimeout(() => {
          // Still the same element, still on-page, and we haven't since
          // navigated to an auth page? Only then is it trusted.
          if (_pendingComposer !== composer || !composer.isConnected || isAuthOrMarketingPage()) return;
          _confirmedComposer = composer;
          tryInjectUI();
        }, 300);
      }
      return;
    }

    // Core UI (CSS, theme observers, tooltip engine) must run exactly once,
    // ever. It used to share window.CTS.UIInjected with the sidebar retry
    // logic below — but that flag gets reset to false on every pass when
    // there's no sidebar <nav> to mount the quota panel in (e.g. Incognito
    // chat has none), which re-ran ClaudeTrackerUI.init() on every DOM
    // mutation. init() creates fresh MutationObservers/timers with no guard
    // of its own, so that leaked without bound and froze the tab. Gating
    // this separately means it can only ever fire once.
    if (!window.CTS.coreUIInjected) {
      window.CTS.coreUIInjected = true;
      window.ClaudeTrackerUI.init();
    }

    // Composer stats row
    if (!document.getElementById('ct-row') && composer.parentElement) {
      composer.parentElement.appendChild(window.ClaudeTrackerUI.buildComposerRow());
    }

    // Quota card — floats independently of the composer (fixed-position,
    // top-right of the viewport) instead of living inside the message box's
    // toolbar row, so it never crowds the "+" button or wraps awkwardly.
    if (!document.getElementById('ct-toolbar-quota')) {
      const strip = window.ClaudeTrackerUI.buildToolbarQuota();
      document.body.appendChild(strip);
      requestAnimationFrame(() => strip.classList.add('vis'));
    }

    // Sidebar quota panel — retried independently on subsequent passes.
    // Absence of a sidebar <nav> is a legitimate terminal state on some
    // layouts (e.g. Incognito chat has none), not an error condition, so
    // it no longer aborts the rest of this function — countdown tick,
    // composer stats, and toolbar updates should still work either way.
    if (!document.getElementById('ct-quota')) {
      const sidebar = getSidebarRoot();
      if (sidebar) {
        const qBox = window.ClaudeTrackerUI.buildQuotaContainer();
        // Pin the panel to the very top of the sidebar, above the nav
        // buttons (New/Projects/Artifacts/.../Design) and the chat list,
        // rather than after them.
        sidebar.insertBefore(qBox, sidebar.firstElementChild);

        setTimeout(() => qBox.classList.add('vis'), 200);
        // Retry fetch on a backoff schedule to handle cold-start: orgId may not be
        // captured yet when the first attempt fires (SPA hasn't made an org API call).
        // Each attempt no-ops harmlessly if orgId is still null or a fetch is in flight.
        // Stops retrying once we have real data.
        [300, 1200, 2800, 5500].forEach(delay => {
          setTimeout(() => {
            if (window.CTS.current5hUtil === 0) window.CTS_Network.triggerUsageFetch();
          }, delay);
        });
      }
    }

    // Chat-list dates: (re)fetch on a light cadence — not on every call,
    // since tryInjectUI can run many times per second during an SPA
    // navigation — and stamp whatever we already have immediately so rows
    // don't sit unlabeled until the next fetch completes.
    if (getSidebarRoot()) {
      const sinceLastFetch = Date.now() - (window.CTS.lastConvoListFetch || 0);
      if (!window.CTS.lastConvoListFetch || sinceLastFetch > 45000) {
        window.CTS_Network.fetchConversationList();
      }
      scheduleSidebarDates();
    }

    // Repaint quota bars from persisted state on every injection path — not just
    // when the sidebar is freshly built. The toolbar strip may be re-injected by
    // the MutationObserver independently (SPA navigation nukes it while the sidebar
    // survives), so the repaint must run unconditionally here. _storageReady is
    // already resolved by the time any real navigation settles, so the .then() fires
    // as a microtask with no perceptible delay.
    (window.CTS._storageReady || Promise.resolve()).then(() => {
      if (window.CTS.current5hUtil > 0) {
        window.ClaudeTrackerUI.updateQuotaBars('5h', window.CTS.current5hUtil, window.CTS.targetTimestamps['5h']);
      }
      if (window.CTS.current7dUtil > 0) {
        window.ClaudeTrackerUI.updateQuotaBars('7d', window.CTS.current7dUtil, window.CTS.targetTimestamps['7d']);
      }
    });

    window.CTS_Quota.startCountdownTick();
    setupSidebarObserver();
    window.CTS.UIInjected = true;
  }

  // ─── Inactivity Poller ────────────────────────────────────────────────────

  ['mousemove', 'click', 'keydown'].forEach(e => {
    document.addEventListener(e, () => { window.CTS.lastActivityTime = Date.now(); }, { passive: true });
  });

  setInterval(() => {
    if (Date.now() - window.CTS.lastActivityTime >= 4000) {
      if (!window.CTS.inactivityArmed) {
        window.CTS.inactivityArmed = true;
        window.CTS_Network.triggerUsageFetch();
      }
    } else {
      window.CTS.inactivityArmed = false;
    }
  }, 4000);

  // Keep sidebar chat dates fresh even on a quiet tab (new chats created in
  // another tab, renames, etc.) without waiting on a mutation to trigger it.
  setInterval(() => {
    if (window.CTS.orgId && getSidebarRoot()) window.CTS_Network.fetchConversationList();
  }, 60000);

  // ─── MutationObserver ─────────────────────────────────────────────────────

  const mutationObserver = new MutationObserver(() => {
    // ct-quota only belongs inside a sidebar <nav>. Its absence is either
    // (a) permanent and expected — no sidebar exists at all (Incognito) — or
    // (b) temporary and needs a retry — a sidebar exists but we haven't built
    // the box into it yet, e.g. right after an SPA transition out of an
    // Incognito chat (no full reload, so UIInjected/coreUIInjected persist
    // from the sidebar-less session and never naturally get re-checked).
    // Only treat (b) as unhealthy: check for ct-quota's absence ONLY when a
    // real sidebar is actually present right now, so this can never loop
    // forever on a layout that structurally can't have one.
    const sidebarPresent = !!getSidebarRoot();
    const sidebarMissingQuota = sidebarPresent && !document.getElementById('ct-quota');

    if (!document.getElementById('ct-toolbar-quota') || !document.getElementById('ct-row') || sidebarMissingQuota) {
      window.CTS.UIInjected = false;
    }
    if (!window.CTS.UIInjected) tryInjectUI();

    // Sidebar chat list is virtualized/re-rendered independently of the
    // quota panel (scrolling, renaming, new chats), so it needs its own
    // lightweight re-stamp pass on every mutation batch rather than only
    // whenever the rest of the UI happens to reinject.
    if (sidebarPresent) scheduleSidebarDates();
  });

    mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

    // ─── Polling Fallback ─────────────────────────────────────────────────────
    // Brave on Wayland throttles or batches MutationObserver callbacks during
    // initial page render, causing the observer to fire too late — the composer
    // is already in the DOM but the injection window has passed. Opening DevTools
    // forces a synchronous layout flush that drains the queued mutations, which
    // is why the metrics appear instantly the moment DevTools opens.
    // A lightweight interval runs in parallel to catch this gap without replacing
    // the observer (which still handles SPA navigations correctly).

    let _stableCount  = 0;
    const _injectPoller = setInterval(() => {
      const rowMissing     = !document.getElementById('ct-row');
      const toolbarMissing = !document.getElementById('ct-toolbar-quota');
      const composerReady  = !!(
        document.querySelector('div[contenteditable="true"]') ||
        document.querySelector('textarea[placeholder]')
      );

      if ((rowMissing || toolbarMissing) && composerReady) {
        _stableCount = 0;
        window.CTS.UIInjected = false;
        tryInjectUI();
      } else if (!rowMissing && !toolbarMissing) {
        // Both elements present — count consecutive stable ticks then stop polling.
        if (++_stableCount >= 10) clearInterval(_injectPoller);
      }
    }, 500);

    // ─── Exports ─────────────────────────────────────────────────────────────

    window.CTS_Content = {
      tryInjectUI,
      applyAnalysis,
      updateInlineStats,
      injectSidebarDates,
    };

})();
