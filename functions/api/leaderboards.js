/* ══════════════════════════════════════════════
   LEADERBOARDS API
   Unified leaderboard storage for all games
   ══════════════════════════════════════════════ */

const MAX_ENTRIES = 50;

const BOARDS = {
  'skull-clicker':    { key: 'sc_leaderboard',  label: 'High Score',  sort: 'desc' },
  'memory-match':     { key: 'lb_memory_match', label: 'Best Moves',  sort: 'asc' },
  'commander-bingo':  { key: 'lb_bingo',        label: 'Bingos',      sort: 'desc' },
  'mana-clash':       { key: 'lb_mana_clash',   label: 'High Score',  sort: 'desc' },
  'phamily-time':     { key: 'lb_phamily_time', label: 'Hours',       sort: 'desc' },
};

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

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const game = url.searchParams.get('game');

  if (game === 'all') {
    const result = {};
    for (const [name, board] of Object.entries(BOARDS)) {
      const data = await env.MARKETPLACE.get(board.key, 'json') || [];
      result[name] = data.slice(0, 10);
    }
    return json(result);
  }

  if (game && BOARDS[game]) {
    const data = await env.MARKETPLACE.get(BOARDS[game].key, 'json') || [];
    return json(data.slice(0, 10));
  }

  return json({ error: 'Specify ?game=all or ?game=<name>' }, 400);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const game = body.game;
  if (!game || !BOARDS[game]) return json({ error: 'Invalid game' }, 400);

  const player = getPlayer(request, body);
  if (!player) return json({ error: 'Not authenticated' }, 401);

  const score = typeof body.score === 'number' ? body.score : 0;
  if (score <= 0) return json({ error: 'Invalid score' }, 400);

  const board = BOARDS[game];
  const lb = await env.MARKETPLACE.get(board.key, 'json') || [];

  const existing = lb.find(e => e.id === player.id);
  if (existing) {
    const isBetter = board.sort === 'asc'
      ? score < existing.score
      : score > existing.score;
    if (isBetter) {
      existing.score = board.sort === 'asc' ? Math.round(score) : Math.floor(score);
      existing.name = player.name;
      existing.updatedAt = Date.now();
    } else {
      return json({ success: true, updated: false });
    }
  } else {
    lb.push({
      id: player.id,
      name: player.name,
      score: board.sort === 'asc' ? Math.round(score) : Math.floor(score),
      updatedAt: Date.now(),
    });
  }

  lb.sort((a, b) => board.sort === 'asc' ? a.score - b.score : b.score - a.score);
  const trimmed = lb.slice(0, MAX_ENTRIES);
  await env.MARKETPLACE.put(board.key, JSON.stringify(trimmed));

  return json({ success: true, updated: true });
}
