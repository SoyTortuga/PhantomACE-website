/* ══════════════════════════════════════════════
   CHANNEL POINTS API
   Twitch EventSub webhook for point redemptions
   + GET endpoint for pending redemptions
   ══════════════════════════════════════════════ */

import { verifyEventSub } from '../../server/lib/eventsub.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

const REWARD_HANDLERS = {
  'skull-boost': async (env, userId, redemption) => {
    const key = `cp_skull_boost_${userId}`;
    const boost = { multiplier: 2, expiresAt: Date.now() + 300000, rewardTitle: redemption.reward.title };
    await env.MARKETPLACE.put(key, JSON.stringify(boost), { expirationTtl: 600 });
    await queueRedemption(env, userId, 'skull-boost', redemption);
  },
  'theme-unlock': async (env, userId, redemption) => {
    const inv = await getInventory(env, userId);
    const themeId = 'theme_' + redemption.reward.title.toLowerCase().replace(/\s+/g, '_');
    if (!inv.items.find(i => i.id === themeId)) {
      inv.items.push({
        id: themeId, game: 'profile', type: 'theme', name: redemption.reward.title,
        rarity: 'rare', consumable: false, grantedAt: Date.now(), source: 'channel-points',
      });
      await saveInventory(env, userId, inv);
    }
    await queueRedemption(env, userId, 'theme-unlock', redemption);
  },
  /* PHAM CHECK-IN — "I'm here", once per broadcast.
     The once-per-stream limit is Twitch's own (max_per_user_per_stream on
     the reward), so there is no counter to reset and no scheduled job; the
     reward simply becomes redeemable again when the next stream starts.
     What is recorded here is WHEN, which is the part Twitch does not keep. */
  /* One entry on the open draw's wheel, and nothing else — no queued
     redemption for the site to pop up, no inventory change. The reward costs
     a single point and its whole effect is a name on a reel. */
  'giveaway-entry': async (env, userId, redemption) => {
    const { entryRarityForTitle, addEntrant, settleEntryRedemption } = await import('./bot/giveaway-entry.js');
    const rarity = entryRarityForTitle(redemption.reward && redemption.reward.title);
    if (rarity === false) return;
    const result = await addEntrant(env, userId, redemption.user_name || redemption.user_login || 'unknown', rarity);

    /* THE POINT FOLLOWS THE ANSWER. One entry per person per draw was
       always enforced on the wheel; this enforces it at the till. A second
       redemption — or one that arrives after the draw closed, or for the
       wrong rarity — is cancelled, which refunds it. Twitch has no
       "once per giveaway" cap of its own (per-stream resets between
       broadcasts, and a Rare and a Mythic draw in one night is two
       giveaways), so refusing-with-refund is how the rule is said. */
    await settleEntryRedemption(env, redemption, !!(result && result.ok));
  },

  'pham-checkin': async (env, userId, redemption) => {
    const { getStreamInfo } = await import('./stream-info.js');
    const { streamId, startedAt } = await getStreamInfo(env);

    let position = null;   // 1-based arrival order this broadcast

    await env.MARKETPLACE.mutate('checkin_current', (current) => {
      /* A new broadcast replaces the list wholesale. Twitch's per-stream
         limit has already reset by this point, so carrying the old list
         forward would let one person appear twice in what reads as a single
         stream's attendance. */
      const sameStream = current && streamId && current.streamId === streamId;
      const rec = sameStream
        ? current
        : { streamId: streamId || null, startedAt: startedAt || null, checkins: [] };

      /* Defensive: Twitch enforces one per user per stream, but a webhook can
         be redelivered, and a redelivery is not a second check-in. */
      if (rec.checkins.some(c => String(c.userId) === String(userId))) return undefined;

      const at = Date.now();
      rec.checkins.push({
        userId: String(userId),
        displayName: redemption.user_name || redemption.user_login || '',
        at,
        /* Minutes into the broadcast — the actual question being asked is
           "when did they start watching", and a wall-clock timestamp alone
           makes that arithmetic the reader's problem. */
        minutesIn: rec.startedAt ? Math.max(0, Math.round((at - Date.parse(rec.startedAt)) / 60000)) : null,
      });
      position = rec.checkins.length;
      return rec;
    });

    /* History, streak and any entries earned. Separate from the list above
       because that one is "who is here now" and is thrown away each
       broadcast; this is the durable record streaks are computed from. */
    const { recordCheckin } = await import('./checkin-rewards.js');
    await recordCheckin(env, {
      userId,
      username: redemption.user_name || redemption.user_login || '',
      streamId, startedAt, position,
    });

    /* EVENT BADGES. A window that is closed grants nothing and costs one
       comparison, so this runs on every check-in rather than being switched
       on and off around an event — a feature that has to be remembered is
       one that gets left on.

       mutate(), not read-modify-write: the theme-unlock handler above writes
       the same row, and a viewer redeeming both in the same moment would
       otherwise lose one of them. */
    const { grantOpenBadges } = await import('./checkin-badges.js');
    await env.MARKETPLACE.mutate(inventoryKey(userId), (current) => {
      const inv = current || { userId: String(userId), items: [], equips: {} };
      return grantOpenBadges(inv).length ? inv : undefined;
    });

    /* Nudge the overlay: the same corner reminder the moderator button and
       the timer fire, WITH sound — a viewer just redeemed, so the reaper
       rising with its chime is the acknowledgement. ONLY for a genuinely new
       check-in: `position` stays null when the mutate above treated this as a
       redelivery of an already-recorded redemption, and Twitch can redeliver a
       webhook, so an unconditional push here chimed twice for one redemption.
       Best-effort and isolated: a failure here must never fail the webhook. */
    if (position !== null) {
      try {
        const { pushOverlayEvent } = await import('./overlay/events.js');
        await pushOverlayEvent(env, { type: 'pham-checkin', sound: true });
      } catch { /* overlay is cosmetic; the check-in above is what matters */ }
    }

    await queueRedemption(env, userId, 'pham-checkin', redemption);
  },
  'spin-the-wheel': async (env, userId, redemption) => {
    await queueRedemption(env, userId, 'spin-the-wheel', redemption);
  },
  'community-shoutout': async (env, userId, redemption) => {
    await queueRedemption(env, userId, 'community-shoutout', redemption);
  },

  /* SUMMON RAID BOSS — 10,000 points, sized to the room. Cost, the 1-hour
     cooldown, and the 3-per-stream cap all live on the reward itself in the
     Twitch dashboard (same idea as Pham Check-in's once-per-stream limit),
     so this only has to react and, if a fight is already underway, refund. */
  'raid-boss': async (env, userId, redemption) => {
    const { spawnRaidFromRedemption } = await import('./skull-raid.js');
    const { getStreamInfo } = await import('./stream-info.js');
    const { viewerCount } = await getStreamInfo(env);
    const spawned = await spawnRaidFromRedemption(env, { viewers: viewerCount });
    await settleRedemption(env, redemption, !!spawned);

    /* The badge ladder counts SUMMONS, not charges -- a refunded redemption
       (a fight was already underway) gave the points back and earns nothing
       toward it. Best-effort: a badge that failed to grant is not a reason
       to fail the webhook Twitch is waiting on. */
    if (spawned) {
      try {
        const { recordRaidRedemption } = await import('./raid-badges.js');
        const earned = await recordRaidRedemption(env, userId);
        if (earned.length) {
          const { sendWhisper } = await import('./bot/send-chat.js');
          for (const tier of earned) {
            await sendWhisper(env, userId,
              `☠️ ${tier.name}! That's redemption #${tier.count} of the raid boss — check your profile.`);
          }
        }
      } catch (err) {
        console.error('[channel-points] could not record a raid-boss redemption badge:', err.message);
      }
    }
  },

  /* HATCH A DINO — 30,000 points, the channel-point path into the overlay
     hatch minigame (dino-hatch.js). One roll, granted to the redeemer and
     revealed on stream. Settled explicitly: the reward does NOT skip the
     queue, so a redemption while the minigame is switched off is CANCELED
     (refunded) rather than spending 30,000 points for nothing. A hatch that
     fired always succeeds — a full park overflows to an inventory egg — so
     res.fired is the whole test. */
  'dino-hatch': async (env, userId, redemption) => {
    const { runDinoHatch } = await import('./dino-hatch.js');
    const res = await runDinoHatch(env, {
      userId,
      displayName: redemption.user_name || redemption.user_login || 'Someone',
      count: 1,
      source: 'channel-points',
    });
    await settleRedemption(env, redemption, !!(res && res.fired));
  },
};

