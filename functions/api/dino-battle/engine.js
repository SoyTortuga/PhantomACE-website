/* ══════════════════════════════════════════════
   DINO BATTLE — the pure turn/stat/move engine

   The brain of Dino Park's PvE battles, and the one thing the roadmap says
   must NOT be rewritten when async PvP lands. So it is kept deliberately
   opponent-agnostic: it knows about two TEAMS and a MOVE-PICKER per side, and
   nothing about where a team came from, difficulty tiers, energy or egg
   rewards — those all live in the route (functions/api/dino-battle/index.js).
   Swapping the PvE opponent provider for a snapshot of another player's park
   is a new picker and a new team source, with no change in here.

   DETERMINISTIC BY A STORED SEED. A battle carries its own RNG state as a
   plain integer, so the whole fight is a pure function of (teams, seed, the
   sequence of moves chosen). That is what makes it server-authoritative: the
   client sends only a move id, the server re-derives every number from state
   it holds, and a forged "I won" in the request body changes nothing. It is
   also what makes it testable — same seed, same moves, same log, every run.

   Library only — no request handler. Registered in server/router.js
   NON_ROUTE_MODULES.

   Consumed by:
     • functions/api/dino-battle/index.js — the route that gates energy,
       generates PvE opponents, drives turns and settles rewards.
   ══════════════════════════════════════════════ */

import { SPECIES } from '../dino-species.js';

/* ── STAT DERIVATION ────────────────────────────────────────────────────
   A dino keeps only {speciesId, rarity, mutation, battleXp}. Combat stats
   are COMPUTED from those every time, never stored, so a rebalance is a
   constant change here rather than a migration of every save. Four factors
   multiply:

     rarity tier  — a floor, so a legendary outclasses a common of the same
                    archetype even at level 1;
     archetype    — the per-species role bias (a brute hits, a tank soaks);
     battle level — derived from battleXp, ~7% per level, uncapped XP but a
                    stat cap so a veteran can't become unbeatable;
     mutation     — a flat edge for a recoloured variant.

   The numbers are tuned so a tended, higher-rarity, higher-level dino wins
   more without the matchup ever being a foregone conclusion. */
const BASE = { hp: 110, atk: 30, def: 26, spd: 28 };

const TIER_MULT = { common: 1, uncommon: 1.18, rare: 1.4, epic: 1.7, legendary: 2.1 };

/* Per-level growth and the stat-side cap. battleXp itself never caps (the
   curve below is uncapped); LEVEL_CAP only stops the stat multiplier running
   away, so levelling past it is cosmetic rather than an auto-win. */
const PER_LEVEL = 0.07;
const LEVEL_CAP = 30;

const MUT_MULT = 1.1;

/* battleXp → battle level. Same shape as the game's care-XP curve
   (floor(sqrt(xp/K))+1) so the two feel consistent, but its OWN pool and its
   OWN constant: battle level must persist through the monthly reset and must
   not move when a dino is merely cared for. */
export const BATTLE_XP_PER_LEVEL = 60;

export function battleLevelFromXp(xp) {
  const n = Math.max(0, Math.floor(Number(xp) || 0));
  return Math.min(LEVEL_CAP, Math.floor(Math.sqrt(n / BATTLE_XP_PER_LEVEL)) + 1);
}

/** XP needed to REACH a battle level — inverse of battleLevelFromXp. */
export function xpForBattleLevel(n) {
  return Math.pow(Math.max(1, n) - 1, 2) * BATTLE_XP_PER_LEVEL;
}

/** How far through the current battle level, 0..1, for the XP bar. */
export function battleXpProgress(xp) {
  const lv = battleLevelFromXp(xp);
  if (lv >= LEVEL_CAP) return 1;
  const base = xpForBattleLevel(lv), next = xpForBattleLevel(lv + 1);
  const cur = Math.max(0, Math.floor(Number(xp) || 0));
  return next === base ? 1 : Math.min(1, Math.max(0, (cur - base) / (next - base)));
}

/* ── ARCHETYPES ─────────────────────────────────────────────────────────
   Seven combat roles. `bias` multiplies the base stats (so the orderings are
   the role: a brute's atk beats a tank's, a tank's def and hp beat a
   striker's, a skirmisher outruns a colossus). `moves` is the role's
   kit — a reliable attack, a stronger or utility option, and a special that
   lands a status on a cooldown, which is where the per-turn decision lives. */
