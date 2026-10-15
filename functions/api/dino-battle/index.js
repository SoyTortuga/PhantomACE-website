/* ══════════════════════════════════════════════
   DINO BATTLE — the server-authoritative PvE route

     GET  /api/dino-battle   → energy, today's opponents, your eligible dinos,
                               and any battle already in progress
     POST /api/dino-battle   → { action: 'start'|'move'|'forfeit', ... }

   THE SERVER OWNS THE FIGHT. The client sends only a move id; every number —
   damage, hit/miss, status rolls, the win itself, and therefore the reward —
   is computed here from a seed the client never sees, by the pure engine in
   ./engine.js. A request body claiming `win: true` or a damage figure is
   ignored by construction: nothing in here reads anything off the body except
   the action, the chosen dino's uid, the opponent id, and the move id.

   ENERGY is the decision-gate. A small daily pool (ENERGY_MAX), regenerated on
   the Pacific day boundary via season-time.js, so battling is a choice about
   which fights are worth it rather than a grind. Stored per user, with the day
   stamped in the value so a stale row simply reads as "new day, full pool".

   REWARDS settle against the player's PARK SAVE — the same document grantEgg
   writes — riding the existing grantSeq + marketOps protocol (applyCoins for
   coins, a 'carexp' op that adds to the dino's shared `xp` pool — the same
   level caring raises), so a stale client save cannot clobber a payout and the
   browser reconciles it exactly once. A boss win rolls
   an egg through grantEgg. No leaderboard — per the project's "every mechanic
   is a decision, Dino Park keeps no boards" rule.
   ══════════════════════════════════════════════ */

import { SPECIES, ROSTER_BY_RARITY } from '../dino-species.js';
import { dayKey } from '../season-time.js';
import { saveKey, findDinoByUid, applyCoins, pushParkOp, grantEgg } from '../dino-park.js';
import {
  createBattle, stepTurn, computeRewards, publicView, deriveStats,
  movesetFor, careLevelFromXp, careXpProgress, legalMoves, activeOf, seedToInt, MOVES,
} from './engine.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* ── Keys (registered in server/lib/registry.js) ──
   Both 'none' expiry singletons: the energy row's in-value `day` is the real
   reset rule (a TTL would wipe the pool mid-day), and an abandoned battle is
   self-healed by its own `startedAt` rather than by storage expiry. */
const energyKey = (userId) => `dino_battle_energy_${userId}`;
const battleKey = (userId) => `dino_battle_state_${userId}`;

const ENERGY_MAX = 5;
/* A battle nobody finished is treated as abandoned after this, so a new one
   can start. Forfeit is the clean path; this is the backstop for a closed tab. */
const BATTLE_TTL_MS = 6 * 60 * 60 * 1000;

/* ── PvE opponents ──────────────────────────────────────────────────────
   Five challengers a day, one per difficulty tier, drawn from the roster at
   that tier's rarity and seeded off the Pacific day key so the roster is
   stable for the day and rotates at the same boundary everything else does.
   The boss is a mutated legendary with the egg payoff. The engine knows
   none of this — it is handed a team and an ai picker name. */
const OPP_TIERS = [
  { tier: 1, kind: 'wild', rarity: 'common',    level: 3,  ai: 'balanced'   },
  { tier: 2, kind: 'wild', rarity: 'uncommon',  level: 6,  ai: 'balanced'   },
  { tier: 3, kind: 'wild', rarity: 'rare',      level: 10, ai: 'defensive'  },
  { tier: 4, kind: 'wild', rarity: 'epic',      level: 16, ai: 'aggressive' },
  { tier: 5, kind: 'boss', rarity: 'legendary', level: 22, ai: 'aggressive' },
];

/* Deterministic index from the day key + tier, so every player sees the same
   daily line-up and start() can rebuild the exact opponent from its id rather
   than trust one off the request. */
function pick(dayStr, tier, poolLen) {
  const n = (seedToInt(dayStr + ':' + tier) >>> 0);
  return poolLen ? n % poolLen : 0;
}

function buildOpponents(dayStr) {
  return OPP_TIERS.map(t => {
    const pool = ROSTER_BY_RARITY[t.rarity] || [];
    const speciesId = pool.length ? pool[pick(dayStr, t.tier, pool.length)] : 'compy';
    const meta = SPECIES[speciesId] || {};
    const mutation = t.kind === 'boss' ? 'phantomace' : null;
    const stats = deriveStats({ speciesId, rarity: t.rarity, mutation, level: t.level });
    return {
      id: `${t.kind}_${t.tier}`, tier: t.tier, kind: t.kind, ai: t.ai,
      speciesId, rarity: t.rarity, mutation, level: t.level,
      name: meta.name || speciesId, icon: meta.icon || '', portrait: meta.portrait || '',
      stats: { hp: stats.maxHp, atk: stats.atk, def: stats.def, spd: stats.spd, archetype: stats.archetype },
    };
  });
}

