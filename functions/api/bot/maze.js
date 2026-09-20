/* ══════════════════════════════════════════════
   CHAT MAZE — the whole channel walks one dot through a maze.

     GET  /api/bot/maze            public state, for the overlay
     POST /api/bot/maze            { action: 'start' | 'stop' }, staff only

   Started from Bot Control, played entirely in chat: type a direction
   (up/down/left/right, or WASD, with or without a leading "!") and the
   bot makes that move on the board. EVERY move is applied, in the order
   the messages arrived — walking into a wall still counts as a move, it
   just bonks. That is the broadcaster's rule and also the fun: a hundred
   people steering one dot IS the game, so no cooldowns, no per-user
   filtering, no cleverness.

   Reaching the goal fades the board and deals the next maze one cell
   larger in each direction. Map 1 is 4×4, map 2 is 5×5, and nothing caps
   it — a chat that reaches 12×12 has earned the scroll.

   ORDERING is the room-lock, same as every game here: each move applies
   under mutate() on the one state key, so two webhook deliveries landing
   together queue instead of interleaving. "In the order they enter chat"
   is Twitch's delivery order, which is the only order anyone can observe
   anyway.

   THE MAZE IS DEALT, NOT DRAWN: generated from a seed recorded in the
   state, so the suite can prove properties (every cell reachable, no
   loops, walls agreeing from both sides) about the exact board chat is
   playing, not a lookalike.
   ══════════════════════════════════════════════ */

const KEY = 'maze_current';
const FIRST_SIZE = 4;               /* map 1 — the broadcaster's spec */
const CONTRIBUTOR_CAP = 300;        /* spam-safe; a raid cannot balloon the doc */

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

/* ── The board ─────────────────────────────────────────────────────────
   Walls per cell as a bitmask, one hex digit per cell, one string per
   row: compact in KV, trivially diffable in a console, and the overlay
   can turn each digit straight into four CSS borders. */
export const WALL = { N: 1, E: 2, S: 4, W: 8 };
export const DIRS = {
  up:    { dx: 0, dy: -1, bit: WALL.N, opp: WALL.S },
  right: { dx: 1, dy: 0,  bit: WALL.E, opp: WALL.W },
  down:  { dx: 0, dy: 1,  bit: WALL.S, opp: WALL.N },
  left:  { dx: -1, dy: 0, bit: WALL.W, opp: WALL.E },
};

/* Seeded RNG — same construction as MTGBBB's card dealer, for the same
   reason: a recorded seed makes every board reproducible after the fact. */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A perfect maze: every cell reachable, exactly one path between any two
 * cells. Iterative backtracker so a big board cannot recurse the stack
 * away. Returns `size` strings of `size` hex digits.
 */
export function generateMaze(size, seed) {
  const rnd = mulberry32(hashSeed(String(seed)));
  const cells = Array.from({ length: size }, () => new Array(size).fill(15));
  const seen = Array.from({ length: size }, () => new Array(size).fill(false));

  const stack = [{ x: 0, y: 0 }];
  seen[0][0] = true;

  while (stack.length) {
    const at = stack[stack.length - 1];
    const options = Object.values(DIRS)
      .map(d => ({ d, x: at.x + d.dx, y: at.y + d.dy }))
      .filter(n => n.x >= 0 && n.y >= 0 && n.x < size && n.y < size && !seen[n.y][n.x]);

    if (!options.length) { stack.pop(); continue; }
    const pick = options[Math.floor(rnd() * options.length)];
    cells[at.y][at.x] &= ~pick.d.bit;        /* knock this side… */
    cells[pick.y][pick.x] &= ~pick.d.opp;    /* …and the far side */
    seen[pick.y][pick.x] = true;
    stack.push({ x: pick.x, y: pick.y });
  }

  return cells.map(row => row.map(c => c.toString(16)).join(''));
}

export function wallsAt(walls, x, y) {
  return parseInt(walls[y][x], 16);
}

function freshLevel(level, startedAt) {
  const size = FIRST_SIZE + (level - 1);
  const seed = `MAZE:${startedAt}:${level}`;
  return {
    level, size, seed,
    walls: generateMaze(size, seed),
    pos: { x: 0, y: 0 },
    goal: { x: size - 1, y: size - 1 },
    moves: 0,
    bonks: 0,
  };
}

