/**
 * Conversation exporters (pure): TXT, Markdown, JSON, a structured print model
 * for the PDF flow, and filename helpers. Input is always the output of
 * CTS_Conversation.normalize(). Output is deterministic (no export timestamp).
 * Attachments/images are NOT exported in this version: only their names and
 * types appear, as placeholders. LaTeX stays as monospace source text.
 *
 * - CTS_Export.toTxt(conv, labels) -> string
 * - CTS_Export.toMarkdown(conv, labels) -> string: YAML frontmatter + one heading per message
 * - CTS_Export.toJson(conv) -> string: {"schema":"tokenlens.conversation/1","conversation":{...},"messages":[...]}
 * - CTS_Export.toPrintModel(conv, labels) -> {title, subtitle, blocks[]}: rendered with textContent by export-print.js (no HTML strings)
 * - CTS_Export.sanitizeFilename(title, maxChars) -> string
 * - CTS_Export.fileName(conv, ext, used) -> string: "YYYY-MM-DD - title.ext", numeric suffix on collision ('used' is a Set, mutated)
 * labels: {user, assistant, attachment, artifact, notExported} (English defaults)
 */

(function (root) {
  'use strict';

  const DEFAULT_LABELS = { user: 'You', assistant: 'Claude', unknown: 'Unknown', attachment: 'Attachment', artifact: 'Artifact', notExported: 'not exported' };
  const L = labels => Object.assign({}, DEFAULT_LABELS, labels || {});
  const roleLabel = (m, l) => l[m.role] || l.unknown;
  const iso = s => { const t = Date.parse(s); return isFinite(t) ? new Date(t).toISOString().replace('.000Z', 'Z') : ''; };

  // ─── Filenames ────────────────────────────────────────────────────────────
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  function sanitizeFilename(title, maxChars) {
    maxChars = maxChars || 80;
    let s = String(title == null ? '' : title).normalize('NFC')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g, '') // bidi/zero-width controls can disguise file names
      .replace(/[<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    s = Array.from(s).slice(0, maxChars).join('').trim();           // cut by code point, never inside an emoji
    s = s.replace(/^[. ]+|[. ]+$/g, '');                              // Windows dislikes trailing dots/spaces
    if (!s) s = 'Untitled';
    if (RESERVED.test(s)) s = '_' + s;
    return s;
  }

  function fileName(conv, ext, used) {
    const d = iso(conv.createdAt) || iso(conv.updatedAt);
    const stem = (d ? d.slice(0, 10) : 'undated') + ' - ' + sanitizeFilename(conv.title);
    let name = stem + '.' + ext, n = 2;
    const seen = used || new Set();
    while (seen.has(name.toLowerCase())) name = stem + ' (' + (n++) + ').' + ext;
    seen.add(name.toLowerCase());
    return name;
  }

  // ─── Shared walk ──────────────────────────────────────────────────────────
  const visibleParts = m => m.parts.filter(p => p.type !== 'tool');
  const attachLine = (p, l) => `[${l.attachment}: ${p.name}${p.mime ? ' (' + p.mime + ')' : ''}, ${l.notExported}]`;

  function toTxt(conv, labels) {
    const l = L(labels);
    const out = [conv.title, '='.repeat(Math.min(60, Array.from(conv.title).length)), ''];
    if (conv.createdAt) out.push('Created: ' + iso(conv.createdAt));
    if (conv.updatedAt) out.push('Updated: ' + iso(conv.updatedAt));
    out.push('');
    conv.messages.forEach(m => {
      out.push(`[${roleLabel(m, l)}]` + (m.createdAt ? ' ' + iso(m.createdAt) : ''));
      visibleParts(m).forEach(p => {
        if (p.type === 'text' || p.type === 'code') out.push(p.text);
        else if (p.type === 'artifact') out.push(`--- ${l.artifact}: ${p.title} ---`, p.text, '--- end ---');
        else if (p.type === 'attachment') out.push(attachLine(p, l));
      });
      out.push('');
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  // A fence must be longer than any run of backticks inside what it wraps.
  function fenceFor(text) {
    let max = 2; (String(text).match(/`+/g) || []).forEach(r => { if (r.length > max) max = r.length; });
    return '`'.repeat(max + 1);
  }

  function toMarkdown(conv, labels) {
    const l = L(labels);
    const fm = ['---', 'title: ' + JSON.stringify(conv.title)];
    if (conv.createdAt) fm.push('created: ' + iso(conv.createdAt));
    if (conv.updatedAt) fm.push('updated: ' + iso(conv.updatedAt));
    if (conv.model) fm.push('model: ' + JSON.stringify(conv.model));
    if (conv.id) fm.push('url: https://claude.ai/chat/' + conv.id);
    fm.push('source: TokenLens', 'message_count: ' + conv.meta.messageCount, 'est_tokens: ' + conv.meta.estTokens, '---', '');
    const out = fm;
    conv.messages.forEach(m => {
      out.push('## ' + roleLabel(m, l), '');
      if (m.createdAt) out.push('*' + iso(m.createdAt) + '*', '');
      visibleParts(m).forEach(p => {
        if (p.type === 'text' || p.type === 'code') out.push(p.text, '');
        else if (p.type === 'artifact') {
          const f = fenceFor(p.text);
          out.push(`**${l.artifact}: ${p.title}**`, '', f + (p.language || ''), p.text, f, '');
        } else if (p.type === 'attachment') out.push('*' + attachLine(p, l) + '*', '');
      });
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  function toJson(conv) {
    const c = { id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt, model: conv.model, meta: conv.meta, warnings: conv.warnings };
    return JSON.stringify({ schema: 'tokenlens.conversation/1', conversation: c, messages: conv.messages }, null, 2) + '\n';
  }

  function toPrintModel(conv, labels) {
    const l = L(labels);
    const blocks = [];
    conv.messages.forEach(m => {
      blocks.push({ kind: 'role', text: roleLabel(m, l), role: m.role, time: m.createdAt ? iso(m.createdAt) : '' });
      visibleParts(m).forEach(p => {
        if (p.type === 'text') p.text.split(/\n{2,}/).forEach(par => { if (par.trim()) blocks.push({ kind: 'text', text: par.trim() }); });
        else if (p.type === 'code') {
          // drop the ``` marker lines; the lang label and monospace box carry that information in print
          const lines = p.text.split('\n');
          if (/^\s{0,3}```/.test(lines[0])) lines.shift();
          if (lines.length && /^\s{0,3}```\s*$/.test(lines[lines.length - 1])) lines.pop();
          blocks.push({ kind: 'code', text: lines.join('\n'), lang: p.lang || '' });
        }
        else if (p.type === 'artifact') blocks.push({ kind: 'artifact', title: `${l.artifact}: ${p.title}`, text: p.text });
        else if (p.type === 'attachment') blocks.push({ kind: 'note', text: attachLine(p, l) });
      });
    });
    return { title: conv.title, subtitle: [iso(conv.createdAt).slice(0, 10), conv.model || ''].filter(Boolean).join('  ·  '), blocks };
  }

  const api = { toTxt, toMarkdown, toJson, toPrintModel, sanitizeFilename, fileName, DEFAULT_LABELS };
  root.CTS_Export = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
