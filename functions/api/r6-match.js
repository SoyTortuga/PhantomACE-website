/* ══════════════════════════════════════════════
   RAINBOW SIX SIEGE — THE MATCH TRACKER.

     mod:   POST /api/r6-match { action:'start', side }    begin, on that side
            POST /api/r6-match { action:'won' | 'lost' }   score the round
            POST /api/r6-match { action:'swap' }           the side is wrong, flip it
            POST /api/r6-match { action:'overtime', side } pick the overtime side
            POST /api/r6-match { action:'undo' }           take back the last round
            POST /api/r6-match { action:'end' }            abandon / finish early
     all:   GET  /api/r6-match                             the live match
            GET  /api/r6-match?season=1                    this month's record

   WHY. The operator draft needs to know which SIDE is being played, and
   asking him to pick attack or defence by hand every round is exactly the
   friction that gets a stream feature switched off. Ranked's rotation is
   deterministic, so the site can work it out from one answer at the start.

   THE RANKED ROTATION, as encoded here:
     Rounds 1-3   the side he started on
     Rounds 4-6   the other side
     First to 4 round wins takes the match (4-0, 4-1, 4-2)
     3-3 after six rounds goes to overtime
     Overtime     sides reset, then swap EVERY round; first to 5 wins

   IT PREDICTS, IT NEVER INSISTS. A derived side is a guess about a game we
   cannot read, so `swap` flips it and the match carries on from there. A wrong
   assumption costs one click rather than making the draft useless — the same
   reason the overtime side is ASKED FOR rather than assumed. Ranked's overtime
   assignment is its own rule and not worth guessing at; he can see it on his
   screen, and it is one button once per match.

   THE RECORD FALLS OUT OF IT. Tracking rounds to derive the side means the
   round-by-round history already exists, so the season record is a by-product
   rather than a second thing to maintain.
   ══════════════════════════════════════════════ */

import { monthKey } from './season-time.js';

const KEY = 'r6_match';
const SEASON_PREFIX = 'r6_season_';

/* A match is an hour at the outside; the TTL is the backstop for one he never
   closed before the stream ended. */
const MATCH_TTL = 28800;

const REGULATION_ROUNDS = 6;
const REGULATION_WINS = 4;
const OVERTIME_WINS = 5;
const MAX_ROUNDS = 9;

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

export const other = (side) => (side === 'attack' ? 'defence' : 'attack');

/**
 * Which side a given round is played on.
 *
 * Returns null in overtime before the overtime side has been given — the one
 * thing this cannot derive, and guessing it would put the draft on the wrong
 * pool at the tensest point of the match.
 */
export function sideForRound(match, round) {
  if (!match || !match.startSide) return null;
  if (round <= 3) return match.startSide;
  if (round <= REGULATION_ROUNDS) return other(match.startSide);

  if (!match.otStartSide) return null;
  /* Overtime swaps every round, so it alternates from round 7. */
  const i = round - (REGULATION_ROUNDS + 1);
  return i % 2 === 0 ? match.otStartSide : other(match.otStartSide);
}

/** Has somebody taken it? */
export function matchOver(match) {
  const target = match.overtime ? OVERTIME_WINS : REGULATION_WINS;
  return match.us >= target || match.them >= target;
}

/** The live shape the overlay and the draft both read. */
export function publicMatch(match) {
  if (!match || match.status !== 'live') return { status: 'none' };
  const side = sideForRound(match, match.round);
  return {
    status: 'live',
    round: match.round,
    us: match.us,
    them: match.them,
    overtime: !!match.overtime,
    side,
    /* True exactly when the tracker is waiting on the one answer it cannot
       work out for itself. The dashboard shows the overtime picker on this. */
    needsOvertimeSide: match.overtime && !match.otStartSide,
    /* So the panel can say "sides swap next round" before it happens — the
       moment that decides which operator is worth drafting. */
    nextSide: match.round < MAX_ROUNDS ? sideForRound(match, match.round + 1) : null,
    history: match.history || [],
  };
}

async function read(env) {
  try { return await env.MARKETPLACE.get(KEY, 'json'); } catch { return null; }
}

/* ── The season record, a by-product of the tracking ─────────────────────── */

async function recordResult(env, match) {
  const key = SEASON_PREFIX + monthKey();
  const won = match.us > match.them;
  await env.MARKETPLACE.mutate(key, (cur) => {
    const s = cur || { month: monthKey(), matches: 0, wins: 0, losses: 0, roundsWon: 0, roundsLost: 0 };
    s.matches++;
    if (won) s.wins++; else s.losses++;
    s.roundsWon += match.us;
    s.roundsLost += match.them;
    return s;
  });
}

export async function readSeason(env) {
  try {
    const s = await env.MARKETPLACE.get(SEASON_PREFIX + monthKey(), 'json');
    if (s) return s;
  } catch { /* fall through */ }
  return { month: monthKey(), matches: 0, wins: 0, losses: 0, roundsWon: 0, roundsLost: 0 };
}

/* ── Actions ─────────────────────────────────────────────────────────────── */

