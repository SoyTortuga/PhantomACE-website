#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CHAT MAZE — the board, the rules, and the chat doorway

     node server/scripts/test-chat-maze.js

   The game's promises, from the broadcaster's spec:

     · every chat direction is applied, in arrival order — a wall move
       still counts (a bonk), it is never dropped
     · map 1 is 4×4 and each clear grows the maze by one in both x and y
     · the maze must be SOLVABLE, every time: an unreachable goal on
       stream is not a bug ticket, it is a dead segment in front of a
       live audience

   Solvability is not sampled, it is proven per property: generated
   boards are flood-filled to show every cell reachable, wall bitmasks
   are checked to agree from both sides of every edge, and the passage
   count must be exactly n²−1 — a tree, so there is one path and chat
   cannot luck into a loop that never ends.

   The doorway matters as much as the game: the move regex must take
   whole-message tokens only, or the maze starts eating sentences that
   merely contain the word "up".
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateMaze, wallsAt, offerMove, buildClearMessage, buildStartMessage,
  onRequestGet, onRequestPost, _resetHint, WALL, DIRS,
} from '../../functions/api/bot/maze.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* No network: announcements go through send-chat, which must never be
   reached from here — the routes swallow its failure by design. */
globalThis.fetch = async () => { throw new Error('unexpected network call'); };

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list() { return { keys: [] }; },
    async mutate(k, fn) {
      const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
      const out = await fn(cur);
      if (out === undefined) return;
      store.set(k, JSON.stringify(out));
    },
  };
}
const env = (seed = {}) => ({
  /* RAW OBJECT, not pre-stringified — this fakeKV stringifies its seed
     itself, and a doubled JSON.stringify turns the moderator list into a
     string whose .entries is undefined: every gate check then fails as
     403 while looking like a fixture that should pass. */
  MARKETPLACE: fakeKV({ site_moderators: { entries: [{ userId: '222' }] }, ...seed }),
  TWITCH_BROADCASTER_ID: '111',
});
const as = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) });
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/bot/maze', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });
const GET = (e, h) => onRequestGet({ env: e, request: new Request('https://x/api/bot/maze', { headers: h }) });

/* ══ Every board is provably playable ══════════════════════════════════ */
{
  for (const size of [4, 5, 6, 9, 14]) {
    const walls = generateMaze(size, 'proof:' + size);

    /* Same seed, same board — the recorded seed reproduces the game. */
    check(`${size}×${size} is deterministic`, walls, generateMaze(size, 'proof:' + size));

    /* Walls agree from both sides: an east wall here is a west wall there. */
    let disagree = 0, passages = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = wallsAt(walls, x, y);
        if (x + 1 < size) {
          const east = !!(c & WALL.E), west = !!(wallsAt(walls, x + 1, y) & WALL.W);
          if (east !== west) disagree++;
          if (!east) passages++;
        }
        if (y + 1 < size) {
          const south = !!(c & WALL.S), north = !!(wallsAt(walls, x, y + 1) & WALL.N);
          if (south !== north) disagree++;
          if (!south) passages++;
        }
      }
    }
    check(`${size}×${size} walls agree from both sides`, disagree, 0);

    /* A perfect maze is a spanning tree: n²−1 passages, no more, no less.
       More would be a loop; fewer would strand a cell. */
    check(`${size}×${size} has exactly n²−1 passages`, passages, size * size - 1);

    /* And the flood fill agrees: everything reachable from the start. */
    const seen = new Set(['0,0']);
    const q = [{ x: 0, y: 0 }];
    while (q.length) {
      const at = q.pop();
      for (const d of Object.values(DIRS)) {
        if (wallsAt(walls, at.x, at.y) & d.bit) continue;
        const nx = at.x + d.dx, ny = at.y + d.dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size || seen.has(nx + ',' + ny)) continue;
        seen.add(nx + ',' + ny);
        q.push({ x: nx, y: ny });
      }
    }
    check(`${size}×${size} is fully connected`, seen.size, size * size);
  }
}

