/* ══════════════════════════════════════════════
   BOT SEND-CHAT — shared module
   Bot token refresh, chat sending, giveaway code
   pulls, cooldowns, and action logging.
   Imported by commands.js, trigger.js, and (once
   adopted by phamily-giveaway) hype-train.js.
   ══════════════════════════════════════════════ */

import { activateItemCode, activateNextItemCode } from '../item-codes.js';

export const TIER_INFO = {
  common:   { entries: 2,  emoji: '🎟️' },
  uncommon: { entries: 5,  emoji: '🎫' },
  rare:     { entries: 15, emoji: '💎' },
  mythic:   { entries: 50, emoji: '🔥' },
};

const CODE_EXPIRY_SECONDS = 300;
const ITEM_CODE_DURATION_SECONDS = 300; // 5 min — same window as a giveaway code drop
const ACTION_LOG_KEY = 'bot_action_log';
const ACTION_LOG_MAX = 20;
const ACTION_LOG_TTL = 604800; // 7 days

/* Half a second. The bot account is a MODERATOR, which Twitch rates at 100
   messages per 30 seconds rather than the 20 a normal account gets — so the
   floor here is about 0.3s and this leaves headroom.

   It is not zero, and should not be: each drop pulls from a finite code
   pool, and a held-down button with no gate at all empties a rarity in
   seconds with nothing to confirm it. The cooldown stopped being about the
   rate limit and became about the pool.

   DEPENDS ON THE BOT STAYING A MODERATOR. If that is ever revoked the limit
   silently drops back to 20/30s, and Twitch reports a throttled message as
   HTTP 200 with is_sent false — so drops would vanish from chat while the
   panel reported success. */
const DROP_COOLDOWN_SECONDS = 0.5;
/* Left at 15. Item codes come from a hand-curated queue rather than a pool
   of interchangeable codes, so firing them off rapidly burns through
   prepared rewards in the wrong order with no way back. */
const DROPITEM_COOLDOWN_SECONDS = 15;
const ANNOUNCE_COOLDOWN_SECONDS = 5;
const ANNOUNCE_MAX_LENGTH = 450;

export async function getBotToken(env) {
  const cached = await env.MARKETPLACE.get('twitch_bot_token', 'json');
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.access_token;

  const refresh = env.TWITCH_BOT_REFRESH_TOKEN
    || await env.MARKETPLACE.get('twitch_bot_refresh_token');
  if (!refresh) return null;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
    }),
  });

  if (!res.ok) return null;
  const tokens = await res.json();

  await env.MARKETPLACE.put('twitch_bot_token', JSON.stringify({
    access_token: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in * 1000),
  }), { expirationTtl: tokens.expires_in });

  return tokens.access_token;
}

export async function sendChatMessage(env, message) {
  const token = await getBotToken(env);
  if (!token) return false;

  const broadcasterId = env.TWITCH_BROADCASTER_ID;
  const botUserId = env.TWITCH_BOT_USER_ID
    || await env.MARKETPLACE.get('twitch_bot_user_id')
    || broadcasterId;

  const res = await fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Client-Id': env.TWITCH_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      broadcaster_id: broadcasterId,
      sender_id: botUserId,
      message: message,
    }),
  });

  if (!res.ok) return false;

  /* ── 200 DOES NOT MEAN THE MESSAGE APPEARED ──────────────────────────
     Twitch accepts the request and then decides separately whether to post
     it. AutoMod holds, blocked terms, follower/subscriber-only mode and the
     "block hyperlinks from non-moderators" setting all come back as HTTP 200
     with data[0].is_sent === false and a drop_reason.

     This used to `return res.ok`, so every one of those was reported as a
     successful send: the panel said "Code dropped to chat", the action log
     recorded it, and chat showed nothing. That mattered little while the bot
     was the broadcaster, who is exempt from all of it. It matters a great
     deal for a bot account without moderator status — and every drop message
     contains a phantomace.tv link, which is exactly what those filters
     catch. */
  let result = null;
  try {
    const payload = await res.json();
    result = payload && payload.data && payload.data[0];
  } catch {
    /* Accepted, but the body was unreadable. Nothing says it was refused, so
       do not invent a failure. */
    return true;
  }

  if (result && result.is_sent === false) {
    const reason = result.drop_reason || {};
    console.warn(`[chat] Twitch accepted but did not post the message: ${reason.code || 'unknown'} ${reason.message || ''}`.trim());
    return false;
  }

  return true;
}

