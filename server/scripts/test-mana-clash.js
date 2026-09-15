#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MANA CLASH TURN MODEL — test suite

     node server/scripts/test-mana-clash.js

   Plays real games through the real handlers. No database and no browser: a
   fake MARKETPLACE holds rooms in a Map, and the dice are made deterministic
   so a rule can be asserted rather than waited for.

   The point is the states nobody reaches by playing once by hand — an idle
   clock expiring mid-selection, a tie on the final round, the last player
   leaving mid-turn, a game finishing twice at once. Those are where a
   multiplayer room breaks, and they are miserable to reproduce live.
   ══════════════════════════════════════════════ */

import * as scoring from '../../functions/api/mana-clash-scoring.js';
import { onRequestGet, onRequestPost } from '../../functions/api/mana-clash.js';

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
function ok(label, cond) { check(label, !!cond, true); }

/* ── A KV stand-in ───────────────────────────────────────────────────────
   mutate() is modelled as what the real one guarantees: read, apply, write,
   with `undefined` meaning "write nothing". Values round-trip through JSON
   so a handler that accidentally relies on object identity across a write
   fails here rather than in production. */
function makeEnv() {
  const store = new Map();
  return {
    MARKETPLACE: {
      async get(key, type) {
        if (!store.has(key)) return null;
        const raw = store.get(key);
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      async put(key, value) { store.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
      async delete(key) { store.delete(key); },
      async mutate(key, fn) {
        const current = store.has(key) ? JSON.parse(store.get(key)) : null;
        const next = await fn(current);
        if (next === undefined) return current;
        store.set(key, JSON.stringify(next));
        return JSON.parse(store.get(key));
      },
      async listValues({ prefix }) {
        const out = [];
        for (const [name, raw] of store) if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        return out;
      },
    },
    _store: store,
  };
}

const USERS = {
  a: { user_id: '101', display_name: 'Ash' },
  b: { user_id: '202', display_name: 'Bry' },
  c: { user_id: '303', display_name: 'Cal' },
};

function cookieFor(u) {
  return `pham_session=${encodeURIComponent(JSON.stringify(USERS[u]))}`;
}

async function post(env, who, body) {
  const res = await onRequestPost({
    env,
    request: new Request('https://test.local/api/mana-clash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieFor(who) },
      body: JSON.stringify(body),
    }),
  });
  return { status: res.status, data: await res.json() };
}

async function get(env, who, qs) {
  const res = await onRequestGet({
    env,
    request: new Request(`https://test.local/api/mana-clash?${qs}`, { headers: { Cookie: cookieFor(who) } }),
  });
  return { status: res.status, data: await res.json() };
}

/* ── Loaded dice ─────────────────────────────────────────────────────────
   Math.random is queued rather than the roller replaced: ES module exports
   are read-only bindings, so reassigning scoring.rollDice throws, and a
   patch that silently failed would leave every assertion below running on
   random dice while still printing PASS.

   rollDice picks FACES[floor(random * 6)] and FACES is in value order, so a
   value v is requested by feeding (v-1)/6 plus a nudge. The real roller,
   scorer and round logic all still run. */
const realRandom = Math.random;
let randomQueue = [];
Math.random = () => (randomQueue.length ? randomQueue.shift() : realRandom());

/** Deal exactly these faces to the next roll. Digits, 1-6. */
function loadDice(hand) {
  randomQueue = [...hand].map(ch => (Number(ch) - 1) / 6 + 0.001);
}

/* Prove the stub actually reaches the handler before trusting it. */
{
  const env = makeEnv();
  const made = await post(env, 'a', { action: 'create-room', goal: 10000, idleMs: 30000, practice: true });
  const code = made.data.code;
  await post(env, 'a', { action: 'start-game', code });
  loadDice('111222');
  const r = await post(env, 'a', { action: 'roll', code });
  check('loaded dice reach the handler', r.data.room.you.pending, 2500);
  check('and are read as two triplets, not six singles', r.data.room.you.event, 'clash');
}

/* ── Making time pass ────────────────────────────────────────────────────
   Deadlines are moved into the past in the store, rather than sleeping. The
   handler resolves them on the next request either way, which is the whole
   point of resolving time lazily. */

function expireTurn(env, code, userId) {
  const key = 'mc_room_' + code;
  const room = JSON.parse(env._store.get(key));
  room.players[userId].turn.deadline = Date.now() - 1;
  env._store.set(key, JSON.stringify(room));
}

function endIntermission(env, code) {
  const key = 'mc_room_' + code;
  const room = JSON.parse(env._store.get(key));
  room.intermissionEndsAt = Date.now() - 1;
  env._store.set(key, JSON.stringify(room));
}

/* ── Room setup ──────────────────────────────────────────────────────── */

async function newRoom(env, { goal = 10000, idleMs = 30000, practice = false } = {}) {
  const r = await post(env, 'a', { action: 'create-room', goal, idleMs, practice });
  return r.data.code;
}

{
  const env = makeEnv();
  const bad = await post(env, 'a', { action: 'create-room', goal: 7777, idleMs: 30000 });
  check('goal must be one of the three', bad.status, 400);
  const bad2 = await post(env, 'a', { action: 'create-room', goal: 10000, idleMs: 5000 });
  check('idle timer must be one of the three', bad2.status, 400);
}

{
  /* Login is required, and the refusal must be a 401 rather than a room
     joined by a nameless player. */
  const env = makeEnv();
  const res = await onRequestPost({
    env,
    request: new Request('https://test.local/api/mana-clash', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create-room', goal: 10000, idleMs: 30000 }),
    }),
  });
  check('anonymous cannot create a room', res.status, 401);
}

