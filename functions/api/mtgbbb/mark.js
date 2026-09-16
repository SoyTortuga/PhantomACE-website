/* ══════════════════════════════════════════════
   MTGBBB MARK — the moderator panel's only write path.

   Three actions, one endpoint, matching bingo/call.js's shape:

     mark   — record a pull: a card name plus zero or more treatment ids.
     undo   — remove one pull by id, from the recent-pulls list.
     pack   — nudge the visible pack counter, independent of pulls. Not
              every pack yields a mark (some have zero, occasionally more
              than one), so this is not derived from pulls.length — it is
              the moderator's own count of packs actually opened, there so
              the broadcaster can sanity-check it against the box in hand.

   AUTHORIZATION: any moderator or broadcaster, not only the room's host.
   This is the "corrected" authorization the plan calls out — Commander
   Bingo's call.js restricts marking to the exact creator, which is a
   problem the moment the mod running the panel needs to hand off mid-box.
   Awarding the prize is the one action that stays host-locked, in award.js.

   Every write goes through mutate(): marks arrive in a burst around a pack
   opening, and a lost update here is a pull that a player never sees credit
   for.

   A 'mark' ALSO does two things beyond recording the pull, both computed
   inside the same mutate() callback for one atomic view of before-and-after,
   but both DISPATCHED after it resolves — neither may hold the room's lock
   open for its own I/O:

     OVERLAY EVENTS. One 'mtgbbb-pull' (the card, its treatments as labels,
     and how many player cards hold it — the number that makes a pull a
     shared event). Then one 'mtgbbb-bingo' per pattern NEWLY completed by
     this pull, found by diffing scoreCard() before and after per player.
     A pull that completes nothing emits none. A pull that completes a
     blackout emits exactly ONE event for it, not also one for every one of
     the (up to thirteen) line patterns blackout necessarily also
     completes — a blackout is the moment worth announcing, not fourteen
     redundant ones in the same second. pushOverlayEvent() never throws, so
     a miss here costs the overlay, never the mark.

     CALL-YOUR-SHOT RESOLUTION. Any unresolved shot on this card resolves
     right here, against THIS pull's own treatments — see shot.js for why
     that is always the first and only pull that can resolve a given shot.
     A win is recorded inside the lock; the giveaway code itself is pulled
     afterward, same reasoning as the overlay push.
   ══════════════════════════════════════════════ */

import { scoreCard, cardCounts } from '../mtgbbb-scoring.js';

const GAME_TTL = 14400;

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

