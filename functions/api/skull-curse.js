/* ══════════════════════════════════════════════
   /api/skull-curse — Today's Curse (Skull Clicker's daily challenge)

   One curse a day, the SAME for everyone, chosen deterministically from the
   Pacific day key (hashed exactly as the Daily Rite hashes its question). The
   player runs a short, bounded objective UNDER the curse — a dedicated daily
   run that lives in its own record and NEVER touches sc_save_ (the endless /
   prestige save), so a curse can neither corrupt nor reset their main
   progress, and the monthly run+prestige wipe is none of this file's business.

   GET  → today's curse definition + this player's run state (bones so far,
          the target, whether it is already done, relics earned).
   POST { action:'strike', count } → land a batch of cursed strikes. The SERVER
          owns the bone maths: it applies the curse's per-strike value and
          rules (crumble / decay / deadline), advances a server-side total, and
          when the total reaches the target marks the day done exactly once.
          POST { action:'reset' } → abandon today's run and start it over (for
          a deadline curse the player failed); it never clears the done flag.

   SERVER-AUTHORITATIVE. The client reports only how many times it struck; the
   server decides what that is worth and whether the objective is met, and
   re-checks the stored record (like rite.js) so a client cannot claim a clear
   it did not earn, nor a second clear the same day.

   THE REWARD IS THE GAME'S OWN CURRENCY — a Cursed Relic (sc_relics_<userId>),
   granted once per day on the first clear, which the game turns into a small
   permanent click-power bonus. It is NOT a giveaway entry: the site-wide meta
   reward for clearing every daily is the framework's job (markDailyComplete),
   and is paid there, once, so this never double-pays the engagement currency.
   ══════════════════════════════════════════════ */

import { dayKey } from './season-time.js';

/* The curse bank. Each curse is a set of knobs the server interprets and the
   client renders from — one source of truth, shipped to the client by GET so
   the two can never drift:
     perStrike    bones a landed strike is worth
     target       bones needed to break the curse
     reqCap       most strikes one POST can land (a per-flush ceiling)
     crumbleEvery 0 = none; else every Nth strike crumbles to dust (worth 0)
     decayPerSec  0 = none; else bones rot by this much per real second
     deadlineSec  0 = none; else the pile scatters (run restarts) if the target
                  is not reached within this many seconds of the run's start
   Every curse is beatable: target is reachable under its own rules. Append to
   grow the bank — the day's pick stays stable for everyone without a stored
   roll. */
export const CURSES = [
  { id: 'famine',   name: 'Famine of Marrow', blurb: 'The crypt is picked clean — every skull yields but a sliver. Grind out the bones.',
    perStrike: 3,  target: 540,  reqCap: 50, crumbleEvery: 0, decayPerSec: 0,  deadlineSec: 0 },
  { id: 'brittle',  name: 'Brittle Bones',    blurb: 'The bones are rotten through — every fourth strike crumbles to dust and gives nothing.',
    perStrike: 5,  target: 500,  reqCap: 50, crumbleEvery: 4, decayPerSec: 0,  deadlineSec: 0 },
  { id: 'wither',   name: 'Withering Hour',   blurb: 'The pile rots as fast as it rises. Out-pace the decay or lose your gains.',
    perStrike: 6,  target: 420,  reqCap: 50, crumbleEvery: 0, decayPerSec: 9,  deadlineSec: 0 },
  { id: 'blood',    name: 'Blood Price',      blurb: 'Each strike is paid in blood — worth a fortune, but the Reaper demands a mountain.',
    perStrike: 12, target: 1200, reqCap: 40, crumbleEvery: 0, decayPerSec: 0,  deadlineSec: 0 },
  { id: 'deadline', name: "The Reaper's Deadline", blurb: 'Reach the quota before the hourglass empties, or the pile scatters and you begin again.',
    perStrike: 8,  target: 520,  reqCap: 50, crumbleEvery: 0, decayPerSec: 0,  deadlineSec: 45 },
  { id: 'frost',    name: 'Grave Frost',      blurb: 'Your hands freeze to the bone — fewer strikes land at once, so it is a test of stamina.',
    perStrike: 5,  target: 400,  reqCap: 18, crumbleEvery: 0, decayPerSec: 0,  deadlineSec: 0 },
  { id: 'tithe',    name: 'Cursed Tithe',     blurb: 'A rotting, thieving curse — every third strike crumbles AND the pile slowly bleeds away.',
    perStrike: 7,  target: 440,  reqCap: 50, crumbleEvery: 3, decayPerSec: 4,  deadlineSec: 0 },
];