export async function getBroadcasterToken(env) {
  const cached = await env.MARKETPLACE.get('twitch_broadcaster_token', 'json');
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.access_token;

  const refresh = await env.MARKETPLACE.get('twitch_broadcaster_refresh_token');
  if (!refresh) return null;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
    }),
  });

  if (!res.ok) return null;
  const tokens = await res.json();

  await env.MARKETPLACE.put('twitch_broadcaster_token', JSON.stringify({
    access_token: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in * 1000),
  }), { expirationTtl: tokens.expires_in });
  if (tokens.refresh_token) {
    await env.MARKETPLACE.put('twitch_broadcaster_refresh_token', tokens.refresh_token);
  }

  return tokens.access_token;
}

export async function sendWhisper(env, toUserId, message) {
  const token = await getBotToken(env);
  if (!token) return false;

  const botUserId = env.TWITCH_BOT_USER_ID || await env.MARKETPLACE.get('twitch_bot_user_id');
  if (!botUserId) return false;

  const res = await fetch(
    `https://api.twitch.tv/helix/whispers?from_user_id=${botUserId}&to_user_id=${toUserId}`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Client-Id': env.TWITCH_CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    }
  );

  return res.ok;
}

/* Claims one code from the tier, or null when the pool is exhausted.

   This was an array plus a cursor: read gc_ptr_{tier}, read gc_{tier},
   take pool[ptr], write ptr+1. Three separate operations, so two drops
   firing together read the same cursor, handed out the SAME code twice,
   and burned one. The claim is now a single statement using FOR UPDATE
   SKIP LOCKED — concurrent claimers skip past each other's locked rows
   instead of colliding, so double-issuance cannot be expressed.

   Null still means "pool exhausted", so callers are unchanged. */
export async function pullGiveawayCode(env, rarity) {
  return env.MARKETPLACE.pullGiveawayCode(rarity || 'common');
}

/* ── Cooldowns ─────────────────────────────────
   Cloudflare KV rejects any expirationTtl under 60 seconds, but several
   cooldowns here are shorter than that (15s, 5s) — so the gate can't rely
   on the KV entry's own expiry to define "still cooling down." Instead,
   store a timestamp with a storage TTL long enough to satisfy KV's floor
   (at least 60s, or the cooldown itself if that's longer), and compare
   elapsed time in code. Returns false if still within `seconds` of the
   last call. */
async function checkAndSetCooldown(env, key, seconds) {
  const existing = await env.MARKETPLACE.get(key, 'json');
  if (existing && Date.now() - existing.at < seconds * 1000) return false;
  await env.MARKETPLACE.put(key, JSON.stringify({ at: Date.now() }), { expirationTtl: Math.max(seconds, 60) });
  return true;
}

/* ── Action log — feeds the control panel ─────── */
export async function logBotAction(env, entry) {
  const stamped = { ...entry, at: Date.now() };
  const log = await env.MARKETPLACE.get(ACTION_LOG_KEY, 'json') || [];
  log.unshift(stamped);
  if (log.length > ACTION_LOG_MAX) log.length = ACTION_LOG_MAX;
  await env.MARKETPLACE.put(ACTION_LOG_KEY, JSON.stringify(log), { expirationTtl: ACTION_LOG_TTL });

  /* Mirror into the activity feed so it shows the whole picture — the events
     viewers caused AND the drops/announcements the bot sent back. Best-effort:
     a feed write must never break the action it is recording. */
  try {
    const { recordActivity } = await import('../activity.js');
    let summary;
    if (entry.type === 'drop') summary = `${entry.actor || 'someone'} dropped a ${entry.rarity || ''} code`.trim();
    else if (entry.type === 'giveaway-winner') summary = `${entry.username || 'someone'} picked as giveaway winner`;
    else if (entry.type === 'giveaway-code') summary = `Prize code sent to ${entry.username || 'someone'}`;
    else summary = `${entry.actor || 'bot'}: ${entry.message || entry.type || 'action'}`.slice(0, 160);
    await recordActivity(env, { category: 'bot', type: entry.type || 'action', summary, payload: stamped });
  } catch (err) { console.error('[send-chat] activity record failed:', err.message); }
}

export async function getBotActionLog(env) {
  return await env.MARKETPLACE.get(ACTION_LOG_KEY, 'json') || [];
}

/* ── Shared actions — used by both commands.js
   (chat-triggered) and trigger.js (panel-triggered) ── */

export const MAX_DROP_COUNT = 10;

