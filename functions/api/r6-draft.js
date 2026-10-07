/* ══════════════════════════════════════════════
   RAINBOW SIX SIEGE — CHAT DRAFTS THE OPERATOR.

     mod:   POST /api/r6-draft { action: 'attack' | 'defence' }   open a draft
            POST /api/r6-draft { action: 'lock' }                 freeze the tally
            POST /api/r6-draft { action: 'end' }                  clear the panel
     chat:  !op <operator>
     OBS:   GET  /api/r6-draft

   WHY THIS EXISTS AT ALL. Siege gives us nothing to read — no official API,
   no live match state — so an integration cannot reflect the game. It can
   only give chat something real to do about it, and the most real thing is a
   pick he actually has to play.

   TWO SIDES, SEPARATE DRAFTS. Attack and defence pools are disjoint, so a
   draft is opened for one side and votes resolve against that pool alone.
   During a defence draft "Thatcher" is not a near miss to fuzzy-match, it is
   simply not a candidate — which deletes every wrong-side vote for free.

   SILENT IN CHAT, like every other chat mode here. A prep phase is forty-five
   seconds; a bot line per vote would bury the channel exactly when chat is
   trying to coordinate. The overlay carries the tally.

   ONE VOTE PER CHATTER, AND IT CAN BE CHANGED. The opposite call to MTGBBB's
   guess round, on purpose: there, later information made re-guessing an
   exploit. Here there is no hidden information — the tally is on screen and
   swinging behind a pick is the whole point of a draft.

   LOCKING IS A SEPARATE STEP. A draft that closed on a timer would either cut
   chat off mid-swing or leave him waiting on a clock. The mod locks it when
   he is ready to pick, and the winner stays on screen while he loads in.
   ══════════════════════════════════════════════ */

import { SIDES, rosterFor, rosterReady, matchOperator, normalise } from './r6-operators.js';

const KEY = 'r6_draft';

/* The whole lifecycle is bounded by the stream, not a clock, so the TTL is the
   backstop for a draft nobody closed before the stream ended. */
const KEY_TTL = 14400;
const LOCKED_LINGER_MS = 90000;
const MAX_VOTERS = 2000;
const SHOWN = 5;

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

async function readDraft(env) {
  try { return await env.MARKETPLACE.get(KEY, 'json'); } catch { return null; }
}

/** A locked draft lingers so he can load in, then takes itself off screen. */
function liveView(draft, now = Date.now()) {
  if (!draft) return null;
  if (draft.status === 'locked' && now - (draft.lockedAt || 0) > LOCKED_LINGER_MS) return null;
  return draft;
}

/** The tally, highest first, ties broken by name so the order never jitters. */
export function tallyOf(draft) {
  const counts = new Map();
  for (const op of Object.values(draft.votes || {})) {
    counts.set(op, (counts.get(op) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([operator, votes]) => ({ operator, votes }))
    .sort((a, b) => (b.votes - a.votes) || (a.operator < b.operator ? -1 : 1));
}

/* ── Chat ────────────────────────────────────────────────────────────────── */

/**
 * One chatter's pick. Silent on every rejection — an unknown operator, a
 * wrong-side operator and a locked draft all look identical from chat.
 * A later vote REPLACES an earlier one; swinging behind a pick is the game.
 */
export async function voteFromChat(env, { userId, name, text }) {
  if (!userId || !text) return { ok: false, reason: 'empty' };

  const draft = liveView(await readDraft(env));
  if (!draft || draft.status !== 'open') return { ok: false, reason: 'closed' };

  const operator = matchOperator(draft.side, text);
  if (!operator) return { ok: false, reason: 'no-match' };

  const id = String(userId);
  let outcome = { ok: false, reason: 'closed' };
  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || cur.status !== 'open') return undefined;
    const had = !!cur.votes[id];
    if (!had && Object.keys(cur.votes).length >= MAX_VOTERS) {
      outcome = { ok: false, reason: 'full' };
      return undefined;
    }
    if (cur.votes[id] === operator) { outcome = { ok: false, reason: 'same' }; return undefined; }
    cur.votes[id] = operator;
    cur.voters[id] = String(name || 'Someone').slice(0, 30);
    outcome = { ok: true, operator, changed: had };
    return cur;
  }, { expirationTtl: KEY_TTL });

  return outcome;
}

/* ── Mod actions ─────────────────────────────────────────────────────────── */

export async function openDraft(env, side) {
  if (!SIDES.includes(side)) return { ok: false, error: 'Pick attack or defence.' };
  if (!rosterFor(side).length) {
    return { ok: false, error: 'No operator roster yet — paste it into functions/api/r6-operators.js.' };
  }
  const now = Date.now();
  await env.MARKETPLACE.put(KEY, JSON.stringify({
    side,
    status: 'open',
    openedAt: now,
    lockedAt: 0,
    votes: {},    // userId -> operator
    voters: {},   // userId -> display name, for the "picked by" line
    winner: null,
  }), { expirationTtl: KEY_TTL });
  return { ok: true, side };
}

/**
 * Freeze it and name the winner. The winner is computed ONCE, here, and
 * stored — recomputing it on every overlay poll would let a late vote that
 * slipped in under the lock change what is already on screen.
 */
export async function lockDraft(env) {
  let winner = null;
  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || cur.status !== 'open') return undefined;
    const tally = tallyOf(cur);
    if (!tally.length) return undefined;         // nothing to lock; leave it open
    winner = tally[0];
    cur.status = 'locked';
    cur.lockedAt = Date.now();
    cur.winner = { operator: winner.operator, votes: winner.votes, total: Object.keys(cur.votes).length };
    return cur;
  }, { expirationTtl: KEY_TTL });
  return winner ? { ok: true, winner } : { ok: false, error: 'Nobody has voted yet.' };
}

export async function endDraft(env) {
  try { await env.MARKETPLACE.delete(KEY); } catch { /* best effort */ }
  return { ok: true };
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

export async function onRequestGet(context) {
  const draft = liveView(await readDraft(context.env));
  if (!draft) return json({ status: 'none', rosterReady: rosterReady() });

  if (draft.status === 'locked') {
    return json({
      status: 'locked',
      side: draft.side,
      winner: draft.winner,
      rosterReady: true,
    });
  }

  const tally = tallyOf(draft);
  const total = Object.keys(draft.votes || {}).length;
  return json({
    status: 'open',
    side: draft.side,
    total,
    /* Trimmed for the panel; `total` keeps the real number so the bar
       percentages stay honest when a long tail is cut off. */
    tally: tally.slice(0, SHOWN),
    rosterReady: true,
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can run a draft.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  const action = String(body.action || '');

  if (action === 'attack' || action === 'defence') {
    const r = await openDraft(env, action);
    return r.ok ? json({ success: true, side: r.side }) : json({ error: r.error }, 400);
  }
  if (action === 'lock') {
    const r = await lockDraft(env);
    return r.ok ? json({ success: true, winner: r.winner }) : json({ error: r.error }, 400);
  }
  if (action === 'end') {
    await endDraft(env);
    return json({ success: true });
  }
  return json({ error: 'Unknown action' }, 400);
}

/* Re-exported so one import reaches the matcher in tests and callers. */
export { matchOperator, normalise };
