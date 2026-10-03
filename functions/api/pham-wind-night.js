/* ══════════════════════════════════════════════
   PHAMSHOCK — WIND NIGHT: chat steers the wind (Epic D #12).

   A STREAM-NIGHT MODE, NOT A ROOM. Normal PhamShock is room-based (ps_room_),
   simultaneous artillery with a per-round wind the server gusts on its own.
   Wind Night is none of that room machinery: one SINGLETON the broadcaster/mods
   start from a control POST, where CHAT collectively moves the wind with a chat
   command. While a session is live its wind is SERVER-AUTHORITATIVE and every
   PhamShock room reads it (pham-shock.js getActiveWind), so chat's gusts blow
   across every battlefield on stream and all clients + the overlay agree. It
   touches no ps_room_ key, and when no session is active PhamShock plays exactly
   as before (its own per-round gust).

   THE FLOW
     • A mod POSTs `start`. Wind resets to 0 and the session goes live.
     • Every `!wind left` / `!wind right` in Twitch chat nudges the wind one step
       toward that side, clamped to [-WIND_MAX, WIND_MAX] (see windFromChat,
       called from bot/commands.js).
     • PhamShock's resolve() flies every shell with the session wind while live.

   THE AGGREGATE — "a value and a count, never a log".
     The session stores the current wind (one number) and two counters: nudges
     applied and distinct chatters. The per-chatter rate-limit map `seen`
     (uid -> last nudge time) is the ONLY per-person state and it is CAPPED at
     MAX_CHATTERS, so a raid of thousands cannot grow the record without bound —
     past the cap new chatters are turned away while the ones already in keep
     playing. There is no per-message log of any kind.

   RATE LIMIT: one nudge per chatter per NUDGE_COOLDOWN_MS. A chatter may keep
   steering the wind through the session, but only every few seconds, so a single
   spammer cannot pin the wind alone — it takes a chat.

   TIME IS RESOLVED LAZILY, like the rooms and the other chat games: a session
   nobody has nudged in IDLE_MS reads as over and the overlay poll flips it to
   `ended` and retires the pointer. No scheduler. An explicit End ends it now.

   STORAGE. One singleton key `pham_wind_night`, registered in
   server/lib/registry.js as { table: 'singletons', expiry: 'real' }: every write
   slides a TTL forward, so a session left unended lapses off the overlay rather
   than lingering. The live status is also timestamp-driven (lastActiveAt +
   IDLE_MS) so publicWind reads 'none' the moment it goes idle, before the row is
   even gone.
   ══════════════════════════════════════════════ */

export const WIND_NIGHT_KEY = 'pham_wind_night';

/* Matches PhamShock's own wind clamp (pham-shock.js resolve/checkTimers use
   [-8, 8]); chat can drive the wind across that whole range. */
export const WIND_MAX = 8;
export const WIND_STEP = 1;

/* One nudge per chatter per this window. Long enough that a lone spammer cannot
   hold the wind, short enough that a lively chat can swing it fast. */
export const NUDGE_COOLDOWN_MS = 5000;

/* No nudges for this long and the session puts itself away. */
export const IDLE_MS = 15 * 60 * 1000;

/* Storage backstop, comfortably longer than IDLE_MS so the timestamp rule is
   what ends a live session and the TTL only reclaims an abandoned row. */
const SESSION_TTL_SECONDS = 1200;

/* The per-chatter rate-limit map is capped so a raid cannot balloon the doc. */
const MAX_CHATTERS = 2000;

/* The unified "what's on stream" pointer id. stream-now.js must list
   'phamshock' in its GAMES whitelist or the refresh is a silent no-op. */
const STREAM_NOW_GAME = 'phamshock';

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

export function clampWind(w) {
  const n = Number(w) || 0;
  return Math.max(-WIND_MAX, Math.min(WIND_MAX, n));
}

function round1(w) { return Math.round((Number(w) || 0) * 10) / 10; }

/* A nudge direction from the chat argument. +1 blows right (toward +x, shown →),
   -1 blows left (toward -x, shown ←). Anything else is not a steer. */
export function parseWindDir(arg) {
  const a = String(arg == null ? '' : arg).trim().toLowerCase().split(/\s+/)[0];
  if (a === 'left' || a === 'l' || a === '<' || a === '<<' || a === '←') return -1;
  if (a === 'right' || a === 'r' || a === '>' || a === '>>' || a === '→') return 1;
  return 0;
}

function newSession(now, by) {
  return {
    status: 'active',
    startedAt: now,
    lastActiveAt: now,
    by: by || null,
    wind: 0,
    nudges: 0,
    chatters: 0,
    seen: {},
  };
}

/* A session is live only while active AND nudged within IDLE_MS. The pure read
   path (getActiveWind, publicWind) uses this so an idle session reads as over
   without anyone having to write first. */
function isLive(s, now) {
  return !!(s && s.status === 'active' && now - (Number(s.lastActiveAt) || Number(s.startedAt) || 0) < IDLE_MS);
}

/**
 * The server-authoritative wind for PhamShock to fly shells with, or null when
 * no Wind Night session is live. READ ONLY — never writes, so pham-shock.js can
 * call it on every poll without churning the row. null => normal per-round gust.
 */
export async function getActiveWind(env, now = Date.now()) {
  if (!env || !env.MARKETPLACE) return null;
  try {
    const s = await env.MARKETPLACE.get(WIND_NIGHT_KEY, 'json');
    return isLive(s, now) ? clampWind(s.wind) : null;
  } catch (err) {
    console.error('[pham-wind-night] read failed:', err.message);
    return null;
  }
}

/* The small shape the overlay reads — never the raw `seen` rate-limit map. An
   idle or ended (or absent) session reads as 'none' so the panel hides itself. */
