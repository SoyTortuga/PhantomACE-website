/* ══════════════════════════════════════════════
   BOT COMMANDS
   EventSub webhook for channel.chat.message
   Broadcaster/moderator-only chat commands:
     !drop <common|uncommon|rare|mythic>
     !dropitem [code]
     !announce <message>
   ══════════════════════════════════════════════ */

import { verifyEventSub } from '../../../server/lib/eventsub.js';

import { dropCodeAction, dropItemAction, announceAction } from './send-chat.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/* A sender counts as authorized if Twitch flags them as the broadcaster
   or a moderator — via chatter_user_id match or the badges array. Never
   trust the display name/login string alone. */
function isAuthorizedSender(env, event) {
  if (!event) return false;
  if (event.chatter_user_id && env.TWITCH_BROADCASTER_ID && event.chatter_user_id === env.TWITCH_BROADCASTER_ID) {
    return true;
  }
  const badges = event.badges || [];
  return badges.some(b => b.set_id === 'broadcaster' || b.set_id === 'moderator');
}

/* ── !entries ────────────────────────────────────────────────────────────
   Tells a viewer their own standing. The whole point is the people who
   never open the site: the ledger is invisible to them otherwise, and an
   invisible reward system may as well not exist.

   Rate-limited per asker rather than globally. A global cooldown would mean
   the second person to ask in the same few seconds gets silence and no idea
   why — and "the bot ignored me" is exactly the impression this command
   exists to avoid. One person spamming it only silences themselves. */
const ENTRIES_COOLDOWN_MS = 30000;

async function handleEntriesCommand(env, event) {
  const userId = event.chatter_user_id;
  const name = event.chatter_user_name || event.chatter_user_login || 'friend';
  if (!userId) return;

  const key = `bot_cooldown_entries_${userId}`;
  const last = await env.MARKETPLACE.get(key, 'json');
  if (last && last.at > Date.now() - ENTRIES_COOLDOWN_MS) return;
  await env.MARKETPLACE.put(key, JSON.stringify({ at: Date.now() }), { expirationTtl: 120 });

  const [{ getGiveawaySummary }, { getCheckinStats }, { sendChatMessage }] = await Promise.all([
    import('../giveaway-entries.js'),
    import('../checkin-rewards.js'),
    import('./send-chat.js'),
  ]);

  const summary = await getGiveawaySummary(env, { user_id: userId });
  const mine = (summary.you && summary.you.entries) || 0;
  const stats = await getCheckinStats(env, userId);

  /* No link. The bot is a moderator now, so a link filter would not block
     it — but this fires many times a stream, and a URL on every reply is
     still noise nobody asked for. */
  let msg = `@${name} — ${mine} ${mine === 1 ? 'entry' : 'entries'} in this month's giveaway`;
  if (stats.streak > 0) {
    msg += ` · ${stats.streak}-stream check-in streak`;
  }
  if (mine === 0) {
    msg += '. Grab a code when one drops in chat!';
  }

  await sendChatMessage(env, msg);
}

function parseCommand(event) {
  const text = event && event.message && typeof event.message.text === 'string' ? event.message.text.trim() : '';
  if (!text.startsWith('!')) return null;

  const spaceIdx = text.indexOf(' ');
  const command = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
  return { command, rest };
}

/* Which badge in a chat message carries a subscription length.

   Twitch gives the channel's earliest subscribers a FOUNDER badge instead
   of a subscriber one, so looking only for set_id 'subscriber' misses them
   — and they are precisely the people with the most months behind them.
   The cumulative count sits in `info` either way; only the set id differs.

   Subscriber is preferred when both somehow appear, because its version id
   carries the tier as well. */
export function pickSubBadge(badges) {
  const list = Array.isArray(badges) ? badges : [];
  const sub = list.find(b => b && b.set_id === 'subscriber');
  if (sub) return { badge: sub, isFounder: false };
  const founder = list.find(b => b && b.set_id === 'founder');
  if (founder) return { badge: founder, isFounder: true };
  return null;
}

