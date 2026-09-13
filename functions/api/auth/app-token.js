/* ══════════════════════════════════════════════
   ONE CACHED APP ACCESS TOKEN, SHARED BY EVERYTHING.

   WHAT WENT WRONG WITHOUT THIS

   Six places requested client_credentials tokens. Two cached the result
   under `twitch_app_token` with INCOMPATIBLE shapes — one writing
   { access_token }, the other { token }, each reading only its own field.
   The other four cached nothing at all and minted a brand new token on
   every single request, including twitch-status.js, which every page on
   the site polls.

   Twitch limits how many app access tokens a client may hold at once and
   invalidates older ones as new ones are issued. So ordinary site traffic
   was continuously revoking the token the bot setup had cached. The
   broadcaster pressed "Create EventSub Subscriptions" and got six identical
   "Invalid OAuth token" failures, with nothing anywhere to connect that to
   a page-load poll on an unrelated endpoint.

   Verified rather than assumed: the stored token had the right shape and an
   expiry two months out, and Twitch's own /oauth2/validate returned 401.

   TWO RULES FOR ANYONE ADDING A CALLER
   1. Never call the token endpoint directly. Use getAppToken(env).
   2. On a 401 from a Helix call, use getAppToken(env, { force: true }) and
      retry ONCE. A token can be revoked long before its recorded expiry,
      and the expiry only records what Twitch said at the time.
   ══════════════════════════════════════════════ */

const CACHE_KEY = 'twitch_app_token';

/* Refresh a minute early so a token cannot lapse mid-request. */
const SAFETY_MARGIN_MS = 60_000;

/**
 * @param {object} env
 * @param {object} [opts]
 * @param {boolean} [opts.force] mint a new one regardless of the cache
 * @param {boolean} [opts.validate] ask Twitch whether the cached token still
 *   works before returning it. Costs a round trip, so it is off by default
 *   and used by the callers where a failure is expensive and visible —
 *   bot-setup, chiefly. Ordinary read-only endpoints can afford to fail and
 *   retry instead.
 * @returns {Promise<string|null>}
 */
export async function getAppToken(env, { force = false, validate = false } = {}) {
  if (!force) {
    const cached = await env.MARKETPLACE.get(CACHE_KEY, 'json');
    /* Both field names are read. The two historical writers disagreed, and
       a token cached by one was invisible to the other. */
    const token = cached && (cached.access_token || cached.token);
    if (token && cached.expiresAt > Date.now() + SAFETY_MARGIN_MS) {
      if (!validate || await isValid(token)) return token;
      console.warn('[app-token] cached token failed validation — minting a fresh one');
    }
  }

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    console.error(`[app-token] could not mint an app token: ${res.status}`);
    return null;
  }
  const data = await res.json();

  /* Written under BOTH field names so a future reader expecting either one
     still finds it. Belt and braces against the exact divergence that caused
     this, for as long as more than one reader exists. */
  await env.MARKETPLACE.put(CACHE_KEY, JSON.stringify({
    access_token: data.access_token,
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  }), { expirationTtl: data.expires_in });

  return data.access_token;
}

/** Ask Twitch whether a token is actually usable. */
export async function isValid(token) {
  if (!token) return false;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: 'OAuth ' + token },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Run a Helix request with the shared token, refreshing once on a 401.
 *
 * Saves every caller from writing the same retry, and means a revoked token
 * self-heals on first use instead of surfacing as an inexplicable failure
 * somewhere unrelated.
 *
 * @param {object} env
 * @param {(token: string) => Promise<Response>} run
 */
export async function withAppToken(env, run) {
  let token = await getAppToken(env);
  if (!token) return null;

  let res = await run(token);
  if (res && res.status === 401) {
    console.warn('[app-token] Helix returned 401 — refreshing and retrying once');
    token = await getAppToken(env, { force: true });
    if (token) res = await run(token);
  }
  return res;
}