/* ── Chat entry point ──────────────────────────────────────────────────
   commands.js offers every non-command message here, exactly as it offers
   them to the scramble. The regex turns almost all of chat away without
   touching storage; the hint cache turns direction-shaped small talk away
   without a read while no maze is running.

   Single letters are WASD on purpose, not U/D/L/R: "d" cannot mean both
   down and right, and WASD is the spelling a gamer chat already knows.
   The full words always work, leading "!" tolerated on everything. */
const MOVE_RE = /^!?(up|down|left|right|w|a|s|d)$/i;
const LETTER = { w: 'up', a: 'left', s: 'down', d: 'right' };

/* Valid because this server is deliberately single-instance (two processes
   would double-advance every room timer on the site). start() clears it,
   so the first move after Start is never eaten by a stale "off". */
let activeHint = { value: null, at: 0 };
const HINT_TTL = 5000;

export function _resetHint() { activeHint = { value: null, at: 0 }; }

/**
 * Offer a chat message to the maze. Returns null when it was not a move
 * (wrong shape, or no maze running) and an array of chat lines to say —
 * usually empty — when the move was consumed.
 */
export async function offerMove(env, { name, text }) {
  const m = MOVE_RE.exec(String(text || '').trim());
  if (!m) return null;
  const dir = LETTER[m[1].toLowerCase()] || m[1].toLowerCase();

  const now = Date.now();
  if (activeHint.value === false && now - activeHint.at < HINT_TTL) return null;

  const res = await performMove(env, dir, name, { hint: true });
  return res ? res.say : null;
}

/**
 * Apply one move under the state lock. Shared by the chat path and the
 * test page's staff controls, so there is exactly one set of movement
 * rules — the test page cannot pass a maze the chat would fail.
 *
 * Returns null when no maze is running, else { say } — chat lines the
 * CALLER decides what to do with: the chat path says them in channel,
 * the test page shows them on screen and keeps the channel quiet.
 */
async function performMove(env, dir, name, { hint = false } = {}) {
  const now = Date.now();
  const say = [];
  let consumed = false;

  await env.MARKETPLACE.mutate(KEY, (state) => {
    if (!state || state.status !== 'active') {
      if (hint) activeHint = { value: false, at: now };
      return undefined;
    }
    if (hint) activeHint = { value: true, at: now };
    consumed = true;

    const d = DIRS[dir];
    const blocked = !!(wallsAt(state.walls, state.pos.x, state.pos.y) & d.bit);
    if (!blocked) {
      state.pos = { x: state.pos.x + d.dx, y: state.pos.y + d.dy };
    } else {
      state.bonks += 1;
    }
    state.moves += 1;
    state.totalMoves += 1;
    state.lastMove = { dir, by: String(name || 'chat').slice(0, 40), blocked, at: now };
    /* The on-screen input history: last ten moves, newest last, whoever
       sent them -- chat and test drives alike. Capped by slicing on write
       so the document cannot grow with the stream. */
    state.recent = [...(state.recent || []), state.lastMove].slice(-10);

    const who = state.lastMove.by;
    if (state.contributors[who] !== undefined ||
        Object.keys(state.contributors).length < CONTRIBUTOR_CAP) {
      state.contributors[who] = (state.contributors[who] || 0) + 1;
    }

    if (state.pos.x === state.goal.x && state.pos.y === state.goal.y) {
      state.history.push({
        level: state.level, size: state.size,
        moves: state.moves, bonks: state.bonks, clearedBy: who,
      });
      say.push(buildClearMessage(state, who));
      /* The fade is the overlay's job; the server just stamps when. The
         next board exists immediately, so a move typed during the fade
         lands on the new maze rather than into the void. */
      state.transition = {
        clearedLevel: state.level, clearedSize: state.size,
        moves: state.moves, bonks: state.bonks, by: who, at: now,
      };
      Object.assign(state, freshLevel(state.level + 1, state.startedAt));
    }

    state.updatedAt = now;
    return state;
  });

  return consumed ? { say } : null;
}

/* Pure and exported so the suite can pin the wording without a Twitch
   connection on the line. */
export function buildClearMessage(state, who) {
  const next = state.size + 1;
  return `🧭 Maze ${state.level} (${state.size}×${state.size}) cleared in ` +
    `${state.moves} moves${state.bonks ? ` (${state.bonks} bonks)` : ''} — ` +
    `${who} made the winning move! Next up: ${next}×${next}`;
}

