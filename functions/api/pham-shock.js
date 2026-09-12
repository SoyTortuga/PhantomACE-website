const GAME_W = 960;
const GAME_H = 500;
const MAX_PLAYERS = 16;
const ROUND_MS = 30000;
const RESOLVE_MS = 6000;
const MAX_ROUNDS = 50;
const ROOM_TTL = 7200;

const WEAPONS = [
  { radius: 20, damage: 25, ammo: 999, splitter: false },
  { radius: 35, damage: 40, ammo: 3, splitter: false },
  { radius: 10, damage: 35, ammo: 3, splitter: false },
  { radius: 55, damage: 60, ammo: 1, splitter: false },
  { radius: 15, damage: 18, ammo: 2, splitter: true },
];

function json(data, s = 200) {
  return new Response(JSON.stringify(data), { status: s, headers: { 'Content-Type': 'application/json' } });
}

function getSession(req) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(/pham_session=([^;]+)/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
}

function getPlayer(req, body) {
  const s = getSession(req);
  if (s) return { id: s.user_id, name: s.display_name, img: s.profile_image || null };
  if (body && body.guestId && body.guestName) return { id: 'guest_' + body.guestId, name: body.guestName.slice(0, 20), img: null };
  return null;
}

function nextColor(players, excludeId) {
  const used = new Set(Object.entries(players).filter(([id]) => id !== excludeId).map(([, p]) => p.color));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return 0;
}

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 4; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

function mulberry32(s) {
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeTerrain(seed) {
  const rng = mulberry32(seed);
  const t = new Array(GAME_W);
  const base = GAME_H * 0.35, amp = GAME_H * 0.2;
  const n = 3 + Math.floor(rng() * 4);
  const offs = [];
  for (let i = 0; i < n; i++) {
    offs.push({
      f: (0.5 + rng() * 2) / GAME_W * Math.PI * 2,
      p: rng() * Math.PI * 2,
      a: (0.3 + rng() * 0.7) * amp / n,
    });
  }
  for (let x = 0; x < GAME_W; x++) {
    let h = base;
    for (const o of offs) h += Math.sin(x * o.f + o.p) * o.a;
    t[x] = Math.round(Math.max(30, Math.min(GAME_H - 30, h)));
  }
  return t;
}

function digTerrain(t, cx, cy, r) {
  for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(GAME_W, Math.ceil(cx + r)); x++) {
    const dx = x - cx, md = Math.sqrt(Math.max(0, r * r - dx * dx));
    const sy = GAME_H - t[x], top = cy - md, bot = cy + md;
    if (bot > sy) t[x] = Math.max(0, t[x] - Math.round(bot - Math.max(sy, top)));
  }
}

function tY(t, x) { return GAME_H - t[Math.max(0, Math.min(GAME_W - 1, Math.round(x)))]; }

function simShot(sx, sy, vx, vy, terrain, wind, tanks) {
  let x = sx, y = sy;
  for (let i = 0; i < 2000; i++) {
    x += vx; y += vy; vy += 0.15; vx += wind * 0.003;
    if (x < -50 || x > GAME_W + 50 || y > GAME_H + 50) return null;
    if (y >= tY(terrain, x)) return { x, y };
    for (const tk of tanks) {
      if (Math.abs(x - tk.x) < 14 && Math.abs(y - (tY(terrain, tk.x) - 4)) < 12) return { x, y };
    }
  }
  return null;
}

function applyDamage(hit, weapon, alive, terrain, dmg) {
  for (const tk of alive) {
    const d = Math.sqrt((hit.x - tk.x) ** 2 + (hit.y - tY(terrain, tk.x)) ** 2);
    if (d < weapon.radius + 14) {
      const f = 1 - (d / (weapon.radius + 14)) * 0.5;
      dmg[tk.id] = (dmg[tk.id] || 0) + Math.floor(weapon.damage * f);
    }
  }
}

