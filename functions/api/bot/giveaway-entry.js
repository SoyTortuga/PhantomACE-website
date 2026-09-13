/* ══════════════════════════════════════════════
   GIVEAWAY ENTRY WEBHOOK
   EventSub webhook scoped to the "Enter Giveaway"
   channel points reward only (reward_id condition,
   set up in bot-setup.js). Records an entrant while
   entries are open. See giveaway.js for the
   toggle / pick-winner / send-code control endpoints.
   ══════════════════════════════════════════════ */

const HMAC_PREFIX = 'sha256=';
const TWITCH_MESSAGE_ID = 'twitch-eventsub-message-id';
const TWITCH_MESSAGE_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const TWITCH_MESSAGE_SIGNATURE = 'twitch-eventsub-message-signature';
const TWITCH_MESSAGE_TYPE = 'twitch-eventsub-message-type';

const ENTRANTS_KEY = 'giveaway_entrants';
const STATE_KEY = 'giveaway_state';
const ENTRANTS_TTL = 86400;
const MAX_ENTRANTS = 500;

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

/* Channel-point entries now go into the MONTHLY LEDGER, the same place
   chat-drop code redemptions land, so the winner draw has one source of
   truth instead of two half-pictures.

   What this replaces: a giveaway_entrants array capped at 500 with a
   one-day TTL. That was built for a single short giveaway session and is
   wrong for a month-long one in three ways — it silently stopped recording
   at 500, it discarded everything after a day, and it counted rows rather
   than entries, so it could not represent someone holding 50 entries from
   a mythic drop.

   The open/closed toggle still applies: no entries while entries are shut. */
async function addEntrant(env, userId, username) {
  const state = await env.MARKETPLACE.get(STATE_KEY, 'json');
  if (!state || !state.open) return;

  const { addEntries } = await import('../giveaway-entries.js');
  await addEntries(env, userId, username, 1, 'channel-points');
}

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
    const event = body.event;
    if (event) {
      await addEntrant(env, event.user_id, event.user_name || event.user_login || 'unknown');
    }
    return json({ ok: true });
  }

  if (messageType === 'revocation') {
    return json({ ok: true });
  }

  return json({ ok: true });
}