/**
 * Drop one or more giveaway codes.
 *
 * ONE MESSAGE PER CODE, not one message listing several. A line carrying
 * four codes is one thing to miss: it scrolls past as a single unit, and a
 * viewer who was typing when it landed has lost all four. Separate messages
 * each get their own moment in chat, and with a moderator bot at 100
 * messages per 30 seconds there is no reason to economise.
 *
 * `count` consumes ONE cooldown for the whole action rather than one per
 * code — the gate exists to stop a held button draining a pool, and a
 * deliberate request for five codes is a single decision.
 *
 * @param {object} [opts]
 * @param {number} [opts.count]    how many codes, 1..MAX_DROP_COUNT
 * @param {string} [opts.headline] why it fired, for milestone drops
 */
export async function dropCodeAction(env, rarity, actorLabel, opts = {}) {
  const tier = (rarity || '').toLowerCase();
  const info = TIER_INFO[tier];
  if (!info) {
    return { success: false, error: `Unknown rarity "${rarity}". Use common, uncommon, rare, or mythic.` };
  }

  /* Anything unusable means ONE, never the maximum. Infinity survives a
     plain min/max and comes out as 10 — and a broken caller that asks for
     "as many as possible" should not be handed the most expensive answer. */
  const asked = Number(opts.count);
  const requested = Number.isFinite(asked)
    ? Math.max(1, Math.min(MAX_DROP_COUNT, Math.floor(asked)))
    : 1;

  const canProceed = await checkAndSetCooldown(env, 'bot_cooldown_drop', DROP_COOLDOWN_SECONDS);
  if (!canProceed) {
    return { success: false, error: 'Drop is on cooldown — try again in a moment.' };
  }

  /* Pull everything first. A pool that runs dry midway then yields fewer
     codes than asked for, which is reported rather than passed off as the
     number requested — "I asked for five and got three" is only confusing
     if nothing says so. */
  const codes = [];
  for (let i = 0; i < requested; i++) {
    const code = await pullGiveawayCode(env, tier);
    if (!code) break;
    codes.push(code);
  }

  if (codes.length === 0) {
    return { success: false, error: `No codes left in the ${tier} pool.` };
  }

  /* Register before announcing. Announce-then-register would leave a window
     where the fastest viewer in chat gets "that code is not valid", which is
     the worst possible first impression of a drop. */
  const { registerDropCode } = await import('../giveaway-entries.js');
  for (const code of codes) {
    await registerDropCode(env, code, tier, info.entries, { source: 'manual' });
  }

  /* Optional headline so a milestone drop can say WHY it fired — "thanks for
     the sub" reads very differently from a bare BONUS DROP, and the reason is
     the whole point of tying a drop to an event. Only milestone drops
     (sub/giftsub/raid, in milestones.js) ever pass one; a manual drop from
     the bot control panel gets the terse code-only line instead. */
  const rarityLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  let sentCount = 0;
  for (const code of codes) {
    const msg = opts.headline
      ? `${info.emoji} ${opts.headline.slice(0, 120)} ${info.emoji} ${tier.toUpperCase()} code: ${code} — ` +
        `${info.entries} bonus entries! Claim at phantomace.tv/giveaway (Twitch login required) — expires in 5 min!`
      : `${rarityLabel} - ${code} phantomace.tv/giveaway`;
    if (await sendChatMessage(env, msg)) sentCount++;
  }

  await logBotAction(env, {
    type: 'drop',
    rarity: tier,
    code: codes.join(', '),
    count: codes.length,
    actor: actorLabel || 'unknown',
    sent: sentCount === codes.length,
  });

  return {
    success: true,
    rarity: tier,
    code: codes[0],
    codes,
    requested,
    /* Told plainly when the pool could not cover the request. */
    short: codes.length < requested ? requested - codes.length : 0,
    sent: sentCount === codes.length,
    sentCount,
    expiresAt: Date.now() + (CODE_EXPIRY_SECONDS * 1000),
  };
}

/* Drops an item code — either a specific one (`code` given) or the next
   one waiting in cosmetics' item-code queue. Activates it for a 5-minute
   window, exactly like a giveaway code drop, then posts it to chat. The
   redemption/grant logic itself lives entirely in item-codes.js — this
   only triggers activation and announces it. */
