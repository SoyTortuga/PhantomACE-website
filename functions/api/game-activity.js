/* ══════════════════════════════════════════════
   GAME ACTIVITY — read-only aggregation, shared infra
   Reports live player counts across the room-based
   multiplayer games (Commander Bingo, Mana Clash,
   PhamShock) by counting players in their existing KV
   room records. Never writes anything; each game's own
   room logic (bingo/*.js, mana-clash.js, pham-shock.js)
   is untouched and remains the source of truth.
   ══════════════════════════════════════════════ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/* One query per prefix instead of a list() followed by a get() per room.
   This endpoint is polled by every open game page, so it was the single
   busiest N+1 in the codebase: three prefixes times one round trip per
   active room, on every poll, from every client. */
async function countRoomPlayers(env, prefix, playersField) {
  const rows = await env.MARKETPLACE.listValues({ prefix });
  let players = 0;
  let rooms = 0;
  for (const { value: room } of rows) {
    if (!room) continue;
    const p = room[playersField];
    const count = Array.isArray(p) ? p.length : (p ? Object.keys(p).length : 0);
    if (count > 0) {
      players += count;
      rooms += 1;
    }
  }
  return { players, rooms };
}

export async function onRequestGet(context) {
  const { env } = context;

  const [bingo, manaClash, phamShock, mtgbbb] = await Promise.all([
    countRoomPlayers(env, 'bingo_', 'players'),
    countRoomPlayers(env, 'mc_room_', 'players'),
    countRoomPlayers(env, 'ps_room_', 'players'),
    /* Resolves to the mtgbbb_rooms table alone: mtgbbb_set_* and
       mtgbbb_current live in other tables, so the cached Scryfall pools --
       the largest values in the store -- are never scanned by this poll. */
    countRoomPlayers(env, 'mtgbbb_', 'players'),
  ]);

  return json({
    'commander-bingo': bingo,
    'mana-clash': manaClash,
    'pham-shock': phamShock,
    'mtgbbb': mtgbbb,
  });
}
