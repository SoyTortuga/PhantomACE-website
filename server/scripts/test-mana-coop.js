#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MANA CLASH — the co-op gauntlet

     node server/scripts/test-mana-coop.js

   A cooperative mode: one team versus a series of enemies. Banked points are
   damage; deplete an enemy within its round budget to advance to a tougher
   one, and the run ends when a round can't finish the enemy. No winner, no
   leaderboard. These tests drive the resolution deterministically by seeding
   a room mid-turn and banking a known amount, then reading the enemy state.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost } from '../../functions/api/mana-clash.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async mutate(k, fn, o) { const cur = store.has(k) ? JSON.parse(store.get(k)) : null; const out = await fn(cur); if (out === undefined) return cur; store.set(k, JSON.stringify(out)); return out; },
  };
}
const cookie = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) });
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/mana-clash', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(h || cookie('7')) }, body: JSON.stringify(body) }) });

/* A solo co-op room, mid-turn, ready for the host to bank `pending`. */
function coopRoom(over = {}, turnOver = {}) {
  const now = Date.now();
  const coop = Object.assign({
    cleared: 0, victory: false, runOver: false, lastDamage: 0, justCleared: false,
    wave: 1, enemyName: 'Bone Rattler', enemyMaxHp: 100, enemyHp: 100,
    roundsLeft: 3, isBoss: false, isFinal: false,
    teamHp: 100, teamMaxHp: 100, enemyAttack: 6, shieldEvery: 0,
    poison: 0, burn: 0, shieldRounds: 0, dmgBuffRounds: 0,
    minions: { hp: 0, maxHp: 0, count: 0 }, summonedThresholds: [], roundsThisEnemy: 0,
    lastDealt: 0, lastAttack: 0, log: [],
  }, over.coop || {});
  return Object.assign({
    code: 'AAAA', host: '7', hostName: 'U7',
    mode: 'coop', practice: false, goal: 0, idleMs: 30000,
    status: 'playing', round: 1, roundStartedAt: now,
    isFinalRound: false, nextIsFinal: false, tiedPlayers: null, restingIds: [],
    intermissionEndsAt: null, winner: null,
    players: { '7': { displayName: 'U7', profileImage: null, ready: true, total: 0,
      turn: Object.assign({ pending: 150, dice: [], kept: [], remaining: 6, awaitingSelection: false, done: null, gained: null, event: null, deadline: now + 30000 }, turnOver) } },
    coop, createdAt: now,
  }, over, over.coop ? { coop } : {});
}

/* ══ Create sets the mode and needs no goal ════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  const res = await (await POST(e, { action: 'create-room', mode: 'coop', idleMs: 30000 })).json();
  check('a co-op room is created without a goal', res.success, true);
  check('and is flagged co-op', res.mode, 'coop');
  const room = e.MARKETPLACE.read('mc_room_' + res.code);
  check('the stored room is co-op mode', room.mode, 'coop');
  check('with no point goal', room.goal, 0);
}

/* ══ Banking damages the enemy; enough clears it and advances ══════════ */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom({ coop: { enemyHp: 100, enemyMaxHp: 100 } }, { pending: 150 }) }) };
  const view = await (await POST(e, { action: 'bank', code: 'AAAA' })).json();
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('clearing an enemy advances the wave', room.coop.wave, 2);
  check('and counts the clear', room.coop.cleared, 1);
  check('the next enemy has fresh health', room.coop.enemyHp, room.coop.enemyMaxHp);
  check('the room is between waves', room.status, 'intermission');
  ok('the view carries the co-op block', view.room && view.room.coop && view.room.coop.wave === 2);
}

/* ══ Not enough damage chips the enemy and spends a round ══════════════ */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom({ coop: { enemyHp: 500, enemyMaxHp: 500, roundsLeft: 3 } }, { pending: 200 }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('damage carries across rounds', room.coop.enemyHp, 300);
  check('a round is spent', room.coop.roundsLeft, 2);
  check('and the enemy is not cleared', room.coop.cleared, 0);
}

/* ══ Running out of rounds ends the run ════════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom({ coop: { enemyHp: 100000, enemyMaxHp: 100000, roundsLeft: 1 } }, { pending: 150 }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('the run ends when rounds run out', room.status, 'finished');
  ok('flagged as a finished run, no winner', room.runOver === true && room.winner === null);
  ok('no versus leaderboard was written', !e.MARKETPLACE.read('lb_mana_clash') && !e.MARKETPLACE.read('lb_mana_clash_wins'));
}

/* ══ Colour mechanics — a banked trio drives an effect by die face ═════ */

/* Colourless (1): piercing straight damage on top of the banked points. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000 } },
    { pending: 1000, kept: [1, 1, 1], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  // 1000 banked + one Colourless trio (5% of 10000 = 500 piercing) = 1500 dealt
  check('a Colourless trio pierces for bonus damage', room.coop.enemyHp, 8500);
}

/* White (2): heals the team. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, teamHp: 40, teamMaxHp: 100, enemyAttack: 0 } },
    { pending: 100, kept: [2, 2, 2], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('a White trio heals the team (attack 0 here)', room.coop.teamHp, 52); // +12
}

/* Blue (3): adds rounds to the budget (net of the round just spent). */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, roundsLeft: 3 } },
    { pending: 100, kept: [3, 3, 3, 3, 3, 3], done: null }) }) }; // two Blue trios → +2
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('two Blue trios add two rounds, one is spent', room.coop.roundsLeft, 4);
}

/* Black (4): stacks Poison on the enemy. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000 } },
    { pending: 100, kept: [4, 4, 4], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('a Black trio poisons the enemy', room.coop.poison, 1);
}

/* Green (6): a standing buff amplifies the banked damage. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, dmgBuffRounds: 2 } },
    { pending: 400, kept: [], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('a Green buff amplifies banked damage 1.5x', room.coop.enemyHp, 9400); // 400*1.5=600
}

/* ══ Team HP is a second loss condition ════════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 100000, enemyMaxHp: 100000, teamHp: 5, enemyAttack: 20, roundsLeft: 5 } },
    { pending: 100, kept: [], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('the run ends when the team is wiped', room.status === 'finished' && room.runOver === true);
  check('team HP floors at zero', room.coop.teamHp, 0);
}

/* ══ Minions soak a share of the team's damage ═════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, minions: { hp: 1000, maxHp: 1000, count: 2 } } },
    { pending: 1000, kept: [], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('minions absorb 40% of the hit', room.coop.minions.hp, 600);
  check('the enemy takes only the remaining 60%', room.coop.enemyHp, 9400);
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const api = fs.readFileSync(path.join(REPO, 'functions/api/mana-clash.js'), 'utf8');
  ok('endRound branches to co-op resolution', /room\.mode === 'coop'\) return endRoundCoop/.test(api));
  ok('enemies scale and escalate to a final boss', /COOP_FINAL_WAVE/.test(api) && /function coopSpawn/.test(api));
  ok('co-op is not ranked (no leaderboard)', /function isRanked[\s\S]*goal === RANKED_GOAL/.test(api));

  const game = fs.readFileSync(path.join(REPO, 'games/mana-clash/index.html'), 'utf8');
  ok('the client offers co-op and shows the enemy', /coop/i.test(game));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[mana-coop] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[mana-coop] ${passed} assertions passed.`);
console.log('');
