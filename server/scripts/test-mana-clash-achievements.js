#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MANA CLASH ACHIEVEMENTS — test suite

     node server/scripts/test-mana-clash-achievements.js

   Drives the real recordManaClashAchievement() and onRequestGet() against a
   fake MARKETPLACE (a Map), mirroring server/scripts/test-mana-clash.js. No
   database, no browser: the point is proving the milestone → dice-grant wiring,
   idempotency, bounded growth, and that a reward can never throw into a game
   write.
   ══════════════════════════════════════════════ */

import {
  recordManaClashAchievement, onRequestGet, ACHIEVEMENTS,
} from '../../functions/api/mana-clash-achievements.js';

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
function ok(label, cond) { check(label, !!cond, true); }

/* ── A KV stand-in ───────────────────────────────────────────────────────
   Same contract as the real DAL: mutate() is read → apply → write, with
   `undefined` meaning "write nothing". Values round-trip through JSON so a
   handler relying on object identity across a write fails here. */
function makeEnv() {
  const store = new Map();
  return {
    MARKETPLACE: {
      async get(key, type) {
        if (!store.has(key)) return null;
        const raw = store.get(key);
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      async put(key, value) { store.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
      async delete(key) { store.delete(key); },
      async mutate(key, fn) {
        const current = store.has(key) ? JSON.parse(store.get(key)) : null;
        const next = await fn(current);
        if (next === undefined) return current;
        store.set(key, JSON.stringify(next));
        return JSON.parse(store.get(key));
      },
    },
    _store: store,
  };
}

function cookieFor(userId, name = 'Player') {
  return `pham_session=${encodeURIComponent(JSON.stringify({ user_id: userId, display_name: name }))}`;
}

async function getState(env, userId) {
  const res = await onRequestGet({
    env,
    request: new Request('https://test.local/api/mana-clash-achievements', {
      headers: userId ? { Cookie: cookieFor(userId) } : {},
    }),
  });
  return { status: res.status, data: await res.json() };
}

function inv(env, userId) {
  const raw = env._store.get('inv_' + userId);
  return raw ? JSON.parse(raw) : null;
}
function diceItems(env, userId, id) {
  const i = inv(env, userId);
  const items = (i && i.items) || [];
  return items.filter(x => x.type === 'dice' && x.game === 'mana-clash' && (!id || x.id === id));
}
/* ── First ranked win → First Blood ─────────────────────────────────────── */
{
  const env = makeEnv();
  const r = await recordManaClashAchievement(env, '101', { type: 'win', ranked: true, goal: 10000 });
  check('a ranked win succeeds', r.ok, true);
  check('and unlocks First Blood', r.unlocked, ['mc-first-win']);
  check('granting its dice', r.granted, ['firstblood']);

  const dice = diceItems(env, '101', 'firstblood');
  check('the firstblood dice land in the inventory exactly once', dice.length, 1);
  check('as a mana-clash dice item', [dice[0].type, dice[0].game], ['dice', 'mana-clash']);
  check('with the right rarity', dice[0].rarity, 'common');

  const state = await getState(env, '101');
  const a = state.data.achievements.find(x => x.id === 'mc-first-win');
  ok('the GET view marks it unlocked', a.unlocked);
  check('and carries the reward dice', a.reward.id, 'firstblood');
  check('the summary counts it', state.data.summary.unlocked, 1);
}

/* ── An unranked win is NOT First Blood, but still a win ─────────────────── */
{
  const env = makeEnv();
  const r = await recordManaClashAchievement(env, '101', { type: 'win', ranked: false, goal: 5000 });
  check('an unranked win unlocks nothing', r.unlocked, []);
  const state = await getState(env, '101');
  const a = state.data.achievements.find(x => x.id === 'mc-first-win');
  check('First Blood stays locked', a.unlocked, false);
  check('its progress is still zero', a.progress, { cur: 0, goal: 1 });
}

/* ── High Roller — bank 2000+ in one turn ───────────────────────────────── */
{
  const env = makeEnv();
  let r = await recordManaClashAchievement(env, '202', { type: 'bank', amount: 1500 });
  check('a 1500 bank does not unlock High Roller', r.unlocked, []);
  let state = await getState(env, '202');
  let a = state.data.achievements.find(x => x.id === 'mc-high-roller');
  check('but the progress tracks the best bank', a.progress, { cur: 1500, goal: 2000 });

  r = await recordManaClashAchievement(env, '202', { type: 'bank', amount: 2500 });
  check('a 2500 bank unlocks High Roller', r.unlocked, ['mc-high-roller']);
  check('granting highroller dice', r.granted, ['highroller']);

  /* A smaller later bank changes nothing and writes nothing. */
  const before = env._store.get('mc_ach_202');
  r = await recordManaClashAchievement(env, '202', { type: 'bank', amount: 10 });
  check('a smaller bank unlocks nothing new', r.unlocked, []);
  check('and does not rewrite the record', env._store.get('mc_ach_202'), before);
}

/* ── Warpath — win 3 in a row, and a loss resets the streak ──────────────── */
{
  const env = makeEnv();
  let r;
  r = await recordManaClashAchievement(env, '303', { type: 'win', ranked: true, goal: 10000 }); // streak 1
  check('win 1 does not unlock Warpath', r.unlocked.includes('mc-streak'), false);
  r = await recordManaClashAchievement(env, '303', { type: 'win', ranked: true, goal: 10000 }); // streak 2
  check('win 2 does not either', r.unlocked.includes('mc-streak'), false);
  r = await recordManaClashAchievement(env, '303', { type: 'win', ranked: true, goal: 10000 }); // streak 3
  check('win 3 unlocks Warpath', r.unlocked.includes('mc-streak'), true);
  check('granting warpath dice', r.granted.includes('warpath'), true);

  /* A loss resets the current streak, but bestStreak (and the unlock) stand. */
  await recordManaClashAchievement(env, '303', { type: 'win', ranked: true, goal: 10000, won: false });
  const rec = JSON.parse(env._store.get('mc_ach_303'));
  check('a loss resets the current streak', rec.progress.streak, 0);
  check('but the best streak is kept', rec.progress.bestStreak, 3);
  const state = await getState(env, '303');
  check('and Warpath stays unlocked', state.data.achievements.find(x => x.id === 'mc-streak').unlocked, true);
}

/* ── Six Shooter — a six-of-a-kind in one roll ──────────────────────────── */
{
  const env = makeEnv();
  let r = await recordManaClashAchievement(env, '404', { type: 'roll', sixOfAKind: false });
  check('an ordinary roll unlocks nothing', r.unlocked, []);
  r = await recordManaClashAchievement(env, '404', { type: 'roll', sixOfAKind: true });
  check('a six-of-a-kind unlocks Six Shooter', r.unlocked, ['mc-six-shooter']);
  check('granting sixshooter dice', r.granted, ['sixshooter']);

  /* A second six-of-a-kind re-grants nothing. */
  r = await recordManaClashAchievement(env, '404', { type: 'roll', sixOfAKind: true });
  check('a second six grants nothing new', [r.unlocked, r.granted], [[], []]);
  check('and the dice are still owned once', diceItems(env, '404', 'sixshooter').length, 1);
}

/* ── Marathoner — win a 20,000-point game ───────────────────────────────── */
{
  const env = makeEnv();
  const r = await recordManaClashAchievement(env, '505', { type: 'win', ranked: false, goal: 20000 });
  check('winning a 20k game unlocks Marathoner', r.unlocked.includes('mc-marathoner'), true);
  check('granting the mythic marathon dice', r.granted.includes('marathon'), true);
  const dice = diceItems(env, '505', 'marathon');
  check('with mythic rarity', dice[0].rarity, 'mythic');
  /* A 10k win does NOT grant Marathoner. */
  const env2 = makeEnv();
  const r2 = await recordManaClashAchievement(env2, '505', { type: 'win', ranked: true, goal: 10000 });
  check('a 10k win is not Marathoner', r2.unlocked.includes('mc-marathoner'), false);
}

/* ── Daily Devotee — 5 distinct days, bounded ───────────────────────────── */
{
  const env = makeEnv();
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
  for (const d of days) await recordManaClashAchievement(env, '606', { type: 'daily', dayKey: d });
  let state = await getState(env, '606');
  let a = state.data.achievements.find(x => x.id === 'mc-daily-devotee');
  check('four distinct days is not yet Devotee', a.unlocked, false);
  check('progress shows 4 of 5', a.progress, { cur: 4, goal: 5 });

  /* The same day again does not advance it. */
  const r0 = await recordManaClashAchievement(env, '606', { type: 'daily', dayKey: '2026-10-04' });
  check('a repeat day advances nothing', r0.unlocked, []);

  const r = await recordManaClashAchievement(env, '606', { type: 'daily', dayKey: '2026-10-05' });
  check('the fifth distinct day unlocks Devotee', r.unlocked, ['mc-daily-devotee']);
  check('granting devotee dice', r.granted, ['devotee']);

  /* Bounded: two further days do not grow the stored list past the threshold. */
  await recordManaClashAchievement(env, '606', { type: 'daily', dayKey: '2026-10-06' });
  await recordManaClashAchievement(env, '606', { type: 'daily', dayKey: '2026-10-07' });
  const rec = JSON.parse(env._store.get('mc_ach_606'));
  check('the day list never grows past the requirement', rec.progress.dailyDays.length, 5);
}

/* ── Idempotency across a full re-run ────────────────────────────────────── */
{
  const env = makeEnv();
  await recordManaClashAchievement(env, '707', { type: 'win', ranked: true, goal: 10000 });
  const r = await recordManaClashAchievement(env, '707', { type: 'win', ranked: true, goal: 10000 });
  check('re-winning grants no new achievement', r.unlocked, []);
  check('and re-grants no dice', r.granted, []);
  check('the dice are owned exactly once', diceItems(env, '707', 'firstblood').length, 1);
}

/* ── It never throws into the caller ─────────────────────────────────────── */
{
  const env = makeEnv();
  check('a missing env is reported, not thrown',
    (await recordManaClashAchievement(null, '1', { type: 'win' })).ok, false);
  check('a null event is reported, not thrown',
    (await recordManaClashAchievement(env, '1', null)).ok, false);
  check('a null userId is reported, not thrown',
    (await recordManaClashAchievement(env, null, { type: 'win' })).ok, false);

  const bogus = await recordManaClashAchievement(env, '1', { type: 'nonsense' });
  check('an unknown event type is a harmless no-op', [bogus.ok, bogus.unlocked], [true, []]);

  const badEnv = { MARKETPLACE: { async mutate() { throw new Error('boom'); }, async get() { return null; } } };
  check('a storage failure is swallowed',
    (await recordManaClashAchievement(badEnv, '1', { type: 'win', ranked: true, goal: 10000 })).ok, false);
}

/* ── No-op events write nothing ──────────────────────────────────────────── */
{
  const env = makeEnv();
  await recordManaClashAchievement(env, '808', { type: 'bank', amount: 0 });
  check('a zero bank for a new user creates no record', env._store.has('mc_ach_808'), false);
}

/* ── GET requires a login ────────────────────────────────────────────────── */
{
  const env = makeEnv();
  const anon = await getState(env, null);
  check('an anonymous read is refused', anon.status, 401);

  const named = await getState(env, '909');
  check('a fresh user reads every achievement locked', named.data.summary, { unlocked: 0, total: ACHIEVEMENTS.length });
  check('with the full catalog', named.data.achievements.length, ACHIEVEMENTS.length);
  check('each carrying a reward dice id', named.data.achievements.every(a => a.reward && a.reward.id), true);
}

/* ── Report ──────────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failing check(s):\n`);
  for (const f of failures) console.error('  • ' + f + '\n');
  console.error(`${passed} passed, ${failures.length} failed.`);
  process.exit(1);
} else {
  console.log(`✓ mana-clash achievements: all ${passed} checks passed.`);
}