export const ARCHETYPES = {
  brute:      { name: 'Brute',      bias: { hp: 1.10, atk: 1.35, def: 0.95, spd: 0.80 }, moves: ['bite', 'chomp', 'gore'] },
  tank:       { name: 'Bulwark',    bias: { hp: 1.35, atk: 0.85, def: 1.40, spd: 0.70 }, moves: ['tail_whip', 'brace', 'gore'] },
  striker:    { name: 'Striker',    bias: { hp: 0.95, atk: 1.25, def: 0.85, spd: 1.30 }, moves: ['slash', 'pounce', 'rend'] },
  skirmisher: { name: 'Skirmisher', bias: { hp: 0.85, atk: 1.00, def: 0.85, spd: 1.45 }, moves: ['dart', 'evade', 'harry'] },
  aerial:     { name: 'Aerial',     bias: { hp: 0.80, atk: 1.10, def: 0.80, spd: 1.40 }, moves: ['peck', 'dive_bomb', 'screech'] },
  aquatic:    { name: 'Aquatic',    bias: { hp: 1.15, atk: 1.10, def: 1.05, spd: 1.00 }, moves: ['bite', 'submerge', 'thrash'] },
  colossus:   { name: 'Colossus',   bias: { hp: 1.50, atk: 1.15, def: 1.35, spd: 0.60 }, moves: ['stomp', 'crush', 'bulwark'] },
};

/* ── MOVES ──────────────────────────────────────────────────────────────
   kind drives resolution:
     attack  — deals damage; `effect` optionally rides on a successful hit.
     defend  — no damage; guards this turn (halves incoming) and may heal or
               raise DEF; always available (cd 0) unless noted.
     buff    — self buff + guard.
     debuff  — no damage; weakens the foe.
   `cd` is turns the move is unusable after use (a special you spend once and
   then fight without). `acc` is the hit chance. Signature moves are the
   marquee species' own; they ADD a fourth option rather than replace one, so
   a T. rex genuinely has a richer decision than a generic brute. */
