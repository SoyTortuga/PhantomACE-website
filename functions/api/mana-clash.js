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

function rollFace() { return FACES[Math.floor(Math.random() * FACES.length)]; }

function freshLock() { return [false, false, false, false, false, false]; }

function ensurePlayerRoundFields(p) {
  if (p.dice === undefined) p.dice = null;
  if (!Array.isArray(p.locked) || p.locked.length !== 6) p.locked = freshLock();
  if (typeof p.rollsLeft !== 'number') p.rollsLeft = 3;
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
    p.dice = null;
    p.locked = freshLock();
    p.rollsLeft = 3;
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

/* ==============================================
   ROOM WRITES

   Every write below goes through mutate(), which holds a per-room advisory
   lock across the read-modify-write. The old shape - get, modify, put - is a
   lost update whenever two players act inside the same tick, and with
   simultaneous rounds that is the ordinary case rather than a rare one: two
   people roll at once, both read the same room, and the second put erases
   the first roll. It would have shown up as a die that visibly rolled and
   then wasn't there.

   `fn` mutates the room in place and returns a Response to abort. Aborting
   returns `undefined` from the mutator, so mutate() writes nothing at all -
   a rejected action cannot leave a partial change behind.
   ============================================== */

async function withRoom(env, code, fn) {
  let failed = null;
  const room = await env.MARKETPLACE.mutate('mc_room_' + code, (current) => {
    if (!current) { failed = json({ error: 'Room not found' }, 404); return undefined; }
    const err = fn(current);
    if (err) { failed = err; return undefined; }
    return current;
  }, { expirationTtl: ROOM_TTL });
  return { failed, room };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'list-rooms') {
    // One query rather than a list() plus a get() per room.
    const rows = await env.MARKETPLACE.listValues({ prefix: 'mc_room_' });
    const rooms = [];
    for (const { value: room } of rows) {
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

    /* Writes only when a round actually advanced. This used to put() on
       every poll of every non-lobby room - with a full room polling every
       two seconds that is fifty writes a second to one row, all but one of
       them storing what was already there. Returning undefined when nothing
       changed skips the write entirely. */
    const room = await env.MARKETPLACE.mutate('mc_room_' + code, (current) => {
      if (!current) return undefined;
      let changed = false;
      while (current.status === 'playing' && current.roundStartedAt &&
             Date.now() - current.roundStartedAt >= ROUND_MS) {
        advanceRound(current);
        changed = true;
      }
      return changed ? current : undefined;
    }, { expirationTtl: ROOM_TTL });

    if (!room) return json({ error: 'Room not found' }, 404);
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
    /* The claim on the code is the write itself. Checking with get() and
       then put()ing let two simultaneous creates pick the same code, and the
       second silently replaced the first room out from under its host. */
    let code = null;
    for (let i = 0; i < 10; i++) {
      const candidate = generateCode();
      const fresh = {
        code: candidate, host: userId, hostName: displayName,
        password: body.password || null, status: 'lobby',
        round: 0, roundStartedAt: null,
        players: { [userId]: { displayName, profileImage, scores: {}, busted: false, roundSubmitted: false, totalScore: 0, dice: null, locked: freshLock(), rollsLeft: 3 } },
        createdAt: Date.now(),
      };
      const stored = await env.MARKETPLACE.mutate('mc_room_' + candidate,
        (current) => current ? undefined : fresh,
        { expirationTtl: ROOM_TTL });
      if (stored === fresh) { code = candidate; break; }
    }
    if (!code) return json({ error: 'Could not generate room code' }, 500);
    return json({ success: true, code });
  }

  if (body.action === 'join-room') {
    const code = (body.code || '').toUpperCase().trim();
    if (!code) return json({ error: 'Missing room code' }, 400);

    const { failed } = await withRoom(env, code, (room) => {
      if (room.status !== 'lobby') return json({ error: 'Game already started' }, 400);
      if (Object.keys(room.players).length >= MAX_PLAYERS) return json({ error: 'Room is full' }, 400);
      if (room.password && body.password !== room.password) return json({ error: 'Wrong password' }, 403);
      room.players[userId] = { displayName, profileImage, scores: {}, busted: false, roundSubmitted: false, totalScore: 0, dice: null, locked: freshLock(), rollsLeft: 3 };
      return null;
    });
    if (failed) return failed;
    return json({ success: true, code });
  }

  if (body.action === 'leave-room') {
    const code = body.code;
    if (!code) return json({ error: 'Missing room code' }, 400);

    let emptied = false;
    const { failed } = await withRoom(env, code, (room) => {
      delete room.players[userId];
      if (Object.keys(room.players).length === 0) { emptied = true; return null; }
      if (room.host === userId) {
        const nh = Object.keys(room.players)[0];
        room.host = nh;
        room.hostName = room.players[nh].displayName;
      }
      return null;
    });
    if (failed) return failed;
    /* Deleted outside the lock. A join landing in the gap writes into a room
       that is about to vanish, which costs that player a rejoin - the
       alternative, holding a write lock across a delete, is not something
       mutate() offers, and an empty room is the one state where losing the
       write costs nothing. */
    if (emptied) await env.MARKETPLACE.delete('mc_room_' + code);
    return json({ success: true });
  }

  if (body.action === 'start-game') {
    const code = body.code;
    if (!code) return json({ error: 'Missing room code' }, 400);

    const { failed, room } = await withRoom(env, code, (r) => {
      if (r.host !== userId) return json({ error: 'Only the host can start' }, 403);
      if (r.status !== 'lobby') return json({ error: 'Already started' }, 400);
      r.status = 'playing'; r.round = 1; r.roundStartedAt = Date.now();
      for (const p of Object.values(r.players)) { p.roundSubmitted = false; p.dice = null; p.locked = freshLock(); p.rollsLeft = 3; }
      return null;
    });
    if (failed) return failed;
    addTimeLeft(room);
    return json({ success: true, room });
  }

  if (body.action === 'roll-dice') {
    const code = body.code;
    if (!code) return json({ error: 'Missing room code' }, 400);

    const { failed, room } = await withRoom(env, code, (r) => {
      if (r.status !== 'playing') return json({ error: 'Game not in progress' }, 400);
      while (r.roundStartedAt && Date.now() - r.roundStartedAt >= ROUND_MS) { advanceRound(r); }

      const p = r.players[userId];
      if (!p) return json({ error: 'Not in this room' }, 403);
      ensurePlayerRoundFields(p);
      if (p.busted) return json({ error: 'You are busted' }, 400);
      if (p.roundSubmitted) return json({ error: 'Already submitted' }, 400);
      if (body.round !== r.round) return json({ error: 'Round mismatch' }, 400);
      if (p.rollsLeft <= 0) return json({ error: 'No rolls left' }, 400);

      const lockedIn = Array.isArray(body.locked) && body.locked.length === 6 ? body.locked.map(Boolean) : freshLock();
      if (!p.dice) {
        p.dice = Array.from({ length: 6 }, rollFace);
      } else {
        p.dice = p.dice.map((f, i) => lockedIn[i] ? f : rollFace());
      }
      p.locked = lockedIn;
      p.rollsLeft--;
      return null;
    });
    if (failed) return failed;
    addTimeLeft(room);
    return json({ success: true, room });
  }

  if (body.action === 'submit-round') {
    const code = body.code;
    if (!code) return json({ error: 'Missing room code' }, 400);

    const { failed, room } = await withRoom(env, code, (r) => {
      if (r.status !== 'playing') return json({ error: 'Game not in progress' }, 400);
      while (r.roundStartedAt && Date.now() - r.roundStartedAt >= ROUND_MS) { advanceRound(r); }

      const p = r.players[userId];
      if (!p) return json({ error: 'Not in this room' }, 403);
      ensurePlayerRoundFields(p);
      if (p.busted) return json({ error: 'You are busted' }, 400);
      if (p.roundSubmitted) return json({ error: 'Already submitted' }, 400);
      if (body.round !== r.round) return json({ error: 'Round mismatch' }, 400);

      if (body.slotId === '__bust__') {
        p.busted = true; p.roundSubmitted = true; p.bustedRound = r.round;
      } else {
        const dice = p.dice;
        if (!validateDice(dice)) return json({ error: 'Roll dice before submitting' }, 400);
        if (p.scores.hasOwnProperty(body.slotId)) return json({ error: 'Slot already used' }, 400);
        const valid = validateSlot(body.slotId, dice);
        const score = valid ? scoreSlot(body.slotId, dice) : 0;
        p.scores[body.slotId] = score; p.totalScore += score; p.roundSubmitted = true;
        p.lastSlot = body.slotId; p.lastScore = score;
      }

      const allDone = Object.values(r.players).every(pl => pl.busted || pl.roundSubmitted);
      if (allDone) {
        for (const pl of Object.values(r.players)) { pl.roundSubmitted = false; pl.dice = null; pl.locked = freshLock(); pl.rollsLeft = 3; }
        const active = Object.values(r.players).filter(pl => !pl.busted);
        if (active.length === 0 || r.round >= MAX_ROUNDS) { r.status = 'finished'; r.roundStartedAt = null; }
        else { r.round++; r.roundStartedAt = Date.now(); }
      }
      return null;
    });
    if (failed) return failed;
    addTimeLeft(room);
    return json({ success: true, room });
  }

  return json({ error: 'Invalid action' }, 400);
}
