#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO STREAM SAFARI — chat catches wild dinos on the overlay (Epic D #12)

     node server/scripts/test-dino-safari.js

   Covers the wild roll (real hatch rarity weights + species pools), the catch
   window (dedup + bound + rate limit), both resolution rules (raffle with an
   injected RNG, first by arrival), the rule toggle, the species-pinned egg grant
   through grantEgg, an uncaught spawn expiring with no grant, the broadcaster/mod
   gate on start, and the session self-clearing when idle/ended.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rollWildDino, pickWinner, resolveSpawn, advanceSafari, publicSafari, isLive,
  catchFromChat, trackFromChat, rollsForTrackers, onRequestGet, onRequestPost,
  SAFARI_KEY, CATCH_WINDOW_MS, IDLE_MS, DEFAULT_INTERVAL_SEC,
} from '../../functions/api/dino-safari.js';
import { grantEgg } from '../../functions/api/dino-park.js';
import { SPECIES, RARITIES } from '../../functions/api/dino-species.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async mutate(k, fn) { const cur = store.has(k) ? JSON.parse(store.get(k)) : null; const out = await fn(cur); if (out === undefined) return; store.set(k, JSON.stringify(out)); },
  };
}
const envWith = (seed) => ({ MARKETPLACE: fakeKV(seed) });

function spawnObj(o = {}) {
  const catchers = o.catchers || [];
  const seen = o.seen || catchers.reduce((m, x) => { m[x.userId] = 1; return m; }, {});
  return {
    id: 'sp1',
    speciesId: o.speciesId || 'trike',
    rarity: o.rarity || 'rare',
    mutation: o.mutation || null,
    name: o.name || 'Triceratops',
    icon: 'icon.png', portrait: 'portrait.png',
    rule: o.rule || 'raffle',
    spawnedAt: Date.now(),
    catchUntil: o.catchUntil != null ? o.catchUntil : Date.now() + CATCH_WINDOW_MS,
    catchers,
    seen,
    count: o.count != null ? o.count : catchers.length,
  };
}
function liveSession(o = {}) {
  const now = Date.now();
  return {
    status: 'active',
    startedAt: o.lastActiveAt != null ? o.lastActiveAt : now,
    lastActiveAt: o.lastActiveAt != null ? o.lastActiveAt : now,
    by: o.by || 'Host',
    rule: o.rule || 'raffle',
    intervalMs: o.intervalMs != null ? o.intervalMs : 60000,
    spawn: o.spawn !== undefined ? o.spawn : null,
    nextSpawnAt: o.nextSpawnAt !== undefined ? o.nextSpawnAt : null,
    lastWin: o.lastWin || null,
    lastWinUntil: o.lastWinUntil || 0,
    spawns: o.spawns || (o.spawn ? 1 : 0),
    caught: 0,
  };
}

/* ══ The wild roll — reuses the real hatch weights + species pools ═════════ */
{
  const d = rollWildDino({ rarity: () => 'epic', species: () => 'trex', mutation: () => null });
  check('an injected roll pins the rarity', d.rarity, 'epic');
  check('and the species', d.speciesId, 'trex');
  check('and resolves the species name', d.name, 'Tyrannosaurus Rex');
  ok('and carries an icon + portrait for the overlay', d.icon && d.portrait);

  const counts = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 };
  const N = 40000;
  for (let i = 0; i < N; i++) counts[rollWildDino().rarity]++;
  ok('common is by far the most frequent wild dino', counts.common / N > 0.7 && counts.common / N < 0.87);
  ok('every tier can appear in the wild', RARITIES.every(r => counts[r] > 0));
  ok('legendary is the rarest wild dino', counts.legendary < counts.epic && counts.epic < counts.rare);

  let inTier = true;
  for (let i = 0; i < 500; i++) { const w = rollWildDino(); if (SPECIES[w.speciesId].rarity !== w.rarity) inTier = false; }
  ok('a wild species always matches its rolled rarity', inTier);
}

