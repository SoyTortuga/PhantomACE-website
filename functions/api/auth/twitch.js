const TWITCH_CHANNEL = 'phantomace';
const SCOPES = 'user:read:follows user:read:subscriptions';
const COOKIE_NAME = 'pham_session';
const COOKIE_MAX_AGE = 86400;

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const clientId = env.TWITCH_CLIENT_ID;
  const clientSecret = env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return new Response('Twitch credentials not configured', { status: 500 });
  }

  const redirectUri = `${url.origin}/api/auth/twitch`;
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');

  if (error) {
    /* Twitch rejected the authorisation. This used to redirect to returnTo
       and drop the reason entirely, which made a failed login look identical
       to "the button did nothing": no cookie, no message, no trace. That cost
       real debugging time — an invalid redirect_uri produced a silent bounce
       with nothing anywhere to explain it.

       Surface it both ways: a log line for whoever is running the server, and
       a query param so it is visible in the address bar even when the failure
       happens on a deployment whose logs nobody can read. */
    const description = url.searchParams.get('error_description') || '';
    console.error(`[auth] Twitch OAuth error: ${error}${description ? ' — ' + description : ''} (redirect_uri sent: ${redirectUri})`);

    const returnTo = state ? decodeURIComponent(state) : '/';
    const sep = returnTo.includes('?') ? '&' : '?';
    return Response.redirect(
      `${url.origin}${returnTo}${sep}login_error=${encodeURIComponent(error)}`,
      302
    );
  }

  if (!code) {
    const returnTo = url.searchParams.get('return_to') || '/';
    const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('state', encodeURIComponent(returnTo));
    return Response.redirect(authUrl.toString(), 302);
  }

  const returnPath = state ? decodeURIComponent(state) : '/';

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();

    const headers = {
      'Authorization': `Bearer ${access_token}`,
      'Client-Id': clientId,
    };

    const userRes = await fetch('https://api.twitch.tv/helix/users', { headers });
    if (!userRes.ok) throw new Error('User fetch failed');
    const { data: users } = await userRes.json();
    const user = users[0];

    const broadcasterRes = await fetch(
      `https://api.twitch.tv/helix/users?login=${TWITCH_CHANNEL}`,
      { headers }
    );
    const { data: broadcasters } = await broadcasterRes.json();
    const broadcasterId = broadcasters[0]?.id;

    let role = 'visitor';
    let followedAt = null;
    let subscribedAt = null;
    let subExpiresAt = null;

    if (user.login.toLowerCase() === TWITCH_CHANNEL.toLowerCase()) {
      role = 'broadcaster';
    } else if (broadcasterId) {
      try {
        const followRes = await fetch(
          `https://api.twitch.tv/helix/channels/followed?user_id=${user.id}&broadcaster_id=${broadcasterId}`,
          { headers }
        );
        if (followRes.ok) {
          const followData = await followRes.json();
          if (followData.data?.length > 0) {
            role = 'follower';
            followedAt = followData.data[0].followed_at;
          }
        }
      } catch {}

      try {
        const subRes = await fetch(
          `https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=${broadcasterId}`,
          { headers }
        );
        if (subRes.ok) {
          const subData = await subRes.json();
          if (subData.data?.length > 0) {
            const sub = subData.data[0];
            const tier = sub.tier;
            if (tier === '3000') role = 'sub_tier3';
            else if (tier === '2000') role = 'sub_tier2';
            else role = 'sub_tier1';
          }
        }
      } catch {}
    }

    const session = {
      user_id: user.id,
      display_name: user.display_name,
      profile_image: user.profile_image_url,
      login: user.login,
      role,
      followedAt,
      subscribedAt,
      subExpiresAt,
    };

    /* Signed, so it cannot be edited in a browser. See session-crypto.js —
       the payload stays readable for the frontend; only forgery is closed. */
    const { signSession } = await import('./session-crypto.js');
    const cookieValue = await signSession(session, env.SESSION_SECRET);
    const isSecure = url.protocol === 'https:';
    const flags = [
      `Path=/`,
      `Max-Age=${COOKIE_MAX_AGE}`,
      `SameSite=Lax`,
    ];
    if (isSecure) flags.push('Secure');

    return new Response(null, {
      status: 302,
      headers: {
        'Location': returnPath,
        'Set-Cookie': `${COOKIE_NAME}=${cookieValue}; ${flags.join('; ')}`,
      },
    });
  } catch (err) {
    return Response.redirect(`${url.origin}${returnPath}`, 302);
  }
}
