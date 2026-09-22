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
import { onRequestPost, viewFor, coopPick, pickRandom } from '../../functions/api/mana-clash.js';

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
    awaitingBoon: false, pendingBoons: null, ultCharge: 0, ultUsed: 0,
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
  // Conscripts: allies add 1% of enemy max HP each round (100 here), on top of
  // banked damage. Bank 400 so total dealt (500) clears the 4% anti-stall floor
  // (400 on a 10,000 enemy) -- otherwise the enemy self-heals and the ally
  // contribution can't be read cleanly.
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, boons: boonsWith({ allyPct: 0.01, taken: ['army'] }) } },
    { pending: 400, kept: [], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('Conscripts add ally damage each round', room.coop.enemyHp, 9500); // 400 banked + 100 ally (1%)
}
{
  // The boon itself grants exactly 1% -- guards the tuned value, not just the mechanic.
  const api = fs.readFileSync(path.join(REPO, 'functions/api/mana-clash.js'), 'utf8');
  ok('the Conscripts boon grants 1% ally damage', /case 'army':\s*b\.allyPct = \(b\.allyPct \|\| 0\) \+ 0\.01;/.test(api));
  ok('and its description says 1%', /name: 'Conscripts'[\s\S]*?1% of enemy HP/.test(api));
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

/* ── The vote has a deadline, so an AFK player can't hold it open forever ── */

/* Not expired yet, and votes are incomplete: nothing forces a resolution. */
{
  const room = coopVoteRoom(['p1', 'p2']);
  room.coop.boonVoteDeadline = Date.now() + 60000;   // well in the future
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: room }) };
  await POST(e, { action: 'choose-boon', code: 'AAAA', boon: 'zeal' }, cookie('p1'));
  const after = e.MARKETPLACE.read('mc_room_AAAA');
  ok('still waiting on p2 — the deadline has not passed', after.coop.awaitingBoon === true);
}

/* Expired, with only some players having voted: resolves on THEIR votes. */
{
  const room = coopVoteRoom(['p1', 'p2', 'p3']);
  room.coop.boonVoteDeadline = Date.now() - 1000;    // already passed
  room.coop.boonVotes = { p1: 'vigor' };             // p2, p3 never voted
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: room }) };
  // 'ready' is a neutral trigger here — it goes through withRoom (which
  // runs advance() first) and is expected to refuse since the room isn't
  // in the lobby; only the persisted STATE from advance() matters.
  await POST(e, { action: 'ready', code: 'AAAA' }, cookie('p1'));
  const after = e.MARKETPLACE.read('mc_room_AAAA');
  ok('the vote resolved without waiting for p2/p3', after.coop.awaitingBoon === false);
  ok('p1’s lone vote won it', after.coop.boons.taken.includes('vigor'));
  check('and the run moved on to the next wave', after.coop.wave, 2);
}

/* Expired with NOBODY having voted: still resolves, to the first offer. */
{
  const room = coopVoteRoom(['p1', 'p2']);
  room.coop.boonVoteDeadline = Date.now() - 1000;
  room.coop.boonVotes = {};
  const firstOffered = room.coop.pendingBoons[0].id;
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: room }) };
  await POST(e, { action: 'ready', code: 'AAAA' }, cookie('p1'));
  const after = e.MARKETPLACE.read('mc_room_AAAA');
  ok('an entirely unvoted deadline still resolves', after.coop.awaitingBoon === false);
  ok('falling back to the first offered boon', after.coop.boons.taken.includes(firstOffered));
}