export function publicWind(s, now = Date.now()) {
  if (!isLive(s, now)) return { status: 'none', serverNow: now };
  const wind = round1(clampWind(s.wind));
  return {
    status: 'active',
    serverNow: now,
    by: s.by || null,
    wind,
    dir: wind > 0.05 ? 'right' : wind < -0.05 ? 'left' : 'calm',
    strength: Math.abs(wind),
    max: WIND_MAX,
    chatters: s.chatters || 0,
    nudges: s.nudges || 0,
  };
}

/* Best-effort pointer upkeep — a stream_now hiccup must never take down the
   control action or chat nudge that triggered it. */
async function refreshPointer(env, by) {
  try {
    const { refreshStreamNow } = await import('./stream-now.js');
    await refreshStreamNow(env, { game: STREAM_NOW_GAME, label: 'Wind Night', level: by || null });
  } catch (err) {
    console.error('[pham-wind-night] could not refresh stream_now:', err.message);
  }
}

async function clearPointer(env) {
  try {
    const { clearStreamNow } = await import('./stream-now.js');
    await clearStreamNow(env, STREAM_NOW_GAME);
  } catch (err) {
    console.error('[pham-wind-night] could not clear stream_now:', err.message);
  }
}

/* ══ Chat participation — called from bot/commands.js on `!wind` ═══════════
   One step toward the named side, one nudge per chatter per cooldown, clamped
   to range. No live session → a quiet no-op. Silent by design: the overlay is
   the feedback, and a reply per chatter would bury the channel. */
export async function windFromChat(env, { userId, name, arg } = {}) {
  if (!env || !env.MARKETPLACE || !userId) return { ok: false, status: 'none' };
  const dir = parseWindDir(arg);
  if (!dir) return { ok: false, status: 'none' };
  const uid = String(userId);

  let landed = false;
  let after = null;

  await env.MARKETPLACE.mutate(WIND_NIGHT_KEY, (s) => {
    const now = Date.now();
    after = s;
    if (!isLive(s, now)) return undefined;   // no live session — nothing to steer

    s.seen = (s.seen && typeof s.seen === 'object') ? s.seen : {};
    const last = s.seen[uid];
    /* Rate limit: this chatter nudged within the cooldown. Quiet no-op. */
    if (last != null && now - last < NUDGE_COOLDOWN_MS) return undefined;

    const isNew = !(uid in s.seen);
    /* The bound: once the map is full, new chatters are turned away while the
       ones already in keep steering. Only ever reached by a chat far larger
       than any real session needs. */
    if (isNew && Object.keys(s.seen).length >= MAX_CHATTERS) return undefined;

    s.wind = clampWind((Number(s.wind) || 0) + dir * WIND_STEP);
    s.seen[uid] = now;
    if (isNew) s.chatters = (s.chatters || 0) + 1;
    s.nudges = (s.nudges || 0) + 1;
    s.lastActiveAt = now;
    landed = true;
    after = s;
    return s;
  }, { expirationTtl: SESSION_TTL_SECONDS });

  /* A landed nudge is activity — slide the unified pointer forward. */
  if (landed) await refreshPointer(env, after && after.by);

  return { ok: landed, status: publicWind(after).status, wind: after ? round1(after.wind) : 0 };
}

/* ══ GET — the overlay (OBS browser source) ═══════════════════════════════
   Key in the URL, like every overlay panel. Resolves the clock on read so an
   idle session is retired on schedule, and keeps the unified pointer alive
   while genuinely live (the maze does the same from its own GET). */
export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const { getOverlayKey } = await import('./overlay/events.js');
  const key = await getOverlayKey(env);
  if (url.searchParams.get('key') !== key) {
    return json({ error: 'Bad or missing key' }, 403);
  }

  let s = await env.MARKETPLACE.get(WIND_NIGHT_KEY, 'json');
  const now = Date.now();

  if (s && s.status === 'active' && !isLive(s, now)) {
    /* Gone idle: retire it now so the panel hides and the pointer clears,
       rather than waiting for the storage TTL to reclaim the row. */
    await env.MARKETPLACE.mutate(WIND_NIGHT_KEY, (cur) =>
      (cur && cur.status === 'active') ? { status: 'ended', endedAt: now } : undefined,
      { expirationTtl: 60 });
    await clearPointer(env);
    s = { status: 'ended' };
  } else if (isLive(s, now)) {
    /* Keep-alive while live: this overlay poll slides the unified pointer. */
    await refreshPointer(env, s.by);
  }

  return json(publicWind(s, now));
}

/* ══ POST — the control button (broadcaster / moderators) ═════════════════ */
export async function onRequestPost(context) {
  const { env, request } = context;

  const { isModerator } = await import('./admin/moderators.js');
  const session = getSession(request);
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can run Wind Night.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'start') {
    const now = Date.now();
    const s = newSession(now, session.display_name || null);
    /* Overwrites any previous session — a fresh start resets the wind to 0
       rather than inheriting an old gust. */
    await env.MARKETPLACE.mutate(WIND_NIGHT_KEY, () => s, { expirationTtl: SESSION_TTL_SECONDS });
    await refreshPointer(env, s.by);
    return json({ success: true, wind: publicWind(s, now) });
  }

  if (body.action === 'end') {
    /* A tombstone rather than a delete, so a nudge already holding the lock
       cannot resurrect the session by writing it back. */
    await env.MARKETPLACE.mutate(WIND_NIGHT_KEY, () => ({ status: 'ended', endedAt: Date.now() }),
      { expirationTtl: 60 });
    await clearPointer(env);
    return json({ success: true });
  }

  return json({ error: 'Invalid action' }, 400);
}
