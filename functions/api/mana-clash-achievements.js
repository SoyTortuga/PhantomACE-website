/* ══════════════════════════════════════════════
   MANA CLASH ACHIEVEMENTS → cosmetic dice unlocks

   Players earn cosmetic dice sets by hitting Mana Clash milestones. This
   module is self-contained: it owns the per-user progress record under
   `mc_ach_<userId>`, maps each milestone to a dice set, and grants the dice
   directly into the shared inventory (`inv_<userId>`) the same way every
   other server-side minter does — idempotently, under the row's lock.

   mana-clash.js calls recordManaClashAchievement() when something happens;
   the game page reads onRequestGet() to render the Achievements panel and
   loadDiceSets() then surfaces any newly-owned set in the dice picker.

   THE REWARD DICE SETS (firstblood / highroller / warpath / sixshooter /
   marathon / devotee) are defined in games/mana-clash/index.html's DICE_SETS
   map and its dice-set CSS. The `id` here is the DICE_SETS key — that is the
   whole contract: an inventory item of type 'dice', game 'mana-clash', whose
   id matches a DICE_SETS key, shows up owned in the picker.
   ══════════════════════════════════════════════ */

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

/* ── Tuning ──────────────────────────────────── */
const ACH_PREFIX = 'mc_ach_';
const HIGH_ROLLER_MIN = 2000;   // points banked in one turn for High Roller
const STREAK_REQUIRED = 3;      // wins in a row for Warpath
const DAILY_REQUIRED = 5;       // distinct days of the Daily Challenge for Devotee
const MARATHON_GOAL = 20000;    // winning a game at this target is Marathoner

function achKey(userId) { return ACH_PREFIX + userId; }

/* A reward is an inventory dice item. `cls` is carried only for the client
   (the Achievements panel draws a sample die with it); it is NOT written into
   the inventory row, which needs only id/type/game/name/rarity. */
function dice(id, name, rarity, cls) {
  return { id, type: 'dice', game: 'mana-clash', name, rarity, cls };
}

/* ── Catalog ─────────────────────────────────────
   `met(progress)` is the single source of truth for "is this unlocked" — the
   recorder recomputes every predicate after each event and diffs against the
   stored set, so an achievement can never be half-unlocked. `progress(p)`
   returns {cur, goal} purely for the client's progress bar. */
export const ACHIEVEMENTS = [
  {
    id: 'mc-first-win',
    name: 'First Blood',
    desc: 'Win your first ranked Mana Clash game.',
    reward: dice('firstblood', 'First Blood', 'common', 'set-firstblood'),
    met: (p) => p.rankedWins >= 1,
    progress: (p) => ({ cur: Math.min(p.rankedWins, 1), goal: 1 }),
  },
  {
    id: 'mc-high-roller',
    name: 'High Roller',
    desc: `Bank ${HIGH_ROLLER_MIN.toLocaleString()} or more points in a single turn.`,
    reward: dice('highroller', 'High Roller', 'uncommon', 'set-highroller'),
    met: (p) => p.bestBank >= HIGH_ROLLER_MIN,
    progress: (p) => ({ cur: Math.min(p.bestBank, HIGH_ROLLER_MIN), goal: HIGH_ROLLER_MIN }),
  },
  {
    id: 'mc-streak',
    name: 'Warpath',
    desc: `Win ${STREAK_REQUIRED} games in a row.`,
    reward: dice('warpath', 'Warpath', 'rare', 'set-warpath'),
    met: (p) => p.bestStreak >= STREAK_REQUIRED,
    progress: (p) => ({ cur: Math.min(Math.max(p.streak, p.bestStreak), STREAK_REQUIRED), goal: STREAK_REQUIRED }),
  },
  {
    id: 'mc-six-shooter',
    name: 'Six Shooter',
    desc: 'Roll a six-of-a-kind in a single roll.',
    reward: dice('sixshooter', 'Six Shooter', 'rare', 'set-sixshooter'),
    met: (p) => !!p.sixShooter,
    progress: (p) => ({ cur: p.sixShooter ? 1 : 0, goal: 1 }),
  },
  {
    id: 'mc-marathoner',
    name: 'Marathoner',
    desc: `Win a ${MARATHON_GOAL.toLocaleString()}-point game.`,
    reward: dice('marathon', 'Long Haul', 'mythic', 'set-marathon'),
    met: (p) => !!p.win20k,
    progress: (p) => ({ cur: p.win20k ? 1 : 0, goal: 1 }),
  },
  {
    id: 'mc-daily-devotee',
    name: 'Daily Devotee',
    desc: `Play the Daily Challenge on ${DAILY_REQUIRED} different days.`,
    reward: dice('devotee', 'Daily Devotee', 'uncommon', 'set-devotee'),
    met: (p) => (p.dailyDays || []).length >= DAILY_REQUIRED,
    progress: (p) => ({ cur: (p.dailyDays || []).length, goal: DAILY_REQUIRED }),
  },
];

