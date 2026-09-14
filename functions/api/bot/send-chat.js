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

const DROP_COOLDOWN_SECONDS = 15;
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
     deal for a bot account that is not a moderator — and every drop message
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
  const log = await env.MARKETPLACE.get(ACTION_LOG_KEY, 'json') || [];
  log.unshift({ ...entry, at: Date.now() });
  if (log.length > ACTION_LOG_MAX) log.length = ACTION_LOG_MAX;
  await env.MARKETPLACE.put(ACTION_LOG_KEY, JSON.stringify(log), { expirationTtl: ACTION_LOG_TTL });
}

export async function getBotActionLog(env) {
  return await env.MARKETPLACE.get(ACTION_LOG_KEY, 'json') || [];
}

/* ── Shared actions — used by both commands.js
   (chat-triggered) and trigger.js (panel-triggered) ── */

export async function dropCodeAction(env, rarity, actorLabel) {
  const tier = (rarity || '').toLowerCase();
  const info = TIER_INFO[tier];
  if (!info) {
    return { success: false, error: `Unknown rarity "${rarity}". Use common, uncommon, rare, or mythic.` };
  }

  const canProceed = await checkAndSetCooldown(env, 'bot_cooldown_drop', DROP_COOLDOWN_SECONDS);
  if (!canProceed) {
    return { success: false, error: 'Drop is on cooldown — try again in a few seconds.' };
  }

  const code = await pullGiveawayCode(env, tier);
  if (!code) {
    return { success: false, error: `No codes left in the ${tier} pool.` };
  }

  /* Register it before announcing it. Announce-then-register would leave a
     window where the fastest viewer in chat gets "that code is not valid",
     which is the worst possible first impression of a drop. */
  const { registerDropCode } = await import('../giveaway-entries.js');
  await registerDropCode(env, code, tier, info.entries);

  const msg = `${info.emoji} BONUS DROP! ${info.emoji} ${tier.toUpperCase()} code: ${code} — ` +
    `${info.entries} bonus entries! Claim at phantomace.tv/giveaway (Twitch login required) — expires in 5 min!`;

  const sent = await sendChatMessage(env, msg);

  await logBotAction(env, {
    type: 'drop',
    rarity: tier,
    code,
    actor: actorLabel || 'unknown',
    sent,
  });

  return { success: true, rarity: tier, code, sent, expiresAt: Date.now() + (CODE_EXPIRY_SECONDS * 1000) };
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
