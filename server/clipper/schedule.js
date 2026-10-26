/* ══════════════════════════════════════════════
   WHEN EACH SHORT GOES LIVE.

   The bot runs daily but publishes a WEEK AHEAD: each run uploads the clips
   for the day `daysAhead` from now, with YouTube's `status.publishAt` set to
   the slot time. The result is a rolling seven-day-deep schedule.

   WHY NOT UPLOAD A WHOLE WEEK AT ONCE. videos.insert costs ~1600 quota units
   against a 10,000/day default — about six uploads a day. A true weekly batch
   (2 posts x 7 days x 2 accounts = 28 uploads) is ~44,800 units and would die
   partway through. Uploading daily, dated a week out, keeps the same schedule
   depth at ~4 uploads/day.

   TIKTOK HAS NO EQUIVALENT. Its Content Posting API exposes no publish time,
   so TikTok posts same-day; only YouTube is genuinely scheduled.

   THE TIMEZONE IS NOT COSMETIC. "10:00 Pacific" is a different UTC instant in
   March than in December, and a naive fixed offset silently drifts by an hour
   twice a year — posting at 9am or 11am for months before anyone connects it
   to the clock change. zonedTimeToUtc resolves the wall-clock time against the
   zone's real rules via Intl, so DST is handled rather than assumed.
   ══════════════════════════════════════════════ */

/**
 * The offset (ms) between a UTC instant and the wall clock in `tz` at that
 * instant. Positive west of Greenwich is NOT assumed — it is derived.
 */
function zoneOffset(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ts))) p[part.type] = part.value;
  /* hour can come back as "24" at midnight in some ICU versions. */
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUtc - ts;
}

/**
 * The UTC instant for a wall-clock time in a named zone.
 * Two passes: the first offset is measured at the naive guess, the second at
 * the corrected instant — which is what gets a time near a DST boundary right.
 *
 * @returns {Date}
 */
export function zonedTimeToUtc(year, month, day, hour, minute, tz) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstPass = naive - zoneOffset(naive, tz);
  return new Date(naive - zoneOffset(firstPass, tz));
}

/** The calendar date in `tz`, `daysAhead` days from `now`. */
function dateAhead(now, daysAhead, tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  /* Today's date in the zone, then advance by whole days in UTC — safe
     because we only use the y/m/d, which zonedTimeToUtc re-resolves. */
  const [y, m, d] = dtf.format(new Date(now)).split('-').map(Number);
  const advanced = new Date(Date.UTC(y, m - 1, d) + daysAhead * 86400000);
  return {
    year: advanced.getUTCFullYear(),
    month: advanced.getUTCMonth() + 1,
    day: advanced.getUTCDate(),
  };
}

/**
 * The publish instants for one account's posts in this run.
 *
 * @param {number} now        ms epoch
 * @param {object} schedule   { daysAhead, times:['HH:MM'...], timezone }
 * @param {number} count      how many slots are needed (<= times.length)
 * @returns {Date[]} in slot order
 */
export function slotsFor(now, schedule, count) {
  const { year, month, day } = dateAhead(now, schedule.daysAhead, schedule.timezone);
  const out = [];
  for (let i = 0; i < count; i++) {
    const [hh, mm] = schedule.times[i].split(':').map(Number);
    out.push(zonedTimeToUtc(year, month, day, hh, mm, schedule.timezone));
  }
  return out;
}