/* THE ONLY PLACE CUMULATIVE MONTHS EVER APPEAR.

   Twitch's subscriptions endpoint hands back a tier and no duration, so
   nothing at login can say how long someone has subscribed. The badge they
   wear in chat carries it, in `info`, and it is correct by construction:
   Twitch decides what badge to attach, not us.

   Recorded monotonically. A viewer who lapses and resubscribes should not
   lose the eight years they already earned, and a badge can only ever be
   worn at or above what was earned. */
/* VIP is a status the broadcaster grants by hand, and chat is the only
   place it is visible to us — Helix has no "is this person a VIP" call the
   site is authorised for. Unlike a subscription it can be taken away, so
   this records what chat last showed rather than the high-water mark the
   months use. */
export function hasVipBadge(badges) {
  return (Array.isArray(badges) ? badges : []).some(b => b && b.set_id === 'vip');
}

async function recordSubMonths(env, event) {
  const userId = event && event.chatter_user_id;
  if (!userId) return;

  const isVip = hasVipBadge(event.badges);

  /* FOUNDERS WEAR A DIFFERENT BADGE. Twitch gives the channel's earliest
     subscribers a founder badge INSTEAD of a subscriber one, so a lookup for
     set_id 'subscriber' misses them completely — and they are precisely the
     people with the most months behind them. The cumulative count is still
     in `info`; only the set id differs. */
  const picked = pickSubBadge(event.badges);
  if (!picked) {
    /* A VIP who does not subscribe still has something worth recording, so
       this cannot return early on the subscription badge alone. */
    if (isVip) await markVip(env, userId, event.chatter_user_name);
    return;
  }
  const { badge, isFounder } = picked;

  const { decodeBadgeVersion } = await import('../import-badges.js');
  /* A founder badge's version is not a month ladder — it is 0 for everyone —
     so its months come from `info` alone and its tier is not knowable here.
     Recording tier 1 is a floor rather than a claim: the importer prefers
     the tier on the session, and the write below only ever raises. */
  const decoded = isFounder ? { tier: 1, months: NaN } : decodeBadgeVersion(badge.id);
  /* `info` is the authoritative count; the version id only carries the
     threshold the badge is drawn for. Prefer info, fall back to the id. */
  const fromInfo = parseInt(badge.info, 10);
  const months = Number.isFinite(fromInfo) && fromInfo >= 0
    ? fromInfo
    : (decoded ? decoded.months : NaN);
  if (!Number.isFinite(months)) return;
  const tier = decoded ? decoded.tier : 1;

  try {
    await env.MARKETPLACE.mutate(`sub_months_${userId}`, (cur) => {
      const hadMonths = cur ? Number(cur.months) || 0 : 0;
      const hadTier = cur ? Number(cur.tier) || 0 : 0;
      const knownFounder = !!(cur && cur.founder);
      const knownVip = !!(cur && cur.vip);
      if (hadMonths >= months && hadTier >= tier &&
          knownFounder === isFounder && knownVip === isVip) {
        return undefined;   // nothing new
      }
      return {
        userId: String(userId),
        name: event.chatter_user_name || (cur && cur.name) || '',
        months: Math.max(months, hadMonths),
        tier: Math.max(tier, hadTier),
        /* Sticky: someone is a founder for good, and a lapsed founder who
           returns still wears the badge. */
        founder: isFounder || !!(cur && cur.founder),
        /* NOT sticky. VIP is given and taken away, so this is what chat
           last showed rather than the best it ever showed. */
        vip: isVip,
        at: Date.now(),
      };
    });
  } catch (err) {
    /* A chat message must never fail over a bookkeeping write. */
    console.error('[bot] could not record sub months:', err.message);
  }
}

/* A VIP who is not a subscriber has no months and no tier, so they get a
   record that carries only what is true about them. */
