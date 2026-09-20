function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function getPlayer(request, body) {
  const session = getSession(request);
  if (session) return { id: session.user_id, name: session.display_name };
  if (body && body.guestId && body.guestName) return { id: 'guest_' + body.guestId, name: body.guestName.slice(0, 20) };
  return null;
}

const LB_KEY = 'sc_leaderboard';
const SAVE_MAX_BYTES = 20000;   /* a real save is a few hundred bytes */

const saveKey = (userId) => `sc_save_${userId}`;

function totalOf(state) {
  const n = state && Number(state.totalSkulls);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function onRequestGet(context) {
  const { env } = context;
  const lb = await env.MARKETPLACE.get(LB_KEY, 'json') || [];
  return json(lb.slice(0, 10));
}

/**
 * Cross-device save, LOGGED-IN PLAYERS ONLY. A guest's id lives in the same
 * localStorage a wipe clears, so there is nothing stable to key their save
 * on — the very failure this fixes would orphan it too.
 *
 * HIGHEST LIFETIME TOTAL WINS, always. totalSkulls only ever climbs, so it
 * is a safe merge key: an old tab or a second device can never clobber a
 * better save, and a cleared browser (local total 0) adopts the server's
 * on load rather than the reverse. The write returns the winner so the
 * client can adopt it when the server's was ahead.
 */
async function saveState(env, session, body) {
  const state = body && body.state;
  if (!state || typeof state !== 'object') return json({ error: 'No state' }, 400);
  if (JSON.stringify(state).length > SAVE_MAX_BYTES) return json({ error: 'Save too large' }, 400);

  const incoming = totalOf(state);
  let winner = state;

  await env.MARKETPLACE.mutate(saveKey(session.user_id), (current) => {
    if (current && totalOf(current) > incoming) {
      winner = current;                 /* server is ahead — keep it, tell the client */
      return undefined;                 /* no write */
    }
    return { ...state, savedAt: Date.now() };
  });

  return json({ success: true, adopted: winner !== state, state: winner });
}

async function loadState(env, session) {
  const state = await env.MARKETPLACE.get(saveKey(session.user_id), 'json');
  return json({ state: state || null });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  /* The save/load pair is login-only, so it checks the session directly
     rather than through getPlayer (which also admits guests). */
  if (body.action === 'save-state' || body.action === 'load-state') {
    const session = getSession(request);
    if (!session || !session.user_id) return json({ error: 'Log in to sync your progress.' }, 401);
    return body.action === 'save-state'
      ? saveState(env, session, body)
      : loadState(env, session);
  }

  if (body.action !== 'submit-score') return json({ error: 'Invalid action' }, 400);

  const player = getPlayer(request, body);
  if (!player) return json({ error: 'Not authenticated' }, 401);

  const score = typeof body.score === 'number' ? Math.floor(body.score) : 0;
  if (score <= 0) return json({ error: 'Invalid score' }, 400);

  const lb = await env.MARKETPLACE.get(LB_KEY, 'json') || [];

  const existing = lb.find(e => e.id === player.id);
  if (existing) {
    if (score > existing.score) {
      existing.score = score;
      existing.name = player.name;
      existing.updatedAt = Date.now();
    } else {
      return json({ success: true, updated: false });
    }
  } else {
    lb.push({ id: player.id, name: player.name, score, updatedAt: Date.now() });
  }

  lb.sort((a, b) => b.score - a.score);
  const trimmed = lb.slice(0, 50);
  await env.MARKETPLACE.put(LB_KEY, JSON.stringify(trimmed));

  return json({ success: true, updated: true });
}
