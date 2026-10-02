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
/* The MONTHLY-ledger draw's winner lives under its OWN key, never WINNER_KEY.
   The two draws are different events — the Big Prize is a live channel-points
   spin, the monthly draw is over the accumulated ledger — and sharing a record
   would let one draw's pending-winner guard block or clobber the other. */
const MONTHLY_WINNER_KEY = 'giveaway_monthly_winner';
const CODE_MAX_LENGTH = 60;
const STATE_TTL = 86400;

/* The DISPLAY spec per rarity — the base title, a label for the panel, and
   the colour that tells the rarities apart in a viewer's reward list. It no
   longer holds a reward id: each rarity is now a POOL of slots, so the id is
   resolved per (rarity, slot) instead of once per rarity (see slotIdKey). */
export const RARITY_REWARDS = {
  rare:   { title: 'Enter Rare Giveaway',   label: 'Rare',   colour: '#c7a550' },
  mythic: { title: 'Enter Mythic Giveaway', label: 'Mythic', colour: '#eb6726' },
};

export const RARITIES = Object.keys(RARITY_REWARDS);

/* SLOT POOL. Twitch's only per-user limiter is max_per_user_per_stream, which
   is per-reward and resets each stream — so a single Rare reward capped at one
   entry per stream could host only ONE Rare draw per stream. Each rarity is
   instead a pool of identical rewards, opened one at a time: draw two uses
   slot 2, draw three uses slot 3, and the cap holds each viewer to exactly one
   entry per slot. Slot 1 keeps the bare title and the ORIGINAL id key so
   already-cached ids and live subscriptions keep working. */
const SLOTS_PER_RARITY = 3;
const ROMAN = ['', '', 'II', 'III'];
const SLOT_CURSORS_KEY = 'giveaway_slot_cursors';

function slotTitle(rarity, slot) {
  const spec = RARITY_REWARDS[rarity];
  if (!spec) return null;
  return spec.title + (slot === 1 ? '' : ' ' + ROMAN[slot]);
}

function slotIdKey(rarity, slot) {
  return slot === 1 ? `giveaway_reward_${rarity}_id` : `giveaway_reward_${rarity}_${slot}_id`;
}

/**
 * The channel points reward id for a draw's rarity and slot.
 *
 * A null/unknown rarity means the legacy "Enter Giveaway" reward, whose id
 * the admin page stored when it created it.
 */
