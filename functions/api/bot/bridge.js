/* ══════════════════════════════════════════════
   BOT BRIDGE
   Shared-secret authenticated endpoints for the
   rig-side Twurple service (PhantomACE-Bot-Service,
   a separate always-on Node process — see its README).
   The rig has no browser session and can't reach KV
   directly, so it talks to these instead of using
   pham_session like everything else on the site.

   - GET  ?action=token   → rig's RefreshingAuthProvider loads its token on startup
   - POST {action:'save-token'} → onRefresh callback target
   - GET  ?action=pending → queued panel actions for the rig to execute (not yet
                            populated by anything — trigger.js still executes
                            directly via the legacy send-chat.js path until the
                            rig is confirmed working end-to-end)
   - POST {action:'ack'}  → rig reports a completed action for the action log

   Deliberately separate from the legacy twitch_bot_token/
   twitch_bot_refresh_token used by send-chat.js/commands.js/
   trigger.js: two independent refresh-token grants running
   in parallel would otherwise invalidate each other, since
   Twitch refresh tokens are single-use/rotating.
   ══════════════════════════════════════════════ */

import { logBotAction } from './send-chat.js';

const TWURPLE_TOKEN_KEY = 'twurple_bot_token';
const PENDING_ACTIONS_KEY = 'bridge_pending_actions';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isAuthorized(env, request) {
  const secret = env.BOT_SERVICE_SECRET;
  if (!secret) return false;
  const header = request.headers.get('X-Bot-Service-Secret') || '';
  return header === secret;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!isAuthorized(env, request)) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'token') {
    const token = await env.MARKETPLACE.get(TWURPLE_TOKEN_KEY, 'json');
    return json({ token: token || null });
  }

  if (action === 'pending') {
    const pending = await env.MARKETPLACE.get(PENDING_ACTIONS_KEY, 'json') || [];
    if (pending.length > 0) {
      await env.MARKETPLACE.delete(PENDING_ACTIONS_KEY);
    }
    return json({ actions: pending });
  }

  return json({ error: 'Invalid action' }, 400);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!isAuthorized(env, request)) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'save-token') {
    const token = body.token;
    if (!token || !token.accessToken || !token.refreshToken) {
      return json({ error: 'Missing token fields' }, 400);
    }
    await env.MARKETPLACE.put(TWURPLE_TOKEN_KEY, JSON.stringify(token));
    return json({ success: true });
  }

  if (body.action === 'ack') {
    await logBotAction(env, {
      type: body.type || 'rig-action',
      rarity: body.rarity,
      code: body.code,
      message: body.message,
      actor: body.actor || 'rig',
      sent: body.success !== false,
    });
    return json({ success: true });
  }

  return json({ error: 'Invalid action' }, 400);
}
