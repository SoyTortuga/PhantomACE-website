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

/* The three rewards that enter someone, and the rarity each one means.
   Matched on the TITLE rather than a stored reward id, for one blunt
   reason: a reward id condition needs its own EventSub subscription, and
   creating one needs the broadcaster signed in at the admin page. The
   catch-all `channel.channel_points_custom_reward_redemption.add`
   subscription that already feeds /api/channel-points sees every redemption
   on the channel, so routing on the title there costs nothing and needs
   nobody to sign in.

   `null` is the legacy reward, which predates rarities and matches whatever
   draw is open. */
export const ENTRY_REWARD_RARITY = {
  'enter rare giveaway': 'rare',
  'enter mythic giveaway': 'mythic',
  'enter giveaway': null,
};

/** The rarity a reward title enters, or false when it enters nothing. */
export function entryRarityForTitle(title) {
  const key = String(title || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ENTRY_REWARD_RARITY, key)
    ? ENTRY_REWARD_RARITY[key]
    : false;
}

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
export async function addEntrant(env, userId, username, rarity = null) {
  const state = await env.MARKETPLACE.get(STATE_KEY, 'json');
  if (!state || !state.open) return { ok: false, reason: 'closed' };

  /* THE REWARD MUST MATCH THE DRAW.
     Both entry rewards are disabled between draws, so a mismatch should be
     impossible — but "should be impossible" is doing a lot of work there.
     Twitch delivers redemptions with a lag, a viewer can redeem in the
     second before the reward is switched off, and the broadcaster can open
     a Rare draw while a stray Mythic redemption is still in flight. Silently
     accepting it would put someone on the wrong wheel.

     A null rarity is the legacy reward and matches any open draw. */
  if (rarity && state.rarity && rarity !== state.rarity) {
    return { ok: false, reason: 'rarity-mismatch', open: state.rarity };
  }

  let added = false;
  await env.MARKETPLACE.mutate(ENTRANTS_KEY, (current) => {
    const rec = current && Array.isArray(current.entrants)
      ? current
      : { entrants: [], openedAt: Date.now() };
    /* One slice per person. Twitch allows repeat redemptions of the same
       reward, and someone redeeming five times should not get five slices
       of a wheel that is meant to pick a person. */
    if (rec.entrants.some(e => String(e.userId) === String(userId))) return undefined;
    rec.entrants.push({ userId: String(userId), username: username || 'unknown', at: Date.now() });
    added = true;
    return rec;
  });

  return added ? { ok: true } : { ok: false, reason: 'duplicate' };
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
      /* This route is subscribed with a reward_id condition on the legacy
         "Enter Giveaway" reward, so whatever arrives here is that one — but
         read the title anyway, so a re-pointed subscription cannot quietly
         file a Mythic redemption against a Rare draw. */
      const rarity = entryRarityForTitle(event.reward && event.reward.title);
      await addEntrant(env, event.user_id, event.user_name || event.user_login || 'unknown',
        rarity === false ? null : rarity);
    }
    return json({ ok: true });
  }

  if (messageType === 'revocation') {
    return json({ ok: true });
  }

  return json({ ok: true });
}
