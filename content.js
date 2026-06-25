/**
 * Extension entry point: DOM observation, UI injection orchestration, and
 * post-response analysis pipeline.
 *
 * - CTS_Content.tryInjectUI() -> void: injects all UI components if the composer is present and not yet injected
 * - CTS_Content.applyAnalysis(result, convoId) -> void: processes conversation analysis output, updates context bar, chips
 * - CTS_Content.updateInlineStats() -> void: refreshes turn count, cost, and latency pills in the composer row
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

    // Context bar
    const barFill = document.getElementById('ct-ctx-bar-fill');
    const barNode = document.getElementById('ct-ctx-bar');
    if (barFill && barNode) {
      barFill.style.width       = pct + '%';
      barFill.style.background  = pct > 85 ? 'var(--ct-red)' : pct > 60 ? 'var(--ct-orange)' : 'var(--ct-blue)';
      barNode.classList.toggle('vis', pct > 2);
    }

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
    const allMessages = document.querySelectorAll('[data-testid="assistant-message"]');
    if (allMessages.length > 0) {
      const payload = {
        latMs:      window.CTS.lastLatencyMs,
        tps:        window.CTS.lastSpeedTps,
        outputTok:  lastOutputTokens,
        stopReason: window.CTS.stopReasonHistory[0],
      };
      window.ClaudeTrackerUI.renderChips(
        allMessages[allMessages.length - 1],
        payload,
        !!(window.CTS.cachedUntilTs && window.CTS.cachedUntilTs > Date.now())
      );
    }

    updateInlineStats();
  }

  // ─── Sidebar Observer ─────────────────────────────────────────────────────

  let _sidebarObserver = null;

  function setupSidebarObserver() {
    if (_sidebarObserver) { _sidebarObserver.disconnect(); _sidebarObserver = null; }
    const nav = document.querySelector('nav.flex-col') || document.querySelector('nav');
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

  // ─── UI Injection ─────────────────────────────────────────────────────────

  function tryInjectUI() {
    if (window.CTS.UIInjected && document.getElementById('ct-row')) return;

    const composer = document.querySelector('div[contenteditable="true"]')
    || document.querySelector('textarea[placeholder]');
    if (!composer) return;

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

    // Context bar
    const wrap = composer.closest('form') || composer.parentElement?.parentElement;
    if (wrap && !document.getElementById('ct-ctx-bar')) {
      wrap.style.position = 'relative';
      const bar = document.createElement('div');
      bar.id = 'ct-ctx-bar';
      bar.innerHTML = `<div id="ct-ctx-bar-fill"></div>`;
      wrap.prepend(bar);
    }

    // Composer stats row
    if (!document.getElementById('ct-row') && composer.parentElement) {
      composer.parentElement.appendChild(window.ClaudeTrackerUI.buildComposerRow());
    }

    // Toolbar quota strip
    if (!document.getElementById('ct-toolbar-quota')) {
      const plusBtn =
      document.querySelector('button[aria-label="Add content"]') ||
      document.querySelector('button[data-testid="attach-button"]') ||
      document.querySelector('button[aria-label*="attach" i]') ||
      document.querySelector('button[aria-label*="Add" i]') ||
      composer.closest('form')?.querySelector('button');
      if (plusBtn) {
        const strip = window.ClaudeTrackerUI.buildToolbarQuota();
        const toolbarRow = plusBtn.parentElement;
        if (toolbarRow) {
          plusBtn.after(strip);
          // On wide/desktop viewports Claude's toolbar container often has
          // overflow:hidden which clips our injected strip. Unlock it on the
          // immediate row and its parent only — deep ancestor changes risk
          // breaking Claude's own scroll containment.
          [toolbarRow, toolbarRow.parentElement].forEach(el => {
            if (!el) return;
            const cs = window.getComputedStyle(el);
            if (cs.overflowX === 'hidden') el.style.overflowX = 'visible';
            if (cs.overflow  === 'hidden') el.style.overflow  = 'visible';
          });
        }
      }
    }

    // Sidebar quota panel — retried independently on subsequent passes.
    // Absence of a sidebar <nav> is a legitimate terminal state on some
    // layouts (e.g. Incognito chat has none), not an error condition, so
    // it no longer aborts the rest of this function — countdown tick,
    // composer stats, and toolbar updates should still work either way.
    if (!document.getElementById('ct-quota')) {
      const sidebar = document.querySelector('nav.flex-col')
      || document.querySelector('[class*="sidebar"] nav')
      || document.querySelector('nav');
      if (sidebar) {
        const qBox = window.ClaudeTrackerUI.buildQuotaContainer();
        const footer = sidebar.querySelector('.mt-auto') || sidebar.lastElementChild;
        if (footer) sidebar.insertBefore(qBox, footer);
        else sidebar.appendChild(qBox);

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
    const sidebarPresent = !!(
      document.querySelector('nav.flex-col') ||
      document.querySelector('[class*="sidebar"] nav') ||
      document.querySelector('nav')
    );
    const sidebarMissingQuota = sidebarPresent && !document.getElementById('ct-quota');

    if (!document.getElementById('ct-toolbar-quota') || !document.getElementById('ct-row') || sidebarMissingQuota) {
      window.CTS.UIInjected = false;
    }
    if (!window.CTS.UIInjected) tryInjectUI();
  });

  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

  // ─── Exports ─────────────────────────────────────────────────────────────

  window.CTS_Content = {
    tryInjectUI,
    applyAnalysis,
    updateInlineStats,
  };

})();
