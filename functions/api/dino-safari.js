/* ══════════════════════════════════════════════
   DINO STREAM SAFARI — chat catches wild dinos on the overlay (Epic D #12).

   A STREAM-NIGHT MODE, NOT THE PARK. Normal Dino Park is a single-player save
   (dino_park_<id>) synced per account. The Safari is none of that: one SINGLETON
   the broadcaster/mods start from a control POST, where the SERVER spawns a wild
   dino on the overlay every spawn interval, chat races to catch it with `!catch`,
   and the winner is granted that EXACT dino as an egg in their park. It touches
   no player's save except to grant the won egg (through grantEgg, the same
   server-authoritative path redemption codes use). When no Safari is live, Dino
   Park plays exactly as before.

   THE FLOW
     • A mod POSTs `start` with a catch rule (raffle | first) and an optional
       spawn interval. The first wild dino is rolled immediately.
     • Each wild dino opens a short CATCH WINDOW. Every `!catch` in Twitch chat
       adds the chatter to that spawn's catchers (see catchFromChat, called from
       bot/commands.js), one catch per chatter per spawn.
     • When the window closes the spawn RESOLVES by the rule, the winner is
       granted an egg PINNED to the spawned species, and after a short gap the
       next wild dino rolls. A spawn nobody caught expires with no grant.

   THE WILD ROLL — the real hatch odds. A spawn's rarity comes from the hatch
   minigame's own weighted roll (dino-species.js rollHatchRarity) and its species
   from that rarity's pool (rollSpeciesId), so a wild dino is distributed exactly
   like a hatched one — no second economy. A ~18% mutation is rolled the same way
   the hatch grant does, decided server-side so the dino the stream sees is the
   dino the winner gets.

   THE AGGREGATE — "a capped set and a count, never a per-message log".
     A spawn holds its catchers as a capped array (arrival order, so `first`
     needs no extra timestamp) plus a `seen` dedupe map, both bounded by
     MAX_CATCHERS. A raid of thousands cannot grow the record without bound —
     past the cap new catchers are turned away while the ones already in keep
     their claim. There is no per-message log of any kind.

   RATE LIMIT: one catch per chatter per spawn. The first `!catch` from a Twitch
   id lands; any repeat on the same spawn is a quiet no-op. That is both the
   anti-spam limit and the fairness rule (one claim per person per dino), and it
   resets with each new spawn.

   TIME IS RESOLVED LAZILY, like the rooms and the other chat games: there is NO
   scheduler. The catch window closing, the next spawn rolling and the session
   going idle are all "this deadline has passed", applied on whatever request
   arrives next — the overlay poll, or a chat catch. The GRANT is the one side
   effect, performed OUTSIDE the lock by whichever caller actually resolved the
   spawn (exactly once, because resolving clears the spawn atomically).

   STORAGE. One singleton key `dino_safari`, registered in server/lib/registry.js
   as { table: 'singletons', expiry: 'real' }: every write slides a TTL forward,
   so a Safari left unended lapses off the overlay rather than lingering. The live
   status is also timestamp-driven (lastActiveAt + IDLE_MS) so publicSafari reads
   'none' the moment it goes idle, before the row is even gone.
   ══════════════════════════════════════════════ */

import {
  rollHatchRarity, rollSpeciesId, rollDinoMutation, speciesMeta, SPECIES,
} from './dino-species.js';

export const SAFARI_KEY = 'dino_safari';

/* Seconds BETWEEN spawns (configurable on start, clamped to this range). */
export const DEFAULT_INTERVAL_SEC = 60;
export const MIN_INTERVAL_SEC = 30;
export const MAX_INTERVAL_SEC = 300;

/* How long a wild dino stays catchable once it appears. */
export const CATCH_WINDOW_MS = 25000;

/* How long the overlay shows the winner banner after a spawn resolves. */
export const WINNER_SHOW_MS = 10000;

/* No spawn/resolve/catch for this long and the Safari reads as over. Comfortably
   longer than one interval + catch window (325s at the slowest) so a genuinely
   running-but-quiet Safari between spawns is never falsely retired. */
