const TWITCH_CHANNEL = 'phantomace';
const COOKIE_NAME = 'pham_session';

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  const clientId = env.TWITCH_CLIENT_ID;
  const clientSecret = env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return json({ error: 'Twitch not configured' }, 500);

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
    if (!tokenRes.ok) throw new Error('Token request failed');
    const { access_token } = await tokenRes.json();

    const headers = { 'Authorization': `Bearer ${access_token}`, 'Client-Id': clientId };

    const broadcasterRes = await fetch(
      `https://api.twitch.tv/helix/users?login=${TWITCH_CHANNEL}`, { headers }
    );
    const { data: broadcasters } = await broadcasterRes.json();
    const broadcasterId = broadcasters[0]?.id;
    if (!broadcasterId) return json({ error: 'Channel not found' }, 500);

    let role = 'visitor';
    let subTier = 0;

    try {
      const subRes = await fetch(
        `https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=${broadcasterId}&user_id=${session.user_id}`,
        { headers }
      );
      if (subRes.ok) {
        const subData = await subRes.json();
        if (subData.data?.length > 0) {
          const tier = subData.data[0].tier;
          if (tier === '3000') { role = 'sub_tier3'; subTier = 3; }
          else if (tier === '2000') { role = 'sub_tier2'; subTier = 2; }
          else { role = 'sub_tier1'; subTier = 1; }
        }
      }
    } catch {}

    if (role === 'visitor') {
      try {
        const followRes = await fetch(
          `https://api.twitch.tv/helix/channels/followed?user_id=${session.user_id}&broadcaster_id=${broadcasterId}`,
          { headers }
        );
        if (followRes.ok) {
          const followData = await followRes.json();
          if (followData.data?.length > 0) role = 'follower';
        }
      } catch {}
    }

    const updatedSession = { ...session, role };
    const url = new URL(request.url);
    /* Must sign, exactly as the login flow does. An unsigned cookie issued
       here would be rejected by the server's session gate on the very next
       request, silently logging the user out the moment their roles were
       refreshed — the opposite of what this endpoint is for. */
    const { signSession } = await import('./session-crypto.js');
    const cookieValue = await signSession(updatedSession, env.SESSION_SECRET);
    const isSecure = url.protocol === 'https:';
    const flags = ['Path=/', 'Max-Age=86400', 'SameSite=Lax'];
    if (isSecure) flags.push('Secure');

    return new Response(JSON.stringify({ role, subTier }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `${COOKIE_NAME}=${cookieValue}; ${flags.join('; ')}`,
      },
    });
  } catch (err) {
    return json({ error: 'Failed to check roles' }, 500);
  }
}