/* ══ Start: staff only, map 1 is 4×4 ═══════════════════════════════════ */
{
  const e = env();
  check('anonymous cannot start', (await POST(e, { action: 'start' })).status, 401);
  check('a viewer cannot start', (await POST(e, { action: 'start' }, as('999'))).status, 403);
  check('a moderator can', (await POST(e, { action: 'start' }, as('222'))).status, 200);

  const st = e.MARKETPLACE.read('maze_current');
  check('map 1 is 4×4', [st.level, st.size], [1, 4]);
  check('the dot starts top-left', st.pos, { x: 0, y: 0 });
  check('the goal is bottom-right', st.goal, { x: 3, y: 3 });
  ok('the start message tells chat the controls', /up \/ down \/ left \/ right/.test(buildStartMessage()));
}

/* ══ The doorway: exact tokens, nothing else ═══════════════════════════ */
{
  const e = env();
  await POST(e, { action: 'start' }, as('222'));
  _resetHint();

  const noise = ['whats up', 'up up', 'download', 'lefty', '!!up', 'move up', 'u', 'r', ''];
  for (const text of noise) {
    check(`"${text}" is not a move`, await offerMove(e, { name: 'X', text }), null);
  }
  check('and none of that touched the board', e.MARKETPLACE.read('maze_current').moves, 0);

  /* Every accepted spelling, including "!"-prefixed and WASD singles.
     "d" is RIGHT — WASD, not U/D/L/R, because one letter cannot mean two
     directions and gamers already know which set this is. */
  ok('"up" moves', (await offerMove(e, { name: 'X', text: 'up' })) !== null);
  ok('"!down" moves', (await offerMove(e, { name: 'X', text: '!down' })) !== null);
  ok('"W" moves', (await offerMove(e, { name: 'X', text: 'W' })) !== null);
  const before = e.MARKETPLACE.read('maze_current');
  await offerMove(e, { name: 'X', text: 'd' });
  const after = e.MARKETPLACE.read('maze_current');
  ok('"d" is right, not down', after.lastMove.dir === 'right');
  check('four moves are on the clock', after.moves, 4);
}

/* ══ Order, bonks, and the walls being law ═════════════════════════════ */
{
  const e = env();
  await POST(e, { action: 'start' }, as('222'));
  _resetHint();

  /* Drive a known walk on the REAL level-1 board by following open walls:
     the point is that blocked moves bonk without moving and open moves
     move, deterministically, in the order given. */
  const st0 = e.MARKETPLACE.read('maze_current');
  const openDown = !(wallsAt(st0.walls, 0, 0) & WALL.S);
  const openRight = !(wallsAt(st0.walls, 0, 0) & WALL.E);
  ok('a corner cell opens somewhere', openDown || openRight);

  /* Walk into the sealed side first, then the open side. */
  const sealed = openDown ? (openRight ? null : 'right') : 'down';
  if (sealed) {
    await offerMove(e, { name: 'A', text: sealed });
    const bonked = e.MARKETPLACE.read('maze_current');
    check('a wall move bonks', bonked.bonks, 1);
    check('but still counts as a move', bonked.moves, 1);
    check('and the dot stays put', bonked.pos, { x: 0, y: 0 });
  }

  const open = openDown ? 'down' : 'right';
  await offerMove(e, { name: 'B', text: open });
  const moved = e.MARKETPLACE.read('maze_current');
  check('an open move moves', moved.pos, openDown ? { x: 0, y: 1 } : { x: 1, y: 0 });
  check('the last mover is named', moved.lastMove.by, 'B');

  /* Off-board edges are walls too: the generator never opens them. */
  await offerMove(e, { name: 'C', text: 'up' });
  const edge = e.MARKETPLACE.read('maze_current');
  ok('walking off the top edge bonks', edge.pos.y >= 0 && edge.bonks >= 1);
}