/* xmur3 string hash → 32-bit int, identical to rite.js, so the day's curse is
   stable for everyone with no stored roll and no possible reroll. */
function pickIndex(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = (h ^ (h >>> 13)) >>> 0;
  return h % CURSES.length;
}

export function todaysCurse(day = dayKey()) {
  const idx = pickIndex('skull-curse:' + day);
  return { index: idx, ...CURSES[idx] };
}

/* ── Light anti-cheat on strike rate ────────────────────────────────────────
   reqCap already bounds one flush; this bounds a flood of flushes. A real
   client queues strikes and flushes them about once a second, so landing a
   batch always fits inside RATE·elapsed + BURST. A script POSTing reqCap many
   times a second is clipped to the sustainable rate. Low-stakes (the reward is
   the game's own currency, not a giveaway entry), so this stays deliberately
   generous — no real masher is ever throttled. */
const STRIKE_RATE_PER_SEC = 45;
const STRIKE_BURST = 60;

const curseKey = (userId) => `sc_curse_${userId}`;
const relicsKey = (userId) => `sc_relics_${userId}`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* A fresh run for today's curse. The record is day-scoped and REPLACED every
   day, so it never accumulates and never has to be reconciled with the main
   save's monthly reset. */
function freshRun(day, curse) {
  const now = Date.now();
  return {
    day, curseId: curse.id,
    bones: 0, strikes: 0,
    startedAt: now, lastAt: now,
    done: false, doneAt: null,
    failedAttempts: 0,
  };
}

/* Bring a stored record into today: a record from another day (or for a
   different curse, which only happens across a day boundary) is a fresh run.
   Preserves a done record so the one-per-day guard survives a reload. */
function forToday(rec, day, curse) {
  if (rec && typeof rec === 'object' && rec.day === day && rec.curseId === curse.id) {
    return {
      ...freshRun(day, curse),
      bones: Number(rec.bones) || 0,
      strikes: Number(rec.strikes) || 0,
      startedAt: Number(rec.startedAt) || Date.now(),
      lastAt: Number(rec.lastAt) || Date.now(),
      done: !!rec.done,
      doneAt: rec.doneAt || null,
      failedAttempts: Number(rec.failedAttempts) || 0,
    };
  }
  return freshRun(day, curse);
}

/* Relics earned, remaining decay/deadline — the small public shape the game
   reads. Derives the live countdown so the client can tick it down locally
   between flushes. */
function publicRun(rec, curse, relics) {
  const now = Date.now();
  const deadlineRemaining = curse.deadlineSec > 0 && !rec.done
    ? Math.max(0, curse.deadlineSec - (now - rec.startedAt) / 1000)
    : null;
  return {
    day: rec.day,
    bones: Math.floor(rec.bones),
    target: curse.target,
    strikes: rec.strikes,
    done: !!rec.done,
    startedAt: rec.startedAt,
    deadlineRemaining,
    failedAttempts: rec.failedAttempts || 0,
    relics: Number(relics) || 0,
  };
}

async function readRelics(env, userId) {
  try {
    const r = await env.MARKETPLACE.get(relicsKey(userId), 'json');
    return r && typeof r === 'object' ? r : { relics: 0, lastDay: null, history: [] };
  } catch { return { relics: 0, lastDay: null, history: [] }; }
}

/* Grant one Cursed Relic for today's clear. Idempotent per Pacific day via
   lastDay, so two strikes that both observe the completion transition (or a
   retry) can never pay twice. Returns the new relic total. */
