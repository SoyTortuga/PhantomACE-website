const FACES = ['W','U','B','R','G','C'];
const VALUES = { W:1, U:2, B:3, R:4, G:5, C:6 };
const ROUND_MS = 30000;
const MAX_PLAYERS = 8;
const MAX_ROUNDS = 12;
const ROOM_TTL = 7200;
const SLOT_ORDER = ['mono','guild','shard','nephilim','wubrgc','white','blue','black','red','green','colorless','wild'];

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function getPlayer(request, body) {
  const session = getSession(request);
  if (session) return { userId: session.user_id, displayName: session.display_name, profileImage: session.profile_image || null };
  if (body && body.guestId && body.guestName) return { userId: 'guest_' + body.guestId, displayName: body.guestName.slice(0, 20), profileImage: null };
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function validateDice(dice) {
  return Array.isArray(dice) && dice.length === 6 && dice.every(f => FACES.includes(f));
}

function countFaces(dice) {
  const c = {}; FACES.forEach(f => c[f] = 0); dice.forEach(f => c[f]++); return c;
}

function validateSlot(slotId, dice) {
  const counts = countFaces(dice);
  const colorDice = dice.filter(f => f !== 'C');
  const colorDistinct = new Set(colorDice).size;
  const colorCounts = {};
  ['W','U','B','R','G'].forEach(f => { if (counts[f] > 0) colorCounts[f] = counts[f]; });
  const colorVals = Object.values(colorCounts).sort((a, b) => b - a);
  switch (slotId) {
    case 'mono': return colorDice.length === 6 && colorDistinct === 1;
    case 'guild': return colorDice.length === 6 && colorDistinct === 2 && colorVals[0] === 3 && colorVals[1] === 3;
    case 'shard': return colorDice.length === 6 && colorDistinct === 3 && colorVals.every(v => v === 2);
    case 'nephilim': return colorDistinct === 4;
    case 'wubrgc': return new Set(dice).size === 6;
    case 'white': return counts.W >= 4;
    case 'blue': return counts.U >= 4;
    case 'black': return counts.B >= 4;
    case 'red': return counts.R >= 4;
    case 'green': return counts.G >= 4;
    case 'colorless': return counts.C >= 4;
    case 'wild': return true;
    default: return false;
  }
}

function scoreSlot(slotId, dice) {
  switch (slotId) {
    case 'mono': return 50;
    case 'guild': return 20;
    case 'shard': return 25;
    case 'nephilim': return 30;
    case 'wubrgc': return 60;
    default: return dice.reduce((s, f) => s + VALUES[f], 0);
  }
}

function getBottomSlot(scores) {
  for (let i = SLOT_ORDER.length - 1; i >= 0; i--) {
    if (!scores.hasOwnProperty(SLOT_ORDER[i])) return SLOT_ORDER[i];
  }
  return null;
}

function advanceRound(room) {
  for (const p of Object.values(room.players)) {
    if (!p.busted && !p.roundSubmitted) {
      const slot = getBottomSlot(p.scores);
      if (slot) {
        p.scores[slot] = 0;
        p.lastSlot = slot;
        p.lastScore = 0;
      } else {
        p.busted = true;
      }
    }
    p.roundSubmitted = false;
  }
  const active = Object.values(room.players).filter(p => !p.busted);
  if (active.length === 0 || room.round >= MAX_ROUNDS) {
    room.status = 'finished';
    room.roundStartedAt = null;
  } else {
    room.round++;
    room.roundStartedAt = Date.now();
  }
}

function addTimeLeft(room) {
  if (room.status === 'playing' && room.roundStartedAt) {
    room.roundTimeLeft = Math.max(0, ROUND_MS - (Date.now() - room.roundStartedAt));
  } else {
    room.roundTimeLeft = 0;
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'list-rooms') {
    const list = await env.MARKETPLACE.list({ prefix: 'mc_room_' });
    const rooms = [];
    for (const key of list.keys) {
      const room = await env.MARKETPLACE.get(key.name, 'json');
      if (room && room.status === 'lobby') {
        rooms.push({
          code: room.code, host: room.hostName,
          playerCount: Object.keys(room.players).length,
          maxPlayers: MAX_PLAYERS, hasPassword: !!room.password,
        });
      }
    }
    return json(rooms);
  }

  if (action === 'get-state') {
    const code = url.searchParams.get('code');
    if (!code) return json({ error: 'Missing room code' }, 400);
    const room = await env.MARKETPLACE.get('mc_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);

    while (room.status === 'playing' && room.roundStartedAt && Date.now() - room.roundStartedAt >= ROUND_MS) {
      advanceRound(room);
    }
    if (room.status !== 'lobby') {
      await env.MARKETPLACE.put('mc_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    }
    addTimeLeft(room);
    return json(room);
  }

  return json({ error: 'Invalid action' }, 400);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const player = getPlayer(request, body);
  if (!player) return json({ error: 'Login or provide a guest name to play.' }, 401);
  const { userId, displayName, profileImage } = player;

  if (body.action === 'create-room') {
    let code, exists;
    for (let i = 0; i < 10; i++) { code = generateCode(); exists = await env.MARKETPLACE.get('mc_room_' + code); if (!exists) break; }
    if (exists) return json({ error: 'Could not generate room code' }, 500);

    const room = {
      code, host: userId, hostName: displayName,
      password: body.password || null, status: 'lobby',
      round: 0, roundStartedAt: null,
      players: { [userId]: { displayName, profileImage, scores: {}, busted: false, roundSubmitted: false, totalScore: 0 } },
      createdAt: Date.now(),
    };
    await env.MARKETPLACE.put('mc_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    return json({ success: true, code });
  }

  if (body.action === 'join-room') {
    const code = (body.code || '').toUpperCase().trim();
    if (!code) return json({ error: 'Missing room code' }, 400);
    const room = await env.MARKETPLACE.get('mc_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);
    if (room.status !== 'lobby') return json({ error: 'Game already started' }, 400);
    if (Object.keys(room.players).length >= MAX_PLAYERS) return json({ error: 'Room is full' }, 400);
    if (room.password && body.password !== room.password) return json({ error: 'Wrong password' }, 403);

    room.players[userId] = { displayName, profileImage, scores: {}, busted: false, roundSubmitted: false, totalScore: 0 };
    await env.MARKETPLACE.put('mc_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    return json({ success: true, code });
  }

  if (body.action === 'leave-room') {
    const code = body.code;
    if (!code) return json({ error: 'Missing room code' }, 400);
    const room = await env.MARKETPLACE.get('mc_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);
    delete room.players[userId];
    if (Object.keys(room.players).length === 0) { await env.MARKETPLACE.delete('mc_room_' + code); return json({ success: true }); }
    if (room.host === userId) { const nh = Object.keys(room.players)[0]; room.host = nh; room.hostName = room.players[nh].displayName; }
    await env.MARKETPLACE.put('mc_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    return json({ success: true });
  }

  if (body.action === 'start-game') {
    const code = body.code;
    if (!code) return json({ error: 'Missing room code' }, 400);
    const room = await env.MARKETPLACE.get('mc_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);
    if (room.host !== userId) return json({ error: 'Only the host can start' }, 403);
    if (room.status !== 'lobby') return json({ error: 'Already started' }, 400);
    room.status = 'playing'; room.round = 1; room.roundStartedAt = Date.now();
    for (const p of Object.values(room.players)) { p.roundSubmitted = false; }
    await env.MARKETPLACE.put('mc_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    addTimeLeft(room);
    return json({ success: true, room });
  }

  if (body.action === 'submit-round') {
    const code = body.code;
    if (!code) return json({ error: 'Missing room code' }, 400);
    const room = await env.MARKETPLACE.get('mc_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);
    if (room.status !== 'playing') return json({ error: 'Game not in progress' }, 400);

    while (room.roundStartedAt && Date.now() - room.roundStartedAt >= ROUND_MS) { advanceRound(room); }

    const p = room.players[userId];
    if (!p) return json({ error: 'Not in this room' }, 403);
    if (p.busted) return json({ error: 'You are busted' }, 400);
    if (p.roundSubmitted) return json({ error: 'Already submitted' }, 400);
    if (body.round !== room.round) return json({ error: 'Round mismatch' }, 400);

    if (body.slotId === '__bust__') {
      p.busted = true; p.roundSubmitted = true; p.bustedRound = room.round;
    } else {
      if (!validateDice(body.dice)) return json({ error: 'Invalid dice' }, 400);
      if (p.scores.hasOwnProperty(body.slotId)) return json({ error: 'Slot already used' }, 400);
      const valid = validateSlot(body.slotId, body.dice);
      const score = valid ? scoreSlot(body.slotId, body.dice) : 0;
      p.scores[body.slotId] = score; p.totalScore += score; p.roundSubmitted = true;
      p.lastSlot = body.slotId; p.lastScore = score;
    }

    const allDone = Object.values(room.players).every(pl => pl.busted || pl.roundSubmitted);
    if (allDone) {
      for (const pl of Object.values(room.players)) pl.roundSubmitted = false;
      const active = Object.values(room.players).filter(pl => !pl.busted);
      if (active.length === 0 || room.round >= MAX_ROUNDS) { room.status = 'finished'; room.roundStartedAt = null; }
      else { room.round++; room.roundStartedAt = Date.now(); }
    }

    await env.MARKETPLACE.put('mc_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    addTimeLeft(room);
    return json({ success: true, room });
  }

  return json({ error: 'Invalid action' }, 400);
}
