#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO PARK — offline egg catch-up

     node server/scripts/test-dino-park-catchup.js

   Eggs only incubate while PhantomACE is live, and a closed browser used to
   mean that gap was never credited. The catch-up answers "how many seconds
   of [since, now] was the stream live" — now from a live-interval log the
   RIG stamps on its own minute tick (recordLiveTick), not from Twitch VODs,
   which silently credited nothing whenever VOD archiving was off.

   Everything here drives the real recordLiveTick + onRequestGet against a
   fake KV — no network, no Twitch, no real database.
   ══════════════════════════════════════════════ */

import { onRequestGet, recordLiveTick, overlapSeconds } from '../../functions/api/dino-park-catchup.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const MIN = 60 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/* ── overlapSeconds ───────────────────────────────────────────────────── */
{
  const from = 1000, now = 5000;
  check('fully inside the window', overlapSeconds(2000, 3000, from, now), 1);
  check('starts before, ends inside', overlapSeconds(0, 2000, from, now), 1);
  check('starts inside, ends after', overlapSeconds(4000, 6000, from, now), 1);
  check('fully contains the window', overlapSeconds(0, 6000, from, now), 4);
  check('entirely before the window', overlapSeconds(0, 500, from, now), 0);
  check('entirely after the window', overlapSeconds(6000, 7000, from, now), 0);
}

/* An env with a KV stand-in, env-shaped so the real code's env.MARKETPLACE
   works; `store`/`read` hang off it for the test to inspect. */
function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    MARKETPLACE: {
      async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async mutate(k, fn) { const cur = store.has(k) ? JSON.parse(store.get(k)) : null; const out = await fn(cur); if (out === undefined) return; store.set(k, JSON.stringify(out)); },
    },
  };
}

const GET = (env, since) => onRequestGet({
  env, request: new Request('https://x/api/dino-park-catchup' + (since === undefined ? '' : `?since=${since}`)),
});
const liveLog = (env) => env.read('dino_live_log');

/* ── recordLiveTick builds intervals ──────────────────────────────────── */
{
  const env = fakeKV();
  const t0 = Date.now() - HOUR;
  /* Five consecutive minute ticks, all live → one interval spanning them. */
  for (let i = 0; i <= 5; i++) await recordLiveTick(env, true, t0 + i * MIN);
  const log = liveLog(env);
  check('consecutive live ticks make one interval', log.intervals.length, 1);
  check('the interval starts at the first tick', log.intervals[0].start, t0);
  check('and ends at the last', log.intervals[0].end, t0 + 5 * MIN);
}
{
  /* An offline tick records nothing and does not extend the interval. */
  const env = fakeKV();
  const t0 = Date.now() - HOUR;
  await recordLiveTick(env, true, t0);
  await recordLiveTick(env, true, t0 + MIN);
  await recordLiveTick(env, false, t0 + 2 * MIN);   // stream went down
  await recordLiveTick(env, false, t0 + 3 * MIN);
  const log = liveLog(env);
  check('offline ticks add no interval', log.intervals.length, 1);
  check('and leave the interval ended at the last live tick', log.intervals[0].end, t0 + MIN);
}
{
  /* A live tick after a long gap opens a NEW interval (a separate broadcast). */
  const env = fakeKV();
  const t0 = Date.now() - 6 * HOUR;
  await recordLiveTick(env, true, t0);
  await recordLiveTick(env, true, t0 + MIN);
  await recordLiveTick(env, true, t0 + 3 * HOUR);   // hours later — a new stream
  const log = liveLog(env);
  check('a live tick after a long gap starts a new interval', log.intervals.length, 2);
}
{
  /* A single missed tick (a gap under the merge tolerance) still counts as
     the same interval rather than splitting it. */
  const env = fakeKV();
  const t0 = Date.now() - HOUR;
  await recordLiveTick(env, true, t0);
  await recordLiveTick(env, true, t0 + 2 * MIN);    // ~one missed tick (120s < 150s tolerance)
  check('a single missed tick does not split the interval', liveLog(env).intervals.length, 1);
}