export const MOVES = {
  /* reliable attacks (no cooldown) */
  bite:      { name: 'Bite',       kind: 'attack', power: 30, acc: 0.95 },
  tail_whip: { name: 'Tail Whip',  kind: 'attack', power: 28, acc: 0.95 },
  slash:     { name: 'Slash',      kind: 'attack', power: 32, acc: 0.95 },
  dart:      { name: 'Dart',       kind: 'attack', power: 26, acc: 0.98 },
  peck:      { name: 'Peck',       kind: 'attack', power: 24, acc: 0.98 },

  /* heavy attacks — more power, less accuracy, no cooldown */
  chomp:     { name: 'Chomp',      kind: 'attack', power: 46, acc: 0.82 },
  crush:     { name: 'Crush',      kind: 'attack', power: 52, acc: 0.78 },
  pounce:    { name: 'Pounce',     kind: 'attack', power: 42, acc: 0.88 },
  dive_bomb: { name: 'Dive Bomb',  kind: 'attack', power: 44, acc: 0.82 },

  /* specials — a status on a cooldown */
  gore:      { name: 'Gore',       kind: 'attack', power: 30, acc: 0.90, effect: 'stun',  chance: 0.40, cd: 3 },
  stomp:     { name: 'Stomp',      kind: 'attack', power: 34, acc: 0.90, effect: 'stun',  chance: 0.35, cd: 3 },
  rend:      { name: 'Rend',       kind: 'attack', power: 24, acc: 0.90, effect: 'bleed', cd: 2 },
  harry:     { name: 'Harry',      kind: 'attack', power: 18, acc: 0.95, effect: 'bleed', cd: 3 },
  thrash:    { name: 'Thrash',     kind: 'attack', power: 28, acc: 0.88, effect: 'bleed', cd: 2 },
  screech:   { name: 'Screech',    kind: 'debuff', effect: 'atk_down', cd: 3 },

  /* defend / buff */
  brace:     { name: 'Brace',      kind: 'defend', effect: 'guard_heal', cd: 0 },
  bulwark:   { name: 'Bulwark',    kind: 'defend', effect: 'guard_big',  cd: 2 },
  evade:     { name: 'Evade',      kind: 'buff',   effect: 'spd_guard',  cd: 2 },
  submerge:  { name: 'Submerge',   kind: 'defend', effect: 'heal_guard', cd: 3 },

  /* signatures (marquee species only) */
  apex_bite:    { name: 'Apex Bite',       kind: 'attack', power: 48, acc: 0.88, effect: 'bleed',        cd: 2, signature: true },
  sail_slash:   { name: 'Sail Slash',      kind: 'attack', power: 40, acc: 0.90, effect: 'atk_up_self',  cd: 2, signature: true },
  deep_crush:   { name: 'Deep Crush',      kind: 'attack', power: 50, acc: 0.80, effect: 'stun', chance: 0.50, cd: 3, signature: true },
  tusk_charge:  { name: 'Tusk Charge',     kind: 'attack', power: 52, acc: 0.82, effect: 'stun', chance: 0.40, cd: 2, signature: true },
  earthshaker:  { name: 'Earthshaker',     kind: 'attack', power: 54, acc: 0.80, effect: 'stun', chance: 0.45, cd: 3, signature: true },
  devour:       { name: 'Devour',          kind: 'attack', power: 50, acc: 0.82, effect: 'lifesteal',    cd: 3, signature: true },
  sky_terror:   { name: 'Sky Terror',      kind: 'attack', power: 46, acc: 0.85, effect: 'stun', chance: 0.40, cd: 2, signature: true },
  abyssal_bite: { name: 'Abyssal Bite',    kind: 'attack', power: 56, acc: 0.80,                          cd: 2, signature: true },
  primordial:   { name: 'Primordial Surge',kind: 'attack', power: 34, acc: 0.90, effect: 'bleed_atkdown', cd: 2, signature: true },

  /* signatures for the new apex legendaries (defined now, reachable only once
     their species' art lands and `pending` is removed). */
  serrated_bite:  { name: 'Serrated Bite',  kind: 'attack', power: 50, acc: 0.85, effect: 'bleed',        cd: 2, signature: true },
  constrict:      { name: 'Constrict',      kind: 'attack', power: 38, acc: 0.90, effect: 'stun', chance: 0.50, cd: 3, signature: true },
  raking_bite:    { name: 'Raking Bite',    kind: 'attack', power: 52, acc: 0.82, effect: 'lifesteal',    cd: 3, signature: true },
  death_roll:     { name: 'Death Roll',     kind: 'attack', power: 46, acc: 0.85, effect: 'stun', chance: 0.45, cd: 3, signature: true },
  crushing_jaws:  { name: 'Crushing Jaws',  kind: 'attack', power: 58, acc: 0.78,                          cd: 2, signature: true },
};

/** Marquee species → their signature move (added as a 4th option). */
export const SIGNATURES = {
  trex: 'apex_bite', spino: 'sail_slash', mosa: 'deep_crush', mammoth: 'tusk_charge',
  argent: 'earthshaker', megashark: 'devour', quetz: 'sky_terror', liopl: 'abyssal_bite',
  anomal: 'primordial',
  carchar: 'serrated_bite', titanoboa: 'constrict', livyatan: 'raking_bite',
  sarco: 'death_roll', pliosaur: 'crushing_jaws',
};

/* ── SPECIES → ARCHETYPE ─────────────────────────────────────────────────
   Every one of the 84 species is mapped by its nature: carnivore bulk →
   brute, armour/frills/sauropod heft → tank or colossus, agile predators →
   striker, small quick movers → skirmisher, fliers → aerial, marine → aquatic.
   Authored as data rather than guessed from the name at runtime, so adding a
   species is one deliberate line and a stray id can't silently fall through.
   archetypeFor() still has a rarity-based fallback for any id not listed. */