async function resolveRewardId(env, rarity, slot = 1) {
  const spec = RARITY_REWARDS[rarity];
  if (!spec) return await env.MARKETPLACE.get('giveaway_reward_id');

  const idKey = slotIdKey(rarity, slot);
  const cached = await env.MARKETPLACE.get(idKey);
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
  const wanted = slotTitle(rarity, slot).toLowerCase();
  const hit = (data && Array.isArray(data.data) ? data.data : [])
    .find(r => String(r.title || '').trim().toLowerCase() === wanted);
  if (!hit) return null;

  await env.MARKETPLACE.put(idKey, hit.id);
  return hit.id;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function publicEntrant(e) {
  return { userId: e.userId, username: e.username };
}

async function setRewardEnabled(env, enabled, rarity = null, slot = 1) {
  const rewardId = await resolveRewardId(env, rarity, slot);
  if (!rewardId) {
    const spec = RARITY_REWARDS[rarity];
    return {
      ok: false,
      /* notFound lets the disable-sweep skip slots that were never created —
         a non-existent slot is already "off", not a stray to report. */
      notFound: true,
      error: spec
        ? `No "${slotTitle(rarity, slot)}" reward found on the channel. Create the pool with: node server/scripts/giveaway-rewards.js --service phantomace-web --create --confirm`
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
  /* Configured if ANY entry reward id is cached: the legacy single reward, or
     either rarity's slot-1 reward. The slot pool resolves the rest by title on
     demand, so a cached slot-1 id is enough to know the rewards exist. */
  const rewardId = (await env.MARKETPLACE.get('giveaway_reward_id'))
    || (await env.MARKETPLACE.get('giveaway_reward_rare_id'))
    || (await env.MARKETPLACE.get('giveaway_reward_mythic_id'));

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

  /* The monthly-ledger draw, shown alongside the Big Prize event but entirely
     separate: its own winner record, and a live pool preview (current month's
     non-guest entry totals) so the panel can say what a draw would pull from
     WITHOUT drawing anyone — the totals are a read, the draw is a POST. */
  const { monthlyLedgerTotals, prevMonthKey } = await import('../giveaway-entries.js');
  const monthly = await monthlyLedgerTotals(env);
  /* Previous UTC month's pool, so the panel can offer "draw last month" during
     the grace window after the ledger rolls over — only worth showing when that
     month actually had entrants. */
  const monthlyPrev = await monthlyLedgerTotals(env, prevMonthKey());
  const monthlyWinner = await env.MARKETPLACE.get(MONTHLY_WINNER_KEY, 'json') || null;

  return json({
    open: !!state.open,
    rarity: state.rarity || null,
    slot: state.slot || null,
    rarities,
    entrants: entrants.map(publicEntrant),
    entrantCount: entrants.length,
    winner,
    rewardConfigured: !!rewardId,
    monthly,
    monthlyPrev,
    monthlyWinner,
    /* Whether each reveal can be replayed onto the overlay (a winner with a
       stored reel payload exists), plus who, for the Overlay Dashboard's
       "Replay last reveal" buttons to enable/label themselves. */
    replay: {
      big: winner && winner.reveal ? { who: winner.username, rarity: winner.rarity || null } : null,
      monthly: monthlyWinner && monthlyWinner.reveal ? { who: monthlyWinner.username, month: monthlyWinner.month || null } : null,
    },
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

    /* WHICH SLOT. Opening picks the next slot in the pool by round-robin, so
       two consecutive same-rarity draws in one stream land on different slots
       and each gets its own fresh per-user-per-stream cap. Closing reuses the
       slot that was actually opened, so switching a draw off never leaves the
       wrong slot redeemable. */
    let slot;
    if (open) {
      const cursors = (await env.MARKETPLACE.get(SLOT_CURSORS_KEY, 'json')) || {};
      const last = Number(cursors[rarity]) || 0;
      slot = (last % SLOTS_PER_RARITY) + 1;
    } else {
      slot = prev.slot || 1;
    }

    const result = await setRewardEnabled(env, open, rarity, slot);
    if (!result.ok) return json({ error: result.error }, 400);

    /* ONE DRAW AT A TIME. Opening a slot switches off every OTHER slot across
       ALL rarities, so at most one entry reward is ever redeemable — a viewer
       can never pay into a draw that is not running or sit on a wheel they are
       not on. Failure here is reported but does not undo the open: a stray
       enabled reward is caught by the rarity check in addEntrant, and refusing
       to open a draw because some other slot would not switch off is the worse
       outcome on a live stream. A slot that was never created reports notFound,
       not a failure — it is already off, so it is not a stray. */
    let strays = [];
    if (open) {
      for (const r of RARITIES) {
        for (let i = 1; i <= SLOTS_PER_RARITY; i++) {
          if (r === rarity && i === slot) continue;
          const off = await setRewardEnabled(env, false, r, i);
          if (!off.ok && !off.notFound) strays.push(slotTitle(r, i));
        }
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

    /* Advance the round-robin cursor only once the slot is actually open, so a
       refused open does not burn a slot number. */
    if (open) {
      const cursors = (await env.MARKETPLACE.get(SLOT_CURSORS_KEY, 'json')) || {};
      cursors[rarity] = slot;
      await env.MARKETPLACE.put(SLOT_CURSORS_KEY, JSON.stringify(cursors));
    }

    await env.MARKETPLACE.put(STATE_KEY, JSON.stringify({ open, rarity, slot, changedAt: Date.now() }), { expirationTtl: STATE_TTL });
    return json({ success: true, open, rarity, slot, clearedPrevious, strays });
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
    /* The exact overlay reel payload, stored on the winner so "Replay last
       reveal" can re-push the SAME spin later (same names, same landing row). */
    const reveal = {
      entrants: entrants.map(e => ({ username: e.username })),
      winnerIndex,
      rarity: state.rarity || null,
      who: chosen.username,
    };
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
      reveal,
    };
    await env.MARKETPLACE.put(WINNER_KEY, JSON.stringify(winner), { expirationTtl: STATE_TTL });

    await logBotAction(env, {
      type: 'giveaway-winner',
      username: winner.username,
      actor: session.display_name || 'broadcaster',
    });

    /* Puts the same spin on stream that the moderator just watched in the
       panel. Only usernames and the index the reel has to land on — nothing
       here is more than what is already on screen at the control panel. */
    const { pushOverlayEvent } = await import('../overlay/events.js');
    await pushOverlayEvent(env, { type: 'giveaway-spin', ...reveal });

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

  /* ── THE MONTHLY LEDGER DRAW ──────────────────────────────────────────
     A separate event from the Big Prize spin above: it draws over the month's
     accumulated entry ledger, WEIGHTED by entry count, and never touches the
     Big Prize keys. Re-drawing simply overwrites the monthly winner record —
     there is no pending-winner guard here, so a moderator can re-roll freely,
     and the Big Prize draw cannot be blocked by (or block) this one. */
  if (body.action === 'draw-monthly') {
    const { drawMonthlyWinner, buildWeightedReelPool, monthKey, prevMonthKey } = await import('../giveaway-entries.js');
    /* Draw the current UTC month by default. A `month` may be passed to draw the
       just-ended month during the grace window (the ledger rolls on the UTC
       calendar, so a broadcaster west of UTC crosses over while still "this
       month" locally). Restricted to current or previous month — older months
       aren't drawable from the UI to avoid re-rolling settled history by mistake. */
    const cur = monthKey(), prev = prevMonthKey();
    const month = body.month ? String(body.month) : cur;
    if (month !== cur && month !== prev) {
      return json({ error: `Only the current (${cur}) or previous (${prev}) month can be drawn here.` }, 400);
    }
    const draw = await drawMonthlyWinner(env, { month });
    if (!draw.winner) {
      return json({ error: `Nobody has entered for ${month} yet.` }, 400);
    }

    /* The prize is drawn at the grand (mythic) tier — this is the big monthly
       giveaway — but the reveal LABEL says "Monthly Giveaway" rather than a
       rarity, and send-monthly-code still lets a moderator override the tier. */
    /* The exact overlay reel payload, stored so "Replay last reveal" can
       re-push the SAME monthly spin (same bounded weighted strip, same landing
       row, same label/note) without re-drawing a different winner. */
    const reel = buildWeightedReelPool(draw.entrants, draw.winner);
    const reveal = {
      entrants: reel.pool,
      winnerIndex: reel.winnerIndex,
      rarity: 'mythic',
      who: draw.winner.username,
      label: month === prev ? `Monthly Giveaway · ${month}` : 'Monthly Giveaway',
      note: `Drawn from ${draw.totalEntries} entries across ${draw.totalPeople} ${draw.totalPeople === 1 ? 'person' : 'people'}`,
    };

    const winner = {
      userId: draw.winner.userId,
      username: draw.winner.username,
      entries: draw.winner.entries,
      month: draw.month,
      totalEntries: draw.totalEntries,
      totalPeople: draw.totalPeople,
      rarity: 'mythic',
      pickedAt: Date.now(),
      sent: false,
      reveal,
    };
    await env.MARKETPLACE.put(MONTHLY_WINNER_KEY, JSON.stringify(winner), { expirationTtl: STATE_TTL });

    await logBotAction(env, {
      type: 'giveaway-winner',
      username: winner.username,
      actor: session.display_name || 'broadcaster',
    });

    /* Put the same grand reel on stream, at mythic-tier grandeur, labelled as
       the monthly draw and noting the pool it came from. The reel pool is a
       BOUNDED, WEIGHTED, cosmetic strip — the weighted pick above is
       authoritative — and PhamReel lands it on that winner. */
    const { pushOverlayEvent } = await import('../overlay/events.js');
    await pushOverlayEvent(env, { type: 'giveaway-spin', ...reveal });

    return json({
      success: true,
      winner: { userId: winner.userId, username: winner.username, entries: winner.entries },
      totalEntries: draw.totalEntries,
      totalPeople: draw.totalPeople,
      month: draw.month,
    });
  }

  if (body.action === 'send-monthly-code') {
    const winner = await env.MARKETPLACE.get(MONTHLY_WINNER_KEY, 'json');
    if (!winner) return json({ error: 'No monthly winner drawn yet.' }, 400);
    if (winner.sent) return json({ error: 'A code was already sent to this monthly winner.' }, 400);

    /* Defaults to the draw's tier (mythic), but a moderator can hand out a
       different tier deliberately — same shape as the Big Prize send-code. */
    const tier = String(body.rarity || winner.rarity || 'mythic').toLowerCase();
    if (!TIER_INFO[tier]) return json({ error: `Unknown rarity "${tier}".` }, 400);

    let code = (body.code || '').trim();
    if (!code) code = await pullGiveawayCode(env, tier);
    if (!code) return json({ error: `No codes left in the ${tier} pool.` }, 400);
    if (code.length > CODE_MAX_LENGTH) return json({ error: 'Code is too long.' }, 400);

    /* Register it AND record the prize, locked to the winner for the 7-day
       window, so it is claimable on /giveaway exactly like a Big Prize win. */
    const { registerDropCode, recordPrize, PRIZE_WINDOW_SECONDS } = await import('../giveaway-entries.js');
    const entries = (TIER_INFO[tier] || {}).entries || 0;
    await registerDropCode(env, code, tier, entries, {
      source: 'giveaway-monthly-win',
      lockedTo: winner.userId,
      ttlSeconds: PRIZE_WINDOW_SECONDS,
      announce: false,
    });
    const prize = await recordPrize(env, winner.userId, { code, tier, entries });

    const message = `🏆 You won the MONTHLY giveaway! Your code: ${code} — it is locked to your account and waiting on phantomace.tv/giveaway for 7 days. Congrats!`;
    const sent = await sendWhisper(env, winner.userId, message);

    winner.sent = true;
    winner.whispered = sent;
    winner.code = code;
    winner.rarity = tier;
    winner.sentAt = Date.now();
    await env.MARKETPLACE.put(MONTHLY_WINNER_KEY, JSON.stringify(winner), { expirationTtl: STATE_TTL });

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

  /* ── REPLAY LAST REVEAL ───────────────────────────────────────────────
     Re-push a stored winner's giveaway-spin reveal to the overlay, for the
     Overlay Dashboard's "Replay last reveal" buttons. The draws themselves
     stay on Bot Control; this only re-shows the reel that already happened.
     which='monthly' replays the monthly draw, anything else the Big Prize. */
  if (body.action === 'replay') {
    const which = body.which === 'monthly' ? 'monthly' : 'big';
    const key = which === 'monthly' ? MONTHLY_WINNER_KEY : WINNER_KEY;
    const winner = await env.MARKETPLACE.get(key, 'json');
    if (!winner || !winner.reveal) {
      return json({
        error: which === 'monthly'
          ? 'No monthly winner to replay yet — draw one from Bot Control first.'
          : 'No Big Prize winner to replay yet — spin one from Bot Control first.',
      }, 400);
    }
    const { pushOverlayEvent } = await import('../overlay/events.js');
    await pushOverlayEvent(env, { type: 'giveaway-spin', ...winner.reveal });
    return json({ success: true, which, who: winner.username });
  }

  return json({ error: 'Invalid action' }, 400);
}
