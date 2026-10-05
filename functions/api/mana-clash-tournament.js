/* ══════════════════════════════════════════════
   MANA CLASH — BRACKET NIGHT (single-elimination tournament)

   A broadcaster-run stream event. Players sign up, the host generates a
   single-elimination bracket, and each match is a REAL Mana Clash versus room
   (seeded with the two players, marked as a tournament match). When a match
   room finishes, mana-clash.js settle() reports the winner here and the bracket
   advances; the host can also report a winner by hand for a no-show.

   ONE SINGLETON, `mana_clash_tournament`, registered in server/lib/registry.js
   as a singleton with a real TTL that every write slides forward — a bracket
   nobody ends clears itself off the overlay rather than lingering.

   Match rooms are made by mana-clash.js's exported seedTournamentMatch (the one
   place that knows the room shape), linked back here by their {round, match}
   position. Tournament matches are UNRANKED (unrankedReason 'tournament'), so a
   bracket cannot be used to farm the monthly prize boards.
   ══════════════════════════════════════════════ */

export const TOURNEY_KEY = 'mana_clash_tournament';
const TOURNEY_TTL = 21600;        // 6h sliding backstop
const MAX_PLAYERS = 32;
const STREAM_NOW_GAME = 'mana-clash';

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

/* ══ Bracket math ═════════════════════════════════════════════════════════ */

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }

/* All rounds as shells, round 0 populated from the (shuffled, bye-padded)
   seeds. Byes resolve immediately. Pure given the shuffled seed order. */
export function generateBracket(players) {
  const seeds = shuffle(players.slice());
  const size = Math.max(2, nextPow2(seeds.length));
  while (seeds.length < size) seeds.push(null);

  const rounds = [];
  let count = size / 2;
  const r0 = [];
  for (let j = 0; j < count; j++) {
    const a = seeds[2 * j] || null;
    const b = seeds[2 * j + 1] || null;
    const m = { a, b, winner: null, code: null, bye: false };
    if (a && !b) { m.winner = a.id; m.bye = true; }
    else if (b && !a) { m.winner = b.id; m.bye = true; }
    else if (!a && !b) { m.winner = null; m.bye = true; }   // empty slot
    r0.push(m);
  }
  rounds.push(r0);
  count = Math.floor(count / 2);
  while (count >= 1) {
    const rr = [];
    for (let j = 0; j < count; j++) rr.push({ a: null, b: null, winner: null, code: null, bye: false });
    rounds.push(rr);
    count = Math.floor(count / 2);
  }

  /* Push any round-0 bye winners into round 1 so the next round shows who
     already advanced. */
  propagateRound(rounds, 0);
  return rounds;
}

function playerById(state, id) {
  return (state.players || []).find(p => p.id === id) || null;
}

/* Slot each decided winner of round r into round r+1. Match j feeds match
   floor(j/2), side a when j is even, side b when j is odd. */
function propagateRound(rounds, r) {
  const cur = rounds[r];
  const next = rounds[r + 1];
  if (!next) return;
  for (let j = 0; j < cur.length; j++) {
    const w = cur[j].winner;
    if (!w) continue;
    const who = typeof w === 'string'
      ? ((cur[j].a && cur[j].a.id === w) ? cur[j].a : (cur[j].b && cur[j].b.id === w ? cur[j].b : { id: w, name: w }))
      : w;
    const slot = next[Math.floor(j / 2)];
    if (j % 2 === 0) slot.a = who; else slot.b = who;
  }
  /* A bye advancing into a round where its opponent slot is also a bye should
     itself auto-resolve, so cascading byes don't stall a sparse bracket. */
  for (const m of next) {
    if (m.winner) continue;
    if (m.a && !m.b && isByeOpponentResolved(rounds, r + 1, m, 'b')) { m.winner = m.a.id; m.bye = true; }
  }
}

/* A next-round slot stays empty only because the feeding match is a real match
   still to be played; if that feeding match was itself an empty bye, the slot
   will never fill, so a lone player there is a bye. */
function isByeOpponentResolved(rounds, r, match, emptySide) {
  const idx = rounds[r].indexOf(match);
  const prev = rounds[r - 1];
  if (!prev) return false;
  const feederIndex = idx * 2 + (emptySide === 'a' ? 0 : 1);
  const feeder = prev[feederIndex];
  return !!(feeder && feeder.bye && !feeder.a && !feeder.b);
}

function roundComplete(rounds, r) {
  return rounds[r].every(m => m.winner || (!m.a && !m.b));
}

function matchesNeedingPlay(rounds, r) {
  return rounds[r].filter(m => !m.winner && m.a && m.b);
}

/* Record a winner for one match and cascade it forward. Idempotent. */
export function setMatchWinner(state, r, j, winnerId) {
  const m = state.rounds[r] && state.rounds[r][j];
  if (!m || m.winner) return false;
  if (!(m.a && m.a.id === winnerId) && !(m.b && m.b.id === winnerId)) return false;
  m.winner = winnerId;
  propagateRound(state.rounds, r);
  /* Champion: a winner in the last round ends it. */
  if (r === state.rounds.length - 1) {
    state.champion = playerById(state, winnerId) ||
      (m.a && m.a.id === winnerId ? m.a : m.b);
    state.status = 'done';
  }
  return true;
}