export async function startMatch(env, side) {
  if (side !== 'attack' && side !== 'defence') return { ok: false, error: 'Pick attack or defence.' };
  await env.MARKETPLACE.put(KEY, JSON.stringify({
    status: 'live',
    startSide: side,
    otStartSide: null,
    round: 1,
    us: 0,
    them: 0,
    overtime: false,
    history: [],
    startedAt: Date.now(),
  }), { expirationTtl: MATCH_TTL });
  return { ok: true };
}

/**
 * Score a round and move on.
 *
 * The side is stamped into history as it was WHEN THE ROUND WAS PLAYED, not
 * recomputed later — a swap partway through a match would otherwise rewrite
 * which side earlier rounds were played on.
 */
export async function scoreRound(env, result) {
  if (result !== 'won' && result !== 'lost') return { ok: false, error: 'Unknown result.' };
  let outcome = { ok: false, error: 'No match running.' };

  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || cur.status !== 'live') return undefined;

    const playedSide = sideForRound(cur, cur.round);
    cur.history.push({ round: cur.round, side: playedSide, result });
    if (result === 'won') cur.us++; else cur.them++;

    if (matchOver(cur)) {
      cur.status = 'done';
      cur.endedAt = Date.now();
      outcome = { ok: true, finished: true, us: cur.us, them: cur.them };
      return cur;
    }

    cur.round++;
    /* 3-3 after regulation is overtime. The side is asked for, never assumed. */
    if (!cur.overtime && cur.round > REGULATION_ROUNDS) {
      cur.overtime = true;
      cur.otStartSide = null;
    }
    outcome = { ok: true, finished: false, round: cur.round, needsOvertimeSide: cur.overtime && !cur.otStartSide };
    return cur;
  }, { expirationTtl: MATCH_TTL });

  /* Recorded after the lock is released — a second key, and the match's own
     lock must not be held across it. */
  if (outcome.ok && outcome.finished) {
    const done = await read(env);
    if (done) { try { await recordResult(env, done); } catch (err) { console.error('[r6-match] season record failed:', err.message); } }
  }
  return outcome;
}

/** The derived side was wrong. Flip the whole rotation from here. */
export async function swapSides(env) {
  let side = null;
  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || cur.status !== 'live') return undefined;
    /* Flipping the ANCHOR, not the current round, so every future round stays
       consistent with the correction rather than alternating wrongly again. */
    if (cur.overtime && cur.otStartSide) cur.otStartSide = other(cur.otStartSide);
    else cur.startSide = other(cur.startSide);
    side = sideForRound(cur, cur.round);
    return cur;
  }, { expirationTtl: MATCH_TTL });
  return side ? { ok: true, side } : { ok: false, error: 'No match running.' };
}

export async function setOvertimeSide(env, side) {
  if (side !== 'attack' && side !== 'defence') return { ok: false, error: 'Pick attack or defence.' };
  let ok = false;
  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || cur.status !== 'live' || !cur.overtime) return undefined;
    cur.otStartSide = side;
    ok = true;
    return cur;
  }, { expirationTtl: MATCH_TTL });
  return ok ? { ok: true } : { ok: false, error: 'Not in overtime.' };
}

/** Take back the last round — a misclick mid-match is the common case. */
export async function undoRound(env) {
  let ok = false;
  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || !cur.history || !cur.history.length) return undefined;
    const last = cur.history.pop();
    if (last.result === 'won') cur.us--; else cur.them--;
    cur.round = last.round;
    cur.status = 'live';
    delete cur.endedAt;
    /* Stepping back into regulation leaves overtime behind with it. */
    if (cur.round <= REGULATION_ROUNDS) { cur.overtime = false; cur.otStartSide = null; }
    ok = true;
    return cur;
  }, { expirationTtl: MATCH_TTL });
  return ok ? { ok: true } : { ok: false, error: 'Nothing to undo.' };
}

export async function endMatch(env) {
  try { await env.MARKETPLACE.delete(KEY); } catch { /* best effort */ }
  return { ok: true };
}

/** The live match, for anything that wants to title itself after the round. */
export async function currentMatch(env) {
  return publicMatch(await read(env));
}

/** What the draft asks when it wants to open on the right side by itself. */
export async function activeSide(env) {
  const m = await read(env);
  if (!m || m.status !== 'live') return null;
  return sideForRound(m, m.round);
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  if (new URL(request.url).searchParams.get('season')) {
    return json(await readSeason(env));
  }
  return json(publicMatch(await read(env)));
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can track a match.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  const action = String(body.action || '');

  if (action === 'start') {
    const r = await startMatch(env, String(body.side || ''));
    return r.ok ? json({ success: true }) : json({ error: r.error }, 400);
  }
  if (action === 'won' || action === 'lost') {
    const r = await scoreRound(env, action);
    return r.ok ? json({ success: true, ...r }) : json({ error: r.error }, 400);
  }
  if (action === 'swap') {
    const r = await swapSides(env);
    return r.ok ? json({ success: true, side: r.side }) : json({ error: r.error }, 400);
  }
  if (action === 'overtime') {
    const r = await setOvertimeSide(env, String(body.side || ''));
    return r.ok ? json({ success: true }) : json({ error: r.error }, 400);
  }
  if (action === 'undo') {
    const r = await undoRound(env);
    return r.ok ? json({ success: true }) : json({ error: r.error }, 400);
  }
  if (action === 'end') { await endMatch(env); return json({ success: true }); }
  return json({ error: 'Unknown action' }, 400);
}