/* ── onRequestGet sums overlap ────────────────────────────────────────── */
{
  const env = fakeKV();
  const now = Date.now();
  /* A live interval from 2h ago to 1h ago (a 1-hour broadcast). */
  env.store.set('dino_live_log', JSON.stringify({ intervals: [{ start: now - 2 * HOUR, end: now - HOUR }] }));
  const body = await (await GET(env, now - 3 * HOUR)).json();
  check('a live interval fully inside the gap counts in full', body.liveSeconds, 3600);
}
{
  const env = fakeKV();
  const now = Date.now();
  /* Live interval started before `since`: only the part inside [since, now]. */
  env.store.set('dino_live_log', JSON.stringify({ intervals: [{ start: now - 90 * MIN, end: now - 30 * MIN }] }));
  const body = await (await GET(env, now - HOUR)).json();
  check('only the portion inside [since, now] counts', body.liveSeconds, 30 * 60);
}
{
  const env = fakeKV();
  const now = Date.now();
  env.store.set('dino_live_log', JSON.stringify({ intervals: [{ start: now - 5 * HOUR, end: now - 4 * HOUR }] }));
  const body = await (await GET(env, now - HOUR)).json();
  check('an interval entirely before the gap is worth zero', body.liveSeconds, 0);
}
{
  const env = fakeKV();
  const now = Date.now();
  env.store.set('dino_live_log', JSON.stringify({ intervals: [
    { start: now - 5 * HOUR, end: now - 5 * HOUR + 30 * MIN },
    { start: now - 2 * HOUR, end: now - HOUR },
  ] }));
  const body = await (await GET(env, now - 6 * HOUR)).json();
  check('multiple intervals in the gap sum', body.liveSeconds, 30 * 60 + 60 * 60);
}

/* ── No/invalid since, and the window cap ─────────────────────────────── */
{
  const env = fakeKV({ dino_live_log: { intervals: [{ start: Date.now() - HOUR, end: Date.now() }] } });
  check('missing since credits nothing', (await (await GET(env, undefined)).json()).liveSeconds, 0);
  check('since in the future credits nothing', (await (await GET(env, Date.now() + MIN)).json()).liveSeconds, 0);
}
{
  const env = fakeKV();
  const now = Date.now();
  /* Fully inside a 30-day gap but before the 7-day cap → not credited. */
  env.store.set('dino_live_log', JSON.stringify({ intervals: [{ start: now - 10 * DAY, end: now - 10 * DAY + HOUR }] }));
  const body = await (await GET(env, now - 30 * DAY)).json();
  check('live time older than the capped window is not credited', body.liveSeconds, 0);
}
{
  const env = fakeKV();
  check('no log yet credits nothing, cleanly', (await (await GET(env, Date.now() - HOUR)).json()).liveSeconds, 0);
}
{
  /* Never credit more than the gap itself, whatever the log claims. */
  const env = fakeKV();
  const now = Date.now();
  env.store.set('dino_live_log', JSON.stringify({ intervals: [{ start: now - 10 * HOUR, end: now }] }));
  const body = await (await GET(env, now - HOUR)).json();
  check('credit is capped at the gap length', body.liveSeconds, 3600);
}

/* ── Pruning keeps the record bounded ─────────────────────────────────── */
{
  const env = fakeKV();
  const now = Date.now();
  /* Seed an ancient interval, then a live tick now: the old one is pruned. */
  env.store.set('dino_live_log', JSON.stringify({ intervals: [{ start: now - 10 * DAY, end: now - 10 * DAY + HOUR }] }));
  await recordLiveTick(env, true, now);
  const log = liveLog(env);
  ok('an interval past the window is pruned on the next tick',
     log.intervals.every(iv => iv.end >= now - 7 * DAY));
}

/* ── Wiring ───────────────────────────────────────────────────────────── */
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.resolve(HERE, '../..');

  const game = fs.readFileSync(path.join(REPO, 'games/dino-park/index.html'), 'utf8');
  ok('applyOfflineDecay calls the catch-up', /applyEggCatchup\(state\.lastTick\)/.test(game));
  ok('the catch-up credit is additive, never a replace', /e\.elapsed = Math\.min\(e\.hatchTime, e\.elapsed \+ liveSeconds\)/.test(game));

  const idx = fs.readFileSync(path.join(REPO, 'server/index.js'), 'utf8');
  ok('the rig minute tick records live intervals', /recordLiveTick\(env, !!s\.live/.test(idx));

  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the live log is a registered singleton', /dino_live_log:\s*\{ table: 'singletons'/.test(reg));

  const cat = fs.readFileSync(path.join(REPO, 'functions/api/dino-park-catchup.js'), 'utf8');
  ok('the VOD dependency is gone', !/helix\/videos/.test(cat));
}

/* ── Report ───────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[dino-park-catchup] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[dino-park-catchup] ${passed} assertions passed.`);
console.log('');
