/* ══════════════════════════════════════════════
   BITS POWER-UP → DINO HATCH

   Twitch EventSub webhook for channel.bits.use. The broadcaster chose ONE
   trigger from this event: a Power-up costing exactly 300 bits rolls the dino
   hatch minigame once for whoever spent them (dino-hatch.js).

   channel.bits.use fires for BOTH ordinary cheers and Power-ups; event.type
   distinguishes them ('cheer' vs 'power_up'). Only a 300-bit Power-up hatches —
   an ordinary cheer of 300 bits does not, and neither does a Power-up of any
   other size. Everything else is acknowledged and ignored.

   NEEDS bits:read + the subscription. This subscription is created by the admin
   panel only when the broadcaster has granted bits:read (bot-setup.js), and it
   needs a re-authorisation to add that scope — so until then this route simply
   never receives an event. It is inert, not broken.

   Signature verification uses the shared verifier, which fails closed, compares
   in constant time and enforces a replay window.
   ══════════════════════════════════════════════ */

import { verifyEventSub } from '../../server/lib/eventsub.js';

/* The one Power-up size that hatches. Kept as a named constant because it is a
   deliberate product decision, not a magic number — a Power-up of any other
   cost is ignored on purpose. */
const HATCH_POWERUP_BITS = 300;

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
      const isPowerUp = event.type === 'power_up';
      const bits = Number(event.bits) || 0;

      if (isPowerUp && bits === HATCH_POWERUP_BITS) {
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

    return json({ ok: true });
  }

  return json({ ok: true });
}