/* ── Rolling, keeping, banking ───────────────────────────────────────── */

{
  const env = makeEnv();
  const code = await newRoom(env, { practice: true });
  await post(env, 'a', { action: 'start-game', code });

  loadDice('112346');
  let r = await post(env, 'a', { action: 'roll', code });
  check('scorable mask reaches the client', r.data.room.you.scorable, [true, true, false, false, false, false]);
  ok('awaiting a selection after a scoring roll', r.data.room.you.awaitingSelection);
  check('cannot roll again before keeping', (await post(env, 'a', { action: 'roll', code })).status, 400);
  check('cannot bank before keeping', (await post(env, 'a', { action: 'bank', code })).status, 400);

  /* Keeping a die that contributes nothing is refused by the same scorer
     the mask came from. */
  check('cannot keep a dead die', (await post(env, 'a', { action: 'keep', code, indices: [0, 1, 2] })).status, 400);
  check('cannot keep a die that is not there', (await post(env, 'a', { action: 'keep', code, indices: [9] })).status, 400);
  check('cannot keep the same die twice', (await post(env, 'a', { action: 'keep', code, indices: [0, 0] })).status, 400);
  check('cannot keep nothing', (await post(env, 'a', { action: 'keep', code, indices: [] })).status, 400);

  r = await post(env, 'a', { action: 'keep', code, indices: [0, 1] });
  check('two 1s are 200 pending', r.data.room.you.pending, 200);
  check('four dice left to roll', r.data.room.you.remaining, 4);
  ok('can bank now', r.data.room.you.canBank);

  loadDice('5555');
  r = await post(env, 'a', { action: 'roll', code });
  check('four 5s auto-taken as a Mana Clash', r.data.room.you.event, 'clash');
  check('pending is 200 + 1000', r.data.room.you.pending, 1200);
  check('six fresh dice after a clash', r.data.room.you.remaining, 6);
  ok('no selection pending after a clash', !r.data.room.you.awaitingSelection);

  r = await post(env, 'a', { action: 'bank', code });
  check('banked total', r.data.room.players[0].total, 1200);
}

{
  /* MANA BURN takes the whole pending pile. */
  const env = makeEnv();
  const code = await newRoom(env, { practice: true });
  await post(env, 'a', { action: 'start-game', code });

  loadDice('111234');
  await post(env, 'a', { action: 'roll', code });
  let r = await post(env, 'a', { action: 'keep', code, indices: [0, 1, 2] });
  check('three 1s pending', r.data.room.you.pending, 1000);

  loadDice('2346');
  r = await post(env, 'a', { action: 'roll', code });
  check('a dead roll is a burn', r.data.room.you.event, 'burn');
  check('pending is lost', r.data.room.you.pending, 0);
  check('the turn is over', r.data.room.you.done, 'burned');
  check('nothing banked', r.data.room.players[0].total, 0);
  /* Solo, so burning ended the round too — the refusal that comes back is
     "between rounds", which is the more useful of the two answers. */
  check('cannot act after burning', (await post(env, 'a', { action: 'roll', code })).status, 409);
}

