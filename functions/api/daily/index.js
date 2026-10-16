/* ══════════════════════════════════════════════
   /api/daily — the Daily Challenges hub

   GET → the player's picture for today: every live challenge with a done
   flag, how many remain, the cleared-the-whole-day streak, and the meta
   reward. Logged out, it still lists the challenges (so the page sells
   itself) but with no progress.

   All the logic lives in state.js; this is the read endpoint the hub page
   polls. Completions are written by each daily (the Rite here, the games via
   markDailyComplete), never by this route.
   ══════════════════════════════════════════════ */

import { getDailyState, CHALLENGES } from './state.js';

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

  if (!session || !session.user_id) {
    return json({
      loggedIn: false,
      challenges: CHALLENGES.map(c => ({ id: c.id, title: c.title, blurb: c.blurb, href: c.href, icon: c.icon, done: false })),
      total: CHALLENGES.length,
    });
  }

  const state = await getDailyState(env, session.user_id);
  return json({ loggedIn: true, ...state });
}