export const SPECIES_ARCHETYPE = {
  /* common */
  compy: 'skirmisher', proto: 'tank', galli: 'skirmisher', coelo: 'skirmisher',
  dimetro: 'striker', iguan: 'tank', dimor: 'aerial', pachy: 'tank',
  kentro: 'tank', ovira: 'skirmisher', micro: 'aerial', archae: 'aerial',
  dodo: 'skirmisher', ornitho: 'skirmisher', guanl: 'striker', hetero: 'skirmisher',
  plat: 'tank', psitt: 'skirmisher', sinosaur: 'skirmisher', ptdac: 'aerial',
  /* uncommon */
  raptor: 'striker', dilopho: 'striker', stego: 'tank', para: 'tank',
  baryo: 'striker', cory: 'tank', styra: 'tank', rhamph: 'aerial',
  ichthy: 'aquatic', megalo: 'brute', utah: 'striker', deino: 'striker',
  cerato: 'striker', trood: 'skirmisher', concav: 'striker', stygi: 'tank',
  anhan: 'aerial', tape: 'aerial', nycto: 'aerial', notho: 'aquatic',
  archel: 'aquatic', tbird: 'striker', cbear: 'brute', dwolf: 'striker',
  glypto: 'tank', entelo: 'brute',
  /* rare */
  trike: 'tank', allo: 'brute', anky: 'tank', diplo: 'colossus',
  carno: 'striker', plesio: 'aquatic', pterano: 'aerial', brachio: 'colossus',
  smilo: 'striker', therizo: 'brute', amarg: 'tank', cryo: 'striker',
  deinoch: 'skirmisher', mamen: 'colossus', tylo: 'aquatic', shoni: 'aquatic',
  heli: 'aquatic', megarach: 'striker', wrhino: 'colossus', clion: 'striker',
  gsloth: 'colossus', masto: 'colossus',
  /* epic */
  trex: 'brute', spino: 'brute', apato: 'colossus', gigano: 'brute',
  mosa: 'aquatic', bronto: 'colossus', mammoth: 'colossus', elasmo: 'aquatic',
  hatz: 'aerial', dunky: 'aquatic', krono: 'aquatic', andrew: 'brute',
  /* legendary */
  argent: 'colossus', megashark: 'aquatic', quetz: 'aerial', liopl: 'aquatic',
  anomal: 'aquatic',
  /* new species (mapped now; the pending ones are unreachable until their art
     lands and `pending` is removed in dino-species.js — but the invariant
     "every species has an archetype" holds regardless). */
  carchar: 'brute', titanoboa: 'striker', livyatan: 'aquatic', sarco: 'aquatic',
  pliosaur: 'aquatic', yuty: 'brute',
  acro: 'brute', tarbo: 'brute', sucho: 'striker', megalania: 'striker',
  gigapith: 'brute', basilo: 'aquatic', patago: 'colossus',
};

/* A rarity-keyed fallback so an unmapped id still gets a sane role rather
   than throwing. Higher rarities lean toward the heavy hitters. */
const FALLBACK_ARCHETYPE = {
  common: 'skirmisher', uncommon: 'striker', rare: 'tank', epic: 'brute', legendary: 'colossus',
};

export function archetypeFor(speciesId, rarity) {
  if (SPECIES_ARCHETYPE[speciesId]) return SPECIES_ARCHETYPE[speciesId];
  const r = rarity || (SPECIES[speciesId] && SPECIES[speciesId].rarity) || 'common';
  return FALLBACK_ARCHETYPE[r] || 'skirmisher';
}

/** The move ids a species can use: its archetype kit plus any signature. */
export function movesetFor(speciesId, rarity) {
  const arch = ARCHETYPES[archetypeFor(speciesId, rarity)];
  const base = arch ? arch.moves.slice() : ['bite'];
  const sig = SIGNATURES[speciesId];
  if (sig && !base.includes(sig)) base.push(sig);
  return base;
}

/**
 * The combat stats for a dino description. Pure: no roster lookup for rarity,
 * the caller passes the authoritative rarity (the route reads it from the
 * SPECIES table, never from the client). Returns integers, hp doubling as the
 * starting/maximum HP.
 */
export function deriveStats({ speciesId, rarity, mutation, battleXp, level } = {}) {
  const r = TIER_MULT[rarity] ? rarity : 'common';
  const tier = TIER_MULT[r];
  const arch = ARCHETYPES[archetypeFor(speciesId, r)] || ARCHETYPES.skirmisher;
  const lv = level != null ? Math.max(1, Math.min(LEVEL_CAP, Math.floor(level))) : battleLevelFromXp(battleXp);
  const levelMult = 1 + PER_LEVEL * (lv - 1);
  const mut = mutation ? MUT_MULT : 1;
  const stat = (key) => Math.max(1, Math.round(BASE[key] * arch.bias[key] * tier * levelMult * mut));
  return {
    hp: stat('hp'), maxHp: stat('hp'),
    atk: stat('atk'), def: stat('def'), spd: stat('spd'),
    level: lv, archetype: archetypeFor(speciesId, r),
  };
}

