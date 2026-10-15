/**
 * Conversation normalizer (pure): raw claude.ai conversation JSON in, one
 * stable shape out. Export, handoff and the indexer all share it. No DOM, no
 * chrome.*. Never throws; anything unexpected is recorded in warnings[].
 *
 * Required input fields are only those the v5.9 code already reads:
 * chat_messages[], sender ('human'|'assistant'), content[].text, text.
 * Everything else (name, model, uuid, parent_message_uuid,
 * current_leaf_message_uuid, content[].type, attachments/files) is an OPTIONAL
 * PROBE: used when present, warned about when absent, never required.
 *
 * - CTS_Conversation.normalize(raw, opts) -> {id,title,createdAt,updatedAt,model,messages,meta,warnings}
 *     opts: {id, titleHint, allBranches}
 * - CTS_Conversation.splitFences(text) -> [{type:'text'|'code', text, lang?}]: fence-aware splitter (never splits a fence)
 * - CTS_Conversation.estimateTokens(text) -> number: the existing heuristic from shared.js
 *
 * Message: {id, role:'user'|'assistant'|'unknown', createdAt, parts:[{type:'text'|'code'|'artifact'|'attachment'|'tool', ...}], text}
 * message.text equals what shared.js extractText() would return, so token
 * estimates stay identical to the existing context estimate.
 */

