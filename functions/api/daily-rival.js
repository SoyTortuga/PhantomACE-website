/* ══════════════════════════════════════════════
   /api/daily-rival — Dino Park's entry in the Daily Challenges

     GET  /api/daily-rival  → today's rival (the SAME beast for everyone),
                              your eligible dinos, and your result if you have
                              already fought today.
     POST /api/daily-rival  { uid } → send that dino against the rival. The
                              server resolves the whole fight deterministically
                              and settles the reward. ONE attempt per Pacific
                              day, win or lose.

   THE RIVAL IS DETERMINISTIC FROM THE DAY KEY. Species, rarity, level and ai
   are seeded off season-time.dayKey() exactly the way the Daily Rite seeds its
   question, so everyone faces the identical challenger and it cannot be
   rerolled. It rotates at the same Pacific midnight every other cycle does.

   THE SERVER OWNS THE FIGHT. The client sends only which of its own dinos to
   send in; the engine (./dino-battle/engine.js) resolves every number from a
   seed the client never sees, so a forged "I won" in the body changes nothing.
   The battle is auto-resolved (both sides driven by ai pickers) — the player's
   decision is WHICH dino to commit against a rival whose archetype and stats
   are shown up front, and they commit it once a day.

   DONE-ON-ATTEMPT, REWARD-ON-WIN, mirroring the Rite. Completing the fight is
   what marks the daily done for the hub streak (markDailyComplete); winning is
   what pays Dino Park's OWN currency — coins plus care XP into the champion's
   shared xp pool, the same level caring raises. A loss pays only a little
   training XP. NO giveaway entries here: the site-wide meta reward for clearing
   every daily is the framework's job, so this never double-pays.

   SETTLEMENT rides the save's grantSeq/marketOps protocol (applyCoins + a
   'carexp' op), exactly like the energy-gated battle route, so a stale client
   save cannot clobber the payout and the browser reconciles it once.

   Route with handlers — NOT a NON_ROUTE library. One KV prefix:
     dino_rival_<userId> — one row per player: { day, uid, win, ... }. The
     in-value `day` is the once-a-day guard and the reset rule (a row from a
     previous day reads as "not fought today"), so expiry 'none'.
   ══════════════════════════════════════════════ */

import { SPECIES, ROSTER_BY_RARITY } from './dino-species.js';
import { dayKey } from './season-time.js';
import { saveKey, findDinoByUid, applyCoins, pushParkOp } from './dino-park.js';
import {
  createBattle, resolveToEnd, deriveStats, movesetFor,
  careLevelFromXp, careXpProgress, seedToInt, MOVES,
} from './dino-battle/engine.js';
import { markDailyComplete } from './daily/state.js';

const DAILY_ID = 'dino-rival';
const rivalKey = (userId) => `dino_rival_${userId}`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* ── THE DAILY RIVAL ──────────────────────────────────────────────────────
   A pool of challenger shapes; the day key picks one, then picks the exact
   species from that rarity's roster. Legendary days wear the phantomace
   mutation for flavour. Everything here is a pure function of the day string —
   two calls on the same day return the identical rival. */
const RIVAL_POOL = [
  { rarity: 'uncommon',  level: 8,  ai: 'balanced'   },
  { rarity: 'rare',      level: 12, ai: 'defensive'  },
  { rarity: 'epic',      level: 16, ai: 'aggressive' },
  { rarity: 'rare',      level: 14, ai: 'balanced'   },
  { rarity: 'epic',      level: 18, ai: 'aggressive' },
  { rarity: 'legendary', level: 22, ai: 'aggressive' },
  { rarity: 'uncommon',  level: 10, ai: 'balanced'   },
];

function seededIndex(seed, len) {
  return len ? (seedToInt(seed) >>> 0) % len : 0;
}

export function todaysRival(day = dayKey()) {
  const shape = RIVAL_POOL[seededIndex('dino-rival:' + day, RIVAL_POOL.length)];
  const pool = ROSTER_BY_RARITY[shape.rarity] || [];
  const speciesId = pool.length ? pool[seededIndex('dino-rival-species:' + day, pool.length)] : 'compy';
  const meta = SPECIES[speciesId] || {};
  const mutation = shape.rarity === 'legendary' ? 'phantomace' : null;
  const stats = deriveStats({ speciesId, rarity: shape.rarity, mutation, level: shape.level });
  return {
    day, speciesId, rarity: shape.rarity, mutation, level: shape.level, ai: shape.ai,
    name: meta.name || speciesId, icon: meta.icon || '', portrait: meta.portrait || '',
    archetype: stats.archetype,
    stats: { hp: stats.maxHp, atk: stats.atk, def: stats.def, spd: stats.spd, archetype: stats.archetype },
  };
}

