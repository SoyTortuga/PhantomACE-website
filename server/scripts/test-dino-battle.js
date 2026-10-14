#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO BATTLE — the server-authoritative PvE engine + route

     node server/scripts/test-dino-battle.js

   What these guard:
     • stats DERIVED from rarity × archetype × battle level × mutation, never
       hand-authored, with the role orderings that make an archetype mean
       something;
     • the battle-level curve and its inverse agreeing (an off-by-one here is
       an XP bar that fills against a boundary the level never crosses);
     • every species mapped to a known archetype, every archetype's moveset
       valid, the marquee signatures present;
     • each move's effect — damage, bleed-over-time, stun-skips-a-turn, the
       attack debuff, the defend heal/guard — and that a special stays on its
       cooldown;
     • DETERMINISM: the same seed and moves replay bit-for-bit (the property
       that makes the engine testable AND server-authoritative at once);
     • the PvP-ready SEAM: the engine resolves ANY two teams with ANY pickers,
       with no coupling to PvE's energy/opponents/egg concepts;
     • ENERGY gating — can't battle at zero, regenerates on the Pacific day;
     • REWARDS scaled to difficulty, a loss paying only training XP, a boss
       egg rolled off the battle's own RNG;
     • SERVER AUTHORITY — a forged "I won / here are 99999 coins" body is
       ignored, an illegal move refused, a settled battle not settleable twice;
     • the save settlement riding grantSeq + a 'bxp' op so a stale client
       cannot clobber a payout;
     • the wiring (registry keys, router library decl, the game's battle tab).
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayKey } from '../../functions/api/season-time.js';
import {
  SPECIES, ROSTER_BY_RARITY, rollSpeciesId, isPendingSpecies,
} from '../../functions/api/dino-species.js';
import { grantEgg } from '../../functions/api/dino-park.js';
import {
  ARCHETYPES, MOVES, SIGNATURES, SPECIES_ARCHETYPE,
  deriveStats, battleLevelFromXp, xpForBattleLevel, battleXpProgress,
  archetypeFor, movesetFor, createBattle, stepTurn, resolveToEnd, computeRewards,
  publicView, PICKERS, makeCombatant, activeOf, legalMoves, BOSS_EGG_CHANCE,
} from '../../functions/api/dino-battle/engine.js';
import { onRequestGet, onRequestPost } from '../../functions/api/dino-battle/index.js';

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

/* ══ A KV double, same contract as the other suites' ═══════════════════ */
function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async mutate(k, fn) { const cur = store.has(k) ? JSON.parse(store.get(k)) : null; const out = await fn(cur); if (out === undefined) return; store.set(k, JSON.stringify(out)); },
    async list(opts) { const prefix = (opts && opts.prefix) || ''; return { keys: [...store.keys()].filter(n => n.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
  };
}
const cookie = (id) => id ? { Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) } : {};
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/dino-battle', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });
const GET = (e, h) => onRequestGet({ env: e, request: new Request('https://x/api/dino-battle', { headers: { ...h } }) });

