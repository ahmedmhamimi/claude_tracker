/**
 * Composer insertion: the single place that puts text into claude.ai's message
 * box. Reused by Handoff (Group C) and Snippets (Group E). Strategies, in order:
 *   1. a synthetic paste event carrying text/plain,
 *   2. document.execCommand('insertText'),
 *   3. copy to the clipboard and tell the user to paste.
 * After each attempt the composer is READ BACK; the next strategy only runs
 * if the text is not there. Never sends anything. All DOM access goes through
 * an injectable 'env', so the fall-through logic is tested with a mock.
 *
 * - CTS_Composer.insertText(text, env?) -> Promise<{ok, method:'paste'|'exec'|'clipboard'|'none', manual:boolean}>
 * - CTS_Composer.contains(haystack, text) -> boolean: whitespace-insensitive check of start and end of text
 * - CTS_Composer.realEnv(win?) -> env: the real-DOM environment (uses CTS_Endpoints selectors)
 * - CTS_Composer.findComposer(doc) -> Element|null
 *
 * @requires endpoints.js
 */

(function (root) {
  'use strict';

  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // The editor rewrites whitespace (paragraph wrappers, collapsed newlines), so compare
  // the normalised first and last 40 characters rather than the whole string.
  function contains(haystack, text) {
    const h = norm(haystack), t = norm(text);
    if (!t) return true;
    return h.includes(t.slice(0, 40)) && h.includes(t.slice(-40)) && h.length >= Math.min(t.length, 40);
  }

  function findComposer(doc) {
    const E = root.CTS_Endpoints;
    const hit = E && E.find(doc, 'composer');
    return hit ? hit.el : null;
  }

  function realEnv(win) {
    win = win || root;
    const doc = win.document;
    return {
      settleMs: 80,
      composer: () => findComposer(doc),
      focus: el => { el.focus(); },
      caretToEnd: el => {
        if (el.tagName === 'TEXTAREA') { el.selectionStart = el.selectionEnd = el.value.length; return; }
        const sel = win.getSelection(), r = doc.createRange();
        r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
      },
      read: el => (el.tagName === 'TEXTAREA' ? el.value : el.innerText || el.textContent || ''),
      paste: (el, text) => {
        const dt = new win.DataTransfer(); dt.setData('text/plain', text);
        return el.dispatchEvent(new win.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      },
      exec: (el, text) => { try { return !!doc.execCommand('insertText', false, text); } catch (_) { return false; } },
      clipboard: text => (win.navigator.clipboard && win.navigator.clipboard.writeText ? win.navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false)),
      sleep: ms => new Promise(r => setTimeout(r, ms)),
    };
  }

  async function insertText(text, env) {
    env = env || realEnv();
    text = String(text == null ? '' : text);
    if (!text) return { ok: false, method: 'none', manual: false };
    const el = env.composer();
    if (el) {
      const attempts = [['paste', env.paste], ['exec', env.exec]];
      for (const [method, fn] of attempts) {
        try {
          env.focus(el); env.caretToEnd(el);
          fn(el, text);
          await env.sleep(env.settleMs || 0);
          if (contains(env.read(el), text)) return { ok: true, method, manual: false };
        } catch (_) { /* fall through to the next strategy */ }
      }
    }
    let copied = false;
    try { copied = !!(await env.clipboard(text)); } catch (_) {}
    return copied ? { ok: false, method: 'clipboard', manual: true } : { ok: false, method: 'none', manual: false };
  }

  const api = { insertText, contains, realEnv, findComposer };
  root.CTS_Composer = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
