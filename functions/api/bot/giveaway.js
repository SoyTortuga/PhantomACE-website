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

  /* THE WHEEL SPINS OVER THIS EVENT'S ENTRANTS, NOT THE MONTH.
     This read used to come from the monthly ledger, which made a
     spontaneous on-stream spin draw from every entry accumulated since the
     1st — including people who were not watching. The Big Prize giveaway is
     an event: open entries, let chat redeem, spin, hand over a code, reset. */
  const rec = await env.MARKETPLACE.get(ENTRANTS_KEY, 'json');
  const entrants = (rec && Array.isArray(rec.entrants) ? rec.entrants : [])
    .map(e => ({ userId: e.userId, username: e.username }));

  /* No monthly totals here. The two giveaways share no entries — codes feed
     the month, channel points feed this event — and the dashboard already
     shows the monthly ledger in its own card. Repeating it inside the event
     panel is what made them look like one system in the first place. */
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

    /* OPENING AFTER A DRAW STARTS A NEW EVENT.
       mutate() writes no expiry, so the entrant list persists until it is
       cleared — which is right while an event is running, and wrong the
       next time entries open, when last week's entrants would be on the
       wheel. Keyed on a winner already existing, so closing and reopening
       to pause mid-event keeps everyone; opening after you have drawn and
       handed out a code starts clean. Reset clears it explicitly either
       way. */
    let clearedPrevious = false;
    if (open) {
      const previousWinner = await env.MARKETPLACE.get(WINNER_KEY, 'json');
      if (previousWinner) {
        await env.MARKETPLACE.delete(WINNER_KEY);
        await env.MARKETPLACE.delete(ENTRANTS_KEY);
        clearedPrevious = true;
      }
    }

    await env.MARKETPLACE.put(STATE_KEY, JSON.stringify({ open, changedAt: Date.now() }), { expirationTtl: STATE_TTL });
    return json({ success: true, open, clearedPrevious });
  }

  if (body.action === 'pick-winner') {
    /* Flat pick, one chance per person, over THIS EVENT's entrants.
       Not the monthly ledger and not weighted: the wheel is for a live
       spin among the people who just entered, and everyone on screen has
       exactly one slice. Weighting would also make the wheel lie, since a
       slice's size is what a viewer reads as their odds. */
    const rec = await env.MARKETPLACE.get(ENTRANTS_KEY, 'json');
    const pool = (rec && Array.isArray(rec.entrants) ? rec.entrants : [])
      .map(e => ({ userId: e.userId, username: e.username }));

    if (pool.length === 0) {
      return json({ error: 'Nobody has entered yet. Open entries and let chat redeem first.' }, 400);
    }

    const winnerIndex = Math.floor(Math.random() * pool.length);
    const chosen = pool[winnerIndex];

    const entrants = pool;
    const winner = {
      userId: chosen.userId,
      username: chosen.username,
      entrantCount: pool.length,
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
    /* Clears THIS EVENT: the winner and the session entrant list, so the
       next spin starts empty.

       It deliberately does NOT touch the monthly entry ledger. That is a
       whole month of entries people earned by watching, redeeming drops and
       claiming Phamily Time rewards, and one click of a button labelled
       "reset" should not be able to destroy it. A month rolls over on its
       own because the ledger is keyed by month; if one genuinely needs
       clearing, that is a deliberate database operation, not a panel
       button. */
    await env.MARKETPLACE.delete(WINNER_KEY);
    await env.MARKETPLACE.delete(ENTRANTS_KEY);
    return json({ success: true, note: 'Event cleared. Monthly giveaway entries are untouched.' });
  }

  return json({ error: 'Invalid action' }, 400);
}