/* ── Energy ──
   Pure normalisation: a missing or previous-day row becomes a full pool for
   today. Returns the current pool WITHOUT writing — the GET poll stays
   read-only, and the spend on start() is the only write. */
function normalizeEnergy(rec, today) {
  if (rec && rec.day === today && Number.isFinite(Number(rec.count))) {
    return { day: today, count: Math.max(0, Math.min(ENERGY_MAX, Math.floor(rec.count))) };
  }
  return { day: today, count: ENERGY_MAX };
}

/** A park/vault dino, as the battle view and start() need it. */
function eligibleDinos(state) {
  const out = [];
  for (const src of ['park', 'vault']) {
    for (const d of (Array.isArray(state[src]) ? state[src] : [])) {
      if (!d || !d.uid || d.busy) continue;                  // out on an expedition, or not yet uid'd — skip
      const rarity = (SPECIES[d.speciesId] && SPECIES[d.speciesId].rarity) || 'common';
      const xp = Math.max(0, Math.floor(Number(d.xp) || 0));
      const stats = deriveStats({ speciesId: d.speciesId, rarity, mutation: d.mutation, xp });
      out.push({
        uid: d.uid, speciesId: d.speciesId, rarity, mutation: d.mutation || null,
        name: String(d.nickname || (SPECIES[d.speciesId] && SPECIES[d.speciesId].name) || d.speciesId).slice(0, 32),
        source: src, xp, level: careLevelFromXp(xp), levelProgress: careXpProgress(xp),
        stats: { hp: stats.maxHp, atk: stats.atk, def: stats.def, spd: stats.spd, archetype: stats.archetype },
        moves: movesetFor(d.speciesId, rarity).map(id => ({ id, name: MOVES[id].name })),
      });
    }
  }
  return out;
}

function freshBattle(rec) {
  if (!rec || rec.status !== 'active') return null;
  if (Date.now() - Number(rec.startedAt || 0) > BATTLE_TTL_MS) return null;
  return rec;
}

/* ── GET ─────────────────────────────────────────────────────────────── */
export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);

  const today = dayKey();
  const [energyRec, saveRec, battleRec] = await Promise.all([
    env.MARKETPLACE.get(energyKey(session.user_id), 'json'),
    env.MARKETPLACE.get(saveKey(session.user_id), 'json'),
    env.MARKETPLACE.get(battleKey(session.user_id), 'json'),
  ]);

  const energy = normalizeEnergy(energyRec, today);
  const state = (saveRec && saveRec.state) ? saveRec.state : null;
  const active = freshBattle(battleRec);

  return json({
    energy: { count: energy.count, max: ENERGY_MAX },
    opponents: buildOpponents(today),
    dinos: state ? eligibleDinos(state) : [],
    active: active ? publicView(active) : null,
  });
}

/* ── POST ────────────────────────────────────────────────────────────── */
export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);
  const userId = session.user_id;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400);

  if (body.action === 'start') return startBattle(env, userId, body);
  if (body.action === 'move') return submitMove(env, userId, body);
  if (body.action === 'forfeit') return forfeit(env, userId);
  return json({ error: 'Unknown action' }, 400);
}

async function startBattle(env, userId, body) {
  const uid = String(body.uid || '');
  const opponentId = String(body.opponentId || '');
  const today = dayKey();

  /* Refuse a second battle before spending anything. */
  const existing = freshBattle(await env.MARKETPLACE.get(battleKey(userId), 'json'));
  if (existing) return json({ error: 'Finish your current battle first.' }, 409);

  const opponent = buildOpponents(today).find(o => o.id === opponentId);
  if (!opponent) return json({ error: 'That challenger is not available today.' }, 400);

  const saveRec = await env.MARKETPLACE.get(saveKey(userId), 'json');
  const state = (saveRec && saveRec.state) ? saveRec.state : null;
  const found = state ? findDinoByUid(state, uid) : null;
  if (!found || found.dino.busy) return json({ error: 'Pick one of your dinos.' }, 400);
  const d = found.dino;
  const rarity = (SPECIES[d.speciesId] && SPECIES[d.speciesId].rarity) || 'common';

  /* Spend one energy, regenerating first if the day rolled over. Under the
     lock so two tabs can't both spend the last point. */
  let spent = null;
  await env.MARKETPLACE.mutate(energyKey(userId), (rec) => {
    const e = normalizeEnergy(rec, today);
    if (e.count <= 0) { spent = { out: true, energy: e }; return undefined; }
    e.count -= 1;
    spent = { out: false, energy: e };
    return { day: e.day, count: e.count };
  });
  if (!spent || spent.out) return json({ error: 'Out of energy — it refills tomorrow.', energy: { count: 0, max: ENERGY_MAX } }, 400);

  const battle = createBattle({
    a: { team: [{
      uid: d.uid, speciesId: d.speciesId, rarity, mutation: d.mutation || null,
      xp: Math.max(0, Math.floor(Number(d.xp) || 0)),
      name: String(d.nickname || (SPECIES[d.speciesId] && SPECIES[d.speciesId].name) || d.speciesId).slice(0, 32),
    }] },
    b: { ai: opponent.ai, team: [{
      speciesId: opponent.speciesId, rarity: opponent.rarity, mutation: opponent.mutation,
      level: opponent.level, name: opponent.name,
    }] },
    seed: crypto.randomUUID(),
    meta: { tier: opponent.tier, kind: opponent.kind, level: opponent.level, opponentId: opponent.id },
  });
  battle.startedAt = Date.now();

  await env.MARKETPLACE.put(battleKey(userId), JSON.stringify(battle));
  return json({ success: true, battle: publicView(battle), energy: { count: spent.energy.count, max: ENERGY_MAX } });
}

