#!/usr/bin/env node
/* ══════════════════════════════════════════════
   OVERLAY — who plays the chime, and how often that costs a lock

     node server/scripts/test-overlay-audio-leader.js

   Several overlay sources are usually open at once: the OBS browser source,
   the desktop monitor, a dashboard. Without an election every one of them
   plays the check-in chime and the stream hears it two or three times, a
   fraction of a second apart. Each source sends a random instance id on
   every poll; the server keeps a short-lived heartbeat registry and names
   the lowest live id the leader.

   None of that was covered. The only existing assertions are regexes over
   the client's handling of `data.audioLeader` -- nothing exercised the
   election itself, which is the part with the state in it.

   What is pinned:

     - one source leads; the lowest id wins and BOTH sources agree on it,
       because two sources that disagree is the bug this prevents;
     - a source that stops polling goes stale and the survivor takes over,
       so closing OBS does not leave the stream silent;
     - a muted source and the desktop monitor send no id, so they never
       compete and never win;
     - THE HEARTBEAT DOES NOT TAKE A LOCK ON EVERY TICK. It used to rewrite
       the registry under an advisory lock once a second per source --
       contending transactions on one row, all day -- to restamp something
       allowed to be six seconds stale. It writes only when the write would
       change something now. The election still has to be right at every
       tick, so this counts both the writes and the answers.
   ══════════════════════════════════════════════ */

import { onRequestGet } from '../../functions/api/overlay/events.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* A clock the test drives, so six seconds of staleness is one line. */
const RealDate = Date;
let NOW = RealDate.parse('2026-10-10T20:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
};
const advance = (ms) => { NOW += ms; };

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  const counts = { get: 0, mutate: 0 };
  /* The overlay key lives in the store (getOverlayKey reads `overlay_key` and
     mints one if absent), not on env. */
  store.set('overlay_key', 'k');
  return {
    MARKETPLACE: {
      async get(k, t) { counts.get++; if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        counts.mutate++;
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
      async listValues() { return []; },
    },
    _store: store,
    _counts: counts,
  };
}

/* One poll from one source. `iid` omitted = a muted source or the monitor. */
async function poll(env, iid) {
  const qs = new URLSearchParams({ key: 'k', since: '0' });
  if (iid) qs.set('iid', iid);
  const res = await onRequestGet({
    env, request: new Request('https://phantomace.tv/api/overlay/events?' + qs),
  });
  return (await res.json()).audioLeader;
}

const registry = (env) => {
  const raw = env._store.get('overlay_instances');
  return raw ? JSON.parse(raw) : null;
};

/* ── One source leads itself ─────────────────────────────────────────── */
{
  const env = makeEnv();
  check('a lone source is its own leader', await poll(env, 'b-source'), 'b-source');
  ok('and it is registered', !!(registry(env) || {})['b-source']);
}

/* ── Two sources agree, and the lowest id wins ───────────────────────── */
{
  const env = makeEnv();
  /* 'a' sorts before 'z', so 'a' leads however the polls interleave. */
  const first = await poll(env, 'z-obs');
  check('the first source in leads while alone', first, 'z-obs');

  advance(100);
  const second = await poll(env, 'a-monitor');
  check('a lower id takes the lead', second, 'a-monitor');

  advance(100);
  check('and the other source is told the same thing', await poll(env, 'z-obs'), 'a-monitor');
  /* Two sources disagreeing is precisely the double-chime this prevents. */
  advance(100);
  const [x, y] = [await poll(env, 'a-monitor'), await poll(env, 'z-obs')];
  check('both agree, poll after poll', [x, y], ['a-monitor', 'a-monitor']);
}

/* ── A source that stops polling hands over ──────────────────────────── */
{
  const env = makeEnv();
  await poll(env, 'a-obs');
  advance(100);
  check('the lower id leads', await poll(env, 'z-dash'), 'a-obs');

  /* OBS is closed. Past the 6s staleness window, the survivor takes over --
     otherwise the stream goes silent until something restarts. */
  advance(7000);
  check('the survivor takes over once the leader goes stale', await poll(env, 'z-dash'), 'z-dash');
  ok('and the dead instance is swept from the registry',
    !Object.keys(registry(env) || {}).includes('a-obs'));
}

/* ── No id: a muted source and the desktop monitor never compete ─────── */
{
  const env = makeEnv();
  check('a source sending no id gets no leader', await poll(env, null), null);
  check('and nothing is registered for it', registry(env), null);

  advance(100);
  await poll(env, 'a-obs');
  advance(100);
  check('a real source still leads', await poll(env, 'a-obs'), 'a-obs');
  advance(100);
  check('and the silent one is still told nothing', await poll(env, null), null);
  check('the registry holds only the real source', Object.keys(registry(env)), ['a-obs']);
}

/* ── The heartbeat stops locking on every tick ───────────────────────── */
{
  const env = makeEnv();
  await poll(env, 'a-obs');
  const afterFirst = env._counts.mutate;
  check('the first poll registers, which does take the lock', afterFirst, 1);

  /* Ten ticks inside the beat interval. The election must stay right at
     every one of them, and none of them needs the lock. */
  let answers = [];
  for (let i = 0; i < 10; i++) {
    advance(100);
    answers.push(await poll(env, 'a-obs'));
  }
  check('every tick still names the leader', [...new Set(answers)], ['a-obs']);
  check('and not one of them took the lock', env._counts.mutate, afterFirst);

  /* Past the beat interval the stamp is refreshed, so the instance cannot
     age out of its own six-second window. */
  advance(2100);
  check('a tick past the beat interval leads', await poll(env, 'a-obs'), 'a-obs');
  check('and does rewrite the heartbeat', env._counts.mutate, afterFirst + 1);

  /* The thing the restamping is FOR: polling steadily must never let a live
     source go stale. Thirty seconds of ticks, well past the 6s window. */
  const before = env._counts.mutate;
  let stillLeading = true;
  for (let i = 0; i < 30; i++) {
    advance(1000);
    if (await poll(env, 'a-obs') !== 'a-obs') stillLeading = false;
  }
  ok('a source polling steadily never ages out', stillLeading);
  const writes = env._counts.mutate - before;
  ok(`30s of 1Hz polling took ${writes} locked writes, not 30`, writes <= 16 && writes > 0);
}

/* ── Skipping the write must not drop us out of the registry ────────
   On a tick that does not write, the election still runs off the registry we
   READ, so this call has to put its own stamp back into that local copy. With
   one source the bug hides -- an empty registry falls back to naming the
   caller -- so it takes two sources to see it: the lower id must keep leading
   on the ticks where neither of them wrote anything. */
{
  const env = makeEnv();
  await poll(env, 'a-obs');
  advance(50);
  await poll(env, 'z-dash');
  const settled = env._counts.mutate;

  const answers = [];
  for (let i = 0; i < 6; i++) {
    advance(150);                       /* inside the beat interval */
    answers.push(await poll(env, 'z-dash'));
  }
  check('no writes happened on those ticks', env._counts.mutate, settled);
  check('and the lower id still leads on every one of them',
    [...new Set(answers)], ['a-obs']);

  /* And the source doing the polling must still count itself live. */
  advance(150);
  check('the polling source is still in the registry it reads back',
    Object.keys(registry(env)).sort(), ['a-obs', 'z-dash']);
  check('a poll from the leader still names itself', await poll(env, 'a-obs'), 'a-obs');
}

globalThis.Date = RealDate;

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[overlay-audio-leader] ${passed} assertions passed.`);
