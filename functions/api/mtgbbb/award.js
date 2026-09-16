/* ══════════════════════════════════════════════
   MTGBBB AWARD — the host pays out a prize.

   Mirrors bingo/award.js exactly, including why: awarding needs BOTH a
   moderator AND the host of THIS room. Moderator alone would let anyone
   reach into a stranger's game; host alone would let anyone mint entries by
   opening a room and declaring themselves the winner. Neither check is
   enough by itself, so both are required — see the plan's namespace section.

   One prize per player per room, decided inside the mutate() lock so a
   double click or two moderators awarding at once cannot pay twice.
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

  await env.MARKETPLACE.mutate(`mtgbbb_${code}`, (room) => {
    if (!room) { failure = json({ error: 'Game not found' }, 404); return undefined; }

    if (String(session.user_id) !== String(room.host)) {
      failure = json({ error: 'That is not your game.' }, 403);
      return undefined;
    }

    const player = (room.players || []).find(p => p.id === playerId);
    if (!player) { failure = json({ error: 'That player is not in this game.' }, 404); return undefined; }

    room.prizes = Array.isArray(room.prizes) ? room.prizes : [];
    if (room.prizes.some(pr => pr.playerId === playerId)) {
      failure = json({ error: `${player.name} has already been awarded a prize.` }, 409);
      return undefined;
    }

    room.prizes.push({
      playerId,
      name: player.name,
      rarity,
      entries,
      awardedBy: session.display_name || String(session.user_id),
      at: Date.now(),
    });
    awarded = { playerId, name: player.name, rarity, entries };
    return room;
  }, { expirationTtl: GAME_TTL });

  if (failure) return failure;

  const userId = playerId.slice(2); // strip the 'u_' prefix
  let total = 0;
  try {
    const { addEntries } = await import('../giveaway-entries.js');
    total = await addEntries(env, userId, awarded.name, entries, `mtgbbb:${rarity}`);
  } catch (err) {
    console.error('[mtgbbb/award] entry credit failed:', err.message);
  }

  return json({ success: true, ...awarded, total });
}
