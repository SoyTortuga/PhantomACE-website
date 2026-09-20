function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
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

  const key = `bingo_${code}`;
  const raw = await env.MARKETPLACE.get(key);
  if (!raw) return json({ error: 'Game not found' }, 404);

  const game = JSON.parse(raw);

  /* The public poll everyone always got. `you` rides along only for a
     session that is actually in the game: it is what lets a refreshed page
     re-derive its marks — called events plus the caller's OWN wildcard
     stamps — instead of a local set a sweep can eat. Nobody is ever handed
     another player's cards or stamps; the host verifies through counts on
     the host page, not by reading cards from here. */
  const out = { calledEvents: game.calledEvents, status: game.status };

  const session = getSession(request);
  if (session && session.user_id) {
    const me = game.players.find(p => p.id === 'u_' + session.user_id);
    if (me) {
      const cards = (Array.isArray(me.cards) && me.cards.length) ? me.cards : [me.cardIds];
      out.you = { cards, wildcards: Array.isArray(me.wildcards) ? me.wildcards : [] };
    }
  }

  return json(out);
}