/* ══ pickWinner — raffle (injectable) + first (arrival) ════════════════════ */
{
  const catchers = [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }, { userId: 'd' }];
  check('raffle with rng→0 picks the first slot', pickWinner(catchers, 'raffle', () => 0).userId, 'a');
  check('raffle with rng→0.99 picks the last slot', pickWinner(catchers, 'raffle', () => 0.99).userId, 'd');
  check('raffle with rng→0.5 picks deterministically', pickWinner(catchers, 'raffle', () => 0.5).userId, 'c');
  check('first always picks the earliest catcher', pickWinner(catchers, 'first').userId, 'a');
  check('nobody caught → no winner', pickWinner([], 'raffle', () => 0), null);
}

/* ══ resolveSpawn — the grant is pinned to the spawned species ═════════════ */
{
  const sp = spawnObj({ speciesId: 'trike', rarity: 'rare', rule: 'raffle', catchers: [{ userId: 'x1' }, { userId: 'x2' }] });
  const r = resolveSpawn(sp, () => 0.99);
  check('raffle resolution names the rng-picked winner', r.win.winnerId, 'x2');
  check('and the grant is pinned to the exact species', r.grant.speciesId, 'trike');
  check('at the spawned rarity', r.grant.rarity, 'rare');
  check('to the winning chatter', r.grant.winnerId, 'x2');

  const first = resolveSpawn(spawnObj({ rule: 'first', catchers: [{ userId: 'first' }, { userId: 'second' }] }));
  check('first resolution names the earliest catcher', first.win.winnerId, 'first');

  const none = resolveSpawn(spawnObj({ catchers: [] }));
  check('an uncaught spawn resolves with no grant', none.grant, null);
  check('and the banner records it got away', none.win.caught, false);
}

/* ══ advanceSafari — lazy lifecycle, bounded, injectable ═══════════════════ */
{
  // A closed spawn resolves and schedules the next; nothing rolls backlog.
  const s = liveSession({
    intervalMs: 60000,
    spawn: spawnObj({ speciesId: 'trike', rarity: 'rare', rule: 'raffle', catchUntil: Date.now() - 10, catchers: [{ userId: 'w' }] }),
  });
  const now = Date.now();
  const adv = advanceSafari(s, now, { rng: () => 0 });
  ok('resolving a closed spawn reports a change', adv.changed);
  check('it yields one grant', adv.grants.length, 1);
  check('pinned to the spawned species', adv.grants[0].speciesId, 'trike');
  check('the spawn is cleared after resolving', s.spawn, null);
  ok('the next spawn is scheduled one interval out', s.nextSpawnAt >= now + 60000);
  ok('the winner banner is recorded', s.lastWin && s.lastWin.winnerId === 'w');
}
{
  // An uncaught spawn expires with NO grant, and the next rolls when due.
  const s = liveSession({
    intervalMs: 1000,
    spawn: spawnObj({ catchUntil: Date.now() - 10, catchers: [] }),
  });
  const a1 = advanceSafari(s, Date.now(), { rng: () => 0 });
  check('an uncaught spawn grants nothing', a1.grants.length, 0);
  check('and its banner says it got away', s.lastWin.caught, false);
  const a2 = advanceSafari(s, s.nextSpawnAt + 1, { roll: { rarity: () => 'legendary', species: () => 'quetz', mutation: () => null } });
  ok('the next wild dino rolls once its gap passes', a2.changed && s.spawn);
  check('and it is the injected species', s.spawn.speciesId, 'quetz');
}
{
  // The rule toggle is honored end to end.
  const base = { intervalMs: 1000, spawn: spawnObj({ catchUntil: Date.now() - 10, catchers: [{ userId: 'p1' }, { userId: 'p2' }, { userId: 'p3' }] }) };
  const raffle = liveSession({ ...base, rule: 'raffle', spawn: spawnObj({ rule: 'raffle', catchUntil: Date.now() - 10, catchers: [{ userId: 'p1' }, { userId: 'p2' }, { userId: 'p3' }] }) });
  advanceSafari(raffle, Date.now(), { rng: () => 0.99 });
  check('a raffle session picks by rng', raffle.lastWin.winnerId, 'p3');
  const firstS = liveSession({ ...base, rule: 'first', spawn: spawnObj({ rule: 'first', catchUntil: Date.now() - 10, catchers: [{ userId: 'p1' }, { userId: 'p2' }, { userId: 'p3' }] }) });
  advanceSafari(firstS, Date.now(), { rng: () => 0.99 });
  check('a first session ignores rng and takes the earliest', firstS.lastWin.winnerId, 'p1');
}