async function markVip(env, userId, name) {
  try {
    await env.MARKETPLACE.mutate(`sub_months_${userId}`, (cur) => {
      if (cur && cur.vip === true) return undefined;
      return {
        userId: String(userId),
        name: name || (cur && cur.name) || '',
        months: cur ? Number(cur.months) || 0 : 0,
        tier: cur ? Number(cur.tier) || 0 : 0,
        founder: !!(cur && cur.founder),
        vip: true,
        at: Date.now(),
      };
    });
  } catch (err) {
    console.error('[bot] could not record VIP:', err.message);
  }
}

async function handleChatMessage(env, event) {
  await recordSubMonths(env, event);
  const parsed = parseCommand(event);

  /* ORDINARY CHAT REACHES THE GAME. Every message used to stop here unless
     it began with "!", which is right when the bot only has commands and
     wrong the moment chat is playing something: a scramble whose answer had
     to be typed as "!mana clash" is a worse game for no reason.

     offerGuess returns null for the overwhelming majority of messages — no
     game running, or simply not the answer — and writes nothing for a
     chatter it has already counted. */
  /* THE MAZE HEARS EVERYTHING FIRST, "!" or not. Its regex is one exact
     token, so it turns almost every message away before either game does
     any work -- and "!up" must work as well as "up", which the parsed
     branch below would otherwise swallow into the command table. */
  try {
    const { offerMove } = await import('./maze.js');
    const mazeSaid = await offerMove(env, {
      name: event.chatter_user_name || event.chatter_user_login,
      text: event.message && event.message.text,
    });
    if (mazeSaid) {
      if (mazeSaid.length) {
        const { sendChatMessage } = await import('./send-chat.js');
        for (const m of mazeSaid) await sendChatMessage(env, m);
      }
      return;
    }
  } catch (err) {
    /* A broken maze must not break chat commands, same as the scramble. */
    console.error('[maze]', err.message);
  }

  if (!parsed) {
    try {
      const { offerGuess, announceGame } = await import('../chat-game.js');
      const said = await offerGuess(env, {
        userId: event.chatter_user_id,
        name: event.chatter_user_name || event.chatter_user_login,
        text: event.message && event.message.text,
      });
      /* A guess can produce more than one line — a round timing out and the
         next one opening land together. */
      for (const a of (said || [])) await announceGame(env, a);
    } catch (err) {
      /* A broken game must not break chat commands. */
      console.error('[chat-game]', err.message);
    }
    return;
  }

  const actor = event.chatter_user_login || event.chatter_user_name || 'unknown';

  /* ── PUBLIC COMMANDS ────────────────────────────────────────────────────
     Checked BEFORE the moderator gate. Every command used to sit behind it,
     which is correct for !drop and would have made !entries answer only the
     three people who least need to ask. */
  if (parsed.command === '!entries') {
    await handleEntriesCommand(env, event);
    return;
  }

  /* Everything past here is broadcaster/moderator only. */
  if (!isAuthorizedSender(env, event)) return;

  if (parsed.command === '!drop') {
    await dropCodeAction(env, parsed.rest, actor);
    return;
  }

  if (parsed.command === '!dropitem') {
    await dropItemAction(env, parsed.rest || null, actor);
    return;
  }

  if (parsed.command === '!announce') {
    await announceAction(env, parsed.rest, actor);
    return;
  }

  /* !scramble | !scramble skip | !scramble stop
     Runnable from chat so the game can be started from a phone while the
     BRB screen is already up, without opening the control panel. */
  if (parsed.command === '!scramble') {
    const { controlGame, announceGame } = await import('../chat-game.js');
    const word = parsed.rest.toLowerCase().split(' ')[0];
    const action = word === 'stop' ? 'stop' : word === 'skip' ? 'skip' : 'start';
    const result = await controlGame(env, action, {});
    if (result.announce) await announceGame(env, result.announce);
    return;
  }
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

    if (subType === 'channel.chat.message') {
      await handleChatMessage(env, event);
    }

    return json({ ok: true });
  }

  if (messageType === 'revocation') {
    return json({ ok: true });
  }

  return json({ ok: true });
}
