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

async function countRoomPlayers(env, prefix, playersField) {
  const list = await env.MARKETPLACE.list({ prefix });
  let players = 0;
  let rooms = 0;
  for (const key of list.keys) {
    const room = await env.MARKETPLACE.get(key.name, 'json');
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

  const [bingo, manaClash, phamShock] = await Promise.all([
    countRoomPlayers(env, 'bingo_', 'players'),
    countRoomPlayers(env, 'mc_room_', 'players'),
    countRoomPlayers(env, 'ps_room_', 'players'),
  ]);

  return json({
    'commander-bingo': bingo,
    'mana-clash': manaClash,
    'pham-shock': phamShock,
  });
}
