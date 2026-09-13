export async function onRequestGet(context) {
  const { env } = context;
  const clientId = env.TWITCH_CLIENT_ID;
  const clientSecret = env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return Response.json(
      { live: false, error: 'Twitch credentials not configured' },
      { status: 200 }
    );
  }

  try {
    /* Shared cached token. This used to mint a brand new app token on every
       single request, and Twitch invalidates older app tokens as new ones are
       issued — so ordinary traffic here was silently revoking the token the
       bot setup relied on, surfacing as "Invalid OAuth token" on an unrelated
       admin page. See functions/api/auth/app-token.js. */
    /* withAppToken, NOT getAppToken. The wrapper refreshes once on a 401 and
       retries, which is what makes a revoked token self-heal on ordinary
       traffic. Calling getAppToken directly returns a cached token forever
       while it is unexpired — a token Twitch has already revoked looks
       perfectly valid by its own metadata, so nothing on this path would ever
       discover it was dead. That is exactly what happened: this endpoint
       returned {"live":false,"error":"Stream request failed: 401"} on every
       poll, with HTTP 200, so it failed silently and indefinitely. */
    const { withAppToken } = await import('./auth/app-token.js');
    const streamRes = await withAppToken(env, (token) => fetch(
      'https://api.twitch.tv/helix/streams?user_login=phantomace',
      { headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId } }
    ));
    if (!streamRes) throw new Error('Could not get an app access token');

    if (!streamRes.ok) {
      throw new Error(`Stream request failed: ${streamRes.status}`);
    }

    const { data } = await streamRes.json();

    if (data && data.length > 0) {
      const stream = data[0];
      return Response.json({
        live: true,
        title: stream.title,
        game: stream.game_name,
        viewers: stream.viewer_count,
        thumbnail: stream.thumbnail_url,
        started_at: stream.started_at,
      }, {
        headers: { 'Cache-Control': 'public, max-age=60' },
      });
    }

    return Response.json(
      { live: false },
      { headers: { 'Cache-Control': 'public, max-age=60' } }
    );
  } catch (err) {
    return Response.json(
      { live: false, error: err.message },
      { status: 200 }
    );
  }
}
