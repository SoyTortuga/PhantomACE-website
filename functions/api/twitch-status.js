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
    const { getAppToken } = await import('./auth/app-token.js');
    const access_token = await getAppToken(env);
    if (!access_token) throw new Error('Could not get an app access token');


    const streamRes = await fetch(
      'https://api.twitch.tv/helix/streams?user_login=phantomace',
      {
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Client-Id': clientId,
        },
      }
    );

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
