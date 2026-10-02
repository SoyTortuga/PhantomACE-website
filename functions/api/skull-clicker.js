function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function getPlayer(request, body) {
  const session = getSession(request);
  if (session) return { id: session.user_id, name: session.display_name };
  if (body && body.guestId && body.guestName) return { id: 'guest_' + body.guestId, name: body.guestName.slice(0, 20) };
  return null;
}

/* Anonymous guests (no Twitch login) have a per-browser id and can't be verified
   or awarded, so they do not appear on the public boards. */
const isGuest = (id) => String(id).startsWith('guest_');
const notGuest = (e) => e && !isGuest(e.id);

const LB_KEY = 'sc_leaderboard';
const SAVE_MAX_BYTES = 20000;   /* a real save is a few hundred bytes */
const EVENT_KEY = 'sc_event';
const EVENT_MAX_MS = 30 * 60 * 1000;   /* cap a frenzy at 30 min, whoever sets it */

const saveKey = (userId) => `sc_save_${userId}`;

/* finite() coerces a BOUNDED numeric field (prestige, ascensions, timestamps,
   counters) into [0, cap]: Infinity → cap, NaN/-Infinity/negative → 0. These
   fields never approach the cap in real play; it is purely a corruption guard. */
const SCORE_CAP = 1e300;
function finite(v, cap = SCORE_CAP) {
  const n = Number(v);
  if (Number.isFinite(n)) return n < 0 ? 0 : (n > cap ? cap : n);
  return n === Infinity ? cap : 0;
}

/* ── Big-number scores ───────────────────────────────────────────────────
   Lifetime skulls can now exceed the JS double ceiling (~1.8e308), so a score
   is stored as a STRING ("1.23e500") and ranked by scoreLog (= log10, a tiny
   finite number like 500 that never overflows). parseScoreLog accepts BOTH the
   new {score:string, scoreLog:number} shape AND legacy numeric scores (the live
   board holds values like 1.48e191 and the two entries pinned to the real top),
   so reads and sorts stay correct across the migration. */
function parseScoreLog(score, scoreLog) {
  const sl = Number(scoreLog);
  if (Number.isFinite(sl) && sl > 0) return sl;
  const n = Number(score);
  if (Number.isFinite(n)) return n > 0 ? Math.log10(n) : 0;
  const m = String(score).match(/^(\d+(?:\.\d+)?)[eE]\+?(\d+)$/);
  if (m) return Math.log10(parseFloat(m[1])) + parseFloat(m[2]);
  return 0;
}
/* Canonical stored score. Keeps a finite legacy Number as-is (back-compat with
   any numeric consumer), keeps a new string as-is, and neutralises a non-finite
   legacy value to 0. */
