#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DAILY RIVAL — Dino Park's daily challenge

     node server/scripts/test-dino-rival.js

   No network, no database: a fake in-memory KV (get/put/delete/mutate) and
   fake pham_session cookies, in the test-daily.js style. Proves the four
   things that matter:

     1. DETERMINISM — todaysRival is a pure function of the day key: same day,
        identical rival; a different day can differ.
     2. ONE ATTEMPT PER PACIFIC DAY — a first POST fights and settles; a second
        POST the same day is refused (409) and nothing is paid again.
     3. SERVER-AUTHORITATIVE REWARD — a win pays Dino Park coins + care XP into
        the CHAMPION's shared xp pool via a 'carexp' op and a grantSeq bump; the
        body's figures are ignored by construction (nothing reads them).
     4. markDailyComplete is called exactly once for 'dino-rival' per day (the
        hub shows it done), done-on-attempt whether the fight is won or lost.

   Plus the wiring greps that would silently 500/crash the rig if they drift.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as rival from '../../functions/api/daily-rival.js';
import { readDaily } from '../../functions/api/daily/state.js';
import { dayKey } from '../../functions/api/season-time.js';
import { careLevelFromXp } from '../../functions/api/dino-battle/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── Fake KV with mutate(), matching test-daily.js ── */
function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    async mutate(key, fn) {
      const cur = store.has(key) ? JSON.parse(store.get(key)) : null;
      const next = await fn(cur);
      if (next !== undefined) store.set(key, JSON.stringify(next));
      return next === undefined ? cur : next;
    },
  };
}
const fakeEnv = (seed) => ({ MARKETPLACE: fakeKV(seed) });

function sessionReq(url, { userId, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (userId) {
    const cookie = encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'Nyx' }));
    headers.Cookie = 'pham_session=' + cookie;
  }
  return new Request('https://phantomace.tv' + url, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
}

/* A save with one overpowering champion (a maxed legendary — stat level caps at
   30, and the daily rival tops out at legendary lv22, so it wins on the vast
   majority of seeds) and one level-1 weakling (a common that loses on the vast
   majority of seeds). The outcome of any single fight is still deterministic per
   (day, userId, dino), so the win/loss cases below SEARCH user ids for a seed
   that yields the outcome under test rather than assume today's rival — which
   keeps the test robust whichever calendar day it runs on. */
function seedSave(userId, { championXp = 400000, weaklingXp = 0 } = {}) {
  return {
    [`dino_park_${userId}`]: {
      userId,
      state: {
        coins: 100, grantSeq: 0, marketOps: [], appliedOps: [],
        park: [
          { uid: 'champ', speciesId: 'liopl', xp: championXp, nickname: 'Maw', mutation: null },
          { uid: 'weak', speciesId: 'compy', xp: weaklingXp, nickname: 'Pip', mutation: null },
        ],
        vault: [],
      },
    },
  };
}

/* Find a user id whose deterministic fight (champion 'champ' for a win, weakling
   'weak' for a loss) gives the wanted outcome today, each tried in a throwaway
   env so the search never consumes the real test user's one attempt. Returns the
   id, or null if none of the candidates matched (a legendary champion / lv1
   weakling make a match overwhelmingly likely). */
async function findSeedFor(win, uid) {
  for (let i = 0; i < 120; i++) {
    const id = `seek_${win ? 'w' : 'l'}_${i}`;
    const env = fakeEnv(seedSave(id));
    const res = await rival.onRequestPost({
      env, request: sessionReq('/api/daily-rival', { userId: id, method: 'POST', body: { uid } }),
    });
    const d = await res.json();
    if (d.success && d.result.win === win) return id;
  }
  return null;
}

function entriesFor(env, userId) {
  let total = 0;
  for (const [, v] of env.MARKETPLACE.store) {
    try {
      const rec = JSON.parse(v);
      if (rec && rec.userId === String(userId) && rec.entries != null) total += Number(rec.entries) || 0;
    } catch { /* not a ledger record */ }
  }
  return total;
}

const today = dayKey();

/* The hub's CHALLENGES list does not yet carry the dino-rival entry (that is a
   manager-owned edit). markDailyComplete still records the id in the per-user
   done-map regardless, so completion is verified against the raw record. */
async function markedDone(env, userId, id = 'dino-rival') {
  const rec = await readDaily(env, userId);
  return Array.isArray(rec.done && rec.done[today]) && rec.done[today].includes(id);
}

/* ══ 1. WIRING ══════════════════════════════════
   The registry prefix and the CHALLENGES entry live in files the MANAGER owns
   and applies (this agent must not edit them), so they are reported as pending
   rather than failed — the route is isolation-tested until those land. */
