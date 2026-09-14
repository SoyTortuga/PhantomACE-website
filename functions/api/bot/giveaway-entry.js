/* ══════════════════════════════════════════════
   GIVEAWAY ENTRY WEBHOOK
   EventSub webhook scoped to the "Enter Giveaway"
   channel points reward only (reward_id condition,
   set up in bot-setup.js). Records an entrant while
   entries are open. See giveaway.js for the
   toggle / pick-winner / send-code control endpoints.
   ══════════════════════════════════════════════ */

const HMAC_PREFIX = 'sha256=';

/* Twitch recommends rejecting any message whose timestamp is more than ten
   minutes old. Without it, a captured signed request stays replayable for
   ever, because the signature never expires. */
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
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

  /* Reject stale messages BEFORE spending time on the HMAC. A valid
     signature on an old message is exactly what a replay looks like. */
  const age = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_MESSAGE_AGE_MS) return false;
  const expected = request.headers.get(TWITCH_MESSAGE_SIGNATURE) || '';

  const message = msgId + timestamp + body;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return expected === HMAC_PREFIX + hex;
}

/* TWO GIVEAWAYS, TWO SOURCES, NO OVERLAP.

     chat drop codes    → the MONTHLY ledger (giveaway-entries.js)
     Phamily Time       → the MONTHLY ledger
     channel points     → THIS event's entrant list, and nothing else

   A redemption used to add to the monthly ledger instead, which meant a
   spontaneous on-stream spin drew from every entry accumulated since the
   1st — including people who were not watching — while the cheap
   one-point entry quietly inflated a month-long prize draw.

   The old session list was capped at 500 and silently stopped recording
   past it. This one records everyone, because a cap that hides the people
   it drops is worse than no cap. */
async function addEntrant(env, userId, username) {
  const state = await env.MARKETPLACE.get(STATE_KEY, 'json');
  if (!state || !state.open) return;

  await env.MARKETPLACE.mutate(ENTRANTS_KEY, (current) => {
    const rec = current && Array.isArray(current.entrants)
      ? current
      : { entrants: [], openedAt: Date.now() };
    /* One slice per person. Twitch allows repeat redemptions of the same
       reward, and someone redeeming five times should not get five slices
       of a wheel that is meant to pick a person. */
    if (rec.entrants.some(e => String(e.userId) === String(userId))) return undefined;
    rec.entrants.push({ userId: String(userId), username: username || 'unknown', at: Date.now() });
    return rec;
  });
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