/* The deadline is actually set the moment a boon is first offered. */
{
  const before = Date.now();
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom({ coop: { enemyHp: 100, enemyMaxHp: 100 } }, { pending: 100 }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('a deadline is set on offer', typeof room.coop.boonVoteDeadline === 'number');
  ok('roughly COOP_BOON_VOTE_MS out', room.coop.boonVoteDeadline >= before + 19000 && room.coop.boonVoteDeadline <= before + 21000);
}

/* The client-facing countdown, via viewFor. */
{
  const room = coopVoteRoom(['p1']);
  room.coop.boonVoteDeadline = Date.now() + 12000;
  const v = viewFor(room, 'p1', Date.now());
  ok('the view reports roughly the time left', v.coop.boonVoteMsLeft > 11000 && v.coop.boonVoteMsLeft <= 12000);
}

/* ══ Enemies are randomized, not a fixed cycle ══════════════════════════ */

/* Wave 20 is always the fixed final boss, regardless of randomness. */
{
  for (let i = 0; i < 20; i++) {
    check('wave 20 is always the final boss', coopPick(20).tier, 'final');
  }
}

/* Boss/normal waves always draw from the right pool. */
{
  const bossSlugs = new Set(['boss-badger','boss-cat','boss-dino-rex','boss-dino-tri','boss-frogger','boss-gollux','boss-pengu','demon-slime','necromancer']);
  for (let wave = 1; wave <= 30; wave++) {
    if (wave === 20) continue;
    const pick = coopPick(wave);
    if (wave % 5 === 0) {
      check('wave ' + wave + ' is a boss', pick.tier, 'boss');
      ok('drawn from the boss roster', bossSlugs.has(pick.slug));
    } else {
      check('wave ' + wave + ' is a normal enemy', pick.tier, 'normal');
      ok('not a boss slug', !bossSlugs.has(pick.slug));
    }
  }
}

/* pickRandom never returns the excluded slug when the pool has other
   options — this is what stops back-to-back waves repeating an enemy. */
{
  const pool = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
  for (let i = 0; i < 50; i++) {
    ok('never repeats the avoided slug', pickRandom(pool, 'a').slug !== 'a');
  }
  ok('a single-entry pool still returns something (no infinite loop)', pickRandom([{ slug: 'only' }], 'only').slug === 'only');
}

/* Across many picks at a fixed wave, more than one enemy actually turns up
   -- guards against a "randomized" implementation that silently always
   rolls index 0 or otherwise never varies. */
{
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(coopPick(3).slug);
  ok('the same wave can produce different enemies across picks', seen.size > 1);
}

/* End to end: clearing an enemy never respawns the exact one just beaten.
   Seeded with a real slug (the default fixture carries none) so the check
   is a genuine guarantee, not an undefined-never-equals-anything freebie. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom({ coop: { enemyHp: 100, enemyMaxHp: 100, enemySlug: 'compy' } }, { pending: 100 }) }) };
  const before = e.MARKETPLACE.read('mc_room_AAAA').coop.enemySlug;
  ok('the fixture actually seeded a real slug', before === 'compy');
  await POST(e, { action: 'bank', code: 'AAAA' });
  let room = e.MARKETPLACE.read('mc_room_AAAA');
  const pick = room.coop.pendingBoons[0].id;
  await POST(e, { action: 'choose-boon', code: 'AAAA', boon: pick });
  room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('the next enemy is never the one that was just cleared', room.coop.enemySlug !== before);
}

/* ══ Co-op shows every player's banked colours, not just your own ══════ */
{
  const room = coopVoteRoom(['p1', 'p2']);
  room.players.p1.turn.kept = ['R', 'R', 'R'];
  room.players.p2.turn.kept = ['W', 'W', 'W'];

  const seenByP1 = viewFor(room, 'p1', Date.now());
  const p2AsSeenByP1 = seenByP1.players.find(p => p.id === 'p2');
  check('p1 can see what p2 banked', p2AsSeenByP1.kept, ['W', 'W', 'W']);
  const p1AsSeenByP1 = seenByP1.players.find(p => p.id === 'p1');
  check('and their own, same as always', p1AsSeenByP1.kept, ['R', 'R', 'R']);

  // Solo co-op gets no special treatment here — there's simply nobody else
  // to check, but the same opt-in applies to a lone player's own row too.
  const solo = coopRoom({}, { kept: ['G', 'G', 'G'], done: null });
  const soloView = viewFor(solo, '7', Date.now());
  check('and it holds for a solo run too', soloView.players[0].kept, ['G', 'G', 'G']);
}

/* ══ Critical hits — 4/5/6 of a kind amplify the round's damage ═══════ */

/* enemyMaxHp is kept small enough here that the round's damage always
   clears the "barely scratched it" anti-stall threshold (4% of max HP) —
   otherwise the enemy's own self-heal would mask the crit math entirely,
   since 100-300 damage against a 10,000 HP enemy reads as a stall. */

/* Three of a kind is not a crit — the baseline everything else compares to. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 2000, enemyMaxHp: 2000, enemyAttack: 0 } },
    { pending: 100, kept: ['W', 'W', 'W'], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('three of a kind deals plain damage, no crit', room.coop.enemyHp, 1900);
  ok('and logs no crit tag', !(room.coop.log || []).some(t => t.startsWith('crit:')));
}

/* Four of a kind: x1.5. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 2000, enemyMaxHp: 2000, enemyAttack: 0 } },
    { pending: 100, kept: ['W', 'W', 'W', 'W'], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('four of a kind crits for 1.5x', room.coop.enemyHp, 2000 - 150);
  ok('and logs the crit tier', (room.coop.log || []).includes('crit:4'));
}

/* Five of a kind: x2. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 2000, enemyMaxHp: 2000, enemyAttack: 0 } },
    { pending: 100, kept: ['W', 'W', 'W', 'W', 'W'], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('five of a kind crits for 2x', room.coop.enemyHp, 2000 - 200);
  ok('and logs the crit tier', (room.coop.log || []).includes('crit:5'));
}

/* Six of a kind: x3 — the ceiling. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 2000, enemyMaxHp: 2000, enemyAttack: 0 } },
    { pending: 100, kept: ['W', 'W', 'W', 'W', 'W', 'W'], done: null }) }) };
  await POST(e, { action: 'bank', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('six of a kind crits for 3x', room.coop.enemyHp, 2000 - 300);
  ok('and logs the crit tier', (room.coop.log || []).includes('crit:6'));
}

/* Crit is a personal feat, but the team shares the best one landed. */
{
  const room = coopRoom(
    { coop: { enemyHp: 2000, enemyMaxHp: 2000, enemyAttack: 0 } },
    { pending: 100, kept: ['W', 'W', 'W'], done: null });   // host: no crit alone
  room.players.p2 = { displayName: 'P2', profileImage: null, ready: true, total: 0, turn: {
    pending: 50, dice: [], kept: ['R', 'R', 'R', 'R', 'R', 'R'], remaining: 6,
    awaitingSelection: false, done: 'banked', gained: 50, event: null, deadline: null,
  } };
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: room }) };
  await POST(e, { action: 'bank', code: 'AAAA' });   // host banks last, resolving the round
  const after = e.MARKETPLACE.read('mc_room_AAAA');
  // raw = 100 + 50 = 150, amplified by p2's six-of-a-kind (x3) = 450.
  check('the best crit across the team applies to the team’s total', after.coop.enemyHp, 2000 - 450);
}

