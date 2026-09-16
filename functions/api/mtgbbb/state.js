/* ══════════════════════════════════════════════
   MTGBBB STATE — the poll every open page hits every 2s.

   PUBLIC, no login required: the overlay and the moderator panel both need
   it, and a room code is not a secret (players are told it, same as every
   other room-based game here). What IS gated is per-player detail — a
   session identifies "you" and gets a scored card back; everyone else's
   card contents never leave the server, only their name and point total.

   THE POOL IS NOT PRIVATE — it is the same 25+ names for everyone in the
   room, just dealt onto different cards, so it comes back on every poll.
   The moderator panel's type-ahead search is what actually needs it; the
   player page uses its own slice via `you.card` instead.

   Scoring happens HERE, on every poll, from mtgbbb-scoring's pure
   functions — never stored. The alternative (storing points on the player
   record and updating them in mark.js) would need every write path to stay
   in sync with the scoring rules forever; recomputing from room.pulls each
   read means there is exactly one place scoring can be wrong.
   ══════════════════════════════════════════════ */

import { scoreCard, oneAway, standings } from '../mtgbbb-scoring.js';

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

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').toUpperCase().trim();
  if (!code) return json({ error: 'Missing code' }, 400);

  const raw = await env.MARKETPLACE.get(`mtgbbb_${code}`, 'json');
  if (!raw) return json({ error: 'Game not found' }, 404);
  const room = raw;

  const board = standings(room.players, room.pulls)
    .map(p => ({ id: p.id, name: p.name, points: p.points, marks: p.marks, blackout: p.blackout }));

  const recentPulls = room.pulls.slice(-50).reverse();

  const out = {
    code: room.code,
    status: room.status,
    hostName: room.hostName,
    setCode: room.setCode,
    setName: room.setName,
    setIcon: room.setIcon,
    boxes: room.boxes,
    packCount: room.packCount,
    packsOpened: room.packsOpened,
    treatments: room.treatments,
    pool: room.pool,
    pullCount: room.pulls.length,
    playerCount: room.players.length,
    standings: board,
    recentPulls,
  };

  const session = getSession(request);
  if (session && session.user_id) {
    const me = room.players.find(p => p.id === 'u_' + session.user_id);
    if (me) {
      const scored = scoreCard(me.card, room.pulls);
      const byName = new Map(room.pool.map(c => [c.name, c]));
      out.you = {
        id: me.id,
        name: me.name,
        card: me.card.map((name, i) => ({
          name,
          marked: scored.marked[i],
          rarity: byName.get(name) ? byName.get(name).rarity : '',
          image: byName.get(name) ? byName.get(name).image : '',
        })),
        marks: scored.marks,
        treatments: scored.treatments,
        lines: scored.lines.map(l => l.id),
        blackout: scored.blackout,
        points: scored.points,
        breakdown: scored.breakdown,
        oneAway: oneAway(scored.marked),
      };
    }
  }

  return json(out);
}
