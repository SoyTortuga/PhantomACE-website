/* ══════════════════════════════════════════════
   /api/settings — read every account switch in one request

   GET  the signed-in person's own settings, and nothing else. There is no
        POST here on purpose: each switch is already owned by the route that
        enforces it, and writing it from a second place is how two copies of
        one rule drift apart.

          comments / mentions   POST /api/forum/comments { action: 'settings' }
          park visitors         POST /api/dino-park      { action: 'set-visitable' }

        So this is a READER. It exists because the settings page would
        otherwise have to ask the comment wall for two booleans — a forum
        database query, and a 503 for the whole page whenever the forum is
        down — and download an entire Dino Park save to find out whether one
        consent row exists.

   The defaults are NOT re-decided here: profileSwitches() comes from the
   route that enforces them, so an absent field means the same thing on this
   page as it does everywhere else.
   ══════════════════════════════════════════════ */

import { profileSwitches } from './forum/comments.js';
import { saveKey, visitKey } from './dino-park.js';
import { softRead } from './soft-read.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

export async function onRequestGet(context) {
  const { env, request } = context;

  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);
  const me = String(session.user_id);

  /* The park reads are SOFT. A settings page whose privacy switches vanish
     because the dino tables are unhappy is worse than one that says the
     park row is unknown: the two have nothing to do with each other, and
     the switches are the reason anybody opened the page. */
  const [profile, pass, parks] = await Promise.all([
    env.MARKETPLACE.get(`profile_${me}`, 'json'),
    softRead(env.MARKETPLACE.get(visitKey(me), 'json'), 'park visitor consent'),
    softRead(env.MARKETPLACE.list({ prefix: saveKey(me) }), 'park save', { keys: [] }),
  ]);

  const switches = profileSwitches(profile);

  /* An EXACT match, not "the prefix returned something": list() is a LIKE
     query, so the prefix for user 12 also matches user 123's save. */
  const hasPark = ((parks && parks.keys) || []).some(k => k && k.name === saveKey(me));

  return json({
    account: {
      userId: me,
      /* The name and avatar come from the session so this agrees with the
         header on the same page; the login comes from the record, because
         the cookie does not carry it and /user/<login> needs it. */
      displayName: session.display_name || '',
      avatar: typeof session.profile_image === 'string' ? session.profile_image : '',
      login: (profile && profile.login) || '',
      role: session.role || 'visitor',
      firstSeen: (profile && profile.firstSeen) || null,
    },
    /* Somebody can hold a valid cookie with no profile row — the switches
       are stored ON that row, so without one there is nothing to write and
       the page says so rather than failing a save with no explanation. */
    hasProfile: !!profile,
    commentsEnabled: switches.commentsEnabled,
    mentionsEnabled: switches.mentionsEnabled,
    parkVisitable: !!pass,
    hasPark,
  });
}
