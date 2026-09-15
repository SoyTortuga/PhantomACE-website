/* ══════════════════════════════════════════════
   BOT COMMANDS
   EventSub webhook for channel.chat.message
   Broadcaster/moderator-only chat commands:
     !drop <common|uncommon|rare|mythic>
     !dropitem [code]
     !announce <message>
   ══════════════════════════════════════════════ */

import { dropCodeAction, dropItemAction, announceAction } from './send-chat.js';

const HMAC_PREFIX = 'sha256=';

/* Twitch recommends rejecting any message whose timestamp is more than ten
   minutes old. Without it, a captured signed request stays replayable for
   ever, because the signature never expires. */
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
const TWITCH_MESSAGE_ID = 'twitch-eventsub-message-id';
const TWITCH_MESSAGE_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const TWITCH_MESSAGE_SIGNATURE = 'twitch-eventsub-message-signature';
const TWITCH_MESSAGE_TYPE = 'twitch-eventsub-message-type';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function verifySignature(secret, request, body) {
  const msgId = request.headers.get(TWITCH_MESSAGE_ID) || '';
  const timestamp = request.headers.get(TWITCH_MESSAGE_TIMESTAMP) || '';

  /* Reject stale messages BEFORE spending time on the HMAC. A valid
     signature on an old message is exactly what a replay looks like. */
  const age = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_MESSAGE_AGE_MS) return false;
  const expected = request.headers.get(TWITCH_MESSAGE_SIGNATURE) || '';

  const message = msgId + timestamp + body;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return expected === HMAC_PREFIX + hex;
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

  /* No link. This fires many times a stream, and a bot posting a URL on
     every reply is both spammy and the thing a non-moderator link filter
     blocks — which would make the command fail silently for everyone. */
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

/* ── The chat scramble ───────────────────────────────────────────────────
   Announcements only, never a reply to a guess. The bot is capped at
   roughly twenty messages per thirty seconds as a non-moderator, so a line
   per guess would silence it within seconds of a busy round — and a
   throttled message comes back as HTTP 200 with is_sent false, so it would
   fail without saying so. Live state goes on the overlay instead. */
async function announceGame(env, announce) {
  if (!announce) return;
  const { sendChatMessage } = await import('./send-chat.js');

  if (announce.kind === 'start') {
    await sendChatMessage(env, `Unscramble it: ${announce.display}  —  ${announce.hint}. Type your answer in chat!`);
  } else if (announce.kind === 'win') {
    await sendChatMessage(env, `@${announce.name} got it — ${announce.word.toUpperCase()}! +2 giveaway entries.`);
  } else if (announce.kind === 'timeout') {
    await sendChatMessage(env, `Time! It was ${announce.word.toUpperCase()}. Next one coming up.`);
  } else if (announce.kind === 'skip') {
    await sendChatMessage(env, `Skipped — it was ${announce.word.toUpperCase()}.`);
  } else if (announce.kind === 'stop') {
    const top = Object.values(announce.scores || {})
      .sort((a, b) => b.points - a.points).slice(0, 3)
      .map((s, i) => `${i + 1}. ${s.name} (${s.points})`).join('  ');
    await sendChatMessage(env, top ? `Scramble over! ${top}` : 'Scramble over!');
  }
}

async function handleChatMessage(env, event) {
  const parsed = parseCommand(event);

  /* ORDINARY CHAT REACHES THE GAME. Every message used to stop here unless
     it began with "!", which is right when the bot only has commands and
     wrong the moment chat is playing something: a scramble whose answer had
     to be typed as "!mana clash" is a worse game for no reason.

     offerGuess returns null for the overwhelming majority of messages — no
     game running, or simply not the answer — and writes nothing for a
     chatter it has already counted. */
  if (!parsed) {
    try {
      const { offerGuess } = await import('../chat-game.js');
      await announceGame(env, await offerGuess(env, {
        userId: event.chatter_user_id,
        name: event.chatter_user_name || event.chatter_user_login,
        text: event.message && event.message.text,
      }));
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
    const { controlGame } = await import('../chat-game.js');
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
