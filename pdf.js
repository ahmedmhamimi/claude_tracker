/**
 * Direct PDF export (ISOLATED world). No new tab, no print dialog: the chat is
 * laid out on A4 canvases with the browser's own text engine (so every
 * language, right-to-left text and emoji render correctly), each page is
 * compressed to JPEG and written into a PDF file that downloads immediately.
 * Handles headings, bullet/numbered lists, quotes, tables (as rows), bold,
 * italic, inline code and fenced code blocks. Text in the PDF is an image, so
 * it is not selectable; use Markdown/Text export when you need to copy text.
 *
 * - CTS_Pdf.build(conv, labels) -> Promise<Uint8Array>: the PDF file bytes
 *
 * @requires conversation.js (normalized conversation objects)
 */

(function () {
  'use strict';

  const PW = 1240, PH = 1754;                       // A4 at 150 dpi
  const M = 110, TOP = 120, BOTTOM = PH - 120, CW = PW - 2 * M;
  const SANS = '"Segoe UI", "Helvetica Neue", Roboto, "Noto Sans", "Noto Naskh Arabic", "Noto Sans Hebrew", Arial, sans-serif';
  const MONO = 'Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", "Courier New", monospace';
  const RTL_CH = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
  const isRtl = s => { let r = 0, l = 0; for (const ch of s) { if (RTL_CH.test(ch)) r++; else if (/[A-Za-z]/.test(ch)) l++; } return r > l; };
  const iso = s => { const t = Date.parse(s); return isFinite(t) ? new Date(t).toISOString().replace('.000Z', 'Z') : ''; };
  const font = (size, o) => (o.c ? `${size - 3}px ${MONO}` : `${o.i ? 'italic ' : ''}${o.b ? 'bold ' : ''}${size}px ${SANS}`);

  function runs(text) {
    const out = []; const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g; let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: text.slice(last, m.index) });
      const s = m[0];
      out.push(s.startsWith('**') ? { t: s.slice(2, -2), b: 1 } : s[0] === '`' ? { t: s.slice(1, -1), c: 1 } : { t: s.slice(1, -1), i: 1 });
      last = m.index + s.length;
    }
    if (last < text.length) out.push({ t: text.slice(last) });
    return out;
  }

  function assemble(jpegs) {
    const enc = new TextEncoder(), chunks = [], offs = []; let offset = 0;
    const push = b => { const u = typeof b === 'string' ? enc.encode(b) : b; chunks.push(u); offset += u.length; };
    const n = jpegs.length, total = 2 + 3 * n;
    push(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 226, 227, 207, 211, 10])); // %PDF-1.4 + binary marker
    const begin = id => { offs[id] = offset; push(`${id} 0 obj\n`); };
    begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    begin(2); push(`<< /Type /Pages /Kids [${jpegs.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${n} >>\nendobj\n`);
    jpegs.forEach((j, i) => {
      const pg = 3 + 3 * i, ct = pg + 1, im = pg + 2;
      begin(pg); push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>\nendobj\n`);
      const cs = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q';
      begin(ct); push(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream\nendobj\n`);
      begin(im); push(`<< /Type /XObject /Subtype /Image /Width ${PW} /Height ${PH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.length} >>\nstream\n`);
      push(j); push('\nendstream\nendobj\n');
    });
    const xref = offset;
    push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
    for (let id = 1; id <= total; id++) push(String(offs[id]).padStart(10, '0') + ' 00000 n \n');
    push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(offset); let p = 0;
    chunks.forEach(c => { out.set(c, p); p += c.length; });
    return out;
  }

  async function build(conv, labels) {
    const lab = Object.assign({ user: 'You', assistant: 'Claude', unknown: 'Unknown', attachment: 'Attachment', artifact: 'Artifact', notExported: 'not exported' }, labels || {});
    const pages = []; let cv, ctx, y;

    const newPage = () => {
      cv = document.createElement('canvas'); cv.width = PW; cv.height = PH;
      ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, PW, PH); y = TOP;
    };
    const endPage = () => new Promise((res, rej) => {
      ctx.font = `18px ${SANS}`; ctx.fillStyle = '#9a988f'; ctx.textAlign = 'center'; ctx.direction = 'ltr';
      ctx.fillText(String(pages.length + 1), PW / 2, PH - 60); ctx.textAlign = 'left';
      cv.toBlob(b => { if (!b) return rej(new Error('jpeg')); b.arrayBuffer().then(a => { pages.push(new Uint8Array(a)); res(); }, rej); }, 'image/jpeg', 0.82);
    });
    const ensure = async h => { if (y + h > BOTTOM) { await endPage(); newPage(); } };

    // Break one over-long token (a URL, say) into pieces that fit.
    const splitLong = (tok, avail) => {
      const parts = []; let cur = '';
      for (const ch of tok.t) { ctx.font = tok.f; if (cur && ctx.measureText(cur + ch).width > avail) { parts.push(cur); cur = ch; } else cur += ch; }
      if (cur) parts.push(cur);
      return parts.map(t => { ctx.font = tok.f; return { t, f: tok.f, code: tok.code, w: ctx.measureText(t).width }; });
    };

    async function paragraph(text, o) {
      o = Object.assign({ size: 23, indent: 0, color: '#1f1e1d', after: 8, bullet: null, bold: false, bar: false }, o);
      const lh = o.lh || Math.round(o.size * 1.5), base = Math.round(lh * 0.74);
      const x0 = M + o.indent, avail = PW - M - x0;
      text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

      if (isRtl(text)) {                                   // right-to-left: plain text, right aligned
        const plain = text.replace(/\*\*|`|^#+\s*|^>\s?/g, '');
        ctx.font = font(o.size, { b: o.bold });
        const lines = []; let cur = '';
        plain.split(/\s+/).filter(Boolean).forEach(w => { const t = cur ? cur + ' ' + w : w; if (cur && ctx.measureText(t).width > avail) { lines.push(cur); cur = w; } else cur = t; });
        if (cur) lines.push(cur);
        for (let i = 0; i < lines.length; i++) {
          await ensure(lh);
          ctx.font = font(o.size, { b: o.bold }); ctx.fillStyle = o.color; ctx.direction = 'rtl'; ctx.textAlign = 'right';
          if (o.bar) { ctx.fillStyle = '#d6d3c8'; ctx.fillRect(PW - M - o.indent + 10, y, 4, lh); ctx.fillStyle = o.color; }
          if (o.bullet && i === 0) ctx.fillText(o.bullet, PW - M - o.indent + 26, y + base);
          ctx.fillText(lines[i], PW - M - o.indent, y + base);
          ctx.direction = 'ltr'; ctx.textAlign = 'left'; y += lh;
        }
        y += o.after; return;
      }

      const toks = [];
      runs(text).forEach(r => {
        const f = font(o.size, { b: o.bold || r.b, i: r.i, c: r.c }); ctx.font = f;
        r.t.split(/(\s+)/).forEach(t => { if (t !== '') toks.push({ t, f, code: !!r.c, w: ctx.measureText(t).width }); });
      });
      const lines = [[]]; let w = 0;
      const place = tk => {
        const ws = /^\s+$/.test(tk.t);
        if (ws && !lines[lines.length - 1].length) return;
        if (w + tk.w > avail && lines[lines.length - 1].length) { if (ws) return; lines.push([]); w = 0; }
        lines[lines.length - 1].push(tk); w += tk.w;
      };
      toks.forEach(tk => { if (tk.w > avail) splitLong(tk, avail).forEach(place); else place(tk); });
      for (let i = 0; i < lines.length; i++) {
        await ensure(lh);
        if (o.bar) { ctx.fillStyle = '#d6d3c8'; ctx.fillRect(x0 - 16, y, 4, lh); }
        ctx.textAlign = 'left'; ctx.direction = 'ltr';
        if (o.bullet && i === 0) { ctx.font = font(o.size, { b: o.bold }); ctx.fillStyle = o.color; ctx.fillText(o.bullet, x0 - 28, y + base); }
        let x = x0;
        lines[i].forEach(tk => {
          if (tk.code) { ctx.fillStyle = '#efece4'; ctx.fillRect(x - 2, y + 2, tk.w + 4, lh - 6); }
          ctx.font = tk.f; ctx.fillStyle = o.color; ctx.fillText(tk.t, x, y + base); x += tk.w;
        });
        y += lh;
      }
      y += o.after;
    }

    async function codeBlock(text, lang) {
      const fs = 20, lh = 29, pad = 16;
      ctx.font = `${fs}px ${MONO}`; const cw = ctx.measureText('M').width, max = Math.max(10, Math.floor((CW - 2 * pad) / cw));
      const rows = [''];
      text.replace(/\t/g, '  ').split('\n').forEach(l => { if (!l.length) rows.push(''); for (let i = 0; i < l.length; i += max) rows.push(l.slice(i, i + max)); });
      rows.push('');
      y += 6;
      for (const r of rows) {
        await ensure(lh);
        ctx.fillStyle = '#f3f1ea'; ctx.fillRect(M, y, CW, lh);
        ctx.font = `${fs}px ${MONO}`; ctx.fillStyle = '#2b2a28'; ctx.direction = 'ltr'; ctx.textAlign = 'left';
        ctx.fillText(r, M + pad, y + 21); y += lh;
      }
      y += 12;
    }

    async function markdown(text) {
      let fence = null, buf = [], lang = '';
      for (const raw of text.replace(/\r/g, '').split('\n')) {
        const fm = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(raw);
        if (fence) {
          if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && !fm[2]) { await codeBlock(buf.join('\n'), lang); fence = null; buf = []; } else buf.push(raw);
          continue;
        }
        if (fm) { fence = fm[1]; lang = fm[2] || ''; buf = []; continue; }
        let m;
        if (!raw.trim()) { y += 8; }
        else if ((m = /^(#{1,6})\s+(.*)$/.exec(raw))) { y += 8; await paragraph(m[2], { size: [34, 30, 27, 25, 24, 23][m[1].length - 1], bold: true, after: 6 }); }
        else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) { await ensure(20); ctx.fillStyle = '#d6d3c8'; ctx.fillRect(M, y + 8, CW, 2); y += 22; }
        else if ((m = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(raw))) { const lvl = Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2)); await paragraph(m[3], { indent: 36 + lvl * 30, bullet: /^\d/.test(m[2]) ? m[2] : '•', after: 4 }); }
        else if ((m = /^>\s?(.*)$/.exec(raw))) await paragraph(m[1], { indent: 30, color: '#6b6a63', bar: true, after: 4 });
        else if (/^\s*\|.*\|\s*$/.test(raw)) { if (!/^[\s|:-]+$/.test(raw)) await paragraph(raw.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim()).join('   │   '), { size: 21, after: 3 }); }
        else await paragraph(raw, {});
      }
      if (fence) await codeBlock(buf.join('\n'), lang);
    }

    newPage();
    await paragraph(conv.title || 'Untitled', { size: 42, bold: true, lh: 56, after: 6 });
    const sub = [iso(conv.createdAt).slice(0, 10), conv.model || ''].filter(Boolean).join('  ·  ');
    if (sub) await paragraph(sub, { size: 21, color: '#8a887f', after: 14 });

    for (const m of conv.messages) {
      await ensure(120); y += 28;
      const who = lab[m.role] || lab.unknown;
      await paragraph(who + (m.createdAt ? '   ' + iso(m.createdAt).replace('T', ' ').replace(/:\d\dZ$/, 'Z') : ''), { size: 22, bold: true, color: m.role === 'user' ? '#55534c' : '#B9573A', after: 4 });
      for (const p of m.parts.filter(x => x.type !== 'tool')) {
        if (p.type === 'text') await markdown(p.text);
        else if (p.type === 'code') {
          const lines = p.text.split('\n');
          if (/^\s{0,3}```/.test(lines[0])) lines.shift();
          if (lines.length && /^\s{0,3}```\s*$/.test(lines[lines.length - 1])) lines.pop();
          await codeBlock(lines.join('\n'), p.lang);
        } else if (p.type === 'artifact') { await paragraph(`${lab.artifact}: ${p.title}`, { bold: true, after: 2 }); await codeBlock(p.text, p.language); }
        else if (p.type === 'attachment') await paragraph(`[${lab.attachment}: ${p.name}${p.mime ? ' (' + p.mime + ')' : ''}, ${lab.notExported}]`, { size: 20, color: '#8a887f' });
      }
    }
    await endPage();
    return assemble(pages);
  }

  window.CTS_Pdf = { build };
})();
