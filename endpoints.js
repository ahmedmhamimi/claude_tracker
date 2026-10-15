/**
 * Every claude.ai API path and DOM selector the 6.0 features depend on, in one
 * place, each with ordered fallbacks and a note on what it is for. When
 * claude.ai changes, this is the only file to touch. Loaded in BOTH worlds.
 * No DOM or chrome.* access of its own: selfTest() receives a document-like
 * object, so it is testable in Node with a mock.
 *
 * - CTS_Endpoints.PATHS -> object: path templates with {org} / {id} placeholders (claude.ai only)
 * - CTS_Endpoints.buildUrl(name, params) -> string: absolute https://claude.ai URL; throws for any other host
 * - CTS_Endpoints.SELECTORS -> object: key -> {note, list: string[]} (first match wins)
 * - CTS_Endpoints.find(doc, key) -> {el, index}|null: first match and which fallback hit
 * - CTS_Endpoints.selfTest(doc) -> object[]: [{key, kind, ok, hitIndex, note}] for the diagnostics report
 * - CTS_Endpoints.checkUsageShape(json) / checkConversationShape(json) / checkListShape(json) -> object: structural report, never contains values
 */

(function (root) {
  'use strict';

  const ORIGIN = 'https://claude.ai';

  const PATHS = {
    usage:        { tpl: '/api/organizations/{org}/usage',                                       note: 'Quota readings (existing, network.js)' },
    convList:     { tpl: '/api/organizations/{org}/chat_conversations',                          note: 'Chat list: uuid, created_at, updated_at (existing)' },
    conv:         { tpl: '/api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=raw', note: 'Full conversation (existing)' },
  };

  const SELECTORS = {
    composer: {
      note: 'Message input (existing selectors first; ProseMirror fallbacks are unverified)',
      list: ['div[contenteditable="true"]', 'textarea[placeholder]', '.ProseMirror[contenteditable]', '[data-testid="chat-input"]'],
    },
    sendButton: {
      note: 'Send button, used to locate the composer card',
      list: ['button[aria-label*="send" i]', 'button[type="submit"]'],
    },
    transcriptRow: {
      note: 'One row per message (existing, Aug-2026 DOM)',
      list: ['[data-testid="transcript-row"]'],
    },
    assistantActionBar: {
      note: 'Present only on assistant rows (existing)',
      list: ['[data-testid^="action-bar-"]'],
    },
    sidebar: {
      note: 'Sidebar root (existing, content.js getSidebarRoot)',
      list: ['[data-testid="sidebar"]', 'aside.dframe-sidebar', 'nav.flex-col', 'nav'],
    },
    widgetHeaderActions: {
      note: 'TokenLens own widget header, anchor for the panel button',
      list: ['#ct-toolbar-quota .ct-tq-actions'],
    },
    composerRowRight: {
      note: 'TokenLens own composer row slot, anchor for the handoff action',
      list: ['#ct-row-right'],
    },
  };

  function buildUrl(name, params) {
    const p = PATHS[name];
    if (!p) throw new Error('unknown endpoint ' + name);
    let path = p.tpl.replace(/\{(\w+)\}/g, (_, k) => {
      const v = params && params[k];
      if (!v || !/^[A-Za-z0-9-]{8,64}$/.test(String(v))) throw new Error('bad param ' + k);
      return String(v);
    });
    const url = ORIGIN + path;
    if (new URL(url).origin !== ORIGIN) throw new Error('host not allowed');
    return url;
  }

  function find(doc, key) {
    const s = SELECTORS[key];
    if (!s || !doc) return null;
    for (let i = 0; i < s.list.length; i++) {
      let el = null;
      try { el = doc.querySelector(s.list[i]); } catch (_) {}
      if (el) return { el, index: i };
    }
    return null;
  }

  function selfTest(doc) {
    return Object.keys(SELECTORS).map(key => {
      const hit = find(doc, key);
      return { key, kind: 'selector', ok: !!hit, hitIndex: hit ? hit.index : -1, note: SELECTORS[key].note };
    }).concat(Object.keys(PATHS).map(key => ({ key, kind: 'endpoint', ok: null, hitIndex: -1, note: PATHS[key].note })));
  }

  // Structural checks report field PRESENCE and types only, never values.
  const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

  function checkUsageShape(j) {
    const out = { type: typeOf(j) };
    if (!j || typeof j !== 'object') return out;
    ['five_hour', 'seven_day'].forEach(k => {
      const w = j[k];
      out[k] = w && typeof w === 'object'
        ? { utilization: typeOf(w.utilization), resets_at: typeOf(w.resets_at) }
        : typeOf(w);
    });
    return out;
  }

  function checkConversationShape(j) {
    const out = { type: typeOf(j) };
    if (!j || typeof j !== 'object') return out;
    ['uuid', 'name', 'model', 'created_at', 'updated_at', 'current_leaf_message_uuid'].forEach(k => { out[k] = typeOf(j[k]); });
    out.chat_messages = typeOf(j.chat_messages);
    const m = Array.isArray(j.chat_messages) ? j.chat_messages : [];
    out.messageCount = m.length;
    const first = m[0] && typeof m[0] === 'object' ? m[0] : null;
    if (first) {
      out.message = {};
      ['uuid', 'sender', 'text', 'created_at', 'parent_message_uuid', 'index', 'attachments', 'files', 'files_v2'].forEach(k => { out.message[k] = typeOf(first[k]); });
      out.message.content = typeOf(first.content);
    }
    const partTypes = {};
    m.forEach(x => { if (x && Array.isArray(x.content)) x.content.forEach(c => { const t = c && c.type ? String(c.type).slice(0, 24) : 'none'; partTypes[t] = (partTypes[t] || 0) + 1; }); });
    out.contentPartTypes = partTypes;
    return out;
  }

  function checkListShape(j) {
    const out = { type: typeOf(j) };
    if (Array.isArray(j)) {
      out.count = j.length;
      const f = j[0] && typeof j[0] === 'object' ? j[0] : null;
      if (f) { out.item = {}; ['uuid', 'name', 'created_at', 'updated_at'].forEach(k => { out.item[k] = typeOf(f[k]); }); }
    }
    return out;
  }

  const api = { ORIGIN, PATHS, SELECTORS, buildUrl, find, selfTest, checkUsageShape, checkConversationShape, checkListShape };
  root.CTS_Endpoints = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
