export async function onRequestGet(context) {
  const { env } = context;
  const clientId = env.TWITCH_CLIENT_ID;
  const clientSecret = env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return Response.json(
      { segments: [], error: 'Twitch credentials not configured' },
      { status: 200 }
    );
  }

  try {
    /* Shared cached token. This used to mint a brand new app token on every
       single request, and Twitch invalidates older app tokens as new ones are
       issued — so ordinary traffic here was silently revoking the token the
       bot setup relied on, surfacing as "Invalid OAuth token" on an unrelated
       admin page. See functions/api/auth/app-token.js. */
    /* getAppToken, not withAppToken: this handler makes several Helix calls
       with one token, so a per-call retry would be awkward. It does not need
       one. twitch-status.js is polled by every page load and uses
       withAppToken, so a revoked token is discovered and replaced in the
       SHARED cache within seconds — long before a low-traffic endpoint like
       this one would notice. Stating that dependency explicitly, because it
       is the reason this is safe rather than an oversight. */
    const { getAppToken } = await import('./auth/app-token.js');
    const access_token = await getAppToken(env);
    if (!access_token) throw new Error('Could not get an app access token');


    const userRes = await fetch(
      'https://api.twitch.tv/helix/users?login=phantomace',
      {
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Client-Id': clientId,
        },
      }
    );

    if (!userRes.ok) {
      throw new Error(`User lookup failed: ${userRes.status}`);
    }

    const userData = await userRes.json();
    if (!userData.data || userData.data.length === 0) {
      throw new Error('User not found');
    }

    const broadcasterId = userData.data[0].id;

    const scheduleRes = await fetch(
      `https://api.twitch.tv/helix/schedule?broadcaster_id=${broadcasterId}&first=10`,
      {
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Client-Id': clientId,
        },
      }
    );

    if (scheduleRes.status === 404) {
      return Response.json(
        { segments: [] },
        { headers: { 'Cache-Control': 'public, max-age=300' } }
      );
    }

    if (!scheduleRes.ok) {
      throw new Error(`Schedule request failed: ${scheduleRes.status}`);
    }

    const scheduleData = await scheduleRes.json();
    const segments = (scheduleData.data?.segments || []).map(seg => ({
      id: seg.id,
      title: seg.title,
      start_time: seg.start_time,
      end_time: seg.end_time,
      category: seg.category?.name || null,
      is_recurring: seg.is_recurring,
    }));

    return Response.json(
      { segments },
      { headers: { 'Cache-Control': 'public, max-age=300' } }
    );
  } catch (err) {
    return Response.json(
      { segments: [], error: err.message },
      { status: 200 }
    );
  }
}
