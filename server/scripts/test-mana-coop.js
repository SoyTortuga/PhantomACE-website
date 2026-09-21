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
import { onRequestPost, viewFor } from '../../functions/api/mana-clash.js';

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
    lastDealt: 0, lastAttack: 0, log: [], weakColor: 6, carryover: 0,
    boons: { dmgMult: 0, poisonMult: 0, healMult: 0, roundsBonus: 0, soakReduce: 0, secondWind: false, secondWindUsed: false, taken: [] },
    awaitingBoon: false, pendingBoons: null,
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

/* ══ Clearing an enemy offers a boon, which then advances the wave ══════ */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom({ coop: { enemyHp: 100, enemyMaxHp: 100 } }, { pending: 100 }) }) };
  const view = await (await POST(e, { action: 'bank', code: 'AAAA' })).json();
  let room = e.MARKETPLACE.read('mc_room_AAAA');
  check('clearing counts the clear', room.coop.cleared, 1);
  check('the wave pauses for a boon (not yet advanced)', room.coop.wave, 1);
  ok('a boon choice is offered', room.coop.awaitingBoon === true && room.coop.pendingBoons.length === 3);
  ok('the view carries the boon choice', view.room.coop.awaitingBoon && view.room.coop.pendingBoons.length === 3);

  const pick = room.coop.pendingBoons[0].id;
  await POST(e, { action: 'choose-boon', code: 'AAAA', boon: pick });
  room = e.MARKETPLACE.read('mc_room_AAAA');
  check('choosing a boon advances the wave', room.coop.wave, 2);
  ok('the boon is banked on the run', room.coop.boons.taken.includes(pick));
  check('the next enemy has fresh health', room.coop.enemyHp, room.coop.enemyMaxHp);
  check('the room is between waves', room.status, 'intermission');
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
  check('a White trio heals the team (attack 0 here)', room.coop.teamHp, 65); // +25
}

/* Blue (3): a banked trio is a net gain — the round isn't spent, and each trio
   adds one, so the counter climbs (not cancelled by the round spend). */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, roundsLeft: 3 } },
    { pending: 100, kept: [3, 3, 3, 3, 3, 3], done: null }) }) }; // two Blue trios → +2, no spend
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('two Blue trios raise the counter by two (round not spent)', room.coop.roundsLeft, 5);
}

/* A single Blue trio nets +1 to the visible counter (was previously cancelled). */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, roundsLeft: 4 } },
    { pending: 100, kept: [3, 3, 3], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('one Blue trio nets +1 round', room.coop.roundsLeft, 5);
}

/* Blue on a Blue-weak enemy is doubled — +2 from a single trio. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, roundsLeft: 4, weakColor: 3 } },
    { pending: 100, kept: [3, 3, 3], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('a Blue trio on a Blue-weak enemy nets +2', room.coop.roundsLeft, 6);
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

/* ══ REAL dice are LETTER faces — colour trios must register from them ══ */
{
  // Kept dice are stored as 'C','W','U','B','R','G' in the live game, not 1-6.
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, weakColor: 6 } },
    { pending: 100, kept: ['B', 'B', 'B'], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('letter-face dice register as colour trios (Black → poison)', room.coop.poison, 1);
}

/* Full flow: create → start → roll (forced W,W,W,U,B,G) → keep the Whites →
   bank, against the real wave-1 White-weak enemy. Proves the whole path. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopLobby(1) }) };
  await POST(e, { action: 'start-game', code: 'AAAA' }, cookie('p1'));
  let room = e.MARKETPLACE.read('mc_room_AAAA');
  const weak = room.coop.weakColor, maxHp = room.coop.enemyMaxHp;
  const realRandom = Math.random;
  const queue = [0.17, 0.17, 0.17, 0.34, 0.51, 0.84];   // → indices 1,1,1,2,3,5 = W,W,W,U,B,G
  let qi = 0;
  Math.random = () => (qi < queue.length ? queue[qi++] : realRandom());
  await POST(e, { action: 'roll', code: 'AAAA' }, cookie('p1'));
  Math.random = realRandom;
  room = e.MARKETPLACE.read('mc_room_AAAA');
  const dice = room.players.p1.turn.dice;
  const wIdx = dice.map((d, i) => (d === 'W' ? i : -1)).filter(i => i >= 0).slice(0, 3);
  ok('the forced roll produced three Whites to keep', wIdx.length === 3);
  await POST(e, { action: 'keep', code: 'AAAA', indices: wIdx }, cookie('p1'));
  await POST(e, { action: 'bank', code: 'AAAA' }, cookie('p1'));
  room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('wave 1 is White-weak', weak === 2);
  // 200 (White triple) + weakness bonus (6% of maxHp) torn off the enemy.
  check('the real keep→bank flow lands the weak-White bonus damage',
    room.coop.enemyHp, maxHp - (200 + Math.ceil(maxHp * 0.06)));
}

/* ══ Weakness — the weak colour's effect lands doubled ═════════════════ */
{
  // Black weakness (face 4) + one banked Black trio → 2 poison, not 1.
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, weakColor: 4 } },
    { pending: 100, kept: [4, 4, 4], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('a trio of the weak colour is doubled', room.coop.poison, 2);
}

