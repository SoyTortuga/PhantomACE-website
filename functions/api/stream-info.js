/* ══════════════════════════════════════════════
   IS THE CHANNEL LIVE, AND WHICH BROADCAST IS IT?

   Library, not a route. Declared in server/router.js NON_ROUTE_MODULES —
   adding a file under functions/ without declaring it fails the boot, which
   is how a previous change took production down for three minutes.

   Two callers need different halves of the same Twitch call:

     phamily-time.js  — only whether the channel is live, so watch time does
                        not accrue while nobody is streaming.
     channel-points.js — WHICH broadcast a check-in belongs to.

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

/**
 * @returns {Promise<{live:boolean, streamId:string|null, startedAt:string|null}>}
 *
 * Never throws. A failure to reach Twitch reports not-live rather than
 * propagating: every caller treats "live" as permission to do something, and
 * an outage should withhold that, not crash a webhook.
 */
export async function getStreamInfo(env) {
  const cached = await env.MARKETPLACE.get(CACHE_KEY, 'json');
  if (cached && cached.checkedAt > Date.now() - CACHE_MS) {
    return { live: !!cached.live, streamId: cached.streamId || null, startedAt: cached.startedAt || null };
  }

  const clientId = env.TWITCH_CLIENT_ID;
  if (!clientId) return { live: false, streamId: null, startedAt: null };

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
    if (!res || !res.ok) return { live: false, streamId: null, startedAt: null };

    const { data } = await res.json();
    const stream = data && data[0];
    const info = {
      live: !!stream,
      /* Twitch mints a new stream id per broadcast, so it is the natural
         identity for "this stream" — and the thing that makes a per-stream
         reset detectable without a scheduled job. */
      streamId: stream ? String(stream.id) : null,
      startedAt: stream ? stream.started_at : null,
    };

    await env.MARKETPLACE.put(CACHE_KEY, JSON.stringify({ ...info, checkedAt: Date.now() }), { expirationTtl: 60 });
    return info;
  } catch {
    return { live: false, streamId: null, startedAt: null };
  }
}

/** Convenience for callers that only care whether anything is on air. */
export async function isChannelLive(env) {
  return (await getStreamInfo(env)).live;
}
