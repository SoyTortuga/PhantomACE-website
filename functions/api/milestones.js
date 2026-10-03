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

/* Follows can be resent by Twitch or replayed; a per-user dedupe window stops
   one follow alerting twice. The KV key self-expires, so "seen" is just its
   presence. Ten minutes is generous against resends and short enough that a
   genuine unfollow/refollow later still alerts. */
const FOLLOW_DEDUPE_SECONDS = 600;

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

/* Twitch's global cheermote prefixes. A cheer's text carries its bits as
   tokens like "Cheer100" or "Kappa50", which read as noise on stream. */
const CHEERMOTE_PREFIXES = new Set([
  'cheer', 'doodlecheer', 'biblethump', 'cheerwhal', 'corgo', 'scoops', 'uni',
  'showlove', 'party', 'seemsgood', 'pride', 'kappa', 'frankerz', 'heyguys',
  'dansgame', 'elegiggle', 'trihard', 'kreygasm', '4head', 'swiftrage',
  'notlikethis', 'failfish', 'vohiyo', 'pjsalt', 'mrdestructoid', 'bday',
  'ripcheer', 'shamrock', 'bitboss', 'streamlabs', 'muxy', 'holidaycheer',
  'goal', 'anon', 'charity',
]);
const CHEER_TOKEN = /^(.*?[A-Za-z])(\d+)$/;

/**
 * The cheer's message with its cheermote tokens removed. Pure — exported
 * for tests.
 *
 * Known prefixes (and anything with "cheer" in it) always go. A channel can
 * also have its own custom cheermote prefix, which no list knows; so when the
 * known tokens do not account for every bit cheered, remaining
 * letters-then-digits tokens are removed too, but only until the bits add up
 * — "mp3" in a message that is already fully accounted for survives.
 */
export function stripCheermotes(message, bits) {
  const tokens = String(message == null ? '' : message).split(/\s+/).filter(Boolean);
  const total = Number(bits) || 0;
  const drop = new Set();
  let counted = 0;

  tokens.forEach((t, i) => {
    const m = CHEER_TOKEN.exec(t);
    if (!m) return;
    const prefix = m[1].toLowerCase();
    if (CHEERMOTE_PREFIXES.has(prefix) || prefix.includes('cheer')) {
      drop.add(i);
      counted += Number(m[2]) || 0;
    }
  });

  if (counted < total) {
    tokens.forEach((t, i) => {
      if (drop.has(i) || counted >= total) return;
      const m = CHEER_TOKEN.exec(t);
      if (!m) return;
      const amount = Number(m[2]) || 0;
      if (amount <= 0 || counted + amount > total) return;
      drop.add(i);
      counted += amount;
    });
  }

  return tokens.filter((_, i) => !drop.has(i)).join(' ').trim();
}

export async function getMilestoneConfig(env) {
  const rec = await env.MARKETPLACE.get(CONFIG_KEY, 'json');
  return { ...DEFAULTS, ...(rec || {}) };
}

/* ── The events ──────────────────────────────── */