/* Weakness also tears off bonus damage AND doubles the effect, together —
   White-weak enemy, banked White trio, attack 0 to read team HP cleanly. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, weakColor: 2, teamHp: 40, teamMaxHp: 100, enemyAttack: 0 } },
    { pending: 100, kept: [2, 2, 2], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  // 100 banked + weakness bonus (6% of 10000 = 600) = 700 damage.
  check('weakness deals bonus damage', room.coop.enemyHp, 9300);
  // White heal doubled by the weakness: 2 trios-worth × 25 = 50.
  check('and the White effect is doubled', room.coop.teamHp, 90);
}

/* Two different colour trios in one bank both fire (kept = a Black + a Red
   triple). Minions present so Red Burn has something to land on. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, minions: { hp: 2000, maxHp: 2000, count: 2 } } },
    { pending: 100, kept: [4, 4, 4, 5, 5, 5], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('a Black trio in a multi-colour bank poisons', room.coop.poison, 1);
  check('and the Red trio in the same bank burns', room.coop.burn, 1);
}

/* ══ Overkill carries a share into the next enemy ══════════════════════ */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 100, enemyMaxHp: 100 } },
    { pending: 300, kept: [], done: null }) }) }; // 200 overkill → 100 carried (50%)
  await POST(e, { action: 'bank', code: 'AAAA' });
  let room = e.MARKETPLACE.read('mc_room_AAAA');
  check('overkill is banked for the next enemy', room.coop.carryover, 100);
  const pick = room.coop.pendingBoons[0].id;
  await POST(e, { action: 'choose-boon', code: 'AAAA', boon: pick });
  room = e.MARKETPLACE.read('mc_room_AAAA');
  check('the next enemy spawns already wounded by the spill', room.coop.enemyHp, room.coop.enemyMaxHp - 100);
  check('and the carry is spent', room.coop.carryover, 0);
}

/* ══ Telegraph — the view previews the next incoming hit ═══════════════ */
{
  const room = coopRoom({ coop: { enemyHp: 10000, enemyMaxHp: 10000, enemyAttack: 12, roundsLeft: 5 } });
  const v = viewFor(room, '7', Date.now());
  check('the view telegraphs the next attack', v.coop.nextAttack, 12);
  ok('and flags no enrage yet', v.coop.willEnrage === false);
  // Cornered on rounds → the telegraph shows the enraged figure.
  const room2 = coopRoom({ coop: { enemyHp: 10000, enemyMaxHp: 10000, enemyAttack: 12, roundsLeft: 2 } });
  const v2 = viewFor(room2, '7', Date.now());
  check('a cornered enemy telegraphs an enraged hit', v2.coop.nextAttack, 21); // 12 * 1.75
  ok('and flags the enrage', v2.coop.willEnrage === true);
}

/* ══ Second Wind cheats death once ═════════════════════════════════════ */
{
  const seed = coopRoom(
    { coop: { enemyHp: 100000, enemyMaxHp: 100000, teamHp: 5, teamMaxHp: 100, enemyAttack: 50, roundsLeft: 5 } },
    { pending: 100, kept: [], done: null });
  seed.coop.boons = { dmgMult: 0, poisonMult: 0, healMult: 0, roundsBonus: 0, soakReduce: 0, secondWind: 2, taken: ['wind', 'wind'] };
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: seed }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('Second Wind keeps the run alive', room.status !== 'finished' && room.coop.teamHp === 40);
  check('one charge is spent, the other remains (stacks)', room.coop.boons.secondWind, 1);
}

/* ══ Second Wind also cheats a round-timeout, not just a wipe ══════════ */
{
  const seed = coopRoom(
    // Team HP is comfortably safe; only the round budget is about to run out.
    { coop: { enemyHp: 100000, enemyMaxHp: 100000, teamHp: 200, teamMaxHp: 200, enemyAttack: 1, roundsLeft: 1 } },
    { pending: 100, kept: [], done: null });
  seed.coop.boons = { dmgMult: 0, poisonMult: 0, healMult: 0, roundsBonus: 0, soakReduce: 0, secondWind: 1, taken: ['wind'] };
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: seed }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('Second Wind keeps the run alive on a timeout', room.status !== 'finished');
  check('and grants a fresh block of rounds', room.coop.roundsLeft, 3);
  check('the charge is spent', room.coop.boons.secondWind, 0);
}

