/**
 * Minimal ZIP writer (pure): store-only (no compression), CRC32, UTF-8 names.
 * Enough for bulk export; no ZIP64, so it refuses archives that would need it.
 *
 * - CTS_Zip.crc32(bytes) -> number: unsigned CRC-32 (IEEE)
 * - CTS_Zip.buildZip(entries, opts) -> Uint8Array: entries [{name, data: string|Uint8Array}]; opts {date: Date}
 * - CTS_Zip.toBytes(str) -> Uint8Array: UTF-8 encode
 */

(function (root) {
  'use strict';

  const enc = new TextEncoder();
  const toBytes = s => (typeof s === 'string' ? enc.encode(s) : s);

  let table = null;
  function crc32(bytes) {
    if (!table) {
      table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dos(d) {
    const y = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function safeName(n) {
    n = String(n).replace(/\\/g, '/').replace(/^\/+/, '');
    if (n.split('/').some(p => p === '..')) throw new Error('unsafe zip entry name');
    return n;
  }

  function buildZip(entries, opts) {
    const when = dos((opts && opts.date) || new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
    if (entries.length > 65535) throw new Error('too many entries for non-ZIP64 archive');
    const chunks = []; const central = []; let offset = 0;
    for (const e of entries) {
      const name = enc.encode(safeName(e.name)), data = toBytes(e.data), crc = crc32(data);
      if (data.length > 0xFFFFFFFE || offset > 0xFFFFFFFE) throw new Error('archive too large for non-ZIP64');
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, when.time, true); lh.setUint16(12, when.date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, when.time, true); ch.setUint16(14, when.date, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdStart = offset; let cdSize = 0;
    central.forEach(c => { cdSize += c.length; });
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, cdStart, true);
    const all = chunks.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0)); let o = 0;
    all.forEach(c => { out.set(c, o); o += c.length; });
    return out;
  }

  const api = { crc32, buildZip, toBytes };
  root.CTS_Zip = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
