/* ══════════════════════════════════════════════
   CHECK-IN HISTORY, STREAKS, AND ARRIVAL REWARDS

   Library, not a route — declared in server/router.js NON_ROUTE_MODULES.

   channel-points.js records who is here NOW, in checkin_current, replaced
   wholesale each broadcast. That answers "who is watching" and nothing else.
   This answers the questions worth rewarding:

     how many streams in a row has this person turned up for?
     were they one of the first to arrive?

   WHY STREAKS NEED A STREAM LOG

   A streak is "consecutive streams attended", so it needs to know what the
   previous stream was. Deriving that from a viewer's own history is wrong:
   somebody who checked in twice a month apart would look like a 2-streak.
   stream_log is written by the server's minute tick, so a stream NOBODY
   checks into is still recorded and correctly breaks everyone's streak.

   REWARDS ARE GRANTED ONCE PER STREAK LENGTH REACHED, PER RUN — not once per
   stream. Hitting 5 pays out at 5; staying on 5 pays nothing further; reaching
   10 pays again. paidStreak is the high-water mark WITHIN the current unbroken
   run and resets to 0 when the run restarts, so a streak that breaks and climbs
   back EARNS the tiers again (turning up for ten more streams after a lapse is
   worth rewarding). A redelivered webhook is still not a second attendance —
   the duplicate guard below catches it before any of this runs — so it never
   pays twice within a run.
   ══════════════════════════════════════════════ */

const HISTORY_LIMIT = 100;   // per-viewer streams kept
const LOG_LIMIT = 200;       // broadcasts kept in stream_log

/* Entries awarded on reaching a streak length. Ascending, and read in order
   so adding a tier later cannot silently reorder payouts. */
export const STREAK_TIERS = [
  { streams: 3,  entries: 3,  label: '3-stream streak' },
  { streams: 5,  entries: 6,  label: '5-stream streak' },
  { streams: 10, entries: 15, label: '10-stream streak' },
  { streams: 20, entries: 35, label: '20-stream streak' },
  { streams: 50, entries: 100, label: '50-stream streak' },
];

/* The first few people to check in each broadcast. Rewards turning up at the
   start, which is the behaviour worth encouraging. Deliberately small — it
   is a nudge, not a race worth farming alts for. */
export const EARLY_BIRD_COUNT = 5;
export const EARLY_BIRD_ENTRIES = 2;

const historyKey = (userId) => `ci_${userId}`;

/* Clock slack when deciding whether a check-in happened before a broadcast
   began: Twitch's started_at and this server's clock are not the same clock. */
const PENDING_SLACK_MS = 5 * 60 * 1000;

async function appendStreamLog(env, streamId, startedAt) {
  if (!streamId) return false;
  const sid = String(streamId);
  let added = false;
  await env.MARKETPLACE.mutate('stream_log', (current) => {
    const rec = current && Array.isArray(current.streams) ? current : { streams: [] };
    if (rec.streams.some(s => s.id === sid)) return undefined;
    rec.streams.push({ id: sid, startedAt: startedAt || null, at: Date.now() });
    if (rec.streams.length > LOG_LIMIT) rec.streams = rec.streams.slice(-LOG_LIMIT);
    added = true;
    return rec;
  });
  return added;
}

/**
 * Append a broadcast to the ordered log. Idempotent per stream id.
 *
 * Also the backstop that settles check-ins made while the stream id was
 * unknown (see resolvePendingCheckins). The server's minute tick calls this
 * on every live minute, so a pending check-in waits at most about a minute
 * even when nobody else checks in after it.
 */
export async function recordStream(env, streamId, startedAt) {
  const added = await appendStreamLog(env, streamId, startedAt);
  if (streamId) {
    try {
      await resolvePendingCheckins(env, streamId, startedAt);
    } catch (err) {
      console.error('[checkin] could not settle pending check-ins:', err.message);
    }
  }
  return added;
}

/**
 * The log entries for `streamId` and the stream before it. `cur` is null when
 * the stream is not logged yet; `prev` is null when nothing precedes it.
 */