/* ══ Public view ══════════════════════════════════════════════════════════ */

export function publicTournament(state, userId = null) {
  if (!state || !state.status || state.status === 'idle') return { status: 'none' };
  const view = {
    status: state.status,
    by: state.by || null,
    round: state.round || 0,
    totalRounds: state.rounds ? state.rounds.length : 0,
    playerCount: (state.players || []).length,
    players: (state.players || []).map(p => ({ name: p.name })),
    rounds: (state.rounds || []).map(rd => rd.map(m => ({
      a: m.a ? { name: m.a.name } : null,
      b: m.b ? { name: m.b.name } : null,
      winnerName: m.winner ? ((m.a && m.a.id === m.winner) ? m.a.name : (m.b && m.b.id === m.winner ? m.b.name : null)) : null,
      live: !!(m.code && !m.winner),
      bye: !!m.bye,
    }))),
    champion: state.champion ? { name: state.champion.name } : null,
  };
  if (userId) {
    view.youJoined = (state.players || []).some(p => p.id === userId);
    /* Alive = joined and never lost a decided match. Lets the splash tell
       "advanced, waiting for the next round" from "knocked out". */
    const lost = (state.rounds || []).some(rd => rd.some(m =>
      m.winner && ((m.a && m.a.id === userId) || (m.b && m.b.id === userId)) && m.winner !== userId));
    view.youAlive = view.youJoined && !lost;
    /* Your current, unplayed match this round — the splash uses this to offer
       a "join your match" button with the room code. */
    const rd = state.rounds && state.rounds[state.round];
    let yourMatch = null;
    if (rd) {
      for (const m of rd) {
        if (m.winner) continue;
        if ((m.a && m.a.id === userId) || (m.b && m.b.id === userId)) {
          const opp = (m.a && m.a.id === userId) ? m.b : m.a;
          yourMatch = { code: m.code || null, opponent: opp ? opp.name : null, ready: !!m.code };
          break;
        }
      }
    }
    view.yourMatch = yourMatch;
  }
  return view;
}

/* ══ Called by mana-clash.js settle() when a tournament match room finishes ═ */
export async function reportTournamentMatch(env, ref, winnerId) {
  if (!env || !env.MARKETPLACE || !ref || !winnerId) return;
  await env.MARKETPLACE.mutate(TOURNEY_KEY, (state) => {
    if (!state || state.status !== 'active') return undefined;
    const ok = setMatchWinner(state, ref.round, ref.match, winnerId);
    return ok ? state : undefined;
  }, { expirationTtl: TOURNEY_TTL });
}

async function refreshPointer(env, by) {
  try {
    const { refreshStreamNow } = await import('./stream-now.js');
    await refreshStreamNow(env, { game: STREAM_NOW_GAME, label: 'Bracket Night', level: by || null });
  } catch (err) { /* best effort */ }
}
async function clearPointer(env) {
  try {
    const { clearStreamNow } = await import('./stream-now.js');
    await clearStreamNow(env, STREAM_NOW_GAME);
  } catch (err) { /* best effort */ }
}

/* ══ GET — overlay + splash read the bracket ══════════════════════════════ */
export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  const state = await env.MARKETPLACE.get(TOURNEY_KEY, 'json');
  return json(publicTournament(state, session && session.user_id ? String(session.user_id) : null));
}

/* ══ POST ═════════════════════════════════════════════════════════════════
   Player action: `join` (while sign-ups are open). Everything else is a
   broadcaster/moderator control. */
