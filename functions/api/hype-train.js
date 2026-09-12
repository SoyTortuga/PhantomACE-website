/* ══════════════════════════════════════════════
   HYPE TRAIN API
   EventSub webhook for hype train events
   Posts giveaway codes in chat at level thresholds
   + GET endpoint for live hype train state
   ══════════════════════════════════════════════ */

import { pullGiveawayCode, getBotToken, sendChatMessage } from './bot/send-chat.js';

const HMAC_PREFIX = 'sha256=';
const TWITCH_MESSAGE_ID = 'twitch-eventsub-message-id';
const TWITCH_MESSAGE_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const TWITCH_MESSAGE_SIGNATURE = 'twitch-eventsub-message-signature';
const TWITCH_MESSAGE_TYPE = 'twitch-eventsub-message-type';

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

async function verifySignature(secret, request, body) {
  const msgId = request.headers.get(TWITCH_MESSAGE_ID) || '';
  const timestamp = request.headers.get(TWITCH_MESSAGE_TIMESTAMP) || '';
  const expected = request.headers.get(TWITCH_MESSAGE_SIGNATURE) || '';

  const message = msgId + timestamp + body;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return expected === HMAC_PREFIX + hex;
}

async function handleHypeTrainProgress(env, event) {
  const level = event.level;
  const reward = LEVEL_REWARDS[level];
  if (!reward) return;

  const stateKey = 'hype_train_active';
  const state = await env.MARKETPLACE.get(stateKey, 'json') || { id: null, droppedLevels: [] };

  if (state.id === event.id && state.droppedLevels.includes(level)) return;

  const codes = [];
  for (let i = 0; i < reward.count; i++) {
    const code = await pullGiveawayCode(env, reward.rarity);
    if (code) codes.push(code);
  }
  if (codes.length === 0) return;

  state.id = event.id;
  if (!state.droppedLevels.includes(level)) state.droppedLevels.push(level);
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

  const codeList = codes.join(' | ');
  const plural = codes.length > 1 ? 'codes' : 'code';
  const msg = `${reward.emoji} HYPE TRAIN LEVEL ${level}! ${reward.emoji} ` +
    `${codes.length} bonus ${plural}: ${codeList} — ` +
    `${reward.entries} bonus entries each! ` +
    `Paste into the Gleam giveaway at phantomace.tv/giveaway — expires in 5 min!`;

  await sendChatMessage(env, msg);
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
  await env.MARKETPLACE.delete('hype_train_drops');

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
    const drops = await env.MARKETPLACE.get('hype_train_drops', 'json') || [];
    const now = Date.now();
    const active = drops.filter(d => d.expiresAt > now);
    return json({ drops: active });
  }

  return json({ error: 'Invalid action' }, 400);
}

/* ── POST — Twitch EventSub webhook ─────────── */

export async function onRequestPost(context) {
  const { env, request } = context;

  const bodyText = await request.text();
  const messageType = request.headers.get(TWITCH_MESSAGE_TYPE);

  const secret = env.TWITCH_EVENTSUB_SECRET;
  if (secret) {
    const valid = await verifySignature(secret, request, bodyText);
    if (!valid) return new Response('Invalid signature', { status: 403 });
  }

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
