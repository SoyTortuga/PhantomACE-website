/* ══════════════════════════════════════════════
   GIVEAWAY CONTROL
   Broadcaster-only: open/close the "Enter Giveaway"
   channel points reward, spin for a winner from the
   entrants captured by giveaway-entry.js, then
   whisper the winner their prize code.
   ══════════════════════════════════════════════ */

import { pullGiveawayCode, sendWhisper, getBroadcasterToken, logBotAction } from './send-chat.js';

const ENTRANTS_KEY = 'giveaway_entrants';
const STATE_KEY = 'giveaway_state';
const WINNER_KEY = 'giveaway_winner';
const CODE_MAX_LENGTH = 60;
const STATE_TTL = 86400;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function publicEntrant(e) {
  return { userId: e.userId, username: e.username };
}

async function setRewardEnabled(env, enabled) {
  const rewardId = await env.MARKETPLACE.get('giveaway_reward_id');
  if (!rewardId) {
    return { ok: false, error: 'No giveaway reward configured yet — set it up in /api/admin/bot-setup first.' };
  }

  const token = await getBroadcasterToken(env);
  if (!token) {
    return { ok: false, error: 'Broadcaster channel-points authorization missing — re-authorize in bot setup.' };
  }

  const res = await fetch(
    `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${env.TWITCH_BROADCASTER_ID}&id=${rewardId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Client-Id': env.TWITCH_CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_enabled: enabled }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, error: err.message || 'Twitch API error toggling the reward.' };
  }
  return { ok: true };
}

/* ── GET — current giveaway state for the panel ── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || session.role !== 'broadcaster') {
    return json({ error: 'Broadcaster only' }, 403);
  }

  const state = await env.MARKETPLACE.get(STATE_KEY, 'json') || { open: false };
  const entrants = await env.MARKETPLACE.get(ENTRANTS_KEY, 'json') || [];
  const winner = await env.MARKETPLACE.get(WINNER_KEY, 'json') || null;
  const rewardId = await env.MARKETPLACE.get('giveaway_reward_id');

  return json({
    open: !!state.open,
    entrants: entrants.map(publicEntrant),
    entrantCount: entrants.length,
    winner,
    rewardConfigured: !!rewardId,
  });
}

/* ── POST — toggle / pick-winner / send-code / reset ── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || session.role !== 'broadcaster') {
    return json({ error: 'Broadcaster only' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'toggle') {
    const open = !!body.open;
    const result = await setRewardEnabled(env, open);
    if (!result.ok) return json({ error: result.error }, 400);

    await env.MARKETPLACE.put(STATE_KEY, JSON.stringify({ open, changedAt: Date.now() }), { expirationTtl: STATE_TTL });
    return json({ success: true, open });
  }

  if (body.action === 'pick-winner') {
    const entrants = await env.MARKETPLACE.get(ENTRANTS_KEY, 'json') || [];
    if (entrants.length === 0) return json({ error: 'No entrants yet.' }, 400);

    const winnerIndex = Math.floor(Math.random() * entrants.length);
    const winner = { ...entrants[winnerIndex], pickedAt: Date.now(), sent: false };
    await env.MARKETPLACE.put(WINNER_KEY, JSON.stringify(winner), { expirationTtl: STATE_TTL });

    await logBotAction(env, {
      type: 'giveaway-winner',
      username: winner.username,
      actor: session.display_name || 'broadcaster',
    });

    return json({
      success: true,
      winner: publicEntrant(winner),
      winnerIndex,
      entrants: entrants.map(publicEntrant),
    });
  }

  if (body.action === 'send-code') {
    const winner = await env.MARKETPLACE.get(WINNER_KEY, 'json');
    if (!winner) return json({ error: 'No winner picked yet.' }, 400);
    if (winner.sent) return json({ error: 'A code was already sent to this winner.' }, 400);

    let code = (body.code || '').trim();
    if (!code && body.rarity) {
      code = await pullGiveawayCode(env, body.rarity);
    }
    if (!code) return json({ error: 'No code to send — provide one, or pick a tier that still has codes left.' }, 400);
    if (code.length > CODE_MAX_LENGTH) return json({ error: 'Code is too long.' }, 400);

    const message = `🏆 You won the giveaway! Your prize code: ${code} — keep it safe and follow the redemption instructions on stream. Congrats!`;
    const sent = await sendWhisper(env, winner.userId, message);

    winner.sent = sent;
    winner.code = code;
    winner.sentAt = Date.now();
    await env.MARKETPLACE.put(WINNER_KEY, JSON.stringify(winner), { expirationTtl: STATE_TTL });

    await logBotAction(env, {
      type: 'giveaway-code',
      username: winner.username,
      code,
      actor: session.display_name || 'broadcaster',
      sent,
    });

    return json({ success: true, sent, winner: { ...publicEntrant(winner), sent, sentAt: winner.sentAt } });
  }

  if (body.action === 'reset') {
    await env.MARKETPLACE.delete(ENTRANTS_KEY);
    await env.MARKETPLACE.delete(WINNER_KEY);
    return json({ success: true });
  }

  return json({ error: 'Invalid action' }, 400);
}
