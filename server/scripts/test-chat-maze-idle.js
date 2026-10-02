#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CHAT MAZE — idle auto-stop

     node server/scripts/test-chat-maze-idle.js

   A maze stayed active until somebody typed !maze off: on the overlay for
   the rest of the stream, and taking the state lock for every
   direction-shaped chat line. The overlay's poll now puts away a maze
   nobody has moved in MAZE_IDLE_MS, once, with one line to chat.
   ══════════════════════════════════════════════ */

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const sent = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/helix/chat/messages')) sent.push(JSON.parse(opts.body).message);
  return new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 });
};

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  store.set('twitch_bot_token', JSON.stringify({ access_token: 't', expiresAt: Date.now() + 3600000 }));
  return {
    TWITCH_BROADCASTER_ID: '1',
    TWITCH_CLIENT_ID: 'c',
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async listValues() { return []; },
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
          const next = await fn(cur);
          if (next === undefined) return cur;
          store.set(k, JSON.stringify(next));
          return JSON.parse(store.get(k));
        });
        chains.set(k, run.then(() => {}, () => {}));
        return run;
      },
    },
    _store: store,
  };
}

const maze = await import('../../functions/api/bot/maze.js');
const read = (env) => JSON.parse(env._store.get('maze_current'));
const age = (env, ms) => {
  const s = read(env);
  s.updatedAt = Date.now() - ms;
  env._store.set('maze_current', JSON.stringify(s));
};
const poll = async (env) => (await maze.onRequestGet({ env, request: new Request('https://x/api/bot/maze') })).json();

ok('the idle window is minutes, not seconds', maze.MAZE_IDLE_MS >= 5 * 60 * 1000);

{
  const env = makeEnv();
  await maze.startMaze(env);
  sent.length = 0;

  age(env, maze.MAZE_IDLE_MS - 60000);
  check('a maze moved recently stays up', (await poll(env)).status, 'active');
  check('and nothing is said', sent.length, 0);

  age(env, maze.MAZE_IDLE_MS + 1000);
  const r = await poll(env);
  check('a maze left idle is put away by the poll', r.status, 'off');
  check('recorded as an idle stop', read(env).stoppedReason, 'idle');
  check('with one line to chat', sent.length, 1);
  ok('saying it is taking a break', /taking a break/.test(sent[0]));

  await poll(env);
  await Promise.all([poll(env), poll(env), poll(env)]);
  check('later polls say nothing more', sent.length, 1);

  maze._resetHint();
  const move = await maze.offerMove(env, { userId: '5', name: 'x', text: 'up' });
  check('a stopped maze no longer takes moves', move, null);

  await maze.startMaze(env);
  check('a mod can start it again', read(env).status, 'active');
  check('as a fresh run', read(env).stoppedReason, undefined);
}

{
  /* Two polls landing together on an idle maze: one stop, one line. */
  const env = makeEnv();
  await maze.startMaze(env);
  sent.length = 0;
  age(env, maze.MAZE_IDLE_MS + 1000);
  await Promise.all([poll(env), poll(env), poll(env)]);
  check('concurrent polls announce the break once', sent.length, 1);
}

{
  /* A move just before the stop keeps it alive: the check repeats in the lock. */
  const env = makeEnv();
  await maze.startMaze(env);
  sent.length = 0;
  age(env, maze.MAZE_IDLE_MS + 1000);
  maze._resetHint();
  await maze.offerMove(env, { userId: '5', name: 'x', text: 'down' });
  await maze.offerMove(env, { userId: '5', name: 'x', text: 'right' });
  check('a moved maze is not stopped', (await poll(env)).status, 'active');
}

console.log('');
if (failures.length) {
  console.log(`[chat-maze-idle] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[chat-maze-idle] ${passed} assertions passed.`);
console.log('');
