#!/usr/bin/env node
/* ══════════════════════════════════════════════
   HYPE TRAIN DROPS — test suite

     node server/scripts/test-hype-train.js

   Driven through hype-train.js's own onRequestPost with signed requests,
   over a fake store whose mutate() serialises per key the way the real
   advisory lock does. Pins:

     a jump past a reward level (4 → 6) still pays it
     concurrent progress events never pay a level twice
     a begin answered after progress does not reset what was paid
     a progress answered after the end pays nothing
     an empty pool releases the level for a later retry
     a handler failure answers 200, never a 500 Twitch would retry
   ══════════════════════════════════════════════ */

import { signEventSub } from '../lib/eventsub.js';

const SECRET = 'a-test-eventsub-secret';

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
  if (String(url).includes('/helix/chat/messages')) {
    sent.push(JSON.parse(opts.body).message);
    return new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

function makeEnv({ pool = 100 } = {}) {
  const store = new Map();
  const chains = new Map();
  let n = 0;
  const pools = { common: pool, uncommon: pool, rare: pool, mythic: pool };
  store.set('twitch_bot_token', JSON.stringify({ access_token: 't', expiresAt: Date.now() + 3600000 }));
  const env = {
    TWITCH_EVENTSUB_SECRET: SECRET,
    TWITCH_BROADCASTER_ID: '1',
    TWITCH_CLIENT_ID: 'c',
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async list() { return { keys: [], list_complete: true }; },
      async listValues() { return []; },
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
          /* A yield inside the lock, so an unlocked caller would interleave. */
          await new Promise(r => setImmediate(r));
          const next = await fn(cur);
          if (next === undefined) return cur;
          store.set(k, JSON.stringify(next));
          return JSON.parse(store.get(k));
        });
        chains.set(k, run.then(() => {}, () => {}));
        return run;
      },
      async pullGiveawayCode(rarity) {
        if (pools[rarity] <= 0) return null;
        pools[rarity]--;
        return `${rarity.slice(0, 3).toUpperCase()}${++n}`;
      },
    },
    _store: store,
    _pools: pools,
  };
  return env;
}

let msgSeq = 0;
async function deliver(env, type, event, messageType = 'notification') {
  const mod = await import('../../functions/api/hype-train.js');
  const raw = JSON.stringify({ subscription: { type, status: messageType === 'revocation' ? 'authorization_revoked' : 'enabled' }, event });
  const id = `hype-msg-${++msgSeq}-${Math.random()}`;
  const ts = new Date().toISOString();
  const request = new Request('https://phantomace.tv/api/hype-train', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': messageType,
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': await signEventSub(SECRET, id, ts, raw),
    },
    body: raw,
  });
  return mod.onRequestPost({ env, request, waitUntil() {} });
}

const progress = (id, level) => ({ id, level, total: level * 100, goal: 500 });
const state = (env) => JSON.parse(env._store.get('hype_train_active') || 'null');
const drops = (env) => JSON.parse(env._store.get('hype_train_drops') || '[]');
const quiet = { error: console.error, warn: console.warn, log: console.log };
console.error = console.warn = () => {};

/* ── The arithmetic ──────────────────────────────────────────────────── */
{
  const { dueRewardLevels } = await import('../../functions/api/hype-train.js');
  check('level 4 owes nothing', dueRewardLevels(4, []), []);
  check('level 5 owes 5', dueRewardLevels(5, []), [5]);
  check('a jump to 6 still owes 5', dueRewardLevels(6, []), [5]);
  check('a jump to 16 owes every level passed', dueRewardLevels(16, []), [5, 10, 15]);
  check('paid levels are not owed again', dueRewardLevels(16, [5, 10]), [15]);
  check('string levels from storage count as paid', dueRewardLevels(10, ['5']), [10]);
}

/* ── 4 → 6 pays level 5 ──────────────────────────────────────────────── */
{
  const env = makeEnv();
  sent.length = 0;
  await deliver(env, 'channel.hype_train.begin', { id: 'T1', level: 1, total: 0, goal: 100 });
  await deliver(env, 'channel.hype_train.progress', progress('T1', 4));
  check('level 4 drops nothing', drops(env).length, 0);
  await deliver(env, 'channel.hype_train.progress', progress('T1', 6));
  check('jumping 4 → 6 pays level 5', drops(env).map(d => d.level), [5]);
  check('with the level-5 reward', drops(env)[0].codes.length, 4);
  check('and records it as paid', state(env).droppedLevels, [5]);
  ok('chat hears the level-5 announcement', sent.some(m => /HYPE TRAIN LEVEL 5!/.test(m)));

  await deliver(env, 'channel.hype_train.progress', progress('T1', 6));
  check('another level-6 event pays nothing more', drops(env).length, 1);

  await deliver(env, 'channel.hype_train.progress', progress('T1', 16));
  check('a jump to 16 pays 10 and 15, in order', drops(env).map(d => d.level), [5, 10, 15]);
}

