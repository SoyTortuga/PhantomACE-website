/* ══════════════════════════════════════════════
   BOT SETUP — One-time admin tool
   1. GET  /api/admin/bot-setup          → starts OAuth flow
   2. GET  /api/admin/bot-setup?code=... → callback, stores tokens
   3. POST /api/admin/bot-setup          → creates EventSub subscriptions
   Also handles the separate broadcaster-scoped OAuth
   (channel:manage:redemptions) needed to toggle the
   "Enter Giveaway" channel points reward on/off, and
   one-time creation of that reward — see giveaway.js
   for the actual toggle/pick-winner/send-code flow.
   ══════════════════════════════════════════════ */

import { getBroadcasterToken } from '../bot/send-chat.js';

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || session.role !== 'broadcaster') {
    return html('<h1>Access Denied</h1><p>You must be logged in as the broadcaster.</p>', 403);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return html(`<h1>Auth Error</h1><p>${escapeHtml(error)}: ${escapeHtml(url.searchParams.get('error_description') || '')}</p>`);
  }

  if (code) {
    const state = url.searchParams.get('state');
    if (state === 'broadcaster') {
      return await handleBroadcasterOAuthCallback(env, url, code);
    }
    return await handleOAuthCallback(env, url, code);
  }

  return showSetupPage(env, url);
}

