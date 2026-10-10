/* ══════════════════════════════════════════════
   IS HE LIVE? — the header's LIVE dot.

   This is the single most-called route on the site: the shared header asks
   on every page load and every 60 seconds after, for every visitor. It used
   to make its OWN Twitch Helix call each time, which is exactly what
   stream-info.js was written to stop ("Every heartbeat from every open page
   calls this; without it, N viewers means N calls a minute to Twitch"). It
   was the one caller that bypassed the shared 30-second cache.

   That is not only load. An app token has a finite points budget, and when a
   busy stream exhausts it this route answered {"live": false} with HTTP 200
   — so the dot went dark in the middle of a broadcast, silently.

   `error` IS PART OF THE CONTRACT. js/notifications.js reads
   `if (!status || status.error) return;` to decide whether to ANNOUNCE a
   change, so a lookup that merely FAILED must not come back as a plain
   `live: false` — that announces "PhantomACE has gone offline" on a blip and
   "is now LIVE!" when it recovers. getStreamInfo marks a failed lookup
   `stale`; that is mapped back onto `error` below.
   ══════════════════════════════════════════════ */

export async function onRequestGet(context) {
  const { env } = context;

  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    return Response.json(
      { live: false, error: 'Twitch credentials not configured' },
      { status: 200 }
    );
  }

  /* max-age for the browser (it polls every 60s anyway), s-maxage so the edge
     can answer a burst of page loads without touching the rig at all. Shorter
     than max-age on purpose: the shared copy is the one that must not lag
     behind a stream going live. */
  const headers = { 'Cache-Control': 'public, max-age=60, s-maxage=30' };

  try {
    const { getStreamInfo } = await import('./stream-info.js');
    const info = await getStreamInfo(env);

    /* A failed lookup, not an offline channel. Same shape the client already
       handles for an unreachable request. */
    if (info.stale) {
      return Response.json({ live: false, error: 'stream lookup failed' }, { status: 200, headers });
    }

    if (!info.live) return Response.json({ live: false }, { headers });

    return Response.json({
      live: true,
      title: info.title,
      game: info.category,
      viewers: info.viewerCount,
      thumbnail: info.thumbnail,
      started_at: info.startedAt,
    }, { headers });
  } catch (err) {
    /* `error` keeps anything that announces a change quiet. */
    return Response.json({ live: false, error: err.message }, { status: 200 });
  }
}
