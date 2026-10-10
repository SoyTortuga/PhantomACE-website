/* ══════════════════════════════════════════════
   ACHIEVEMENTS → badges, for every game that can verify one

   Mana Clash has had achievements since it shipped and nothing else did.
   This is the same engine, generalised, for Memory Match, Commander Bingo,
   PhamShock and MTGBBB. Mana Clash keeps its own module and its own
   `mc_ach_` rows: it grants DICE, not badges, and rewriting a working
   feature to share a file would be a migration for no gain.

   WHY EVENTS AND NOT BOARDS. Progress is folded from an event at the moment
   something happens, never read back off a leaderboard. Every board on this
   site is truncated — lb_memory_match keeps 50 rows, the daily keeps 500 —
   so a player off the end of one would silently stop making progress, which
   is a bug this project has already shipped twice under another name. An
   event reaches here whatever the player's rank.

   `met(progress)` IS THE TRUTH. The recorder recomputes every predicate
   after each event and diffs against the stored set, so an achievement can
   never be half-unlocked, and adding one later unlocks it retroactively for
   anyone whose stored progress already satisfies it. `progress(p)` returns
   {cur, goal} only for the client's bar.

   THE ART MAY NOT EXIST YET. A badge names /assets/badges/<id>.png whether
   or not the file is there; both surfaces that draw badges already fall back
   to a glyph when the image 404s (js/pages/inventory.js's data-fallback,
   js/pages/profile.js's data-glyph — whose comment says in as many words
   that a badge can name artwork that is not there yet). So the system works
   from the day it ships and the art can land one file at a time.

   This file exports onRequestGet, so it IS a route (/api/achievements) and
   needs no NON_ROUTE_MODULES entry. Its rows do need a registry prefix:
   `ach_` in server/lib/registry.js.
   ══════════════════════════════════════════════ */

const KEY_PREFIX = 'ach_';

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

/** One player's progress in one game. */
export function achKey(game, userId) { return `${KEY_PREFIX}${game}_${userId}`; }

/* A reward is a profile badge. `id` doubles as the inventory item id and the
   artwork filename, so it has to be unique across every badge the site grants
   — hence the per-game prefixes, which also keep clear of the hand-minted
   ones (agate-hunt, mtgbbb-winner, mini-golf, dino-park-beta). */
function badge(id, name, rarity) {
  return {
    id, type: 'badge', game: 'profile', name, rarity,
    image: `/assets/badges/${id}.png`,
  };
}

/* ── Memory Match ─────────────────────────────────
   Fed by recordResult (every finished ranked game) and the daily puzzle's
   own finisher. The server deals the deck and counts the moves, so none of
   this can be claimed by a client. */
const MEMORY_MATCH = {
  label: 'Memory Match',
  /* Capped so a row cannot grow however many games are played. */
  normalize(p) {
    p.games = Number(p.games) || 0;
    p.flawless = !!p.flawless;
    p.dailyDays = Array.isArray(p.dailyDays)
      ? [...new Set(p.dailyDays.filter(d => typeof d === 'string'))].slice(0, 5)
      : [];
    return p;
  },
  apply(p, e) {
    switch (e.type) {
      case 'game': {
        p.games += 1;
        /* Twenty pairs in twenty moves is a perfect board: every second flip
           matched, no wasted turn. It is the floor, so nothing beats it. */
        if (Number(e.pairs) === 20 && Number(e.moves) === 20) p.flawless = true;
        return true;
      }
      case 'daily': {
        const day = typeof e.dayKey === 'string' ? e.dayKey.trim() : '';
        if (day && p.dailyDays.length < 5 && !p.dailyDays.includes(day)) {
          p.dailyDays.push(day);
          return true;
        }
        return false;
      }
      default: return false;
    }
  },
  catalog: [
    {
      id: 'mm-flawless', name: 'Flawless',
      desc: 'Clear a 20-pair board in 20 moves — every single flip a match.',
      reward: badge('mm-flawless', 'Flawless', 'rare'),
      met: (p) => !!p.flawless,
      progress: (p) => ({ cur: p.flawless ? 1 : 0, goal: 1 }),
    },
    {
      id: 'mm-fifty', name: 'Card Counter',
      desc: 'Finish 50 ranked games.',
      reward: badge('mm-fifty', 'Card Counter', 'uncommon'),
      met: (p) => p.games >= 50,
      progress: (p) => ({ cur: Math.min(p.games, 50), goal: 50 }),
    },
    {
      id: 'mm-daily-five', name: 'Daily Devotion',
      desc: 'Play the daily puzzle on 5 different days.',
      reward: badge('mm-daily-five', 'Daily Devotion', 'uncommon'),
      met: (p) => p.dailyDays.length >= 5,
      progress: (p) => ({ cur: p.dailyDays.length, goal: 5 }),
    },
  ],
};

/* ── Commander Bingo ──────────────────────────────
   Fed by bingo/end.js, which scores each player from the room's own card and
   calls — the client never reports a result. */
