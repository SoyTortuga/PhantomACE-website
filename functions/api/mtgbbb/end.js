/* ══════════════════════════════════════════════
   MTGBBB END — closes the room to new pulls.

   Any moderator or broadcaster, not only the host — same reasoning as
   mark.js. Ending does not settle prizes: award.js is the separate,
   host-locked step that actually pays those out, exactly like bingo.

   Two side effects fire once, on the actual active-to-ended transition
   only — never on a repeated end call, which is why they live inside the
   `justEnded` branch rather than after every call to this route:

     - mtgbbb_current is cleared, but ONLY if it still points at this room.
       A stale end call on an old room must not blank the pointer out from
       under a different game that started after it.
     - Every player's final score is folded into lb_mtgbbb, the site's
       ordinary monthly-reset leaderboard (see leaderboards.js) — the same
       machinery commander-bingo and mana-clash already ride, not a new
       per-month key of MTGBBB's own.
   ══════════════════════════════════════════════ */

import { standings } from '../mtgbbb-scoring.js';

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
    return json({ error: 'Only the broadcaster and moderators can end a game.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = String(body.code || '').toUpperCase().trim();
  if (!code) return json({ error: 'Missing code' }, 400);

  let failure = null;
  let final = null;
  let justEnded = false;

  await env.MARKETPLACE.mutate(`mtgbbb_${code}`, (room) => {
    if (!room) { failure = json({ error: 'Game not found' }, 404); return undefined; }
    if (room.status === 'ended') { final = room; return undefined; }

    room.status = 'ended';
    room.endedAt = Date.now();
    final = room;
    justEnded = true;
    return room;
  }, { expirationTtl: GAME_TTL });

  if (failure) return failure;

  const board = standings(final.players, final.pulls)
    .map(p => ({ id: p.id, name: p.name, points: p.points, marks: p.marks, blackout: p.blackout }));

  if (justEnded) {
    try {
      const current = await env.MARKETPLACE.get('mtgbbb_current', 'json');
      if (current && current.code === code) await env.MARKETPLACE.delete('mtgbbb_current');
    } catch (err) {
      console.error('[mtgbbb/end] could not clear mtgbbb_current:', err.message);
    }

    /* Every player who scored above zero, not only the winner — a strong
       showing in a losing seat still deserves to register on the board.
       Best score kept, exactly like Mana Clash's SCORE_BOARD. */
    try {
      await env.MARKETPLACE.mutate('lb_mtgbbb', (lb) => {
        const list = Array.isArray(lb) ? lb : [];
        for (const p of board) {
          if (p.points <= 0) continue;
          const row = list.find(e => e.id === p.id);
          if (row) {
            if (p.points > row.score) { row.score = p.points; row.updatedAt = Date.now(); }
            row.name = p.name;
          } else {
            list.push({ id: p.id, name: p.name, score: p.points, updatedAt: Date.now() });
          }
        }
        list.sort((a, b) => b.score - a.score);
        return list.slice(0, 50);
      });
    } catch (err) {
      console.error('[mtgbbb/end] could not update lb_mtgbbb:', err.message);
    }
  }

  return json({ success: true, standings: board });
}