async function streamNeighbours(env, streamId) {
  const log = await env.MARKETPLACE.get('stream_log', 'json');
  const streams = log && Array.isArray(log.streams) ? log.streams : [];
  const idx = streams.findIndex(s => s.id === streamId);
  if (idx === -1) return { cur: null, prev: streams.length ? streams[streams.length - 1] : null, logged: false };
  return { cur: streams[idx], prev: idx > 0 ? streams[idx - 1] : null, logged: true };
}

function entryStartMs(entry) {
  if (!entry) return NaN;
  const t = entry.startedAt ? Date.parse(entry.startedAt) : NaN;
  return Number.isFinite(t) ? t : Number(entry.at) || NaN;
}

/**
 * Settle check-ins that arrived while the stream id was unknown.
 *
 * Each pending check-in joins this broadcast's list in arrival order and is
 * recorded against it — unless it happened before this broadcast began, in
 * which case it belonged to the previous one (a lookup that failed for the
 * tail of a stream, settled by the next) and is credited there, with no
 * early-bird position. Returns what was settled.
 */
export async function resolvePendingCheckins(env, streamId, startedAt) {
  if (!streamId) return [];
  const sid = String(streamId);
  const startMs = startedAt ? Date.parse(startedAt) : NaN;
  const settled = [];

  await env.MARKETPLACE.mutate('checkin_current', (current) => {
    if (!current || !Array.isArray(current.pending) || !current.pending.length) return undefined;

    const sameStream = current.streamId === sid;
    const earlier = !sameStream && current.streamId
      ? { streamId: current.streamId, startedAt: current.startedAt || null }
      : null;
    const rec = sameStream ? current : { streamId: sid, startedAt: startedAt || null, checkins: [] };
    if (!Array.isArray(rec.checkins)) rec.checkins = [];

    const pending = current.pending.slice().sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    for (const p of pending) {
      if (Number.isFinite(startMs) && Number(p.at) < startMs - PENDING_SLACK_MS) {
        settled.push({ ...p, streamId: earlier ? earlier.streamId : null, startedAt: earlier ? earlier.startedAt : null, position: null, earlier: true });
        continue;
      }
      if (rec.checkins.some(c => String(c.userId) === String(p.userId))) continue;
      rec.checkins.push({
        userId: String(p.userId),
        displayName: p.displayName || '',
        at: p.at,
        minutesIn: rec.startedAt ? Math.max(0, Math.round((p.at - Date.parse(rec.startedAt)) / 60000)) : null,
      });
      settled.push({ ...p, streamId: sid, startedAt: startedAt || null, position: rec.checkins.length, earlier: false });
    }
    rec.pending = [];
    return rec;
  });

  for (const s of settled) {
    let target = s.streamId;
    let targetStart = s.startedAt;
    if (!target && s.earlier) {
      const { prev } = await streamNeighbours(env, sid);
      if (prev && prev.id !== sid) { target = prev.id; targetStart = prev.startedAt || null; }
    }
    if (!target) continue;
    try {
      await recordCheckin(env, {
        userId: s.userId, username: s.displayName || '',
        streamId: target, startedAt: targetStart, position: s.position,
      });
    } catch (err) {
      console.error('[checkin] could not record a settled check-in:', err.message);
    }
  }
  return settled;
}

/**
 * Record a check-in and award anything it earns.
 *
 * @returns {Promise<{streak:number, bestStreak:number, total:number,
 *                    awards:{label:string, entries:number}[], position:number}>}
 */
