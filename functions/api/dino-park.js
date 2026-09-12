/* ══════════════════════════════════════════════
   DINO PARK API
   Cross-device save sync for logged-in players.
   Guests keep localStorage-only saves (see games/dino-park/index.html);
   this endpoint exists purely so a logged-in player's park follows
   their Twitch account across devices.
   ══════════════════════════════════════════════ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function saveKey(userId) {
  return `dino_park_${userId}`;
}

/* ── GET — fetch the player's cloud save ──────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);

  const record = await env.MARKETPLACE.get(saveKey(session.user_id), 'json');
  if (!record) return json({ hasSave: false, state: null });

  return json({ hasSave: true, state: record.state, savedAt: record.savedAt || 0 });
}

/* ── POST — persist the player's current state ── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (!body || typeof body.state !== 'object' || body.state === null) {
    return json({ error: 'Missing state' }, 400);
  }

  const record = { userId: session.user_id, state: body.state, savedAt: Date.now() };
  await env.MARKETPLACE.put(saveKey(session.user_id), JSON.stringify(record));

  return json({ success: true, savedAt: record.savedAt });
}
