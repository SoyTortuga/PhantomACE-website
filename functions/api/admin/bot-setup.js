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

/* ── WHO MAY DO WHAT ─────────────────────────────────────────────────────
   This page used to be broadcaster-only in one lump, which drew the line in
   the wrong place. The steps are not the same kind of action:

     Step 1 (authorize chat bot)  — consent comes from the BOT account, whose
                                    password the designer holds. The
                                    broadcaster's channel is not involved.
     Step 4 / EventSub management — no consent at all, just stored tokens.
     Step 2, 3 (channel points,   — grants NEW permissions on, and creates
       hype train scopes)           rewards in, the broadcaster's own
                                    channel. Nobody else can approve that,
                                    and nobody else should.

   Lumping them together meant the person who actually holds the bot
   credentials could not link the bot, while the broadcaster had to be walked
   through a step that was never theirs to do. So the gate is per-step now.

   Note the asymmetry is enforced on the SERVER for every path, not just
   hidden in the page — a moderator who constructs the broadcaster OAuth
   callback by hand is refused at the callback itself.  */

const MODERATOR_ACTIONS = new Set(['create-eventsub', 'list-eventsub', 'delete-eventsub']);

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);

  /* isBroadcaster compares user_id against TWITCH_BROADCASTER_ID rather than
     trusting session.role — identity, not a claim. See moderators.js. */
  const { isModerator, isBroadcaster } = await import('./moderators.js');
  const broadcaster = isBroadcaster(env, session);
  if (!broadcaster && !(await isModerator(env, session))) {
    return html('<h1>Access Denied</h1><p>You must be logged in as the broadcaster or an approved moderator.</p>', 403);
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
      /* Refused here as well as in the page, because the page only hides the
         link. This callback stores a token granting permissions on the
         broadcaster's channel; it must not be reachable by anyone who simply
         navigated to the Twitch consent URL themselves. */
      if (!broadcaster) {
        return html('<h1>Broadcaster Only</h1><p>Channel points and hype train permissions can only be granted by the broadcaster\'s own account.</p>', 403);
      }
      return await handleBroadcasterOAuthCallback(env, url, code);
    }
    return await handleOAuthCallback(env, url, code);
  }

  return showSetupPage(env, url, broadcaster);
}

