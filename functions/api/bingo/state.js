import { TOTAL_EVENTS } from './squares.js';
import { readPointer, pointerCode, dropStalePointer } from './overlay.js';
import { standings, paidPrizes } from './end.js';
import { refreshStreamNow } from '../stream-now.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
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

/* `?list=1` — every ACTIVE room, for the Overlay Dashboard's room picker.
   Staff-gated (broadcaster/moderators), with one extra door: a bingo host
   may list too, so their own host page could use the same enumeration. The
   codes themselves are not secret (players are told them), so the list is
   not sensitive; the gate keeps it off the public poll, not out of reach.

   listValues({ prefix: 'bingo_' }) returns ONLY room docs — bingo_current
   is a singleton in a different table (see server/lib/registry.js). */
async function listRooms(env, request) {
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  const currentCode = pointerCode(await readPointer(env));

  const rows = await env.MARKETPLACE.listValues({ prefix: 'bingo_' });
  const rooms = [];
  let hostsAny = false;
  let pointerRoomExists = false;
  for (const { value: g } of rows) {
    if (g && g.code && String(g.code).toUpperCase().trim() === currentCode) pointerRoomExists = true;
    if (!g || !g.code || g.status !== 'active') continue;
    if (String(g.host) === String(session.user_id)) hostsAny = true;
    rooms.push({
      code: g.code,
      hostName: g.hostName || ('Host ' + (g.host || g.code)),
      playerCount: Array.isArray(g.players) ? g.players.length : 0,
      createdAt: g.createdAt || 0,
      showOnOverlay: g.showOnOverlay !== false,
      isCurrent: currentCode != null && String(g.code).toUpperCase().trim() === currentCode,
    });
  }

  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session)) && !hostsAny) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  /* A pointer naming a room that expired (or was never written) is "none":
     no row is marked current, and the stale pointer is dropped so the
     overlay stops resolving a game that is not there. */
  if (currentCode && !pointerRoomExists) {
    try { await dropStalePointer(env, currentCode); } catch (err) {
      console.error('[bingo/state] could not drop stale bingo_current:', err.message);
    }
  }

  /* The room on the overlay first, then newest — the order a moderator
     picking a room to show would want them in. */
  rooms.sort((a, b) =>
    (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1) || (b.createdAt - a.createdAt));

  return json({ rooms });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  if (url.searchParams.get('list')) return listRooms(env, request);

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
       force a brand-new game. Sent as an explicit true/false (not just when
       true) so the host page can tell "not the host" apart from "an older
       server that never sent this at all", and treat them differently. */
    out.isHost = String(session.user_id) === String(game.host);

    /* Only the host is told whether the room is the one on stream — it is
       what the host page's overlay switch shows. Kept off every player's
       2-second poll, which has no use for it. */
    if (out.isHost) {
      out.onOverlay = pointerCode(await readPointer(env)) === code;
      /* THE HOST POLL IS THE KEEP-ALIVE. The host page polls this every few
         seconds while open; that slides the unified pointer's TTL forward so a
         quiet-but-live game stays on stream. The public ?current=1 overlay poll
         carries no session, so it never reaches here — close the host tab and
         the pointer lapses within the TTL and the overlay clears itself. Gated
         to onOverlay so a side-room host does not keep the stream pointer up. */
      if (out.onOverlay && game.status === 'active') {
        try { await refreshStreamNow(env, { game: 'bingo', code }); } catch (err) {
          console.error('[bingo/state] could not refresh stream_now:', err.message);
        }
      }
    }

    /* The host's live roster and, once ended, the results and who has been
       paid — so a refreshed host page restores the panel with a real player
       list, and a refresh after ending restores the award screen instead of
       losing it. Counts only, computed here from the room; no cards. */
    if (out.isHost) {
      out.roster = standings(game);
      out.prizes = paidPrizes(game);
      /* Verified `!bingo` claims from chat — server-checked, newest first — so
         the host page can show them and award straight from the list. */
      out.claims = (Array.isArray(game.claims) ? game.claims : [])
        .map(c => ({ playerId: c.playerId, name: c.name, bingos: c.bingos, at: c.at }))
        .sort((a, b) => (b.at || 0) - (a.at || 0));
      if (game.endedAt) out.endedAt = game.endedAt;
    }

    const me = (game.players || []).find(p => p.id === 'u_' + session.user_id);
    if (me) {
      const cards = (Array.isArray(me.cards) && me.cards.length) ? me.cards : [me.cardIds];
      out.you = { cards, wildcards: Array.isArray(me.wildcards) ? me.wildcards : [] };
    }
  }

  return json(out);
}
