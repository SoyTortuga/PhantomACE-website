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
    const { getAppToken } = await import('./app-token.js');
    const access_token = await getAppToken(env);
    if (!access_token) throw new Error('Could not get an app access token');

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

    /* VIP is a chat-granted status the bot records in sub_months_, not a Helix
       fact — so re-read it here too, letting Refresh pick up a VIP grant (or
       loss) without a full re-login. Freshly read, then written into whichever
       cookie this reissues below. */
    let vip = false;
    try {
      const sm = await env.MARKETPLACE.get(`sub_months_${session.user_id}`, 'json');
      vip = !!(sm && sm.vip);
    } catch { /* leave vip false; a read hiccup must not grant status */ }

    /* THE BROADCASTER IS NEVER RE-EVALUATED.
       Twitch reports a broadcaster as tier 3000 on their own channel, so
       running them through the subscription check below would "successfully"
       determine that the broadcaster is a Tier 3 subscriber and demote them —
       a verified result, and completely wrong. Their identity is fixed and
       there is nothing to re-check. */
    if (String(session.user_id) === String(broadcasterId)) {
      /* AND WRITE IT BACK. Returning the right answer without reissuing the
         cookie made Refresh useless for repairing a stale session: the badge
         corrected itself to Broadcaster, then reverted to whatever the cookie
         still said on the next page load, because the badge is rendered from
         the cookie. Worse, the role-gated UI reads body[data-role] from that
         same stale cookie, so the panel kept hiding itself while the server
         would happily have allowed the request.

         A "refresh my role" button that cannot actually change your role is
         just a way to be told the truth once and then shown a lie. */
      const corrected = { ...session, role: 'broadcaster', vip };
      const { signSession } = await import('./session-crypto.js');
      const cookieValue = await signSession(corrected, env.SESSION_SECRET);
      const flags = ['Path=/', 'Max-Age=86400', 'SameSite=Lax'];
      if (new URL(request.url).protocol === 'https:') flags.push('Secure');

      return new Response(JSON.stringify({ role: 'broadcaster', subTier: 0, verified: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Set-Cookie': `${COOKIE_NAME}=${cookieValue}; ${flags.join('; ')}`,
        },
      });
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
    /* Prefer the session's own subTier. Deriving it from `role` is exactly
       what broke moderators: role is a display ladder on which moderator
       outranks every sub tier, so a subscribing moderator derived to 0 and
       lost their benefits. The fallback is for cookies issued before subTier
       existed, and is corrected by the live check below. */
    let subTier = typeof session.subTier === 'number'
      ? session.subTier
      : (role === 'sub_tier3' ? 3 : role === 'sub_tier2' ? 2 : role === 'sub_tier1' ? 1 : 0);
    let verified = false;          // did ANY check actually succeed?

    /* Whether they hold a rank that a subscription must not overwrite.
       Re-read from the list rather than trusted from the cookie, so someone
       removed as a moderator loses it here too. */
    let privileged = role === 'broadcaster';
    if (!privileged) {
      try {
        const { getModerators } = await import('../admin/moderators.js');
        const { userIds } = await getModerators(env);
        privileged = userIds.includes(String(session.user_id));
      } catch { /* leave privileged false; a failure must not grant rank */ }
    }

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
          subTier = tier === '3000' ? 3 : tier === '2000' ? 2 : 1;
          role = subTier === 3 ? 'sub_tier3' : subTier === 2 ? 'sub_tier2' : 'sub_tier1';
        } else if (role.startsWith('sub_')) {
          /* Checked successfully and genuinely not subscribed any more. A
             downgrade here is a real result rather than a failure, so it is
             allowed to stand. */
          role = 'follower';
          subTier = 0;
        } else {
          /* Checked successfully, not subscribed. A privileged account keeps
             its rank; only the tier goes. */
          subTier = 0;
        }
      } else {
        console.warn(`[recheck-roles] subscription check unavailable (${subRes.status}) — leaving role as ${role}`);
      }
    } catch {}

    /* THE FIX. Rank is re-applied AFTER the subscription check, because the
       check above sets `role` from the subscription alone.

       Without this, a moderator who subscribes was demoted to sub_tier1 the
       moment any page called this endpoint — and Phamily Time calls it on
       load. They logged in as a moderator, opened a page, and every
       moderator-only control vanished, because the reissued cookie now said
       sub_tier1. A subscription is not a demotion.

       Doing it here rather than guarding the check above also means a
       moderator whose cookie predates the change, or who was added to the
       list since they last logged in, is corrected without logging out. */
    if (privileged && role !== 'broadcaster') role = 'moderator';

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

    const updatedSession = { ...session, role, subTier, vip };
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