(function (root) {
  'use strict';

  const Shared = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./shared.js') : root.CTS_Shared;
  const estimateTokens = t => (Shared && Shared.estimateTokens ? Shared.estimateTokens(t) : Math.ceil(String(t || '').length / 4));

  // ─── Fence-aware splitting ────────────────────────────────────────────────
  // A fence opens with ``` (optionally a language) at line start and closes
  // with ``` at line start. An unterminated fence runs to the end of the text.
  function splitFences(text) {
    text = String(text == null ? '' : text);
    const out = [];
    const lines = text.split('\n');
    let buf = [], inCode = false, lang = '';
    const flush = (type) => {
      if (!buf.length) return;
      const o = { type, text: buf.join('\n') };
      buf = [];
      if (type === 'text' && o.text === '') return; // artefact of a trailing newline
      if (type === 'code') o.lang = lang;
      out.push(o);
    };
    for (const line of lines) {
      const m = /^\s{0,3}```(.*)$/.exec(line);
      if (m) {
        if (!inCode) { flush('text'); inCode = true; lang = m[1].trim().split(/\s+/)[0] || ''; buf.push(line); }
        else if (m[1].trim() === '') { buf.push(line); flush('code'); inCode = false; lang = ''; }
        else buf.push(line);
      } else buf.push(line);
    }
    flush(inCode ? 'code' : 'text');
    return out;
  }

  const str = v => (typeof v === 'string' ? v : null);

  function normalize(raw, opts) {
    opts = opts || {};
    const warnings = [];
    const warned = {};
    const warn = (code) => { if (!warned[code]) { warned[code] = 1; warnings.push(code); } };

    const empty = () => ({
      id: opts.id || null, title: opts.titleHint || '', createdAt: null, updatedAt: null, model: null,
      messages: [], meta: { messageCount: 0, rawMessageCount: 0, estTokens: 0, branchCount: null, branchSelected: false, titleDerived: true },
      warnings,
    });

    if (!raw || typeof raw !== 'object') { warn('not-an-object'); return empty(); }
    if (!Array.isArray(raw.chat_messages)) { warn('no-chat_messages'); const e = empty(); e.id = str(raw.uuid) || e.id; return e; }

    let msgs = raw.chat_messages.filter(m => m && typeof m === 'object');
    if (msgs.length !== raw.chat_messages.length) warn('skipped-non-object-messages');
    const rawCount = msgs.length;

    // ── Branch selection ────────────────────────────────────────────────────
    let branchCount = null, branchSelected = false;
    const leaf = str(raw.current_leaf_message_uuid);
    const allHaveIds = msgs.length > 0 && msgs.every(m => str(m.uuid));
    const haveParents = allHaveIds && msgs.some(m => str(m.parent_message_uuid));
    if (haveParents) {
      const byId = new Map(msgs.map(m => [m.uuid, m]));
      const parentIds = new Set(msgs.map(m => m.parent_message_uuid).filter(Boolean));
      branchCount = msgs.filter(m => !parentIds.has(m.uuid)).length;
      if (leaf && byId.has(leaf) && !opts.allBranches) {
        const chain = []; const seen = new Set();
        let cur = byId.get(leaf);
        while (cur && !seen.has(cur.uuid)) { seen.add(cur.uuid); chain.push(cur); cur = byId.get(cur.parent_message_uuid); }
        chain.reverse();
        msgs = chain; branchSelected = true;
      } else if (!opts.allBranches) warn('leaf-missing');
    } else if (rawCount > 0) warn('branch-info-missing');

    // ── Messages ────────────────────────────────────────────────────────────
    let model = str(raw.model);
    const messages = msgs.map(m => {
      let role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : 'unknown';
      if (role === 'unknown') warn('unknown-sender');
      if (!model && str(m.model)) model = m.model;
      const parts = [];
      let text = '';

      const addText = (t) => {
        text += t;
        splitFences(t).forEach(p => { if (p.text !== '' || p.type === 'code') parts.push(p); });
      };

      if (Array.isArray(m.content)) {
        m.content.forEach(c => {
          if (!c || typeof c !== 'object') return;
          const type = str(c.type);
          if (type === 'tool_use' || type === 'server_tool_use') {
            const inp = c.input && typeof c.input === 'object' ? c.input : {};
            if (c.name === 'artifacts' || (str(inp.content) && str(inp.type))) {
              parts.push({ type: 'artifact', id: str(inp.id), title: str(inp.title) || 'Artifact', language: str(inp.language), mime: str(inp.type), text: str(inp.content) || '' });
            } else parts.push({ type: 'tool', kind: 'tool_use', name: str(c.name) || '' });
          } else if (type === 'tool_result') {
            parts.push({ type: 'tool', kind: 'tool_result', name: str(c.name) || '' });
          } else if (type === 'thinking' || type === 'redacted_thinking') {
            parts.push({ type: 'tool', kind: 'thinking', name: '' });
          } else if (typeof c.text === 'string' && (!type || type === 'text')) {
            addText(c.text);
          } else if (typeof c.text === 'string') {
            // unknown part type that still carries text: keep the text (existing extractText would)
            warn('unknown-part:' + String(type).slice(0, 24)); addText(c.text);
          } else if (type) { warn('unknown-part:' + String(type).slice(0, 24)); parts.push({ type: 'tool', kind: String(type).slice(0, 24), name: '' }); }
        });
      } else if (typeof m.text === 'string') {
        addText(m.text);
      }

      ['attachments', 'files', 'files_v2'].forEach(k => {
        if (Array.isArray(m[k])) m[k].forEach(f => {
          if (!f || typeof f !== 'object') return;
          parts.push({ type: 'attachment', name: str(f.file_name) || str(f.name) || 'unnamed', mime: str(f.file_type) || str(f.mime_type) || str(f.mime) || '' });
        });
      });

      return { id: str(m.uuid), role, createdAt: str(m.created_at), parts, text };
    });

    if (!str(raw.uuid) && !opts.id) warn('id-missing');
    if (!str(raw.created_at)) warn('created-missing');
    if (!model) warn('model-missing');

    let title = str(raw.name) || str(raw.title) || '';
    let titleDerived = false;
    if (!title.trim()) {
      warn('title-missing'); titleDerived = true;
      title = opts.titleHint || '';
      if (!title) {
        const u = messages.find(m => m.role === 'user' && m.text.trim());
        title = u ? u.text.trim().replace(/\s+/g, ' ').slice(0, 60) : 'Untitled chat';
      }
    }

    let est = 0;
    messages.forEach(m => { est += estimateTokens(m.text); });

    return {
      id: str(raw.uuid) || opts.id || null,
      title,
      createdAt: str(raw.created_at),
      updatedAt: str(raw.updated_at),
      model: model || null,
      messages,
      meta: { messageCount: messages.length, rawMessageCount: rawCount, estTokens: est, branchCount, branchSelected, titleDerived },
      warnings,
    };
  }

  const api = { normalize, splitFences, estimateTokens };
  root.CTS_Conversation = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