/* ══ catchFromChat — dedup, rate limit, bound, silent ═════════════════════ */
{
  const e = envWith({ [SAFARI_KEY]: liveSession({ spawn: spawnObj({ catchers: [] }) }) });
  await catchFromChat(e, { userId: 'c1', name: 'One' });
  await catchFromChat(e, { userId: 'c1', name: 'One' });   // same chatter again
  check('a chatter is counted once per spawn (dedup = rate limit)', e.MARKETPLACE.read(SAFARI_KEY).spawn.count, 1);
  await catchFromChat(e, { userId: 'c2', name: 'Two' });
  check('a different chatter adds another', e.MARKETPLACE.read(SAFARI_KEY).spawn.count, 2);
  ok('no reply is sent — the catch is silent (ok flag only)',
    (await catchFromChat(e, { userId: 'c3' })).ok === true);
}
{
  // Bounded: a full catcher set turns new chatters away.
  const seen = {}; for (let i = 0; i < 2000; i++) seen['u' + i] = 1;   // MAX_CATCHERS
  const e = envWith({ [SAFARI_KEY]: liveSession({ spawn: spawnObj({ seen, count: 2000, catchers: [] }) }) });
  const r = await catchFromChat(e, { userId: 'latecomer' });
  check('a full catcher set rejects a new chatter', r.ok, false);
  check('and the count does not grow past the cap', e.MARKETPLACE.read(SAFARI_KEY).spawn.count, 2000);
}
{
  // No live Safari → a quiet no-op.
  const e = envWith({});
  const r = await catchFromChat(e, { userId: 'nobody' });
  check('no Safari means nothing to catch', r, { ok: false, status: 'none' });
}

/* ══ End-to-end grant — a chat-only catcher receives the pinned egg ════════ */
{
  const e = envWith({
    [SAFARI_KEY]: liveSession({
      intervalMs: 60000,
      spawn: spawnObj({ speciesId: 'trike', rarity: 'rare', catchUntil: Date.now() - 10, catchers: [{ userId: 'chatuser', name: 'Chatter' }] }),
    }),
  });
  await e.MARKETPLACE.put('overlay_key', 'k');
  const res = await onRequestGet({ env: e, request: new Request('https://x/api/dino-safari?key=k') });
  const body = await res.json();
  check('the poll resolves the closed window to waiting', body.phase, 'waiting');
  ok('and reports the winner banner', body.lastWin && body.lastWin.winnerId === 'chatuser');
  const save = e.MARKETPLACE.read('dino_park_chatuser');
  ok('a chat-only catcher with no prior save gets one created', save && save.state);
  check('and receives exactly one egg', save.state.eggs.length, 1);
  check('pinned to the exact dino the stream saw', save.state.eggs[0].speciesId, 'trike');
}

/* ══ grantEgg pin — honoured only at the matching rarity ═══════════════════ */
{
  const e = envWith({});
  const r = await grantEgg(e, 'u9', 'rare', { speciesId: 'trike' });
  check('a rarity-matched pin is granted exactly', r.egg.speciesId, 'trike');
}
{
  const e = envWith({});
  const r = await grantEgg(e, 'u9', 'epic', { speciesId: 'trike' });   // trike is rare, not epic
  ok('a mismatched-rarity pin is ignored and rolls in-tier', r.egg.speciesId !== 'trike');
  check('and the egg stays at the requested rarity', SPECIES[r.egg.speciesId].rarity, 'epic');
}

/* ══ Overlay GET key gate ═════════════════════════════════════════════════ */
{
  const e = envWith({});
  await e.MARKETPLACE.put('overlay_key', 'secret');
  const bad = await onRequestGet({ env: e, request: new Request('https://x/api/dino-safari?key=wrong') });
  check('the overlay GET rejects a bad key', bad.status, 403);
}