export const IDLE_MS = 12 * 60 * 1000;

/* Storage backstop, longer than IDLE_MS so the timestamp rule ends a live
   session and the TTL only reclaims an abandoned row. */
const SESSION_TTL_SECONDS = 1000;

/* The per-spawn catcher set + dedupe map are capped so a raid cannot balloon
   the doc. Only ever reached by a chat far larger than any real catch needs. */
const MAX_CATCHERS = 2000;

/* ── TRACKING ───────────────────────────────────────────────────────────
   The catch window is 25 seconds; the gap between spawns is a minute by
   default. For most of a Safari there is nothing for chat to do but wait, so
   `!track` turns the gap into the part they play.

   Tracking does not pick the dino — it buys EXTRA ROLLS on the same weighted
   table, and the best rarity wins. A chat that turns out in numbers is more
   likely to turn up something good, but nothing is ever guaranteed and the
   species pool is untouched: a legendary stays a legendary. Shifting the
   weights instead would quietly make the Safari a different game from the
   hatch minigame it deliberately shares odds with. */
const TRACKERS_PER_ROLL = 15;
const MAX_BONUS_ROLLS = 4;
const MAX_TRACKERS = 2000;

/* Worst to best. Used only to pick the best of several rolls. */
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** How many rolls a given turnout buys, including the base one. */
export function rollsForTrackers(trackers) {
  const bonus = Math.min(MAX_BONUS_ROLLS, Math.floor(Math.max(0, trackers) / TRACKERS_PER_ROLL));
  return 1 + bonus;
}

/* The unified "what's on stream" pointer id. stream-now.js must list 'dino-park'
   in its GAMES whitelist or the refresh is a silent no-op. */
const STREAM_NOW_GAME = 'dino-park';

const RULES = ['raffle', 'first'];

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

function clampInterval(sec) {
  const n = Math.floor(Number(sec) || 0);
  if (!n) return DEFAULT_INTERVAL_SEC;
  return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, n));
}

function normalizeRule(rule) {
  return RULES.indexOf(rule) === -1 ? 'raffle' : rule;
}

/* ══ The wild roll + resolution, as pure/injectable functions ══════════════ */

/**
 * Roll one wild dino using the hatch minigame's own rarity weights + species
 * pools, decided fully server-side (species, rarity and mutation). `roll`
 * defaults to the real dino-species rollers (Math.random); a test injects its
 * own so a spawn is deterministic.
 */
export function rollWildDino(roll = {}, rolls = 1) {
  const rollRarity = roll.rarity || rollHatchRarity;
  const rollSpecies = roll.species || rollSpeciesId;
  const rollMut = roll.mutation !== undefined ? roll.mutation : rollDinoMutation;

  /* Chat's tracking buys extra rolls on the SAME table; the best one wins.
     The species pool is then drawn for that rarity exactly as always. */
  let rarity = rollRarity();
  for (let i = 1; i < Math.max(1, rolls); i++) {
    const next = rollRarity();
    if (RARITY_ORDER.indexOf(next) > RARITY_ORDER.indexOf(rarity)) rarity = next;
  }
  const speciesId = rollSpecies(rarity);
  const meta = speciesMeta(speciesId) || {};
  const mutation = typeof rollMut === 'function' ? rollMut() : (rollMut || null);
  return {
    speciesId,
    rarity,
    mutation: mutation || null,
    name: meta.name || speciesId,
    icon: meta.icon || '',
    portrait: meta.portrait || '',
  };
}

/** The light reveal fields the overlay draws for a spawn or a win. */
function revealOf(spawn) {
  return {
    speciesId: spawn.speciesId,
    rarity: spawn.rarity,
    mutation: spawn.mutation || null,
    name: spawn.name || spawn.speciesId,
    icon: spawn.icon || '',
    portrait: spawn.portrait || '',
  };
}

/**
 * Pick the winning catcher by the spawn's rule. PURE and injectable: `raffle`
 * uses `rng` (default Math.random) over the capped catcher set; `first` is the
 * earliest valid catcher (catchers are stored in arrival order). Returns the
 * catcher {userId, name} or null when nobody caught.
 */
