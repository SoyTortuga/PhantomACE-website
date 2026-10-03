/* ══════════════════════════════════════════════
   STREAM-NOW — the ONE "what's on stream" pointer.

   For years each game kept its own live-on-stream signal: bingo_current,
   mtgbbb_current, maze_current (status), chat_scramble (status). Each overlay
   panel polled its own key through its own endpoint, and bingo/mtgbbb never
   stopped on their own — a host who closed the tab left the panel up for the
   room's whole 4h TTL. Maze and scramble already self-retire on inactivity;
   this generalises that pattern to all four.

   `stream_now` is a SINGLE singleton the overlay reads once per poll (as
   `whatsOn`, through overlay/events.js). It carries only the light fields a
   panel needs to decide whether to show and to draw its header — the detailed
   board still comes from each game's own state endpoint while it is the shown
   game.

   HOW IT RETIRES — the inactivity fix. Writers REFRESH it on a sliding TTL
   (~3 min): a game's START, its ACTIVITY, and the host/control presence poll
   all call refreshStreamNow. The public VIEWER overlay poll only ever READS it
   (readStreamNow never writes), so the moment the host stops polling — closes
   their tab — nothing refreshes it and it lapses within the TTL, clearing the
   overlay by itself. "Clear on end" becomes "stop refreshing"; an explicit
   End still clears it immediately via clearStreamNow.

   SINGLE GAME ON STREAM. Refreshing for one game REPLACES the pointer (last
   writer wins), so two games can never both show.

   This file exports NO request handler — it is a LIBRARY. It must be listed in
   server/router.js's NON_ROUTE_MODULES, or the rig boot crashes to
   SERVICE_PAUSED. The key `stream_now` must be registered in
   server/lib/registry.js as { table: 'singletons', expiry: 'real' } — the
   'real' expiry is what makes the sliding TTL actually retire the row.
   ══════════════════════════════════════════════ */

export const STREAM_NOW_KEY = 'stream_now';

/* ~3 minutes. Long enough that a quiet bingo stretch stays live while the host
   page keeps polling, short enough that a closed tab clears the overlay
   promptly. Cloudflare KV refuses a TTL under 60s, so every write floors at
   60 — never a concern at this value, but guarded below regardless. */
export const STREAM_NOW_TTL_SECONDS = 180;

/* 'mana-clash' is the Streamer-vs-Chat clash event (mana-clash-chat.js), not
   the room-based game — it rides this one pointer like the others so starting
   it retires whatever game was on stream (one game on stream, last writer
   wins). Its own overlay panel polls its own endpoint for the board. */
/* 'phamshock' is the PhamShock Wind Night stream event (pham-wind-night.js),
   not the room-based artillery game — it rides this one pointer like the others
   so starting it retires whatever game was on stream (one game on stream, last
   writer wins). Its own overlay panel polls its own endpoint for the wind. */
/* 'dino-park' is the Dino Stream Safari event (dino-safari.js), not the
   single-player park — it rides this one pointer like the others so starting a
   Safari retires whatever game was on stream. Its own overlay panel polls its
   own endpoint for the current wild spawn. */
const GAMES = ['bingo', 'mtgbbb', 'maze', 'scramble', 'mana-clash', 'phamshock', 'dino-park'];

/**
 * Refresh (or set) the pointer for `info.game`, sliding its TTL forward.
 *
 * Called from each game's START, its ACTIVITY writes, and its host/control
 * presence poll — never from the public overlay read. Pointing at one game
 * replaces whatever was there, enforcing one-game-on-stream. Only the light
 * header fields are kept; anything omitted is carried over when the SAME game
 * (and code, when given) is already current, else reset.
 *
 * Never throws — a pointer refresh must not take down the call, pull or poll
 * that triggered it. Returns the written record, or null on a bad game / error.
 */
export async function refreshStreamNow(env, info, ttlSeconds = STREAM_NOW_TTL_SECONDS) {
  if (!env || !env.MARKETPLACE || !info || GAMES.indexOf(info.game) === -1) return null;
  const now = Date.now();
  let out = null;
  try {
    await env.MARKETPLACE.mutate(STREAM_NOW_KEY, (cur) => {
      const prior = (cur && cur.game === info.game &&
        (info.code == null || String(cur.code || '') === String(info.code))) ? cur : null;
      const carry = (v, p) => (v != null ? v : (prior ? (p != null ? p : null) : null));
      out = {
        game: info.game,
        code: info.code != null ? String(info.code) : (prior ? (prior.code != null ? prior.code : null) : null),
        label: carry(info.label, prior && prior.label),
        setName: carry(info.setName, prior && prior.setName),
        level: carry(info.level, prior && prior.level),
        startedAt: (prior && prior.startedAt) ? prior.startedAt : (info.startedAt || now),
        lastActiveAt: now,
      };
      return out;
    }, { expirationTtl: Math.max(ttlSeconds, 60) });
  } catch (err) {
    console.error('[stream-now] refresh failed:', err.message);
  }
  return out;
}

/**
 * The current pointer, or null when nothing is on stream (absent row, an
 * expired/lapsed one, or an explicit clear's tombstone). READ ONLY — this is
 * what the public overlay poll uses, so it must never refresh the TTL. That is
 * the whole inactivity mechanism: only writers keep it alive.
 */
export async function readStreamNow(env) {
  try {
    const rec = await env.MARKETPLACE.get(STREAM_NOW_KEY, 'json');
    if (!rec || !rec.game) return null;
    return rec;
  } catch (err) {
    console.error('[stream-now] read failed:', err.message);
    return null;
  }
}

/**
 * Clear the pointer immediately on an explicit End/stop, but ONLY if it still
 * names `game` (and `code`, when given). A stale end on an old room must never
 * blank a newer game's overlay — the same last-writer-wins guard bingo_current
 * and mtgbbb_current already apply. A null `game` clears whatever is there.
 *
 * Writes a short-lived `{ game: null }` tombstone rather than deleting, so the
 * guard stays atomic inside the mutate; readStreamNow reads it as "nothing on".
 */
export async function clearStreamNow(env, game = null, code = null) {
  if (!env || !env.MARKETPLACE) return;
  try {
    await env.MARKETPLACE.mutate(STREAM_NOW_KEY, (cur) => {
      if (!cur || !cur.game) return undefined;                       // already clear
      if (game && cur.game !== game) return undefined;              // names a different game — leave it
      if (code != null && String(cur.code || '') !== String(code)) return undefined;
      return { game: null, clearedAt: Date.now() };
    }, { expirationTtl: 60 });
  } catch (err) {
    console.error('[stream-now] clear failed:', err.message);
  }
}