export async function recordCheckin(env, { userId, username, streamId, startedAt, position }) {
  const uid = String(userId);

  /* NO STREAM ID, NO VERDICT. A null id used to fall through: no duplicate
     check (it keys on the id), no previous stream to compare with, so the
     streak reset to 1 — and the null entry then failed the NEXT stream's
     "were they at the previous one" test as well. channel-points.js now
     holds such a check-in as pending until the id is known; this guard is
     for any other caller. Nothing is written and nothing is paid. */
  if (!streamId) {
    const stats = await getCheckinStats(env, uid);
    return { ...stats, awards: [], position: null, deferred: true };
  }
  const sid = String(streamId);

  /* The stream may not be logged yet — the minute tick logs it, and the
     first check-ins of a broadcast are exactly the ones that can beat it
     there. Unlogged, it has no "previous stream", and every early arrival
     had their streak reset to 1. */
  let { cur, prev, logged } = await streamNeighbours(env, sid);
  if (!logged) {
    await appendStreamLog(env, sid, startedAt);
    cur = { id: sid, startedAt: startedAt || null, at: Date.now() };
  }
  const prevId = prev && prev.id !== sid ? prev.id : null;

  /* Attendance recorded with no stream id before this fix still counts for
     the stream it fell inside, rather than silently breaking streaks. */
  const prevStart = entryStartMs(prev);
  const curStart = entryStartMs(cur);
  const inPrevWindow = (s) => !s.streamId && Number.isFinite(prevStart) && Number.isFinite(curStart) &&
    Number(s.at) >= prevStart - PENDING_SLACK_MS && Number(s.at) < curStart - PENDING_SLACK_MS;

  let result = null;

  await env.MARKETPLACE.mutate(historyKey(uid), (current) => {
    const rec = current && Array.isArray(current.streams)
      ? current
      : { userId: uid, username: username || '', streams: [], streak: 0, bestStreak: 0, total: 0, paidStreak: 0 };

    rec.username = username || rec.username || '';

    /* Already counted for this broadcast. A redelivered webhook is not a
       second attendance, and must not extend a streak. */
    if (rec.streams.some(s => s.streamId === sid)) {
      result = {
        streak: rec.streak, bestStreak: rec.bestStreak, total: rec.total,
        awards: [], position: null, duplicate: true,
      };
      return undefined;
    }

    /* Consecutive only if they were present for the immediately preceding
       broadcast. No previous stream on record (first ever, or the log was
       just created) starts a streak at 1 rather than pretending continuity
       we cannot actually verify. */
    const attendedPrevious = !!prevId && rec.streams.some(s => s.streamId === prevId || inPrevWindow(s));
    rec.streak = attendedPrevious ? (Number(rec.streak) || 0) + 1 : 1;
    rec.bestStreak = Math.max(Number(rec.bestStreak) || 0, rec.streak);
    rec.total = (Number(rec.total) || 0) + 1;

    /* The run restarted, so the per-run payout ratchet restarts with it: a
       rebuilt streak re-earns the tiers it passes. Reset here, before the
       tier loop below reads it. */
    if (!attendedPrevious) rec.paidStreak = 0;

    rec.streams.push({ streamId: sid, startedAt: startedAt || null, at: Date.now(), position: position || null });
    if (rec.streams.length > HISTORY_LIMIT) rec.streams = rec.streams.slice(-HISTORY_LIMIT);

    /* Pay every tier newly reached THIS run. paidStreak is the ratchet within
       one unbroken run (reset to 0 above when the run restarts), so staying on
       a streak never re-pays a tier, while a broken-and-rebuilt streak earns
       the tiers again. */
    const paid = Number(rec.paidStreak) || 0;
    const awards = [];
    for (const tier of STREAK_TIERS) {
      if (rec.streak >= tier.streams && paid < tier.streams) {
        awards.push({ label: tier.label, entries: tier.entries });
      }
    }
    if (awards.length) rec.paidStreak = Math.max(paid, rec.streak);

    if (position !== null && position !== undefined && position <= EARLY_BIRD_COUNT) {
      awards.push({ label: `early check-in (#${position})`, entries: EARLY_BIRD_ENTRIES });
    }

    result = {
      streak: rec.streak, bestStreak: rec.bestStreak, total: rec.total,
      awards, position: position || null, duplicate: false,
    };
    return rec;
  });

  if (!result) return { streak: 0, bestStreak: 0, total: 0, awards: [], position: null };

  /* Entries are added AFTER the history write commits. If this half fails,
     the viewer is short some entries and the history says why — recoverable.
     Awarding first and failing to record would pay the same tier again on
     the next check-in, every time, forever. */
  for (const a of result.awards) {
    const { addEntries } = await import('./giveaway-entries.js');
    await addEntries(env, uid, username, a.entries, `checkin:${a.label}`);
  }

  return result;
}

/** Read one viewer's standing, for the chat command and the leaderboard. */
export async function getCheckinStats(env, userId) {
  const rec = await env.MARKETPLACE.get(historyKey(userId), 'json');
  if (!rec) return { streak: 0, bestStreak: 0, total: 0 };
  return {
    streak: Number(rec.streak) || 0,
    bestStreak: Number(rec.bestStreak) || 0,
    total: Number(rec.total) || 0,
    username: rec.username || '',
  };
}
