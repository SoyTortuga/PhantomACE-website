/* ══════════════════════════════════════════════
   MANA CLASH — Farkle with mana dice

   Rules: docs/MANA-CLASH-RULES.md. Scoring: mana-clash-scoring.js, which is
   the authority — the client scores a hand too so dice light up as they
   land, but every selection is re-scored here.

   ROOM WRITES ALL GO THROUGH mutate(). Rounds are simultaneous, so two
   players acting inside the same tick is the ordinary case, and a
   get-modify-put would lose one of them. That would surface as a die that
   visibly rolled and then wasn't there.

   TIME IS RESOLVED LAZILY, on whatever request arrives next. There is no
   scheduler: an idle clock that expires and an intermission that ends are
   both just "this deadline has passed," applied at the top of every read and
   every write. A room with nobody polling it has no state worth advancing.
   ══════════════════════════════════════════════ */

import {
  rollDice, scoreSelection, scorableMask, hasAnyScore, isHotDice, bestSelection, DICE_COUNT,
} from './mana-clash-scoring.js';

const ROOM_TTL = 7200;
const MAX_PLAYERS = 100;
const INTERMISSION_MS = 10000;
const GOALS = [5000, 10000, 20000];
const IDLE_CHOICES = [10000, 30000, 60000];

/* Only 10,000-point games reach the boards. A 5,000 game is much quicker and
   a 20,000 game much longer; mixing them would make both boards meaningless. */
const RANKED_GOAL = 10000;

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* Login required. Mana Clash used to accept a localStorage guest id, which
   made "most wins" unownable — a guest id is free to mint, so a board built
   on it ranks whoever cared to refresh. Prizes ride on these boards. */
