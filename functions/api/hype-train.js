/* ══════════════════════════════════════════════
   HYPE TRAIN API
   EventSub webhook for hype train events
   Posts giveaway codes in chat at level thresholds
   + GET endpoint for live hype train state
   ══════════════════════════════════════════════ */

import { verifyEventSub } from '../../server/lib/eventsub.js';

import { pullGiveawayCode, getBotToken, sendChatMessage } from './bot/send-chat.js';

const CODE_EXPIRY_SECONDS = 300;

const LEVEL_REWARDS = {
  5:  { rarity: 'common',   count: 4, entries: 2,  emoji: '🎟️' },
  10: { rarity: 'uncommon', count: 3, entries: 5,  emoji: '🎫' },
  15: { rarity: 'rare',     count: 2, entries: 15, emoji: '💎' },
  20: { rarity: 'mythic',   count: 1, entries: 50, emoji: '🔥' },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

async function handleHypeTrainProgress(env, event) {
  const level = event.level;

  const stateKey = 'hype_train_active';
  let state = await env.MARKETPLACE.get(stateKey, 'json') || { id: null, droppedLevels: [], alertedLevels: [] };

  /* A new train id resets the per-train bookkeeping. Without this, a second
     train in the same session would inherit the first one's dropped and
     alerted levels and silently skip them. */
  if (state.id !== event.id) {
    state = { id: event.id, startedAt: Date.now(), droppedLevels: [], alertedLevels: [] };
  }
  state.droppedLevels = state.droppedLevels || [];
  state.alertedLevels = state.alertedLevels || [];

  /* ── THIS USED TO RETURN IMMEDIATELY ────────────────────────────────────
     The old first act was `const reward = LEVEL_REWARDS[level]; if (!reward)
     return;` — and rewards exist only at levels 5, 10, 15 and 20. So every
     other level did nothing at all, and two things depended on that:

     hype_train_site, which the site-wide banner reads, was written only when
     a train BEGAN and ENDED. During the train it stayed frozen at level 1
     with the opening progress numbers, on every page, however far the train
     actually got. It is refreshed on every progress event now.

     And no overlay alert was possible for a level that paid no code, which
     is most of them. */
  await env.MARKETPLACE.put('hype_train_site', JSON.stringify({
    id: event.id,
    level,
    total: event.total,
    goal: event.goal,
    startedAt: state.startedAt || Date.now(),
    status: 'active',
  }), { expirationTtl: 3600 });

  /* One alert per level reached, not per progress event — Twitch sends
     progress on every contribution, so this would otherwise fire dozens of
     times at the same level. */
  if (!state.alertedLevels.includes(level)) {
    state.alertedLevels.push(level);
    const { pushOverlayEvent } = await import('./overlay/events.js');
    await pushOverlayEvent(env, { type: 'hype-level', level, total: event.total, goal: event.goal });
    try {
      const { recordActivity } = await import('./activity.js');
      await recordActivity(env, {
        category: 'hype', type: 'hype-level',
        summary: `Hype train reached level ${level}`,
        payload: { id: event.id, level, total: event.total, goal: event.goal },
      });
    } catch (err) { console.error('[hype-train] activity record failed:', err.message); }
  }

  const reward = LEVEL_REWARDS[level];
  if (!reward || state.droppedLevels.includes(level)) {
    /* Nothing to drop, but the alert bookkeeping above still has to persist
       or the next progress event re-alerts the same level. */
    await env.MARKETPLACE.put(stateKey, JSON.stringify(state), { expirationTtl: 3600 });
    return;
  }

  const codes = [];
  for (let i = 0; i < reward.count; i++) {
    const code = await pullGiveawayCode(env, reward.rarity);
    if (code) codes.push(code);
  }
  if (codes.length === 0) {
    /* Pool exhausted. Saved anyway, for the same reason as above. */
    await env.MARKETPLACE.put(stateKey, JSON.stringify(state), { expirationTtl: 3600 });
    return;
  }

  state.droppedLevels.push(level);
  await env.MARKETPLACE.put(stateKey, JSON.stringify(state), { expirationTtl: 3600 });

  const drop = {
    level,
    rarity: reward.rarity,
    entries: reward.entries,
    codes,
    droppedAt: Date.now(),
    expiresAt: Date.now() + (CODE_EXPIRY_SECONDS * 1000),
  };

  const dropsKey = 'hype_train_drops';
  const drops = await env.MARKETPLACE.get(dropsKey, 'json') || [];
  drops.push(drop);
  await env.MARKETPLACE.put(dropsKey, JSON.stringify(drops), { expirationTtl: CODE_EXPIRY_SECONDS });

  /* Make each dropped code claimable. Without this the code is just a
     string in chat that nothing recognises — which is what it was while the
     message pointed at a Gleam embed that had never been configured. */
  const { registerDropCode } = await import('./giveaway-entries.js');
  for (const c of codes) {
    await registerDropCode(env, c, reward.rarity, reward.entries, {
      source: 'hype-train', level,
    });
  }

  /* ONE MESSAGE PER CODE. These used to go out pipe-joined on a single line
     — "4 bonus codes: ABC1 | DEF2 | GHI3 | JKL4" — which made all four of
     them one thing to miss: the line scrolls past as a unit, and a viewer
     who happened to be typing lost the lot. A level 5 train drops four
     commons, so that was four rewards riding on one glance at chat.

     Affordable because the bot account is a moderator, which Twitch rates
     at 100 messages per 30 seconds; four is nothing against that. The first
     line carries the level announcement, the rest are bare codes so the
     train does not shout four times. */
  for (let i = 0; i < codes.length; i++) {
    const lead = i === 0
      ? `${reward.emoji} HYPE TRAIN LEVEL ${level}! ${reward.emoji} `
      : '';
    const msg = `${lead}${reward.rarity.toUpperCase()} code: ${codes[i]} — ` +
      `${reward.entries} bonus entries! ` +
      `Claim at phantomace.tv/giveaway (Twitch login required) — expires in 5 min!`;
    await sendChatMessage(env, msg);
  }
}

async function handleHypeTrainBegin(env, event) {
  const state = {
    id: event.id,
    level: 1,
    total: event.total,
    goal: event.goal,
    startedAt: Date.now(),
    droppedLevels: [],
    status: 'active',
  };
  await env.MARKETPLACE.put('hype_train_active', JSON.stringify(state), { expirationTtl: 3600 });
  await env.MARKETPLACE.put('hype_train_site', JSON.stringify(state), { expirationTtl: 3600 });

  /* Light up Skull Clicker too: a train fires a site-wide cursed-skull
     frenzy for everyone playing. Best-effort — an event must never break the
     webhook that pays out the codes. */
  try {
    const { setSkullEvent } = await import('./skull-clicker.js');
    await setSkullEvent(env, 'frenzy', 10 * 60 * 1000);
  } catch (err) {
    console.error('[hype-train] could not start skull frenzy:', err.message);
  }

  try {
    const { recordActivity } = await import('./activity.js');
    await recordActivity(env, {
      category: 'hype', type: 'hype-begin',
      summary: 'Hype train started',
      payload: event,
    });
  } catch (err) { console.error('[hype-train] activity record failed:', err.message); }

  await sendChatMessage(env,
    '🚂 HYPE TRAIN STARTED! Reach higher levels for bonus giveaway codes dropped right here in chat! 🎟️'
  );
}

async function handleHypeTrainEnd(env, event) {
  const state = await env.MARKETPLACE.get('hype_train_active', 'json') || {};

  const summary = {
    id: event.id,
    level: event.level,
    total: event.total,
    topContributions: event.top_contributions || [],
    endedAt: Date.now(),
    status: 'ended',
  };
  await env.MARKETPLACE.put('hype_train_site', JSON.stringify(summary), { expirationTtl: 300 });
  await env.MARKETPLACE.delete('hype_train_active');

  try {
    const { recordActivity } = await import('./activity.js');
    await recordActivity(env, {
      category: 'hype', type: 'hype-end',
      summary: `Hype train ended at level ${event.level}`,
      payload: summary,
    });
  } catch (err) { console.error('[hype-train] activity record failed:', err.message); }
  /* hype_train_drops is NOT deleted here any more. Codes dropped at the top
     of a train stay claimable for their full five minutes, and wiping the
     list when the train ended made them vanish from the site while still
     working — the display window contradicting the claim window. The live
     feed now expires each code on its own schedule. */

  const droppedCount = (state.droppedLevels || []).length;
  await sendChatMessage(env,
    `🚂 Hype Train complete! Reached Level ${event.level}. ` +
    (droppedCount > 0
      ? `${droppedCount} bonus code${droppedCount > 1 ? 's were' : ' was'} dropped! `
      : '') +
    `Thanks for riding! 🎉`
  );
}

/* ── GET — live hype train state for the site ── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'status') {
    const state = await env.MARKETPLACE.get('hype_train_site', 'json');
    if (!state) return json({ active: false });
    return json({ active: state.status === 'active', ...state });
  }

  if (action === 'drops') {
    /* Serves the unified feed so anything still polling this path sees
       manual drops too, rather than a hype-train-only view. */
    const { getLiveDrops } = await import('./giveaway-entries.js');
    return json({ drops: await getLiveDrops(env) });
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
    const subType = body.subscription ? body.subscription.type : '';
    const event = body.event;
    if (!event) return json({ ok: true });

    if (subType === 'channel.hype_train.begin') {
      await handleHypeTrainBegin(env, event);
    } else if (subType === 'channel.hype_train.progress') {
      await handleHypeTrainProgress(env, event);
    } else if (subType === 'channel.hype_train.end') {
      await handleHypeTrainEnd(env, event);
    }

    return json({ ok: true });
  }

  if (messageType === 'revocation') {
    return json({ ok: true });
  }

  return json({ ok: true });
}