/* ══ Without a charge, a round-timeout still ends the run as before ═══ */
{
  const room0 = coopRoom(
    { coop: { enemyHp: 100000, enemyMaxHp: 100000, teamHp: 200, teamMaxHp: 200, enemyAttack: 1, roundsLeft: 1 } },
    { pending: 100, kept: [], done: null });
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: room0 }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('no charge, no save — the run ends on timeout', room.status === 'finished' && room.runOver === true);
}

/* ══ A double failure in one round can cheat both, if charges allow ════ */
{
  const seed = coopRoom(
    // Enough incoming damage to wipe the team AND already on the last round.
    { coop: { enemyHp: 100000, enemyMaxHp: 100000, teamHp: 5, teamMaxHp: 100, enemyAttack: 50, roundsLeft: 1 } },
    { pending: 100, kept: [], done: null });
  seed.coop.boons = { dmgMult: 0, poisonMult: 0, healMult: 0, roundsBonus: 0, soakReduce: 0, secondWind: 2, taken: ['wind', 'wind'] };
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: seed }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('both the wipe and the timeout are cheated', room.status !== 'finished');
  check('team HP is revived', room.coop.teamHp, 40);
  check('and a fresh round block is granted', room.coop.roundsLeft, 3);
  check('both charges are spent', room.coop.boons.secondWind, 0);
}

/* ══ Enemies scale with the party ══════════════════════════════════════ */

/* A co-op lobby of `n` ready players, host = p1, ready to start. */
function coopLobby(n) {
  const now = Date.now();
  const players = {};
  for (let i = 1; i <= n; i++) players['p' + i] = { displayName: 'P' + i, profileImage: null, ready: true, total: 0, turn: null };
  return {
    code: 'AAAA', host: 'p1', hostName: 'P1', mode: 'coop', practice: false, goal: 0, idleMs: 30000,
    status: 'lobby', round: 0, roundStartedAt: now, isFinalRound: false, nextIsFinal: false,
    tiedPlayers: null, restingIds: [], intermissionEndsAt: null, winner: null, players, createdAt: now,
  };
}
async function startedCoop(n) {
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopLobby(n) }) };
  await POST(e, { action: 'start-game', code: 'AAAA' }, cookie('p1'));
  return e.MARKETPLACE.read('mc_room_AAAA').coop;
}
{
  const solo = await startedCoop(1);
  const trio = await startedCoop(3);
  // Wave-1 enemy HP: solo ×1.0, +0.8 per extra player → 3p = ×2.6, near-linear.
  check('solo wave-1 enemy HP', solo.enemyMaxHp, 1500);
  check('3-player wave-1 enemy HP scales ~linearly', trio.enemyMaxHp, 3900);
  ok('a bigger party faces far more enemy HP', trio.enemyMaxHp / solo.enemyMaxHp === 2.6);
  // Attack scales too (5 base × [0.7 + 0.3·players]).
  check('solo enemy attack', solo.enemyAttack, 5);
  check('3-player enemy attack is higher', trio.enemyAttack, 8);
  // Shared team pool grows +50 per extra player.
  check('solo team pool', solo.teamMaxHp, 100);
  check('3-player team pool', trio.teamMaxHp, 200);
  // A normal enemy gives a workable round budget (not the old cramped 3).
  check('a normal enemy gives 5 rounds', solo.roundsLeft, 5);
}

/* ══ New boons: Bulwark, Conscripts, Regeneration ══════════════════════ */
function boonsWith(over) {
  return Object.assign({ dmgMult: 0, poisonMult: 0, healMult: 0, roundsBonus: 0, soakReduce: 0,
    secondWind: 0, dmgTakenMult: 1, allyPct: 0, regen: 0, taken: [] }, over);
}
{
  // Bulwark: incoming attack scaled by dmgTakenMult (0.5 here → 20 becomes 10).
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 100000, enemyMaxHp: 100000, enemyAttack: 20, teamHp: 100, teamMaxHp: 100, roundsLeft: 5, boons: boonsWith({ dmgTakenMult: 0.5, taken: ['bulwark'] }) } },
    { pending: 100, kept: [], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('Bulwark softens the incoming hit', room.coop.lastAttack, 10);
}
{
  // Conscripts: allies add 3% of enemy max HP each round (300 here), on top of banked damage.
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, boons: boonsWith({ allyPct: 0.03, taken: ['army'] }) } },
    { pending: 100, kept: [], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('Conscripts add ally damage each round', room.coop.enemyHp, 9600); // 100 banked + 300 ally
}
{
  // Regeneration: +8 team HP each round (attack 0 to read it cleanly).
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 100000, enemyMaxHp: 100000, enemyAttack: 0, teamHp: 50, teamMaxHp: 100, roundsLeft: 5, boons: boonsWith({ regen: 8, taken: ['regen'] }) } },
    { pending: 100, kept: [], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('Regeneration heals each round', room.coop.teamHp, 58);
}