function resolve(room) {
  const terrain = makeTerrain(room.terrainSeed);
  for (const e of room.explosions) digTerrain(terrain, e.x, e.y, e.r);

  const alive = [];
  for (const [id, p] of Object.entries(room.players)) {
    if (!p.eliminated) alive.push({ id, x: p.x });
  }

  const results = [], newExp = [], dmg = {};

  for (const [id, p] of Object.entries(room.players)) {
    if (p.eliminated || !p.submitted) continue;
    const s = p.submission, w = WEAPONS[s.weapon] || WEAPONS[0];
    const aRad = -s.angle * Math.PI / 180, pwr = s.power * 0.14;
    const sx = p.x + Math.cos(aRad) * 18;
    const sy = tY(terrain, p.x) - 8 + Math.sin(aRad) * 18;
    const vx = Math.cos(aRad) * pwr, vy = Math.sin(aRad) * pwr;

    const hit = simShot(sx, sy, vx, vy, terrain, room.wind, alive);
    const r = { pid: id, sx, sy, vx, vy, wi: s.weapon, hit: !!hit, hx: hit ? hit.x : 0, hy: hit ? hit.y : 0, subs: [] };

    if (hit) {
      newExp.push({ x: hit.x, y: hit.y, r: w.radius });
      digTerrain(terrain, hit.x, hit.y, w.radius);
      applyDamage(hit, w, alive, terrain, dmg);

      if (w.splitter) {
        for (let j = 0; j < 4; j++) {
          const a2 = -Math.PI * 0.2 - Math.random() * Math.PI * 0.6;
          const dir = Math.random() > 0.5 ? 1 : -1;
          const svx = Math.cos(a2) * (2 + Math.random() * 2) * dir;
          const svy = Math.sin(a2) * (3 + Math.random() * 2);
          const sh = simShot(hit.x, hit.y - 5, svx, svy, terrain, room.wind, alive);
          if (sh) {
            newExp.push({ x: sh.x, y: sh.y, r: w.radius });
            digTerrain(terrain, sh.x, sh.y, w.radius);
            r.subs.push({ x: sh.x, y: sh.y, svx, svy });
            applyDamage(sh, w, alive, terrain, dmg);
          }
        }
      }
    }
    results.push(r);
  }

  for (const [id, d] of Object.entries(dmg)) {
    const p = room.players[id];
    if (p) { p.hp = Math.max(0, p.hp - d); if (p.hp <= 0) p.eliminated = true; }
  }

  for (const p of Object.values(room.players)) {
    if (p.submitted && p.submission) {
      const wi = p.submission.weapon;
      if (WEAPONS[wi] && WEAPONS[wi].ammo !== 999) {
        p.ammo[wi] = Math.max(0, (p.ammo[wi] || 0) - 1);
      }
    }
    p.submitted = false;
    p.submission = null;
  }

  room.explosions.push(...newExp);
  room.roundResults = results;
  room.damageMap = dmg;

  const aliveNow = Object.values(room.players).filter(p => !p.eliminated);
  if (aliveNow.length <= 1 || room.round >= MAX_ROUNDS) {
    room.status = 'finished';
    if (aliveNow.length === 1) {
      room.winner = Object.keys(room.players).find(id => !room.players[id].eliminated);
    } else if (aliveNow.length === 0) {
      room.winner = null;
    } else {
      let bestId = null, bestHp = -1;
      for (const [id, p] of Object.entries(room.players)) {
        if (!p.eliminated && p.hp > bestHp) { bestHp = p.hp; bestId = id; }
      }
      room.winner = bestId;
    }
  } else {
    room.phase = 'resolving';
    room.resolvedAt = Date.now();
  }
}

