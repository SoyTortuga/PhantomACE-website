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
