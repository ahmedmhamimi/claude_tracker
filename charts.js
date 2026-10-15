/**
 * Inline-SVG chart builders (pure string builders; no chart library).
 * Only numbers and escaped labels are interpolated. Colours are CSS variables
 * (--accent, --muted, --line, --surface, --text) so charts follow the theme
 * of the shadow root they are drawn in. The UI turns the string into nodes
 * with DOMParser, never innerHTML.
 *
 * - CTS_Charts.dailyPeakChart(series, o) -> string: bars = 5h daily peak, line = 7d peak; o: {w,h,label,max}
 * - CTS_Charts.calendarHeatmap(days, o) -> string: <=90 days as week columns; o: {startWeekday,label,fmtTitle}
 * - CTS_Charts.weekdayHourHeatmap(matrix, o) -> string: 7 x 24; o: {dayLabels,label,fmtTitle}
 * - CTS_Charts.esc(s) -> string
 */

(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n1 = v => Math.round(v * 10) / 10;
  const NS = 'xmlns="http://www.w3.org/2000/svg"';

  function dailyPeakChart(series, o) {
    o = o || {};
    const W = o.w || 520, H = o.h || 140, padL = 26, padB = 14, padT = 6;
    const iw = W - padL - 4, ih = H - padB - padT, n = Math.max(1, series.length);
    const bw = iw / n;
    let bars = '', line = [];
    series.forEach((d, i) => {
      const x = padL + i * bw;
      if (d.peak5h != null) {
        const h = ih * d.peak5h / 100;
        bars += `<rect x="${n1(x + bw * 0.12)}" y="${n1(padT + ih - h)}" width="${n1(Math.max(1, bw * 0.76))}" height="${n1(h)}" rx="1" fill="var(--accent)" opacity=".85"><title>${esc(o.fmtTitle ? o.fmtTitle(d) : d.peak5h + '%')}</title></rect>`;
      }
      if (d.peak7d != null) line.push(`${n1(x + bw / 2)},${n1(padT + ih - ih * d.peak7d / 100)}`);
    });
    const grid = [0, 50, 100].map(v => `<line x1="${padL}" x2="${W - 4}" y1="${n1(padT + ih - ih * v / 100)}" y2="${n1(padT + ih - ih * v / 100)}" stroke="var(--line)" stroke-width="1"/><text x="${padL - 4}" y="${n1(padT + ih - ih * v / 100 + 3)}" text-anchor="end" font-size="9" fill="var(--muted)">${v}</text>`).join('');
    return `<svg ${NS} viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || '')}" width="100%" preserveAspectRatio="xMidYMid meet">${grid}${bars}${line.length > 1 ? `<polyline points="${line.join(' ')}" fill="none" stroke="var(--text)" stroke-width="1.4" stroke-linejoin="round" opacity=".7"/>` : ''}</svg>`;
  }

  const shade = (v, max) => (v <= 0 || max <= 0 ? 0 : Math.min(1, 0.18 + 0.82 * v / max));

  function calendarHeatmap(days, o) {
    o = o || {};
    const cell = 11, gap = 2, start = o.startWeekday || 0; // weekday (0=Sun) of days[0]
    const max = days.reduce((m, d) => Math.max(m, d.points), 0);
    const cols = Math.ceil((days.length + start) / 7);
    const W = cols * (cell + gap), H = 7 * (cell + gap);
    let cells = '';
    days.forEach((d, i) => {
      const k = i + start, x = Math.floor(k / 7) * (cell + gap), y = (k % 7) * (cell + gap);
      const a = shade(d.points, max);
      cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${a ? 'var(--accent)' : 'var(--surface)'}" ${a ? `opacity="${n1(a)}"` : ''}><title>${esc(o.fmtTitle ? o.fmtTitle(d) : d.points)}</title></rect>`;
    });
    return `<svg ${NS} viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || '')}" width="100%" preserveAspectRatio="xMinYMin meet">${cells}</svg>`;
  }

  function weekdayHourHeatmap(m, o) {
    o = o || {};
    const cw = 16, ch = 14, padL = 28, padT = 12;
    const max = m.reduce((a, r) => Math.max(a, ...r), 0);
    const W = padL + 24 * cw, H = padT + 7 * ch;
    let s = '';
    for (let h = 0; h < 24; h += 3) s += `<text x="${padL + h * cw + 1}" y="9" font-size="8" fill="var(--muted)">${h}</text>`;
    m.forEach((row, d) => {
      s += `<text x="${padL - 4}" y="${padT + d * ch + 10}" text-anchor="end" font-size="8" fill="var(--muted)">${esc((o.dayLabels || [])[d] || d)}</text>`;
      row.forEach((v, h) => {
        const a = shade(v, max);
        s += `<rect x="${padL + h * cw}" y="${padT + d * ch}" width="${cw - 2}" height="${ch - 2}" rx="2" fill="${a ? 'var(--accent)' : 'var(--surface)'}" ${a ? `opacity="${n1(a)}"` : ''}><title>${esc(o.fmtTitle ? o.fmtTitle(d, h, v) : v)}</title></rect>`;
      });
    });
    return `<svg ${NS} viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || '')}" width="100%" preserveAspectRatio="xMinYMin meet">${s}</svg>`;
  }

  const api = { esc, dailyPeakChart, calendarHeatmap, weekdayHourHeatmap };
  root.CTS_Charts = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