function checkTimers(room) {
  if (room.status !== 'playing') return false;
  let changed = false;

  if (room.phase === 'aiming' && room.roundStartedAt && Date.now() - room.roundStartedAt >= ROUND_MS) {
    resolve(room);
    changed = true;
  }

  if (room.phase === 'resolving' && room.resolvedAt && Date.now() - room.resolvedAt >= RESOLVE_MS) {
    room.round++;
    room.wind += (Math.random() - 0.5) * 2;
    room.wind = Math.max(-8, Math.min(8, room.wind));
    room.phase = 'aiming';
    room.roundStartedAt = Date.now();
    room.resolvedAt = null;
    room.roundResults = null;
    room.damageMap = null;
    changed = true;
  }

  return changed;
}

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'list-rooms') {
    const list = await env.MARKETPLACE.list({ prefix: 'ps_room_' });
    const rooms = [];
    for (const key of list.keys) {
      const room = await env.MARKETPLACE.get(key.name, 'json');
      if (room && room.status === 'lobby') {
        rooms.push({
          code: room.code, host: room.hostName,
          count: Object.keys(room.players).length,
          max: MAX_PLAYERS, pw: !!room.password,
        });
      }
    }
    return json(rooms);
  }

  if (action === 'get-state') {
    const code = url.searchParams.get('code');
    if (!code) return json({ error: 'Missing code' }, 400);
    const room = await env.MARKETPLACE.get('ps_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);

    const changed = checkTimers(room);
    if (changed) await env.MARKETPLACE.put('ps_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });

    if (room.phase === 'aiming' && room.roundStartedAt) {
      room.timeLeft = Math.max(0, ROUND_MS - (Date.now() - room.roundStartedAt));
    }
    return json(room);
  }

  return json({ error: 'Invalid action' }, 400);
}

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const player = getPlayer(request, body);
  if (!player) return json({ error: 'Not authenticated' }, 401);

  if (body.action === 'create-room') {
    let code, exists;
    for (let i = 0; i < 10; i++) {
      code = genCode();
      exists = await env.MARKETPLACE.get('ps_room_' + code);
      if (!exists) break;
    }
    if (exists) return json({ error: 'Could not generate code' }, 500);

    const room = {
      code, host: player.id, hostName: player.name,
      password: body.password || null, status: 'lobby',
      terrainSeed: Math.floor(Math.random() * 2147483647),
      round: 0, phase: null, wind: 0,
      roundStartedAt: null, resolvedAt: null,
      players: {
        [player.id]: {
          name: player.name, img: player.img, hp: 100, x: 0,
          ammo: {}, angle: 45, power: 50,
          submitted: false, submission: null,
          eliminated: false, color: 0, ready: false,
        },
      },
      explosions: [], roundResults: null, damageMap: null, winner: null,
    };
    await env.MARKETPLACE.put('ps_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    return json({ success: true, code });
  }

  if (body.action === 'join-room') {
    const code = (body.code || '').toUpperCase().trim();
    if (!code) return json({ error: 'Missing code' }, 400);
    const room = await env.MARKETPLACE.get('ps_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);
    if (room.status !== 'lobby') return json({ error: 'Game already started' }, 400);
    if (Object.keys(room.players).length >= MAX_PLAYERS) return json({ error: 'Room full' }, 400);
    if (room.password && body.password !== room.password) return json({ error: 'Wrong password' }, 403);

    room.players[player.id] = {
      name: player.name, img: player.img, hp: 100, x: 0,
      ammo: {}, angle: 45, power: 50,
      submitted: false, submission: null,
      eliminated: false, color: nextColor(room.players), ready: false,
    };
    await env.MARKETPLACE.put('ps_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    return json({ success: true, code });
  }

  if (body.action === 'leave-room') {
    const code = body.code;
    if (!code) return json({ error: 'Missing code' }, 400);
    const room = await env.MARKETPLACE.get('ps_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);
    delete room.players[player.id];
    if (!Object.keys(room.players).length) {
      await env.MARKETPLACE.delete('ps_room_' + code);
      return json({ success: true });
    }
    if (room.host === player.id) {
      const nh = Object.keys(room.players)[0];
      room.host = nh;
      room.hostName = room.players[nh].name;
    }
    await env.MARKETPLACE.put('ps_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    return json({ success: true });
  }

  if (body.action === 'set-color') {
    const code = body.code;
    if (!code) return json({ error: 'Missing code' }, 400);
    const room = await env.MARKETPLACE.get('ps_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);
    if (room.status !== 'lobby') return json({ error: 'Already started' }, 400);
    const p = room.players[player.id];
    if (!p) return json({ error: 'Not in this room' }, 403);

    const color = Math.round(body.color);
    if (!Number.isInteger(color) || color < 0 || color >= MAX_PLAYERS) return json({ error: 'Invalid color' }, 400);
    const taken = Object.entries(room.players).some(([id, o]) => id !== player.id && o.color === color);
    if (taken) return json({ error: 'Color taken' }, 400);

    p.color = color;
    await env.MARKETPLACE.put('ps_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    return json({ success: true });
  }

  if (body.action === 'set-ready') {
    const code = body.code;
    if (!code) return json({ error: 'Missing code' }, 400);
    const room = await env.MARKETPLACE.get('ps_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);
    if (room.status !== 'lobby') return json({ error: 'Already started' }, 400);
    const p = room.players[player.id];
    if (!p) return json({ error: 'Not in this room' }, 403);

    p.ready = !!body.ready;
    await env.MARKETPLACE.put('ps_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    return json({ success: true });
  }

  if (body.action === 'kick-player') {
    const code = body.code;
    if (!code) return json({ error: 'Missing code' }, 400);
    const room = await env.MARKETPLACE.get('ps_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);
    if (room.host !== player.id) return json({ error: 'Only host can kick' }, 403);
    if (room.status !== 'lobby') return json({ error: 'Already started' }, 400);
    const targetId = body.targetId;
    if (!targetId || targetId === player.id) return json({ error: 'Invalid target' }, 400);
    if (!room.players[targetId]) return json({ error: 'Player not found' }, 404);

    delete room.players[targetId];
    await env.MARKETPLACE.put('ps_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    return json({ success: true });
  }

  if (body.action === 'start-game') {
    const code = body.code;
    if (!code) return json({ error: 'Missing code' }, 400);
    const room = await env.MARKETPLACE.get('ps_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);
    if (room.host !== player.id) return json({ error: 'Only host can start' }, 403);
    if (room.status !== 'lobby') return json({ error: 'Already started' }, 400);

    const pIds = Object.keys(room.players);
    if (pIds.length < 2) return json({ error: 'Need at least 2 players' }, 400);
    if (!pIds.every(id => room.players[id].ready)) return json({ error: 'All players must be ready' }, 400);

    const terrain = makeTerrain(room.terrainSeed);
    const margin = Math.floor(GAME_W * 0.05);
    const spacing = (GAME_W - margin * 2) / Math.max(1, pIds.length - 1);

    pIds.forEach((id, i) => {
      const p = room.players[id];
      p.x = Math.round(pIds.length === 1 ? GAME_W / 2 : margin + spacing * i);
      p.hp = 100;
      p.eliminated = false;
      p.submitted = false;
      p.submission = null;
      p.angle = p.x < GAME_W / 2 ? 45 : 135;
      p.power = 50;
      const ammo = {};
      WEAPONS.forEach((w, wi) => { if (w.ammo !== 999) ammo[wi] = w.ammo; });
      p.ammo = ammo;
    });

    room.status = 'playing';
    room.phase = 'aiming';
    room.round = 1;
    room.wind = Math.round((Math.random() - 0.5) * 8 * 10) / 10;
    room.roundStartedAt = Date.now();
    room.explosions = [];
    room.roundResults = null;
    room.damageMap = null;
    room.winner = null;

    await env.MARKETPLACE.put('ps_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    return json({ success: true });
  }

  if (body.action === 'submit-turn') {
    const code = body.code;
    if (!code) return json({ error: 'Missing code' }, 400);
    const room = await env.MARKETPLACE.get('ps_room_' + code, 'json');
    if (!room) return json({ error: 'Room not found' }, 404);
    if (room.status !== 'playing' || room.phase !== 'aiming') return json({ error: 'Not in aiming phase' }, 400);

    checkTimers(room);
    if (room.phase !== 'aiming') {
      await env.MARKETPLACE.put('ps_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
      return json({ error: 'Round ended' }, 400);
    }

    const p = room.players[player.id];
    if (!p) return json({ error: 'Not in this room' }, 403);
    if (p.eliminated) return json({ error: 'Eliminated' }, 400);
    if (p.submitted) return json({ error: 'Already submitted' }, 400);

    const angle = Math.max(0, Math.min(180, Math.round(body.angle || 45)));
    const power = Math.max(10, Math.min(100, Math.round(body.power || 50)));
    const weapon = Math.max(0, Math.min(WEAPONS.length - 1, Math.round(body.weapon || 0)));

    const w = WEAPONS[weapon];
    if (w.ammo !== 999 && (p.ammo[weapon] || 0) <= 0) {
      return json({ error: 'No ammo' }, 400);
    }

    p.submitted = true;
    p.submission = { angle, power, weapon };

    const allDone = Object.values(room.players).every(pl => pl.eliminated || pl.submitted);
    if (allDone) resolve(room);

    await env.MARKETPLACE.put('ps_room_' + code, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    return json({ success: true });
  }

  return json({ error: 'Invalid action' }, 400);
}