/* ── RNG ────────────────────────────────────────────────────────────────
   An LCG in the same family as the game's seededRand, but carried on the
   battle object as a plain integer so the whole fight round-trips through
   storage and replays bit-for-bit. Every draw advances battle.rng; nothing in
   here calls Math.random, so resolution is deterministic. */
export function seedToInt(seed) {
  let n = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
  return n || 1;
}

function nextRand(battle) {
  battle.rng = (battle.rng * 1664525 + 1013904223) >>> 0;
  return ((battle.rng >>> 16) & 0x7fff) / 32768;
}

/* ── COMBATANTS & TEAMS ─────────────────────────────────────────────────
   A combatant is a plain object (JSON-safe). Buffs/debuffs are a multiplier
   plus a turn counter per stat; a value <1 is a debuff, >1 a buff. `guarding`
   is a single turn's damage halving, cleared at end of turn. `stun` skips the
   next action. `cool` maps a move id to turns-until-usable. */
export function makeCombatant(src) {
  const speciesId = src.speciesId;
  const rarity = src.rarity || (SPECIES[speciesId] && SPECIES[speciesId].rarity) || 'common';
  const stats = deriveStats({ speciesId, rarity, mutation: src.mutation, battleXp: src.battleXp, level: src.level });
  return {
    uid: src.uid || null,
    speciesId, rarity, mutation: src.mutation || null,
    name: String(src.name || speciesId).slice(0, 32),
    level: stats.level, archetype: stats.archetype,
    maxHp: stats.maxHp, hp: stats.maxHp,
    atk: stats.atk, def: stats.def, spd: stats.spd,
    moves: movesetFor(speciesId, rarity),
    cool: {},
    stun: 0,
    bleedTurns: 0, bleedDmg: 0,
    atkMult: 1, atkTurns: 0,
    defMult: 1, defTurns: 0,
    spdMult: 1, spdTurns: 0,
    guarding: false,
  };
}

const effAtk = (c) => Math.max(1, Math.round(c.atk * (c.atkTurns > 0 ? c.atkMult : 1)));
const effDef = (c) => Math.max(1, Math.round(c.def * (c.defTurns > 0 ? c.defMult : 1)));
const effSpd = (c) => Math.max(1, Math.round(c.spd * (c.spdTurns > 0 ? c.spdMult : 1)));

export function activeOf(side) { return side.team[side.active]; }
function aliveIndex(side) { return side.team.findIndex(c => c.hp > 0); }

/** Legal move ids for a combatant right now (excludes ones on cooldown). */
export function legalMoves(c) {
  return c.moves.filter(id => MOVES[id] && !(c.cool[id] > 0));
}

/* ── MOVE PICKERS ───────────────────────────────────────────────────────
   A picker chooses one legal move id for a side. This is the whole PvP seam:
   PvE opponents use these named strategies; an async-PvP opponent later is
   just another picker over a snapshot team, and the engine never has to
   change. Selectable by name so a picker survives in stored battle state (a
   function can't), with an override hook for tests. */
function strongestAttack(c) {
  const atks = legalMoves(c).filter(id => MOVES[id].kind === 'attack');
  if (!atks.length) return legalMoves(c)[0] || c.moves[0];
  return atks.sort((a, b) => MOVES[b].power - MOVES[a].power)[0];
}
function firstOf(c, kinds) {
  return legalMoves(c).find(id => kinds.includes(MOVES[id].kind));
}

export const PICKERS = {
  aggressive(battle, side) {
    const c = activeOf(battle[side]);
    return strongestAttack(c);
  },
  balanced(battle, side) {
    const me = activeOf(battle[side]);
    const foe = activeOf(battle[side === 'a' ? 'b' : 'a']);
    const low = me.hp < me.maxHp * 0.35;
    if (low) {
      const heal = firstOf(me, ['defend']);
      if (heal) return heal;
    }
    /* Spend a status special early, while it still has a fight to pay off in
       and the foe isn't already suffering it. */
    const special = legalMoves(me).find(id => MOVES[id].cd && MOVES[id].effect);
    if (special) {
      const e = MOVES[special].effect;
      const wasteful = (e === 'bleed' && foe.bleedTurns > 0) || ((e === 'stun') && foe.stun > 0);
      if (!wasteful && foe.hp > foe.maxHp * 0.25) return special;
    }
    return strongestAttack(me);
  },
  defensive(battle, side) {
    const me = activeOf(battle[side]);
    if (me.hp < me.maxHp * 0.6) {
      const guard = firstOf(me, ['defend', 'buff']);
      if (guard) return guard;
    }
    return strongestAttack(me);
  },
  random(battle, side) {
    const opts = legalMoves(activeOf(battle[side]));
    return opts[Math.floor(nextRand(battle) * opts.length)] || opts[0];
  },
};

