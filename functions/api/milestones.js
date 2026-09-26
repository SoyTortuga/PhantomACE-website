/* ══════════════════════════════════════════════
   MILESTONE DROPS — subs, gift subs, and raids

   EventSub webhook. When something worth celebrating happens, fire the same
   code drop the hype train already fires, with a headline saying why.

   The mechanism is deliberately NOT new. dropCodeAction already pulls from
   the pool, registers the code so it can actually be claimed, posts to chat
   and writes the action log — and it carries the shared drop cooldown, which
   is what stops a gift-sub bomb of twenty subs from posting twenty codes in
   four seconds. A separate path would have had to re-earn all of that.

   SIGNATURE VERIFICATION USES THE SHARED VERIFIER.

   The other four webhooks each carry their own copy, wrapped in `if
   (secret)` — so a missing TWITCH_EVENTSUB_SECRET disables checking rather
   than refusing the request. That is latent today only because index.js
   refuses to boot without the secret. server/lib/eventsub.js was written
   during the migration to replace all four, fails closed, compares in
   constant time and enforces a replay window — and nothing had ever
   imported it. This is the first caller; the other four are worth moving
   over as a deliberate change of their own, not folded into a feature.
   ══════════════════════════════════════════════ */

import { verifyEventSub } from '../../server/lib/eventsub.js';
import { dropCodeAction } from './bot/send-chat.js';

const CONFIG_KEY = 'milestone_drops';

/* Defaults. Stored in one row so they can be tuned without a deploy, and so
   the whole thing can be switched off when a stream does not want it. */
