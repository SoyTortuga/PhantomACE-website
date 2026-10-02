/* ══════════════════════════════════════════════
   IS THE CHANNEL LIVE, AND WHICH BROADCAST IS IT?

   Library, not a route. Declared in server/router.js NON_ROUTE_MODULES —
   adding a file under functions/ without declaring it fails the boot, which
   is how a previous change took production down for three minutes.

   Three callers need different slices of the same Twitch call:

     phamily-time.js  — only whether the channel is live, so watch time does
                        not accrue while nobody is streaming.
     channel-points.js — WHICH broadcast a check-in belongs to, and (for the
                        raid boss redemption) how many people are watching.

   They shared a cache key (twitch_live_cache) before this existed, and one
   of them wrote {live, checkedAt} while the other wanted a stream id. Two
   writers, one key, different shapes: whichever ran last decided what the
   other could see. So there is one reader and one writer, here.

   The 30-second cache is load-bearing, not an optimisation. Every heartbeat
   from every open page calls this; without it, N viewers means N calls a
   minute to Twitch.
   ══════════════════════════════════════════════ */

const CACHE_KEY = 'twitch_live_cache';
const CACHE_MS = 30000;
const CHANNEL = 'phantomace';

/* How long after last SEEING the stream live a failed lookup may still name
   it. Comfortably past a Twitch or database blip; short of the gap between
   two broadcasts, so a failure at the start of the NEXT stream cannot hand
   back the previous one's id. */
const LAST_LIVE_GRACE_MS = 15 * 60 * 1000;
/* Only when no live sighting is on record at all (a fresh cache row): the
   newest logged broadcast, if it began recently enough to still be running. */
const LOG_FALLBACK_MS = 12 * 60 * 60 * 1000;

const OFFLINE = { live: false, streamId: null, startedAt: null, viewerCount: 0 };

/**
 * The stream a FAILED lookup should still attribute things to.
 *
 * A failed lookup used to return streamId null, and a null was read
 * downstream as "a new broadcast" — the check-in list was replaced, everyone
 * after became an early bird again, and streaks reset. The live flag stays
 * false (an outage still withholds permission, as before); only the identity
 * of the stream already known to be running is carried through, marked
 * stale. If nothing recent is known, the answer stays null — "unknown" —
 * which callers must treat as unknown, never as new.
 */
async function lastKnownStream(env, cached) {
  const now = Date.now();
  const last = cached && cached.lastLive;
  if (last && last.streamId) {
    if (now - (Number(last.seenAt) || 0) < LAST_LIVE_GRACE_MS) {
      return { ...OFFLINE, streamId: String(last.streamId), startedAt: last.startedAt || null, stale: true };
    }
    return { ...OFFLINE, stale: true };
  }
  try {
    const log = await env.MARKETPLACE.get('stream_log', 'json');
    const streams = log && Array.isArray(log.streams) ? log.streams : [];
    const newest = streams[streams.length - 1];
    if (newest && newest.id) {
      const began = newest.startedAt ? Date.parse(newest.startedAt) : Number(newest.at);
      if (Number.isFinite(began) && now - began < LOG_FALLBACK_MS) {
        return { ...OFFLINE, streamId: String(newest.id), startedAt: newest.startedAt || null, stale: true };
      }
    }
  } catch { /* no fallback is still an answer: unknown */ }
  return { ...OFFLINE, stale: true };
}

/**
 * @returns {Promise<{live:boolean, streamId:string|null, startedAt:string|null, viewerCount:number, stale?:true}>}
 *
 * Never throws. A failure to reach Twitch reports not-live rather than
 * propagating: every caller treats "live" as permission to do something, and
 * an outage should withhold that, not crash a webhook. `stale` marks an
 * answer that came from what was last known rather than from Twitch.
 */
export async function getStreamInfo(env) {
  let cached = null;
  try {
    cached = await env.MARKETPLACE.get(CACHE_KEY, 'json');
  } catch {
    return { ...OFFLINE, stale: true };
  }
  if (cached && cached.checkedAt > Date.now() - CACHE_MS) {
    return {
      live: !!cached.live, streamId: cached.streamId || null, startedAt: cached.startedAt || null,
      viewerCount: cached.viewerCount || 0,
    };
  }

  const clientId = env.TWITCH_CLIENT_ID;
  if (!clientId) return { ...OFFLINE };

  try {
    /* withAppToken, NOT getAppToken: the wrapper refreshes once on a 401 and
       retries. A token Twitch has already revoked still looks valid by its
       own metadata, so a plain cached read would keep returning a dead token
       forever — which is exactly how this endpoint once reported
       {"live":false} on every single poll, with HTTP 200, indefinitely. */
    const { withAppToken } = await import('./auth/app-token.js');
    const res = await withAppToken(env, (token) => fetch(
      `https://api.twitch.tv/helix/streams?user_login=${CHANNEL}`,
      { headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId } }
    ));
    if (!res || !res.ok) return await lastKnownStream(env, cached);

    const { data } = await res.json();
    const stream = data && data[0];
    const info = {
      live: !!stream,
      /* Twitch mints a new stream id per broadcast, so it is the natural
         identity for "this stream" — and the thing that makes a per-stream
         reset detectable without a scheduled job. */
      streamId: stream ? String(stream.id) : null,
      startedAt: stream ? stream.started_at : null,
      viewerCount: stream ? stream.viewer_count : 0,
    };

    /* The last live sighting rides in the same row, carried across offline
       answers, so a later failed lookup knows what was running. The row is a
       non-expiring singleton (registry.js), so it survives the TTL below;
       freshness is checkedAt's job. */
    const now = Date.now();
    const lastLive = stream
      ? { streamId: info.streamId, startedAt: info.startedAt, seenAt: now }
      : (cached && cached.lastLive) || null;
    try {
      await env.MARKETPLACE.put(CACHE_KEY, JSON.stringify({ ...info, checkedAt: now, lastLive }), { expirationTtl: 60 });
    } catch { /* the answer is still good without the cache */ }
    return info;
  } catch {
    return await lastKnownStream(env, cached);
  }
}

/** Convenience for callers that only care whether anything is on air. */
export async function isChannelLive(env) {
  return (await getStreamInfo(env)).live;
}
