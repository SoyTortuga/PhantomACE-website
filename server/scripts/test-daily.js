#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DAILY CHALLENGES — the shared framework, the hub, and the Rite

     node server/scripts/test-daily.js

   Two halves, no network and no database:

   1. WIRING (grep of source). The things that silently 500 or crash the rig
      if they drift: the two KV prefixes (daily_, rite_agg_) must be in the
      registry, the handler-less state.js must be in NON_ROUTE_MODULES, the
      nav must link /daily, and the page must carry the ids its script drives.
      Plus the design-identity bans on the new stylesheet (no box-shadow, no
      blur, no coloured side-rail).

   2. LOGIC (a fake KV + fake sessions). markDailyComplete must be idempotent
      per Pacific day, a full clear must advance the streak and pay the meta
      reward exactly once, a broken run must reset the streak, and the Rite
      must be deterministic, one-guess-per-day, and server-authoritative about
      the correct answer.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  markDailyComplete, getDailyState, readDaily, setRiteAnswer,
  CHALLENGES, META_ENTRIES, dailyKey,
} from '../../functions/api/daily/state.js';
import * as rite from '../../functions/api/daily/rite.js';
import { dayKey } from '../../functions/api/season-time.js';

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

/* ── A KV stand-in with the mutate() the framework relies on ── */
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

/* yesterday's / N-days-ago Pacific key, computed exactly as isYesterday does
   so the streak maths lines up. */