async function showSetupPage(env, url) {
  const botToken = await env.MARKETPLACE.get('twitch_bot_token', 'json');
  const botRefresh = await env.MARKETPLACE.get('twitch_bot_refresh_token');
  const subs = await env.MARKETPLACE.get('eventsub_subscriptions', 'json');
  const broadcasterRefresh = await env.MARKETPLACE.get('twitch_broadcaster_refresh_token');
  const giveawayRewardId = await env.MARKETPLACE.get('giveaway_reward_id');

  const tokenStatus = botRefresh ? '✅ Bot token stored' : '❌ No bot token — authorize below';
  const subStatus = subs && subs.length > 0
    ? `✅ ${subs.length} EventSub subscription(s) active`
    : '❌ No EventSub subscriptions — create below';
  const broadcasterStatus = broadcasterRefresh
    ? '✅ Channel points management authorized'
    : '❌ Not authorized — needed to toggle the giveaway reward on/off';
  const giveawayRewardStatus = giveawayRewardId
    ? `✅ "Enter Giveaway" reward created (ID: ${giveawayRewardId})`
    : '❌ Not created yet';

  const callbackUrl = `${url.origin}/api/admin/bot-setup`;
  const scopes = 'user:write:chat user:bot user:read:chat user:manage:whispers';
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${env.TWITCH_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
    `&response_type=code&scope=${encodeURIComponent(scopes)}`;

  /* channel:read:hype_train is REQUIRED to create any channel.hype_train.*
     EventSub subscription — Twitch checks the broadcaster's granted scopes
     when the subscription is created, not when the event fires.

     It was missing, and the consequence was invisible in the obvious place:
     "Create EventSub Subscriptions" succeeded for channel points and chat
     while all three hype train types were rejected, so the feature looked
     set up and no hype train event could ever arrive. Confirmed against
     Helix on 2026-09-13 — 3 subscriptions enabled, zero hype train.

     Adding a scope here does NOT upgrade an existing token. The broadcaster
     has to run the "Authorize Channel Points Management" step again so
     Twitch re-prompts for the new scope. */
  /* channel:read:subscriptions lets the site re-check a viewer's sub tier
     AFTER login, using the broadcaster's token.

     It is needed because /api/auth/recheck-roles cannot work without it. That
     endpoint used an app token, which Twitch rejects for both
     helix/subscriptions/user and helix/channels/followed, so it verified
     nothing. Roles are therefore only accurate at the moment of login: a
     viewer who subscribes mid-session keeps their old role until they log out
     and back in.

     Grabbing it now because the broadcaster is already re-authorizing for
     channel:read:hype_train. Adding it later would mean asking them a third
     time. */
  const broadcasterScopes = 'channel:manage:redemptions channel:read:hype_train channel:read:subscriptions';
  const broadcasterAuthUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${env.TWITCH_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
    `&response_type=code&scope=${encodeURIComponent(broadcasterScopes)}&state=broadcaster`;

  return html(`<!DOCTYPE html>
<html><head><title>PhantomACE Bot Setup</title>
<style>
  body { font-family: system-ui; background: #111; color: #eee; max-width: 700px; margin: 40px auto; padding: 20px; }
  h1 { color: #ff0000; }
  .status { padding: 12px; background: #222; border-radius: 6px; margin: 12px 0; }
  .btn { display: inline-block; padding: 12px 24px; background: #9146ff; color: white; text-decoration: none;
    border-radius: 6px; font-weight: bold; border: none; cursor: pointer; font-size: 14px; }
  .btn:hover { background: #7c2fff; }
  .btn-red { background: #ff0000; }
  .btn-red:hover { background: #cc0000; }
  .section { margin: 24px 0; padding: 20px; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; }
  .step { color: #ff4400; font-weight: bold; }
  code { background: #2a2a2a; padding: 2px 6px; border-radius: 3px; }
  #result, #giveawayResult { margin-top: 12px; padding: 12px; background: #1a2a1a; border-radius: 6px; display: none; }
</style></head><body>
<h1>🤖 Bot Setup</h1>
<p>This page configures the hype train chat bot and EventSub webhooks. Everything runs on Cloudflare — no local machine needed.</p>

<div class="section">
  <h2><span class="step">Step 1:</span> Authorize Chat Bot</h2>
  <div class="status">${tokenStatus}</div>
  <p>Click below to authorize the bot to send messages in your Twitch chat.
  Log in with the account you want the bot to post as (your main account or a separate bot account).</p>
  <p><b>Important:</b> Make sure <code>${callbackUrl}</code> is added as an OAuth Redirect URL in your
  <a href="https://dev.twitch.tv/console/apps" style="color:#9146ff">Twitch Developer Console</a> app settings.</p>
  <a class="btn" href="${authUrl}">Authorize with Twitch</a>
</div>

<div class="section">
  <h2><span class="step">Step 2:</span> Authorize Channel Points Management</h2>
  <div class="status">${broadcasterStatus}</div>
  <p>Separate authorization, using your <b>broadcaster</b> account specifically — Twitch only lets the
  channel owner manage channel points rewards. This lets the site toggle the "Enter Giveaway" reward
  on/off from the bot control panel for big-prize drawings.</p>
  <a class="btn" href="${broadcasterAuthUrl}">Authorize Channel Points</a>
</div>

<div class="section">
  <h2><span class="step">Step 3:</span> Create the "Enter Giveaway" Reward</h2>
  <div class="status">${giveawayRewardStatus}</div>
  <p>Creates a channel points reward viewers redeem to enter a big-prize giveaway. Only needs to be
  done once — after that, toggle it on/off from the bot control panel. Requires Step 2.</p>
  <label style="display:block;margin:10px 0">Cost (channel points):
    <input id="giveawayCost" type="number" value="5000" min="1" style="width:100px;margin-left:8px;padding:6px;background:#222;color:#eee;border:1px solid #333;border-radius:4px">
  </label>
  <button class="btn btn-red" onclick="createGiveawayReward()" ${giveawayRewardId ? 'disabled' : ''}>Create Reward</button>
  <div id="giveawayResult"></div>
</div>

<div class="section">
  <h2><span class="step">Step 4:</span> Create EventSub Subscriptions</h2>
  <div class="status">${subStatus}</div>
  <p>This creates webhook subscriptions for hype train events, channel point redemptions,
  inbound chat messages (so mods/broadcaster can trigger drops with <code>!drop</code> and
  <code>!announce</code> in chat), and giveaway reward entries (once Step 3 is done).
  Twitch will send events to your Cloudflare functions automatically.
  Complete Step 1 first — the chat message subscription needs the bot's authorized user ID.</p>
  <button class="btn btn-red" onclick="createSubs()">Create Subscriptions</button>
  <div id="result"></div>
</div>

<div class="section">
  <h2><span class="step">Step 5:</span> Set Environment Variables</h2>
  <p>In your <a href="https://dash.cloudflare.com" style="color:#9146ff">Cloudflare Dashboard</a>,
  go to your Pages project → Settings → Environment variables. Add these as <b>encrypted</b> secrets:</p>
  <ul>
    <li><code>TWITCH_EVENTSUB_SECRET</code> — A random string (generate one: <code id="randomSecret"></code>)
      <button onclick="genSecret()" style="font-size:11px;cursor:pointer">Generate</button></li>
    <li><code>TWITCH_BROADCASTER_ID</code> — Your Twitch user ID: <b>${env.TWITCH_BROADCASTER_ID || '(not set yet)'}</b></li>
  </ul>
  <p>The bot tokens are stored in KV automatically when you complete Step 1.</p>
</div>

<script>
function genSecret() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  const s = Array.from(arr, b => b.toString(16).padStart(2,'0')).join('');
  document.getElementById('randomSecret').textContent = s;
}
genSecret();

async function createSubs() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Creating...';
  const el = document.getElementById('result');
  try {
    const res = await fetch('/api/admin/bot-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create-eventsub' })
    });
    const data = await res.json();
    el.style.display = 'block';
    if (data.success) {
      el.innerHTML = '<b>✅ Created!</b><br>' + data.results.map(r =>
        (r.ok ? '✅' : '❌') + ' ' + r.type + (r.error ? ': ' + r.error : '')
      ).join('<br>');
    } else {
      el.innerHTML = '<b>❌ Error:</b> ' + (data.error || 'Unknown error');
    }
  } catch(e) {
    el.style.display = 'block';
    el.innerHTML = '<b>❌ Error:</b> ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = 'Create Subscriptions';
}

async function createGiveawayReward() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Creating...';
  const el = document.getElementById('giveawayResult');
  const cost = parseInt(document.getElementById('giveawayCost').value, 10) || 5000;
  try {
    const res = await fetch('/api/admin/bot-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create-giveaway-reward', cost })
    });
    const data = await res.json();
    el.style.display = 'block';
    el.innerHTML = data.success
      ? '<b>✅ Reward created!</b> ID: ' + data.rewardId + '. Now run Step 4 to subscribe to its redemptions.'
      : '<b>❌ Error:</b> ' + (data.error || 'Unknown error');
  } catch (e) {
    el.style.display = 'block';
    el.innerHTML = '<b>❌ Error:</b> ' + e.message;
  }
  if (!document.getElementById('giveawayResult').innerHTML.includes('✅')) {
    btn.disabled = false;
    btn.textContent = 'Create Reward';
  }
}
</script>
</body></html>`);
}

async function handleOAuthCallback(env, url, code) {
  try {
    const callbackUrl = `${url.origin}/api/admin/bot-setup`;

    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        client_secret: env.TWITCH_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: callbackUrl,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return html(`<h1>Token Error</h1><pre>${escapeHtml(err)}</pre>`, 500);
    }

    const tokens = await tokenRes.json();
    if (!tokens.access_token || !tokens.refresh_token) {
      return html(`<h1>Token Error</h1><p>Twitch's response was missing an access or refresh token.</p><pre>${escapeHtml(JSON.stringify(tokens, null, 2))}</pre>`, 500);
    }
    const ttl = Number.isFinite(tokens.expires_in) && tokens.expires_in >= 60 ? tokens.expires_in : 3600;

    await env.MARKETPLACE.put('twitch_bot_refresh_token', tokens.refresh_token);
    await env.MARKETPLACE.put('twitch_bot_token', JSON.stringify({
      access_token: tokens.access_token,
      expiresAt: Date.now() + (ttl * 1000),
    }), { expirationTtl: ttl });

    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': 'Bearer ' + tokens.access_token,
        'Client-Id': env.TWITCH_CLIENT_ID,
      },
    });

    let botInfo = '';
    if (userRes.ok) {
      const userData = await userRes.json();
      const user = userData.data && userData.data[0];
      if (user) {
        await env.MARKETPLACE.put('twitch_bot_user_id', user.id);
        botInfo = `Bot account: <b>${escapeHtml(user.display_name)}</b> (ID: ${escapeHtml(user.id)})`;
      }
    }

    return html(`<!DOCTYPE html>
<html><head><title>Bot Authorized</title>
<style>
  body { font-family: system-ui; background: #111; color: #eee; max-width: 600px; margin: 80px auto; padding: 20px; text-align: center; }
  .success { font-size: 48px; }
  a { color: #ff4400; }
</style></head><body>
<div class="success">✅</div>
<h1>Bot Authorized!</h1>
<p>${botInfo}</p>
<p>The bot can now send messages in your Twitch chat.</p>
<p>Tokens are stored securely in KV — no env vars needed for this part.</p>
<p><a href="/api/admin/bot-setup">← Back to setup</a></p>
</body></html>`);
  } catch (e) {
    return html(`<h1>Unexpected Error</h1><p>Something went wrong finishing bot authorization.</p><pre>${escapeHtml(e.message || String(e))}</pre><p><a href="/api/admin/bot-setup">← Back to setup</a></p>`, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || session.role !== 'broadcaster') {
    return json({ error: 'Broadcaster only' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'create-eventsub') {
    return await createEventSubSubscriptions(env, request);
  }

  if (body.action === 'list-eventsub') {
    return await listEventSubSubscriptions(env);
  }

  if (body.action === 'delete-eventsub') {
    return await deleteEventSubSubscription(env, body);
  }

  if (body.action === 'create-giveaway-reward') {
    return await createGiveawayReward(env, body);
  }

  return json({ error: 'Invalid action' }, 400);
}

async function handleBroadcasterOAuthCallback(env, url, code) {
  try {
    const callbackUrl = `${url.origin}/api/admin/bot-setup`;

    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        client_secret: env.TWITCH_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: callbackUrl,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return html(`<h1>Token Error</h1><pre>${escapeHtml(err)}</pre>`, 500);
    }

    const tokens = await tokenRes.json();
    if (!tokens.access_token || !tokens.refresh_token) {
      return html(`<h1>Token Error</h1><p>Twitch's response was missing an access or refresh token.</p><pre>${escapeHtml(JSON.stringify(tokens, null, 2))}</pre>`, 500);
    }
    const ttl = Number.isFinite(tokens.expires_in) && tokens.expires_in >= 60 ? tokens.expires_in : 3600;

    await env.MARKETPLACE.put('twitch_broadcaster_refresh_token', tokens.refresh_token);
    await env.MARKETPLACE.put('twitch_broadcaster_token', JSON.stringify({
      access_token: tokens.access_token,
      expiresAt: Date.now() + (ttl * 1000),
    }), { expirationTtl: ttl });

    return html(`<!DOCTYPE html>
<html><head><title>Channel Points Authorized</title>
<style>
  body { font-family: system-ui; background: #111; color: #eee; max-width: 600px; margin: 80px auto; padding: 20px; text-align: center; }
  .success { font-size: 48px; }
  a { color: #ff4400; }
</style></head><body>
<div class="success">✅</div>
<h1>Channel Points Authorized!</h1>
<p>The site can now manage the "Enter Giveaway" reward on your channel.</p>
<p><a href="/api/admin/bot-setup">← Back to setup</a></p>
</body></html>`);
  } catch (e) {
    return html(`<h1>Unexpected Error</h1><p>Something went wrong finishing channel points authorization.</p><pre>${escapeHtml(e.message || String(e))}</pre><p><a href="/api/admin/bot-setup">← Back to setup</a></p>`, 500);
  }
}

async function createGiveawayReward(env, body) {
  const broadcasterId = env.TWITCH_BROADCASTER_ID;
  if (!broadcasterId) return json({ error: 'TWITCH_BROADCASTER_ID env var not set.' }, 500);

  const existing = await env.MARKETPLACE.get('giveaway_reward_id');
  if (existing) return json({ success: true, rewardId: existing, alreadyExisted: true });

  const token = await getBroadcasterToken(env);
  if (!token) return json({ error: 'Not authorized for channel points management — complete Step 2 first.' }, 400);

  const cost = Math.max(1, parseInt(body.cost, 10) || 5000);

  const res = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Client-Id': env.TWITCH_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Enter Giveaway',
      cost,
      prompt: 'Redeem to enter the current giveaway for a chance to win a big prize!',
      is_enabled: false,
      should_redemptions_skip_request_queue: true,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: err.message || 'Twitch API error creating the reward.' }, 400);
  }

  const data = await res.json();
  const rewardId = data.data[0].id;
  await env.MARKETPLACE.put('giveaway_reward_id', rewardId);

  return json({ success: true, rewardId });
}