/* ══ The ultimate — charged by Mana Clash, spent for a team-wide burst ═══ */

/* Rolling into hot dice charges it, through the real roll handler. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopLobby(1) }) };
  await POST(e, { action: 'start-game', code: 'AAAA' }, cookie('p1'));
  const realRandom = Math.random;
  const queue = [0.05, 0.20, 0.38, 0.55, 0.71, 0.90];   // one of each face -> a scoring straight
  let qi = 0;
  Math.random = () => (qi < queue.length ? queue[qi++] : realRandom());
  await POST(e, { action: 'roll', code: 'AAAA' }, cookie('p1'));
  Math.random = realRandom;
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('the forced roll actually hot-diced', room.players.p1.turn.event === 'clash');
  check('Mana Clash charges the ultimate', room.coop.ultCharge, 2.5);
}

/* Emptying the hand via keep (the OTHER hot-dice path) also charges it. */
{
  // The leftover dice must themselves score for the keep to be accepted —
  // two 1s ('C') do, each as a single, unlike two 2s ('W') which score nothing.
  const room = coopRoom({ coop: { ultCharge: 10 } },
    { dice: ['C', 'C'], kept: ['W', 'W', 'W'], remaining: 2, awaitingSelection: true, pending: 100, done: null });
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: room }) };
  await POST(e, { action: 'keep', code: 'AAAA', indices: [0, 1] });   // keeps the last 2 dice, empties the hand
  const after = e.MARKETPLACE.read('mc_room_AAAA');
  check('emptying the hand also charges the ultimate', after.coop.ultCharge, 12.5);
}

/* The charge cannot exceed the cap. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopLobby(1) }) };
  await POST(e, { action: 'start-game', code: 'AAAA' }, cookie('p1'));
  const room0 = e.MARKETPLACE.read('mc_room_AAAA');
  room0.coop.ultCharge = 99;
  await e.MARKETPLACE.put('mc_room_AAAA', JSON.stringify(room0));
  const realRandom = Math.random;
  const queue = [0.05, 0.20, 0.38, 0.55, 0.71, 0.90];
  let qi = 0;
  Math.random = () => (qi < queue.length ? queue[qi++] : realRandom());
  await POST(e, { action: 'roll', code: 'AAAA' }, cookie('p1'));
  Math.random = realRandom;
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('the charge clamps at the cap, not past it', room.coop.ultCharge, 100);
}

/* Versus has no ultimate to charge -- a hot dice roll there is a no-op for it. */
{
  const env = { MARKETPLACE: fakeKV() };
  const made = await (await POST(env, { action: 'create-room', goal: 10000, idleMs: 30000, practice: true })).json();
  const code = made.code;
  await POST(env, { action: 'ready', code, ready: true });
  await POST(env, { action: 'start-game', code });
  const realRandom = Math.random;
  const queue = [0.05, 0.20, 0.38, 0.55, 0.71, 0.90];
  let qi = 0;
  Math.random = () => (qi < queue.length ? queue[qi++] : realRandom());
  const res = await POST(env, { action: 'roll', code });
  Math.random = realRandom;
  ok('a versus hot-dice roll does not error', res.status === 200);
  const room = env.MARKETPLACE.read('mc_room_' + code);
  ok('and there is no coop block to have charged', !room.coop);
}