/** The treatment ids a shot's tier needs present on the resolving pull. */
function shotRequirement(shot) {
  if (shot.tier === 'rare') return ['foil', shot.treatmentId];
  if (shot.tier === 'uncommon') return ['foil'];
  return [];
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can mark pulls.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = String(body.code || '').toUpperCase().trim();
  const action = body.action === 'undo' ? 'undo' : body.action === 'pack' ? 'pack' : 'mark';
  if (!code) return json({ error: 'Missing code' }, 400);

  let failure = null;
  let response = null;
  const overlayJobs = [];
  const shotWins = []; // { playerId, tier }

  await env.MARKETPLACE.mutate(`mtgbbb_${code}`, (room) => {
    if (!room) { failure = json({ error: 'Game not found' }, 404); return undefined; }
    if (room.status === 'ended') { failure = json({ error: 'This game has ended.' }, 400); return undefined; }

    if (action === 'pack') {
      const delta = body.delta === -1 ? -1 : 1;
      room.packsOpened = Math.max(0, (room.packsOpened || 0) + delta);
      response = { packsOpened: room.packsOpened };
      return room;
    }

    if (action === 'undo') {
      const pullId = String(body.pullId || '');
      if (!pullId) { failure = json({ error: 'Missing pullId' }, 400); return undefined; }
      const idx = room.pulls.findIndex(p => p.id === pullId);
      if (idx === -1) { failure = json({ error: 'That pull is already gone.' }, 404); return undefined; }
      const [removed] = room.pulls.splice(idx, 1);
      response = { removed };
      return room;
    }

    /* action === 'mark' */
    const cardName = String(body.card || '').trim();
    const inPool = room.pool.some(c => c.name === cardName);
    if (!inPool) { failure = json({ error: 'That card is not in this set.' }, 400); return undefined; }

    const knownTreatments = new Set(room.treatments.map(t => t.id));
    const treatments = Array.isArray(body.treatments)
      ? [...new Set(body.treatments.map(String))]
      : [];
    const unknown = treatments.find(id => !knownTreatments.has(id));
    if (unknown) { failure = json({ error: `Unknown treatment: ${unknown}` }, 400); return undefined; }

    const pullsBefore = room.pulls;
    const pull = {
      id: String(room.nextPullId++),
      card: cardName,
      treatments,
      at: Date.now(),
      by: session.display_name || String(session.user_id),
    };
    const pullsAfter = [...pullsBefore, pull];
    room.pulls = pullsAfter;
    response = { pull };

    /* THE PULL EVENT. holders comes from every player's CURRENT card, not
       the pool — the pool tells you how many squares exist, this tells you
       how many people are about to feel something. */
    const poolCard = room.pool.find(c => c.name === cardName);
    overlayJobs.push({
      type: 'mtgbbb-pull',
      card: cardName,
      rarity: poolCard ? poolCard.rarity : '',
      image: poolCard ? (poolCard.art || poolCard.image || '') : '',
      treatments: treatments.map(id => {
        const t = room.treatments.find(x => x.id === id);
        return t ? t.label : id;
      }),
      holders: cardCounts(room.players.map(p => p.card)).get(cardName) || 0,
      players: room.players.length,
    });

    /* THE BINGO DIFF. Every player, scored before and after this one pull,
       so "newly completed" is a fact about this pull specifically rather
       than a flag that has to be remembered and could go stale across an
       undo. */
    for (const p of room.players) {
      const before = scoreCard(p.card, pullsBefore);
      const after = scoreCard(p.card, pullsAfter);

      if (after.blackout && !before.blackout) {
        overlayJobs.push({ type: 'mtgbbb-bingo', who: p.name, pattern: 'Blackout', points: after.points });
        continue; // see header: blackout stands alone, not alongside the lines it also completes
      }

      const newLines = after.lines.filter(l => !before.lines.some(bl => bl.id === l.id));
      for (const line of newLines) {
        overlayJobs.push({ type: 'mtgbbb-bingo', who: p.name, pattern: line.label, points: after.points });
      }
    }

    /* CALL-YOUR-SHOT. By construction (shot.js refuses a shot on a card
       already in room.pulls) this is always the first pull of `cardName`
       since the shot was set, so there is nothing to iterate — each
       unresolved shot on this card resolves exactly once, right here. */
    for (const shot of room.shots || []) {
      if (shot.resolved || shot.card !== cardName) continue;
      const required = shotRequirement(shot);
      shot.resolved = true;
      shot.won = required.every(id => treatments.includes(id));
      shot.resolvedAt = Date.now();
      if (shot.won) shotWins.push({ playerId: shot.playerId, tier: shot.tier });
    }

    return room;
  }, { expirationTtl: GAME_TTL });

  if (failure) return failure;

  if (overlayJobs.length) {
    const { pushOverlayEvent } = await import('../overlay/events.js');
    for (const ev of overlayJobs) await pushOverlayEvent(env, ev);
  }

  if (shotWins.length) {
    const { pullGiveawayCode } = await import('../bot/send-chat.js');
    for (const win of shotWins) {
      try {
        const giveawayCode = await pullGiveawayCode(env, win.tier);
        if (!giveawayCode) continue; // pool exhausted — the win stands, just no code to show yet
        await env.MARKETPLACE.mutate(`mtgbbb_${code}`, (room) => {
          if (!room) return undefined;
          const shot = (room.shots || []).find(s => s.playerId === win.playerId);
          if (shot) shot.code = giveawayCode;
          return room;
        }, { expirationTtl: GAME_TTL });
      } catch (err) {
        console.error('[mtgbbb/mark] call-your-shot code mint failed:', err.message);
      }
    }
  }

  return json({ success: true, ...response });
}