/** The player's park/vault dinos that are free to fight (not on expedition). */
function eligibleDinos(state) {
  const out = [];
  for (const src of ['park', 'vault']) {
    for (const d of (Array.isArray(state[src]) ? state[src] : [])) {
      if (!d || !d.uid || d.busy) continue;
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

/* ── REWARD ──
   Richer than a wild energy-battle (it is a once-a-day marquee fight), scaled
   off the rival's level. Coins + care XP on a win; a small training XP on a
   loss so a fought dino still learns something. Pure, so the route never trusts
   a client figure. */
const RIVAL_REWARD = { coinBase: 35, coinPerLevel: 4, xpBase: 35, xpPerLevel: 3, lossXp: 8 };

function computeRivalReward(win, rivalLevel) {
  if (!win) return { win: false, coins: 0, xp: RIVAL_REWARD.lossXp };
  const lvl = Math.max(1, Math.floor(Number(rivalLevel) || 1));
  return {
    win: true,
    coins: RIVAL_REWARD.coinBase + lvl * RIVAL_REWARD.coinPerLevel,
    xp: RIVAL_REWARD.xpBase + lvl * RIVAL_REWARD.xpPerLevel,
  };
}

/* A compact, JSON-safe log for the result card. */
function digestLog(battle) {
  return (battle.log || []).slice(-60).map(e => {
    if (e.t === 'hit') return `${e.by} used ${e.move} — ${e.dmg} dmg${e.guarded ? ' (guarded)' : ''}.`;
    if (e.t === 'miss') return `${e.by} used ${e.move} — missed!`;
    if (e.t === 'defend') return `${e.who} used ${e.move}${e.heal ? ` — healed ${e.heal}` : ''}.`;
    if (e.t === 'heal') return `${e.who} recovered ${e.amount} HP.`;
    if (e.t === 'bleed') return `${e.who} bleeds for ${e.dmg}.`;
    if (e.t === 'status') return `${e.who} is ${e.status}.`;
    if (e.t === 'stunned') return `${e.who} is stunned and cannot move!`;
    return '';
  }).filter(Boolean);
}

/* ── GET ─────────────────────────────────────────────────────────────── */
export async function onRequestGet(context) {
  const { env, request } = context;
  const day = dayKey();
  const rival = todaysRival(day);
  const rivalPublic = {
    speciesId: rival.speciesId, rarity: rival.rarity, mutation: rival.mutation,
    level: rival.level, name: rival.name, icon: rival.icon, portrait: rival.portrait,
    archetype: rival.archetype, stats: rival.stats,
  };

  const session = getSession(request);
  if (!session || !session.user_id) return json({ day, loggedIn: false, rival: rivalPublic });

  const [saveRec, rivalRec] = await Promise.all([
    env.MARKETPLACE.get(saveKey(session.user_id), 'json'),
    env.MARKETPLACE.get(rivalKey(session.user_id), 'json'),
  ]);
  const state = (saveRec && saveRec.state) ? saveRec.state : null;
  const mine = rivalRec && rivalRec.day === day ? rivalRec : null;

  return json({
    day, loggedIn: true, rival: rivalPublic,
    dinos: state ? eligibleDinos(state) : [],
    record: mine ? {
      fought: true, win: !!mine.win, championName: mine.championName || null,
      coins: mine.coins || 0, xp: mine.xp || 0, leveledTo: mine.leveledTo || null,
      log: Array.isArray(mine.log) ? mine.log : [],
    } : null,
  });
}

/* ── POST ────────────────────────────────────────────────────────────── */
export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);
  const userId = session.user_id;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  const uid = String((body && body.uid) || '');
  if (!uid) return json({ error: 'Pick one of your dinos.' }, 400);

  const day = dayKey();
  const rival = todaysRival(day);

  /* Read the save to validate the champion and read its real xp/species. The
     authoritative once-a-day guard is the atomic claim on the rival row below,
     not this read. */
  const saveRec = await env.MARKETPLACE.get(saveKey(userId), 'json');
  const state = (saveRec && saveRec.state) ? saveRec.state : null;
  const found = state ? findDinoByUid(state, uid) : null;
  if (!found || found.dino.busy) return json({ error: 'That dino is not ready to fight.' }, 400);
  const d = found.dino;
  const rarity = (SPECIES[d.speciesId] && SPECIES[d.speciesId].rarity) || 'common';
  const championName = String(d.nickname || (SPECIES[d.speciesId] && SPECIES[d.speciesId].name) || d.speciesId).slice(0, 32);

  /* Claim the day atomically. If a row for today already exists, this is a
     repeat attempt — refuse and hand back the stored result without re-fighting
     or re-paying. The whole fight is resolved INSIDE the lock (it is pure and
     deterministic) so two concurrent requests cannot both fight. */
  let claim = null;
  await env.MARKETPLACE.mutate(rivalKey(userId), (cur) => {
    if (cur && cur.day === day) { claim = { already: true, record: cur }; return undefined; }

    const battle = createBattle({
      a: { ai: 'balanced', team: [{
        uid: d.uid, speciesId: d.speciesId, rarity, mutation: d.mutation || null,
        xp: Math.max(0, Math.floor(Number(d.xp) || 0)), name: championName,
      }] },
      b: { ai: rival.ai, team: [{
        speciesId: rival.speciesId, rarity: rival.rarity, mutation: rival.mutation,
        level: rival.level, name: rival.name,
      }] },
      seed: `dino-rival:${day}:${userId}:${uid}`,
      meta: { kind: 'rival', level: rival.level },
    });
    resolveToEnd(battle);
    const win = battle.status === 'won';
    const reward = computeRivalReward(win, rival.level);

    const record = {
      day, uid, win, championName,
      coins: reward.coins, xp: reward.xp, leveledTo: null,
      rivalName: rival.name, rivalSpeciesId: rival.speciesId,
      log: digestLog(battle),
    };
    claim = { already: false, record, reward };
    return record;
  });

  if (!claim) return json({ error: 'Could not reach the pits.' }, 500);

  if (claim.already) {
    const r = claim.record;
    return json({
      error: 'You have already faced today\'s rival.', alreadyFought: true,
      result: { win: !!r.win, coins: r.coins || 0, xp: r.xp || 0, leveledTo: r.leveledTo || null, log: r.log || [] },
      championName: r.championName || null,
    }, 409);
  }

  /* Settle the reward into the save and update the stored record's leveledTo,
     then mark the daily done for the hub (idempotent per day). */
  const settlement = await settleRewards(env, userId, uid, claim.reward);
  if (settlement.leveledTo) {
    await env.MARKETPLACE.mutate(rivalKey(userId), (cur) => {
      if (!cur || cur.day !== day) return undefined;
      cur.leveledTo = settlement.leveledTo;
      return cur;
    });
  }
  const daily = await markDailyComplete(env, userId, session.display_name, DAILY_ID);

  const r = claim.record;
  return json({
    success: true,
    result: {
      win: !!r.win, coins: claim.reward.coins, xp: claim.reward.xp,
      leveledTo: settlement.leveledTo, log: r.log,
    },
    championName,
    cleared: !!(daily && daily.newlyCleared),
    streak: daily && daily.streak,
  });
}

/**
 * Pay the result into the player's park save, riding the grantSeq/marketOps
 * protocol so a stale client save cannot clobber it. The XP is CARE XP added to
 * the champion's shared `xp` pool (a 'carexp' delta op applied once by uid), so
 * a win levels the dino exactly as tending it does; coins go through applyCoins.
 */
async function settleRewards(env, userId, uid, reward) {
  const out = { leveledTo: null };
  await env.MARKETPLACE.mutate(saveKey(userId), (rec) => {
    const state = rec && rec.state;
    if (!state) return undefined;
    if (!Array.isArray(state.marketOps)) state.marketOps = [];
    if (!Array.isArray(state.appliedOps)) state.appliedOps = [];

    if (reward.xp > 0 && uid) {
      const found = findDinoByUid(state, uid);
      if (found) {
        const before = careLevelFromXp(found.dino.xp || 0);
        found.dino.xp = Math.max(0, Math.floor(Number(found.dino.xp) || 0)) + reward.xp;
        const after = careLevelFromXp(found.dino.xp);
        if (after > before) out.leveledTo = after;
        pushParkOp(state, { t: 'carexp', uid, d: reward.xp });
      }
    }
    if (reward.coins > 0) applyCoins(state, reward.coins, 'rival');

    state.grantSeq = Number(state.grantSeq || 0) + 1;
    return { userId, state, savedAt: Date.now() };
  });
  return out;
}
