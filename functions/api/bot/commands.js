/* ══════════════════════════════════════════════
   BOT COMMANDS
   EventSub webhook for channel.chat.message
   Broadcaster/moderator-only chat commands:
     !drop <common|uncommon|rare|mythic>
     !dropitem [code]
     !announce <message>
   ══════════════════════════════════════════════ */

import { dropCodeAction, dropItemAction, announceAction } from './send-chat.js';

const HMAC_PREFIX = 'sha256=';
const TWITCH_MESSAGE_ID = 'twitch-eventsub-message-id';
const TWITCH_MESSAGE_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const TWITCH_MESSAGE_SIGNATURE = 'twitch-eventsub-message-signature';
const TWITCH_MESSAGE_TYPE = 'twitch-eventsub-message-type';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function verifySignature(secret, request, body) {
  const msgId = request.headers.get(TWITCH_MESSAGE_ID) || '';
  const timestamp = request.headers.get(TWITCH_MESSAGE_TIMESTAMP) || '';
  const expected = request.headers.get(TWITCH_MESSAGE_SIGNATURE) || '';

  const message = msgId + timestamp + body;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return expected === HMAC_PREFIX + hex;
}

/* A sender counts as authorized if Twitch flags them as the broadcaster
   or a moderator — via chatter_user_id match or the badges array. Never
   trust the display name/login string alone. */
function isAuthorizedSender(env, event) {
  if (!event) return false;
  if (event.chatter_user_id && env.TWITCH_BROADCASTER_ID && event.chatter_user_id === env.TWITCH_BROADCASTER_ID) {
    return true;
  }
  const badges = event.badges || [];
  return badges.some(b => b.set_id === 'broadcaster' || b.set_id === 'moderator');
}

function parseCommand(event) {
  const text = event && event.message && typeof event.message.text === 'string' ? event.message.text.trim() : '';
  if (!text.startsWith('!')) return null;

  const spaceIdx = text.indexOf(' ');
  const command = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
  return { command, rest };
}

async function handleChatMessage(env, event) {
  if (!isAuthorizedSender(env, event)) return;

  const parsed = parseCommand(event);
  if (!parsed) return;

  const actor = event.chatter_user_login || event.chatter_user_name || 'unknown';

  if (parsed.command === '!drop') {
    await dropCodeAction(env, parsed.rest, actor);
    return;
  }

  if (parsed.command === '!dropitem') {
    await dropItemAction(env, parsed.rest || null, actor);
    return;
  }

  if (parsed.command === '!announce') {
    await announceAction(env, parsed.rest, actor);
    return;
  }
}

/* ── POST — Twitch EventSub webhook ─────────── */

export async function onRequestPost(context) {
  const { env, request } = context;

  const bodyText = await request.text();
  const messageType = request.headers.get(TWITCH_MESSAGE_TYPE);

  const secret = env.TWITCH_EVENTSUB_SECRET;
  if (secret) {
    const valid = await verifySignature(secret, request, bodyText);
    if (!valid) return new Response('Invalid signature', { status: 403 });
  }

  let body;
  try { body = JSON.parse(bodyText); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (messageType === 'webhook_callback_verification') {
    return new Response(body.challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (messageType === 'notification') {
    const subType = body.subscription ? body.subscription.type : '';
    const event = body.event;
    if (!event) return json({ ok: true });

    if (subType === 'channel.chat.message') {
      await handleChatMessage(env, event);
    }

    return json({ ok: true });
  }

  if (messageType === 'revocation') {
    return json({ ok: true });
  }

  return json({ ok: true });
}