const COMMANDER_BINGO = {
  label: 'Commander Bingo',
  normalize(p) {
    p.games = Number(p.games) || 0;
    p.bingos = Number(p.bingos) || 0;
    p.blackout = !!p.blackout;
    return p;
  },
  apply(p, e) {
    if (e.type !== 'game') return false;
    p.games += 1;
    p.bingos += Math.max(0, Number(e.bingos) || 0);
    /* Every square called on your card. */
    if (Number(e.marked) >= 25) p.blackout = true;
    return true;
  },
  catalog: [
    {
      id: 'cb-first', name: 'Called',
      desc: 'Hit your first bingo.',
      reward: badge('cb-first', 'Called', 'common'),
      met: (p) => p.bingos >= 1,
      progress: (p) => ({ cur: Math.min(p.bingos, 1), goal: 1 }),
    },
    {
      id: 'cb-blackout', name: 'Blackout',
      desc: 'Fill every square on a card.',
      reward: badge('cb-blackout', 'Blackout', 'rare'),
      met: (p) => !!p.blackout,
      progress: (p) => ({ cur: p.blackout ? 1 : 0, goal: 1 }),
    },
    {
      id: 'cb-ten', name: 'Regular',
      desc: 'Play 10 games through to the end.',
      reward: badge('cb-ten', 'Regular', 'uncommon'),
      met: (p) => p.games >= 10,
      progress: (p) => ({ cur: Math.min(p.games, 10), goal: 10 }),
    },
  ],
};

/* ── PhamShock ────────────────────────────────────
   Fed by resolve() when a real multi-player match settles. A win is the
   server's own conclusion, never a client's claim. */
const PHAM_SHOCK = {
  label: 'PhamShock',
  normalize(p) {
    p.wins = Number(p.wins) || 0;
    p.streak = Number(p.streak) || 0;
    p.bestStreak = Number(p.bestStreak) || 0;
    return p;
  },
  apply(p, e) {
    if (e.type !== 'match') return false;
    if (e.won) {
      p.wins += 1;
      p.streak += 1;
      if (p.streak > p.bestStreak) p.bestStreak = p.streak;
    } else {
      /* A loss ends a run; the best is kept. */
      if (p.streak === 0) return false;
      p.streak = 0;
    }
    return true;
  },
  catalog: [
    {
      id: 'ps-first', name: 'First Shot',
      desc: 'Win your first match.',
      reward: badge('ps-first', 'First Shot', 'common'),
      met: (p) => p.wins >= 1,
      progress: (p) => ({ cur: Math.min(p.wins, 1), goal: 1 }),
    },
    {
      id: 'ps-streak', name: 'Dialled In',
      desc: 'Win 3 matches in a row.',
      reward: badge('ps-streak', 'Dialled In', 'rare'),
      met: (p) => p.bestStreak >= 3,
      progress: (p) => ({ cur: Math.min(Math.max(p.streak, p.bestStreak), 3), goal: 3 }),
    },
    {
      id: 'ps-ten', name: 'Veteran',
      desc: 'Win 10 matches.',
      reward: badge('ps-ten', 'Veteran', 'uncommon'),
      met: (p) => p.wins >= 10,
      progress: (p) => ({ cur: Math.min(p.wins, 10), goal: 10 }),
    },
  ],
};

/* ── MTGBBB ───────────────────────────────────────
   Fed by mtgbbb/end.js from the room's computed scores. Points come from
   mtgbbb-scoring, never from a client. */
const MTGBBB = {
  label: 'MTGBBB',
  normalize(p) {
    p.boxes = Number(p.boxes) || 0;
    p.scored = !!p.scored;
    p.blackout = !!p.blackout;
    return p;
  },
  apply(p, e) {
    if (e.type !== 'box') return false;
    p.boxes += 1;
    if ((Number(e.points) || 0) > 0) p.scored = true;
    if (e.blackout) p.blackout = true;
    return true;
  },
  catalog: [
    {
      id: 'bbb-first', name: 'Cracked',
      desc: 'Score a point in a box crack.',
      reward: badge('bbb-first', 'Cracked', 'common'),
      met: (p) => !!p.scored,
      progress: (p) => ({ cur: p.scored ? 1 : 0, goal: 1 }),
    },
    {
      id: 'bbb-five', name: 'Box Fiend',
      desc: 'Play through 5 box cracks.',
      reward: badge('bbb-five', 'Box Fiend', 'uncommon'),
      met: (p) => p.boxes >= 5,
      progress: (p) => ({ cur: Math.min(p.boxes, 5), goal: 5 }),
    },
    {
      id: 'bbb-blackout', name: 'Full Box',
      desc: 'Black out a card in a box crack.',
      reward: badge('bbb-blackout', 'Full Box', 'mythic'),
      met: (p) => !!p.blackout,
      progress: (p) => ({ cur: p.blackout ? 1 : 0, goal: 1 }),
    },
  ],
};

export const GAMES = Object.freeze({
  'memory-match': MEMORY_MATCH,
  'commander-bingo': COMMANDER_BINGO,
  'pham-shock': PHAM_SHOCK,
  'mtgbbb': MTGBBB,
});

/** Every badge this module can grant — the art manifest, in one place.
    `from` is the game that earns it; the reward's own `game` is 'profile',
    which is the inventory slot it lands in, so the two cannot share a key. */
