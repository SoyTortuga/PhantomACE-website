/* ══════════════════════════════════════════════
   MTGBBB SETS — the room-creation dropdown, and one set's pool.

     GET /api/mtgbbb/sets            the dropdown
     GET /api/mtgbbb/sets?set=dsk    that set's pool and treatment table

   BOTH REQUIRE A MODERATOR, which is stricter than a read endpoint
   usually needs. Either one can miss its cache and go out to Scryfall,
   and Scryfall is a free service run by other people. An open endpoint
   that triggers an outbound fetch is an open invitation to make somebody
   else pay for our traffic, and the only caller that exists is the room
   creation panel, which is moderators-only anyway.

   This is the ONLY place in MTGBBB that may reach Scryfall, and it is
   reachable only before a room exists. Once a room is open its set data is
   frozen into it; a live game does no network I/O at all, because the box
   is being opened on camera and a third party's bad afternoon must not be
   able to stall a pull.
   ══════════════════════════════════════════════ */

import { listPlayableSets, loadSetData, unplayableReason } from '../mtgbbb-scryfall.js';

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

  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can open a game.' }, 403);
  }

  const url = new URL(request.url);
  const code = (url.searchParams.get('set') || '').trim().toLowerCase();

  try {
    if (!code) {
      return json({ sets: await listPlayableSets(env) });
    }

    /* Scryfall set codes are three or four lowercase alphanumerics. Bounded
       here so a long or exotic parameter cannot be reflected into an
       outbound URL. */
    if (!/^[a-z0-9]{3,6}$/.test(code)) return json({ error: 'Unknown set.' }, 400);

    const data = await loadSetData(env, code);

    /* THE UNDER-25 GUARD. Refused here and again in create.js, because a
       grid with holes in it discovered mid-stream — after sixty people have
       joined and a box is half open — is far worse than a refusal nobody
       will ever see on a real set. */
    if (!data.playable) {
      return json({ error: unplayableReason(data), set: data.code, playable: false }, 422);
    }

    return json({ set: data });
  } catch (err) {
    /* A 404 from Scryfall is a set that does not exist; anything else is
       their service being unavailable, and saying so is more useful to a
       moderator than a generic failure. */
    const status = err && err.status === 404 ? 404 : 502;
    return json({
      error: status === 404
        ? 'Scryfall has no such set.'
        : 'Could not reach Scryfall. Try again in a moment.',
    }, status);
  }
}
