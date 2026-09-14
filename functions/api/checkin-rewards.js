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

   REWARDS ARE GRANTED ONCE PER STREAK LENGTH REACHED, not once per stream.
   Hitting 5 pays out at 5; staying on 5 pays nothing further; reaching 10
   pays again. Stored per-user as the highest tier already paid, because
   "did I already give them this" is the only question that stops a restart
   or a redelivered webhook from paying twice.
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

/** Append a broadcast to the ordered log. Idempotent per stream id. */
export async function recordStream(env, streamId, startedAt) {
  if (!streamId) return false;
  let added = false;
  await env.MARKETPLACE.mutate('stream_log', (current) => {
    const rec = current && Array.isArray(current.streams) ? current : { streams: [] };
    if (rec.streams.some(s => s.id === streamId)) return undefined;
    rec.streams.push({ id: String(streamId), startedAt: startedAt || null, at: Date.now() });
    if (rec.streams.length > LOG_LIMIT) rec.streams = rec.streams.slice(-LOG_LIMIT);
    added = true;
    return rec;
  });
  return added;
}

/**
 * The stream before `streamId` in the log, or null if it is the first one
 * we know about.
 */
async function previousStreamId(env, streamId) {
  const log = await env.MARKETPLACE.get('stream_log', 'json');
  const streams = log && Array.isArray(log.streams) ? log.streams : [];
  const idx = streams.findIndex(s => s.id === streamId);
  if (idx <= 0) return null;
  return streams[idx - 1].id;
}

/**
 * Record a check-in and award anything it earns.
 *
 * @returns {Promise<{streak:number, bestStreak:number, total:number,
 *                    awards:{label:string, entries:number}[], position:number}>}
 */
export async function recordCheckin(env, { userId, username, streamId, startedAt, position }) {
  const uid = String(userId);
  const prevId = streamId ? await previousStreamId(env, streamId) : null;

  let result = null;

  await env.MARKETPLACE.mutate(historyKey(uid), (current) => {
    const rec = current && Array.isArray(current.streams)
      ? current
      : { userId: uid, username: username || '', streams: [], streak: 0, bestStreak: 0, total: 0, paidStreak: 0 };

    rec.username = username || rec.username || '';

    /* Already counted for this broadcast. A redelivered webhook is not a
       second attendance, and must not extend a streak. */
    if (streamId && rec.streams.some(s => s.streamId === streamId)) {
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
    const attendedPrevious = !!prevId && rec.streams.some(s => s.streamId === prevId);
    rec.streak = attendedPrevious ? (Number(rec.streak) || 0) + 1 : 1;
    rec.bestStreak = Math.max(Number(rec.bestStreak) || 0, rec.streak);
    rec.total = (Number(rec.total) || 0) + 1;

    rec.streams.push({ streamId: streamId || null, startedAt: startedAt || null, at: Date.now(), position: position || null });
    if (rec.streams.length > HISTORY_LIMIT) rec.streams = rec.streams.slice(-HISTORY_LIMIT);

    /* Pay every tier newly reached. paidStreak is the ratchet: it only ever
       goes up, so a broken-and-rebuilt streak does not re-pay tiers this
       account has already been given. */
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
