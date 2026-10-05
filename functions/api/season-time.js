/* ══════════════════════════════════════════════
   SEASON TIME — the single calendar every monthly cycle rolls on.

   The giveaway ledger, the monthly leaderboard awards, Phamily Time and the
   Skull Clicker seasonal reset all key by month, and they MUST agree on when a
   month begins — otherwise a viewer's entries and their watch time can land in
   different months at the boundary. This module is that one source of truth.

   The boundary follows SEASON_TZ (the broadcaster's stream timezone), not UTC,
   so a month rolls at local midnight on the 1st rather than mid-stream. DST is
   handled by Intl, so the offset is always correct for the date in question.

   Library only — no request handler. Registered in server/router.js
   NON_ROUTE_MODULES.
   ══════════════════════════════════════════════ */

export const SEASON_TZ = 'America/Los_Angeles';

/* The wall-clock Y/M/D in SEASON_TZ for an instant. en-CA formats as
   YYYY-MM-DD, so the split is unambiguous. */
function zonedYMD(d, tz = SEASON_TZ) {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  const [y, m, day] = s.split('-').map(Number);
  return { y, m, day };
}

/* Milliseconds SEASON_TZ is offset from UTC at the given instant (DST-aware).
   Positive = ahead of UTC. */
function tzOffsetMs(date, tz = SEASON_TZ) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((a, x) => (x.type !== 'literal' && (a[x.type] = x.value), a), {});
  const hour = p.hour === '24' ? 0 : +p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/* The UTC instant of a SEASON_TZ wall-clock time. Two-pass so a time near a DST
   transition resolves to the correct offset. */
function zonedWallToUTC(y, mo, d, h, mi, s, tz = SEASON_TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const o1 = tzOffsetMs(new Date(guess), tz);
  const o2 = tzOffsetMs(new Date(guess - o1), tz);
  return guess - o2;
}

function pad(n) { return String(n).padStart(2, '0'); }
function daysInCalMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/** 'YYYY-MM' for the instant, in SEASON_TZ. */
export function monthKey(d = new Date()) {
  const { y, m } = zonedYMD(d);
  return `${y}-${pad(m)}`;
}

/** 'YYYY-MM-DD' for the instant, in SEASON_TZ — the key the Daily Challenge
    rolls on, so a new puzzle appears at local midnight, not UTC. */
export function dayKey(d = new Date()) {
  const { y, m, day } = zonedYMD(d);
  return `${y}-${pad(m)}-${pad(day)}`;
}

/** Subtract one from a 'YYYY-MM' string (TZ-independent string math). */
export function prevMonthOf(mk) {
  const [y, m] = String(mk).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** The month before `d`'s SEASON_TZ month, 'YYYY-MM'. */
export function prevMonthKey(d = new Date()) {
  return prevMonthOf(monthKey(d));
}

/** Add one to a 'YYYY-MM' string (TZ-independent string math). Mirrors
    prevMonthOf, for the Phamily Time "next month" preview. */
export function nextMonthOf(mk) {
  const [y, m] = String(mk).split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/** The month after `d`'s SEASON_TZ month, 'YYYY-MM'. */
export function nextMonthKey(d = new Date()) {
  return nextMonthOf(monthKey(d));
}

/** The UTC-ms instant the SEASON_TZ month containing `d` ends (= next month's
    1st at 00:00 local). Used for "days left" / countdowns. */
export function monthEndsAt(d = new Date()) {
  const { y, m } = zonedYMD(d);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return zonedWallToUTC(ny, nm, 1, 0, 0, 0);
}

/** Whole days left in the current SEASON_TZ month (ceil), including today. */
export function daysLeftInMonth(d = new Date()) {
  return Math.max(0, Math.ceil((monthEndsAt(d) - d.getTime()) / 86400000));
}

/** Is `d` the last calendar day of its SEASON_TZ month? */
export function isLastDayOfMonth(d = new Date()) {
  const { y, m, day } = zonedYMD(d);
  return day === daysInCalMonth(y, m);
}

/** "September 2026" for the SEASON_TZ month of `d`. */
export function monthLabel(d = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SEASON_TZ, month: 'long', year: 'numeric',
  }).format(d);
}

/** Days in the SEASON_TZ month of `d`. */
export function daysInMonth(d = new Date()) {
  const { y, m } = zonedYMD(d);
  return daysInCalMonth(y, m);
}

/** Day-of-month (1–31) of `d` in SEASON_TZ. */
export function dayOfMonth(d = new Date()) {
  return zonedYMD(d).day;
}

/** 'YYYY-Www' ISO week key for the SEASON_TZ date of `d` (weeks start Monday).
   Used by weekly features (Phamily Quests) so a week rolls on the stream's
   calendar, not UTC. The year is the ISO week-year, so the last days of
   December can read as week 01 of the next year, by design. */
export function weekKey(d = new Date()) {
  const { y, m, day } = zonedYMD(d);
  const date = new Date(Date.UTC(y, m - 1, day));
  const dow = (date.getUTCDay() + 6) % 7;            // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dow + 3);      // the Thursday of this week
  const firstThu = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fDow = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fDow + 3);
  const week = 1 + Math.round((date - firstThu) / (7 * 86400000));
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}