async function getAppAccessToken(env, { forceRefresh = false } = {}) {
  /* Shared cached token — see functions/api/auth/app-token.js. Minting one
     here independently is what revoked everyone else's. validate:true because
     a stale token on this path surfaces as six identical "Invalid OAuth token"
     failures on a page the broadcaster only visits during setup. */
  const { getAppToken } = await import('../auth/app-token.js');
  return getAppToken(env, { force: forceRefresh, validate: !forceRefresh });
}


async function createEventSubSubscriptions(env, request) {
  let appToken = await getAppAccessToken(env);
  if (!appToken) return json({ error: 'Could not get app access token. Check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.' }, 500);

  const broadcasterId = env.TWITCH_BROADCASTER_ID;
  if (!broadcasterId) return json({ error: 'TWITCH_BROADCASTER_ID env var not set.' }, 500);

  const secret = env.TWITCH_EVENTSUB_SECRET;
  if (!secret) return json({ error: 'TWITCH_EVENTSUB_SECRET env var not set.' }, 500);

  const origin = new URL(request.url).origin;
  const botUserId = env.TWITCH_BOT_USER_ID || await env.MARKETPLACE.get('twitch_bot_user_id');
  const giveawayRewardId = await env.MARKETPLACE.get('giveaway_reward_id');

  const subscriptions = [
    {
      type: 'channel.hype_train.begin',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/hype-train`,
    },
    {
      type: 'channel.hype_train.progress',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/hype-train`,
    },
    {
      type: 'channel.hype_train.end',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/hype-train`,
    },
    {
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/channel-points`,
    },
  ];

  if (botUserId) {
    subscriptions.push({
      type: 'channel.chat.message',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId, user_id: botUserId },
      callback: `${origin}/api/bot/commands`,
    });
  }

  if (giveawayRewardId) {
    subscriptions.push({
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId, reward_id: giveawayRewardId },
      callback: `${origin}/api/bot/giveaway-entry`,
    });
  }

  const results = [];
  if (!botUserId) {
    results.push({
      type: 'channel.chat.message',
      ok: false,
      error: 'No authorized bot user ID yet — complete Step 1 (Authorize Chat Bot) first.',
    });
  }
  if (!giveawayRewardId) {
    results.push({
      type: 'channel.channel_points_custom_reward_redemption.add (giveaway)',
      ok: false,
      error: 'No giveaway reward created yet — complete Step 3 first.',
    });
  }
  for (const sub of subscriptions) {
    /* One 401 means the token is dead for ALL of them, so mint a fresh one
       once and carry on rather than reporting six identical failures and
       making the broadcaster guess which of their own actions broke it. */
    const post = async (token) => fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Client-Id': env.TWITCH_CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: sub.type,
        version: sub.version,
        condition: sub.condition,
        transport: {
          method: 'webhook',
          callback: sub.callback,
          secret: secret,
        },
      }),
    });

    let res = await post(appToken);
    if (res.status === 401) {
      console.warn('[bot-setup] EventSub returned 401 — refreshing the app token and retrying');
      const fresh = await getAppAccessToken(env, { forceRefresh: true });
      if (fresh) { appToken = fresh; res = await post(appToken); }
    }

    const data = await res.json();
    if (res.ok) {
      results.push({ type: sub.type, ok: true, status: 'created' });
    } else if (res.status === 409) {
      // Twitch's uniqueness is on type + version + condition — NOT the
      // callback URL. So a 409 means "one already exists somewhere", quite
      // possibly pointing at a different origin, and nothing was subscribed
      // here. Reporting that as plain success is how you end up believing
      // dev is wired up when every event is still going to production.
      results.push({
        type: sub.type,
        ok: true,
        status: 'already exists — NOT re-pointed',
        warning: `A subscription for this type+condition already exists, possibly with a different callback than ${sub.callback}. Twitch does not allow two, and this request changed nothing. Use action:'list-eventsub' to see where it actually points, and action:'delete-eventsub' to remove it first if you need to re-point it.`,
      });
    } else {
      results.push({ type: sub.type, ok: false, error: data.message || res.statusText });
    }
  }

  await env.MARKETPLACE.put('eventsub_subscriptions', JSON.stringify(
    results.filter(r => r.ok).map(r => ({ type: r.type, createdAt: Date.now() }))
  ));

  return json({ success: true, results });
}