/* A dino_park save record the route reads dinos from and settles into. */
function saveRec(userId, park, over = {}) {
  return { userId, state: { saveEpoch: 2, coins: 100, grantSeq: 0, park, vault: [], eggs: [], discovered: [], marketOps: [], appliedOps: [], ...over } };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ══ STAT DERIVATION ═══════════════════════════════════════════════════ */
{
  /* Rarity is a floor: same species/level, a higher tier is strictly stronger. */
  const lowR = deriveStats({ speciesId: 'trex', rarity: 'common', level: 5 });
  const hiR = deriveStats({ speciesId: 'trex', rarity: 'legendary', level: 5 });
  ok('a higher rarity derives higher HP/ATK', hiR.hp > lowR.hp && hiR.atk > lowR.atk);

  /* Mutation is a flat edge. */
  const plain = deriveStats({ speciesId: 'trex', rarity: 'epic', level: 5 });
  const mut = deriveStats({ speciesId: 'trex', rarity: 'epic', level: 5, mutation: 'golden' });
  ok('a mutation raises every stat', mut.hp > plain.hp && mut.atk > plain.atk && mut.def > plain.def && mut.spd > plain.spd);

  /* Battle level grows stats. */
  const lv1 = deriveStats({ speciesId: 'trex', rarity: 'epic', battleXp: 0 });
  const lv10 = deriveStats({ speciesId: 'trex', rarity: 'epic', level: 10 });
  ok('a higher battle level derives higher stats', lv10.atk > lv1.atk && lv10.hp > lv1.hp);
  check('a zero-XP dino is battle level 1', lv1.level, 1);

  /* Archetype orderings, isolated by using same rarity+level so tier cancels. */
  const brute = deriveStats({ speciesId: 'allo', rarity: 'rare', level: 5 });   // brute
  const tank = deriveStats({ speciesId: 'trike', rarity: 'rare', level: 5 });   // tank
  ok('a brute out-hits a tank', brute.atk > tank.atk);
  ok('a tank out-guards and out-lasts a brute', tank.def > brute.def && tank.hp > brute.hp);
  const skrm = deriveStats({ speciesId: 'deinoch', rarity: 'rare', level: 5 }); // skirmisher
  const colo = deriveStats({ speciesId: 'mamen', rarity: 'rare', level: 5 });   // colossus
  ok('a skirmisher outruns a colossus', skrm.spd > colo.spd);
  ok('a colossus out-bulks a skirmisher', colo.hp > skrm.hp);

  /* The route never trusts a client rarity: an unknown rarity falls to common. */
  const bogus = deriveStats({ speciesId: 'trex', rarity: 'ultramega', level: 1 });
  check('an unknown rarity is treated as common', bogus.hp, deriveStats({ speciesId: 'trex', rarity: 'common', level: 1 }).hp);
}

/* ══ Battle-level curve round-trips ════════════════════════════════════ */
{
  const drift = [];
  for (let lv = 1; lv <= 25; lv++) {
    const at = xpForBattleLevel(lv);
    if (battleLevelFromXp(at) !== lv) drift.push(`lv ${lv}: xpForBattleLevel=${at} reads back ${battleLevelFromXp(at)}`);
    if (at > 0 && battleLevelFromXp(at - 1) !== lv - 1) drift.push(`lv ${lv}: one XP short is not ${lv - 1}`);
  }
  check('every battle-level boundary round-trips', drift, []);
  const bad = [];
  for (let xp = 0; xp < 20000; xp += 53) { const p = battleXpProgress(xp); if (!(p >= 0 && p <= 1)) bad.push(`${xp}→${p}`); }
  check('battle XP progress stays 0..1', bad, []);
}

/* ══ Archetypes, movesets, signatures ══════════════════════════════════ */
{
  const unmapped = Object.keys(SPECIES).filter(id => !SPECIES_ARCHETYPE[id]);
  check('every species has an explicit archetype', unmapped, []);
  const badArch = Object.entries(SPECIES_ARCHETYPE).filter(([, a]) => !ARCHETYPES[a]).map(([id]) => id);
  check('every mapped archetype is a real one', badArch, []);
  ok('archetypeFor resolves for all species', Object.keys(SPECIES).every(id => ARCHETYPES[archetypeFor(id)]));

  const badMoves = [];
  for (const [name, a] of Object.entries(ARCHETYPES)) {
    if (a.moves.length < 3 || a.moves.length > 4) badMoves.push(`${name} has ${a.moves.length} moves`);
    for (const m of a.moves) if (!MOVES[m]) badMoves.push(`${name} references unknown move ${m}`);
    if (!a.moves.some(m => MOVES[m].kind === 'attack')) badMoves.push(`${name} has no attack`);
  }
  check('every archetype has a valid 3-4 move kit with an attack', badMoves, []);

  /* A marquee species adds its signature as a 4th option. */
  const rexMoves = movesetFor('trex', 'epic');
  ok('T. rex gains its signature move', rexMoves.includes('apex_bite') && rexMoves.length === ARCHETYPES.brute.moves.length + 1);
  const badSig = Object.entries(SIGNATURES).filter(([, m]) => !MOVES[m] || !MOVES[m].signature).map(([id]) => id);
  check('every signature move exists and is flagged', badSig, []);
  const plainMoves = movesetFor('allo', 'rare');  // a brute with no signature
  check('a non-marquee species keeps the base kit', plainMoves.length, ARCHETYPES.brute.moves.length);
}

/* ══ Move effects (driven with explicit moves + a chosen RNG) ══════════ */

/* Run ONE turn on a fresh clone with a given rng and explicit moves. */
function turnWith(base, rng, moves) {
  const b = clone(base); b.rng = rng >>> 0;
  const res = stepTurn(b, moves);
  return { b, res };
}
/* Find an rng that makes a one-turn outcome satisfy pred — used where a hit or
   a status roll must land for the assertion to be meaningful. Deterministic:
   the chosen rng is then reused so the whole scenario replays. */
function seedFor(base, moves, pred) {
  for (let r = 1; r < 60000; r++) { const { b } = turnWith(base, r, moves); if (pred(b)) return r; }
  throw new Error('no rng satisfied the predicate');
}

{
  /* Damage lowers the target's HP (foe attacks back rather than healing, so a
     small hit is not masked by a self-heal). */
  const base = createBattle({ a: { team: [{ speciesId: 'ichthy', rarity: 'uncommon', level: 5 }] }, b: { team: [{ speciesId: 'anky', rarity: 'rare', level: 5 }] }, seed: 's' });
  const r = seedFor(base, { aMove: 'bite', bMove: 'tail_whip' }, b => activeOf(b.b).hp < activeOf(b.b).maxHp && b.log.some(e => e.t === 'hit'));
  const { b } = turnWith(base, r, { aMove: 'bite', bMove: 'tail_whip' });
  ok('a landed attack reduces the target HP', activeOf(b.b).hp < activeOf(b.b).maxHp);
}
{
  /* Bleed is damage over time: an explicit bleed tick resolves on a later turn. */
  const base = createBattle({ a: { team: [{ speciesId: 'raptor', rarity: 'uncommon', level: 8 }] }, b: { team: [{ speciesId: 'trike', rarity: 'rare', level: 8 }] }, seed: 'bl' });
  const r = seedFor(base, { aMove: 'rend', bMove: 'tail_whip' }, b => activeOf(b.b).bleedTurns > 0);
  const { b } = turnWith(base, r, { aMove: 'rend', bMove: 'tail_whip' });
  ok('a bleed special applies bleeding', activeOf(b.b).bleedTurns > 0);
  const before = activeOf(b.b).bleedTurns;
  const res2 = stepTurn(b, { aMove: 'slash', bMove: 'tail_whip' });
  ok('bleeding deals damage over time', res2.log.some(e => e.t === 'bleed'));
  ok('and ticks down each turn', activeOf(b.b).bleedTurns < before);
}
{
  /* Stun makes the victim skip its next action. The stunner is the SLOWER
     side (a slow tank vs a fast striker) so the stun is applied after the
     victim has already acted this turn and therefore persists to the next —
     a fast stunner's hit would be consumed by the victim's own skipped action
     the same turn, which is correct but not what this asserts. */
  const base = createBattle({ a: { team: [{ speciesId: 'trike', rarity: 'rare', level: 9 }] }, b: { team: [{ speciesId: 'raptor', rarity: 'uncommon', level: 9 }] }, seed: 'st' });
  const r = seedFor(base, { aMove: 'gore', bMove: 'slash' }, b => activeOf(b.b).stun > 0);
  const { b } = turnWith(base, r, { aMove: 'gore', bMove: 'slash' });
  ok('a stun special stuns the target', activeOf(b.b).stun > 0);
  const res2 = stepTurn(b, { aMove: 'tail_whip', bMove: 'slash' });
  ok('the stunned target skips its action next turn', res2.log.some(e => e.t === 'stunned'));
}
{
  /* Screech is a no-damage attack debuff. */
  const base = createBattle({ a: { team: [{ speciesId: 'pterano', rarity: 'rare', level: 6 }] }, b: { team: [{ speciesId: 'trex', rarity: 'epic', level: 6 }] }, seed: 'sc' });
  const { b } = turnWith(base, 7, { aMove: 'screech', bMove: 'bite' });
  ok('screech weakens the foe attack', activeOf(b.b).atkTurns > 0 && activeOf(b.b).atkMult < 1);
}
{
  /* Brace heals and raises defence (a defend/buff). */
  const base = createBattle({ a: { team: [{ speciesId: 'trike', rarity: 'rare', level: 6 }] }, b: { team: [{ speciesId: 'stego', rarity: 'uncommon', level: 6 }] }, seed: 'br' });
  base.a.team[0].hp = 10;
  const { b } = turnWith(base, 3, { aMove: 'brace', bMove: 'brace' });
  ok('brace restores HP and raises defence', activeOf(b.a).hp > 10 && activeOf(b.a).defTurns > 0 && activeOf(b.a).defMult > 1);
}
{
  /* A special stays on cooldown after use; a no-cooldown attack never does. */
  const me = makeCombatant({ speciesId: 'allo', rarity: 'rare', level: 9 });
  check('all kit moves start usable', legalMoves(me).length, me.moves.length);
  const base = createBattle({ a: { team: [{ speciesId: 'allo', rarity: 'rare', level: 9 }] }, b: { team: [{ speciesId: 'diplo', rarity: 'rare', level: 9 }] }, seed: 'cd' });
  const { b } = turnWith(base, 5, { aMove: 'gore', bMove: 'crush' });
  ok('a used special goes on cooldown', activeOf(b.a).cool.gore > 0 && !legalMoves(activeOf(b.a)).includes('gore'));
  ok('a no-cooldown attack is always re-usable', legalMoves(activeOf(b.a)).includes('bite'));
}

/* ══ Determinism + the PvP seam ════════════════════════════════════════ */
{
  /* Same seed + same pickers → identical fight, every time. */
  const mk = () => createBattle({ a: { ai: 'aggressive', team: [{ speciesId: 'trex', rarity: 'epic', level: 10 }] }, b: { ai: 'aggressive', team: [{ speciesId: 'anky', rarity: 'rare', level: 10 }] }, seed: 'dup' });
  const x = mk(); resolveToEnd(x);
  const y = mk(); resolveToEnd(y);
  check('a seeded battle replays bit-for-bit', JSON.stringify(x.log), JSON.stringify(y.log));
  check('with the same outcome', x.status, y.status);
  ok('and it actually took turns', x.turn > 1);

  /* The SEAM: ANY two teams, ANY pickers. The engine takes custom pickers by
     name and never references PvE's energy/opponents/eggs. A side told to only
     defend cannot win against one told to attack — proving pickers are honored
     and inputs decide the outcome (not any hardcoded "wild" behaviour). */
  const always = (move) => () => move;
  const seamBattle = createBattle({
    a: { ai: 'turtle', team: [{ speciesId: 'trike', rarity: 'rare', level: 8 }] },
    b: { ai: 'smash', team: [{ speciesId: 'trex', rarity: 'epic', level: 12 }] },
    seed: 'seam',
  });
  const status = resolveToEnd(seamBattle, { turtle: always('brace'), smash: PICKERS.aggressive });
  ok('a custom-picker battle resolves to a winner', status === 'won' || status === 'lost');
  check('the only-defends side loses to the attacker', status, 'lost');

  /* No PvE coupling baked into the engine: it pulls in only the species table,
     never the route's own machinery — the energy pool, the opponent generator
     (season-time / ROSTER_BY_RARITY), the egg grant, or the storage keys.
     Checked structurally (imports + code tokens) so a mention in a comment that
     explains what the engine does NOT do can't trip it. */
  const engineSrc = fs.readFileSync(path.join(REPO, 'functions/api/dino-battle/engine.js'), 'utf8');
  const imports = engineSrc.match(/^import .*$/gm) || [];
  ok('the engine imports only the species table', imports.length === 1 && /from '\.\.\/dino-species\.js'/.test(imports[0]));
  ok('the engine never calls the route-only machinery',
     !/grantEgg/.test(engineSrc) && !/ROSTER_BY_RARITY/.test(engineSrc) && !/dino_battle_/.test(engineSrc) && !/dayKey/.test(engineSrc));
}

/* ══ Reward calc ═══════════════════════════════════════════════════════ */
{
  const won = (meta) => { const b = createBattle({ a: { team: [{ speciesId: 'trex', rarity: 'epic', level: 5 }] }, b: { team: [{ speciesId: 'compy', rarity: 'common', level: 1 }] }, seed: 'rw', meta }); b.status = 'won'; return b; };
  const t1 = computeRewards(won({ tier: 1, level: 3, kind: 'wild' }));
  const t4 = computeRewards(won({ tier: 4, level: 16, kind: 'wild' }));
  ok('a win pays coins and XP', t1.win && t1.coins > 0 && t1.xp > 0);
  ok('a tougher opponent pays more', t4.coins > t1.coins && t4.xp > t1.xp);

  const lost = createBattle({ a: { team: [{ speciesId: 'trex', rarity: 'epic', level: 5 }] }, b: { team: [{ speciesId: 'compy', rarity: 'common', level: 1 }] }, seed: 'rl', meta: { tier: 1, level: 3, kind: 'wild' } });
  lost.status = 'lost';
  const lr = computeRewards(lost);
  ok('a loss pays no coins, only a little training XP', lr.win === false && lr.coins === 0 && lr.xp > 0 && lr.xp < t1.xp);

  /* A boss egg is rolled off the battle's own RNG, so it is deterministic:
     scan rng for one that grants and one that does not. */
  const bossAt = (rng) => { const b = won({ tier: 5, level: 22, kind: 'boss' }); b.rng = rng; return computeRewards(b); };
  let grants = null, denies = null;
  for (let r = 1; r < 5000 && (grants === null || denies === null); r++) { const e = bossAt(r).bossEgg; if (e && grants === null) grants = r; if (!e && denies === null) denies = r; }
  ok('a boss can grant an egg', grants !== null && !!bossAt(grants).bossEgg);
  ok('and a boss can also grant none', denies !== null && !bossAt(denies).bossEgg);
  ok('the egg rarity is a Dino Park tier', ['rare', 'epic'].includes(bossAt(grants).bossEgg));
  ok('the boss egg chance is the stated one', BOSS_EGG_CHANCE === 0.5);
}

/* ══ ROUTE: energy gating ══════════════════════════════════════════════ */
const today = dayKey();
{
  const park = [{ speciesId: 'compy', mutation: null, uid: 'd1', battleXp: 0 }];
  const e = { MARKETPLACE: fakeKV({ ['dino_park_7']: saveRec('7', park) }) };
  const g = await (await GET(e, cookie('7'))).json();
  check('a fresh player has a full energy pool', g.energy, { count: 5, max: 5 });
  check('today\'s challengers are generated', g.opponents.length, 5);
  ok('the eligible dinos carry derived stats and moves', g.dinos.length === 1 && g.dinos[0].stats.atk > 0 && g.dinos[0].moves.length >= 3);
  check('a logged-out request is refused', (await GET(e)).status, 401);
}
{
  /* THE GUARD (mutation check): spending energy is load-bearing. At zero the
     start is refused AND no battle is written — remove the e.count<=0 branch
     and this fails, which is the point. */
  const park = [{ speciesId: 'compy', uid: 'd1', battleXp: 0 }];
  const e = { MARKETPLACE: fakeKV({ ['dino_park_7']: saveRec('7', park), ['dino_battle_energy_7']: { day: today, count: 0 } }) };
  const r = await POST(e, { action: 'start', uid: 'd1', opponentId: 'wild_1' }, cookie('7'));
  check('a player at zero energy cannot start', r.status, 400);
  ok('and no battle was created', !e.MARKETPLACE.read('dino_battle_state_7'));
}
{
  /* Regenerates on the Pacific day boundary: a previous-day row reads full. */
  const park = [{ speciesId: 'compy', uid: 'd1', battleXp: 0 }];
  const e = { MARKETPLACE: fakeKV({ ['dino_park_7']: saveRec('7', park), ['dino_battle_energy_7']: { day: '2000-01-01', count: 0 } }) };
  const g = await (await GET(e, cookie('7'))).json();
  check('a stale-day energy row reads as a fresh pool', g.energy.count, 5);
  const s = await (await POST(e, { action: 'start', uid: 'd1', opponentId: 'wild_1' }, cookie('7'))).json();
  check('starting after rollover spends from the fresh pool', s.energy.count, 4);
}

/* ══ ROUTE: start / move / server authority / settlement ═══════════════ */
{
  const park = [{ speciesId: 'compy', mutation: null, uid: 'd1', battleXp: 0 }];
  const e = { MARKETPLACE: fakeKV({ ['dino_park_7']: saveRec('7', park) }) };

  const s = await (await POST(e, { action: 'start', uid: 'd1', opponentId: 'wild_1' }, cookie('7'))).json();
  ok('a battle starts', s.success && s.battle && s.battle.status === 'active');
  check('starting spends one energy', s.energy.count, 4);
  ok('the battle is stored server-side', !!e.MARKETPLACE.read('dino_battle_state_7'));
  ok('the move list is returned to the client', s.battle.moves.length >= 3);

  check('a second battle is refused while one runs', (await POST(e, { action: 'start', uid: 'd1', opponentId: 'wild_2' }, cookie('7'))).status, 409);
  check('an unknown opponent is refused', (await POST(e, { action: 'start', uid: 'd1', opponentId: 'nope' }, cookie('zz'))).status, 400);
  check('a stranger\'s dino cannot be sent', (await POST(e, { action: 'start', uid: 'ghost', opponentId: 'wild_1' }, cookie('7'))).status, 409);

  check('an illegal move is refused', (await POST(e, { action: 'move', moveId: 'totally_fake' }, cookie('7'))).status, 400);
}
{
  /* SERVER AUTHORITY + settlement. Seed a battle the player will WIN this turn
     (foe at 1 HP, player faster), with an rng chosen so the strike lands, and
     submit a move carrying FORGED win/coins fields. The server must ignore the
     body, compute its own result, and settle exactly that — not 99999. */
  const base = createBattle({
    a: { team: [{ speciesId: 'compy', uid: 'd1', battleXp: 0 }] },           // skirmisher, fast
    b: { ai: 'aggressive', team: [{ speciesId: 'anky', rarity: 'rare', level: 8 }] },  // tank, slow
    seed: 'win', meta: { tier: 1, level: 3, kind: 'wild', opponentId: 'wild_1' },
  });
  base.startedAt = Date.now();
  base.b.team[0].hp = 1;
  const winRng = seedFor(base, { aMove: 'dart' }, b => b.status === 'won');
  base.rng = winRng;

  const expect = (() => { const b = clone(base); stepTurn(b, { aMove: 'dart' }); return computeRewards(b); })();

  const park = [{ speciesId: 'compy', uid: 'd1', battleXp: 0 }];
  const e = { MARKETPLACE: fakeKV({ ['dino_park_7']: saveRec('7', park), ['dino_battle_state_7']: base }) };

  const res = await (await POST(e, { action: 'move', moveId: 'dart', win: true, coins: 99999, xp: 99999, battle: { status: 'won' } }, cookie('7'))).json();
  ok('the server resolves the win itself', res.ended === true && res.result.win === true);
  check('and pays its OWN coins, not the forged amount', res.result.coins, expect.coins);
  check('nor the forged XP', res.result.xp, expect.xp);

  const save = e.MARKETPLACE.read('dino_park_7').state;
  check('the save gained exactly the computed coins', save.coins, 100 + expect.coins);
  ok('via a coins marketOp the client reconciles', save.marketOps.some(o => o.t === 'coins' && o.d === expect.coins));
  const bxp = save.marketOps.find(o => o.t === 'bxp' && o.uid === 'd1');
  ok('battle XP is applied to the exact dino by a bxp op', !!bxp && bxp.d === expect.xp);
  check('and stamped onto the dino itself', save.park[0].battleXp, expect.xp);
  ok('with grantSeq bumped so a stale save cannot clobber it', save.grantSeq === 1);
  ok('the battle is cleared after settling', !e.MARKETPLACE.read('dino_battle_state_7'));

  check('a move after the battle ended is refused', (await POST(e, { action: 'move', moveId: 'dart' }, cookie('7'))).status, 400);
}
{
  /* A forged body cannot turn a LOSS into a win. Seed a battle the player
     loses (player at 1 HP, foe healthy and faster-hitting), submit with
     win:true — the result is still a loss and no coins are minted. */
  const base = createBattle({
    a: { team: [{ speciesId: 'anky', uid: 'd1', rarity: 'rare', level: 3 }] },  // slow tank
    b: { ai: 'aggressive', team: [{ speciesId: 'raptor', rarity: 'uncommon', level: 12 }] }, // fast striker
    seed: 'lose', meta: { tier: 2, level: 6, kind: 'wild', opponentId: 'wild_2' },
  });
  base.startedAt = Date.now();
  base.a.team[0].hp = 1;
  const loseRng = seedFor(base, { aMove: 'tail_whip' }, b => b.status === 'lost');
  base.rng = loseRng;

  const park = [{ speciesId: 'anky', uid: 'd1', battleXp: 100 }];
  const e = { MARKETPLACE: fakeKV({ ['dino_park_7']: saveRec('7', park, { park }), ['dino_battle_state_7']: base }) };
  const res = await (await POST(e, { action: 'move', moveId: 'tail_whip', win: true, coins: 99999 }, cookie('7'))).json();
  check('a forged win on a losing board still loses', res.result.win, false);
  check('a loss mints no coins', res.result.coins, 0);
  const save = e.MARKETPLACE.read('dino_park_7').state;
  check('and the save coins are unchanged', save.coins, 100);
  ok('a loss still pays a little training XP', save.park[0].battleXp > 100);
}
{
  /* Forfeit ends the battle as a loss, settles only training XP, and clears. */
  const base = createBattle({ a: { team: [{ speciesId: 'compy', uid: 'd1', battleXp: 0 }] }, b: { ai: 'aggressive', team: [{ speciesId: 'anky', rarity: 'rare', level: 8 }] }, seed: 'ff', meta: { tier: 1, level: 3, kind: 'wild', opponentId: 'wild_1' } });
  base.startedAt = Date.now();
  const park = [{ speciesId: 'compy', uid: 'd1', battleXp: 0 }];
  const e = { MARKETPLACE: fakeKV({ ['dino_park_7']: saveRec('7', park), ['dino_battle_state_7']: base }) };
  const res = await (await POST(e, { action: 'forfeit' }, cookie('7'))).json();
  check('forfeit resolves as a loss', res.result.win, false);
  ok('and clears the battle', !e.MARKETPLACE.read('dino_battle_state_7'));
}
{
  /* A boss win grants an egg through the existing grantEgg path. Seed a boss
     battle the player wins, with an rng that both wins AND rolls the egg. */
  const park = [{ speciesId: 'trex', uid: 'd1', rarity: 'epic', battleXp: 5000 }];
  const findBossRng = () => {
    for (let r = 1; r < 60000; r++) {
      const b = createBattle({ a: { team: [{ speciesId: 'trex', uid: 'd1', rarity: 'epic', battleXp: 5000 }] }, b: { ai: 'aggressive', team: [{ speciesId: 'compy', rarity: 'common', level: 1 }] }, seed: 'boss', meta: { tier: 5, level: 22, kind: 'boss', opponentId: 'boss_5' } });
      b.b.team[0].hp = 1; b.rng = r;
      const c = clone(b); stepTurn(c, { aMove: 'bite' });
      if (c.status === 'won' && computeRewards(clone(c)).bossEgg) return r;
    }
    return null;
  };
  const r = findBossRng();
  ok('a winnable boss turn that also rolls an egg exists', r !== null);
  const base = createBattle({ a: { team: [{ speciesId: 'trex', uid: 'd1', rarity: 'epic', battleXp: 5000 }] }, b: { ai: 'aggressive', team: [{ speciesId: 'compy', rarity: 'common', level: 1 }] }, seed: 'boss', meta: { tier: 5, level: 22, kind: 'boss', opponentId: 'boss_5' } });
  base.startedAt = Date.now(); base.b.team[0].hp = 1; base.rng = r;
  const e = { MARKETPLACE: fakeKV({ ['dino_park_7']: saveRec('7', park, { park }), ['dino_battle_state_7']: base }) };
  const res = await (await POST(e, { action: 'move', moveId: 'bite' }, cookie('7'))).json();
  ok('a boss win reports an egg', res.result.eggGranted === true && ['rare', 'epic'].includes(res.result.eggRarity));
  const save = e.MARKETPLACE.read('dino_park_7').state;
  ok('and an egg actually lands in the incubator', (save.eggs || []).length === 1);
}

/* ══ NEW SPECIES — defined but dormant ═════════════════════════════════
   Thirteen species added ahead of their art. Two are live (art on disk);
   eleven are pending and must be unreachable until their PNG lands. */
{
  const NEW_LEGENDARY = ['carchar', 'titanoboa', 'livyatan', 'sarco', 'pliosaur', 'yuty'];
  const NEW_EPIC = ['acro', 'tarbo', 'sucho', 'megalania', 'gigapith', 'basilo', 'patago'];
  const NEW = [...NEW_LEGENDARY, ...NEW_EPIC];
  const LIVE_NEW = ['yuty', 'gigapith'];
  const PENDING_NEW = NEW.filter(id => !LIVE_NEW.includes(id));

  /* Present, correctly tiered, and every one mapped to an archetype (the
     invariant extended to the new roster). */
  check('all 13 new species are in the table', NEW.filter(id => SPECIES[id]).length, 13);
  check('the six new legendaries are legendary', NEW_LEGENDARY.filter(id => SPECIES[id] && SPECIES[id].rarity === 'legendary').length, 6);
  check('the seven new epics are epic', NEW_EPIC.filter(id => SPECIES[id] && SPECIES[id].rarity === 'epic').length, 7);
  const unmappedNew = NEW.filter(id => !ARCHETYPES[SPECIES_ARCHETYPE[id]]);
  check('every new species has a mapped archetype', unmappedNew, []);

  /* The pending flag is exactly where it should be. */
  check('the two art-on-disk species are live', LIVE_NEW.filter(id => !isPendingSpecies(id)).length, 2);
  check('the other eleven are dormant', PENDING_NEW.filter(id => isPendingSpecies(id)).length, 11);

  /* Dormant species never enter a roll pool. */
  const pooled = Object.values(ROSTER_BY_RARITY).flat();
  ok('no pending species is in any tier pool', !pooled.some(id => isPendingSpecies(id)));
  ok('the live pools still have members', ROSTER_BY_RARITY.legendary.length >= 6 && ROSTER_BY_RARITY.epic.length >= 13);
  let rolledPending = false;
  for (const r of ['legendary', 'epic']) for (let i = 0; i < 500; i++) if (isPendingSpecies(rollSpeciesId(r))) rolledPending = true;
  ok('rollSpeciesId never rolls a dormant species', !rolledPending);

  /* grantEgg refuses a pinned dormant species and falls back to a live one. */
  let eggRefusedPending = true, eggAlwaysLive = true;
  for (let i = 0; i < 12; i++) {
    const e = { MARKETPLACE: fakeKV({ ['dino_park_7']: { userId: '7', state: { saveEpoch: 2, coins: 0, park: [], vault: [], eggs: [], discovered: [] } } }) };
    const r = await grantEgg(e, '7', 'legendary', { speciesId: 'carchar' });
    if (!r.success) { eggRefusedPending = false; break; }
    if (r.egg.speciesId === 'carchar' || isPendingSpecies(r.egg.speciesId)) eggRefusedPending = false;
    if (SPECIES[r.egg.speciesId].rarity !== 'legendary' || isPendingSpecies(r.egg.speciesId)) eggAlwaysLive = false;
  }
  ok('grantEgg refuses a pinned dormant species', eggRefusedPending);
  ok('and still grants a live species of that rarity', eggAlwaysLive);

  /* The apex-legendary signatures exist and are reachable once live. */
  const SIG_IDS = ['carchar', 'titanoboa', 'livyatan', 'sarco', 'pliosaur'];
  ok('each apex legendary has a signature move', SIG_IDS.every(id => SIGNATURES[id] && MOVES[SIGNATURES[id]] && MOVES[SIGNATURES[id]].signature));
  ok('and its moveset carries it', SIG_IDS.every(id => movesetFor(id, 'legendary').includes(SIGNATURES[id])));

  /* Battle opponents are generated only from live species — no broken boss. */
  const e = { MARKETPLACE: fakeKV({ ['dino_park_7']: { userId: '7', state: { saveEpoch: 2, coins: 0, park: [{ speciesId: 'compy', uid: 'd1', battleXp: 0 }], vault: [], eggs: [], discovered: [], marketOps: [], appliedOps: [] } } }) };
  const g = await (await GET(e, cookie('7'))).json();
  ok('no battle opponent is a dormant species', !g.opponents.some(o => isPendingSpecies(o.speciesId)));

  /* THE ART GATE: every LIVE species' icon points at a file that exists on
     disk. This passes for the 85 originals plus Yutyrannus and Gigantopithecus,
     and is the check that proves an art drop is complete before un-pending —
     a pending species whose PNG has not landed is (correctly) not checked. */
  const missing = [];
  for (const [id, s] of Object.entries(SPECIES)) {
    if (s.pending) continue;
    const p = path.join(REPO, s.icon.replace(/^\//, ''));
    if (!fs.existsSync(p)) missing.push(id);
  }
  check('every live species icon exists on disk', missing, []);
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the energy key prefix is registered', /prefix: 'dino_battle_energy_'/.test(reg));
  ok('the battle-state key prefix is registered', /prefix: 'dino_battle_state_'/.test(reg));

  const router = fs.readFileSync(path.join(REPO, 'server/router.js'), 'utf8');
  ok('the engine is declared a library (no handler) in the router', /api\/dino-battle\/engine\.js/.test(router));

  const route = fs.readFileSync(path.join(REPO, 'functions/api/dino-battle/index.js'), 'utf8');
  ok('the route gates energy on the Pacific day boundary', /from '\.\.\/season-time\.js'/.test(route) && /dayKey\(\)/.test(route));
  ok('rewards settle through grantEgg / applyCoins', /grantEgg/.test(route) && /applyCoins/.test(route));

  const game = fs.readFileSync(path.join(REPO, 'games/dino-park/index.html'), 'utf8');
  ok('the game has a Battle tab wired into the nav and tab order', /switchTab\('battle'\)/.test(game) && /'battle', 'dinodex'/.test(game));
  ok('the battle view renders and talks to the route', /function renderBattle/.test(game) && /'\/api\/dino-battle'/.test(game));
  ok('the client applies the server\'s battle-XP op', /op\.t === 'bxp'/.test(game));

  /* The client roster knows the new species and hides dormant ones via a
     ROSTER_LIVE filter, so the Dinodex never renders a broken sprite. */
  ok('the client roster defines the new species', /id:'carchar'/.test(game) && /id:'gigapith'/.test(game) && /id:'yuty'/.test(game));
  ok('the client hides dormant species behind a ROSTER_LIVE filter', /const ROSTER_LIVE = ROSTER\.filter\(r => !r\.pending\)/.test(game) && /ROSTER_LIVE\.filter\(r => r\.rarity === to\)/.test(game));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[dino-battle] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[dino-battle] ${passed} assertions passed.`);
console.log('');