export function allRewards() {
  return Object.entries(GAMES).flatMap(([from, def]) =>
    def.catalog.map(a => ({ from, achievement: a.id, ...a.reward })));
}

function normalizeRecord(def, cur, userId) {
  const rec = (cur && typeof cur === 'object') ? cur : {};
  rec.userId = userId;
  if (!rec.unlocked || typeof rec.unlocked !== 'object') rec.unlocked = {};
  rec.progress = def.normalize((rec.progress && typeof rec.progress === 'object') ? rec.progress : {});
  return rec;
}

/* Idempotent inventory grant, the same locked read-modify-write every other
   minter on the site uses. Identity is id + game + type, so a badge already
   held is a no-op and no write happens at all. */
async function grantBadge(env, userId, reward, game) {
  let outcome = 'owned';
  await env.MARKETPLACE.mutate(`inv_${userId}`, (cur) => {
    const inv = (cur && typeof cur === 'object') ? cur : { userId, items: [], equips: {} };
    if (!Array.isArray(inv.items)) inv.items = [];
    if (!inv.equips || typeof inv.equips !== 'object') inv.equips = {};
    if (inv.items.some(i => i && i.id === reward.id && i.game === reward.game && i.type === reward.type)) {
      return undefined;
    }
    inv.items.push({
      id: reward.id,
      type: reward.type,
      game: reward.game,
      name: reward.name,
      rarity: reward.rarity,
      /* Badges are the only items with art of their own, and it rides in
         `meta` — without it the badge lands with nothing to draw. The file
         may not exist yet; both surfaces fall back to a glyph. */
      meta: { image: reward.image },
      grantedAt: Date.now(),
      source: `${game}-achievement`,
    });
    outcome = 'added';
    return inv;
  });
  return outcome;
}

/**
 * The entry point each game calls when something happens.
 *
 *   recordAchievement(env, 'memory-match',    uid, { type:'game', pairs, moves })
 *   recordAchievement(env, 'memory-match',    uid, { type:'daily', dayKey })
 *   recordAchievement(env, 'commander-bingo', uid, { type:'game', bingos, marked })
 *   recordAchievement(env, 'pham-shock',      uid, { type:'match', won })
 *   recordAchievement(env, 'mtgbbb',          uid, { type:'box', points, blackout })
 *
 * NEVER throws into the caller: a cosmetic reward must not be able to break
 * a game write. Guests (no account) are ignored — there is no inventory to
 * grant into.
 */
export async function recordAchievement(env, game, userId, event) {
  try {
    const def = GAMES[game];
    if (!def || !env || !env.MARKETPLACE || userId == null) return { ok: false };
    if (!event || typeof event !== 'object') return { ok: false };
    const uid = String(userId);
    if (!uid || uid.startsWith('guest_')) return { ok: false, guest: true };

    const newlyUnlocked = [];
    await env.MARKETPLACE.mutate(achKey(game, uid), (cur) => {
      const rec = normalizeRecord(def, cur, uid);
      const changed = def.apply(rec.progress, event);

      /* Every predicate, every time — so an achievement added later unlocks
         for anyone already past it, and none can be half-set. */
      for (const a of def.catalog) {
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
      const a = def.catalog.find(x => x.id === id);
      if (!a || !a.reward) continue;
      try {
        if (await grantBadge(env, uid, a.reward, game) === 'added') granted.push(a.reward.id);
      } catch (err) {
        try { console.error('[achievements] grant failed for', id, err && err.message); } catch {}
      }
    }
    return { ok: true, unlocked: newlyUnlocked, granted };
  } catch (err) {
    try { console.error('[achievements] record failed:', err && err.message); } catch {}
    return { ok: false, error: err && err.message };
  }
}

/** One game's state for the logged-in player. */
async function stateFor(env, game, userId) {
  const def = GAMES[game];
  let rec = null;
  try { rec = await env.MARKETPLACE.get(achKey(game, userId), 'json'); } catch { rec = null; }
  const norm = normalizeRecord(def, rec, String(userId));
  return {
    game,
    label: def.label,
    achievements: def.catalog.map(a => ({
      id: a.id,
      name: a.name,
      desc: a.desc,
      unlocked: !!norm.unlocked[a.id],
      unlockedAt: norm.unlocked[a.id] || null,
      progress: a.progress(norm.progress),
      reward: { id: a.reward.id, name: a.reward.name, rarity: a.reward.rarity, image: a.reward.image },
    })),
  };
}

/* ── GET — the player's achievements ──────────────
   /api/achievements            every game
   /api/achievements?game=mtgbbb  one of them
   Reads are per game and independent, so they go out together. */
export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);
  const uid = String(session.user_id);

  const one = new URL(request.url).searchParams.get('game');
  if (one) {
    if (!GAMES[one]) return json({ error: 'Unknown game' }, 404);
    return json(await stateFor(env, one, uid));
  }

  const names = Object.keys(GAMES);
  const games = await Promise.all(names.map(g => stateFor(env, g, uid)));
  return json({ games });
}