export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in with Twitch first.' }, 401);
  const userId = String(session.user_id);
  const name = session.display_name || 'Player';

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  const action = body.action;

  /* ── join (players) ── */
  if (action === 'join') {
    let err = null;
    await env.MARKETPLACE.mutate(TOURNEY_KEY, (state) => {
      if (!state || state.status !== 'signups') { err = 'Sign-ups are not open.'; return undefined; }
      state.players = state.players || [];
      if (state.players.some(p => p.id === userId)) return undefined;   // already in
      if (state.players.length >= MAX_PLAYERS) { err = `The bracket is full (${MAX_PLAYERS}).`; return undefined; }
      state.players.push({ id: userId, name, avatar: session.profile_image || null });
      return state;
    }, { expirationTtl: TOURNEY_TTL });
    if (err) return json({ error: err }, 400);
    const state = await env.MARKETPLACE.get(TOURNEY_KEY, 'json');
    return json({ success: true, tournament: publicTournament(state, userId) });
  }

  if (action === 'leave') {
    await env.MARKETPLACE.mutate(TOURNEY_KEY, (state) => {
      if (!state || state.status !== 'signups') return undefined;
      state.players = (state.players || []).filter(p => p.id !== userId);
      return state;
    }, { expirationTtl: TOURNEY_TTL });
    const state = await env.MARKETPLACE.get(TOURNEY_KEY, 'json');
    return json({ success: true, tournament: publicTournament(state, userId) });
  }

  /* ── everything below is staff only ── */
  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators run the bracket.' }, 403);
  }

  if (action === 'open') {
    const state = { status: 'signups', by: name, createdAt: Date.now(), players: [], rounds: null, round: 0, champion: null };
    await env.MARKETPLACE.mutate(TOURNEY_KEY, () => state, { expirationTtl: TOURNEY_TTL });
    await refreshPointer(env, name);
    return json({ success: true, tournament: publicTournament(state, userId) });
  }

  if (action === 'generate') {
    let err = null;
    await env.MARKETPLACE.mutate(TOURNEY_KEY, (state) => {
      if (!state || state.status !== 'signups') { err = 'Open sign-ups first.'; return undefined; }
      if ((state.players || []).length < 2) { err = 'Need at least two players.'; return undefined; }
      state.rounds = generateBracket(state.players);
      state.round = 0;
      state.status = 'active';
      state.champion = null;
      return state;
    }, { expirationTtl: TOURNEY_TTL });
    if (err) return json({ error: err }, 400);
    const state = await env.MARKETPLACE.get(TOURNEY_KEY, 'json');
    await refreshPointer(env, name);
    return json({ success: true, tournament: publicTournament(state, userId) });
  }

  if (action === 'start-round') {
    /* Create a Mana Clash room for every unplayed match in the current round
       that has two real players (byes already have winners). Each room is tagged
       with its {round, match} so settle() can report the winner back here. */
    const pre = await env.MARKETPLACE.get(TOURNEY_KEY, 'json');
    if (!pre || pre.status !== 'active') return json({ error: 'No active bracket.' }, 400);
    const curRound = pre.round || 0;
    const rd = pre.rounds[curRound];
    if (!rd) return json({ error: 'No such round.' }, 400);

    const toSeed = [];
    for (let j = 0; j < rd.length; j++) {
      const m = rd[j];
      if (m.winner || m.code || !m.a || !m.b) continue;
      toSeed.push({ j, a: m.a, b: m.b });
    }

    const { seedTournamentMatch } = await import('./mana-clash.js');
    const codes = {};
    for (const s of toSeed) {
      const code = await seedTournamentMatch(env, [s.a, s.b], { round: curRound, match: s.j });
      if (code) codes[s.j] = code;
    }

    await env.MARKETPLACE.mutate(TOURNEY_KEY, (state) => {
      if (!state || state.status !== 'active') return undefined;
      const round = state.rounds[curRound];
      if (!round) return undefined;
      for (const j in codes) if (round[j]) round[j].code = codes[j];
      return state;
    }, { expirationTtl: TOURNEY_TTL });

    const state = await env.MARKETPLACE.get(TOURNEY_KEY, 'json');
    await refreshPointer(env, name);
    return json({ success: true, tournament: publicTournament(state, userId) });
  }

  if (action === 'report') {
    /* Manual winner for a no-show or dispute. The dashboard reports by SIDE
       ('a'/'b') so it never needs to handle user ids. */
    const r = Number(body.round); const j = Number(body.match);
    let err = null;
    await env.MARKETPLACE.mutate(TOURNEY_KEY, (state) => {
      if (!state || state.status !== 'active') { err = 'No active bracket.'; return undefined; }
      const m = state.rounds[r] && state.rounds[r][j];
      if (!m) { err = 'No such match.'; return undefined; }
      const winnerId = body.side === 'a' ? (m.a && m.a.id)
        : body.side === 'b' ? (m.b && m.b.id)
        : String(body.winnerId || '');
      const ok = winnerId && setMatchWinner(state, r, j, winnerId);
      if (!ok) { err = 'That is not a valid winner for that match.'; return undefined; }
      return state;
    }, { expirationTtl: TOURNEY_TTL });
    if (err) return json({ error: err }, 400);
    const state = await env.MARKETPLACE.get(TOURNEY_KEY, 'json');
    return json({ success: true, tournament: publicTournament(state, userId) });
  }

  if (action === 'advance') {
    let err = null;
    await env.MARKETPLACE.mutate(TOURNEY_KEY, (state) => {
      if (!state || state.status !== 'active') { err = 'No active bracket.'; return undefined; }
      if (!roundComplete(state.rounds, state.round)) { err = 'This round is not finished.'; return undefined; }
      if (state.round >= state.rounds.length - 1) { err = 'The bracket is already at the final.'; return undefined; }
      state.round += 1;
      return state;
    }, { expirationTtl: TOURNEY_TTL });
    if (err) return json({ error: err }, 400);
    const state = await env.MARKETPLACE.get(TOURNEY_KEY, 'json');
    await refreshPointer(env, name);
    return json({ success: true, tournament: publicTournament(state, userId) });
  }

  if (action === 'end') {
    await env.MARKETPLACE.mutate(TOURNEY_KEY, () => ({ status: 'idle', endedAt: Date.now() }), { expirationTtl: 60 });
    await clearPointer(env);
    return json({ success: true });
  }

  return json({ error: 'Invalid action' }, 400);
}