async function submitMove(env, userId, body) {
  const moveId = String(body.moveId || '');
  const battle = freshBattle(await env.MARKETPLACE.get(battleKey(userId), 'json'));
  if (!battle) return json({ error: 'No battle in progress.' }, 400);

  const me = activeOf(battle.a);
  /* A stunned combatant's action is skipped regardless, so any in-kit id is
     accepted then; otherwise the move must be known and off cooldown. The
     client cannot force an outcome — only choose among its own legal moves. */
  if (me.stun <= 0) {
    if (!me.moves.includes(moveId) || !legalMoves(me).includes(moveId)) {
      return json({ error: 'That move is not available.' }, 400);
    }
  }

  const res = stepTurn(battle, { aMove: moveId });

  if (!res.ended) {
    await env.MARKETPLACE.put(battleKey(userId), JSON.stringify(battle));
    return json({ success: true, battle: publicView(battle), ended: false });
  }

  /* Battle over: settle, then clear it. Rewards come straight from the engine's
     pure computeRewards — the server's own numbers, not the client's. */
  const rewards = computeRewards(battle);
  const settlement = await settleRewards(env, userId, battle, rewards);
  await env.MARKETPLACE.delete(battleKey(userId));

  return json({
    success: true, ended: true, battle: publicView(battle),
    result: { win: rewards.win, coins: rewards.coins, xp: rewards.xp, ...settlement },
  });
}

async function forfeit(env, userId) {
  const battle = freshBattle(await env.MARKETPLACE.get(battleKey(userId), 'json'));
  if (!battle) return json({ error: 'No battle in progress.' }, 400);
  battle.status = 'lost';
  const rewards = computeRewards(battle);                 // loss payout only
  const settlement = await settleRewards(env, userId, battle, rewards);
  await env.MARKETPLACE.delete(battleKey(userId));
  return json({ success: true, ended: true, battle: publicView(battle), result: { win: false, coins: 0, xp: rewards.xp, ...settlement } });
}

/**
 * Pay the result into the player's park save, riding the grantSeq/marketOps
 * protocol so a stale client save can't clobber it. Coins via applyCoins (the
 * same 'coins' op the marketplace uses); the XP is CARE XP added to the dino's
 * shared `xp` pool — the same one caring feeds — via a 'carexp' op the client
 * applies to the exact dino by uid. Because the op is a DELTA applied once, the
 * client's own caring XP since the last sync is preserved and the win stacks on
 * top. A boss egg is granted through the existing grantEgg path. Returns what to
 * tell the player.
 */
async function settleRewards(env, userId, battle, rewards) {
  const combatant = activeOf(battle.a);
  const uid = combatant && combatant.uid;
  const out = { eggGranted: false, eggRarity: null, leveledTo: null };

  await env.MARKETPLACE.mutate(saveKey(userId), (rec) => {
    const state = rec && rec.state;
    if (!state) return undefined;                          // no save to settle into
    if (!Array.isArray(state.marketOps)) state.marketOps = [];
    if (!Array.isArray(state.appliedOps)) state.appliedOps = [];

    if (rewards.xp > 0 && uid) {
      const found = findDinoByUid(state, uid);
      if (found) {
        const before = careLevelFromXp(found.dino.xp || 0);
        found.dino.xp = Math.max(0, Math.floor(Number(found.dino.xp) || 0)) + rewards.xp;
        const after = careLevelFromXp(found.dino.xp);
        if (after > before) out.leveledTo = after;
        pushParkOp(state, { t: 'carexp', uid, d: rewards.xp });
      }
    }
    if (rewards.coins > 0) applyCoins(state, rewards.coins, 'battle');

    state.grantSeq = Number(state.grantSeq || 0) + 1;
    return { userId, state, savedAt: Date.now() };
  });

  if (rewards.bossEgg) {
    const egg = await grantEgg(env, userId, rewards.bossEgg);
    if (egg && egg.success) { out.eggGranted = true; out.eggRarity = rewards.bossEgg; }
  }
  return out;
}
