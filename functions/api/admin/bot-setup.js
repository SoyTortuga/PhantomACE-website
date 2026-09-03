/* ══════════════════════════════════════════════
   BOT SETUP — One-time admin tool
   1. GET  /api/admin/bot-setup          → starts OAuth flow
   2. GET  /api/admin/bot-setup?code=... → callback, stores tokens
   3. POST /api/admin/bot-setup          → creates EventSub subscriptions
   ══════════════════════════════════════════════ */

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
    return html(`<h1>Auth Error</h1><p>${error}: ${url.searchParams.get('error_description') || ''}</p>`);
  }

  if (code) {
    return await handleOAuthCallback(env, url, code);
  }

  return showSetupPage(env, url);
}

async function showSetupPage(env, url) {
  const botToken = await env.MARKETPLACE.get('twitch_bot_token', 'json');
  const botRefresh = await env.MARKETPLACE.get('twitch_bot_refresh_token');
  const subs = await env.MARKETPLACE.get('eventsub_subscriptions', 'json');

  const tokenStatus = botRefresh ? '✅ Bot token stored' : '❌ No bot token — authorize below';
  const subStatus = subs && subs.length > 0
    ? `✅ ${subs.length} EventSub subscription(s) active`
    : '❌ No EventSub subscriptions — create below';

  const callbackUrl = `${url.origin}/api/admin/bot-setup`;
  const scopes = 'user:write:chat user:bot';
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${env.TWITCH_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
    `&response_type=code&scope=${encodeURIComponent(scopes)}`;

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
  #result { margin-top: 12px; padding: 12px; background: #1a2a1a; border-radius: 6px; display: none; }
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
  <h2><span class="step">Step 2:</span> Create EventSub Subscriptions</h2>
  <div class="status">${subStatus}</div>
  <p>This creates webhook subscriptions for hype train and channel point events.
  Twitch will send events to your Cloudflare functions automatically.</p>
  <button class="btn btn-red" onclick="createSubs()">Create Subscriptions</button>
  <div id="result"></div>
</div>

<div class="section">
  <h2><span class="step">Step 3:</span> Set Environment Variables</h2>
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
</script>
</body></html>`);
}

async function handleOAuthCallback(env, url, code) {
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
    return html(`<h1>Token Error</h1><pre>${err}</pre>`, 500);
  }

  const tokens = await tokenRes.json();

  await env.MARKETPLACE.put('twitch_bot_refresh_token', tokens.refresh_token);
  await env.MARKETPLACE.put('twitch_bot_token', JSON.stringify({
    access_token: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in * 1000),
  }), { expirationTtl: tokens.expires_in });

  const userRes = await fetch('https://api.twitch.tv/helix/users', {
    headers: {
      'Authorization': 'Bearer ' + tokens.access_token,
      'Client-Id': env.TWITCH_CLIENT_ID,
    },
  });

  let botInfo = '';
  if (userRes.ok) {
    const userData = await userRes.json();
    const user = userData.data[0];
    await env.MARKETPLACE.put('twitch_bot_user_id', user.id);
    botInfo = `Bot account: <b>${user.display_name}</b> (ID: ${user.id})`;
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

  return json({ error: 'Invalid action' }, 400);
}

async function getAppAccessToken(env) {
  const cached = await env.MARKETPLACE.get('twitch_app_token', 'json');
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.access_token;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();

  await env.MARKETPLACE.put('twitch_app_token', JSON.stringify({
    access_token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  }), { expirationTtl: data.expires_in });

  return data.access_token;
}

async function createEventSubSubscriptions(env, request) {
  const appToken = await getAppAccessToken(env);
  if (!appToken) return json({ error: 'Could not get app access token. Check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.' }, 500);

  const broadcasterId = env.TWITCH_BROADCASTER_ID;
  if (!broadcasterId) return json({ error: 'TWITCH_BROADCASTER_ID env var not set.' }, 500);

  const secret = env.TWITCH_EVENTSUB_SECRET;
  if (!secret) return json({ error: 'TWITCH_EVENTSUB_SECRET env var not set.' }, 500);

  const origin = new URL(request.url).origin;

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

  const results = [];
  for (const sub of subscriptions) {
    const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + appToken,
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

    const data = await res.json();
    if (res.ok || res.status === 409) {
      results.push({ type: sub.type, ok: true, status: res.status === 409 ? 'already exists' : 'created' });
    } else {
      results.push({ type: sub.type, ok: false, error: data.message || res.statusText });
    }
  }

  await env.MARKETPLACE.put('eventsub_subscriptions', JSON.stringify(
    results.filter(r => r.ok).map(r => ({ type: r.type, createdAt: Date.now() }))
  ));

  return json({ success: true, results });
}