function getPlayer(request) {
  const session = getSession(request);
  if (!session || !session.user_id) return null;
  return {
    userId: String(session.user_id),
    displayName: session.display_name || 'Player',
    profileImage: session.profile_image || null,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/* ══ Turn state ═══════════════════════════════════════════════════════════
   One player's turn within one round. `pending` is at risk until banked —
   that tension is the whole game. */

function freshTurn(room, now) {
  return {
    pending: 0,
    dice: [],               // on the table, not yet resolved
    kept: [],               // set aside this turn, for display
    remaining: DICE_COUNT,  // how many will be rolled next
    awaitingSelection: false,
    done: null,             // 'banked' | 'burned' | 'timeout' | 'out'
    /* What this round actually added to the total, filled in when the turn
       resolves. Stated rather than left for the page to infer from `pending`
       — pending happens not to be cleared on a bank, and a display that
       depends on a field not being reset is one refactor from lying. */
    gained: null,
    event: null,            // 'clash' | 'burn', for the page to animate
    deadline: now + room.idleMs,
  };
}

function sittingOut() {
  return {
    pending: 0, dice: [], kept: [], remaining: 0,
    awaitingSelection: false, done: 'out', gained: null, event: null, deadline: null,
  };
}

/** Any action by the player resets their idle clock. */
function touch(room, turn, now) {
  turn.deadline = now + room.idleMs;
}

/**
 * Who ROLLS this round.
 *
 * Not everyone, on a final round. Reaching the goal ends your game: the
 * final round belongs to the people trying to beat you, and you watch.
 */
function playersInRound(room) {
  const all = Object.keys(room.players);
  if (room.tiedPlayers) return all.filter(id => room.tiedPlayers.includes(id));
  const resting = room.restingIds || [];
  return all.filter(id => !resting.includes(id));
}

/**
 * Who can WIN. A different list, and conflating the two was a real bug.
 *
 * The player who crossed the goal sits the final round out but is very much
 * still in the running — everyone else is playing to beat them. One
 * eligibility list served both purposes, so the leader was excluded from the
 * comparison that decides their own victory, and whoever came closest among
 * the chasers won with a lower score.
 */
function contenders(room) {
  const all = Object.keys(room.players);
  if (room.tiedPlayers) return all.filter(id => room.tiedPlayers.includes(id));
  return all;
}

/* ══ Round lifecycle ══════════════════════════════════════════════════════ */

function startRound(room, now) {
  room.round++;
  room.isFinalRound = !!room.nextIsFinal;
  room.nextIsFinal = false;
  room.status = 'playing';
  room.roundStartedAt = now;
  room.intermissionEndsAt = null;

  /* Only a final round rests anyone. Cleared here so a tiebreak, or a game
     that somehow carries on, does not inherit a stale list. */
  if (!room.isFinalRound) room.restingIds = [];

  const playing = playersInRound(room);
  for (const [id, p] of Object.entries(room.players)) {
    p.turn = playing.includes(id) ? freshTurn(room, now) : sittingOut();
  }
}

/**
 * Every eligible player has banked or burned.
 *
 * The goal does not end the game on its own. Crossing it arms one final
 * round that everyone plays, so being last to act is not a disadvantage —
 * which is the point of simultaneous rounds.
 */
function endRound(room, now) {
  /* Everyone eligible has left or been removed. Ending on whoever is still
     in the room beats looping the round forever with nobody in it. */
  const remaining = Object.keys(room.players);
  if (playersInRound(room).length === 0) {
    room.status = 'finished';
    room.winner = remaining.length
      ? remaining.reduce((a, b) => (room.players[b].total > room.players[a].total ? b : a))
      : null;
    room.finishedAt = now;
    room.intermissionEndsAt = null;
    return;
  }

  if (room.isFinalRound) {
    /* Over CONTENDERS, not over whoever rolled. The player resting on the
       goal is the one everybody was chasing; leaving them out of this
       comparison would hand the game to the best of the chasers even when
       none of them caught up. */
    const pool = contenders(room);
    const best = Math.max(...pool.map(id => room.players[id].total));
    const tied = pool.filter(id => room.players[id].total === best);

    if (tied.length > 1) {
      room.tiedPlayers = tied;
      room.restingIds = [];             // a tiebreak is played by all the tied
      room.nextIsFinal = true;          // the tiebreak is itself a final round
      room.status = 'intermission';
      room.intermissionEndsAt = now + INTERMISSION_MS;
      return;
    }

    room.status = 'finished';
    room.winner = tied[0];
    room.finishedAt = now;
    room.intermissionEndsAt = null;
    return;
  }

  /* Whoever crossed the goal is finished. They rest through the final round
     while everyone else gets one turn to beat them — which is the whole
     point of a final round, and is not what happens if the leader plays it
     too and simply extends their own lead. */
  const crossed = Object.keys(room.players).filter(id => room.players[id].total >= room.goal);
  room.nextIsFinal = crossed.length > 0;
  room.restingIds = crossed;
  room.status = 'intermission';
  room.intermissionEndsAt = now + INTERMISSION_MS;
}

function roundIsOver(room) {
  const playing = playersInRound(room);
  if (playing.length === 0) return true;
  return playing.every(id => room.players[id].turn && room.players[id].turn.done);
}

/**
 * Apply everything the clock owes: expired idle timers, then a finished
 * round, then an elapsed intermission — in that order, repeatedly, because
 * each can cause the next. A room polled after a long gap catches up in one
 * pass rather than one step per poll.
 *
 * Returns true if anything changed, which is what decides whether a poll
 * writes at all.
 */
function advance(room, now) {
  let changed = false;

  for (let guard = 0; guard < 50; guard++) {
    if (room.status === 'playing') {
      for (const id of playersInRound(room)) {
        const turn = room.players[id].turn;
        if (!turn || turn.done || turn.deadline === null || now < turn.deadline) continue;
        /* Expiry banks what they are holding rather than taking it. The
           clock exists so one closed tab cannot stall a room, not to punish
           slow play. Anything rolled but never selected is simply not part
           of `pending`, so it is neither kept nor lost — there was no
           decision, so nothing is taken for one. */
        room.players[id].total += turn.pending;
        turn.gained = turn.pending;
        turn.done = 'timeout';
        turn.awaitingSelection = false;
        changed = true;
      }

      if (roundIsOver(room)) { endRound(room, now); changed = true; continue; }
      break;
    }

    if (room.status === 'intermission') {
      if (now < room.intermissionEndsAt) break;
      startRound(room, now);
      changed = true;
      continue;
    }

    break;   // lobby or finished — nothing the clock owes
  }

  return changed;
}

/* ══ Leaderboards ═════════════════════════════════════════════════════════
   Written here, from the finished room, rather than POSTed by the winner's
   browser. The server already knows who won; asking the client to report it
   would make "most wins" a number anyone can curl.

   Only ranked games count: goal exactly 10,000, and not a practice room. */

const WINS_BOARD = 'lb_mana_clash_wins';
const SCORE_BOARD = 'lb_mana_clash';
const MAX_ENTRIES = 50;

function isRanked(room) {
  return room.goal === RANKED_GOAL && !room.practice;
}

async function recordResult(env, room) {
  if (!isRanked(room)) return;

  await env.MARKETPLACE.mutate(WINS_BOARD, (current) => {
    const lb = Array.isArray(current) ? current : [];
    const winner = room.players[room.winner];
    if (!winner) return undefined;
    const row = lb.find(e => e.id === room.winner);
    if (row) { row.score += 1; row.name = winner.displayName; row.updatedAt = Date.now(); }
    else lb.push({ id: room.winner, name: winner.displayName, score: 1, updatedAt: Date.now() });
    lb.sort((a, b) => b.score - a.score);
    return lb.slice(0, MAX_ENTRIES);
  });

  /* Every player's final score, not only the winner's — a strong losing
     game still deserves to register on a high-score board. */
  await env.MARKETPLACE.mutate(SCORE_BOARD, (current) => {
    const lb = Array.isArray(current) ? current : [];
    for (const [id, p] of Object.entries(room.players)) {
      if (p.total <= 0) continue;
      const row = lb.find(e => e.id === id);
      if (row) {
        if (p.total > row.score) { row.score = p.total; row.updatedAt = Date.now(); }
        row.name = p.displayName;
      } else {
        lb.push({ id, name: p.displayName, score: p.total, updatedAt: Date.now() });
      }
    }
    lb.sort((a, b) => b.score - a.score);
    return lb.slice(0, MAX_ENTRIES);
  });
}

/* ══ Views ════════════════════════════════════════════════════════════════
   A player is told about their own dice and everyone else's totals. Sending
   the whole room document would hand every client every other player's
   hand — harmless in a friendly game, but it is also how you would cheat,
   and with a hundred players it is a lot of JSON per poll. */

function publicPlayer(id, p, { dice = false } = {}) {
  const out = {
    id,
    name: p.displayName,
    avatar: p.profileImage,
    ready: !!p.ready,
    total: p.total,
    pending: p.turn ? p.turn.pending : 0,
    /* Null until the turn resolves, so the page can tell "holding 550, still
       rolling" from "banked 550" without guessing. */
    gained: p.turn ? p.turn.gained : null,
    done: p.turn ? p.turn.done : null,
    event: p.turn ? p.turn.event : null,
  };

  /* OPT-IN, and only the overlay asks. Rounds are simultaneous, so at any
     moment several players have dice on the table — the on-stream panel
     shows them landing, which is the whole appeal of watching. The players'
     own payload is left exactly as it was: the game page has never needed
     anyone else's dice, and quietly widening what every client receives to
     serve one spectator is how a contract drifts.

     Nothing here is secret. Dice are rolled face up; every one of these
     numbers is already on the screen of the player who rolled it, and the
     overlay is pointed at a stream where they are visible anyway. */
  if (dice && p.turn) {
    out.dice = Array.isArray(p.turn.dice) ? p.turn.dice.slice() : [];
    out.kept = Array.isArray(p.turn.kept) ? p.turn.kept.slice() : [];
    out.remaining = p.turn.remaining;
    out.awaitingSelection = !!p.turn.awaitingSelection;
  }

  return out;
}

/**
 * The room as one client should see it.
 *
 * `userId` null is a SPECTATOR: no `you` block, which is the only part of
 * this that was ever private. Everything else — round, goal, standings,
 * who is resting, the winner, the intermission clock — already goes to
 * every player in the room, so the overlay needs no separate shape and
 * there is no second view to keep in step with this one.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dice] include each player's dice, for the overlay
 */
export function viewFor(room, userId, now, opts = {}) {
  const me = room.players[userId];
  const standings = Object.entries(room.players)
    .map(([id, p]) => publicPlayer(id, p, opts))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const view = {
    code: room.code,
    status: room.status,
    goal: room.goal,
    idleMs: room.idleMs,
    practice: !!room.practice,
    ranked: isRanked(room),
    round: room.round,
    isFinalRound: !!room.isFinalRound,
    nextIsFinal: !!room.nextIsFinal,
    tiedPlayers: room.tiedPlayers || null,
    /* Sent to EVERYONE, not only the player it applies to. The chasers
       should be able to see which player they are chasing; a strip that
       labels the leader "sitting out" describes the mechanic and hides the
       fact. */
    resting: (room.restingIds || []).slice(),
    host: room.host,
    hostName: room.hostName,
    hasPassword: !!room.password,
    maxPlayers: MAX_PLAYERS,
    playerCount: Object.keys(room.players).length,
    players: standings,
    winner: room.winner || null,
    intermissionMsLeft: room.intermissionEndsAt ? Math.max(0, room.intermissionEndsAt - now) : 0,
    serverNow: now,
  };

  /* `you` is present whenever the player is in the room, turn or no turn.
     Gating it on me.turn meant the lobby — where turn is null until the game
     starts — sent no `you` at all, so the page could not tell the host from
     anyone else and never showed the Start button. Being in the room is the
     fact the page needs; having a turn is not. */
  if (me) {
    const t = me.turn;
    view.you = {
      id: userId,
      total: me.total,
      pending: t ? t.pending : 0,
      dice: t ? t.dice : [],
      /* Computed here so the page cannot disagree with the scorer about
         which dice are keepable. The client highlights what this says. */
      scorable: t && t.dice.length ? scorableMask(t.dice) : [],
      /* What the page pre-selects, so the player removes dice they don't
         want rather than assembling a keep from nothing. Sent from here
         because it must be a selection this server will accept — "every die
         that lights up" is not: a die lights up if it scores in some
         reading, and two dice can light up under readings that exclude each
         other. bestSelection() returns a real one, proven legal and optimal
         across every hand in test-scoring.js. */
      suggested: t && t.awaitingSelection && t.dice.length
        ? (bestSelection(t.dice) || { indices: [] }).indices
        : [],
      kept: t ? t.kept : [],
      remaining: t ? t.remaining : DICE_COUNT,
      awaitingSelection: !!(t && t.awaitingSelection),
      done: t ? t.done : null,
      /* `?? null` rather than a bare read: a room created before this field
         existed has turns without it, and JSON drops undefined entirely, so
         the page would see the key missing rather than empty. */
      gained: (t && t.gained !== undefined) ? t.gained : null,
      event: t ? t.event : null,
      msLeft: t && t.deadline ? Math.max(0, t.deadline - now) : 0,
      canRoll: !!(t && room.status === 'playing' && !t.done && !t.awaitingSelection),
      canBank: !!(t && room.status === 'playing' && !t.done && !t.awaitingSelection && t.pending > 0),
    };

    /* Sitting out is not the same as having nothing to do. The player who
       reached the goal has FINISHED — everyone else is rolling to beat
       them — and a screen that just greys out their dice reads as being
       locked out of their own win. They get told what is being chased and
       by whom. */
    if (me.turn && me.turn.done === 'out') {
      const resting = (room.restingIds || []).includes(userId);
      const chasers = playersInRound(room);
      view.you.spectating = {
        reason: resting ? 'goal' : 'tiebreak',
        target: me.total,
        chasers: chasers.length,
        /* Highest total among the people still rolling, so the screen can
           say how close the nearest one is. */
        closest: chasers.length
          ? Math.max(...chasers.map(id => room.players[id].total))
          : 0,
        done: chasers.filter(id => room.players[id].turn && room.players[id].turn.done).length,
      };
    }
  }

  return view;
}

/* ══ Shared write path ════════════════════════════════════════════════════ */

/**
 * Write the finished game to the boards exactly once.
 *
 * A game can end on any request that moves the clock — a bank, a burn, a
 * kick, or just somebody polling — so several callers can see `finished` at
 * the same moment. The right to record is claimed under the room's own lock;
 * everyone who loses the claim does nothing.
 */
async function settle(env, code, room) {
  if (!room || room.status !== 'finished' || room.resultsRecorded) return;

  let claimed = false;
  await env.MARKETPLACE.mutate('mc_room_' + code, (current) => {
    if (!current || current.status !== 'finished' || current.resultsRecorded) return undefined;
    current.resultsRecorded = true;
    claimed = true;
    return current;
  }, { expirationTtl: ROOM_TTL });

  if (claimed) await recordResult(env, room);
}

async function withRoom(env, code, fn) {
  let failed = null;
  const room = await env.MARKETPLACE.mutate('mc_room_' + code, (current) => {
    if (!current) { failed = json({ error: 'Room not found' }, 404); return undefined; }
    const now = Date.now();
    const moved = advance(current, now);
    const err = fn(current, now);
    if (err) {
      /* The action is refused, but the clock is not rolled back: an idle
         timer that expired stays expired. Writing the advance and refusing
         the action are not in conflict. */
      failed = err;
      return moved ? current : undefined;
    }
    return current;
  }, { expirationTtl: ROOM_TTL });

  await settle(env, code, room);
  return { failed, room };
}

/** The player's own turn, or a Response explaining why they cannot act. */
function activeTurn(room, userId) {
  if (room.status === 'intermission') return json({ error: 'Between rounds — hold on.' }, 409);
  if (room.status !== 'playing') return json({ error: 'Game not in progress' }, 400);
  const p = room.players[userId];
  if (!p) return json({ error: 'Not in this room' }, 403);
  if (!p.turn || p.turn.done === 'out') return json({ error: 'You are sitting this round out.' }, 400);
  if (p.turn.done) return json({ error: 'Your round is over.' }, 400);
  return null;
}

/* ══ GET ══════════════════════════════════════════════════════════════════ */

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'list-rooms') {
    const rows = await env.MARKETPLACE.listValues({ prefix: 'mc_room_' });
    const rooms = [];
    for (const { value: room } of rows) {
      if (!room || room.status !== 'lobby' || room.practice) continue;
      rooms.push({
        code: room.code,
        host: room.hostName,
        playerCount: Object.keys(room.players).length,
        maxPlayers: MAX_PLAYERS,
        hasPassword: !!room.password,
        goal: room.goal,
      });
    }
    return json(rooms);
  }

  if (action === 'get-state') {
    const code = (url.searchParams.get('code') || '').toUpperCase().trim();
    if (!code) return json({ error: 'Missing room code' }, 400);
    const player = getPlayer(request);
    if (!player) return json({ error: 'Log in with Twitch to play Mana Clash.' }, 401);

    /* Writes only when the clock actually moved something. This route is
       polled every couple of seconds by every player in the room; writing
       unconditionally would be a hundred writes a second to one row, all but
       one of them storing what was already there. */
    let finished = false;
    const room = await env.MARKETPLACE.mutate('mc_room_' + code, (current) => {
      if (!current) return undefined;
      const wasFinished = current.status === 'finished';
      const changed = advance(current, Date.now());
      finished = !wasFinished && current.status === 'finished';
      return changed ? current : undefined;
    }, { expirationTtl: ROOM_TTL });

    if (!room) return json({ error: 'Room not found' }, 404);
    if (finished) await settle(env, code, room);
    return json(viewFor(room, player.userId, Date.now()));
  }

  return json({ error: 'Invalid action' }, 400);
}