/**
 * Build a battle. Opponent-agnostic: `a` and `b` are each { team:[dinoDesc],
 * ai?:pickerName }. `a` is the side a human may drive (ai optional, so PvP can
 * set it); `b` is normally the opponent with an ai. `seed` makes the whole
 * fight reproducible. `meta` is free-form data the route attaches (opponent
 * tier/kind) and the engine only reads for nothing — it is carried through for
 * the reward calc, which is also pure.
 */
export function createBattle({ a, b, seed, meta } = {}) {
  const battle = {
    rng: seedToInt(seed == null ? Date.now() : seed),
    seed: String(seed == null ? '' : seed),
    turn: 1,
    status: 'active',          // active | won | lost
    a: { team: (a.team || []).map(makeCombatant), active: 0, ai: a.ai || null },
    b: { team: (b.team || []).map(makeCombatant), active: 0, ai: b.ai || null },
    log: [],
    meta: meta || {},
  };
  return battle;
}

function tickBuffs(c) {
  if (c.atkTurns > 0 && --c.atkTurns === 0) c.atkMult = 1;
  if (c.defTurns > 0 && --c.defTurns === 0) c.defMult = 1;
  if (c.spdTurns > 0 && --c.spdTurns === 0) c.spdMult = 1;
  for (const id of Object.keys(c.cool)) if (c.cool[id] > 0) c.cool[id]--;
  c.guarding = false;
}

function resolveAttack(battle, attacker, defender, move, log) {
  const hit = nextRand(battle) < (move.acc == null ? 1 : move.acc);
  if (!hit) {
    log.push({ t: 'miss', by: attacker.name, move: move.name });
    return 0;
  }
  const variance = 0.85 + nextRand(battle) * 0.30;          // 0.85 .. 1.15
  let raw = move.power * (effAtk(attacker) / (effAtk(attacker) + effDef(defender))) * 2.2 * variance;
  if (defender.guarding) raw *= 0.5;
  const dmg = Math.max(1, Math.round(raw));
  defender.hp = Math.max(0, defender.hp - dmg);
  log.push({ t: 'hit', by: attacker.name, move: move.name, dmg, hp: defender.hp, guarded: !!defender.guarding });

  /* On-hit effects. */
  switch (move.effect) {
    case 'stun':
      if (nextRand(battle) < (move.chance || 0)) { defender.stun = 1; log.push({ t: 'status', who: defender.name, status: 'stunned' }); }
      break;
    case 'bleed':
      defender.bleedTurns = 3; defender.bleedDmg = Math.max(1, Math.round(defender.maxHp * 0.06));
      log.push({ t: 'status', who: defender.name, status: 'bleeding' });
      break;
    case 'bleed_atkdown':
      defender.bleedTurns = 3; defender.bleedDmg = Math.max(1, Math.round(defender.maxHp * 0.06));
      defender.atkMult = 0.75; defender.atkTurns = 2;
      log.push({ t: 'status', who: defender.name, status: 'weakened & bleeding' });
      break;
    case 'atk_up_self':
      attacker.atkMult = 1.25; attacker.atkTurns = 2;
      log.push({ t: 'status', who: attacker.name, status: 'enraged' });
      break;
    case 'lifesteal': {
      const heal = Math.max(1, Math.round(dmg * 0.4));
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + heal);
      log.push({ t: 'heal', who: attacker.name, amount: heal, hp: attacker.hp });
      break;
    }
    default: break;
  }
  return dmg;
}

