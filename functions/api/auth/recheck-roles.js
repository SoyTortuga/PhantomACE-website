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

    /* Configuration, not a name lookup — same reasoning as the login flow.
       A stale TWITCH_CHANNEL would silently check the wrong channel. */
    let broadcasterId = env.TWITCH_BROADCASTER_ID || null;
    if (!broadcasterId) {
      const broadcasterRes = await fetch(
        `https://api.twitch.tv/helix/users?login=${TWITCH_CHANNEL}`, { headers }
      );
      const { data: broadcasters } = await broadcasterRes.json();
      broadcasterId = broadcasters[0]?.id || null;
    }
    if (!broadcasterId) return json({ error: 'Channel not found' }, 500);

    /* THE BROADCASTER IS NEVER RE-EVALUATED.
       Twitch reports a broadcaster as tier 3000 on their own channel, so
       running them through the subscription check below would "successfully"
       determine that the broadcaster is a Tier 3 subscriber and demote them —
       a verified result, and completely wrong. Their identity is fixed and
       there is nothing to re-check. */
    if (String(session.user_id) === String(broadcasterId)) {
      return json({ role: 'broadcaster', subTier: 0, verified: true });
    }

    /* ── WHY THIS STARTS FROM THE EXISTING ROLE ──────────────────────────
       It used to start at 'visitor' and write whatever it ended up with. The
       two checks below need a USER access token, and this endpoint only has
       an APP token (client_credentials) — helix/subscriptions/user and
       helix/channels/followed both reject an app token with 401. So both
       checks silently failed, role stayed 'visitor', and the endpoint
       overwrote the caller's cookie with it.

       The effect: a subscriber who opened the Phamily Time page, which calls
       this on load, was demoted to visitor. It cost a real subscriber their
       incubator slots in Dino Park and would have stripped every role on the
       site the same way.

       A verification that cannot verify must never DOWNGRADE. Starting from
       the current role means a failed check leaves things exactly as they
       were; only a successful check can change anything. */
    let role = session.role || 'visitor';
    let subTier = role === 'sub_tier3' ? 3 : role === 'sub_tier2' ? 2 : role === 'sub_tier1' ? 1 : 0;
    let verified = false;          // did ANY check actually succeed?

    try {
      const subRes = await fetch(
        `https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=${broadcasterId}&user_id=${session.user_id}`,
        { headers }
      );
      if (subRes.ok) {
        verified = true;
        const subData = await subRes.json();
        if (subData.data?.length > 0) {
          const tier = subData.data[0].tier;
          if (tier === '3000') { role = 'sub_tier3'; subTier = 3; }
          else if (tier === '2000') { role = 'sub_tier2'; subTier = 2; }
          else { role = 'sub_tier1'; subTier = 1; }
        } else if (role.startsWith('sub_')) {
          /* Checked successfully and genuinely not subscribed any more. A
             downgrade here is a real result rather than a failure, so it is
             allowed to stand. */
          role = 'follower';
          subTier = 0;
        }
      } else {
        console.warn(`[recheck-roles] subscription check unavailable (${subRes.status}) — leaving role as ${role}`);
      }
    } catch {}

    if (role === 'visitor') {
      try {
        const followRes = await fetch(
          `https://api.twitch.tv/helix/channels/followed?user_id=${session.user_id}&broadcaster_id=${broadcasterId}`,
          { headers }
        );
        if (followRes.ok) {
          verified = true;
          const followData = await followRes.json();
          if (followData.data?.length > 0) role = 'follower';
        }
      } catch {}
    }

    /* Nothing could actually be checked. Report the role unchanged and,
       critically, do NOT reissue the cookie — a call that failed to inspect
       a session has no business rewriting it. */
    if (!verified) {
      return json({ role, subTier, verified: false, reason: 'Twitch role check unavailable' });
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