/* ══ POST — broadcaster/moderator only ════════════════════════════════════ */
function postReq(session, bodyObj) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers.Cookie = 'pham_session=' + encodeURIComponent(JSON.stringify(session));
  return new Request('https://x/api/dino-safari', { method: 'POST', headers, body: JSON.stringify(bodyObj) });
}
{
  const e = { MARKETPLACE: fakeKV({}), TWITCH_BROADCASTER_ID: '111' };
  const anon = await onRequestPost({ env: e, request: postReq(null, { action: 'start' }) });
  check('an anonymous start is refused', anon.status, 403);

  const stranger = await onRequestPost({ env: e, request: postReq({ user_id: '999' }, { action: 'start' }) });
  check('a non-moderator start is refused', stranger.status, 403);

  const boss = await onRequestPost({ env: e, request: postReq({ user_id: '111', display_name: 'Boss' }, { action: 'start', rule: 'first', intervalSec: 45 }) });
  const bossBody = await boss.json();
  check('the broadcaster may start a Safari', boss.status, 200);
  check('the start honours the rule toggle', bossBody.safari.rule, 'first');
  check('and the configured interval', bossBody.safari.intervalSec, 45);
  check('and a wild dino is already spawned', bossBody.safari.phase, 'catch');
  ok('with a catchable species', bossBody.safari.spawn && bossBody.safari.spawn.speciesId);
}
{
  // A moderator on the allowlist may start; the default rule is raffle.
  const e = { MARKETPLACE: fakeKV({ site_moderators: { entries: [{ userId: '555' }] } }), TWITCH_BROADCASTER_ID: '111' };
  const mod = await onRequestPost({ env: e, request: postReq({ user_id: '555', display_name: 'Mod' }, { action: 'start' }) });
  const body = await mod.json();
  check('an allowlisted moderator may start a Safari', mod.status, 200);
  check('the default catch rule is raffle', body.safari.rule, 'raffle');
  check('and the default interval is the configured default', body.safari.intervalSec, DEFAULT_INTERVAL_SEC);
}

/* ══ Self-clear — idle and explicit stop ══════════════════════════════════ */
{
  const stale = liveSession({ lastActiveAt: Date.now() - IDLE_MS - 1000, spawn: spawnObj({}) });
  check('an idle Safari reads as none', publicSafari(stale).status, 'none');
  ok('isLive is false past the idle window', !isLive(stale, Date.now()));

  const e = envWith({ [SAFARI_KEY]: stale });
  await e.MARKETPLACE.put('overlay_key', 'k');
  const res = await onRequestGet({ env: e, request: new Request('https://x/api/dino-safari?key=k') });
  check('the overlay poll reports none for an idle Safari', (await res.json()).status, 'none');
  check('and the row is tombstoned so it stops showing', e.MARKETPLACE.read(SAFARI_KEY).status, 'ended');
}
{
  const e = { MARKETPLACE: fakeKV({}), TWITCH_BROADCASTER_ID: '111' };
  await onRequestPost({ env: e, request: postReq({ user_id: '111' }, { action: 'start' }) });
  const stop = await onRequestPost({ env: e, request: postReq({ user_id: '111' }, { action: 'stop' }) });
  const body = await stop.json();
  check('an explicit stop succeeds', body.success, true);
  check('and the Safari reads as none afterward', body.safari.status, 'none');
  check('the stored row is tombstoned', e.MARKETPLACE.read(SAFARI_KEY).status, 'ended');
}

/* ══ TRACKING: the part of a Safari chat actually plays ════════════════
   The catch window is 25 seconds; the gap is a minute. For most of a Safari
   there is nothing to do but wait, so !track turns the gap into the game.

   It buys EXTRA ROLLS on the same weighted table, best rarity wins. It must
   never shift the weights or touch the species pool — the Safari deliberately
   shares the hatch minigame's odds, and bending them here would quietly make
   it a different game. */
{
  check('no trackers is one roll', rollsForTrackers(0), 1);
  check('a few is still one', rollsForTrackers(14), 1);
  check('fifteen buys the second', rollsForTrackers(15), 2);
  check('thirty buys a third', rollsForTrackers(30), 3);
  check('and it is capped', rollsForTrackers(100000), 5);
}

