/* ══════════════════════════════════════════════
   MTGBBB SHOT — call your shot, press your luck.

   A player names a mythic they think is coming and commits to how specific:

     card only                -> common  tier, wins on any pull of that card
     card + foil               -> uncommon, wins on a foil pull of that card
     card + foil + a treatment -> rare, wins only on foil AND that treatment

   ALL OR NOTHING. Committing further does not make the lower tiers count as
   a consolation prize — call a borderless foil, get a plain foil, get
   nothing. That is what makes it a wager rather than a hedge.

   SET ONCE. No changing a shot once it exists — the whole point is that it
   costs something to commit.

   NOT YET PULLED, for every player, not only a late joiner. The plan's own
   language singles out late joiners ("only on cards not yet pulled, and it
   counts forward only") but the reasoning is not late-joiner-specific: a
   shot on a card that has already come out of the box is not a wager, it is
   a lookup. Applying the rule to everyone is the same rule, just not
   special-cased for no reason.

   ONLY MYTHICS, per the plan — a rare-pool wager would be a different, much
   safer bet and is a different feature if it's ever wanted.

   RESOLUTION lives in mark.js, not here: a shot can only resolve against a
   pull, and mark.js already holds the room's lock at the moment a pull is
   recorded. This route only ever creates a shot in the unresolved state.
   ══════════════════════════════════════════════ */

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

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in with Twitch to call a shot.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = String(body.code || '').toUpperCase().trim();
  const cardName = String(body.card || '').trim();
  const wantsFoil = body.wantsFoil === true;
  const treatmentId = body.treatmentId ? String(body.treatmentId) : null;
  if (!code) return json({ error: 'Missing code' }, 400);
  if (!cardName) return json({ error: 'Missing card' }, 400);
  if (treatmentId && !wantsFoil) {
    return json({ error: 'A named treatment needs foil too — that is the rare tier.' }, 400);
  }
  if (treatmentId === 'foil') {
    return json({ error: 'Foil is already the uncommon tier on its own — name a different treatment for rare.' }, 400);
  }

  const playerId = 'u_' + session.user_id;

  let failure = null;
  let result = null;

  await env.MARKETPLACE.mutate(`mtgbbb_${code}`, (room) => {
    if (!room) { failure = json({ error: 'Game not found' }, 404); return undefined; }
    if (room.status === 'ended') { failure = json({ error: 'This game has ended.' }, 400); return undefined; }

    if (!room.players.some(p => p.id === playerId)) {
      failure = json({ error: 'Join the game before calling a shot.' }, 400);
      return undefined;
    }

    if (!room.callYourShot || !room.callYourShot.enabled) {
      failure = json({ error: 'Call-your-shot is not open for this game.' }, 400);
      return undefined;
    }

    room.shots = Array.isArray(room.shots) ? room.shots : [];

    const cap = room.callYourShot.cap;
    if (cap != null && room.shots.length >= cap) {
      failure = json({ error: 'Call-your-shot has reached its cap for this game.' }, 409);
      return undefined;
    }

    if (room.shots.some(s => s.playerId === playerId)) {
      failure = json({ error: 'You already called your shot — it cannot be changed.' }, 409);
      return undefined;
    }

    const poolCard = room.pool.find(c => c.name === cardName);
    if (!poolCard) { failure = json({ error: 'That card is not in this set.' }, 400); return undefined; }
    if (poolCard.rarity !== 'mythic') {
      failure = json({ error: 'Call-your-shot is mythics only.' }, 400);
      return undefined;
    }

    if (treatmentId && !room.treatments.some(t => t.id === treatmentId)) {
      failure = json({ error: `Unknown treatment: ${treatmentId}` }, 400);
      return undefined;
    }

    /* Forward-only, for everyone — see the header. */
    if (room.pulls.some(p => p.card === cardName)) {
      failure = json({ error: 'That card has already been pulled — pick one still in the box.' }, 400);
      return undefined;
    }

    const tier = !wantsFoil ? 'common' : !treatmentId ? 'uncommon' : 'rare';
    const shot = {
      playerId,
      name: session.display_name || String(session.user_id),
      card: cardName,
      wantsFoil,
      treatmentId,
      tier,
      resolved: false,
      won: false,
      code: null,
      at: Date.now(),
    };
    room.shots.push(shot);
    result = { tier, card: cardName };
    return room;
  }, { expirationTtl: GAME_TTL });

  if (failure) return failure;
  return json({ success: true, ...result });
}