/* ── Inspect and remove subscriptions ──────────────────────────────────────
   Without these there is no recovery path: create-eventsub never deletes and
   treats 409 as success, so once a subscription is revoked, or is pointing at
   an origin you no longer use, the admin panel cannot fix it and the only
   option is raw curl against the Helix API. That gap matters most during a
   migration, when callbacks may need re-pointing at a new origin. */

async function listEventSubSubscriptions(env) {
  const appToken = await getAppAccessToken(env);
  if (!appToken) return json({ error: 'Could not get app access token.' }, 500);

  const subs = [];
  let cursor = '';
  // Paginate — a partial list is worse than none here, since a subscription
  // you cannot see is exactly the one causing the 409 you cannot explain.
  do {
    const url = 'https://api.twitch.tv/helix/eventsub/subscriptions' + (cursor ? `?after=${cursor}` : '');
    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + appToken, 'Client-Id': env.TWITCH_CLIENT_ID },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return json({ error: err.message || res.statusText }, res.status);
    }
    const data = await res.json();
    for (const s of data.data || []) {
      subs.push({
        id: s.id,
        type: s.type,
        version: s.version,
        status: s.status,
        condition: s.condition,
        callback: s.transport && s.transport.callback,
        createdAt: s.created_at,
      });
    }
    cursor = data.pagination && data.pagination.cursor;
  } while (cursor);

  return json({
    success: true,
    total: subs.length,
    subscriptions: subs,
    // Anything not 'enabled' will never deliver again and must be deleted
    // and recreated; Twitch does not resurrect these on its own.
    needsAttention: subs.filter(s => s.status !== 'enabled').map(s => ({ id: s.id, type: s.type, status: s.status })),
  });
}

async function deleteEventSubSubscription(env, body) {
  const id = (body.id || '').trim();
  if (!id) return json({ error: "Missing 'id'. Use action:'list-eventsub' to find it." }, 400);

  const appToken = await getAppAccessToken(env);
  if (!appToken) return json({ error: 'Could not get app access token.' }, 500);

  const res = await fetch(
    `https://api.twitch.tv/helix/eventsub/subscriptions?id=${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + appToken, 'Client-Id': env.TWITCH_CLIENT_ID },
    }
  );

  // Twitch answers 204 on success and 404 if it was already gone; treat the
  // latter as success so retrying a delete is safe.
  if (res.status === 204 || res.status === 404) {
    return json({ success: true, id, alreadyGone: res.status === 404 });
  }
  const err = await res.json().catch(() => ({}));
  return json({ error: err.message || res.statusText }, res.status);
}