function resolveSupport(attacker, defender, move, log) {
  switch (move.effect) {
    case 'guard_heal': {
      attacker.guarding = true; attacker.defMult = 1.4; attacker.defTurns = 2;
      const heal = Math.round(attacker.maxHp * 0.08);
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + heal);
      log.push({ t: 'defend', who: attacker.name, move: move.name, heal, hp: attacker.hp });
      break;
    }
    case 'guard_big': {
      attacker.guarding = true; attacker.defMult = 1.6; attacker.defTurns = 2;
      const heal = Math.round(attacker.maxHp * 0.05);
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + heal);
      log.push({ t: 'defend', who: attacker.name, move: move.name, heal, hp: attacker.hp });
      break;
    }
    case 'heal_guard': {
      attacker.guarding = true;
      const heal = Math.round(attacker.maxHp * 0.18);
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + heal);
      log.push({ t: 'defend', who: attacker.name, move: move.name, heal, hp: attacker.hp });
      break;
    }
    case 'spd_guard':
      attacker.guarding = true; attacker.spdMult = 1.5; attacker.spdTurns = 2;
      log.push({ t: 'defend', who: attacker.name, move: move.name });
      break;
    case 'atk_down':
      defender.atkMult = 0.75; defender.atkTurns = 2;
      log.push({ t: 'status', who: defender.name, status: 'weakened' });
      break;
    default:
      log.push({ t: 'defend', who: attacker.name, move: move.name });
      break;
  }
}

/** One combatant takes its chosen action. Mutates in place, appends to log. */
function takeAction(battle, actorSide, moveId, log) {
  const me = activeOf(battle[actorSide]);
  const foeSide = actorSide === 'a' ? 'b' : 'a';
  const foe = activeOf(battle[foeSide]);
  if (me.hp <= 0) return;

  if (me.stun > 0) {
    me.stun--;
    log.push({ t: 'stunned', who: me.name });
    return;
  }

  const move = MOVES[moveId];
  if (!move) { log.push({ t: 'skip', who: me.name }); return; }
  if (move.cd) me.cool[moveId] = move.cd;

  if (move.kind === 'attack') resolveAttack(battle, me, foe, move, log);
  else resolveSupport(me, foe, move, log);
}

function endOfTurn(battle, log) {
  for (const sideName of ['a', 'b']) {
    const c = activeOf(battle[sideName]);
    if (!c) continue;
    if (c.hp > 0 && c.bleedTurns > 0) {
      c.hp = Math.max(0, c.hp - c.bleedDmg);
      c.bleedTurns--;
      log.push({ t: 'bleed', who: c.name, dmg: c.bleedDmg, hp: c.hp });
    }
    tickBuffs(c);
  }
}

/* After any damage, swap in the next living team member or end the battle.
   With single-dino teams this only ever ends the battle, but the switch is
   where multi-dino teams bolt on with no change to the turn loop. */
function settleKOs(battle) {
  for (const sideName of ['a', 'b']) {
    const side = battle[sideName];
    if (side.team[side.active] && side.team[side.active].hp <= 0) {
      const next = aliveIndex(side);
      if (next !== -1) side.active = next;
    }
  }
  if (aliveIndex(battle.a) === -1) battle.status = 'lost';
  else if (aliveIndex(battle.b) === -1) battle.status = 'won';
}

/**
 * Advance one full turn: both active combatants act in SPD order (ties broken
 * by the seeded RNG), then end-of-turn statuses resolve.
 *
 * `choices.aMove` is side A's move; if side A has an ai and no move is given it
 * is picked, which is how PvP (both sides ai) runs. `choices.pickers` overrides
 * the named picker registry — the explicit seam the tests use to prove the
 * engine resolves ANY two teams with ANY pickers, with no "wild" coupling.
 *
 * Returns { ended, status, log } where log is only THIS turn's entries.
 */
export function stepTurn(battle, choices = {}) {
  if (battle.status !== 'active') return { ended: true, status: battle.status, log: [] };
  const pickers = { ...PICKERS, ...(choices.pickers || {}) };
  const log = [];

  const moveFor = (sideName, explicit) => {
    if (explicit != null) return explicit;
    const ai = battle[sideName].ai;
    const pick = ai && pickers[ai] ? pickers[ai] : pickers.balanced;
    return pick(battle, sideName);
  };

  const aMove = moveFor('a', choices.aMove);
  const bMove = moveFor('b', choices.bMove);

  const order = effSpd(activeOf(battle.a)) === effSpd(activeOf(battle.b))
    ? (nextRand(battle) < 0.5 ? ['a', 'b'] : ['b', 'a'])
    : (effSpd(activeOf(battle.a)) > effSpd(activeOf(battle.b)) ? ['a', 'b'] : ['b', 'a']);

  for (const sideName of order) {
    if (battle.status !== 'active') break;
    takeAction(battle, sideName, sideName === 'a' ? aMove : bMove, log);
    settleKOs(battle);
  }

  if (battle.status === 'active') {
    endOfTurn(battle, log);
    settleKOs(battle);
    battle.turn++;
  }

  battle.log.push(...log);
  return { ended: battle.status !== 'active', status: battle.status, log };
}