/* ══ The clear: fade stamp, +1 in both directions, fresh board ═════════ */
{
  const e = env();
  await POST(e, { action: 'start' }, as('222'));
  _resetHint();

  /* Solve level 1 by BFS on its actual walls, then feed the path through
     the same doorway chat uses. */
  const st = e.MARKETPLACE.read('maze_current');
  const path = solve(st.walls, st.size);
  ok('the solver found a path (the board is playable)', path.length > 0);
  for (const dir of path) await offerMove(e, { name: 'Solver', text: dir });

  const next = e.MARKETPLACE.read('maze_current');
  check('the next maze is one bigger in both x and y', [next.level, next.size], [2, 5]);
  check('with the dot reset', next.pos, { x: 0, y: 0 });
  check('and the goal in the new corner', next.goal, { x: 4, y: 4 });
  check('fresh move clock', next.moves, 0);
  check('the transition stamp names the cleared board',
        [next.transition.clearedLevel, next.transition.clearedSize, next.transition.by],
        [1, 4, 'Solver']);
  check('history remembers it', next.history.length, 1);
  ok('the clear announcement says what comes next',
     /Next up: 5×5/.test(buildClearMessage({ level: 1, size: 4, moves: 9, bonks: 0 }, 'Solver')));

  /* The new board is itself playable — the property, not the sample. */
  ok('level 2 solves too', solve(next.walls, next.size).length > 0);
}

/* ══ The test page's steering: same rules, quiet channel ═══════════════ */
{
  const e = env();
  await POST(e, { action: 'start' }, as('222'));

  check('a viewer cannot test-drive', (await POST(e, { action: 'move', dir: 'down' }, as('999'))).status, 403);
  const mv = await POST(e, { action: 'move', dir: 'nope' }, as('222'));
  check('an unknown direction is refused', mv.status, 400);

  const good = await (await POST(e, { action: 'move', dir: 'down' }, as('222'))).json();
  ok('a staff move applies', good.success === true);
  const st = e.MARKETPLACE.read('maze_current');
  check('and is attributed as a test', st.lastMove.by, 'U222 (test)');
  ok('clear announcements come back in the response, not the channel',
     Array.isArray(good.said));

  /* GET: public board, staff flag only for staff. */
  const pub = await (await GET(e)).json();
  ok('the board is public', Array.isArray(pub.walls) && pub.status === 'active');
  check('anonymous is not staff', pub.staff, false);
  check('a moderator is', (await (await GET(e, as('222'))).json()).staff, true);
  ok('contributor ids never leave the server', !('contributors' in pub));
}