async function showSetupPage(env, url, isBroadcasterUser = false) {
  const botToken = await env.MARKETPLACE.get('twitch_bot_token', 'json');
  const botRefresh = await env.MARKETPLACE.get('twitch_bot_refresh_token');
  const subs = await env.MARKETPLACE.get('eventsub_subscriptions', 'json');
  const broadcasterRefresh = await env.MARKETPLACE.get('twitch_broadcaster_refresh_token');
  const giveawayRewardId = await env.MARKETPLACE.get('giveaway_reward_id');
  const checkinRewardId = await env.MARKETPLACE.get('checkin_reward_id');

  const tokenStatus = botRefresh ? '✅ Bot token stored' : '❌ No bot token — authorize below';
  const subStatus = subs && subs.length > 0
    ? `✅ ${subs.length} EventSub subscription(s) active`
    : '❌ No EventSub subscriptions — create below';
  /* ── WHY THIS CHECKS SCOPES AND NOT JUST "IS THERE A TOKEN" ──────────
     It used to say "✅ Channel points management authorized" whenever a
     refresh token existed, regardless of what that token could actually do.
     When channel:read:hype_train was added, the broadcaster opened this page,
     saw a green tick against Step 2, reasonably skipped it, and pressed
     Create Subscriptions — which failed with 403 "subscription missing proper
     authorization" on all three hype train types. The page had told them a
     step was done when the thing it needed to grant had never been granted.

     A status line that reports the presence of a credential rather than its
     adequacy is worse than no status line: it actively directs someone past
     the step they need. So ask Twitch what the token can really do. */
  const REQUIRED_BROADCASTER_SCOPES = [
    'channel:manage:redemptions',
    'channel:read:hype_train',
    'channel:read:subscriptions',
    /* Ad breaks. Listed here even though the subscription step treats it as
       optional, and the two are not in conflict: this line is what stops the
       page claiming Step 2 is done, while Create Subscriptions still builds
       everything else. Silence here would be the exact failure the comment
       above describes — a green tick over a permission never granted. */
    'channel:read:ads',
  ];

  let broadcasterStatus;
  let missingScopes = [];
  if (!broadcasterRefresh) {
    broadcasterStatus = '❌ Not authorized — needed for the giveaway reward and hype train events';
  } else {
    const stored = await env.MARKETPLACE.get('twitch_broadcaster_token', 'json');
    const token = stored && (stored.access_token || stored.token);
    let granted = null;
    try {
      const vr = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: 'OAuth ' + token },
      });
      if (vr.ok) granted = (await vr.json()).scopes || [];
    } catch { /* reported as unknown below */ }

    if (granted === null) {
      broadcasterStatus = '⚠️ Authorization stored but Twitch rejected it — re-authorize below';
    } else {
      missingScopes = REQUIRED_BROADCASTER_SCOPES.filter(sc => !granted.includes(sc));
      broadcasterStatus = missingScopes.length
        ? `❌ RE-AUTHORIZATION REQUIRED — missing: ${escapeHtml(missingScopes.join(', '))}`
        : `✅ Authorized with all ${REQUIRED_BROADCASTER_SCOPES.length} required permissions`;
    }
  }
  const giveawayRewardStatus = giveawayRewardId
    ? `✅ "Enter Giveaway" reward created (ID: ${giveawayRewardId})`
    : '❌ Not created yet';
  const checkinRewardStatus = checkinRewardId
    ? `✅ "Pham Check-In" reward created (ID: ${checkinRewardId})`
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
  /* channel:read:ads covers BOTH ad features: the channel.ad_break.begin
     subscription and the /helix/channels/ads schedule the countdown polls.
     Read only — it cannot start or skip a break. Snoozing one would need
     channel:manage:ads, which is deliberately NOT requested: nothing asks
     for it yet, and it is a permission to act on the channel's monetisation
     rather than observe it. */
  const broadcasterScopes = 'channel:manage:redemptions channel:read:hype_train '
    + 'channel:read:subscriptions channel:read:ads';
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
  #result, #giveawayResult, #checkinResult { margin-top: 12px; padding: 12px; background: #1a2a1a; border-radius: 6px; display: none; }
  .locked { background: #2a1a1a; border: 1px solid #553333; padding: 12px; border-radius: 6px; color: #ffaa88; }
  .section.is-locked { opacity: 0.65; }
</style></head><body>
<h1>🤖 Bot Setup</h1>
<p>This page configures the hype train chat bot and EventSub webhooks.</p>
${isBroadcasterUser ? '' : `<div class="locked"><b>You are signed in as a moderator.</b> Steps 1 and 4 are yours to run —
Step 1's approval comes from the bot account, not this channel. Steps 2 and 3 grant permissions on
PhantomACE's own channel and only they can approve those, so they are shown here for status but disabled.</div>`}

<div class="section">
  <h2><span class="step">Step 1:</span> Authorize Chat Bot</h2>
  <div class="status">${tokenStatus}</div>
  <p>Authorizes the bot to send messages in chat. <b>Whichever Twitch account is signed in
  when you click this becomes the bot</b> — Twitch has no way to ask which one you meant.</p>
  <p class="locked">⚠️ If you are signed into Twitch as the broadcaster right now, this will make the
  broadcaster the bot, and every drop and announcement will post as them. That has already happened
  once on this channel. Sign into <code>twitch.tv</code> as the bot account first — a private window
  is the easy way, since this page's own login is a separate cookie and will survive it.</p>
  <p><b>Important:</b> Make sure <code>${callbackUrl}</code> is added as an OAuth Redirect URL in your
  <a href="https://dev.twitch.tv/console/apps" style="color:#9146ff">Twitch Developer Console</a> app settings.</p>
  <a class="btn" href="${authUrl}">Authorize with Twitch</a>
</div>

<div class="section${isBroadcasterUser ? '' : ' is-locked'}">
  <h2><span class="step">Step 2:</span> Authorize Channel Points Management</h2>
  <div class="status">${broadcasterStatus}</div>
  <p>Separate authorization, using the <b>broadcaster</b> account specifically — Twitch only lets the
  channel owner manage channel points rewards. This lets the site toggle the "Enter Giveaway" reward
  on/off from the bot control panel for big-prize drawings.</p>
  ${isBroadcasterUser
    ? `<a class="btn" href="${broadcasterAuthUrl}">Authorize Channel Points</a>`
    : `<div class="locked">🔒 Broadcaster only — this grants new permissions on their channel, so it cannot be delegated. Twitch would approve whichever account is signed in, which is exactly the mistake worth preventing.</div>`}
</div>

<div class="section${isBroadcasterUser ? '' : ' is-locked'}">
  <h2><span class="step">Step 3:</span> Create the "Enter Giveaway" Reward</h2>
  <div class="status">${giveawayRewardStatus}</div>
  <p>Creates a channel points reward viewers redeem to enter a big-prize giveaway. Only needs to be
  done once — after that, toggle it on/off from the bot control panel. Requires Step 2.</p>
  ${isBroadcasterUser ? `<label style="display:block;margin:10px 0">Cost (channel points):
    <input id="giveawayCost" type="number" value="5000" min="1" style="width:100px;margin-left:8px;padding:6px;background:#222;color:#eee;border:1px solid #333;border-radius:4px">
  </label>
  <button class="btn btn-red" onclick="createGiveawayReward()" ${giveawayRewardId ? 'disabled' : ''}>Create Reward</button>
  <div id="giveawayResult"></div>`
    : `<div class="locked">🔒 Broadcaster only — creates a reward in their channel.</div>`}
</div>

<div class="section${isBroadcasterUser ? '' : ' is-locked'}">
  <h2><span class="step">Step 3b:</span> Create the "Pham Check-In" Reward</h2>
  <div class="status">${checkinRewardStatus}</div>
  <p>A cheap reward viewers redeem once per stream to say they are watching. Twitch enforces the
  once-per-stream limit itself and clears it when the next broadcast starts, so there is nothing
  to reset and nothing that can fail while you are offline.</p>
  <p>It needs no new EventSub subscription — the redemption subscription from Step 4 covers every
  reward on the channel, and check-ins are matched by title.</p>
  ${isBroadcasterUser ? `<label style="display:block;margin:10px 0">Cost (channel points):
    <input id="checkinCost" type="number" value="100" min="1" style="width:100px;margin-left:8px;padding:6px;background:#222;color:#eee;border:1px solid #333;border-radius:4px">
  </label>
  <button class="btn btn-red" onclick="createCheckinReward()" ${checkinRewardId ? 'disabled' : ''}>Create Reward</button>
  <div id="checkinResult"></div>`
    : `<div class="locked">🔒 Broadcaster only — creates a reward in their channel.</div>`}
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
  <h2><span class="step">Step 4b:</span> Existing Subscriptions</h2>
  <p>Twitch allows only ONE subscription per type + condition, and it ignores the callback when
  deciding that — so re-creating never replaces, it 409s. To re-point one, delete it here first.</p>
  <p><b>After changing the bot account</b> the <code>channel.chat.message</code> subscription still
  carries the OLD bot's user ID and will never deliver again. Delete it, then run Step 4.</p>
  <button class="btn" onclick="listSubs()">List Subscriptions</button>
  <div id="subList"></div>
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

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

/* One renderer, one fetch. An earlier draft had a separate copy for the
   post-delete refresh — which is how the two drift and only one gets the
   next fix. */
function renderSubs(data) {
  const el = document.getElementById('subList');
  if (!data.success) {
    el.innerHTML = '<p style="color:#ff6666">❌ ' + esc(data.error || 'Unknown error') + '</p>';
    return;
  }
  if (!data.total) {
    el.innerHTML = '<p>No subscriptions registered.</p>';
    return;
  }
  el.innerHTML = '<p>' + data.total + ' subscription(s):</p>' + data.subscriptions.map(function (s) {
    /* The condition is shown because it is what actually distinguishes two
       subscriptions of the same type — and for channel.chat.message the
       user_id in it IS the bot account. That is the number you check after
       changing bots. */
    var cond = Object.keys(s.condition || {}).map(function (k) {
      return esc(k) + '=' + esc(s.condition[k]);
    }).join(' ');
    return '<div style="border:1px solid #333;padding:10px;margin:8px 0;border-radius:6px">' +
      '<b>' + esc(s.type) + '</b> <small>v' + esc(s.version) + '</small> ' +
      (s.status === 'enabled'
        ? '<span style="color:#66dd66">enabled</span>'
        : '<span style="color:#ff6666">' + esc(s.status) + ' — will never deliver again</span>') +
      '<br><small>' + cond + '</small>' +
      '<br><button class="btn btn-red sub-del" style="margin-top:8px;padding:6px 14px;font-size:12px" ' +
      'data-id="' + esc(s.id) + '">Delete</button>' +
      '</div>';
  }).join('');

  /* Listeners rather than an inline onclick. This whole script is emitted
     from inside a template literal, where a nested \\' collapses to a plain
     quote and silently produces broken JS in the page — which is exactly
     what happened in the first draft. A data attribute has nothing to
     escape wrong. */
  el.querySelectorAll('.sub-del').forEach(function (b) {
    b.addEventListener('click', function () { deleteSub(b.dataset.id, b); });
  });
}

async function fetchSubs() {
  const res = await fetch('/api/admin/bot-setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list-eventsub' })
  });
  return await res.json();
}

