/* ══════════════════════════════════════════════
   COMMANDER BINGO — `!bingo` VERIFIED IN CHAT.

   A viewer types `!bingo`; the server checks THEIR card against the called
   squares and, only if it is a genuine bingo, puts a VERIFIED BINGO alert on
   stream and records a claim the host can award from. The point is that the
   claim is server-authoritative — the server already deals every card and
   records every call, so there is no trusting the chatter.

   HOW IT HANGS TOGETHER
     - bot/commands.js routes `!bingo` here with the Twitch chatter identity.
     - The on-stream game (and which room) comes from stream_now; `!bingo` only
       does anything while bingo is the game on stream.
     - The chatter is matched to a player by 'u_' + their Twitch user id — the
       exact id join.js seats them under.
     - The win check is the SAME one the on-site results use: cardScore from
       end.js, best card per player. The rules are not re-implemented here.
     - A genuine, not-yet-claimed win records a claim on the room and pushes a
       'bingo-claim' alert — gated by the overlay pointer exactly like a call or
       an award, so a side room never reaches the stream.
     - Everything is stored ON THE ROOM record (game.claims, game.cmdCooldowns),
       so there is no new KV key and no registry change — claims ride the same
       'bingo_<code>' row that already expires with the game.

   RATE LIMITING. A per-chatter cooldown (on the room) throttles the reply paths
   — a wrong `!bingo`, or one from someone with no card — so a viewer mashing it
   can neither spam chat nor the overlay. A genuine NEW win is always processed
   (it is deduped by the claim itself, so it can alert only once regardless).

   This file exports NO request handler — it is a LIBRARY, imported by
   bot/commands.js. It must be listed in server/router.js's NON_ROUTE_MODULES or
   the rig boot crashes to SERVICE_PAUSED.
   ══════════════════════════════════════════════ */

import { cardScore } from './end.js';
import { readPointer, alertsAllowed } from './overlay.js';
import { readStreamNow } from '../stream-now.js';

const GAME_TTL = 14400;

/* Fifteen seconds, per chatter. Long enough that a held-down `!bingo` is one
   reply and nothing more; short enough that a card that just became a winner
   can still be claimed a few seconds later. */
export const BINGO_CMD_COOLDOWN_MS = 15000;

const JOIN_URL = 'phantomace.tv/games/commander-bingo';

/* The best score across a player's cards — the same "two cards are two chances
   at one score" rule standings() uses in end.js, reduced to just the bingo
   count. `called` is a Set. */
export function bestBingos(player, called) {
  const cards = (Array.isArray(player.cards) && player.cards.length) ? player.cards : [player.cardIds];
  const wilds = Array.isArray(player.wildcards) ? player.wildcards : [];
  let best = 0;
  cards.forEach((ids, ci) => {
    if (!Array.isArray(ids) || ids.length !== 25) return;
    const wildIds = new Set(wilds.filter(w => w.cardIndex === ci).map(w => w.eventId));
    const s = cardScore(ids, called, wildIds);
    if (s.bingos > best) best = s.bingos;
  });
  return best;
}

/**
 * Verify a chatter's `!bingo`. Does every KV side effect itself (records the
 * claim, pushes the overlay alert); returns { chat } — the one line for the bot
 * to say, or null for silence — plus flags the tests assert on.
 *
 * @param {object} chatter { userId, name } — the Twitch identity from the webhook.
 */
export async function verifyBingoClaim(env, chatter) {
  const userId = chatter && chatter.userId;
  const name = (chatter && (chatter.name || '')) || 'friend';
  if (!userId) return { chat: null, reason: 'no-user' };

  /* Only while bingo is the game on stream. A `!bingo` typed when something
     else (or nothing) is on stream is ignored in silence. */
  const whatsOn = await readStreamNow(env);
  if (!whatsOn || whatsOn.game !== 'bingo' || !whatsOn.code) {
    return { chat: null, reason: 'not-on-stream' };
  }
  const code = String(whatsOn.code).toUpperCase().trim();
  const playerId = 'u_' + userId;

  /* Read the overlay pointer before the room lock — a different row, and the
     alert decision only needs to be as fresh as this request. */
  const pointer = await readPointer(env);

  let result = { chat: null, reason: 'no-room' };
  let alertPayload = null;

  await env.MARKETPLACE.mutate(`bingo_${code}`, (game) => {
    if (!game || game.status !== 'active') { result = { chat: null, reason: 'no-room' }; return undefined; }

    const now = Date.now();

    /* Per-chatter cooldown, pruned to the window so it cannot grow unbounded
       as strangers type the command over a long stream. */
    const cds = (game.cmdCooldowns && typeof game.cmdCooldowns === 'object') ? game.cmdCooldowns : {};
    for (const k of Object.keys(cds)) {
      if (now - (Number(cds[k]) || 0) > BINGO_CMD_COOLDOWN_MS) delete cds[k];
    }
    const cooling = (now - (Number(cds[userId]) || 0)) < BINGO_CMD_COOLDOWN_MS;

    const player = (game.players || []).find(p => p.id === playerId);
    const called = new Set(Array.isArray(game.calledEvents) ? game.calledEvents : []);

    /* ── GENUINE WIN ──────────────────────────────────────────────────────
       Processed once and deduped by the claim, so it is NOT gated behind the
       cooldown: a card that just became a winner must verify even if the
       player tried a moment ago. The dedupe is what keeps it to one alert. */
    if (player) {
      const bingos = bestBingos(player, called);
      if (bingos > 0) {
        game.claims = Array.isArray(game.claims) ? game.claims : [];
        const existing = game.claims.find(c => c.playerId === playerId);
        if (!existing) {
          const who = player.name || name;
          game.claims.push({ playerId, name: who, bingos, at: now });
          if (alertsAllowed(pointer, code, game)) alertPayload = { who, bingos };
          game.cmdCooldowns = cds;
          result = {
            chat: `@${who} VERIFIED BINGO! 🎉 The host will sort your prize.`,
            verified: true, claimed: true, alerted: !!alertPayload,
          };
          return game;
        }
        /* Already claimed — never a second alert. A gentle reminder, but only
           when not cooling, so it cannot be spammed. */
        if (cooling) { result = { chat: null, verified: true, claimed: false, reason: 'already' }; return undefined; }
        cds[userId] = now;
        game.cmdCooldowns = cds;
        result = {
          chat: `@${existing.name || name} you're already verified — hang tight for the host.`,
          verified: true, claimed: false, reason: 'already',
        };
        return game;
      }
    }

    /* ── REPLY PATHS (no win, or no card) — rate limited ──────────────────── */
    if (cooling) { result = { chat: null, reason: 'throttled' }; return undefined; }
    cds[userId] = now;
    game.cmdCooldowns = cds;
    result = player
      ? { chat: `@${name} no bingo yet — keep marking those squares!`, verified: false, reason: 'no-win' }
      : { chat: `@${name} you need a card to claim bingo — join at ${JOIN_URL}`, verified: false, reason: 'not-in-room' };
    return game;
  }, { expirationTtl: GAME_TTL });

  /* The alert is pushed AFTER the claim is safely recorded, and only when the
     room is the one the overlay follows. Best-effort — an overlay hiccup must
     never undo a recorded claim. */
  if (alertPayload) {
    try {
      const { pushOverlayEvent } = await import('../overlay/events.js');
      await pushOverlayEvent(env, {
        type: 'bingo-claim',
        who: alertPayload.who,
        bingos: alertPayload.bingos,
      });
    } catch (err) {
      console.error('[bingo/verify] could not push overlay event:', err.message);
    }
  }

  return result;
}