export async function dropItemAction(env, code, actorLabel) {
  const canProceed = await checkAndSetCooldown(env, 'bot_cooldown_dropitem', DROPITEM_COOLDOWN_SECONDS);
  if (!canProceed) {
    return { success: false, error: 'Item drop is on cooldown — try again in a few seconds.' };
  }

  const record = code
    ? await activateItemCode(env, code, ITEM_CODE_DURATION_SECONDS)
    : await activateNextItemCode(env, ITEM_CODE_DURATION_SECONDS);

  if (!record) {
    return { success: false, error: code ? `Code "${code}" not found.` : 'No item codes queued.' };
  }

  const msg = `🎁 ITEM DROP! 🎁 ${record.item.rarity.toUpperCase()} — ${record.item.name} ` +
    `— code: ${record.code} — redeem at phantomace.tv/redeem.html — expires in 5 min!`;

  /* Item and egg codes never touched the live feed, because they go through
     activateItemCode rather than registerDropCode. Same problem, different
     path: dropped in chat, invisible on the site. Recorded before the send,
     so the page cannot be behind chat. */
  const { recordLiveDrop } = await import('../giveaway-entries.js');
  await recordLiveDrop(env, {
    kind: 'item',
    code: record.code,
    rarity: record.item.rarity,
    itemName: record.item.name,
    source: 'manual',
    expiresAt: record.expiresAt,
    redeemPath: '/redeem',
  });

  const sent = await sendChatMessage(env, msg);

  await logBotAction(env, {
    type: 'dropitem',
    rarity: record.item.rarity,
    code: record.code,
    itemName: record.item.name,
    actor: actorLabel || 'unknown',
    sent,
  });

  return { success: true, code: record.code, item: record.item, sent, expiresAt: record.expiresAt };
}

/* ── DROP A DINO EGG ─────────────────────────────────────────────────────
   Nothing drops dino eggs today. The giveaway drops give ENTRY codes, and
   the item-code queue only hands out codes somebody created beforehand — so
   putting an egg in chat meant running a script on the rig.

   This mints one on demand and hands it straight to dropItemAction, which
   already owns the cooldown, the five-minute activation, the chat message
   and the action log. Minting a fresh code per drop rather than drawing from
   a pool is right here: an egg code is not a scarce pre-printed thing like a
   giveaway code, and a pool would just be one more thing to keep stocked. */
const EGG_RARITIES = ['common', 'uncommon', 'rare', 'mythic'];

export async function dropEggAction(env, rarity, actorLabel, opts = {}) {
  const r = String(rarity || 'common').toLowerCase();
  if (!EGG_RARITIES.includes(r)) {
    return { success: false, error: `Rarity must be one of: ${EGG_RARITIES.join(', ')}` };
  }
  const mutation = !!opts.mutation;

  const cap = r.charAt(0).toUpperCase() + r.slice(1);
  const name = mutation ? `${cap} Mutation Dino Egg` : `${cap} Dino Egg`;

  const { createItemCode } = await import('../item-codes.js');
  let record;
  try {
    /* Public: no restrictedTo. A code in chat is meant for whoever reads it,
       once each — the same contract as every other drop. */
    record = await createItemCode(env, {
      id: mutation ? 'dino_egg_mutation' : `dino_egg_${r}`,
      game: 'dino-park',
      type: 'egg',
      name,
      rarity: r,
      consumable: true,
      quantity: 1,
      guaranteedMutation: mutation,
    });
  } catch (err) {
    return { success: false, error: `Could not create the egg code: ${err.message}` };
  }

  /* If the drop is refused past this point — cooldown, most likely — the
     code exists but was never announced. Harmless: it is inactive, nobody
     has seen it, and it cannot be redeemed. Said out loud because an unused
     row appearing in item_codes otherwise looks like a leak. */
  return await dropItemAction(env, record.code, actorLabel);
}

export async function announceAction(env, message, actorLabel) {
  const text = (message || '').trim();
  if (!text) return { success: false, error: 'Announcement message is empty.' };
  if (text.length > ANNOUNCE_MAX_LENGTH) {
    return { success: false, error: `Announcement too long (max ${ANNOUNCE_MAX_LENGTH} characters).` };
  }

  const canProceed = await checkAndSetCooldown(env, 'bot_cooldown_announce', ANNOUNCE_COOLDOWN_SECONDS);
  if (!canProceed) {
    return { success: false, error: 'Announcements are on cooldown — try again in a few seconds.' };
  }

  const sent = await sendChatMessage(env, text);

  await logBotAction(env, {
    type: 'announce',
    message: text,
    actor: actorLabel || 'unknown',
    sent,
  });

  return { success: true, message: text, sent };
}