const registry = read('server/lib/registry.js');
const stateSrc = read('functions/api/daily/state.js');
const pending = [];
if (!/prefix:\s*'dino_rival_'/.test(registry)) pending.push("registry.js: add { prefix: 'dino_rival_', table: 'dino_parks', expiry: 'none' }");
if (!/id:\s*'dino-rival'/.test(stateSrc)) pending.push("daily/state.js: append the dino-rival CHALLENGES entry");

const html = read('games/dino-park/index.html');
ok('the game has a daily-rival panel', /id="dailyRivalPanel"/.test(html));
ok('the game calls the daily-rival endpoint', /\/api\/daily-rival/.test(html));
ok('the game deep-links ?daily=rival', /daily'?\)\s*===\s*'rival'|get\('daily'\)/.test(html));

/* ══ 2. DETERMINISM ═════════════════════════════ */
await (function determinism() {
  const a = rival.todaysRival(today);
  const b = rival.todaysRival(today);
  check('same day → same species', a.speciesId, b.speciesId);
  check('same day → same rarity', a.rarity, b.rarity);
  check('same day → same level', a.level, b.level);
  ok('rival has combat stats', a.stats && a.stats.hp > 0 && a.stats.atk > 0);
  ok('rival carries an archetype', typeof a.archetype === 'string' && a.archetype.length > 0);

  /* Across many future days the rival is not frozen to one species — proves the
     day key actually drives the pick rather than a constant. */
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const d = new Date(today + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    seen.add(rival.todaysRival(dayKey(d)).speciesId);
  }
  ok('rival rotates across days', seen.size > 1);
})();

/* ══ 3. GET SHAPES ══════════════════════════════ */
await (async function getLoggedOutTeasesRival() {
  const env = fakeEnv();
  const res = await rival.onRequestGet({ env, request: sessionReq('/api/daily-rival') });
  const d = await res.json();
  check('logged-out GET says so', d.loggedIn, false);
  ok('logged-out GET still ships the rival', d.rival && d.rival.name);
  check('logged-out GET lists no dinos', d.dinos, undefined);
})();

await (async function getBeforeFighting() {
  const env = fakeEnv(seedSave('u1'));
  const res = await rival.onRequestGet({ env, request: sessionReq('/api/daily-rival', { userId: 'u1' }) });
  const d = await res.json();
  check('GET before fighting: no record', d.record, null);
  ok('GET lists the eligible champions', Array.isArray(d.dinos) && d.dinos.length === 2);
  ok('a champion carries level + stats', d.dinos[0].level >= 1 && d.dinos[0].stats.hp > 0);
})();

/* ══ 4. ONE ATTEMPT / WIN PAYS / MARKS DONE ═════ */
await (async function winPaysAndMarksDone() {
  const winner = await findSeedFor(true, 'champ');
  ok('found a seed where the champion wins today', winner !== null);
  const env = fakeEnv(seedSave(winner));
  const res = await rival.onRequestPost({
    env, request: sessionReq('/api/daily-rival', { userId: winner, method: 'POST', body: { uid: 'champ' } }),
  });
  const d = await res.json();
  ok('POST succeeds', d.success === true);
  check('the champion beat the rival', d.result.win, true);
  ok('a win pays coins', d.result.coins > 0);
  ok('a win pays care XP', d.result.xp > 0);
  ok('the fight produced a log', Array.isArray(d.result.log) && d.result.log.length > 0);

  /* Reward settled into the SAVE, not trusted from any client figure. */
  const save = await env.MARKETPLACE.get('dino_park_' + winner, 'json');
  check('coins credited to the save', save.state.coins, 100 + d.result.coins);
  ok('grantSeq bumped so the client reconciles once', save.state.grantSeq === 1);
  const champ = save.state.park.find(x => x.uid === 'champ');
  check('care XP added to the champion', champ.xp, 400000 + d.result.xp);
  ok('a carexp op was pushed for the champion',
    save.state.marketOps.some(o => o.t === 'carexp' && o.uid === 'champ' && o.d === d.result.xp));
  ok('a coins op was pushed', save.state.marketOps.some(o => o.t === 'coins' && o.d === d.result.coins));

  /* Completion recorded for the hub; the meta reward (giveaway entries) is the
     framework's job on a WHOLE-DAY clear, NOT this route's — the rival itself
     pays only Dino Park currency, so it grants no entries on its own. */
  ok('markDailyComplete recorded dino-rival done', await markedDone(env, winner));
  check('the rival itself pays no giveaway entries', entriesFor(env, winner), 0);
})();

await (async function secondAttemptRefused() {
  const env = fakeEnv(seedSave('u2'));
  const first = await rival.onRequestPost({
    env, request: sessionReq('/api/daily-rival', { userId: 'u2', method: 'POST', body: { uid: 'champ' } }),
  });
  await first.json();
  const saveAfterFirst = await env.MARKETPLACE.get('dino_park_u2', 'json');
  const coinsAfterFirst = saveAfterFirst.state.coins;
  const seqAfterFirst = saveAfterFirst.state.grantSeq;

  const second = await rival.onRequestPost({
    env, request: sessionReq('/api/daily-rival', { userId: 'u2', method: 'POST', body: { uid: 'weak' } }),
  });
  check('second attempt is refused (409)', second.status, 409);
  const d2 = await second.json();
  ok('the refusal reports it was already fought', d2.alreadyFought === true);
  ok('the refusal hands back the first result', d2.result && typeof d2.result.win === 'boolean');

  const saveAfterSecond = await env.MARKETPLACE.get('dino_park_u2', 'json');
  check('no coins paid a second time', saveAfterSecond.state.coins, coinsAfterFirst);
  check('grantSeq unchanged by the refused attempt', saveAfterSecond.state.grantSeq, seqAfterFirst);
})();

await (async function lossStillMarksDoneButPaysNoCoins() {
  /* A level-1 weakling loses, but the attempt still counts for the hub
     (done-on-attempt), and only a little training XP is paid — no coins. */
  const loser = await findSeedFor(false, 'weak');
  ok('found a seed where the weakling loses today', loser !== null);
  const env = fakeEnv(seedSave(loser));
  const res = await rival.onRequestPost({
    env, request: sessionReq('/api/daily-rival', { userId: loser, method: 'POST', body: { uid: 'weak' } }),
  });
  const d = await res.json();
  ok('POST still succeeds on a loss', d.success === true);
  check('the weakling lost', d.result.win, false);
  check('a loss pays no coins', d.result.coins, 0);
  ok('a loss pays a little training XP', d.result.xp > 0);

  const save = await env.MARKETPLACE.get('dino_park_' + loser, 'json');
  check('no coins credited on a loss', save.state.coins, 100);
  ok('training XP still added to the fighter', save.state.park.find(x => x.uid === 'weak').xp === d.result.xp);

  ok('a loss still marks the daily done (done-on-attempt)', await markedDone(env, loser));
})();

await (async function getAfterFightingReturnsRecord() {
  const env = fakeEnv(seedSave('u4'));
  await rival.onRequestPost({
    env, request: sessionReq('/api/daily-rival', { userId: 'u4', method: 'POST', body: { uid: 'champ' } }),
  });
  const res = await rival.onRequestGet({ env, request: sessionReq('/api/daily-rival', { userId: 'u4' }) });
  const d = await res.json();
  ok('GET after fighting returns the record', d.record && d.record.fought === true);
  ok('the record carries the outcome and log',
    typeof d.record.win === 'boolean' && Array.isArray(d.record.log) && d.record.log.length > 0);
})();

await (async function badInputs() {
  const env = fakeEnv(seedSave('u5'));
  const noLogin = await rival.onRequestPost({
    env, request: sessionReq('/api/daily-rival', { method: 'POST', body: { uid: 'champ' } }),
  });
  check('anonymous POST is a 401', noLogin.status, 401);

  const noUid = await rival.onRequestPost({
    env, request: sessionReq('/api/daily-rival', { userId: 'u5', method: 'POST', body: {} }),
  });
  check('missing uid is a 400', noUid.status, 400);

  const badUid = await rival.onRequestPost({
    env, request: sessionReq('/api/daily-rival', { userId: 'u5', method: 'POST', body: { uid: 'ghost' } }),
  });
  check('unknown dino uid is a 400', badUid.status, 400);
})();

await (async function daySeedPreventsReroll() {
  /* The stored row's day stamp is the guard: a row from a PREVIOUS day reads as
     "not fought today", so a new day grants a fresh attempt. */
  const y = (() => { const dd = new Date(today + 'T12:00:00Z'); dd.setUTCDate(dd.getUTCDate() - 1); return dayKey(dd); })();
  const env = fakeEnv({
    ...seedSave('u6'),
    [`dino_rival_u6`]: { day: y, uid: 'champ', win: true, coins: 99, xp: 99, log: ['old'] },
  });
  const res = await rival.onRequestPost({
    env, request: sessionReq('/api/daily-rival', { userId: 'u6', method: 'POST', body: { uid: 'champ' } }),
  });
  check('a yesterday row does not block today', res.status, 200);
  const d = await res.json();
  ok('today\'s attempt resolves fresh', d.success === true);
})();

console.log('');
if (pending.length) {
  console.log('[dino-rival] PENDING manager-owned shared edits (expected, not a failure):');
  for (const p of pending) console.log('  - ' + p);
  console.log('');
}
if (failures.length) {
  console.log(`[dino-rival] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[dino-rival] ${passed} assertions passed.`);
