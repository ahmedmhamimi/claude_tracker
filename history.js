/**
 * Usage history logic (pure; no DOM, no chrome.*). Used by the recorder in the
 * ISOLATED world, the service worker store, and the panel/popup views.
 *
 * Snapshot: {t (ms), u5h, u7d (percent 0-100), r5h, r7d (reset, epoch seconds|null)}
 * Message record: {t, convId, convTokensEst, quotaDelta5h}
 *
 * - CTS_History.shouldRecord(last, cur, now) -> boolean: >=5 min since last write, or either value moved >=1 point
 * - CTS_History.cleanSnap(raw) -> snapshot|null: validates and rounds a reading
 * - CTS_History.compact(snaps, now) -> {keep, dropTs}: 90-day retention, hourly buckets (peak kept) after 14 days
 * - CTS_History.pace(snaps, now) -> null | {willReach, rate, hitAt, resetAt, minutesBeforeReset}: burn-rate projection for the current 5h window
 * - CTS_History.nextAlert(cur, cfg, fired, now) -> {alert, newFired}: at most ONE alert, once per window per threshold
 * - CTS_History.dailyPeaks / calendarHeat / weekdayHour / limitHits / costBuckets / topConversations: view data
 * - CTS_History.toCsv(snaps) -> string
 */