/* ══ POST ═════════════════════════════════════════════════════════════════ */

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const player = getPlayer(request);
  if (!player) return json({ error: 'Log in with Twitch to play Mana Clash.' }, 401);
  const { userId, displayName, profileImage } = player;

  const code = (body.code || '').toUpperCase().trim();

  /* ── create-room ──────────────────────────────────────────────────── */
  if (body.action === 'create-room') {
    const goal = Number(body.goal);
    if (!GOALS.includes(goal)) return json({ error: `Goal must be one of: ${GOALS.join(', ')}` }, 400);
    const idleMs = Number(body.idleMs);
    if (!IDLE_CHOICES.includes(idleMs)) return json({ error: 'Pick a 10, 30 or 60 second timer.' }, 400);
    const practice = !!body.practice;

    let made = null;
    for (let i = 0; i < 10; i++) {
      const candidate = generateCode();
      const fresh = {
        code: candidate,
        host: userId, hostName: displayName,
        password: practice ? null : (body.password || null),
        practice,
        goal, idleMs,
        status: 'lobby',
        round: 0, roundStartedAt: null,
        isFinalRound: false, nextIsFinal: false, tiedPlayers: null,
        intermissionEndsAt: null,
        winner: null,
        players: {
          [userId]: { displayName, profileImage, ready: true, total: 0, turn: null },
        },
        createdAt: Date.now(),
      };
      /* The claim on the code is the write itself — a get-then-put let two
         simultaneous creates pick the same code, and the second replaced the
         first room out from under its host.

         Whether the claim succeeded is reported by the mutator rather than
         inferred from what mutate() hands back. Comparing the return value
         by identity would quietly depend on mutate() returning the very
         object it was given, which is an implementation detail and not
         something a caller should be able to break by changing. */
      let claimed = false;
      await env.MARKETPLACE.mutate('mc_room_' + candidate, (current) => {
        if (current) return undefined;
        claimed = true;
        return fresh;
      }, { expirationTtl: ROOM_TTL });
      if (claimed) { made = candidate; break; }
    }
    if (!made) return json({ error: 'Could not generate a room code' }, 500);
    return json({ success: true, code: made, practice });
  }

  if (!code) return json({ error: 'Missing room code' }, 400);

  /* ── join-room ────────────────────────────────────────────────────── */
  if (body.action === 'join-room') {
    const { failed } = await withRoom(env, code, (room) => {
      if (room.players[userId]) return null;   // rejoining is not an error
      if (room.practice) return json({ error: 'That is a solo practice room.' }, 403);
      if (room.status !== 'lobby') return json({ error: 'That game has already started.' }, 400);
      if (Object.keys(room.players).length >= MAX_PLAYERS) return json({ error: 'Room is full' }, 400);
      if (room.password && body.password !== room.password) return json({ error: 'Wrong password' }, 403);
      if (Array.isArray(room.kicked) && room.kicked.includes(userId)) {
        return json({ error: 'The host removed you from this room.' }, 403);
      }
      room.players[userId] = { displayName, profileImage, ready: false, total: 0, turn: null };
      return null;
    });
    if (failed) return failed;
    return json({ success: true, code });
  }

  /* ── ready ────────────────────────────────────────────────────────── */
  if (body.action === 'ready') {
    const { failed, room } = await withRoom(env, code, (r) => {
      if (r.status !== 'lobby') return json({ error: 'The game has already started.' }, 400);
      const p = r.players[userId];
      if (!p) return json({ error: 'Not in this room' }, 403);
      p.ready = body.ready === undefined ? true : !!body.ready;
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── kick ─────────────────────────────────────────────────────────── */
  if (body.action === 'kick') {
    const target = String(body.userId || '');
    const { failed, room } = await withRoom(env, code, (r) => {
      if (r.host !== userId) return json({ error: 'Only the host can remove players.' }, 403);
      if (target === userId) return json({ error: 'You cannot remove yourself — leave instead.' }, 400);
      if (!r.players[target]) return json({ error: 'That player is not here.' }, 404);
      delete r.players[target];
      /* Remembered, or they rejoin from the lobby list a second later and
         the host is back where they started. */
      r.kicked = Array.isArray(r.kicked) ? r.kicked : [];
      if (!r.kicked.includes(target)) r.kicked.push(target);
      if (r.tiedPlayers) r.tiedPlayers = r.tiedPlayers.filter(id => id !== target);
      /* Removing the player the round was waiting on ends it here. */
      if (r.status === 'playing' && roundIsOver(r)) endRound(r, Date.now());
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── leave-room ───────────────────────────────────────────────────── */
  if (body.action === 'leave-room') {
    let emptied = false;
    const { failed } = await withRoom(env, code, (r) => {
      if (!r.players[userId]) return null;
      delete r.players[userId];
      if (Object.keys(r.players).length === 0) { emptied = true; return null; }
      if (r.host === userId) {
        const next = Object.keys(r.players)[0];
        r.host = next;
        r.hostName = r.players[next].displayName;
      }
      if (r.tiedPlayers) r.tiedPlayers = r.tiedPlayers.filter(id => id !== userId);
      if (r.status === 'playing' && roundIsOver(r)) endRound(r, Date.now());
      return null;
    });
    if (failed) return failed;
    /* Deleted outside the lock. A join landing in the gap costs that player
       a rejoin; an empty room is the one state where losing a write is free. */
    if (emptied) await env.MARKETPLACE.delete('mc_room_' + code);
    return json({ success: true });
  }

  /* ── start-game ───────────────────────────────────────────────────── */
  if (body.action === 'start-game') {
    const { failed, room } = await withRoom(env, code, (r, now) => {
      if (r.host !== userId) return json({ error: 'Only the host can start.' }, 403);
      if (r.status !== 'lobby') return json({ error: 'Already started' }, 400);
      const ids = Object.keys(r.players);
      if (!r.practice && ids.length < 2) return json({ error: 'Wait for someone to join.' }, 400);
      if (ids.some(id => !r.players[id].ready)) return json({ error: 'Not everyone is ready.' }, 400);
      r.round = 0;
      r.tiedPlayers = null;
      r.nextIsFinal = false;
      for (const p of Object.values(r.players)) p.total = 0;
      startRound(r, now);
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── roll ─────────────────────────────────────────────────────────── */
  if (body.action === 'roll') {
    const { failed, room } = await withRoom(env, code, (r, now) => {
      const blocked = activeTurn(r, userId);
      if (blocked) return blocked;
      const t = r.players[userId].turn;
      if (t.awaitingSelection) return json({ error: 'Keep at least one die first.' }, 400);

      t.dice = rollDice(t.remaining);
      t.event = null;

      if (!hasAnyScore(t.dice)) {
        /* MANA BURN. Everything pending is lost — that is the whole risk of
           rolling again, and softening it would remove the decision. */
        t.pending = 0;
        t.kept = [];
        t.gained = 0;
        t.done = 'burned';
        t.event = 'burn';
        t.awaitingSelection = false;
        t.deadline = null;
        if (roundIsOver(r)) endRound(r, now);
        return null;
      }

      if (isHotDice(t.dice)) {
        /* MANA CLASH. Every die scores, so there is nothing to choose and
           nothing to be gained by making them click it. */
        t.pending += scoreSelection(t.dice).points;
        t.kept = t.kept.concat(t.dice);
        t.dice = [];
        t.remaining = DICE_COUNT;
        t.awaitingSelection = false;
        t.event = 'clash';
        touch(r, t, now);
        return null;
      }

      t.awaitingSelection = true;
      touch(r, t, now);
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── keep ─────────────────────────────────────────────────────────── */
  if (body.action === 'keep') {
    const picks = Array.isArray(body.indices) ? body.indices : null;
    const { failed, room } = await withRoom(env, code, (r, now) => {
      const blocked = activeTurn(r, userId);
      if (blocked) return blocked;
      const t = r.players[userId].turn;
      if (!t.awaitingSelection) return json({ error: 'Roll first.' }, 400);
      if (!picks || picks.length === 0) return json({ error: 'Keep at least one die.' }, 400);

      const seen = new Set();
      for (const i of picks) {
        if (!Number.isInteger(i) || i < 0 || i >= t.dice.length) return json({ error: 'That die is not on the table.' }, 400);
        if (seen.has(i)) return json({ error: 'Same die picked twice.' }, 400);
        seen.add(i);
      }

      const chosen = picks.map(i => t.dice[i]);
      const result = scoreSelection(chosen);
      if (!result.valid) return json({ error: result.reason }, 400);

      t.pending += result.points;
      t.kept = t.kept.concat(chosen);
      t.dice = t.dice.filter((_, i) => !seen.has(i));
      t.remaining = t.dice.length;
      t.awaitingSelection = false;
      t.event = null;

      /* Unreachable in practice — a hand where every die scores is taken on
         the roll — but a player left with zero dice and no pickup would be
         stuck forever, so it is not a state worth trusting to an argument. */
      if (t.remaining === 0) {
        t.dice = [];
        t.remaining = DICE_COUNT;
        t.event = 'clash';
      }

      touch(r, t, now);
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── bank ─────────────────────────────────────────────────────────── */
  if (body.action === 'bank') {
    const { failed, room } = await withRoom(env, code, (r, now) => {
      const blocked = activeTurn(r, userId);
      if (blocked) return blocked;
      const t = r.players[userId].turn;
      if (t.awaitingSelection) return json({ error: 'Keep your scoring dice first.' }, 400);
      if (t.pending <= 0) return json({ error: 'Nothing to bank yet.' }, 400);

      r.players[userId].total += t.pending;
      t.gained = t.pending;
      t.done = 'banked';
      t.deadline = null;
      t.dice = [];
      if (roundIsOver(r)) endRound(r, now);
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  return json({ error: 'Invalid action' }, 400);
}
