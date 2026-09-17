/* ══════════════════════════════════════════════
   GIVEAWAY CONTROL
   Broadcaster or an allowlisted moderator: open/close a giveaway's channel
   points entry reward, spin for a winner from the entrants captured by
   giveaway-entry.js, then hand the winner a prize code locked to them.

   A DRAW HAS A RARITY. Opening entries picks Rare or Mythic, which decides
   three things at once: which channel points reward is switched on, which
   redemptions count as entries, and what the winner's code is worth. They
   were all separate before, which is how a Mythic draw could hand out a
   common code.
   ══════════════════════════════════════════════ */

import { pullGiveawayCode, sendWhisper, getBroadcasterToken, logBotAction, TIER_INFO } from './send-chat.js';

const ENTRANTS_KEY = 'giveaway_entrants';
const STATE_KEY = 'giveaway_state';
const WINNER_KEY = 'giveaway_winner';
const CODE_MAX_LENGTH = 60;
const STATE_TTL = 86400;

/* The entry reward per rarity. Resolved BY TITLE and then cached, rather
   than created and recorded by the admin page: these two were made by
   server/scripts/giveaway-rewards.js, which needs nobody signed in, so
   there is no step that would have written an id here. Looking the title up
   once and caching the answer means the panel works the first time it is
   opened, on whichever machine. */
export const RARITY_REWARDS = {
  rare:   { title: 'Enter Rare Giveaway',   idKey: 'giveaway_reward_rare_id',   colour: '#c7a550' },
  mythic: { title: 'Enter Mythic Giveaway', idKey: 'giveaway_reward_mythic_id', colour: '#eb6726' },
};

export const RARITIES = Object.keys(RARITY_REWARDS);

/**
 * The channel points reward id for a draw's rarity.
 *
 * A null/unknown rarity means the legacy "Enter Giveaway" reward, whose id
 * the admin page stored when it created it.
 */