/* ── Simultaneous rounds ─────────────────────────────────────────────── */

{
  const env = makeEnv();
  const code = await newRoom(env, { goal: 5000 });
  await post(env, 'b', { action: 'join-room', code });
  check('start refused while someone is not ready',
    (await post(env, 'a', { action: 'start-game', code })).status, 400);
  await post(env, 'b', { action: 'ready', code, ready: true });
  check('start refused for a non-host',
    (await post(env, 'b', { action: 'start-game', code })).status, 403);
  const started = await post(env, 'a', { action: 'start-game', code });
  check('round 1 is playing', started.data.room.status, 'playing');

  /* One player banking does not end the round while the other is mid-turn. */
  loadDice('111111');
  await post(env, 'a', { action: 'roll', code });
  let r = await post(env, 'a', { action: 'bank', code });
  check('still playing while B has not finished', r.data.room.status, 'playing');
  check('A banked 8000', r.data.room.players.find(p => p.name === 'Ash').total, 8000);

  loadDice('555555');
  await post(env, 'b', { action: 'roll', code });
  r = await post(env, 'b', { action: 'bank', code });
  check('round ends when both are done', r.data.room.status, 'intermission');
  /* A's 8000 is past this room's 5000 goal, so one final round is armed
     rather than the game ending on the spot. */
  ok('a final round is armed once the goal is passed', r.data.room.nextIsFinal);
  ok('intermission has time on it', r.data.room.intermissionMsLeft > 0);

  check('cannot roll during the intermission', (await post(env, 'a', { action: 'roll', code })).status, 409);
}

/* ── The clock ───────────────────────────────────────────────────────── */

{
  const env = makeEnv();
  const code = await newRoom(env, { idleMs: 10000 });
  await post(env, 'b', { action: 'join-room', code });
  await post(env, 'b', { action: 'ready', code });
  await post(env, 'a', { action: 'start-game', code });

  loadDice('111234');
  await post(env, 'a', { action: 'roll', code });
  await post(env, 'a', { action: 'keep', code, indices: [0, 1, 2] });

  /* A's clock expires holding 1000. Expiry banks it rather than taking it. */
  expireTurn(env, code, '101');
  let r = await get(env, 'b', `action=get-state&code=${code}`);
  const ash = r.data.players.find(p => p.name === 'Ash');
  check('an expired clock banks what was held', ash.total, 1000);
  check('and ends that turn', ash.done, 'timeout');

  /* Acting resets the clock, so B is untouched. */
  check('B is still live', r.data.you.done, null);

  loadDice('555555');
  await post(env, 'b', { action: 'roll', code });
  r = await post(env, 'b', { action: 'bank', code });
  check('round closed once B finished', r.data.room.status, 'intermission');

  /* The intermission elapsing starts the next round, on a poll, with no
     scheduler anywhere. */
  endIntermission(env, code);
  r = await get(env, 'a', `action=get-state&code=${code}`);
  check('the next round starts on its own', r.data.status, 'playing');
  check('round 2', r.data.round, 2);
  check('totals carry over', r.data.players.find(p => p.name === 'Ash').total, 1000);
  check('pending is reset', r.data.you.pending, 0);
  check('six dice again', r.data.you.remaining, 6);
}

/* ── A poll that changes nothing must not write ──────────────────────── */

{
  const env = makeEnv();
  const code = await newRoom(env, { practice: true });
  await post(env, 'a', { action: 'start-game', code });
  const before = env._store.get('mc_room_' + code);
  for (let i = 0; i < 20; i++) await get(env, 'a', `action=get-state&code=${code}`);
  check('twenty idle polls leave the room byte-identical', env._store.get('mc_room_' + code), before);
}

/* ── Finishing, ties, and the boards ─────────────────────────────────── */

async function playToFinish(env, code, hands) {
  /* Each entry is [who, sixDiceString] — roll it, keep everything that
     scores by banking the whole hand. Used to drive totals deterministically. */
  for (const [who, hand] of hands) {
    loadDice(hand);
    await post(env, who, { action: 'roll', code });
    const state = await get(env, who, `action=get-state&code=${code}`);
    if (state.data.you.awaitingSelection) {
      const mask = state.data.you.scorable;
      const idx = mask.map((m, i) => (m ? i : -1)).filter(i => i >= 0);
      await post(env, who, { action: 'keep', code, indices: idx });
    }
    await post(env, who, { action: 'bank', code });
  }
}