/** Run a battle to completion (both sides driven by ai/pickers). For PvP and
    for tests; the live PvE route drives side A one stepTurn per request. */
export function resolveToEnd(battle, pickers) {
  let guard = 0;
  while (battle.status === 'active' && guard++ < 500) {
    stepTurn(battle, { pickers });
  }
  return battle.status;
}

/* ── REWARDS ────────────────────────────────────────────────────────────
   Pure, so the route settles coins/XP/eggs from numbers it can re-derive
   and never trusts the client for a payout. Scaled to opponent difficulty
   (meta.level/tier); a loss pays only a little "training" XP so energy is the
   real cost; a boss win rolls an egg off the battle's own RNG so the roll is
   deterministic and testable. */
const REWARD = { coinBase: 10, coinPerLevel: 2, xpBase: 14, xpPerLevel: 3, bossCoinBonus: 25, lossXp: 4 };
export const BOSS_EGG_CHANCE = 0.5;

export function computeRewards(battle) {
  const win = battle.status === 'won';
  const meta = battle.meta || {};
  const lvl = Math.max(1, Math.floor(Number(meta.level) || 1));
  const tier = Math.max(1, Math.floor(Number(meta.tier) || 1));
  const isBoss = meta.kind === 'boss';
  const tierFactor = 1 + 0.15 * (tier - 1);

  if (!win) return { win: false, coins: 0, xp: REWARD.lossXp, bossEgg: null };

  const coins = Math.round((REWARD.coinBase + lvl * REWARD.coinPerLevel) * tierFactor) + (isBoss ? REWARD.bossCoinBonus : 0);
  const xp = Math.round((REWARD.xpBase + lvl * REWARD.xpPerLevel) * tierFactor);

  let bossEgg = null;
  if (isBoss) {
    /* One draw off the battle RNG so a replay yields the same egg. A bump to
       'epic' on a second, rarer draw gives the boss its payoff. */
    if (nextRand(battle) < BOSS_EGG_CHANCE) bossEgg = nextRand(battle) < 0.2 ? 'epic' : 'rare';
  }
  return { win: true, coins, xp, bossEgg };
}

/* ── CLIENT VIEW ────────────────────────────────────────────────────────
   What the route may safely return to the browser: the visible state of both
   combatants, the player's move options with their cooldown state, and the
   log. The RNG and ai names are omitted — not because exposing them enables
   cheating (the server resolves regardless), but because the client has no use
   for them and a smaller surface is a clearer contract. */
function viewCombatant(c) {
  return {
    uid: c.uid, speciesId: c.speciesId, rarity: c.rarity, mutation: c.mutation,
    name: c.name, level: c.level, archetype: c.archetype,
    hp: c.hp, maxHp: c.maxHp, atk: c.atk, def: c.def, spd: c.spd,
    stun: c.stun, bleedTurns: c.bleedTurns,
    atkMult: c.atkTurns > 0 ? c.atkMult : 1, defMult: c.defTurns > 0 ? c.defMult : 1, spdMult: c.spdTurns > 0 ? c.spdMult : 1,
  };
}

export function publicView(battle) {
  const you = activeOf(battle.a), foe = activeOf(battle.b);
  return {
    turn: battle.turn,
    status: battle.status,
    you: viewCombatant(you),
    foe: viewCombatant(foe),
    moves: you.moves.map(id => ({
      id, name: MOVES[id].name, kind: MOVES[id].kind, power: MOVES[id].power || 0,
      acc: MOVES[id].acc == null ? 1 : MOVES[id].acc, effect: MOVES[id].effect || null,
      cd: MOVES[id].cd || 0, cool: you.cool[id] || 0, signature: !!MOVES[id].signature,
    })),
    log: battle.log.slice(-40),
    meta: { tier: battle.meta.tier || 1, kind: battle.meta.kind || 'wild', opponentId: battle.meta.opponentId || '' },
  };
}
