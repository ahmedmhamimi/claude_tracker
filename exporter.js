/**
 * Group B runtime (ISOLATED): single-chat export (TXT, Markdown, JSON, PDF built
 * directly by pdf.js, no print dialog) and the user-started bulk export (ZIP). Bulk export fetches
 * sequentially with >= 800 ms between requests, is cancellable and resumable
 * (progress and fetched chats are kept in the store until finished or
 * discarded), and lists every failure in _export-report.txt inside the ZIP.
 * Attachments/images are not exported in this version (names only).
 *
 * - CTS_Exporter.currentChatId() -> string|null
 * - CTS_Exporter.exportOne(id, format) -> Promise<{ok, name?, error?}>: format 'txt'|'md'|'json'|'pdf'
 * - CTS_Exporter.startBulk({ids, formats, resume}) -> {cancel(), done: Promise<summary>}
 * - CTS_Exporter.pendingJob() -> Promise<job|null>: an unfinished bulk job that can be resumed
 * - CTS_Exporter.finishJob(jobId) -> Promise<{ok}>: build the ZIP from whatever was fetched so far
 * - CTS_Exporter.discardJob(jobId) -> Promise
 * - CTS_Exporter.labels() -> object: localized role/attachment labels
 *
 * @requires safe.js, features.js, conversation.js, exporters.js, zip.js, client.js, ui-kit.js
 */

(function () {
  'use strict';

  const Safe = window.CTS_Safe, Conv = window.CTS_Conversation, E = window.CTS_Export, Z = window.CTS_Zip, Client = window.CTS_Client, UI = window.CTS_UI;
  const MIN_GAP_MS = 800;
  const MIME = { txt: 'text/plain', md: 'text/markdown', json: 'application/json', zip: 'application/zip', pdf: 'application/pdf' };
  const EXT_FN = { txt: E.toTxt, md: E.toMarkdown };

  const labels = () => ({ user: UI.T('roleYou'), assistant: UI.T('roleClaude'), attachment: UI.T('lblAttachment'), artifact: UI.T('lblArtifact'), notExported: UI.T('lblNotExported') });
  const currentChatId = () => { const m = /^\/chat\/([A-Za-z0-9-]{8,64})/.exec(location.pathname); return m ? m[1] : null; };

  function download(name, data, mime) {
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    document.documentElement.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 15000);
  }

  function render(conv, ext) {
    if (ext === 'json') return E.toJson(conv);
    return EXT_FN[ext](conv, labels());
  }

  async function fetchNormalized(id) {
    const r = await Client.fetchConv(id, 0);
    if (r.status !== 200 || !r.json) return { error: r.status === 404 ? 'not-found' : r.status === 429 ? 'rate' : 'fetch-failed', status: r.status };
    const conv = Conv.normalize(r.json, { id });
    return { conv };
  }

  async function exportOne(id, format) {
    const f = await fetchNormalized(id);
    if (f.error) return { ok: false, error: f.error };
    const conv = f.conv;
    if (format === 'pdf') {
      try {
        const bytes = await window.CTS_Pdf.build(conv, labels());
        const pname = E.fileName(conv, 'pdf', new Set());
        download(pname, bytes, 'application/pdf');
        return { ok: true, name: pname };
      } catch (err) { Safe.run('export', () => { throw err; }); return { ok: false, error: 'pdf-failed' }; }
    }
    const name = E.fileName(conv, format, new Set());
    download(name, render(conv, format), MIME[format]);
    return { ok: true, name };
  }

  // ─── bulk ─────────────────────────────────────────────────────────────────
  const todayStr = () => new Date().toISOString().slice(0, 10);

  async function buildZip(job, entries) {
    const used = new Set(); const files = [];
    entries.sort((a, b) => String(a.convId).localeCompare(String(b.convId))).forEach(en => {
      en.files.forEach(f => files.push({ name: E.fileName({ title: en.title, createdAt: en.createdAt, updatedAt: en.updatedAt }, f.ext, used), data: f.data }));
    });
    const rep = ['TokenLens export report', 'Date: ' + todayStr(), 'Chats requested: ' + job.ids.length, 'Exported: ' + entries.length, 'Failed or skipped: ' + job.failed.length, ''];
    job.failed.forEach(x => rep.push(`- ${x.id}: ${x.reason}`));
    if (!job.failed.length) rep.push('No failures.');
    rep.push('', 'Note: attachments and images are not exported in this version.');
    files.push({ name: '_export-report.txt', data: rep.join('\n') + '\n' });
    return Z.buildZip(files);
  }

  async function finishJob(jobId) {
    const job = await Client.data('job.get', { jobId });
    if (!job) return { ok: false };
    const entries = (await Client.data('job.entries', { jobId })) || [];
    const zip = await buildZip(job, entries);
    download('TokenLens export ' + todayStr() + '.zip', zip, MIME.zip);
    await Client.call('job.delete', { jobId });
    return { ok: true, count: entries.length };
  }

  const discardJob = jobId => Client.call('job.delete', { jobId });
  const pendingJob = async () => { const j = await Client.data('job.latest'); return j && j.done.length + j.failed.length < j.ids.length ? j : null; };

  function startBulk(opts) {
    let cancelled = false;
    const onProgress = opts.onProgress || (() => {});
    const done = (async () => {
      let job = opts.resume ? await pendingJob() : null;
      if (!job) {
        job = { jobId: Date.now().toString(36), created: Date.now(), ids: Array.from(new Set(opts.ids)).slice(0, 5000), formats: opts.formats && opts.formats.length ? opts.formats : ['md'], done: [], failed: [] };
        await Client.call('job.save', job);
      }
      const finished = new Set(job.done.concat(job.failed.map(x => x.id)));
      const todo = job.ids.filter(id => !finished.has(id));
      let stopped = '', consecutive = 0;
      onProgress({ done: job.done.length, failed: job.failed.length, total: job.ids.length });
      for (const id of todo) {
        if (cancelled) { stopped = 'cancelled'; break; }
        const r = await Client.fetchConv(id, MIN_GAP_MS);
        if (r.status === 200 && r.json) {
          const conv = Conv.normalize(r.json, { id });
          await Client.call('job.putEntry', { jobId: job.jobId, convId: id, files: job.formats.map(ext => ({ ext, data: render(conv, ext) })).map(f => f), title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt });
          job.done.push(id); consecutive = 0;
        } else if (r.status === 429) { stopped = 'rate'; break; }
        else { job.failed.push({ id, reason: r.status === 404 ? 'not found (404)' : 'request failed' + (r.status ? ' (' + r.status + ')' : '') }); if (r.status !== 404 && ++consecutive >= 3) { stopped = 'errors'; break; } }
        await Client.call('job.save', job);
        onProgress({ done: job.done.length, failed: job.failed.length, total: job.ids.length });
      }
      if (!stopped) { const f = await finishJob(job.jobId); return { stopped: '', jobId: job.jobId, count: f.count, failed: job.failed.length }; }
      return { stopped, jobId: job.jobId, count: job.done.length, failed: job.failed.length };
    })();
    return { cancel: () => { cancelled = true; }, done };
  }

  window.CTS_Exporter = { currentChatId, exportOne, startBulk, pendingJob, finishJob, discardJob, labels };
})();
