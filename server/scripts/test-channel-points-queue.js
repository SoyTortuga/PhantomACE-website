#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CHANNEL POINTS — the two writes every redemption lands on

     node server/scripts/test-channel-points-queue.js

   Both of these were unlocked read-modify-writes, and both lost data when
   two redemptions arrived in the same moment:

     - `inv_<userId>`, written by theme-unlock (a theme) and by Pham
       Check-in (event badges). The comment in the check-in handler already
       named the hazard; the theme handler was the unlocked one.
     - `cp_queue_<userId>`, written by EVERY reward. Two together and the
       second put discarded the first, so a viewer saw one redemption
       silently vanish.

   Twitch also REDELIVERS webhooks, so the same redemption id can arrive
   twice. That must grant once and queue once.

   Driven through the real signed webhook, because a locked helper nothing
   calls grants nobody anything. The fake MARKETPLACE's mutate() holds a
   per-key lock, the way the Postgres one does — so a get-then-put
   regression here shows up as lost data rather than as a passing test.
   ══════════════════════════════════════════════ */

import { signEventSub } from '../lib/eventsub.js';
import { onRequestPost } from '../../functions/api/channel-points.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const SECRET = 'a-test-eventsub-secret';

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  /* Every write goes through here, so the test can see whether a handler
     reached for put() on a contended row instead of mutate(). */
  const puts = {};
  /* get() and put() YIELD. A fake backed by a synchronous Map never lets two
     handlers interleave, so an unlocked get-then-put would pass the race
     tests below and prove nothing. A real round trip to Postgres is a
     suspension point; this is one too, so the second handler reads the row
     before the first writes it and a lost write actually shows up. */
  const tick = () => new Promise(r => setTimeout(r, 0));
  return {
    TWITCH_EVENTSUB_SECRET: SECRET,
    MARKETPLACE: {
      async get(k, t) { await tick(); if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { await tick(); puts[k] = (puts[k] || 0) + 1; store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          await tick();
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
    store,
    puts,
  };
}

/* A signed redemption, exactly as Twitch sends one. `id` is the redemption
   id — passing the same one twice is a redelivery. */
async function redeem(env, { userId, title, id }) {
  const raw = JSON.stringify({
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      id, user_id: String(userId), user_name: 'viewer' + userId,
      reward: { id: 'rw-' + title, title },
    },
  });
  const mid = 'mid-' + id + '-' + Math.random().toString(36).slice(2);
  const ts = new Date(Date.now()).toISOString();
  const request = new Request('https://phantomace.tv/api/channel-points', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-id': mid,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': await signEventSub(SECRET, mid, ts, raw),
    },
    body: raw,
  });
  return onRequestPost({ env, request });
}

const inv = (env, userId) => {
  const raw = env.store.get('inv_' + userId);
  return raw ? JSON.parse(raw) : null;
};
const queue = (env, userId) => {
  const raw = env.store.get('cp_queue_' + userId);
  return raw ? JSON.parse(raw) : null;
};

/* Pham Check-in reads the live cache; seeded so it records a real check-in
   rather than a pending one. */
function onAir(env) {
  env.store.set('twitch_live_cache', JSON.stringify({
    live: true, streamId: 'stream-cp', startedAt: new Date(Date.now() - 600000).toISOString(),
    viewerCount: 10, checkedAt: Date.now(),
  }));
}

/* ── The theme lands, once ──────────────────────────────────────────── */
{
  const env = makeEnv();
  const r = await redeem(env, { userId: '1', title: 'Unlock Crimson Theme', id: 'red-1' });
  check('a theme redemption is accepted', r.status, 200);

  const items = inv(env, '1').items;
  check('the theme is in the inventory', items.map(i => i.id), ['theme_unlock_crimson_theme']);
  check('typed as a profile theme', [items[0].game, items[0].type], ['profile', 'theme']);
  check('and credited to channel points', items[0].source, 'channel-points');
  check('the redemption is queued for the site to show', queue(env, '1').map(q => q.type), ['theme-unlock']);

  /* THE SAME REDEMPTION, REDELIVERED. Twitch does this. */
  const again = await redeem(env, { userId: '1', title: 'Unlock Crimson Theme', id: 'red-1' });
  check('a redelivery is accepted', again.status, 200);
  check('but grants the theme only once', inv(env, '1').items.length, 1);
  check('and queues it only once', queue(env, '1').length, 1);

  ok('the inventory row was never written with an unlocked put', !env.puts['inv_1']);
  ok('nor was the queue', !env.puts['cp_queue_1']);
}

/* ── Two redemptions at the same instant both survive ───────────────── */
{
  const env = makeEnv();
  onAir(env);

  /* A theme and a check-in write the SAME inventory row. Unlocked, whichever
     landed second won and the other grant was gone. */
  const [a, b] = await Promise.all([
    redeem(env, { userId: '7', title: 'Unlock Bone Theme', id: 'race-theme' }),
    redeem(env, { userId: '7', title: 'Pham Check-In', id: 'race-checkin' }),
  ]);
  check('both redemptions are accepted', [a.status, b.status], [200, 200]);

  const row = inv(env, '7');
  ok('the theme survived the race', row.items.some(i => i.id === 'theme_unlock_bone_theme'));
  check('and both redemptions are in the queue, neither discarded',
    queue(env, '7').map(q => q.type).sort(), ['pham-checkin', 'theme-unlock']);
}

/* ── A burst of different rewards keeps every one ───────────────────── */
{
  const env = makeEnv();
  const titles = ['Unlock Ash Theme', 'Community Shoutout', 'Skull Boost', 'Spin the Wheel'];
  await Promise.all(titles.map((title, i) =>
    redeem(env, { userId: '9', title, id: 'burst-' + i })));

  const q = queue(env, '9');
  check('every reward in the burst is queued', q.length, titles.length);
  check('each with its own redemption id', new Set(q.map(x => x.id)).size, titles.length);
  check('and the types are the mapped ones',
    q.map(x => x.type).sort(),
    ['community-shoutout', 'skull-boost', 'spin-the-wheel', 'theme-unlock']);
}

/* ── The queue stays bounded ────────────────────────────────────────── */
{
  const env = makeEnv();
  /* Sequential: this is about the cap, not the lock. */
  for (let i = 0; i < 25; i++) {
    await redeem(env, { userId: '3', title: 'Community Shoutout', id: 'many-' + i });
  }
  const q = queue(env, '3');
  check('the queue is capped at 20', q.length, 20);
  check('keeping the newest', q[q.length - 1].id, 'many-24');
  check('and dropping the oldest', q[0].id, 'many-5');
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[channel-points-queue] ${passed} assertions passed.`);