async function resolveRewardId(env, rarity) {
  const spec = RARITY_REWARDS[rarity];
  if (!spec) return await env.MARKETPLACE.get('giveaway_reward_id');

  const cached = await env.MARKETPLACE.get(spec.idKey);
  if (cached) return cached;

  const token = await getBroadcasterToken(env);
  if (!token) return null;

  /* only_manageable_rewards, because a reward this app did not create
     cannot be switched on or off by it whatever we do — so a match against
     one would produce a reward id that fails at the PATCH instead of here,
     where the error can name the fix. */
  const res = await fetch(
    `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${env.TWITCH_BROADCASTER_ID}&only_manageable_rewards=true`,
    { headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': env.TWITCH_CLIENT_ID } }
  );
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  const wanted = spec.title.toLowerCase();
  const hit = (data && Array.isArray(data.data) ? data.data : [])
    .find(r => String(r.title || '').trim().toLowerCase() === wanted);
  if (!hit) return null;

  await env.MARKETPLACE.put(spec.idKey, hit.id);
  return hit.id;
}

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

async function setRewardEnabled(env, enabled, rarity = null) {
  const rewardId = await resolveRewardId(env, rarity);
  if (!rewardId) {
    const spec = RARITY_REWARDS[rarity];
    return {
      ok: false,
      error: spec
        ? `No "${spec.title}" reward found on the channel. Create it with: node server/scripts/giveaway-rewards.js --service phantomace-web --create --confirm`
        : 'No giveaway reward configured yet — set it up in /api/admin/bot-setup first.',
    };
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
  /* What each rarity is worth, so the panel can say "Mythic — 50 entries"
     instead of making a moderator remember the table. */
  const rarities = RARITIES.map(r => ({
    rarity: r,
    title: RARITY_REWARDS[r].title,
    colour: RARITY_REWARDS[r].colour,
    entries: (TIER_INFO[r] || {}).entries || 0,
  }));

  return json({
    open: !!state.open,
    rarity: state.rarity || null,
    rarities,
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

    /* Opening needs a rarity; closing reuses whatever is open, so a moderator
       cannot close a Mythic draw by switching off the Rare reward. */
    const prev = await env.MARKETPLACE.get(STATE_KEY, 'json') || {};
    const rarity = open
      ? String(body.rarity || '').toLowerCase()
      : (prev.rarity || null);

    if (open && !RARITY_REWARDS[rarity]) {
      return json({ error: `Pick a rarity for this draw: ${RARITIES.join(' or ')}.` }, 400);
    }

    /* AN UNDELIVERED WINNER BLOCKS THE NEXT DRAW.
       Opening entries clears the previous winner, which was harmless while a
       winner was only a name on a screen. It is not harmless now: the prize
       code is pulled at send-code time, so reopening before sending destroys
       a real win silently and the pool never even notices. Refusing names
       the two ways out, both one click away. Checked before the reward is
       switched on, so a refused open leaves the channel exactly as it was. */
    if (open) {
      const pending = await env.MARKETPLACE.get(WINNER_KEY, 'json');
      if (pending && !pending.sent) {
        return json({
          error: `${pending.username} won the last draw and has not been given a code yet. Send the code first, or Reset to discard that draw.`,
        }, 409);
      }
    }

    const result = await setRewardEnabled(env, open, rarity);
    if (!result.ok) return json({ error: result.error }, 400);

    /* ONE DRAW AT A TIME. Opening Rare switches Mythic off, so the two entry
       rewards can never both be redeemable — which would let a viewer pay
       into a draw that is not running and sit on a wheel they are not on.
       Failure here is reported but does not undo the open: a stray enabled
       reward is caught by the rarity check in addEntrant, and refusing to
       open a draw because the OTHER reward would not switch off is the worse
       outcome on a live stream. */
    let strays = [];
    if (open) {
      for (const other of RARITIES) {
        if (other === rarity) continue;
        const off = await setRewardEnabled(env, false, other);
        if (!off.ok) strays.push(RARITY_REWARDS[other].title);
      }
    }

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

    await env.MARKETPLACE.put(STATE_KEY, JSON.stringify({ open, rarity, changedAt: Date.now() }), { expirationTtl: STATE_TTL });
    return json({ success: true, open, rarity, clearedPrevious, strays });
  }

  if (body.action === 'pick-winner') {
    /* Flat pick, one chance per person, over THIS EVENT's entrants.
       Not the monthly ledger and not weighted: the wheel is for a live
       spin among the people who just entered, and everyone on screen has
       exactly one slice. Weighting would also make the wheel lie, since a
       slice's size is what a viewer reads as their odds. */
    const state = await env.MARKETPLACE.get(STATE_KEY, 'json') || {};
    const rec = await env.MARKETPLACE.get(ENTRANTS_KEY, 'json');
    const pool = (rec && Array.isArray(rec.entrants) ? rec.entrants : [])
      .map(e => ({ userId: e.userId, username: e.username }));

    if (pool.length === 0) {
      return json({ error: 'Nobody has entered yet. Open entries and let chat redeem first.' }, 400);
    }

    const winnerIndex = Math.floor(Math.random() * pool.length);
    const chosen = pool[winnerIndex];

    const entrants = pool;
    /* The rarity is stamped on the winner, not read again at send-code time.
       Between picking and sending, a moderator may well have reopened
       entries for the next draw — and the prize belongs to the draw that was
       actually won. */
    const winner = {
      userId: chosen.userId,
      username: chosen.username,
      rarity: state.rarity || null,
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
      rarity: winner.rarity,
      winnerIndex,
      entrants: entrants.map(publicEntrant),
    });
  }

  if (body.action === 'send-code') {
    const winner = await env.MARKETPLACE.get(WINNER_KEY, 'json');
    if (!winner) return json({ error: 'No winner picked yet.' }, 400);
    if (winner.sent) return json({ error: 'A code was already sent to this winner.' }, 400);

    /* The draw's own rarity, not one chosen at send time. An explicit
       body.rarity still wins so a moderator can hand out something else
       deliberately, but the default is the draw that was actually run. */
    const tier = String(body.rarity || winner.rarity || 'common').toLowerCase();
    if (!TIER_INFO[tier]) return json({ error: `Unknown rarity "${tier}".` }, 400);

    let code = (body.code || '').trim();
    if (!code) code = await pullGiveawayCode(env, tier);
    if (!code) return json({ error: `No codes left in the ${tier} pool.` }, 400);
    if (code.length > CODE_MAX_LENGTH) return json({ error: 'Code is too long.' }, 400);

    /* REGISTER IT, THEN TELL THEM. This is the half that was missing: the
       code was pulled from the pool and whispered, and nothing ever made it
       claimable — so the winner pasted a real code into the box on the
       giveaway page and was told it was not valid.

       Locked to the winner and good for a week, because a prize is not a
       race. */
    const { registerDropCode, recordPrize, PRIZE_WINDOW_SECONDS } = await import('../giveaway-entries.js');
    const entries = (TIER_INFO[tier] || {}).entries || 0;
    await registerDropCode(env, code, tier, entries, {
      source: 'giveaway-win',
      lockedTo: winner.userId,
      ttlSeconds: PRIZE_WINDOW_SECONDS,
      announce: false,
    });
    const prize = await recordPrize(env, winner.userId, { code, tier, entries });

    /* The whisper is now a courtesy, not the delivery mechanism. Twitch
       silently drops whispers from an account the recipient has never
       messaged, which used to mean the prize simply vanished; the card on
       /giveaway is the delivery, and it does not depend on Twitch. */
    const message = `🏆 You won the ${tier.toUpperCase()} giveaway! Your code: ${code} — it is locked to your account and waiting on phantomace.tv/giveaway for 7 days. Congrats!`;
    const sent = await sendWhisper(env, winner.userId, message);

    winner.sent = true;
    winner.whispered = sent;
    winner.code = code;
    winner.rarity = tier;
    winner.sentAt = Date.now();
    await env.MARKETPLACE.put(WINNER_KEY, JSON.stringify(winner), { expirationTtl: STATE_TTL });

    await logBotAction(env, {
      type: 'giveaway-code',
      username: winner.username,
      rarity: tier,
      code,
      actor: session.display_name || 'broadcaster',
      sent,
    });

    return json({
      success: true,
      sent: true,
      whispered: sent,
      rarity: tier,
      entries,
      expiresAt: prize ? prize.expiresAt : null,
      winner: { ...publicEntrant(winner), sent: true, sentAt: winner.sentAt },
    });
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
