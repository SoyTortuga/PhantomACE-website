/* ══════════════════════════════════════════════
   GIVEAWAY CONTROL
   Broadcaster or an allowlisted moderator: open/close the "Enter Giveaway"
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
  /* Moderators may drop codes. Checked against the allowlist rather than
     the cookie's role field, so removing someone takes effect immediately
     instead of when their session happens to expire. */
  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  const state = await env.MARKETPLACE.get(STATE_KEY, 'json') || { open: false };
  const winner = await env.MARKETPLACE.get(WINNER_KEY, 'json') || null;
  const rewardId = await env.MARKETPLACE.get('giveaway_reward_id');

  /* Read the monthly ledger, not the retired giveaway_entrants array. That
     key is no longer written, so reading it here would have shown the
     broadcaster zero entrants however many people had entered. */
  const { monthKey } = await import('../giveaway-entries.js');
  const month = monthKey();
  const rows = await env.MARKETPLACE.listValues({ prefix: 'gwe_' });

  const entrants = [];
  let totalEntries = 0;
  for (const { value } of rows) {
    if (!value || value.month !== month) continue;
    const n = Math.floor(Number(value.entries || 0));
    if (n <= 0) continue;
    entrants.push({ userId: value.userId, username: value.username, entries: n });
    totalEntries += n;
  }
  entrants.sort((a, b) => b.entries - a.entries);

  return json({
    open: !!state.open,
    month,
    entrants: entrants.map(publicEntrant),
    entrantCount: entrants.length,
    totalEntries,
    winner,
    rewardConfigured: !!rewardId,
  });
}

/* ── POST — toggle / pick-winner / send-code / reset ── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  /* Moderators may drop codes. Checked against the allowlist rather than
     the cookie's role field, so removing someone takes effect immediately
     instead of when their session happens to expire. */
  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
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
    /* Weighted by entry count, read from the monthly ledger.
       A flat pick over one row per user would make 50 entries from a mythic
       drop worth exactly as much as a single channel-point entry, which
       would quietly make the whole entry system decorative. */
    const { monthKey } = await import('../giveaway-entries.js');
    const month = monthKey();
    const rows = await env.MARKETPLACE.listValues({ prefix: 'gwe_' });

    const pool = [];
    let totalEntries = 0;
    for (const { value } of rows) {
      if (!value || value.month !== month) continue;
      const n = Math.floor(Number(value.entries || 0));
      if (n <= 0) continue;
      pool.push({ userId: value.userId, username: value.username, entries: n });
      totalEntries += n;
    }

    if (pool.length === 0) return json({ error: 'No entrants yet this month.' }, 400);

    /* Walk the cumulative weights rather than materialising one slot per
       entry — a month of mythic drops could otherwise mean an array with
       tens of thousands of duplicated objects in it. */
    let ticket = Math.floor(Math.random() * totalEntries);
    let chosen = pool[pool.length - 1];
    for (const p of pool) {
      if (ticket < p.entries) { chosen = p; break; }
      ticket -= p.entries;
    }

    const entrants = pool;
    const winnerIndex = pool.indexOf(chosen);
    const winner = {
      userId: chosen.userId,
      username: chosen.username,
      entries: chosen.entries,
      month,
      totalEntries,
      pickedAt: Date.now(),
      sent: false,
    };
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
    /* Clears the WINNER only, so another can be drawn.

       It deliberately does NOT clear the monthly entry ledger. Reset used
       to wipe giveaway_entrants, which was a single session's worth of
       entries and cheap to lose. The ledger is a whole month of entries
       people earned by watching and redeeming drops, and one click of a
       button labelled "reset" should not be able to destroy that. A month
       rolls over on its own because the ledger is keyed by month.

       If a month genuinely needs clearing, that is a deliberate database
       operation, not a panel button. */
    await env.MARKETPLACE.delete(WINNER_KEY);
    await env.MARKETPLACE.delete(ENTRANTS_KEY);   // retired key; clear any leftover
    return json({ success: true, note: 'Winner cleared. Monthly entries are untouched.' });
  }

  return json({ error: 'Invalid action' }, 400);
}