function dayBefore(key, n = 1) {
  const d = new Date(key + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return dayKey(d);
}

/* Build the giveaway-entry total for a user out of the fake store, matched by
   the ledger record's own userId rather than guessing its key spelling. */
function entriesFor(env, userId) {
  let total = 0;
  for (const [, v] of env.MARKETPLACE.store) {
    try {
      const rec = JSON.parse(v);
      if (rec && rec.userId === String(userId) && rec.entries != null) total += Number(rec.entries) || 0;
    } catch { /* not a JSON record */ }
  }
  return total;
}

/* ══ 1. WIRING ══════════════════════════════════ */
const registry = read('server/lib/registry.js');
ok('registry maps the daily_ prefix', /prefix:\s*'daily_'/.test(registry));
ok('registry maps the rite_agg_ prefix', /prefix:\s*'rite_agg_'/.test(registry));

const router = read('server/router.js');
ok('state.js is declared NON_ROUTE (handler-less lib)', /['"]api\/daily\/state\.js['"]/.test(router));

const components = read('js/components.js');
ok('the nav links /daily', /href="\/daily"/.test(components));

const html = read('daily.html');
['dyGuest', 'dySummary', 'dyRite', 'dyRiteOptions', 'dyGrid', 'dyRiteResult'].forEach((id) =>
  ok('daily.html has #' + id, new RegExp('id="' + id + '"').test(html)));
ok('daily.html uses the shared hero title', /page-hero-title/.test(html));
ok('daily.html loads its stylesheet', /css\/pages\/daily\.css/.test(html));
ok('daily.html loads its script', /js\/pages\/daily\.js/.test(html));
ok('logged-out prompt offers Twitch login', /loginWithTwitch\(\)/.test(html));

const css = read('css/pages/daily.css');
check('no box-shadow in the stylesheet', /box-shadow\s*:/.test(css), false);
check('no backdrop-filter / blur', /backdrop-filter\s*:|blur\s*\(/.test(css), false);
/* No coloured side-rail: border-left/right are the banned AI-tell. Full
   borders and border-top/bottom are fine. */
check('no border-left declaration', /border-left\s*:/.test(css), false);
check('no border-right declaration', /border-right\s*:/.test(css), false);

const js = read('js/pages/daily.js');
ok('the page reads the hub endpoint', /\/api\/daily['"]/.test(js) || /fetch\('\/api\/daily'/.test(js));
ok('the page reads/writes the Rite endpoint', /\/api\/daily\/rite/.test(js));

/* The hub route and Rite route both exist and export handlers. */
ok('CHALLENGES includes the Rite and Memory Match',
  CHALLENGES.some(c => c.id === 'daily-rite') && CHALLENGES.some(c => c.id === 'memory-match'));

/* ══ 2. FRAMEWORK LOGIC ═════════════════════════ */
const today = dayKey();
const ALL = CHALLENGES.map(c => c.id);

await (async function freshState() {
  const env = fakeEnv();
  const s = await getDailyState(env, 'u1');
  check('fresh: nothing done', s.doneCount, 0);
  check('fresh: everything remaining', s.remaining, s.total);
  check('fresh: no streak', s.streak, 0);
  check('fresh: not cleared', s.clearedToday, false);
})();

await (async function partialThenClear() {
  const env = fakeEnv();
  // Complete all but the last challenge: never a clear.
  for (let i = 0; i < ALL.length - 1; i++) {
    const r = await markDailyComplete(env, 'u1', 'Nyx', ALL[i]);
    check('partial ' + ALL[i] + ': not cleared', r.clearedToday, false);
    check('partial ' + ALL[i] + ': no meta', r.metaGranted, false);
  }
  // The final one clears the day.
  const last = await markDailyComplete(env, 'u1', 'Nyx', ALL[ALL.length - 1]);
  check('final completion clears the day', last.clearedToday, true);
  check('final completion is newly-cleared', last.newlyCleared, true);
  check('first clear → streak 1', last.streak, 1);
  check('first clear grants the meta', last.metaGranted, true);
  check('meta paid exactly META_ENTRIES', entriesFor(env, 'u1'), META_ENTRIES);

  const s = await getDailyState(env, 'u1');
  check('state agrees it is cleared', s.clearedToday, true);
  check('state streak is 1', s.streak, 1);
  check('state done count == total', s.doneCount, s.total);
})();

await (async function idempotentPerDay() {
  const env = fakeEnv();
  for (const id of ALL) await markDailyComplete(env, 'u1', 'Nyx', id);
  const before = entriesFor(env, 'u1');
  // Re-report an already-done challenge: no second clear, no second payout.
  const again = await markDailyComplete(env, 'u1', 'Nyx', ALL[0]);
  check('re-report: still cleared', again.clearedToday, true);
  check('re-report: NOT newly-cleared', again.newlyCleared, false);
  check('re-report: no second meta', again.metaGranted, false);
  check('re-report: entries unchanged', entriesFor(env, 'u1'), before);
})();

await (async function streakContinues() {
  // Seed a record cleared yesterday with a streak of 5.
  const y = dayBefore(today, 1);
  const seed = { done: { [y]: [...ALL] }, streak: 5, lastClear: y, lastMeta: y, rite: null };
  const env = fakeEnv({ [dailyKey('u1')]: seed });
  let last;
  for (const id of ALL) last = await markDailyComplete(env, 'u1', 'Nyx', id);
  check('yesterday cleared → streak continues to 6', last.streak, 6);
})();

await (async function streakResetsAfterGap() {
  // Last clear was three days ago: the run is broken.
  const old = dayBefore(today, 3);
  const seed = { done: { [old]: [...ALL] }, streak: 9, lastClear: old, lastMeta: old, rite: null };
  const env = fakeEnv({ [dailyKey('u1')]: seed });

  // getDailyState should already show the broken run as 0 before any new clear.
  const pre = await getDailyState(env, 'u1');
  check('broken run shows streak 0 before reclearing', pre.streak, 0);

  let last;
  for (const id of ALL) last = await markDailyComplete(env, 'u1', 'Nyx', id);
  check('gap → streak restarts at 1', last.streak, 1);
})();

/* ══ 3. THE DAILY RITE ══════════════════════════ */
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

await (async function riteDeterminism() {
  const a = rite.todaysQuestion(today);
  const b = rite.todaysQuestion(today);
  check('same day → same question index', a.index, b.index);
  ok('question index in range', a.index >= 0 && a.index < rite.RITE_BANK.length);
  ok('question has four options and a valid answer',
    Array.isArray(a.o) && a.o.length === 4 && a.a >= 0 && a.a <= 3);
})();

await (async function riteGetHidesAnswerUntilAnswered() {
  const env = fakeEnv();
  const res = await rite.onRequestGet({ env, request: sessionReq('/api/daily/rite', { userId: 'u2' }) });
  const d = await res.json();
  check('unanswered GET says so', d.answered, false);
  check('unanswered GET hides the correct index', d.correctIndex, undefined);
  ok('unanswered GET still ships the options', Array.isArray(d.options) && d.options.length === 4);
})();

await (async function riteCorrectAnswerPaysAndMarks() {
  const env = fakeEnv();
  const correct = rite.todaysQuestion(today).a;
  const res = await rite.onRequestPost({
    env, request: sessionReq('/api/daily/rite', { userId: 'u2', method: 'POST', body: { pick: correct } }),
  });
  const d = await res.json();
  check('correct answer is marked correct', d.wasCorrect, true);
  check('correct answer reveals the index', d.correctIndex, correct);
  check('correct answer grants an entry', d.entryGranted, true);

  // The Rite marked itself done on the shared record.
  const rec = await readDaily(env, 'u2');
  ok('the Rite recorded today\'s answer', rec.rite && rec.rite.day === today);
  const state = await getDailyState(env, 'u2');
  ok('the hub shows the Rite done',
    state.challenges.find(c => c.id === 'daily-rite').done === true);
})();

await (async function riteOneGuessPerDay() {
  const env = fakeEnv();
  const correct = rite.todaysQuestion(today).a;
  await rite.onRequestPost({
    env, request: sessionReq('/api/daily/rite', { userId: 'u3', method: 'POST', body: { pick: correct } }),
  });
  const second = await rite.onRequestPost({
    env, request: sessionReq('/api/daily/rite', { userId: 'u3', method: 'POST', body: { pick: (correct + 1) % 4 } }),
  });
  check('a second guess is refused (409)', second.status, 409);
  const d = await second.json();
  check('the refusal reports the real answer', d.correctIndex, correct);
})();

await (async function riteWrongAnswerNoEntryButStillDone() {
  const env = fakeEnv();
  const correct = rite.todaysQuestion(today).a;
  const wrong = (correct + 1) % 4;
  const res = await rite.onRequestPost({
    env, request: sessionReq('/api/daily/rite', { userId: 'u4', method: 'POST', body: { pick: wrong } }),
  });
  const d = await res.json();
  check('wrong answer is marked wrong', d.wasCorrect, false);
  check('wrong answer grants no entry', d.entryGranted, false);
  const state = await getDailyState(env, 'u4');
  ok('but the Rite still counts as done (done-on-answer)',
    state.challenges.find(c => c.id === 'daily-rite').done === true);
})();

await (async function riteRejectsBadPick() {
  const env = fakeEnv();
  const res = await rite.onRequestPost({
    env, request: sessionReq('/api/daily/rite', { userId: 'u5', method: 'POST', body: { pick: 9 } }),
  });
  check('out-of-range pick is a 400', res.status, 400);
})();

await (async function riteNeedsLogin() {
  const env = fakeEnv();
  const res = await rite.onRequestPost({
    env, request: sessionReq('/api/daily/rite', { method: 'POST', body: { pick: 0 } }),
  });
  check('anonymous POST is a 401', res.status, 401);
})();

console.log('');
if (failures.length) {
  console.log(`[daily] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[daily] ${passed} assertions passed.`);
