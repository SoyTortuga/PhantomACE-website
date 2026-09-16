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

    const pull = {
      id: String(room.nextPullId++),
      card: cardName,
      treatments,
      at: Date.now(),
      by: session.display_name || String(session.user_id),
    };
    room.pulls.push(pull);
    response = { pull };
    return room;
  }, { expirationTtl: GAME_TTL });

  if (failure) return failure;
  return json({ success: true, ...response });
}