async function listSubs() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Loading...';
  try {
    renderSubs(await fetchSubs());
  } catch (e) {
    document.getElementById('subList').innerHTML = '<p style="color:#ff6666">❌ ' + esc(e.message) + '</p>';
  }
  btn.disabled = false;
  btn.textContent = 'List Subscriptions';
}

async function deleteSub(id, btn) {
  if (!confirm('Delete this subscription? Events of this type stop arriving until you recreate it in Step 4.')) return;
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  try {
    const res = await fetch('/api/admin/bot-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete-eventsub', id: id })
    });
    const data = await res.json();
    if (data.success) {
      renderSubs(await fetchSubs());
      return;                       // the row this button lived on is gone
    }
    alert('Could not delete: ' + (data.error || 'unknown error'));
  } catch (e) {
    alert('Could not delete: ' + e.message);
  }
  btn.disabled = false;
  btn.textContent = 'Delete';
}

async function createCheckinReward() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Creating...';
  const el = document.getElementById('checkinResult');
  const cost = parseInt(document.getElementById('checkinCost').value, 10) || 100;
  try {
    const res = await fetch('/api/admin/bot-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create-checkin-reward', cost })
    });
    const data = await res.json();
    el.style.display = 'block';
    el.innerHTML = data.success
      ? '<b>✅ Reward created!</b> ID: ' + esc(data.rewardId) + '. It is live now — no Step 4 needed for this one.'
      : '<b>❌ Error:</b> ' + esc(data.error || 'Unknown error');
  } catch (e) {
    el.style.display = 'block';
    el.innerHTML = '<b>❌ Error:</b> ' + esc(e.message);
  }
  if (!document.getElementById('checkinResult').innerHTML.includes('✅')) {
    btn.disabled = false;
    btn.textContent = 'Create Reward';
  }
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

  const { isModerator, isBroadcaster } = await import('./moderators.js');
  const broadcaster = isBroadcaster(env, session);
  if (!broadcaster && !(await isModerator(env, session))) {
    return json({ error: 'Broadcaster or moderator access required' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  /* Allowlist, not a denylist. A new action added later is broadcaster-only
     until somebody deliberately decides otherwise — the safe direction to
     fail when the thing being gated is someone else's channel. */
  if (!broadcaster && !MODERATOR_ACTIONS.has(body.action)) {
    return json({ error: 'That action is broadcaster-only.' }, 403);
  }

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

  if (body.action === 'create-checkin-reward') {
    return await createCheckinReward(env, body);
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


async function createCheckinReward(env, body) {
  const broadcasterId = env.TWITCH_BROADCASTER_ID;
  if (!broadcasterId) return json({ error: 'TWITCH_BROADCASTER_ID env var not set.' }, 500);

  const existing = await env.MARKETPLACE.get('checkin_reward_id');
  if (existing) return json({ success: true, rewardId: existing, alreadyExisted: true });

  const token = await getBroadcasterToken(env);
  if (!token) return json({ error: 'Not authorized for channel points management — complete Step 2 first.' }, 400);

  const cost = Math.max(1, parseInt(body.cost, 10) || 100);

  const res = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Client-Id': env.TWITCH_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Pham Check-In',
      cost,
      prompt: 'Check in to let PhantomACE know you are watching. Once per stream.',
      /* Enabled immediately. Unlike the giveaway reward, which the
         broadcaster toggles per drawing, this one is meant to be available
         the whole time the channel is live. */
      is_enabled: true,
      should_redemptions_skip_request_queue: true,
      /* THE RESET, AND WHY THERE IS NO CODE FOR IT.
         Twitch tracks this per broadcast and clears it when the next stream
         starts. So "resets every time PhantomACE goes live" needs no
         scheduled job, no stream-online webhook, and nothing to go wrong
         while nobody is watching it. */
      is_max_per_user_per_stream_enabled: true,
      max_per_user_per_stream: 1,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    /* Twitch returns 400 CREATE_CUSTOM_REWARD_DUPLICATE_REWARD when a reward
       with this title already exists — which is the likely case if it was
       made by hand in the dashboard. Say so, rather than passing along a
       message that reads like a bug. */
    const dup = /duplicate/i.test(err.message || '');
    return json({
      error: dup
        ? 'A reward called "Pham Check-In" already exists on the channel. Delete it in the Twitch dashboard first, or leave it — redemptions are matched by title, so an existing one already works.'
        : (err.message || 'Twitch API error creating the reward.'),
    }, 400);
  }

  const data = await res.json();
  const rewardId = data.data[0].id;
  await env.MARKETPLACE.put('checkin_reward_id', rewardId);

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

  /* Refuse rather than produce three identical 403s. Twitch rejects a hype
     train subscription with "subscription missing proper authorization" when
     the broadcaster has not granted channel:read:hype_train — a message that
     says nothing about which step to go back to. Checking first turns three
     red crosses into one sentence naming the button to press. */
  /* Hoisted, because the ad-break subscription below is added only when its
     scope is present and re-validating would be a second round trip. */
  let granted = null;
  {
    const stored = await env.MARKETPLACE.get('twitch_broadcaster_token', 'json');
    const bToken = stored && (stored.access_token || stored.token);
    try {
      const vr = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: 'OAuth ' + bToken },
      });
      if (vr.ok) granted = (await vr.json()).scopes || [];
    } catch { /* handled below */ }

    if (granted === null || !granted.includes('channel:read:hype_train')) {
      return json({
        error: 'Hype train events need channel:read:hype_train, which this channel has not granted.',
        fix: 'Go back to Step 2 and click "Authorize Channel Points" again. Twitch will ask you to approve a NEW permission — approve it, then return here.',
        grantedScopes: granted,
      }, 409);
    }
  }

  const subscriptions = [
    /* HYPE TRAIN IS VERSION 2, not 1.
       Twitch replaced the hype train EventSub events when it overhauled the
       feature and retired v1; requesting v1 now returns "invalid subscription
       type and version", which reads like a typo in the type string and is
       not. The other four subscription types here are still v1 — the version
       is per type, not global, so they must not be bumped along with it.

       Payload-compatible with this handler: v2 still carries id, level,
       total, goal and top_contributions, which is everything hype-train.js
       reads. */
    {
      type: 'channel.hype_train.begin',
      version: '2',
      condition: { broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/hype-train`,
    },
    {
      type: 'channel.hype_train.progress',
      version: '2',
      condition: { broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/hype-train`,
    },
    {
      type: 'channel.hype_train.end',
      version: '2',
      condition: { broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/hype-train`,
    },
    {
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/channel-points`,
    },
    /* Milestone drops. They fire nothing until milestone drops are switched
       on in the panel, so subscribing early is harmless and saves coming
       back to this page later. channel.raid is conditioned on the
       TO-broadcaster: it fires when somebody raids this channel, not when
       this channel raids out. */
    {
      type: 'channel.subscribe',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/milestones`,
    },
    {
      type: 'channel.subscription.gift',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/milestones`,
    },
    {
      type: 'channel.raid',
      version: '1',
      condition: { to_broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/milestones`,
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

  /* CONDITIONAL, not part of the hard gate above. channel:read:ads was added
     after this channel was first authorised, so requiring it would refuse to
     create ANY subscription for a broadcaster who has not re-consented —
     breaking a working setup to add an optional feature. Absent scope is
     reported as one failed row instead. */
  if (granted.includes('channel:read:ads')) {
    subscriptions.push({
      type: 'channel.ad_break.begin',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      callback: `${origin}/api/ad-break`,
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
  if (!granted.includes('channel:read:ads')) {
    results.push({
      type: 'channel.ad_break.begin',
      ok: false,
      error: 'Needs channel:read:ads. Go back to Step 2 and click "Authorize Channel Points" '
           + 'again — Twitch will ask you to approve a new permission — then run this step again. '
           + 'Everything else on this page works without it.',
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
      /* Include the version. "invalid subscription type and version" with
         no indication of WHICH version was tried is what made this take a
         round trip to diagnose. */
      results.push({
        type: `${sub.type} (v${sub.version})`,
        ok: false,
        error: data.message || res.statusText,
      });
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