/* ══ Stop, and the stale-hint trap ═════════════════════════════════════ */
{
  const e = env();
  await POST(e, { action: 'start' }, as('222'));
  _resetHint();
  await offerMove(e, { name: 'X', text: 'nothere' });   /* not a move at all */
  await POST(e, { action: 'stop' }, as('222'));
  check('stop turns the game off', e.MARKETPLACE.read('maze_current').status, 'off');
  check('moves after stop are not consumed', await offerMove(e, { name: 'X', text: 'up' }), null);

  /* THE TRAP: the off-hint is cached for a few seconds, so start() must
     reset it — otherwise the first moves of a NEW game are silently eaten
     by the memory of the old one being off. */
  await offerMove(e, { name: 'X', text: 'up' });        /* primes hint=off */
  await POST(e, { action: 'start' }, as('222'));
  const said = await offerMove(e, { name: 'X', text: 'down' });
  ok('the first move after a restart is heard', said !== null);
  check('and applied', e.MARKETPLACE.read('maze_current').moves, 1);
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const cmds = fs.readFileSync(path.join(REPO, 'functions/api/bot/commands.js'), 'utf8').replace(/\r\n/g, '\n');
  ok('chat is offered to the maze', /offerMove\(env, \{/.test(cmds));
  ok('before the "!" gate would swallow "!up"',
     cmds.indexOf('offerMove') < cmds.indexOf('if (!parsed)'));
  ok('a broken maze cannot break chat commands', /A broken maze must not break chat commands/.test(cmds));

  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('maze_current is registered', /maze_current:\s*\{ table: 'singletons', expiry: 'none' \}/.test(reg));

  const tb = fs.readFileSync(path.join(REPO, 'functions/api/admin/toolbox.js'), 'utf8');
  ok('the toolbox maps the test page', /\/maze-test\.html/.test(tb));
  ok('the test page exists', fs.existsSync(path.join(REPO, 'maze-test.html')));
  const page = fs.readFileSync(path.join(REPO, 'maze-test.html'), 'utf8');
  ok('the page loads its script', /js\/pages\/maze-test\.js/.test(page));
  const js = fs.readFileSync(path.join(REPO, 'js/pages/maze-test.js'), 'utf8');
  ok('the board fades on a transition it watched', /classList\.add\('fading'\)/.test(js));
  ok('walls render as borders, and nothing renders unless shown',
     /\(!show \|\| digit === '\.'\) \? 0 : parseInt\(digit, 16\)/.test(js));
  ok('cells are dressed every poll, because fog lifts between polls',
     /function updateCells/.test(js));
  ok('staff x-ray dims what chat cannot see', /' xray' : ' dark'/.test(js));
}

/* ══ The live-testing notes, pinned ════════════════════════════════════ */
{
  /* Input history: last ten, in order, named. Drive 12 distinct moves and
     the first two must have fallen off the front. */
  const e = env();
  await POST(e, { action: 'start' }, as('222'));
  _resetHint();
  const seq = ['up','down','left','right','up','down','left','right','up','down','left','right'];
  for (let i = 0; i < seq.length; i++) {
    await offerMove(e, { name: 'Mover' + i, text: seq[i] });
  }
  const st = e.MARKETPLACE.read('maze_current');
  check('the recent ring holds exactly ten', st.recent.length, 10);
  check('oldest surviving move is the third sent', st.recent[0].by, 'Mover2');
  check('newest is last', st.recent[9].by, 'Mover11');
  ok('each entry names its direction and sender',
     st.recent.every(m => m.dir && m.by && typeof m.blocked === 'boolean'));

  const pub = await (await GET(e)).json();
  check('the wire carries the ring', pub.recent.length, 10);

  /* The cleared ledger is the whole session, not a tail. */
  ok('GET returns full history, unsliced',
     /history: state\.history \|\| \[\]/.test(fs.readFileSync(path.join(REPO, 'functions/api/bot/maze.js'), 'utf8')));

  /* Test-driven clears now announce to chat too -- the broadcaster's call,
     overriding the earlier keep-quiet default. */
  const mz = fs.readFileSync(path.join(REPO, 'functions/api/bot/maze.js'), 'utf8').replace(/\r?\n/g, '\n');
  ok('a clear from the test page reaches the channel',
     /action === 'move'[\s\S]{0,900}sendChatMessage\(env, m\)/.test(mz));

  /* The page's promises from the notes. */
  const js = fs.readFileSync(path.join(REPO, 'js/pages/maze-test.js'), 'utf8').replace(/\r?\n/g, '\n');
  const page = fs.readFileSync(path.join(REPO, 'maze-test.html'), 'utf8').replace(/\r?\n/g, '\n');

  ok('one rover glides; the dot is never re-parented', /class="rover"/.test(js) && !/class="dot"/.test(js));
  ok('with a transform transition to glide on', /\.rover \{[\s\S]{0,200}transition: transform/.test(page));
  ok('a bonk lunges toward the wall it hit', /cellPx \* 0\.28/.test(js));
  ok('the goal is a downward ladder, not a flag', /🪜/.test(js) && !/🏁/.test(js));
  ok('the old board is never unhidden after its fade begins',
     /buildBoard\(latest\);[\s\S]{0,200}classList\.remove\('fading'\)/.test(js));
  ok('a MAZE COMPLETE card shows during the fade', /MAZE ' \+ t\.clearedLevel \+ ' COMPLETE!/.test(js));
  ok('the pad speaks words, not glyphs', /data-dir="up">Up</.test(page) && /data-dir="right">Right</.test(page));
  ok('and lights the direction chat sent', /function flashPad/.test(js) && /lit-bonk/.test(js));
  ok('the ledger reads Maze 1 downward and follows the bottom',
     /history\.map\(/.test(js) && /scrollTop = ul\.scrollHeight/.test(js));
  ok('the ledger scrolls rather than truncates', /#historyList \{ max-height/.test(page));
}

/* ══ Fog, bones, and the stakes ═════════════════════════════════════════ */
{
  const { seedBones } = await import('../../functions/api/bot/maze.js');

  /* Bones: deterministic, in dead ends only, never on start or goal. */
  for (const size of [4, 8, 12]) {
    const walls = generateMaze(size, 'bones:' + size);
    const bones = seedBones(walls, size, 'MAZE:x:' + size);
    check(size + '-board bones are deterministic', bones, seedBones(walls, size, 'MAZE:x:' + size));
    for (const b of bones) {
      const bits = wallsAt(walls, b.x, b.y);
      let up = 0; for (const w of [1,2,4,8]) if (bits & w) up++;
      check('a bone sits in a dead end (' + b.x + ',' + b.y + ')', up, 3);
      ok('never on start or goal', !(b.x === 0 && b.y === 0) && !(b.x === size-1 && b.y === size-1));
    }
  }

  /* A fresh level starts fogged: the start area lit, the rest dark. */
  const e = env();
  await POST(e, { action: 'start' }, as('222'));
  _resetHint();
  let st = e.MARKETPLACE.read('maze_current');
  ok('the start cell is revealed', st.revealed[0][0] === '1');
  ok('and its neighbours', st.revealed[0][1] === '1' && st.revealed[1][0] === '1');
  ok('but not the far corner', st.revealed[3][3] === '0');

  /* Walking reveals; landing on a bone collects it. */
  const path = solve(st.walls, st.size);
  let sawBonePickup = false;
  for (const dir of path) {
    const before = e.MARKETPLACE.read('maze_current').bonesFound;
    await offerMove(e, { userId: '77', name: 'Walker', text: dir });
    const cur = e.MARKETPLACE.read('maze_current');
    if (cur.level === 1 && cur.bonesFound > before) sawBonePickup = true;
  }
  st = e.MARKETPLACE.read('maze_current');
  check('the walk cleared level 1', st.level, 2);
  ok('level 2 starts re-fogged', st.revealed[st.size - 1][st.size - 1] === '0');
  ok('with its own bones', st.bonesTotal >= 1 && st.bonesFound === 0);

  /* THE STAKES LANDED: the winning mover's giveaway ledger exists in the
     store, written by the real addEntries through the real mutate. */
  const ledger = [...e.MARKETPLACE.store.keys()].find(k => k.includes('77') && k !== 'maze_current');
  ok('the winning mover was credited an entry', !!ledger);
  if (ledger) {
    const led = e.MARKETPLACE.read(ledger);
    ok('with the maze named as the source', JSON.stringify(led).includes('maze:level1'));
  }

  /* The clear message carries the stakes. */
  ok('the clear message credits the entry',
     /\+1 giveaway entry/.test(buildClearMessage({ level: 1, size: 4, moves: 9, bonks: 0 }, 'W')));
  const plan = { bonesTotal: 2, bonesFound: 2, allBones: true };
  ok('a full bone set announces the upgrade',
     /UPGRADED/.test(buildClearMessage({ level: 1, size: 4, moves: 9, bonks: 0 }, 'W', plan)));
  ok('a partial set just reports it',
     /1\/2 collected/.test(buildClearMessage({ level: 1, size: 4, moves: 9, bonks: 0 }, 'W',
        { bonesTotal: 2, bonesFound: 1, allBones: false })));

  /* FOG IS ON THE WIRE. A viewer's GET must not leak the board. */
  const pub = await (await GET(e)).json();
  ok('unrevealed walls go out masked', pub.walls.some(row => row.includes('.')));
  check('the ladder is withheld until seen', pub.goal, null);
  ok('hidden bones are never named', (pub.bones || []).every(b => pub.revealed[b.y][b.x] === '1'));
  ok('but the counts are public', typeof pub.bonesTotal === 'number' && typeof pub.bonesFound === 'number');

  const staffView = await (await GET(e, as('222'))).json();
  ok('staff see every wall', !staffView.walls.some(row => row.includes('.')));
  ok('and the goal', staffView.goal !== null);
}

/* ══ The overlay panel and the honest test page ════════════════════ */
{
  const ov = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay hosts a maze panel', /id="ovMaze" hidden/.test(ov));
  ok('and loads its own script, apart from the alert feed', /overlay-maze\.js/.test(ov));

  const js = fs.readFileSync(path.join(REPO, 'js/pages/overlay-maze.js'), 'utf8');
  ok('the panel hides when no maze runs', /panel\.hidden = true/.test(js));
  ok('polls back off while idle', /IDLE_POLL_MS/.test(js));
  ok('failures stay silent on stream', /Silent, like every panel here/.test(js));
  ok('the wire IS the fog: a masked digit draws nothing', /digit === '\.'/.test(js));
  ok('the rover glides on the overlay too', /class="rover" id="ovMazeRover"/.test(js));
  ok('the clear choreography made it across', /MAZE ' \+ t\.clearedLevel \+ ' COMPLETE!/.test(js));
  ok('the word-pad lights per incoming command', /lit-bonk/.test(js) && /data-dir="/.test(js));
  ok('senders scroll beneath', /renderRecent/.test(js));

  const css = fs.readFileSync(path.join(REPO, 'css/pages/overlay.css'), 'utf8');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the panel is styled', /\.ov-maze \{/.test(css));
  ok('no box-shadow, still', !/box-shadow/.test(code));

  /* The test page defaults to the viewer's truth: x-ray is opt-in. */
  const tp = fs.readFileSync(path.join(REPO, 'js/pages/maze-test.js'), 'utf8');
  ok('x-ray is behind a toggle, not the default',
     /staff && \$\('xrayToggle'\) && \$\('xrayToggle'\)\.checked/.test(tp));
  const tph = fs.readFileSync(path.join(REPO, 'maze-test.html'), 'utf8');
  ok('and the toggle exists', /id="xrayToggle"/.test(tph));
  ok('x-ray is a whisper now', /\.cell\.xray \{ opacity: 0\.12; \}/.test(tph));
}

/** BFS the walls; returns the direction list from (0,0) to the far corner. */
function solve(walls, size) {
  const prev = new Map([['0,0', null]]);
  const q = [{ x: 0, y: 0 }];
  while (q.length) {
    const at = q.shift();
    if (at.x === size - 1 && at.y === size - 1) break;
    for (const [name, d] of Object.entries(DIRS)) {
      if (wallsAt(walls, at.x, at.y) & d.bit) continue;
      const nx = at.x + d.dx, ny = at.y + d.dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size || prev.has(nx + ',' + ny)) continue;
      prev.set(nx + ',' + ny, { from: at.x + ',' + at.y, dir: name });
      q.push({ x: nx, y: ny });
    }
  }
  const out = [];
  let key = (size - 1) + ',' + (size - 1);
  while (prev.get(key)) { out.unshift(prev.get(key).dir); key = prev.get(key).from; }
  return out;
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[chat-maze] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[chat-maze] ${passed} assertions passed.`);
console.log('');
