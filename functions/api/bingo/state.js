const TOTAL_EVENTS = 68;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* The glanceable summary the overlay panel reads: how far through the called
   squares we are, how many are playing, and who has actually WON (Commander
   Bingo has no per-player score — a winner is someone the host awarded a
   prize to, and that is what "who's winning" means here). Additive to the
   player poll below, and none of it is private: it is all on stream already. */
function overlaySummary(game) {
  const called = Array.isArray(game.calledEvents) ? game.calledEvents.length : 0;
  const winners = (Array.isArray(game.prizes) ? game.prizes : [])
    .map(p => ({ name: p.name, rarity: p.rarity }));
  return {
    calledCount: called,
    total: TOTAL_EVENTS,
    playerCount: Array.isArray(game.players) ? game.players.length : 0,
    winners,
    /* Whether the host has this game on the stream overlay. Absent on games
       from before the toggle existed, which showed by default — so undefined
       reads as shown, and only an explicit false hides. */
    showOnOverlay: game.showOnOverlay !== false,
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  let code = (url.searchParams.get('code') || '').toUpperCase().trim();

  /* `?current=1` (no code) resolves the live room from the bingo_current
     pointer, so the overlay never needs a code in its OBS URL. Same contract
     as mtgbbb's state. */
  if (!code && url.searchParams.get('current')) {
    const current = await env.MARKETPLACE.get('bingo_current', 'json');
    if (!current || !current.code) return json({ error: 'No game running' }, 404);
    code = String(current.code).toUpperCase().trim();
  }

  if (!code) return json({ error: 'Missing code' }, 400);

  const key = `bingo_${code}`;
  const raw = await env.MARKETPLACE.get(key);
  if (!raw) return json({ error: 'Game not found' }, 404);

  const game = JSON.parse(raw);

  /* The public poll everyone always got, now carrying the overlay summary
     alongside. `you` rides along only for a session that is actually in the
     game: it is what lets a refreshed page re-derive its marks — called
     events plus the caller's OWN wildcard stamps — instead of a local set a
     sweep can eat. Nobody is ever handed another player's cards or stamps;
     the host verifies through counts on the host page, not by reading cards
     from here. */
  const out = {
    code: game.code,
    calledEvents: game.calledEvents,
    status: game.status,
    ...overlaySummary(game),
  };

  const session = getSession(request);
  if (session && session.user_id) {
    /* The host can lose their connection and come back — the host page reads
       this to know it may restore the control panel for this room rather than
       force a brand-new game. Only the true host is ever told so. */
    if (String(session.user_id) === String(game.host)) out.isHost = true;

    const me = game.players.find(p => p.id === 'u_' + session.user_id);
    if (me) {
      const cards = (Array.isArray(me.cards) && me.cards.length) ? me.cards : [me.cardIds];
      out.you = { cards, wildcards: Array.isArray(me.wildcards) ? me.wildcards : [] };
    }
  }

  return json(out);
}