export function buildStartMessage() {
  return '🧭 MAZE TIME! Chat steers the dot: type up / down / left / right ' +
    '(or WASD) in chat. Every message moves it, in order. First maze is 4×4 — reach the flag!';
}

/* ── Routes ──────────────────────────────────────────────────────────── */

export async function onRequestGet(context) {
  const { env, request } = context;

  /* The test page hides its controls from non-staff. Cosmetic only — the
     POST below re-checks for real — but a page of buttons that all 403
     reads as broken rather than as not-yours. */
  let staff = false;
  const session = getSession(request);
  if (session && session.user_id) {
    const { isModerator } = await import('../admin/moderators.js');
    staff = await isModerator(env, session);
  }

  const state = await env.MARKETPLACE.get(KEY, 'json');
  if (!state) return json({ status: 'off', staff });

  /* Contributor names are chat-public already; totals are the fun part.
     Everything else is the board itself, which is the whole point of the
     overlay being able to draw it. */
  const top = Object.entries(state.contributors || {})
    .sort((a, b) => b[1] - a[1])[0] || null;

  return json({
    staff,
    status: state.status,
    level: state.level, size: state.size,
    walls: state.walls, pos: state.pos, goal: state.goal,
    moves: state.moves, bonks: state.bonks, totalMoves: state.totalMoves,
    lastMove: state.lastMove || null,
    recent: state.recent || [],
    transition: state.transition || null,
    /* The WHOLE session, Maze 1 onward -- the cleared panel is a ledger
       that scrolls, not a ticker that forgets. One entry per clear cannot
       outgrow a stream. */
    history: state.history || [],
    topMover: top ? { name: top[0], moves: top[1] } : null,
    startedAt: state.startedAt,
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'The maze is started from Bot Control — staff only.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'start') {
    const now = Date.now();
    const state = {
      status: 'active',
      startedAt: now,
      totalMoves: 0,
      recent: [],
      contributors: {},
      history: [],
      lastMove: null,
      transition: null,
      updatedAt: now,
      ...freshLevel(1, now),
    };
    await env.MARKETPLACE.put(KEY, JSON.stringify(state));
    _resetHint();

    try {
      const { sendChatMessage } = await import('./send-chat.js');
      await sendChatMessage(env, buildStartMessage());
    } catch (err) {
      /* The game runs whether or not the announcement lands. */
      console.error('[maze] start announcement failed:', err.message);
    }
    return json({ success: true, state: { level: 1, size: FIRST_SIZE } });
  }

  /* The test page's steering. Same rules as chat — performMove is the
     only mover — but the clear announcement comes back in the RESPONSE
     instead of going to the channel: a test drive must not narrate itself
     into a live chat. */
  if (body.action === 'move') {
    const dir = String(body.dir || '').toLowerCase();
    if (!DIRS[dir]) return json({ error: 'Unknown direction' }, 400);
    const res = await performMove(env, dir, (session.display_name || 'tester') + ' (test)');
    if (!res) return json({ error: 'No maze is running.' }, 400);
    /* Clears announce to chat WHOEVER made the winning move -- the
       broadcaster wants the cleared list narrated in channel, and a level
       falling during a staff assist is still a level the stream watched
       fall. Individual moves stay silent either way. */
    if (res.say.length) {
      try {
        const { sendChatMessage } = await import('./send-chat.js');
        for (const m of res.say) await sendChatMessage(env, m);
      } catch (err) { console.error('[maze] clear announcement failed:', err.message); }
    }
    return json({ success: true, said: res.say });
  }

  if (body.action === 'stop') {
    let summary = null;
    await env.MARKETPLACE.mutate(KEY, (state) => {
      if (!state || state.status !== 'active') return undefined;
      state.status = 'off';
      state.updatedAt = Date.now();
      summary = { level: state.level, size: state.size, totalMoves: state.totalMoves };
      return state;
    });
    _resetHint();

    if (summary) {
      try {
        const { sendChatMessage } = await import('./send-chat.js');
        await sendChatMessage(env,
          `🧭 Maze over! Chat reached maze ${summary.level} (${summary.size}×${summary.size}) ` +
          `in ${summary.totalMoves} total moves. GG!`);
      } catch (err) {
        console.error('[maze] stop announcement failed:', err.message);
      }
    }
    return json({ success: true, stopped: !!summary });
  }

  return json({ error: 'Unknown action' }, 400);
}