{
  const env = makeEnv();
  const code = await newRoom(env, { goal: 10000 });
  await post(env, 'b', { action: 'join-room', code });
  await post(env, 'b', { action: 'ready', code });
  await post(env, 'a', { action: 'start-game', code });

  /* Round 1 — A 8000, B 4800. Nobody is near the goal. */
  await playToFinish(env, code, [['a', '111111'], ['b', '666666']]);
  endIntermission(env, code);
  let r = await get(env, 'a', `action=get-state&code=${code}`);
  check('round 2 is an ordinary round', r.data.isFinalRound, false);
  check('nobody has crossed the goal', r.data.players.every(p => p.total < 10000), true);

  /* Round 2 — A reaches 16000 and crosses. B is on 9600, still short. */
  await playToFinish(env, code, [['a', '111111'], ['b', '666666']]);
  endIntermission(env, code);
  r = await get(env, 'a', `action=get-state&code=${code}`);
  check('A crossed the goal', r.data.players.find(p => p.name === 'Ash').total >= 10000, true);
  check('B has not', r.data.players.find(p => p.name === 'Bry').total < 10000, true);
  ok('crossing the goal arms a final round', r.data.isFinalRound);
  check('the game is still running', r.data.status, 'playing');

  /* The final round — B, who was behind, takes 8000 and overtakes. That is
     the point of the rule: crossing the goal first does not win the game,
     and being last to act is not a disadvantage. */
  await playToFinish(env, code, [['a', '234566'], ['b', '111111']]);
  r = await get(env, 'a', `action=get-state&code=${code}`);
  check('the game is finished', r.data.status, 'finished');

  const totals = Object.fromEntries(r.data.players.map(p => [p.name, p.total]));
  check('B overtook A in the final round', totals.Bry > totals.Ash, true);
  check('and B won', r.data.players.find(p => p.id === r.data.winner).name, 'Bry');

  /* Ranked, so both boards were written — by the server, from the room. */
  const wins = await env.MARKETPLACE.get('lb_mana_clash_wins', 'json');
  const high = await env.MARKETPLACE.get('lb_mana_clash', 'json');
  check('one win recorded', wins.length, 1);
  check('the winner got it', wins[0].name, 'Bry');
  check('every player reached the high-score board', high.length, 2);
  check('high score is the best final total', high[0].score, Math.max(totals.Ash, totals.Bry));
  check('the loser is on it too', high.some(e => e.name === 'Ash'), true);

  /* Polling a finished game repeatedly must not keep crediting wins. */
  for (let i = 0; i < 5; i++) await get(env, 'a', `action=get-state&code=${code}`);
  check('a finished game is recorded once', (await env.MARKETPLACE.get('lb_mana_clash_wins', 'json'))[0].score, 1);
}

{
  /* A tie on the final round plays one more round among only the tied. */
  const env = makeEnv();
  const code = await newRoom(env, { goal: 5000 });
  await post(env, 'b', { action: 'join-room', code });
  await post(env, 'c', { action: 'join-room', code });
  await post(env, 'b', { action: 'ready', code });
  await post(env, 'c', { action: 'ready', code });
  await post(env, 'a', { action: 'start-game', code });

  /* A and B both take 8000; C takes 4800 and is out of the running. */
  await playToFinish(env, code, [['a', '111111'], ['b', '111111'], ['c', '666666']]);
  endIntermission(env, code);
  let r = await get(env, 'a', `action=get-state&code=${code}`);
  ok('the final round is armed', r.data.isFinalRound);

  /* Everyone burns, so the totals stand and A and B are still level. */
  for (const who of ['a', 'b', 'c']) {
    loadDice('223466');
    await post(env, who, { action: 'roll', code });
  }
  r = await get(env, 'a', `action=get-state&code=${code}`);
  check('a tie does not finish the game', r.data.status, 'intermission');
  check('only the tied leaders play on', r.data.tiedPlayers.length, 2);

  endIntermission(env, code);
  r = await get(env, 'c', `action=get-state&code=${code}`);
  check('the tiebreak round is playing', r.data.status, 'playing');
  check('C sits it out', r.data.you.done, 'out');
  check('C cannot roll in a round they are not in',
    (await post(env, 'c', { action: 'roll', code })).status, 400);

  /* A pulls ahead and the game ends. */
  loadDice('111111');
  await post(env, 'a', { action: 'roll', code });
  await post(env, 'a', { action: 'bank', code });
  loadDice('223466');
  await post(env, 'b', { action: 'roll', code });

  r = await get(env, 'a', `action=get-state&code=${code}`);
  check('the tiebreak decides it', r.data.status, 'finished');
  check('A won', r.data.players.find(p => p.id === r.data.winner).name, 'Ash');

  /* A 5000-point game is not ranked, so no board was touched. */
  check('an unranked game does not reach the wins board',
    await env.MARKETPLACE.get('lb_mana_clash_wins', 'json'), null);
}

