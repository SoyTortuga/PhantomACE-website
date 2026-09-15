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

    /* The channel's id comes from configuration, not from a name lookup.
       Looking it up by TWITCH_CHANNEL meant that if that hardcoded name were
       ever wrong or stale, every follow and subscription check would silently
       run against a DIFFERENT channel and come back negative — with no error
       anywhere to say so. The name lookup remains only as a fallback for a
       missing env var. */
    let broadcasterId = env.TWITCH_BROADCASTER_ID || null;
    if (!broadcasterId) {
      const broadcasterRes = await fetch(
        `https://api.twitch.tv/helix/users?login=${TWITCH_CHANNEL}`,
        { headers }
      );
      const { data: broadcasters } = await broadcasterRes.json();
      broadcasterId = broadcasters[0]?.id || null;
      console.warn('[auth] TWITCH_BROADCASTER_ID not set — fell back to a name lookup');
    }

    let role = 'visitor';
    /* Sub tier is its own fact, not something to read back out of `role`.
       They are INDEPENDENT: a moderator can be a Tier 1 subscriber, and
       encoding both in one string meant whichever was written last erased
       the other. Being made a moderator was silently costing people their
       subscriber benefits — a 1x Phamily Time boost instead of 1.33x, and
       three Dino Park incubator slots instead of six. */
    let subTier = 0;
    let followedAt = null;
    let subscribedAt = null;
    let subExpiresAt = null;

    /* Identify the broadcaster by ID, not by display/login name.
       Comparing user.login against a hardcoded 'phantomace' meant that if the
       account's login differed at all, the broadcaster fell through to the
       subscriber checks — and Twitch reports a broadcaster as tier 3000 on
       their own channel, so they were handed 'sub_tier3'. The badge said Tier
       3 Subscriber and every broadcaster-only piece of UI hid itself, while
       server-side authorisation (which already compared ids) still let them
       through. A name is not an identity. */
    if (broadcasterId && String(user.id) === String(broadcasterId)) {
      role = 'broadcaster';
      subTier = 3;                 // the broadcaster gets every sub benefit
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
        /* user_id is REQUIRED here, not optional. It was missing, so Twitch
           answered 400, subRes.ok was false, the check was skipped in
           silence and every subscriber was assigned 'follower'. The follow
           check directly above passes both ids correctly — the pattern was
           already in the file and simply was not applied here.

           The symptom was far from the cause: a tier 1 subscriber saw three
           Dino Park incubator slots instead of six, because subTier is
           derived from the role. Nobody looks at an incubator and suspects a
           missing query parameter, which is why the failure is now logged
           rather than swallowed. */
        const subRes = await fetch(
          `https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=${broadcasterId}&user_id=${user.id}`,
          { headers }
        );
        if (!subRes.ok) {
          console.warn(`[auth] subscription check failed for ${user.login}: ${subRes.status} — role stays '${role}'`);
        }
        if (subRes.ok) {
          const subData = await subRes.json();
          if (subData.data?.length > 0) {
            const sub = subData.data[0];
            const tier = sub.tier;
            if (tier === '3000') { role = 'sub_tier3'; subTier = 3; }
            else if (tier === '2000') { role = 'sub_tier2'; subTier = 2; }
            else { role = 'sub_tier1'; subTier = 1; }
          }
        }
      } catch {}
    }

    /* An allowlisted moderator outranks their sub tier for display purposes.
       Applied AFTER the sub check so it wins, and only if they are not the
       broadcaster, who already outranks everything.

       This is a UI HINT ONLY. Every privileged endpoint calls isModerator()
       and reads the allowlist fresh on each request, so removing someone
       takes effect immediately rather than whenever their session happens to
       expire. Nothing is authorised on the strength of this field. */
    if (role !== 'broadcaster') {
      try {
        const { getModerators } = await import('../admin/moderators.js');
        const { userIds } = await getModerators(env);
        /* Only `role` changes here. subTier is deliberately left alone — the
           whole point of keeping it separate is that becoming a moderator
           does not stop someone being a subscriber. */
        if (userIds.includes(String(user.id))) role = 'moderator';
      } catch { /* a failure here must not block a login */ }
    }

    const session = {
      user_id: user.id,
      display_name: user.display_name,
      profile_image: user.profile_image_url,
      login: user.login,
      role,
      /* Carried separately so that role — which is a display ladder, and on
         which moderator outranks every sub tier — cannot cost a subscribing
         moderator the thing they are paying for. */
      subTier,
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
