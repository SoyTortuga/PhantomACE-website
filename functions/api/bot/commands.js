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

/* ── ANSWER TWITCH FIRST ─────────────────────────────────────────────────
   Bot replies on the hot paths — maze clears, scramble rounds, !entries —
   used to be awaited before the webhook answered, so every Helix send sat
   between Twitch and its 200. Twitch retries slow answers and disables
   subscriptions that keep failing, and the chat-message subscription sees
   every line typed. The game state is still settled before answering (it
   is what the reply is about); only the outbound messages wait, queued in
   order and sent once the response is on its way. */
function deferSends(context, jobs) {
  if (!jobs.length) return;
  const run = (async () => {
    for (const job of jobs) {
      try { await job(); } catch (err) { console.error('[bot] deferred chat send failed:', err && err.message); }
    }
  })();
  if (context && typeof context.waitUntil === 'function') context.waitUntil(run);
}

async function handleChatMessage(env, event, outbox = []) {
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
      userId: event.chatter_user_id,
      name: event.chatter_user_name || event.chatter_user_login,
      text: event.message && event.message.text,
    });
    if (mazeSaid) {
      if (mazeSaid.length) {
        const { sendChatMessage } = await import('./send-chat.js');
        for (const m of mazeSaid) outbox.push(() => sendChatMessage(env, m));
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
      for (const a of (said || [])) outbox.push(() => announceGame(env, a));
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
    outbox.push(() => handleEntriesCommand(env, event));
    return;
  }

  /* !bingo — a viewer claims a bingo, VERIFIED server-side against their own
     card and the called squares. The claim and the overlay alert are settled
     here (state before the webhook answers, like the games above); only the
     chat reply is deferred. A false claim, or one from someone with no card,
     alerts nothing and is rate-limited inside verify.js. */
  if (parsed.command === '!bingo') {
    try {
      const { verifyBingoClaim } = await import('../bingo/verify.js');
      const r = await verifyBingoClaim(env, {
        userId: event.chatter_user_id,
        name: event.chatter_user_name || event.chatter_user_login,
      });
      if (r && r.chat) {
        const { sendChatMessage } = await import('./send-chat.js');
        outbox.push(() => sendChatMessage(env, r.chat));
      }
    } catch (err) {
      /* A broken verify must not break chat commands. */
      console.error('[bingo/verify]', err.message);
    }
    return;
  }

  /* !hit — a chatter strikes the live Skull Clicker raid boss. The whole point
     is the viewers who never open the site: their damage counts toward the co-op
     kill and shows on the overlay beside site damage, pulling chat into the
     fight. Attributed to a chat contributor keyed by the chatter's Twitch id,
     rate-limited per account server-side by skull-raid's OWN token bucket (the
     same ceiling site strikers have), so a scripted spammer gains nothing. No
     active boss → a quiet no-op. A chat-only striker with no site account earns
     no code/leaderboard reward — only their damage lands. Settled here before
     the webhook answers; deliberately silent (no chat reply), so there is
     nothing to defer and nothing to spam — the overlay HP bar is the feedback. */
  if (parsed.command === '!hit') {
    try {
      const { strikeRaidFromChat } = await import('../skull-raid.js');
      await strikeRaidFromChat(env, {
        userId: event.chatter_user_id,
        name: event.chatter_user_name || event.chatter_user_login,
      });
    } catch (err) {
      /* A broken raid strike must not break chat commands. */
      console.error('[skull-raid/chat]', err.message);
    }
    return;
  }

  /* !clash — a chatter joins the live Streamer-vs-Chat Mana Clash. Their
     command rolls one fair die into chat's shared pool, resolved server-side
     against the streamer's frozen roll with the real Mana Clash scoring. One
     die per chatter per clash (the rate limit, enforced in mana-clash-chat.js),
     bounded participant map, no per-message log. No active clash → a quiet
     no-op. Deliberately silent like !hit: the overlay is the feedback, and a
     reply per chatter would bury the channel during exactly the busy minute
     the clash is open. */
  if (parsed.command === '!clash') {
    try {
      const { clashFromChat } = await import('../mana-clash-chat.js');
      await clashFromChat(env, {
        userId: event.chatter_user_id,
        name: event.chatter_user_name || event.chatter_user_login,
      });
    } catch (err) {
      /* A broken clash must not break chat commands. */
      console.error('[mana-clash-chat/chat]', err.message);
    }
    return;
  }

  /* !wind left | !wind right — a chatter nudges the wind during a PhamShock
     Wind Night session. One step toward that side, clamped to range, one nudge
     per chatter per cooldown (enforced in pham-wind-night.js — a bounded
     counts-and-value record, no per-message log). No live session → a quiet
     no-op. Silent like !hit / !clash: the overlay and the game's own wind gauge
     are the feedback, and a reply per chatter would bury the channel during the
     busy minute the wind is swinging. Also accepts l/r and </> as shorthand. */
  if (parsed.command === '!wind') {
    try {
      const { windFromChat } = await import('../pham-wind-night.js');
      await windFromChat(env, {
        userId: event.chatter_user_id,
        name: event.chatter_user_name || event.chatter_user_login,
        arg: parsed.rest,
      });
    } catch (err) {
      /* A broken wind nudge must not break chat commands. */
      console.error('[pham-wind-night/chat]', err.message);
    }
    return;
  }

  /* !catch — a chatter races to catch the live wild dino during a Dino Stream
     Safari. Their command adds them to the current spawn's catchers; when the
     catch window closes the winner (raffle or first, per the session's rule) is
     granted that exact dino as an egg, server-side (dino-safari.js). One catch
     per chatter per spawn (the rate limit), bounded catcher set, no per-message
     log. No live Safari / closed window → a quiet no-op. Silent like
     !hit / !clash / !wind: the overlay is the feedback, and a reply per chatter
     would bury the channel during the seconds the window is open. */
  if (parsed.command === '!catch') {
    try {
      const { catchFromChat } = await import('../dino-safari.js');
      await catchFromChat(env, {
        userId: event.chatter_user_id,
        name: event.chatter_user_name || event.chatter_user_login,
      });
    } catch (err) {
      /* A broken catch must not break chat commands. */
      console.error('[dino-safari/chat]', err.message);
    }
    return;
  }

  /* MTGBBB guess-the-rare. One call per chatter per pack, first one locks, an
     unknown or ambiguous card dropped. Silent like !hit / !clash / !wind /
     !catch — a box is thirty packs, and a line per guess would bury the
     channel. The overlay panel is the feedback. */
  if (parsed.command === '!guess') {
    try {
      const { guessFromChat } = await import('../mtgbbb-chat.js');
      await guessFromChat(env, {
        userId: event.chatter_user_id,
        name: event.chatter_user_name || event.chatter_user_login,
        text: parsed.rest,
      });
    } catch (err) {
      /* A broken guess must not break chat commands. */
      console.error('[mtgbbb-guess/chat]', err.message);
    }
    return;
  }

  /* Siege operator draft. One vote per chatter, changeable while the draft is
     open — unlike !guess, nothing here is hidden, so swinging behind a pick is
     the game rather than an exploit. Votes resolve against the ACTIVE side's
     pool only, so a wrong-side operator is simply not a candidate. Silent: a
     prep phase is forty-five seconds and a line per vote would bury chat
     exactly when it is trying to coordinate. */
  if (parsed.command === '!op') {
    try {
      const { voteFromChat } = await import('../r6-draft.js');
      await voteFromChat(env, {
        userId: event.chatter_user_id,
        name: event.chatter_user_name || event.chatter_user_login,
        text: parsed.rest,
      });
    } catch (err) {
      /* A broken draft must not break chat commands. */
      console.error('[r6-draft/chat]', err.message);
    }
    return;
  }

  /* The generic chat vote — any game, any question, fixed options or free
     text. One vote per chatter, changeable while it is open. Silent; the
     overlay carries the question and the tally. */
  if (parsed.command === '!vote') {
    try {
      const { voteFromChat } = await import('../chat-vote.js');
      await voteFromChat(env, {
        userId: event.chatter_user_id,
        name: event.chatter_user_name || event.chatter_user_login,
        text: parsed.rest,
      });
    } catch (err) {
      /* A broken vote must not break chat commands. */
      console.error('[chat-vote/chat]', err.message);
    }
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

  /* !maze on | !maze off — the maze from a phone, mid-stream, without
     opening the toolbox. Same people as the page: this sits behind the
     moderator gate above, and startMaze/stopMaze are the same functions
     the route calls, announcements included. */
  if (parsed.command === '!maze') {
    const { startMaze, stopMaze } = await import('./maze.js');
    const want = parsed.rest.toLowerCase();
    if (want === 'on' || want === 'start') await startMaze(env);
    else if (want === 'off' || want === 'stop' || want === 'end') await stopMaze(env);
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

    const outbox = [];
    if (subType === 'channel.chat.message') {
      /* Never 500 at Twitch — see the note in hype-train.js. The message id
         is already claimed, so a retry could not have helped anyway. */
      try {
        await handleChatMessage(env, event, outbox);
      } catch (err) {
        console.error('[bot] chat message handler failed:', err && err.message);
      }
    }

    const { clearEventSubRevocation } = await import('./dashboard.js');
    await clearEventSubRevocation(env, subType);

    deferSends(context, outbox);
    return json({ ok: true });
  }

  if (messageType === 'revocation') {
    const { recordEventSubRevocation } = await import('./dashboard.js');
    await recordEventSubRevocation(env, body, 'bot/commands');
    return json({ ok: true });
  }

  return json({ ok: true });
}