function cleanScore(score) {
  if (typeof score === 'string') return score;
  const n = Number(score);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/* Every save-state scalar that participates in arithmetic (mirrors the client's
   SC_NUM_FIELDS). Timestamps are numbers too and pass through untouched — they sit
   well under the cap, and a non-finite one heals to 0, which every reader treats as
   "unset". clickMulti/globalCpsMult are cleaned separately so they never heal to 0
   (which would zero out production/clicks). */
/* skulls/totalSkulls/lifetimeSkulls/seasonBaseline are DELIBERATELY absent: they
   are big-number strings now, so finite() must never touch them (it would parse
   "1.2e500" to Infinity and overwrite the string with the cap). They pass through
   untouched; the client parses them back into Decimals on load. */
const SC_STATE_NUM_FIELDS = ['prestige','totalClicks','clickBonus','cpsClickPct','boneShards','cursedPopped','ascensions','epitaphs','highestPrestige','graveBlooms','petLevel','essence','spellsCast','spellsBackfired','gardenTier','gardenPlanted','gardenHarvests','wisps','startTime','bloomStart','seasonEndsAt','apocStart','apocPacifiedUntil','savedAt'];
function sanitizeState(state) {
  if (!state || typeof state !== 'object') return state;
  for (const k of SC_STATE_NUM_FIELDS) if (typeof state[k] === 'number') state[k] = finite(state[k]);
  for (const key of ['owned', 'metaLevels', 'buildingLevels', 'perkLevels']) {
    const map = state[key];
    if (map && typeof map === 'object') for (const k in map) if (typeof map[k] === 'number') map[k] = finite(map[k]);
  }
  state.clickMulti = finite(state.clickMulti) > 0 ? finite(state.clickMulti) : 1;
  state.globalCpsMult = finite(state.globalCpsMult) > 0 ? finite(state.globalCpsMult) : 1;
  return state;
}

/* A leaderboard row, healed on READ. Non-destructive (returns a copy) — the stored
   entry keeps its bad value until it is next written or explicitly scrubbed, but the
   display never shows Infinity. */
function sanitizeEntry(e) {
  if (!e || typeof e !== 'object') return e;
  const out = {
    ...e,
    score: cleanScore(e.score),
    scoreLog: parseScoreLog(e.score, e.scoreLog),
    prestige: Math.max(0, Math.min(9999, Math.floor(finite(e.prestige)))),
    ascensions: Math.max(0, Math.min(99999, Math.floor(finite(e.ascensions)))),
  };
  return out;
}

/**
 * Start a site-wide Skull Clicker event (a cursed-skull frenzy). Shared so
 * the hype-train webhook can call it too. Best-effort by contract: callers
 * wrap it so an event never breaks the thing that triggered it.
 */
export async function setSkullEvent(env, type, durationMs) {
  const until = Date.now() + Math.min(Math.max(0, durationMs || 0), EVENT_MAX_MS);
  await env.MARKETPLACE.put(EVENT_KEY, JSON.stringify({ type: type || 'frenzy', until }));
  return { type: type || 'frenzy', until };
}

/** The current event, or null when none is set or it has already elapsed. */
async function currentEvent(env) {
  const ev = await env.MARKETPLACE.get(EVENT_KEY, 'json');
  if (!ev || !ev.until || ev.until <= Date.now()) return null;
  return ev;
}

/* ── Seasonal leaderboard (display only — NO prizes) ────────────────────
   sc_leaderboard is the ALL-TIME board (lifetime skulls, never reset). The
   SEASON board ranks skulls gathered THIS month — a fresh monthly race for
   bragging rights. Skull Clicker deliberately awards NO leaderboard prizes:
   its heavy automation (auto-click / auto-buy / auto-prestige from the
   Reaping tree) makes it a solo idle game rather than a fair competitive
   board, so a turned month simply clears the board — nothing is whispered.
   The stored month is the authority; the client never has to get the reset
   moment right. */
const SEASON_KEY = 'sc_season';                 // { month:'YYYY-MM', entries:[] }

/* The seasonal reset rolls on the shared season calendar (SEASON_TZ), the same
   month boundary as the giveaway ledger / leaderboard awards / Phamily Time, so
   the Skull Clicker "wipe the run" happens at local month-end, not UTC's.
   Kept named monthKeyUTC to minimise churn at its many call sites. */
import { monthKey as monthKeyUTC } from './season-time.js';

function readSeason(raw) {
  if (raw && Array.isArray(raw.entries) && raw.month) return raw;
  return { month: monthKeyUTC(new Date()), entries: [] };
}

/* Ensure the season board is for the current month, clearing it when the
   month has turned. Display-only: no winners are prized — the board simply
   starts fresh for the new month's race. */
async function rolloverSeason(env) {
  const cur = monthKeyUTC(new Date());
  let s = readSeason(await env.MARKETPLACE.get(SEASON_KEY, 'json'));
  if (s.month === cur) return s;

  s = { month: cur, entries: [] };
  await env.MARKETPLACE.put(SEASON_KEY, JSON.stringify(s));
  return s;
}

/* The save-merge rank, matched exactly by the client. Prestige first, then
   lifetime skulls — never the run total, which prestige resets to zero. If
   the merge ranked on run total, a prestige (total 0) would lose to the old
   save and the sync would silently undo it. lifetime is monotonic and
   prestige only climbs, so this is safe from both directions. */
/* Coerces non-finite (Infinity/NaN/-Infinity) and negatives to 0, so a corrupt save
   ranks as LOWEST in outranks() below and can never win the merge over a good save. */
function num(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }
/* lifetime now ranks by log10 — the raw value is a big-number string that would
   overflow Number() to Infinity. Compares legacy numeric saves and new string
   saves alike, and a corrupt/missing value ranks lowest (log 0). */
function lifetimeOf(state) { return Math.max(parseScoreLog(state && state.lifetimeSkulls), parseScoreLog(state && state.totalSkulls)); }
function prestigeOf(state) { return Math.floor(num(state && state.prestige)); }
function ascensionOf(state) { return Math.floor(num(state && state.ascensions)); }
/* The seasonal-reset epoch as a monotonic month index (0 when missing, so a
   pre-migration save always ranks OLDEST). A newer epoch means the save has
   already taken this month's seasonal wipe. */
function epochOf(state) {
  const m = state && state.seasonEpoch;
  if (!m || typeof m !== 'string') return 0;
  const [y, mo] = m.split('-').map(Number);
  return (y && mo) ? y * 12 + (mo - 1) : 0;
}

/** True when `a` should win the merge over `b`.
 *  SEASON EPOCH FIRST: a save that has taken a newer monthly seasonal reset ALWAYS
 *  wins, bypassing the ascension/prestige/lifetime comparison — otherwise a wipe
 *  (which lowers prestige/run) would look "worse" and the stale higher-prestige
 *  save would silently revert it on the next sync. Within the SAME epoch the
 *  original protection is unchanged: ascension outranks prestige outranks lifetime,
 *  so a stale or cleared device still cannot clobber a better save. Kept identical
 *  to the client's serverOutranks(). */
function outranks(a, b) {
  const ea = epochOf(a), eb = epochOf(b);
  if (ea !== eb) return ea > eb;
  const aa = ascensionOf(a), ab = ascensionOf(b);
  if (aa !== ab) return aa > ab;
  const pa = prestigeOf(a), pb = prestigeOf(b);
  if (pa !== pb) return pa > pb;
  return lifetimeOf(a) > lifetimeOf(b);
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  /* `?epoch=1` — the current server-authoritative season epoch (UTC month key).
     The game uses THIS, never its own local clock, to decide the monthly seasonal
     reset — so a wrong client clock/timezone can neither miss a reset nor trigger
     a spurious self-wipe. */
  if (url.searchParams.get('epoch')) {
    return json({ epoch: monthKeyUTC(new Date()) });
  }
  /* `?event=1` — the live site-wide event the game polls for; kept separate
     from the leaderboard so the leaderboard's array shape never changes. The
     current epoch rides along so a long-open tab can also see the month turn. */
  if (url.searchParams.get('event')) {
    return json({ event: await currentEvent(env), epoch: monthKeyUTC(new Date()) });
  }
  /* `?board=season` — this month's race (rolled over on read so the display
     is always current); `?board=alltime` (or no param) — the persistent
     lifetime board, unchanged in shape for any existing caller. */
  if (url.searchParams.get('board') === 'season') {
    const s = await rolloverSeason(env);
    return json({ month: s.month, entries: s.entries.filter(notGuest).slice(0, 15).map(sanitizeEntry) });
  }
  const lb = await env.MARKETPLACE.get(LB_KEY, 'json') || [];
  return json(lb.filter(notGuest).slice(0, 15).map(sanitizeEntry));
}

/**
 * Cross-device save, LOGGED-IN PLAYERS ONLY. A guest's id lives in the same
 * localStorage a wipe clears, so there is nothing stable to key their save
 * on — the very failure this fixes would orphan it too.
 *
 * HIGHEST LIFETIME TOTAL WINS, always. totalSkulls only ever climbs, so it
 * is a safe merge key: an old tab or a second device can never clobber a
 * better save, and a cleared browser (local total 0) adopts the server's
 * on load rather than the reverse. The write returns the winner so the
 * client can adopt it when the server's was ahead.
 */
async function saveState(env, session, body) {
  const state = body && body.state;
  if (!state || typeof state !== 'object') return json({ error: 'No state' }, 400);
  if (JSON.stringify(state).length > SAVE_MAX_BYTES) return json({ error: 'Save too large' }, 400);

  /* Clamp every numeric field to finite before it can persist — a bad client can
     never push Infinity/NaN into KV, and the outranks() comparison below sees clean
     values. */
  sanitizeState(state);

  let winner = state;

  await env.MARKETPLACE.mutate(saveKey(session.user_id), (current) => {
    if (current && outranks(current, state)) {
      winner = current;                 /* server is ahead — keep it, tell the client */
      return undefined;                 /* no write */
    }
    return { ...state, savedAt: Date.now() };
  });

  return json({ success: true, adopted: winner !== state, state: winner });
}

async function loadState(env, session) {
  const state = await env.MARKETPLACE.get(saveKey(session.user_id), 'json');
  /* Heal on read: an already-corrupted save (e.g. mvgfamous's) returns finite values,
     so the client never adopts an Infinity/NaN even before the next write overwrites it. */
  return json({ state: state ? sanitizeState(state) : null });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  /* The save/load pair is login-only, so it checks the session directly
     rather than through getPlayer (which also admits guests). */
  if (body.action === 'save-state' || body.action === 'load-state') {
    const session = getSession(request);
    if (!session || !session.user_id) return json({ error: 'Log in to sync your progress.' }, 401);
    return body.action === 'save-state'
      ? saveState(env, session, body)
      : loadState(env, session);
  }

  /* Start a frenzy by hand — the broadcaster/moderators from Bot Control, or
     a curl. Bounded server-side so a bad client cannot set a forever-event. */
  if (body.action === 'trigger-event') {
    const session = getSession(request);
    const { isModerator } = await import('./admin/moderators.js');
    if (!(await isModerator(env, session))) {
      return json({ error: 'Only the broadcaster and moderators can start an event.' }, 403);
    }
    const mins = Math.min(30, Math.max(1, Math.floor(Number(body.minutes) || 5)));
    const ev = await setSkullEvent(env, 'frenzy', mins * 60 * 1000);
    return json({ success: true, event: ev });
  }

  if (body.action !== 'submit-score') return json({ error: 'Invalid action' }, 400);

  const player = getPlayer(request, body);
  if (!player) return json({ error: 'Not authenticated' }, 401);

  /* Guests play and keep a local save, but never appear on the public all-time or
     season boards — a per-browser identity can't be verified or awarded (and is
     already barred from prizes). Accept the submit so the client doesn't error;
     rank nothing. */
  if (isGuest(player.id)) return json({ success: true, updated: false, guest: true });

  /* Big-number score: travels as a string + scoreLog (log10). Rank/compare by
     scoreLog, store the string. A JSON'd Infinity arrives as null → log 0 → rejected;
     real scores (lifetime ≥ 100) have scoreLog ≥ 2. */
  const scoreLog = parseScoreLog(body.score, body.scoreLog);
  if (!(scoreLog > 0)) return json({ error: 'Invalid score' }, 400);
  const score = cleanScore(body.score);
  /* Carried for display — a prestige tier beside the name is the visible
     reward for resetting. Bounded so a bad client cannot store nonsense. */
  const prestige = Math.max(0, Math.min(9999, Math.floor(Number(body.prestige) || 0)));
  /* DISPLAY ONLY — the ascension (Reaping) count shown beside the name. It is
     NOT a ranking key (all-time still ranks by lifetime score, season by
     monthly skulls); it only ever ratchets up on an entry, exactly like the
     prestige badge. Older entries have no field and render as 0 / no badge. */
  const ascensions = Math.max(0, Math.min(99999, Math.floor(Number(body.ascensions) || 0)));

  /* SEASON board — skulls gathered this month, sent alongside the lifetime
     score. Handled first and independently so it still records even when the
     lifetime board's early-return fires below. Same string+scoreLog shape. */
  const seasonLog = parseScoreLog(body.seasonScore, body.seasonScoreLog);
  const seasonScore = cleanScore(body.seasonScore);
  if (seasonLog > 0) {
    const s = await rolloverSeason(env);
    const ex = s.entries.find(e => e.id === player.id);
    if (ex) {
      if (seasonLog > parseScoreLog(ex.score, ex.scoreLog)) { ex.score = seasonScore; ex.scoreLog = seasonLog; ex.name = player.name; ex.prestige = prestige; ex.updatedAt = Date.now(); }
      else if (prestige > (ex.prestige || 0)) { ex.prestige = prestige; }
      ex.ascensions = Math.max(ex.ascensions || 0, ascensions);   /* display badge, ratchets up */
    } else {
      s.entries.push({ id: player.id, name: player.name, score: seasonScore, scoreLog: seasonLog, prestige, ascensions, updatedAt: Date.now() });
    }
    s.entries.sort((a, b) => parseScoreLog(b.score, b.scoreLog) - parseScoreLog(a.score, a.scoreLog));
    s.entries = s.entries.slice(0, 50);
    await env.MARKETPLACE.put(SEASON_KEY, JSON.stringify(s));
  }

  const lb = await env.MARKETPLACE.get(LB_KEY, 'json') || [];

  const existing = lb.find(e => e.id === player.id);
  if (existing) {
    if (scoreLog > parseScoreLog(existing.score, existing.scoreLog)) {
      existing.score = score;
      existing.scoreLog = scoreLog;
      existing.name = player.name;
      existing.prestige = prestige;
      existing.ascensions = Math.max(existing.ascensions || 0, ascensions);
      existing.updatedAt = Date.now();
    } else {
      /* Score only ever rises, but the prestige AND ascension badges can climb
         while the leaderboard number is still catching up to a past run (a reap
         resets prestige to 0 without changing lifetime) — keep both current. */
      const newP = prestige > (existing.prestige || 0);
      const newA = ascensions > (existing.ascensions || 0);
      if (newP) existing.prestige = prestige;
      if (newA) existing.ascensions = ascensions;
      if (newP || newA) await env.MARKETPLACE.put(LB_KEY, JSON.stringify(lb));
      return json({ success: true, updated: false });
    }
  } else {
    lb.push({ id: player.id, name: player.name, score, scoreLog, prestige, ascensions, updatedAt: Date.now() });
  }

  lb.sort((a, b) => parseScoreLog(b.score, b.scoreLog) - parseScoreLog(a.score, a.scoreLog));
  const trimmed = lb.slice(0, 50);
  await env.MARKETPLACE.put(LB_KEY, JSON.stringify(trimmed));

  return json({ success: true, updated: true });
}