/**
 * Tell Twitch what became of a redemption: FULFILLED spends the points,
 * CANCELED refunds them. Needed here because "a boss is already up" is a
 * real reason to refuse a redemption Twitch already charged for — unlike
 * the reward handlers above, which always succeed once Twitch lets them fire.
 * Never throws: a refund that could not be sent is a lost point, not a
 * webhook worth 500ing over.
 */
async function settleRedemption(env, redemption, ok) {
  const rewardId = redemption && redemption.reward && redemption.reward.id;
  const redemptionId = redemption && redemption.id;
  if (!rewardId || !redemptionId) return;
  try {
    const { getBroadcasterToken } = await import('./bot/send-chat.js');
    const token = await getBroadcasterToken(env);
    if (!token) return;
    const url = 'https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions' +
      `?broadcaster_id=${env.TWITCH_BROADCASTER_ID}&reward_id=${rewardId}&id=${redemptionId}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Client-Id': env.TWITCH_CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: ok ? 'FULFILLED' : 'CANCELED' }),
    });
    if (!res.ok) console.error(`[channel-points] could not ${ok ? 'fulfil' : 'refund'} redemption ${redemptionId}: HTTP ${res.status}`);
  } catch (err) {
    console.error('[channel-points] settle failed:', err.message);
  }
}

function inventoryKey(userId) { return `inv_${userId}`; }
async function getInventory(env, userId) {
  return await env.MARKETPLACE.get(inventoryKey(userId), 'json') || { userId, items: [], equips: {} };
}
async function saveInventory(env, userId, inv) {
  await env.MARKETPLACE.put(inventoryKey(userId), JSON.stringify(inv));
}

async function queueRedemption(env, userId, type, redemption) {
  const key = `cp_queue_${userId}`;
  const queue = await env.MARKETPLACE.get(key, 'json') || [];
  queue.push({
    id: redemption.id,
    type,
    rewardTitle: redemption.reward.title,
    userInput: redemption.user_input || '',
    redeemedAt: Date.now(),
  });
  if (queue.length > 20) queue.shift();
  await env.MARKETPLACE.put(key, JSON.stringify(queue), { expirationTtl: 86400 });
}

function mapRewardTitle(title) {
  const lower = title.toLowerCase();
  /* THE RARITY GIVEAWAY ENTRIES RIDE THIS SUBSCRIPTION ON PURPOSE.
     "Enter Rare Giveaway" and "Enter Mythic Giveaway" have no EventSub
     subscription of their own. Giving them one means a reward_id condition,
     which means the admin page's create-EventSub button, which means the
     broadcaster signed in — and creating subscriptions there is the button
     that 409s against the live ones and reports success. This route is
     already subscribed to EVERY redemption on the channel, so the two new
     rewards arrive here for free.

     The legacy "Enter Giveaway" is deliberately NOT matched: it has its own
     reward_id subscription pointed at /api/bot/giveaway-entry, and routing
     it twice would be two paths to keep in step for no gain. */
  if (lower.includes('giveaway') && (lower.includes('rare') || lower.includes('mythic'))) return 'giveaway-entry';
  /* Before 'theme' and the rest: matched on "check" so a renamed reward
     ("Pham Check-In", "Check In!", "checkin") still routes. Titles are typed
     by hand in the Twitch dashboard and will drift. */
  if (lower.includes('check') && (lower.includes('in') || lower.includes('pham'))) return 'pham-checkin';
  if (lower.includes('skull') && lower.includes('boost')) return 'skull-boost';
  if (lower.includes('theme')) return 'theme-unlock';
  if (lower.includes('wheel') || lower.includes('spin')) return 'spin-the-wheel';
  if (lower.includes('shoutout')) return 'community-shoutout';
  if (lower.includes('boss') || lower.includes('raid')) return 'raid-boss';
  /* "Hatch a Dino" and any rename that keeps the word — created by bot-setup,
     matched by title like the rest, so it needs no reward-id subscription. */
  if (lower.includes('hatch')) return 'dino-hatch';
  return null;
}

/* ── GET — poll for pending redemptions ──────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'poll') {
    const key = `cp_queue_${session.user_id}`;
    const queue = await env.MARKETPLACE.get(key, 'json') || [];
    if (queue.length > 0) {
      await env.MARKETPLACE.delete(key);
    }
    return json({ redemptions: queue });
  }

  if (action === 'skull-boost') {
    const key = `cp_skull_boost_${session.user_id}`;
    const boost = await env.MARKETPLACE.get(key, 'json');
    if (boost && boost.expiresAt > Date.now()) {
      return json({ active: true, multiplier: boost.multiplier, expiresAt: boost.expiresAt });
    }
    return json({ active: false });
  }

  return json({ error: 'Invalid action' }, 400);
}

/* ── POST — Twitch EventSub webhook ─────────── */

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
    if (!event) return json({ ok: true });

    const twitchUserId = event.user_id;
    const rewardTitle = event.reward ? event.reward.title : '';
    const handlerKey = mapRewardTitle(rewardTitle);

    /* Every redemption goes to the activity feed, whether or not the site has a
       handler for that reward — the feed is a record of what viewers did. */
    try {
      const { recordActivity } = await import('./activity.js');
      const who = event.user_name || event.user_login || 'someone';
      await recordActivity(env, {
        category: 'redemption', type: rewardTitle || 'channel-point',
        summary: `${who} redeemed "${rewardTitle || 'a reward'}"`,
        payload: event,
      });
    } catch (err) { console.error('[channel-points] activity record failed:', err.message); }

    if (handlerKey && REWARD_HANDLERS[handlerKey]) {
      await REWARD_HANDLERS[handlerKey](env, twitchUserId, event);
    }

    return json({ ok: true });
  }

  if (messageType === 'revocation') {
    return json({ ok: true });
  }

  return json({ ok: true });
}