export function pickWinner(catchers, rule, rng = Math.random) {
  const list = Array.isArray(catchers) ? catchers : [];
  if (!list.length) return null;
  if (rule === 'first') return list[0];
  const i = Math.floor(rng() * list.length);
  return list[Math.min(list.length - 1, Math.max(0, i))];
}

/**
 * Resolve ONE closed spawn: pick the winner, build the overlay banner, and the
 * grant to perform (pinned to the spawned species + rarity). Pure given the
 * spawn + rng. A spawn nobody caught resolves with no grant.
 */
export function resolveSpawn(spawn, rng = Math.random) {
  const catchers = Array.isArray(spawn.catchers) ? spawn.catchers : [];
  const reveal = revealOf(spawn);
  const winner = pickWinner(catchers, spawn.rule, rng);
  if (!winner) {
    return {
      win: { ...reveal, caught: false, winnerId: null, winnerName: null, catchers: catchers.length },
      grant: null,
    };
  }
  return {
    win: {
      ...reveal,
      caught: true,
      winnerId: String(winner.userId),
      winnerName: winner.name || null,
      catchers: catchers.length,
    },
    grant: { winnerId: String(winner.userId), rarity: spawn.rarity, speciesId: spawn.speciesId },
  };
}

/* ══ Lifecycle ════════════════════════════════════════════════════════════ */

function newSession(now, by, rule, intervalSec) {
  return {
    status: 'active',
    startedAt: now,
    lastActiveAt: now,
    by: by || null,
    rule: normalizeRule(rule),
    intervalMs: clampInterval(intervalSec) * 1000,
    spawn: null,
    nextSpawnAt: now,      // roll the first wild dino at once
    lastWin: null,
    lastWinUntil: 0,
    spawns: 0,
    caught: 0,
  };
}

function makeSpawn(session, now, roll) {
  /* Read before it is cleared: the turnout during THIS gap is what paid for
     the roll, and the next gap starts from nothing. */
  const trackers = Object.keys(session.tracking || {}).length;
  const wild = rollWildDino(roll, rollsForTrackers(trackers));
  session.tracking = {};
  return {
    trackedBy: trackers,
    rolls: rollsForTrackers(trackers),
    id: (now + '_' + Math.random().toString(36).slice(2, 8)),
    ...wild,
    rule: session.rule,
    spawnedAt: now,
    catchUntil: now + CATCH_WINDOW_MS,
    catchers: [],
    seen: {},
    count: 0,
  };
}

/** A Safari is live only while active AND touched within IDLE_MS. */
export function isLive(s, now) {
  return !!(s && s.status === 'active' &&
    now - (Number(s.lastActiveAt) || Number(s.startedAt) || 0) < IDLE_MS);
}

/** Whether a read has timed work to persist. */
function safariDue(s, now) {
  if (!isLive(s, now)) return false;
  if (s.spawn) return now >= s.spawn.catchUntil;      // window closed → resolve
  return s.nextSpawnAt != null && now >= s.nextSpawnAt; // gap over → roll next
}

/**
 * Apply whatever the clock owes, in place: a closed spawn resolves (recording
 * the winner banner and the grant to perform), then the next wild dino rolls
 * when its gap has passed. Returns { changed, grants } so a read writes only
 * when it must and the caller performs each grant OUTSIDE the lock. Bounded: at
 * most one resolve + one new spawn per call, so a long idle gap cannot roll a
 * backlog of uncatchable dinos.
 *
 * @param {object} [opts] { rng, roll } — injected for deterministic tests.
 */
