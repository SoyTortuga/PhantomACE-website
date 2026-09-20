/* ══════════════════════════════════════════════
   BINGO PRIZES — the host awards a winner.

   WHO MAY AWARD IS NOT "THE HOST". Hosting is open to anyone with a Twitch
   login, which is right — a pod should be able to run its own card. But
   giveaway entries are real currency here, and a host who could mint them
   would mean anyone could mint them by opening a game and declaring
   themselves the winner. So awarding needs BOTH: the broadcaster or a
   moderator, AND the host of this particular game. Either alone is not
   enough — the first would let a moderator reach into a stranger's game,
   the second would let a stranger mint prizes.

   ENTRIES ARE CREDITED DIRECTLY, not handed over as a code to redeem. The
   rarity still sets the value, using the same table the chat drops use, so
   a mythic bingo prize is worth exactly a mythic drop. But a code is a
   redemption step that can be mistyped, missed, or expire — and unlike a
   chat drop, which is a race everyone can enter, this prize already belongs
   to one known person. There is nothing for a code to decide.

   ONE PRIZE PER PLAYER PER GAME, claimed under the room's lock. A host
   clicking twice, or two moderators awarding at once, must not pay twice.
   ══════════════════════════════════════════════ */

const GAME_TTL = 14400;
const RARITIES = ['common', 'uncommon', 'rare', 'mythic'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can award prizes.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = String(body.code || '').toUpperCase().trim();
  const playerId = String(body.playerId || '');
  const rarity = String(body.rarity || '').toLowerCase();

  if (!code) return json({ error: 'Missing game code' }, 400);
  if (!playerId) return json({ error: 'Which player?' }, 400);
  if (!RARITIES.includes(rarity)) {
    return json({ error: `Rarity must be one of: ${RARITIES.join(', ')}` }, 400);
  }

  const { TIER_INFO } = await import('../bot/send-chat.js');
  const entries = TIER_INFO[rarity].entries;

  let failure = null;
  let awarded = null;
  let showOnOverlay = true;

  await env.MARKETPLACE.mutate(`bingo_${code}`, (game) => {
    if (!game) { failure = json({ error: 'Game not found' }, 404); return undefined; }
    showOnOverlay = game.showOnOverlay !== false;

    if (String(session.user_id) !== String(game.host)) {
      /* A moderator, but not the host of THIS game. */
      failure = json({ error: 'That is not your game.' }, 403);
      return undefined;
    }

    const player = (game.players || []).find(p => p.id === playerId);
    if (!player) { failure = json({ error: 'That player is not in this game.' }, 404); return undefined; }

    /* Guest records from before login was required. There is no account to
       credit, and saying so is more useful than a silent no-op. */
    if (!String(playerId).startsWith('u_')) {
      failure = json({ error: 'That player joined as a guest and has no account to credit.' }, 400);
      return undefined;
    }

    game.prizes = Array.isArray(game.prizes) ? game.prizes : [];
    if (game.prizes.some(pr => pr.playerId === playerId)) {
      failure = json({ error: `${player.name} has already been awarded a prize.` }, 409);
      return undefined;
    }

    /* Recorded before the entries are credited, inside the lock, so a
       double click cannot pay twice even if the two requests arrive
       together. */
    game.prizes.push({
      playerId,
      name: player.name,
      rarity,
      entries,
      awardedBy: session.display_name || String(session.user_id),
      at: Date.now(),
    });
    awarded = { playerId, name: player.name, rarity, entries };
    return game;
  }, { expirationTtl: GAME_TTL });

  if (failure) return failure;

  /* Credited outside the lock — a different key, and holding one row's lock
     while writing another is how two features deadlock each other. */
  const userId = playerId.slice(2);           // strip the 'u_' prefix
  let total = 0;
  try {
    const { addEntries } = await import('../giveaway-entries.js');
    total = await addEntries(env, userId, awarded.name, entries, `bingo:${rarity}`);
  } catch (err) {
    /* The prize is already recorded and the host has been told it landed.
       Log loudly rather than unwinding something already announced. */
    console.error('[bingo/award] entry credit failed:', err.message);
  }

  /* Put the win on the overlay — the Commander Bingo equivalent of MTGBBB's
     bingo alert. Suppressed when the host has this game off the overlay, the
     same as the call alert. Best-effort, after the prize is safely recorded,
     so a failed alert never affects whether the entries were credited. */
  if (showOnOverlay) try {
    const { pushOverlayEvent } = await import('../overlay/events.js');
    await pushOverlayEvent(env, {
      type: 'bingo-win',
      who: awarded.name,
      rarity: awarded.rarity,
      entries: awarded.entries,
    });
  } catch (err) {
    console.error('[bingo/award] could not push overlay event:', err.message);
  }

  return json({ success: true, ...awarded, total });
}
