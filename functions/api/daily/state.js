/* ══════════════════════════════════════════════
   DAILY CHALLENGES — the shared framework

   Library, no handler. Declared in NON_ROUTE_MODULES. Every daily on the site
   reports completion HERE, and the hub (/api/daily) reads it, so there is one
   source of truth for "what's done today" and the cross-game streak.

   THE CONTRACT, for anyone adding a daily (a game agent, the Rite, Memory
   Match):
     1. Append an entry to CHALLENGES below: { id, title, blurb, href, icon }.
     2. When the player finishes that daily, call
            markDailyComplete(env, userId, username, '<id>')
        exactly once per Pacific day (it is idempotent per day, so calling it
        again is harmless).
   That is all. The hub lists CHALLENGES, ticks off the player's done ids,
   tracks the consecutive-days-cleared streak, and grants the meta reward the
   first time a player clears EVERY challenge in a day.

   WHY A SINGLE PER-USER RECORD. `daily_<userId>` holds the whole picture for a
   player — today's done list, the streak, and the once-a-day guards — so the
   hub reads one key and a completion writes one key under an advisory lock.
   The day boundary is Pacific (season-time.dayKey), matching every other
   cycle on the site.

   META REWARD. Clearing all of a day's challenges grants giveaway bonus
   entries (the site's cross-game engagement currency — individual game
   dailies pay their OWN currency, so this never double-pays and never inflates
   one game's economy). Granted once per day, guarded by lastMeta.
   ══════════════════════════════════════════════ */

import { dayKey } from '../season-time.js';

/* The live dailies. A daily appears on the hub the moment it is in this list;
   game dailies append their own entry when their agent builds them. Order is
   the display order. */
export const CHALLENGES = [
  { id: 'daily-rite',   title: 'The Daily Rite', blurb: 'One question from the crypt. One guess.', href: '/daily', icon: '📜' },
  { id: 'memory-match', title: 'Memory Match',   blurb: "Today's deal — one run, same cards for everyone.", href: '/games/memory-match/', icon: '🃏' },
  { id: 'dino-rival',   title: 'Daily Rival',    blurb: 'One beast, same for all. Send your champion.', href: '/games/dino-park/?daily=rival', icon: '🦖' },
  { id: 'skull-curse',  title: "Today's Curse",  blurb: 'A daily curse for all — run the cursed skull to the quota.', href: '/games/skull-clicker/', icon: '☠️' },
  { id: 'mana-seed',    title: 'Mana Clash',     blurb: "Today's dice — same roll for everyone, play for the best score.", href: '/games/mana-clash/', icon: '🎲' },
  { id: 'sss',          title: 'Soup, Salad, or Sandwich', blurb: 'Five foods. Call each one. Every food is one of the three.', href: '/soup-salad-sandwich', icon: '🥪' },
];

export const META_ENTRIES = 2;        // giveaway entries for clearing the whole day
const KEEP_DAYS = 10;                 // how many past days of `done` to retain

function key(userId) { return 'daily_' + String(userId); }

function freshRecord() {
  return { done: {}, streak: 0, lastClear: null, lastMeta: null, rite: null };
}

/* Trim the done-map to the most recent KEEP_DAYS so the record can't grow
   without bound over a year of play. */
function prune(rec) {
  const days = Object.keys(rec.done || {}).sort();
  while (days.length > KEEP_DAYS) delete rec.done[days.shift()];
  return rec;
}

/** Was `prev` the calendar day immediately before `today`? (Pacific keys.) */
function isYesterday(prev, today) {
  if (!prev) return false;
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return dayKey(d) === prev;
}

/**
 * Mark one daily done for today. Idempotent per day. When this completion
 * makes the day's set cover every CHALLENGE, it counts as a CLEAR: the streak
 * advances and (once per day) the meta reward is granted.
 *
 * @returns {{ done: string[], clearedToday: boolean, newlyCleared: boolean,
 *             streak: number, metaGranted: boolean }}
 */