export function advanceSafari(s, now, opts = {}) {
  const grants = [];
  let changed = false;
  if (!s || s.status !== 'active') return { changed, grants };

  if (s.spawn && now >= s.spawn.catchUntil) {
    const r = resolveSpawn(s.spawn, opts.rng || Math.random);
    s.lastWin = r.win;
    s.lastWinUntil = now + WINNER_SHOW_MS;
    if (r.grant) { grants.push(r.grant); s.caught = (s.caught || 0) + 1; }
    s.spawn = null;
    s.nextSpawnAt = now + (Number(s.intervalMs) || DEFAULT_INTERVAL_SEC * 1000);
    s.lastActiveAt = now;
    changed = true;
  }

  if (!s.spawn && s.nextSpawnAt != null && now >= s.nextSpawnAt) {
    s.spawn = makeSpawn(s, now, opts.roll);
    s.spawns = (s.spawns || 0) + 1;
    s.lastActiveAt = now;
    changed = true;
  }

  return { changed, grants };
}

/**
 * The small shape the overlay reads — never the raw catchers/seen maps. An idle
 * or ended (or absent) session reads as 'none' so the panel hides itself.
 */
export function publicSafari(s, now = Date.now()) {
  if (!isLive(s, now)) return { status: 'none', serverNow: now };

  const win = (s.lastWin && s.lastWinUntil && now < s.lastWinUntil) ? s.lastWin : null;
  const base = {
    status: 'active',
    serverNow: now,
    by: s.by || null,
    rule: s.rule || 'raffle',
    intervalSec: Math.round((Number(s.intervalMs) || DEFAULT_INTERVAL_SEC * 1000) / 1000),
    spawns: s.spawns || 0,
    caught: s.caught || 0,
    lastWin: win,
  };

  if (s.spawn && now < s.spawn.catchUntil) {
    return {
      ...base,
      phase: 'catch',
      spawn: revealOf(s.spawn),
      msLeft: Math.max(0, s.spawn.catchUntil - now),
      catchers: s.spawn.count || 0,
      /* What chat's tracking bought for THIS dino, so the payoff is visible
         at the moment it matters rather than only before the roll. */
      trackedBy: s.spawn.trackedBy || 0,
      rolls: s.spawn.rolls || 1,
    };
  }

  /* Between spawns — the overlay shows the winner banner (if fresh) and a
     countdown to the next wild dino. */
  return {
    ...base,
    phase: 'waiting',
    trackers: Object.keys(s.tracking || {}).length,
    rolls: rollsForTrackers(Object.keys(s.tracking || {}).length),
    spawn: null,
    nextInMs: Math.max(0, (Number(s.nextSpawnAt) || now) - now),
  };
}

/* ══ The egg grant — pinned to the spawned species ═════════════════════════
   The winner gets the EXACT dino the stream saw, as an egg to hatch. grantEgg
   is the server-authoritative grant; a pin whose rarity matches is honoured
   (never a re-roll). If the winner's incubator is full, the dino is held as an
   inventory egg pinned to the same species — the same overflow the hatch
   minigame uses — so a won dino is never lost. Never throws: a grant failure
   must not take down the poll/catch that resolved the spawn. */
function inventoryKey(userId) { return `inv_${userId}`; }
function capitalize(str) { return String(str || '').charAt(0).toUpperCase() + String(str || '').slice(1); }