/* use-ultimate refuses below full charge. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom({ coop: { ultCharge: 99.9 } }) }) };
  const res = await POST(e, { action: 'use-ultimate', code: 'AAAA' });
  check('refused while not fully charged', res.status, 400);
}

/* use-ultimate refuses mid boon-vote. */
{
  const room = coopVoteRoom(['p1']);
  room.coop.ultCharge = 100;
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: room }) };
  const res = await POST(e, { action: 'use-ultimate', code: 'AAAA' }, cookie('p1'));
  check('refused while a boon vote is open', res.status, 400);
}

/* use-ultimate: the burst, the heal, and spending the charge. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, teamHp: 20, teamMaxHp: 100, ultCharge: 100 } }) }) };
  const res = await (await POST(e, { action: 'use-ultimate', code: 'AAAA' })).json();
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  check('the burst deals 25% of current HP', room.coop.enemyHp, 10000 - 2500);
  check('the team is fully healed', room.coop.teamHp, 100);
  check('the charge is spent', room.coop.ultCharge, 0);
  ok('the view carries the burst amount', res.success === true);
  ok('and logs it', (room.coop.log || []).includes('ultimate:2500'));
}

/* A lethal ultimate clears the enemy exactly like a lethal bank does.
   HP 1 is deliberate: ceil(1 * 0.25) = 1, so the burst is guaranteed to be
   at least the enemy's whole remaining HP. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 1, enemyMaxHp: 1, ultCharge: 100, wave: 1 } }) }) };
  await POST(e, { action: 'use-ultimate', code: 'AAAA' });
  const room = e.MARKETPLACE.read('mc_room_AAAA');
  ok('the enemy is cleared', room.coop.cleared === 1);
  ok('a boon is offered, same as any other clear', room.coop.awaitingBoon === true);
}

/* The animation cue: firing the ultimate bumps a counter every client
   watches, so a teammate's ultimate animates on every screen and not only
   the presser's — the whole point of it being server-driven, not a local
   button effect. */
{
  const e = { MARKETPLACE: fakeKV({ mc_room_AAAA: coopRoom(
    { coop: { enemyHp: 10000, enemyMaxHp: 10000, ultCharge: 100 } }) }) };
  check('the counter starts at zero', e.MARKETPLACE.read('mc_room_AAAA').coop.ultUsed, 0);
  const res = await (await POST(e, { action: 'use-ultimate', code: 'AAAA' })).json();
  check('firing it bumps the counter', e.MARKETPLACE.read('mc_room_AAAA').coop.ultUsed, 1);
  check('and the view carries the counter to every client', res.room.coop.ultUsed, 1);
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const api = fs.readFileSync(path.join(REPO, 'functions/api/mana-clash.js'), 'utf8');
  ok('endRound branches to co-op resolution', /room\.mode === 'coop'\) return endRoundCoop/.test(api));
  ok('enemies scale and escalate to a final boss', /COOP_FINAL_WAVE/.test(api) && /function coopSpawn/.test(api));
  ok('co-op is not ranked (no leaderboard)', /function isRanked[\s\S]*goal === RANKED_GOAL/.test(api));

  ok('critical hits are wired into the round resolution', /coopCritInfo\(room\)/.test(api));
  ok('the ultimate is charged from Mana Clash, not damage', /coopGainUltCharge\(r, COOP_ULT_CHARGE_PER_CLASH\)/.test(api));
  ok('a lethal ultimate reuses the shared clear path', /coopClearEnemy\(r, now, burst, before/.test(api));

  const game = fs.readFileSync(path.join(REPO, 'games/mana-clash/index.html'), 'utf8');
  ok('the client offers co-op and shows the enemy', /coop/i.test(game));
  ok('the ultimate plays Unholy Ground’s real animation, not a static image',
     /ultimate-cast\.png/.test(game) && /ULT_FX_FRAMES = 23/.test(game));
  ok('the asset itself exists (gitignored -- see server/scripts/lib/aseprite-slice-sheet.lua)',
     fs.existsSync(path.join(REPO, 'games/mana-clash/assets/fx/ultimate-cast.png')));
  /* The cast fires off the server counter in renderEnemy, NOT locally in
     the click handler -- so a teammate's ultimate animates on every screen.
     A local-only trigger is exactly the bug this replaced. */
  ok('the cast is driven by the shared ultUsed counter, on every client',
     /ultUsed/.test(game) && /lastUltUsed/.test(game));
  ok('and is not fired locally from the button press', !/fireUltimateBeam\(\);\s*\n\s*await act/.test(game));
  ok('the server sends the ultUsed cue', /ultUsed: room\.coop\.ultUsed/.test(api));
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
