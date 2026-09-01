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
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(`Token request failed: ${tokenRes.status}`);
    }

    const { access_token } = await tokenRes.json();

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
