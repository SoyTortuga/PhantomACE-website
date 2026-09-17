/* ══════════════════════════════════════════════
   GIVEAWAY ENTRY WEBHOOK
   EventSub webhook scoped to the "Enter Giveaway"
   channel points reward only (reward_id condition,
   set up in bot-setup.js). Records an entrant while
   entries are open. See giveaway.js for the
   toggle / pick-winner / send-code control endpoints.
   ══════════════════════════════════════════════ */

import { verifyEventSub } from '../../../server/lib/eventsub.js';

const ENTRANTS_KEY = 'giveaway_entrants';
const STATE_KEY = 'giveaway_state';
const ENTRANTS_TTL = 86400;
const MAX_ENTRANTS = 500;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
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

  /* FAILS CLOSED. The copy this replaced verified only `if (secret)`, so a
     missing TWITCH_EVENTSUB_SECRET did not fail — it skipped, and this
     endpoint accepted unsigned posts from anyone. The shared verifier
     answers 500 instead, and also checks the headers, the replay window
     and the signature in constant time. */
  const check = await verifyEventSub(request, env.TWITCH_EVENTSUB_SECRET, bodyText);
  if (!check.ok) return new Response(check.reason, { status: check.status });
  const messageType = check.messageType;

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
