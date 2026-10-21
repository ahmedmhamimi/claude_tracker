/**
 * Shared TokenLens Pro constants and pure license/trial logic. Loaded in every
 * context (content script, service worker, popup, unlock page). No DOM, no
 * chrome.* access: callers pass storage records in and get plain objects out.
 *
 * Money model: one-time $29 license sold on Gumroad. Every install gets a free
 * trial of ALL features for 7 active days (capped at 14 calendar days). After
 * the trial, only the free tier (see FREE) stays available until a license key
 * is activated.
 *
 * - CTS_LicenseCore.CONFIG: object: product id, checkout URL, price, trial/recheck/uses limits.
 * - CTS_LicenseCore.FREE: object: what the free tier keeps (formats, search results, history days).
 * - CTS_LicenseCore.localDay(now) -> string: local calendar day "YYYY-MM-DD".
 * - CTS_LicenseCore.mergeTrial(a, b) -> trial|null: union of two stored trial records (earliest start, all days).
 * - CTS_LicenseCore.trialStatus(trial, now) -> {started, active, expired, day, daysLeft, needsToday}: where the trial stands.
 * - CTS_LicenseCore.advanceTrial(trial, now) -> trial: records today as an active day (or creates the record); never extends an expired trial.
 * - CTS_LicenseCore.licenseValid(lic, now) -> boolean: active license verified within the recheck + grace window.
 * - CTS_LicenseCore.summarize(lic, trial, now) -> {licensed, pro, tier, trial, revoked}: the single answer to "is this person Pro?".
 * - CTS_LicenseCore.keyLooksValid(key) -> boolean: cheap format check before calling Gumroad.
 * - CTS_LicenseCore.maskKey(key) -> string: "ABCD…WXYZ" for display.
 */

(function (root) {
  'use strict';

  const DAY = 864e5;

  const CONFIG = {
    PRODUCT_ID: '3CIgXZqB3bzHn2S-JDYELw==',
    CHECKOUT_URL: 'https://mhamimi.gumroad.com/l/signwd?wanted=true',
    VERIFY_URL: 'https://api.gumroad.com/v2/licenses/verify',
    HOST_ORIGIN: 'https://api.gumroad.com/*',
    PRICE_LABEL: '$29',
    TRIAL_DAYS: 7,              // active days with TokenLens running on claude.ai
    TRIAL_CAP_DAYS: 14,         // calendar days after which an unfinished trial also ends
    RECHECK_MS: 7 * DAY,        // how often a license is re-verified (refund / chargeback check)
    GRACE_MS: 30 * DAY,         // how long a license keeps working if re-verification keeps failing
    MAX_ACTIVATIONS: 5,         // manual activations allowed per key (reinstalls, other machines)
    REFUND_DAYS: 7,
  };

  const FREE = {
    exportFormats: ['md'],      // single-chat save: Markdown stays free
    searchResults: 3,           // search shows the top 3 results
    historyDays: 2,             // history chart shows today + yesterday
  };

  const pad = n => (n < 10 ? '0' : '') + n;
  function localDay(now) {
    const d = new Date(now);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  const cleanDays = a => Array.from(new Set((Array.isArray(a) ? a : []).filter(x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)))).sort().slice(-60);

  function mergeTrial(a, b) {
    const ok = x => x && typeof x === 'object' && typeof x.startedAt === 'number' && isFinite(x.startedAt);
    if (!ok(a) && !ok(b)) return null;
    if (!ok(a)) return { startedAt: b.startedAt, days: cleanDays(b.days) };
    if (!ok(b)) return { startedAt: a.startedAt, days: cleanDays(a.days) };
    return { startedAt: Math.min(a.startedAt, b.startedAt), days: cleanDays([].concat(a.days || [], b.days || [])) };
  }

  function trialStatus(trial, now) {
    if (!trial || typeof trial.startedAt !== 'number') return { started: false, active: true, expired: false, day: 1, daysLeft: CONFIG.TRIAL_DAYS, needsToday: true };
    const days = cleanDays(trial.days), today = localDay(now), hasToday = days.includes(today);
    const outOfDays = days.length >= CONFIG.TRIAL_DAYS && !hasToday;
    const outOfTime = now - trial.startedAt > CONFIG.TRIAL_CAP_DAYS * DAY && !hasToday;
    const expired = outOfDays || outOfTime;
    const used = hasToday ? days.length : days.length + 1;       // today counts as a trial day if it is (or would be) used
    return {
      started: true, active: !expired, expired,
      day: Math.min(CONFIG.TRIAL_DAYS, Math.max(1, used)),
      daysLeft: expired ? 0 : Math.max(0, CONFIG.TRIAL_DAYS - used),   // full days remaining after today
      needsToday: !expired && !hasToday,
    };
  }

  function advanceTrial(trial, now) {
    const t = trial && typeof trial.startedAt === 'number' ? { startedAt: trial.startedAt, days: cleanDays(trial.days) } : { startedAt: now, days: [] };
    const st = trialStatus(t, now);
    if (st.needsToday) t.days = cleanDays(t.days.concat(localDay(now)));
    return t;
  }

  function licenseValid(lic, now) {
    if (!lic || lic.status !== 'active' || !lic.key || typeof lic.lastOk !== 'number') return false;
    return now - lic.lastOk < CONFIG.RECHECK_MS + CONFIG.GRACE_MS;
  }

  function summarize(lic, trial, now) {
    const licensed = licenseValid(lic, now);
    const t = trialStatus(trial, now);
    const pro = licensed || t.active;
    return { licensed, pro, tier: licensed ? 'licensed' : t.active ? 'trial' : 'free', trial: t, revoked: !!(lic && lic.status === 'revoked') };
  }

  const keyLooksValid = key => typeof key === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(key.trim());
  const maskKey = key => (typeof key === 'string' && key.length > 10 ? key.slice(0, 4) + '…' + key.slice(-4) : '••••');

  const api = { CONFIG, FREE, localDay, mergeTrial, trialStatus, advanceTrial, licenseValid, summarize, keyLooksValid, maskKey };
  root.CTS_LicenseCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