(function (root) {
  'use strict';

  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const MIN_GAP_MS = 5 * MIN, RETAIN_MS = 90 * DAY, FULL_RES_MS = 14 * DAY;

  const fin = v => typeof v === 'number' && isFinite(v);

  function cleanSnap(r) {
    if (!r || !fin(r.t) || !fin(r.u5h) || !fin(r.u7d)) return null;
    const ts = v => (fin(v) && v > 0 ? Math.round(v) : null);
    return { t: Math.round(r.t), u5h: Math.max(0, Math.min(100, Math.round(r.u5h))), u7d: Math.max(0, Math.min(100, Math.round(r.u7d))), r5h: ts(r.r5h), r7d: ts(r.r7d) };
  }

  function shouldRecord(last, cur, now) {
    if (!cur) return false;
    if (!last) return true;
    const t = fin(now) ? now : cur.t;
    if (t - last.t >= MIN_GAP_MS) return true;
    return Math.abs(cur.u5h - last.u5h) >= 1 || Math.abs(cur.u7d - last.u7d) >= 1;
  }

  // ─── Retention ────────────────────────────────────────────────────────────
  // Within an hourly bucket the snapshot with the HIGHEST 5h value survives
  // (ties: the latest), so downsampling can never hide a peak or a limit hit.
  function compact(snaps, now) {
    const sorted = snaps.slice().sort((a, b) => a.t - b.t);
    const keep = [], dropTs = [];
    const buckets = new Map();
    for (const s of sorted) {
      const age = now - s.t;
      if (age > RETAIN_MS) { dropTs.push(s.t); continue; }
      if (age <= FULL_RES_MS) { keep.push(s); continue; }
      const k = Math.floor(s.t / HOUR);
      const cur = buckets.get(k);
      if (!cur) buckets.set(k, s);
      else if (s.u5h >= cur.u5h) { dropTs.push(cur.t); buckets.set(k, s); } else dropTs.push(s.t);
    }
    const down = Array.from(buckets.values());
    return { keep: down.concat(keep).sort((a, b) => a.t - b.t), dropTs };
  }

  // ─── Pace ─────────────────────────────────────────────────────────────────
  // Rate = (total points gained) / (total ACTIVE time) over consecutive
  // snapshot pairs inside the current 5h window. A pair is active when it is
  // at most 30 min apart and either gained points or is within 10 min. Dividing
  // totals (not averaging per-pair rates) keeps the whole-point rounding of the
  // readings from inflating the estimate.
  function pace(snaps, now) {
    if (!snaps || !snaps.length) return null;
    const sorted = snaps.slice().sort((a, b) => a.t - b.t);
    const last = sorted[sorted.length - 1];
    if (!last.r5h) return null;
    const resetAt = last.r5h * 1000, windowStart = resetAt - 5 * HOUR;
    if (now - windowStart < 15 * MIN) return null;
    if (now - last.t > 20 * MIN) return null;           // idle right now: stay silent
    if (last.u5h >= 100) return null;
    const w = sorted.filter(s => s.r5h && Math.abs(s.r5h - last.r5h) <= 120 && s.t >= windowStart - MIN && s.t <= resetAt);
    if (w.length < 4) return null;
    let du = 0, dt = 0;
    for (let i = 1; i < w.length; i++) {
      const gain = w[i].u5h - w[i - 1].u5h, gap = w[i].t - w[i - 1].t;
      if (gap <= 0 || gap > 30 * MIN) continue;
      if (gain < 0) continue;                           // defensive: window glitch
      if (gain > 0 || gap <= 10 * MIN) { du += gain; dt += gap; }
    }
    if (dt < 10 * MIN || du < 3) return null;
    const rate = du / (dt / HOUR);                      // points per active hour
    const hitAt = last.t + ((100 - last.u5h) / rate) * HOUR;
    if (hitAt >= resetAt) return { willReach: false, rate, hitAt, resetAt, minutesBeforeReset: 0 };
    const minutesBeforeReset = Math.round((resetAt - hitAt) / MIN / 5) * 5;
    if (minutesBeforeReset < 5) return { willReach: false, rate, hitAt, resetAt, minutesBeforeReset: 0 };
    return { willReach: true, rate, hitAt, resetAt, minutesBeforeReset };
  }

  // ─── Alerts ───────────────────────────────────────────────────────────────
  function nextAlert(cur, cfg, fired, now) {
    const newFired = {};
    Object.keys(fired || {}).forEach(k => { const ts = Number(k.split(':')[1]); if (!ts || ts * 1000 > now - 2 * DAY) newFired[k] = true; });
    const crossed = [];
    [['5h', 'w5h', cur && cur.u5h, cur && cur.r5h], ['7d', 'w7d', cur && cur.u7d, cur && cur.r7d]].forEach(([win, ck, util, reset]) => {
      const c = cfg && cfg[ck]; if (!c || !fin(util)) return;
      [['t80', 'v80'], ['t95', 'v95']].forEach(([on, val]) => {
        const v = c[val];
        if (c[on] && fin(v) && util >= v) {
          const key = win + ':' + (reset || 'x') + ':' + v;
          if (!newFired[key]) crossed.push({ win, threshold: v, key, util });
        }
      });
    });
    if (!crossed.length) return { alert: null, newFired };
    crossed.sort((a, b) => b.threshold - a.threshold || (a.win === '5h' ? -1 : 1));
    crossed.forEach(c => { newFired[c.key] = true; });   // lower thresholds crossed at the same time never stack later
    return { alert: crossed[0], newFired };
  }

  // ─── Views ────────────────────────────────────────────────────────────────
  const dayIdx = (t, off) => Math.floor((t + off * MIN) / DAY);
  const defOff = () => -new Date().getTimezoneOffset();

  function dailyPeaks(snaps, days, now, off) {
    off = fin(off) ? off : defOff();
    const end = dayIdx(now, off), start = end - days + 1;
    const out = Array.from({ length: days }, (_, i) => ({ day: start + i, peak5h: null, peak7d: null }));
    for (const s of snaps) {
      const i = dayIdx(s.t, off) - start;
      if (i < 0 || i >= days) continue;
      const o = out[i];
      if (o.peak5h === null || s.u5h > o.peak5h) o.peak5h = s.u5h;
      if (o.peak7d === null || s.u7d > o.peak7d) o.peak7d = s.u7d;
    }
    return out;
  }

  // Points of the 5h window gained between consecutive snapshots of the SAME window.
  function gains(snaps) {
    const sorted = snaps.slice().sort((a, b) => a.t - b.t); const out = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      if (a.r5h && b.r5h && Math.abs(a.r5h - b.r5h) <= 120 && b.u5h > a.u5h) out.push({ t: b.t, gain: b.u5h - a.u5h });
    }
    return out;
  }

  function calendarHeat(snaps, days, now, off) {
    off = fin(off) ? off : defOff();
    const end = dayIdx(now, off), start = end - days + 1;
    const out = Array.from({ length: days }, (_, i) => ({ day: start + i, points: 0 }));
    gains(snaps).forEach(g => { const i = dayIdx(g.t, off) - start; if (i >= 0 && i < days) out[i].points += g.gain; });
    return out;
  }

  function weekdayHour(snaps, now, days, off) {
    off = fin(off) ? off : defOff();
    const m = Array.from({ length: 7 }, () => new Array(24).fill(0));
    gains(snaps).forEach(g => {
      if (now - g.t > (days || 90) * DAY) return;
      const local = g.t + off * MIN;
      const d = new Date(local);
      m[d.getUTCDay()][d.getUTCHours()] += g.gain;
    });
    return m;
  }

  function limitHits(snaps) {
    const byWin = new Map();
    snaps.slice().sort((a, b) => a.t - b.t).forEach(s => {
      if (s.u5h >= 100 && s.r5h) { const k = Math.round(s.r5h / 60); if (!byWin.has(k)) byWin.set(k, { t: s.t, r5h: s.r5h }); }
    });
    return Array.from(byWin.values());
  }

  const BUCKETS = [{ id: 'lt20', max: 20000 }, { id: '20to60', max: 60000 }, { id: '60to120', max: 120000 }, { id: 'gt120', max: Infinity }];
  function costBuckets(costs) {
    const out = BUCKETS.map(b => ({ id: b.id, n: 0, sum: 0, avg: null }));
    costs.forEach(c => {
      if (!c || !fin(c.convTokensEst) || !fin(c.quotaDelta5h)) return;
      const i = BUCKETS.findIndex(b => c.convTokensEst < b.max);
      out[i].n++; out[i].sum += c.quotaDelta5h;
    });
    out.forEach(o => { o.avg = o.n ? o.sum / o.n : null; });
    return out;
  }

  function topConversations(convs, n) {
    return convs.filter(c => c && fin(c.estTokens) && c.status !== 'missing').sort((a, b) => b.estTokens - a.estTokens || String(a.id).localeCompare(b.id)).slice(0, n || 10);
  }

  function toCsv(snaps) {
    const rows = ['time_iso,utilization_5h_pct,utilization_7d_pct,reset_5h_iso,reset_7d_iso'];
    const iso = s => (s ? new Date(s * 1000).toISOString() : '');
    snaps.slice().sort((a, b) => a.t - b.t).forEach(s => rows.push([new Date(s.t).toISOString(), s.u5h, s.u7d, iso(s.r5h), iso(s.r7d)].join(',')));
    return rows.join('\n') + '\n';
  }

  const api = { shouldRecord, cleanSnap, compact, pace, nextAlert, dailyPeaks, calendarHeat, weekdayHour, limitHits, costBuckets, topConversations, toCsv, BUCKETS, MIN_GAP_MS };
  root.CTS_History = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
