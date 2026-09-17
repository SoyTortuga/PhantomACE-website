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

    await queueRedemption(env, userId, 'pham-checkin', redemption);
  },
  'spin-the-wheel': async (env, userId, redemption) => {
    await queueRedemption(env, userId, 'spin-the-wheel', redemption);
  },
  'community-shoutout': async (env, userId, redemption) => {
    await queueRedemption(env, userId, 'community-shoutout', redemption);
  },
};

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
  /* Before 'theme' and the rest: matched on "check" so a renamed reward
     ("Pham Check-In", "Check In!", "checkin") still routes. Titles are typed
     by hand in the Twitch dashboard and will drift. */
  if (lower.includes('check') && (lower.includes('in') || lower.includes('pham'))) return 'pham-checkin';
  if (lower.includes('skull') && lower.includes('boost')) return 'skull-boost';
  if (lower.includes('theme')) return 'theme-unlock';
  if (lower.includes('wheel') || lower.includes('spin')) return 'spin-the-wheel';
  if (lower.includes('shoutout')) return 'community-shoutout';
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