async function handleEvent(env, type, event) {
  const { pushOverlayEvent, isAlertEnabled } = await import('./overlay/events.js');

  /* Follow and cheer are PURE ALERTS — Twitch-native events we put on OUR
     overlay so they stop fighting Streamlabs for screen space. They drop no
     code and are NOT gated by the milestone-drop toggle. When their per-alert
     toggle is OFF they do nothing at all — no overlay alert AND no feed row. */
  if (type === 'channel.follow') {
    if (!(await isAlertEnabled(env, 'follow'))) return { fired: false, reason: 'follow alerts disabled' };
    const who = event.user_name || event.user_login || 'someone';
    const uid = event.user_id ? String(event.user_id) : who.toLowerCase();
    const seenKey = `follow_seen_${uid}`;
    if (await env.MARKETPLACE.get(seenKey)) return { fired: false, reason: 'duplicate follow within window' };
    await env.MARKETPLACE.put(seenKey, String(Date.now()), { expirationTtl: FOLLOW_DEDUPE_SECONDS });
    await pushOverlayEvent(env, { type: 'follow', user: who });
    try {
      const { recordActivity } = await import('./activity.js');
      await recordActivity(env, { category: 'follow', type, summary: `${who} followed`, payload: event });
    } catch (err) { console.error('[milestones] activity record failed:', err.message); }
    return { fired: true, alert: 'follow' };
  }

  if (type === 'channel.cheer') {
    if (!(await isAlertEnabled(env, 'cheer'))) return { fired: false, reason: 'cheer alerts disabled' };
    const who = event.is_anonymous ? 'An anonymous cheerer' : (event.user_name || event.user_login || 'Someone');
    const bits = Number(event.bits) || 0;
    /* Stripped before the length cap, so the cap measures words people read. */
    const message = event.message ? stripCheermotes(event.message, bits).slice(0, 200) : '';
    await pushOverlayEvent(env, { type: 'cheer', user: who, bits, message });
    try {
      const { recordActivity } = await import('./activity.js');
      await recordActivity(env, { category: 'cheer', type, summary: `${who} cheered ${bits} bit${bits === 1 ? '' : 's'}`, payload: event });
    } catch (err) { console.error('[milestones] activity record failed:', err.message); }
    return { fired: true, alert: 'cheer' };
  }

  /* RESUB — channel.subscription.message, a viewer re-upping and sharing how
     long it has been. A PURE ALERT like follow/cheer: it runs through our
     overlay (so it stops fighting Streamlabs) and records to the feed, but
     drops no code and is not gated by the milestone-drop toggle. channel.subscribe
     fires only for NEW subs, so this is the only event a resub produces. */
  if (type === 'channel.subscription.message') {
    if (!(await isAlertEnabled(env, 'resub'))) return { fired: false, reason: 'resub alerts disabled' };
    const who = event.user_name || event.user_login || 'someone';
    const months = Number(event.cumulative_months) || Number(event.duration_months) || 1;
    const streak = Number(event.streak_months) || 0;
    const message = (event.message && event.message.text) ? String(event.message.text).slice(0, 200) : '';
    await pushOverlayEvent(env, { type: 'resub', who, months, streak, message, tier: event.tier || null });
    try {
      const { recordActivity } = await import('./activity.js');
      await recordActivity(env, {
        category: 'resub', type,
        summary: `${who} resubscribed — ${months} month${months === 1 ? '' : 's'}`,
        payload: event,
      });
    } catch (err) { console.error('[milestones] activity record failed:', err.message); }
    return { fired: true, alert: 'resub' };
  }

  /* TWO SEPARATE CONCERNS for sub/gift/raid: the on-screen ALERT and the code
     DROP. The alert fires whenever the event arrives (subject only to its
     per-alert toggle, enforced inside pushOverlayEvent) — it does NOT depend on
     milestone drops being on. The code DROP is what the drops toggle governs, so
     only the dropCodeAction below is behind cfg.enabled. */
  const cfg = await getMilestoneConfig(env);

  if (type === 'channel.subscribe') {
    /* is_gift subs arrive here AND as channel.subscription.gift. Firing on
       both would alert/drop twice for one act of generosity, so the gift event
       owns gifts and this one ignores them. */
    if (event.is_gift) return { fired: false, reason: 'gift — handled by the gift event' };
    const who = event.user_name || event.user_login || 'someone';
    await pushOverlayEvent(env, { type: 'sub', who, tier: event.tier || null });
    if (!cfg.enabled) return { fired: false, reason: 'alert shown; milestone drops are off' };
    return await dropCodeAction(env, cfg.subRarity, 'milestone:sub', {
      headline: `${who} just subscribed! Thank you!`,
    });
  }

  if (type === 'channel.subscription.gift') {
    const who = event.is_anonymous ? 'An anonymous gifter' : (event.user_name || event.user_login || 'Someone');
    const n = Number(event.total) || 1;
    await pushOverlayEvent(env, { type: 'giftsub', who, count: n });
    if (!cfg.enabled) return { fired: false, reason: 'alert shown; milestone drops are off' };
    return await dropCodeAction(env, cfg.giftRarity, 'milestone:giftsub', {
      headline: `${who} gifted ${n} sub${n === 1 ? '' : 's'}!`,
    });
  }

  if (type === 'channel.raid') {
    const viewers = Number(event.viewers) || 0;
    const who = event.from_broadcaster_user_name || 'A raider';
    /* The alert fires for any raid; the min-viewers threshold gates only the
       DROP ("two friends passing through" earns no code, but is still a raid
       worth showing). */
    await pushOverlayEvent(env, { type: 'raid', who, viewers });
    if (!cfg.enabled) return { fired: false, reason: 'alert shown; milestone drops are off' };
    if (viewers < cfg.raidMinViewers) {
      return { fired: false, reason: `raid of ${viewers} below drop threshold ${cfg.raidMinViewers}` };
    }
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
      /* The feed entry follows the per-alert toggle too: a disabled alert type
         records nothing, matching the overlay (disabled = no alert AND no feed
         row). Follow/cheer record inside handleEvent; sub/gift/raid record here.
         A gifted channel.subscribe is skipped because the gift event covers it. */
      try {
        const { recordActivity } = await import('./activity.js');
        const { isAlertEnabled } = await import('./overlay/events.js');
        if (type === 'channel.subscribe' && !event.is_gift) {
          if (await isAlertEnabled(env, 'sub')) {
            const who = event.user_name || event.user_login || 'someone';
            const tier = { '1000': '1', '2000': '2', '3000': '3' }[event.tier] || event.tier;
            await recordActivity(env, {
              category: 'sub', type,
              summary: `${who} subscribed${tier ? ` (tier ${tier})` : ''}`,
              payload: event,
            });
          }
        } else if (type === 'channel.subscription.gift') {
          if (await isAlertEnabled(env, 'giftsub')) {
            const who = event.is_anonymous ? 'An anonymous gifter' : (event.user_name || event.user_login || 'Someone');
            const n = Number(event.total) || 1;
            await recordActivity(env, {
              category: 'giftsub', type,
              summary: `${who} gifted ${n} sub${n === 1 ? '' : 's'}`,
              payload: event,
            });
          }
        } else if (type === 'channel.raid') {
          if (await isAlertEnabled(env, 'raid')) {
            const who = event.from_broadcaster_user_name || 'A raider';
            await recordActivity(env, {
              category: 'raid', type,
              summary: `${who} raided with ${Number(event.viewers) || 0}`,
              payload: event,
            });
          }
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

      const { clearEventSubRevocation } = await import('./bot/dashboard.js');
      await clearEventSubRevocation(env, type);
    }
    return json({ ok: true });
  }

  /* Five subscription types land here (sub, gift, raid, follow, cheer), and
     this route had no revocation branch at all — a revoked one simply went
     quiet. Recorded so Bot Control can say which. */
  if (check.messageType === 'revocation') {
    const { recordEventSubRevocation } = await import('./bot/dashboard.js');
    await recordEventSubRevocation(env, body, 'milestones');
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