{
  /* Best-of-N on a rigged roller: the sequence is common, legendary, common.
     One roll takes the common; three take the legendary. */
  const seq = ['common', 'legendary', 'common'];
  let i = 0;
  const roll = { rarity: () => seq[i++ % seq.length], species: (r) => Object.keys(SPECIES).find(k => SPECIES[k].rarity === r), mutation: () => null };

  i = 0;
  check('one roll takes what it is given', rollWildDino(roll, 1).rarity, 'common');
  i = 0;
  check('three rolls keep the best', rollWildDino(roll, 3).rarity, 'legendary');
  i = 0;
  const w = rollWildDino(roll, 3);
  check('and the species still comes from that rarity tier', SPECIES[w.speciesId].rarity, 'legendary');
}

{
  /* Tracking only happens in the gap. */
  const e = envWith({ [SAFARI_KEY]: liveSession({ spawn: spawnObj({ catchers: [] }) }) });
  check('a dino on screen means catch, not track', (await trackFromChat(e, { userId: '1' })).reason, 'catching');

  const gap = envWith({ [SAFARI_KEY]: liveSession({ nextSpawnAt: Date.now() + 60000 }) });
  check('tracking lands in the gap', (await trackFromChat(gap, { userId: '1' })).ok, true);
  check('once each', (await trackFromChat(gap, { userId: '1' })).reason, 'already');
  check('and a second person adds one', (await trackFromChat(gap, { userId: '2' })).trackers, 2);

  const st = publicSafari(gap.MARKETPLACE.read(SAFARI_KEY));
  check('the panel shows the turnout', st.trackers, 2);
  check('with what it has earned so far', st.rolls, 1);
}

{
  const e = envWith({});
  check('no Safari, no tracking', (await trackFromChat(e, { userId: '1' })).ok, false);
}

{
  /* Tracking is activity: a Safari chat is working on must not idle out. */
  const stale = Date.now() - (IDLE_MS - 30000);
  const e = envWith({ [SAFARI_KEY]: liveSession({ lastActiveAt: stale, nextSpawnAt: Date.now() + 1000 }) });
  await trackFromChat(e, { userId: '1' });
  const after = e.MARKETPLACE.read(SAFARI_KEY);
  ok('tracking keeps the session alive', after.lastActiveAt > stale);
}

{
  /* The turnout pays for the NEXT dino, then resets. */
  const s = liveSession({ nextSpawnAt: Date.now() - 1 });
  s.tracking = {};
  for (let i = 0; i < 30; i++) s.tracking['u' + i] = 1;

  advanceSafari(s, Date.now(), { roll: { rarity: () => 'common', species: () => 'trike', mutation: () => null } });
  ok('the next dino rolled', !!s.spawn);
  check('the spawn records who paid for it', s.spawn.trackedBy, 30);
  check('and how many rolls that bought', s.spawn.rolls, 3);
  check('the gap starts from nothing again', Object.keys(s.tracking || {}).length, 0);

  const st = publicSafari(s);
  check('the catch view carries it, so the payoff shows on the dino', st.trackedBy, 30);
  check('with the roll count', st.rolls, 3);
}

{
  const cmds = fs.readFileSync(path.join(REPO, 'functions/api/bot/commands.js'), 'utf8');
  ok('chat dispatches !track', /parsed\.command === '!track'/.test(cmds));
  ok('as a PUBLIC command, before the moderator gate',
     cmds.indexOf("'!track'") < cmds.indexOf('if (!isAuthorizedSender(env, event)) return;'));

  const driver = fs.readFileSync(path.join(REPO, 'js/pages/overlay-dino-safari.js'), 'utf8');
  ok('the panel asks for tracking during the gap', /!track<\/b>/.test(driver));
  ok('and shows what it bought on the dino', /ovSafariRolls/.test(driver));
}

/* ══ Report ════════════════════════════════════════════════════════════ */
if (failures.length) {
  console.error(`\n  ✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('    ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  ✓ all ${passed} dino-safari checks passed\n`);
