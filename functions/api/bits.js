/* ══════════════════════════════════════════════
   BITS POWER-UP → DINO HATCH

   Twitch EventSub webhook for channel.bits.use. The broadcaster made a CUSTOM
   Bits Power-up for the dino hatch (300 bits). Using it rolls the hatch
   minigame once for whoever spent the bits (dino-hatch.js).

   WHY custom_power_up, NOT power_up. channel.bits.use fires for three kinds of
   usage, told apart by event.type: 'cheer' (an ordinary cheer), 'power_up' (a
   BUILT-IN Power-up — message effect / Gigantify an Emote / celebration, whose
   bit prices Twitch sets and which can't be made into a hatch reward), and
   'custom_power_up' (a Power-up the broadcaster created). The egg-hatch reward
   is necessarily a CUSTOM Power-up, so it arrives as type 'custom_power_up'
   with its name in event.custom_power_up.title — the earlier code only matched
   'power_up', which is why a 300-bit hatch Power-up never fired. We match the
   custom Power-up the same way the channel-point reward is matched (by title,
   so a rename that keeps the word still works), with the 300-bit cost as a
   fallback signal. An ordinary cheer never hatches. Everything else is acked
   and ignored.

   NEEDS bits:read + the subscription. This subscription is created by the admin
   panel only when the broadcaster has granted bits:read (bot-setup.js), and it
   needs a re-authorisation to add that scope — so until then this route simply
   never receives an event. It is inert, not broken.

   Signature verification uses the shared verifier, which fails closed, compares
   in constant time and enforces a replay window.
   ══════════════════════════════════════════════ */

import { verifyEventSub } from '../../server/lib/eventsub.js';

/* The custom Power-up's Bits cost, used only as a FALLBACK match when the
   title doesn't name the hatch — the broadcaster can reprice the Power-up, so
   this is a signal, not the gate. */
const HATCH_POWERUP_BITS = 300;

/* A custom Power-up is the hatch reward when its title names it (matched like
   the channel-point reward, so a rename keeps working) OR, failing a title,
   when it costs exactly the hatch price. */
function isHatchPowerUp(event) {
  if (!event || event.type !== 'custom_power_up') return false;
  const title = ((event.custom_power_up && event.custom_power_up.title) || '').toLowerCase();
  if (/hatch|egg|dino/.test(title)) return true;
  if (!title && (Number(event.bits) || 0) === HATCH_POWERUP_BITS) return true;
  return false;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  /* Read the body as TEXT and verify before parsing — the signature covers the
     exact bytes Twitch sent. */
  const rawBody = await request.text();

  const check = await verifyEventSub(request, env.TWITCH_EVENTSUB_SECRET, rawBody);
  if (!check.ok) return new Response(check.reason, { status: check.status });

  let body;
  try { body = JSON.parse(rawBody); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (check.messageType === 'webhook_callback_verification') {
    return new Response(body.challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (check.messageType === 'notification') {
    const event = body.event;
    const type = body.subscription && body.subscription.type;

    if (type === 'channel.bits.use' && event) {
      if (isHatchPowerUp(event)) {
        try {
          const { runDinoHatch } = await import('./dino-hatch.js');
          await runDinoHatch(env, {
            userId: event.user_id || null,
            displayName: event.user_name || event.user_login || 'Someone',
            count: 1,
            source: 'bits',
          });
        } catch (err) {
          /* Never 500 at Twitch — repeated failures get the subscription
             disabled, which is worse than losing one hatch. */
          console.error('[bits] hatch failed:', err.message);
        }
      }
    }

    const { clearEventSubRevocation } = await import('./bot/dashboard.js');
    await clearEventSubRevocation(env, type);

    return json({ ok: true });
  }

  if (check.messageType === 'revocation') {
    const { recordEventSubRevocation } = await import('./bot/dashboard.js');
    await recordEventSubRevocation(env, body, 'bits');
    return json({ ok: true });
  }

  return json({ ok: true });
}

export { isHatchPowerUp };