{
  /* Practice never reaches a board, even at the ranked goal. */
  const env = makeEnv();
  const code = await newRoom(env, { goal: 10000, practice: true });
  await post(env, 'a', { action: 'start-game', code });
  let guard = 0;
  while (guard++ < 40) {
    const s = await get(env, 'a', `action=get-state&code=${code}`);
    if (s.data.status === 'finished') break;
    if (s.data.status === 'intermission') { endIntermission(env, code); continue; }
    loadDice('111111');
    await post(env, 'a', { action: 'roll', code });
    await post(env, 'a', { action: 'bank', code });
  }
  const s = await get(env, 'a', `action=get-state&code=${code}`);
  check('the solo game finished', s.data.status, 'finished');
  check('practice is not ranked', s.data.ranked, false);
  check('practice does not reach the wins board',
    await env.MARKETPLACE.get('lb_mana_clash_wins', 'json'), null);
  check('practice does not reach the high-score board',
    await env.MARKETPLACE.get('lb_mana_clash', 'json'), null);
}

/* ── Host powers and leaving ─────────────────────────────────────────── */

{
  const env = makeEnv();
  const code = await newRoom(env);
  await post(env, 'b', { action: 'join-room', code });
  check('a non-host cannot kick', (await post(env, 'b', { action: 'kick', code, userId: '101' })).status, 403);
  check('the host cannot kick themselves', (await post(env, 'a', { action: 'kick', code, userId: '101' })).status, 400);

  const r = await post(env, 'a', { action: 'kick', code, userId: '202' });
  check('the kicked player is gone', r.data.room.playerCount, 1);
  check('and cannot walk straight back in', (await post(env, 'b', { action: 'join-room', code })).status, 403);
}

{
  /* The host leaving hands the room to somebody still in it. */
  const env = makeEnv();
  const code = await newRoom(env);
  await post(env, 'b', { action: 'join-room', code });
  await post(env, 'a', { action: 'leave-room', code });
  const r = await get(env, 'b', `action=get-state&code=${code}`);
  check('the room survives its host leaving', r.data.playerCount, 1);
  check('and B is now the host', r.data.hostName, 'Bry');

  await post(env, 'b', { action: 'leave-room', code });
  check('the last player out deletes the room', env._store.has('mc_room_' + code), false);
}

{
  /* Leaving mid-round must not strand the round waiting on a ghost. */
  const env = makeEnv();
  const code = await newRoom(env, { goal: 5000 });
  await post(env, 'b', { action: 'join-room', code });
  await post(env, 'b', { action: 'ready', code });
  await post(env, 'a', { action: 'start-game', code });

  loadDice('111111');
  await post(env, 'a', { action: 'roll', code });
  await post(env, 'a', { action: 'bank', code });
  await post(env, 'b', { action: 'leave-room', code });

  const r = await get(env, 'a', `action=get-state&code=${code}`);
  ok('the round closed when the last live player left', r.data.status !== 'playing');
}

/* ── Room listing ────────────────────────────────────────────────────── */

{
  const env = makeEnv();
  const open = await newRoom(env, { goal: 20000 });
  await newRoom(env, { practice: true });
  const r = await get(env, 'b', 'action=list-rooms');
  check('only the joinable room is listed', r.data.length, 1);
  check('and it is the open one', r.data[0].code, open);
  check('with its goal shown', r.data[0].goal, 20000);
}

/* ── Report ──────────────────────────────────────────────────────────── */

console.log('');
if (failures.length) {
  console.log(`[mana-clash] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[mana-clash] ${passed} assertions passed.`);
console.log('');