/* ── Concurrent progress events ──────────────────────────────────────── */
{
  const env = makeEnv();
  await deliver(env, 'channel.hype_train.begin', { id: 'T2', level: 1, total: 0, goal: 100 });
  /* Eight contributions landing at once, all at level 5 or past it. */
  const levels = [5, 5, 6, 5, 7, 6, 5, 6];
  const results = await Promise.all(levels.map(l => deliver(env, 'channel.hype_train.progress', progress('T2', l))));
  check('every delivery is answered 200', results.map(r => r.status), levels.map(() => 200));
  check('level 5 is paid exactly once', drops(env).filter(d => d.level === 5).length, 1);
  check('so exactly four codes left the pool', 100 - env._pools.common, 4);
  check('one alert per level reached', state(env).alertedLevels.slice().sort(), [5, 6, 7]);
}

/* ── Out-of-order deliveries ─────────────────────────────────────────── */
{
  const env = makeEnv();
  await deliver(env, 'channel.hype_train.progress', progress('T3', 5));
  check('progress before begin still pays', drops(env).length, 1);
  await deliver(env, 'channel.hype_train.begin', { id: 'T3', level: 1, total: 0, goal: 100 });
  check('a late begin keeps what was paid', state(env).droppedLevels, [5]);
  await deliver(env, 'channel.hype_train.progress', progress('T3', 5));
  check('so level 5 is not paid twice', drops(env).length, 1);

  await deliver(env, 'channel.hype_train.end', { id: 'T3', level: 5, total: 600, top_contributions: [] });
  await deliver(env, 'channel.hype_train.progress', progress('T3', 10));
  check('a progress answered after the end pays nothing', drops(env).length, 1);
  check('and the banner still reads ended', JSON.parse(env._store.get('hype_train_site')).status, 'ended');

  await deliver(env, 'channel.hype_train.begin', { id: 'T3', level: 1, total: 0, goal: 100 });
  check('a begin answered after the end does not reopen it', JSON.parse(env._store.get('hype_train_site')).status, 'ended');

  await deliver(env, 'channel.hype_train.progress', progress('T4', 5));
  check('the NEXT train starts its own bookkeeping', state(env).id, 'T4');
  check('and pays its own level 5', drops(env).filter(d => d.level === 5).length, 2);
}

/* ── Empty pool ──────────────────────────────────────────────────────── */
{
  const env = makeEnv({ pool: 0 });
  await deliver(env, 'channel.hype_train.progress', progress('T5', 5));
  check('an empty pool pays nothing', drops(env).length, 0);
  check('and releases the level', state(env).droppedLevels, []);
  env._pools.common = 10;
  await deliver(env, 'channel.hype_train.progress', progress('T5', 5));
  check('so it pays once the pool is restocked', drops(env).length, 1);
}

/* ── Failures answer 200 ─────────────────────────────────────────────── */
{
  const env = makeEnv();
  env.MARKETPLACE.mutate = async () => { throw new Error('database unavailable'); };
  const res = await deliver(env, 'channel.hype_train.progress', progress('T6', 5));
  check('a database failure is answered 200, not 500', res.status, 200);
}

/* ── Revocation is recorded ──────────────────────────────────────────── */
{
  const env = makeEnv();
  const { _resetRevokedCache } = await import('../../functions/api/bot/dashboard.js');
  _resetRevokedCache();
  const res = await deliver(env, 'channel.hype_train.progress', {}, 'revocation');
  check('a revocation is acknowledged', res.status, 200);
  const rec = JSON.parse(env._store.get('eventsub_revoked') || '{}');
  check('and recorded by type', rec['channel.hype_train.progress'] && rec['channel.hype_train.progress'].reason, 'authorization_revoked');

  await deliver(env, 'channel.hype_train.progress', progress('T7', 2));
  const after = JSON.parse(env._store.get('eventsub_revoked') || '{}');
  check('a later notification of that type clears it', after['channel.hype_train.progress'], undefined);
}

Object.assign(console, quiet);
console.log('');
if (failures.length) {
  console.log(`[hype-train] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[hype-train] ${passed} assertions passed.`);
console.log('');