async function overflowToInventoryEgg(env, userId, rarity, speciesId) {
  try {
    await env.MARKETPLACE.mutate(inventoryKey(userId), (cur) => {
      const inv = cur && typeof cur === 'object' ? cur : { userId: String(userId), items: [], equips: {} };
      if (!Array.isArray(inv.items)) inv.items = [];
      inv.items.push({
        id: `safari_egg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        game: 'dino-park',
        type: 'egg',
        name: `${capitalize(rarity)} Dino Park Egg`,
        rarity,
        consumable: true,
        quantity: 1,
        grantedAt: Date.now(),
        source: 'safari',
        meta: { guaranteed: true, rarity, speciesId },
      });
      return inv;
    });
    return true;
  } catch (err) {
    console.error('[dino-safari] overflow to inventory failed:', err.message);
    return false;
  }
}

async function performGrant(env, grant) {
  if (!env || !grant || !grant.winnerId) return;
  try {
    const { grantEgg } = await import('./dino-park.js');
    const res = await grantEgg(env, grant.winnerId, grant.rarity, { speciesId: grant.speciesId });
    if (res && res.success) return;
    /* Incubator full — hold it as an inventory egg so the won dino is not lost. */
    if (res && res.error === 'Incubator full') {
      await overflowToInventoryEgg(env, grant.winnerId, grant.rarity, grant.speciesId);
    }
  } catch (err) {
    console.error('[dino-safari] grant failed:', err.message);
  }
}

/* Best-effort pointer upkeep — a stream_now hiccup must never take down the
   control action or chat catch that triggered it. */
async function refreshPointer(env, by) {
  try {
    const { refreshStreamNow } = await import('./stream-now.js');
    await refreshStreamNow(env, { game: STREAM_NOW_GAME, label: 'Stream Safari', level: by || null });
  } catch (err) {
    console.error('[dino-safari] could not refresh stream_now:', err.message);
  }
}

async function clearPointer(env) {
  try {
    const { clearStreamNow } = await import('./stream-now.js');
    await clearStreamNow(env, STREAM_NOW_GAME);
  } catch (err) {
    console.error('[dino-safari] could not clear stream_now:', err.message);
  }
}

/* ══ Chat participation — called from bot/commands.js on `!catch` ═══════════
   Adds the chatter to the live spawn's catchers, one catch per chatter per
   spawn. No live spawn / closed window → a quiet no-op. Silent by design: the
   overlay is the feedback, and a reply per chatter would bury the channel
   during exactly the busy seconds the window is open. Resolves the clock first
   (a window that just closed under this message is settled + granted). */
/**
 * One chatter tracking during the gap between spawns.
 *
 * Silent on every rejection — no live Safari, a dino already on screen and
 * having tracked this gap already all look identical from chat. One per
 * chatter per gap, so the turnout measures how many PEOPLE are hunting rather
 * than how fast anyone can type, and it resets with every spawn.
 */
export async function trackFromChat(env, { userId } = {}) {
  if (!env || !env.MARKETPLACE || !userId) return { ok: false, reason: 'empty' };
  const uid = String(userId);

  let outcome = { ok: false, reason: 'closed' };
  await env.MARKETPLACE.mutate(SAFARI_KEY, (s) => {
    const now = Date.now();
    if (!isLive(s, now)) return undefined;
    /* Only in the gap. While a dino is on screen the command to use is
       !catch, and tracking a dino that already exists would do nothing. */
    if (s.spawn && now < s.spawn.catchUntil) { outcome = { ok: false, reason: 'catching' }; return undefined; }

    s.tracking = (s.tracking && typeof s.tracking === 'object') ? s.tracking : {};
    if (Object.prototype.hasOwnProperty.call(s.tracking, uid)) { outcome = { ok: false, reason: 'already' }; return undefined; }
    if (Object.keys(s.tracking).length >= MAX_TRACKERS) { outcome = { ok: false, reason: 'full' }; return undefined; }

    s.tracking[uid] = 1;
    /* Tracking is activity: a Safari chat is working on must not idle out. */
    s.lastActiveAt = now;
    outcome = { ok: true, trackers: Object.keys(s.tracking).length };
    return s;
  }, { expirationTtl: SESSION_TTL_SECONDS });

  return outcome;
}

export async function catchFromChat(env, { userId, name } = {}) {
  if (!env || !env.MARKETPLACE || !userId) return { ok: false, status: 'none' };
  const uid = String(userId);

  let landed = false;
  let after = null;
  let grants = [];

  await env.MARKETPLACE.mutate(SAFARI_KEY, (s) => {
    const now = Date.now();
    after = s;
    if (!isLive(s, now)) return undefined;        // no live Safari — nothing to catch

    const adv = advanceSafari(s, now);
    grants = adv.grants;
    let changed = adv.changed;

    /* Add the catcher only to an OPEN window. */
    if (s.spawn && now < s.spawn.catchUntil) {
      s.spawn.seen = (s.spawn.seen && typeof s.spawn.seen === 'object') ? s.spawn.seen : {};
      const full = Object.keys(s.spawn.seen).length >= MAX_CATCHERS;
      if (!s.spawn.seen[uid] && !full) {
        s.spawn.seen[uid] = 1;
        s.spawn.catchers.push({ userId: uid, name: name || null });
        s.spawn.count = (s.spawn.count || 0) + 1;
        s.lastActiveAt = now;
        landed = true;
        changed = true;
      }
    }

    after = s;
    return changed ? s : undefined;
  }, { expirationTtl: SESSION_TTL_SECONDS });

  for (const g of grants) await performGrant(env, g);

  /* Activity (a landed catch or a resolved window) slides the unified pointer;
     a session gone idle under this message retires it. */
  if (isLive(after, Date.now())) await refreshPointer(env, after && after.by);

  return { ok: landed, status: publicSafari(after).status };
}

/* ══ GET — the overlay (OBS browser source) ═══════════════════════════════
   Key in the URL, like every overlay panel. Resolves the clock on read so an
   idle overlay still sees the window close, the winner grant and the next spawn
   roll on schedule; it only takes the lock when timed work is due, so it can
   never overwrite a catch that landed in between. Keeps the unified pointer
   alive while genuinely live. */
export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const { getOverlayKey } = await import('./overlay/events.js');
  const key = await getOverlayKey(env);
  if (url.searchParams.get('key') !== key) {
    return json({ error: 'Bad or missing key' }, 403);
  }

  let s = await env.MARKETPLACE.get(SAFARI_KEY, 'json');
  const now = Date.now();

  if (s && s.status === 'active' && !isLive(s, now)) {
    /* Gone idle: retire it now so the panel hides and the pointer clears,
       rather than waiting for the storage TTL to reclaim the row. */
    await env.MARKETPLACE.mutate(SAFARI_KEY, (cur) =>
      (cur && cur.status === 'active') ? { status: 'ended', endedAt: now } : undefined,
      { expirationTtl: 60 });
    await clearPointer(env);
    s = { status: 'ended' };
  } else if (safariDue(s, now)) {
    let grants = [];
    await env.MARKETPLACE.mutate(SAFARI_KEY, (cur) => {
      const adv = cur ? advanceSafari(cur, now) : { changed: false, grants: [] };
      grants = adv.grants;
      s = cur;
      return adv.changed ? cur : undefined;
    }, { expirationTtl: SESSION_TTL_SECONDS });
    for (const g of grants) await performGrant(env, g);
    if (isLive(s, now)) await refreshPointer(env, s && s.by);
  } else if (isLive(s, now)) {
    /* Keep-alive while live between spawns: this poll slides the pointer. */
    await refreshPointer(env, s.by);
  }

  return json(publicSafari(s, now));
}

/* ══ POST — the control button (broadcaster / moderators) ═════════════════
   Start payload for the dashboard:
     { action: 'start', rule: 'raffle' | 'first', intervalSec?: number }
     { action: 'stop' }
   Both return the session state so the dashboard can confirm. */
export async function onRequestPost(context) {
  const { env, request } = context;

  const { isModerator } = await import('./admin/moderators.js');
  const session = getSession(request);
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can run a Safari.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'start') {
    const now = Date.now();
    const s = newSession(now, session.display_name || null, body.rule, body.intervalSec);
    /* Roll the first wild dino immediately so the overlay has something to show
       the instant the panel appears. */
    advanceSafari(s, now);
    /* Overwrites any previous Safari — a fresh start resets the spawn cycle. */
    await env.MARKETPLACE.mutate(SAFARI_KEY, () => s, { expirationTtl: SESSION_TTL_SECONDS });
    await refreshPointer(env, s.by);
    return json({ success: true, safari: publicSafari(s, now) });
  }

  if (body.action === 'stop' || body.action === 'end') {
    /* A tombstone rather than a delete, so a catch already holding the lock
       cannot resurrect the Safari by writing it back. */
    await env.MARKETPLACE.mutate(SAFARI_KEY, () => ({ status: 'ended', endedAt: Date.now() }),
      { expirationTtl: 60 });
    await clearPointer(env);
    return json({ success: true, safari: { status: 'none' } });
  }

  return json({ error: 'Invalid action' }, 400);
}