const DEFAULTS = {
  enabled: false,          // opt-in: nothing fires until it is turned on
  subRarity: 'common',
  giftRarity: 'uncommon',
  raidRarity: 'common',
  raidMinViewers: 5,       // below this, a raid is two friends passing through
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function getMilestoneConfig(env) {
  const rec = await env.MARKETPLACE.get(CONFIG_KEY, 'json');
  return { ...DEFAULTS, ...(rec || {}) };
}

/* ── The events ──────────────────────────────── */

async function handleEvent(env, type, event) {
  const cfg = await getMilestoneConfig(env);
  if (!cfg.enabled) return { fired: false, reason: 'milestone drops are off' };

  /* Raised before the drop is attempted, and independently of it. A drop
     can be refused by the shared cooldown — two milestones inside fifteen
     seconds — and the second one is still worth putting on screen even when
     no code goes with it. Tying the alert to the drop would silently swallow
     it. */
  const { pushOverlayEvent } = await import('./overlay/events.js');

  if (type === 'channel.subscribe') {
    /* is_gift subs arrive here AND as channel.subscription.gift. Firing on
       both would drop twice for one act of generosity, so the gift event
       owns gifts and this one ignores them. */
    if (event.is_gift) return { fired: false, reason: 'gift — handled by the gift event' };
    const who = event.user_name || event.user_login || 'someone';
    await pushOverlayEvent(env, { type: 'sub', who, tier: event.tier || null });
    return await dropCodeAction(env, cfg.subRarity, 'milestone:sub', {
      headline: `${who} just subscribed! Thank you!`,
    });
  }

  if (type === 'channel.subscription.gift') {
    const who = event.is_anonymous ? 'An anonymous gifter' : (event.user_name || event.user_login || 'Someone');
    const n = Number(event.total) || 1;
    await pushOverlayEvent(env, { type: 'giftsub', who, count: n });
    return await dropCodeAction(env, cfg.giftRarity, 'milestone:giftsub', {
      headline: `${who} gifted ${n} sub${n === 1 ? '' : 's'}!`,
    });
  }

  if (type === 'channel.raid') {
    const viewers = Number(event.viewers) || 0;
    if (viewers < cfg.raidMinViewers) {
      return { fired: false, reason: `raid of ${viewers} below threshold ${cfg.raidMinViewers}` };
    }
    const who = event.from_broadcaster_user_name || 'A raider';
    await pushOverlayEvent(env, { type: 'raid', who, viewers });
    return await dropCodeAction(env, cfg.raidRarity, 'milestone:raid', {
      headline: `${who} raided with ${viewers}! Welcome raiders!`,
    });
  }

  return { fired: false, reason: `unhandled type ${type}` };
}

/* ── POST — Twitch EventSub webhook ──────────── */

export async function onRequestPost(context) {
  const { env, request } = context;

  /* Read the body as TEXT and verify before parsing. The signature covers
     the exact bytes Twitch sent; anything that parses and re-serialises
     first produces a different digest and every webhook 403s. */
  const rawBody = await request.text();

  const check = await verifyEventSub(request, env.TWITCH_EVENTSUB_SECRET, rawBody);
  if (!check.ok) {
    return new Response(check.reason, { status: check.status });
  }

  let body;
  try { body = JSON.parse(rawBody); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (check.messageType === 'webhook_callback_verification') {
    return new Response(body.challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (check.messageType === 'notification') {
    const type = body.subscription && body.subscription.type;
    const event = body.event;
    if (type && event) {
      try {
        await handleEvent(env, type, event);
      } catch (err) {
        /* Never 500 at Twitch. Repeated failures get the subscription
           disabled, and losing the subscription is worse than losing one
           drop — especially since re-creating it needs the admin page. */
        console.error('[milestones]', err.message);
      }

      /* Record to the activity feed regardless of whether milestone DROPS are
         on — the feed is a record of what happened, not of what we reacted to.
         A gifted channel.subscribe is skipped because the gift event covers it
         (same dedup as the drop path above). */
      try {
        const { recordActivity } = await import('./activity.js');
        if (type === 'channel.subscribe' && !event.is_gift) {
          const who = event.user_name || event.user_login || 'someone';
          const tier = { '1000': '1', '2000': '2', '3000': '3' }[event.tier] || event.tier;
          await recordActivity(env, {
            category: 'sub', type,
            summary: `${who} subscribed${tier ? ` (tier ${tier})` : ''}`,
            payload: event,
          });
        } else if (type === 'channel.subscription.gift') {
          const who = event.is_anonymous ? 'An anonymous gifter' : (event.user_name || event.user_login || 'Someone');
          const n = Number(event.total) || 1;
          await recordActivity(env, {
            category: 'giftsub', type,
            summary: `${who} gifted ${n} sub${n === 1 ? '' : 's'}`,
            payload: event,
          });
        } else if (type === 'channel.raid') {
          const who = event.from_broadcaster_user_name || 'A raider';
          await recordActivity(env, {
            category: 'raid', type,
            summary: `${who} raided with ${Number(event.viewers) || 0}`,
            payload: event,
          });
        }
      } catch (err) {
        console.error('[milestones] activity record failed:', err.message);
      }

      /* GIFT SUBS ALSO HATCH DINOS. Separate from the code drop above and
         from its on/off: the hatch minigame has its own toggle (dino-hatch.js),
         so a channel that has milestone drops switched off still hatches. One
         roll per sub gifted, revealed as a single batch animation. An
         anonymous gift shows the hatch but grants nothing — there is no
         account to grant to. Isolated: a hatch failure must not fail the
         webhook Twitch is waiting on. */
      if (type === 'channel.subscription.gift') {
        try {
          const { runDinoHatch } = await import('./dino-hatch.js');
          await runDinoHatch(env, {
            userId: event.is_anonymous ? null : (event.user_id || null),
            displayName: event.is_anonymous
              ? 'An anonymous gifter'
              : (event.user_name || event.user_login || 'Someone'),
            count: Number(event.total) || 1,
            source: 'giftsub',
          });
        } catch (err) {
          console.error('[milestones] hatch failed:', err.message);
        }
      }
    }
    return json({ ok: true });
  }

  return json({ ok: true });
}

/**
 * Update the config.
 *
 * Lives here next to the defaults it validates against, but is called from
 * /api/bot/trigger rather than exposed as POST on this route — POST here is
 * the Twitch webhook, and a panel request would be rejected by the signature
 * check before it ever reached a handler.
 */
export async function setMilestoneConfig(env, patch) {
  const rarities = ['common', 'uncommon', 'rare', 'mythic'];
  const next = {};

  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  for (const k of ['subRarity', 'giftRarity', 'raidRarity']) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k]).toLowerCase();
    if (!rarities.includes(v)) return { error: `${k} must be one of: ${rarities.join(', ')}` };
    next[k] = v;
  }
  if (patch.raidMinViewers !== undefined) {
    const n = Math.floor(Number(patch.raidMinViewers));
    if (!Number.isFinite(n) || n < 1) return { error: 'raidMinViewers must be 1 or more.' };
    next.raidMinViewers = n;
  }

  await env.MARKETPLACE.mutate(CONFIG_KEY, (current) => ({ ...DEFAULTS, ...(current || {}), ...next }));
  return { success: true, config: await getMilestoneConfig(env) };
}