async function grantRelic(env, userId, day, curseId) {
  let total = 0;
  await env.MARKETPLACE.mutate(relicsKey(userId), (cur) => {
    const r = cur && typeof cur === 'object' ? cur : { relics: 0, lastDay: null, history: [] };
    if (!Array.isArray(r.history)) r.history = [];
    if (r.lastDay === day) { total = Number(r.relics) || 0; return undefined; }
    r.relics = (Number(r.relics) || 0) + 1;
    r.lastDay = day;
    r.history.unshift({ day, curseId, at: Date.now() });
    while (r.history.length > 30) r.history.pop();
    total = r.relics;
    return r;
  });
  return total;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const day = dayKey();
  const curse = todaysCurse(day);
  const base = {
    day,
    curse: { id: curse.id, name: curse.name, blurb: curse.blurb, perStrike: curse.perStrike,
      target: curse.target, reqCap: curse.reqCap, crumbleEvery: curse.crumbleEvery,
      decayPerSec: curse.decayPerSec, deadlineSec: curse.deadlineSec },
  };

  const session = getSession(request);
  if (!session || !session.user_id) return json({ ...base, loggedIn: false });

  const rec = forToday(await env.MARKETPLACE.get(curseKey(session.user_id), 'json'), day, curse);
  const relicRec = await readRelics(env, session.user_id);
  return json({ ...base, loggedIn: true, run: publicRun(rec, curse, relicRec.relics) });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in to face the curse.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const day = dayKey();
  const curse = todaysCurse(day);
  const userId = session.user_id;

  /* ── Abandon and restart today's run (not a clear) ── */
  if (body.action === 'reset') {
    let out = null;
    await env.MARKETPLACE.mutate(curseKey(userId), (cur) => {
      const rec = forToday(cur, day, curse);
      if (rec.done) { out = rec; return undefined; }   /* a cleared day is never un-cleared */
      const fresh = freshRun(day, curse);
      out = fresh;
      return fresh;
    });
    const relicRec = await readRelics(env, userId);
    return json({ run: publicRun(out, curse, relicRec.relics) });
  }

  if (body.action !== 'strike') return json({ error: 'Invalid action' }, 400);

  const count = Math.max(0, Math.floor(Number(body.count) || 0));

  let justCompleted = false;
  let scattered = false;
  let after = null;

  await env.MARKETPLACE.mutate(curseKey(userId), (cur) => {
    const rec = forToday(cur, day, curse);
    const now = Date.now();

    /* Already done today: idempotent. rec.done is only ever true when `cur`
       was today's cleared record (forToday returns a fresh, undone run for any
       other day), so the stored row already holds this — no rewrite. */
    if (rec.done) { after = rec; return undefined; }

    /* Deadline curse: if the hourglass emptied, the pile scatters — reset the
       run and start this batch as the first strikes of a fresh attempt. */
    if (curse.deadlineSec > 0 && (now - rec.startedAt) / 1000 > curse.deadlineSec) {
      const attempts = (rec.failedAttempts || 0) + 1;
      rec.bones = 0; rec.strikes = 0; rec.startedAt = now; rec.lastAt = now;
      rec.failedAttempts = attempts;
      scattered = true;
    }

    const elapsed = Math.max(0, (now - rec.lastAt) / 1000);

    /* Withering: the pile rots by real time since the last strike. */
    if (curse.decayPerSec > 0) rec.bones = Math.max(0, rec.bones - curse.decayPerSec * elapsed);

    /* How many of this batch actually land: the per-flush cap AND a cumulative
       sustainable-rate cap measured from the run's start, so the throughput is
       bounded no matter how the client spaces its POSTs (a 1ms flood cannot
       out-run honest mashing). The burst leaves the first flush unclipped, and
       the rate sits well above any human, so no real masher is ever throttled. */
    const runSecs = Math.max(0, (now - rec.startedAt) / 1000);
    const cumulativeAllowance = Math.floor(runSecs * STRIKE_RATE_PER_SEC) + STRIKE_BURST;
    const remainingAllowance = Math.max(0, cumulativeAllowance - rec.strikes);
    const allowed = Math.max(0, Math.min(count, curse.reqCap, remainingAllowance));

    /* Crumble: a strike whose cumulative index is a multiple of crumbleEvery
       turns to dust. Counted across the batch's index range so the cadence is
       continuous between flushes. */
    let landed = allowed;
    if (curse.crumbleEvery > 0) {
      let crumbled = 0;
      for (let i = 1; i <= allowed; i++) {
        if ((rec.strikes + i) % curse.crumbleEvery === 0) crumbled++;
      }
      landed = allowed - crumbled;
    }

    rec.strikes += allowed;
    rec.bones += landed * curse.perStrike;
    rec.lastAt = now;

    if (rec.bones >= curse.target) {
      rec.done = true;
      rec.doneAt = now;
      rec.bones = curse.target;     /* cap the display at the goal */
      justCompleted = true;
    }

    after = rec;
    return rec;
  });

  /* Reward + hub report happen OUTSIDE the lock, only on the clear transition.
     Both are idempotent on their own side, and best-effort so a hiccup in one
     never denies the player the clear the record already recorded. */
  let relics = (await readRelics(env, userId)).relics;
  if (justCompleted) {
    try {
      relics = await grantRelic(env, userId, day, curse.id);
    } catch (err) { console.error('[skull-curse] relic grant failed:', err && err.message); }
    try {
      const { markDailyComplete } = await import('./daily/state.js');
      await markDailyComplete(env, userId, session.display_name, 'skull-curse');
    } catch (err) { console.error('[skull-curse] daily hub report failed:', err && err.message); }
  }

  return json({
    run: publicRun(after, curse, relics),
    cleared: justCompleted,
    scattered,
  });
}