const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));

/* ── Progress record ─────────────────────────────
   Every field is a scalar or a list capped at its own requirement, so the row
   can never grow without bound no matter how many games are played. */
function normalizeRecord(cur, userId) {
  const rec = (cur && typeof cur === 'object') ? cur : {};
  rec.userId = userId;
  if (!rec.unlocked || typeof rec.unlocked !== 'object') rec.unlocked = {};
  const p = (rec.progress && typeof rec.progress === 'object') ? rec.progress : {};
  p.rankedWins = Number(p.rankedWins) || 0;
  p.streak = Number(p.streak) || 0;
  p.bestStreak = Number(p.bestStreak) || 0;
  p.bestBank = Number(p.bestBank) || 0;
  p.sixShooter = !!p.sixShooter;
  p.win20k = !!p.win20k;
  p.dailyDays = Array.isArray(p.dailyDays)
    ? [...new Set(p.dailyDays.filter(d => typeof d === 'string'))].slice(0, DAILY_REQUIRED)
    : [];
  rec.progress = p;
  return rec;
}

/* Apply one event to the progress counters. Returns whether anything changed,
   so an event that moves nothing (another six-of-a-kind after it's unlocked,
   a smaller bank than the best) writes nothing. */
function applyEvent(p, event) {
  switch (event.type) {
    case 'win': {
      /* The winner gets {type:'win', ranked, goal}. A loss (won:false), if the
         caller chooses to fire it for the losers, resets the streak — that is
         the only way "in a row" can reset. Fire only the winner and the streak
         simply never breaks (it then counts lifetime wins), which still unlocks
         Warpath, just more leniently. */
      const won = event.won !== false;
      if (!won) {
        if (p.streak !== 0) { p.streak = 0; return true; }
        return false;
      }
      p.streak += 1;
      if (p.streak > p.bestStreak) p.bestStreak = p.streak;
      if (event.ranked) p.rankedWins += 1;
      if (Number(event.goal) === MARATHON_GOAL) p.win20k = true;
      return true;
    }
    case 'bank': {
      const amt = Number(event.amount) || 0;
      if (amt > p.bestBank) { p.bestBank = amt; return true; }
      return false;
    }
    case 'roll': {
      if (event.sixOfAKind && !p.sixShooter) { p.sixShooter = true; return true; }
      return false;
    }
    case 'daily': {
      const day = typeof event.dayKey === 'string' ? event.dayKey.trim() : '';
      if (day && p.dailyDays.length < DAILY_REQUIRED && !p.dailyDays.includes(day)) {
        p.dailyDays.push(day);
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/* Idempotent inventory grant — the same locked read-modify-write every other
   minter uses (item-codes.js grantInventoryItem). Identity is id+game+type; an
   item already owned is a no-op. Returns 'added' | 'owned'. */
async function grantDiceReward(env, userId, reward) {
  let outcome = 'owned';
  await env.MARKETPLACE.mutate(`inv_${userId}`, (cur) => {
    const inv = (cur && typeof cur === 'object') ? cur : { userId, items: [], equips: {} };
    if (!Array.isArray(inv.items)) inv.items = [];
    if (!inv.equips || typeof inv.equips !== 'object') inv.equips = {};
    const owned = inv.items.find(i => i && i.id === reward.id && i.game === reward.game && i.type === reward.type);
    if (owned) { outcome = 'owned'; return undefined; }   /* no write */
    inv.items.push({
      id: reward.id,
      type: reward.type,
      game: reward.game,
      name: reward.name,
      rarity: reward.rarity,
      grantedAt: Date.now(),
      source: 'mana-clash-achievement',
    });
    outcome = 'added';
    return inv;
  });
  return outcome;
}

/**
 * The entry point mana-clash.js calls when something happens.
 *
 *   recordManaClashAchievement(env, userId, { type:'win',  ranked, goal })
 *   recordManaClashAchievement(env, userId, { type:'bank', amount })
 *   recordManaClashAchievement(env, userId, { type:'roll', sixOfAKind })
 *   recordManaClashAchievement(env, userId, { type:'daily', dayKey })
 *
 * Updates progress, unlocks any newly-met achievements, and grants the mapped
 * dice set. Idempotent and NEVER throws into the caller — a cosmetic reward
 * must not be able to break a game write.
 */
export async function recordManaClashAchievement(env, userId, event) {
  try {
    if (!env || !env.MARKETPLACE || userId == null || !event || typeof event !== 'object') {
      return { ok: false };
    }
    const uid = String(userId);
    const newlyUnlocked = [];

    await env.MARKETPLACE.mutate(achKey(uid), (cur) => {
      const rec = normalizeRecord(cur, uid);
      const changed = applyEvent(rec.progress, event);

      for (const a of ACHIEVEMENTS) {
        if (!rec.unlocked[a.id] && a.met(rec.progress)) {
          rec.unlocked[a.id] = Date.now();
          newlyUnlocked.push(a.id);
        }
      }
      if (!changed && newlyUnlocked.length === 0) return undefined;   /* no write */
      rec.updatedAt = Date.now();
      return rec;
    });

    const granted = [];
    for (const id of newlyUnlocked) {
      const a = ACH_BY_ID[id];
      if (!a || !a.reward) continue;
      try {
        const res = await grantDiceReward(env, uid, a.reward);
        if (res === 'added') granted.push(a.reward.id);
      } catch (err) {
        try { console.error('[mana-clash-achievements] grant failed for', id, err && err.message); } catch {}
      }
    }

    return { ok: true, unlocked: newlyUnlocked, granted };
  } catch (err) {
    try { console.error('[mana-clash-achievements] record failed:', err && err.message); } catch {}
    return { ok: false, error: err && err.message };
  }
}

/* ── GET — the logged-in user's achievement state ──
   Everything the Achievements panel needs: each achievement with its unlocked
   flag, progress toward it, and the dice it grants. */
export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);

  const stored = await env.MARKETPLACE.get(achKey(String(session.user_id)), 'json');
  const rec = normalizeRecord(stored, String(session.user_id));

  const achievements = ACHIEVEMENTS.map(a => {
    const unlockedAt = rec.unlocked[a.id] || null;
    return {
      id: a.id,
      name: a.name,
      desc: a.desc,
      unlocked: !!unlockedAt,
      unlockedAt,
      progress: a.progress(rec.progress),
      reward: {
        id: a.reward.id,
        type: a.reward.type,
        name: a.reward.name,
        rarity: a.reward.rarity,
        cls: a.reward.cls || null,
      },
    };
  });

  return json({
    achievements,
    summary: {
      unlocked: achievements.filter(a => a.unlocked).length,
      total: achievements.length,
    },
  });
}
