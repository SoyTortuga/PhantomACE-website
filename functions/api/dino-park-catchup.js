/* ══════════════════════════════════════════════
   DINO PARK — OFFLINE EGG CATCH-UP

   Eggs incubate only while PhantomACE is live (games/dino-park/index.html's
   gameTick gates it on isStreamLive) — a deliberate "watch the stream"
   mechanic, not a bug. But it used to mean genuinely lost progress for a
   closed browser: applyOfflineDecay() already says as much in its own
   comment ("time the game was closed can't be attributed to live minutes,
   so it isn't decayed retroactively here") — written when there was no way
   to know whether the stream WAS live during that gap.

   Twitch's VOD history is that missing information. This endpoint takes
   the last moment the client is known to have been ticking (`since`) and
   answers "how many seconds between then and now was PhantomACE live",
   by summing overlap between [since, now] and the channel's own archived
   broadcasts. The client then credits that many seconds to every
   incubating egg — additively, on top of whatever it has already ticked
   locally, so a slow response can never roll elapsed backwards.

   NO SESSION REQUIRED. This is channel-wide public information (anyone can
   see the VOD list on the Twitch channel page); it carries no per-player
   data, so guests get offline catch-up exactly like logged-in players.

   WHY VODs AND NOT AN EVENTSUB LOG. There is no channel.stream.online /
   channel.stream.offline subscription anywhere in this project (checked:
   functions/api/admin/bot-setup.js registers hype train, channel points,
   and chat — nothing tracks live/offline transitions), so there is no
   first-party history to consult. VOD start time + duration is the only
   record Twitch itself keeps of when a broadcast happened, and it is
   already how much of Dino Park's existing player base experiences their
   own stream history.
   ══════════════════════════════════════════════ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/* Bounds how far back a catch-up will look, in both directions:
   - a player gone longer than this gets no catch-up for the excess, rather
     than an unbounded VOD scan;
   - it caps how many pages of VODs a single request will ever fetch, since
     Helix returns newest-first and pagination stops as soon as a page's
     oldest VOD starts before the window (see the loop below). */
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const VOD_PAGE_SIZE = 20;
const MAX_VOD_PAGES = 5;

/* Twitch's video duration format ("3h24m10s", "45m2s", "10s", "2h") always
   omits zero-valued leading units, so every piece is optional. Malformed or
   missing input reads as zero rather than throwing — a single bad VOD entry
   should cost that VOD's credit, not the whole response. */
export function parseDuration(d) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(d || ''));
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  const h = parseInt(m[1] || '0', 10), mi = parseInt(m[2] || '0', 10), s = parseInt(m[3] || '0', 10);
  return h * 3600 + mi * 60 + s;
}

/** Seconds of [vodStart, vodEnd) that fall inside [from, now). */
export function overlapSeconds(vodStart, vodEnd, from, now) {
  const ms = Math.max(0, Math.min(vodEnd, now) - Math.max(vodStart, from));
  return ms / 1000;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const since = parseInt(url.searchParams.get('since'), 10);
  const now = Date.now();

  /* A bad or missing `since`, or one already in the future, credits
     nothing — there is no gap to have missed. */
  if (!Number.isFinite(since) || since <= 0 || since >= now) {
    return json({ liveSeconds: 0 });
  }

  const from = Math.max(since, now - MAX_WINDOW_MS);

  const broadcasterId = env.TWITCH_BROADCASTER_ID;
  const clientId = env.TWITCH_CLIENT_ID;
  if (!broadcasterId || !clientId) return json({ liveSeconds: 0 });

  try {
    const { withAppToken } = await import('./auth/app-token.js');

    let liveSeconds = 0;
    let cursor = null;

    for (let page = 0; page < MAX_VOD_PAGES; page++) {
      const params = new URLSearchParams({ user_id: broadcasterId, type: 'archive', first: String(VOD_PAGE_SIZE) });
      if (cursor) params.set('after', cursor);

      const res = await withAppToken(env, (token) => fetch(
        `https://api.twitch.tv/helix/videos?${params}`,
        { headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId } }
      ));
      if (!res || !res.ok) break;

      const body = await res.json();
      const videos = Array.isArray(body.data) ? body.data : [];
      if (!videos.length) break;

      let oldestStart = now;
      for (const v of videos) {
        const start = new Date(v.created_at).getTime();
        if (!Number.isFinite(start)) continue;
        const end = start + parseDuration(v.duration) * 1000;
        liveSeconds += overlapSeconds(start, end, from, now);
        if (start < oldestStart) oldestStart = start;
      }

      /* Helix returns VODs newest-first. Once a page's oldest video already
         starts at or before the window's edge, every earlier page can only
         contain VODs that are older still — none of them can overlap
         [from, now), so paging further would just spend calls for zero
         additional credit. */
      if (oldestStart <= from) break;

      cursor = body.pagination && body.pagination.cursor;
      if (!cursor) break;
    }

    liveSeconds = Math.min(liveSeconds, (now - from) / 1000);
    return json({ liveSeconds: Math.round(liveSeconds) });
  } catch (err) {
    /* A missed catch-up is a cosmetic loss — an egg simply isn't credited
       for this gap — never something that should surface as a page error. */
    return json({ liveSeconds: 0, error: err.message });
  }
}