export async function markDailyComplete(env, userId, username, challengeId) {
  if (!userId || !challengeId) return null;
  const today = dayKey();
  let result = null;

  const rec = await env.MARKETPLACE.mutate(key(userId), (cur) => {
    const r = cur && typeof cur === 'object' ? { ...freshRecord(), ...cur } : freshRecord();
    if (!r.done || typeof r.done !== 'object') r.done = {};
    const todayDone = new Set(Array.isArray(r.done[today]) ? r.done[today] : []);
    todayDone.add(challengeId);
    r.done[today] = [...todayDone];

    const allIds = CHALLENGES.map(c => c.id);
    const clearedToday = allIds.every(id => todayDone.has(id));
    const newlyCleared = clearedToday && r.lastClear !== today;

    if (newlyCleared) {
      r.streak = isYesterday(r.lastClear, today) ? (Number(r.streak) || 0) + 1 : 1;
      r.lastClear = today;
    }
    result = {
      done: r.done[today],
      clearedToday,
      newlyCleared,
      streak: Number(r.streak) || 0,
      /* The meta is granted below, outside the lock; record the intent here so
         two concurrent completions can't both decide to grant. */
      grantMeta: newlyCleared && r.lastMeta !== today,
    };
    if (result.grantMeta) r.lastMeta = today;
    return prune(r);
  });

  let metaGranted = false;
  if (result && result.grantMeta) {
    try {
      const { addEntries } = await import('../giveaway-entries.js');
      await addEntries(env, userId, username || 'Someone', META_ENTRIES, 'daily-clear');
      metaGranted = true;
    } catch (err) {
      console.error('[daily] meta reward failed:', err && err.message);
    }
  }
  return result && { ...result, metaGranted, grantMeta: undefined };
}

/**
 * The player's daily picture for the hub: each challenge with a done flag,
 * how many remain, the streak, and whether today is already cleared.
 */
export async function getDailyState(env, userId) {
  const today = dayKey();
  let rec = null;
  try { rec = await env.MARKETPLACE.get(key(userId), 'json'); } catch { rec = null; }
  if (!rec || typeof rec !== 'object') rec = freshRecord();

  const todayDone = new Set(Array.isArray(rec.done && rec.done[today]) ? rec.done[today] : []);
  const challenges = CHALLENGES.map(c => ({
    id: c.id, title: c.title, blurb: c.blurb, href: c.href, icon: c.icon,
    done: todayDone.has(c.id),
  }));
  const remaining = challenges.filter(c => !c.done).length;

  /* The displayed streak only still counts if the last clear was today or
     yesterday; an older lastClear means the run is broken (shown as 0) even
     though we don't rewrite the record until the next clear. */
  var streak = Number(rec.streak) || 0;
  if (rec.lastClear !== today && !isYesterday(rec.lastClear, today)) streak = 0;

  return {
    day: today,
    challenges,
    total: challenges.length,
    doneCount: challenges.length - remaining,
    remaining,
    clearedToday: rec.lastClear === today,
    streak,
    metaEntries: META_ENTRIES,
    rite: rec.rite && rec.rite.day === today ? rec.rite : null,
  };
}

/** Read the raw record (for the Rite to stash its per-day answer). Internal. */
export async function readDaily(env, userId) {
  try {
    const rec = await env.MARKETPLACE.get(key(userId), 'json');
    return rec && typeof rec === 'object' ? rec : freshRecord();
  } catch { return freshRecord(); }
}

/** Save the Rite's per-day answer onto the shared record (merged, not clobbered). */
export async function setRiteAnswer(env, userId, answer) {
  await env.MARKETPLACE.mutate(key(userId), (cur) => {
    const r = cur && typeof cur === 'object' ? { ...freshRecord(), ...cur } : freshRecord();
    r.rite = answer;   // { day, pick, correct }
    return r;
  });
}

export { key as dailyKey };