/* ══ Boon voting — resolves once everyone has voted, majority wins ══════ */

/* A co-op room mid-boon-vote for the given players (all clear/banked). */
function coopVoteRoom(ids) {
  const now = Date.now();
  const players = {};
  for (const id of ids) players[id] = { displayName: 'U' + id, profileImage: null, ready: true, total: 0,
    turn: { done: 'banked', gained: 0, kept: [], pending: 0, dice: [], remaining: 6, awaitingSelection: false, deadline: null, event: null } };
  return {
    code: 'AAAA', host: ids[0], hostName: 'U' + ids[0], mode: 'coop', practice: false, goal: 0, idleMs: 30000,
    status: 'intermission', round: 1, roundStartedAt: now, isFinalRound: false, nextIsFinal: false,
    tiedPlayers: null, restingIds: [], intermissionEndsAt: null, winner: null, players, createdAt: now,
    coop: {
      cleared: 1, wave: 1, enemyName: 'X', enemyMaxHp: 1000, enemyHp: 0, roundsLeft: 5,
      isBoss: false, isFinal: false, teamHp: 100, teamMaxHp: 100, teamHpBonus: 0,
      poison: 0, burn: 0, shieldRounds: 0, dmgBuffRounds: 0, minions: { hp: 0, maxHp: 0, count: 0 },
      summonedThresholds: [], roundsThisEnemy: 0, weakColor: 6, carryover: 0, log: [],
      boons: { dmgMult: 0, poisonMult: 0, healMult: 0, roundsBonus: 0, soakReduce: 0, secondWind: 0, taken: [] },
      awaitingBoon: true, boonVotes: {},
      pendingBoons: [
        { id: 'zeal', name: 'Zealotry', desc: '' },
        { id: 'vigor', name: 'Vigor', desc: '' },
        { id: 'slayer', name: 'Giant Slayer', desc: '' },
      ],
    },
  };
}

/* One vote in a two-player room doesn't resolve; the second does. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopVoteRoom(['p1', 'p2']) }) };
  const v1 = await (await POST(e, { action: 'choose-boon', code: 'AAAA', boon: 'zeal' }, cookie('p1'))).json();
  let room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('one vote of two does not resolve', room.coop.awaitingBoon === true);
  check('the tally shows the pending vote', v1.room.coop.boonVotes.zeal, 1);
  check('and reports one vote cast', v1.room.coop.votesCast, 1);

  await POST(e, { action: 'choose-boon', code: 'AAAA', boon: 'zeal' }, cookie('p2'));
  room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('the final vote resolves the choice', room.coop.awaitingBoon === false);
  ok('the winning boon is applied', room.coop.boons.taken.includes('zeal'));
  check('and the wave advances', room.coop.wave, 2);
}

/* Majority wins: two for Vigor, one for Zealotry → Vigor. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopVoteRoom(['p1', 'p2', 'p3']) }) };
  await POST(e, { action: 'choose-boon', code: 'AAAA', boon: 'vigor' }, cookie('p1'));
  await POST(e, { action: 'choose-boon', code: 'AAAA', boon: 'zeal' }, cookie('p2'));
  await POST(e, { action: 'choose-boon', code: 'AAAA', boon: 'vigor' }, cookie('p3'));
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('the majority boon wins', room.coop.boons.taken.includes('vigor') && !room.coop.boons.taken.includes('zeal'));
}

/* A player can change their vote before it resolves. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopVoteRoom(['p1', 'p2']) }) };
  await POST(e, { action: 'choose-boon', code: 'AAAA', boon: 'zeal' }, cookie('p1'));
  await POST(e, { action: 'choose-boon', code: 'AAAA', boon: 'slayer' }, cookie('p1')); // p1 changes vote
  const v = await (await POST(e, { action: 'choose-boon', code: 'AAAA', boon: 'slayer' }, cookie('p2'))).json();
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('the changed vote is the one counted', room.coop.boons.taken.includes('slayer'));
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
