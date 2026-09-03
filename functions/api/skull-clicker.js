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

export async function onRequestGet(context) {
  const { env } = context;
  const lb = await env.MARKETPLACE.get(LB_KEY, 'json') || [];
  return json(lb.slice(0, 10));
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

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
