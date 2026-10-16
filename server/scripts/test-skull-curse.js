#!/usr/bin/env node
/* ══════════════════════════════════════════════
   TODAY'S CURSE — Skull Clicker's daily challenge, in isolation

     node server/scripts/test-skull-curse.js

   No network, no database: a fake in-memory KV (get/put/delete/mutate) and
   fake Twitch sessions, in the style of server/scripts/test-daily.js. The
   route 500s against the real server until the manager maps sc_curse_ /
   sc_relics_ in registry.js and adds the CHALLENGES entry, so everything here
   is exercised against the handlers + the fake KV directly.

   What it proves:
     • DETERMINISM — the day's curse is a pure function of the Pacific day key
       (same for everyone, no reroll), every curse in the bank is beatable.
     • SERVER-AUTHORITATIVE — one POST cannot one-shot the target (the per-flush
       cap holds); the server, not the client, decides bones and completion.
     • ONE PER PACIFIC DAY — a clear is idempotent; no second relic, no second
       hub report.
     • markDailyComplete — a clear records 'skull-curse' on the shared daily
       record exactly once.
     • SEPARATION — a full run never reads or writes sc_save_ (the main /
       prestige save is untouched); the reward is the game's own Cursed Relic.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as curse from '../../functions/api/skull-curse.js';
import { dayKey } from '../../functions/api/season-time.js';
import { readDaily, dailyKey } from '../../functions/api/daily/state.js';

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

/* ── Fake KV with the mutate() the handlers rely on (from test-daily.js) ── */
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

function req(url, { userId, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (userId) {
    const cookie = encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'Nyx' }));
    headers.Cookie = 'pham_session=' + cookie;
  }
  return new Request('https://phantomace.tv' + url, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
}
const strike = (env, userId, count) =>
  curse.onRequestPost({ env, request: req('/api/skull-curse', { userId, method: 'POST', body: { action: 'strike', count } }) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Mash the curse to completion with full-cap flushes. A small real delay
   between flushes lets wall-clock advance, because the server's cumulative
   rate cap (measured from the run's start) deliberately throttles a strike
   flood — exactly what a tight zero-time loop would be. Bounded so a bug can't
   loop forever. */
async function clearIt(env, userId, reqCap) {
  let last = null;
  for (let i = 0; i < 300; i++) {
    const res = await strike(env, userId, reqCap);
    last = await res.json();
    if (last.run.done) break;
    await sleep(150);
  }
  return last;
}

const today = dayKey();

/* ══ WIRING (informational — the manager owns these shared edits) ══ */
{
  const registry = read('server/lib/registry.js');
  const challenges = read('functions/api/daily/state.js');
  const curseWired = /prefix:\s*'sc_curse_'/.test(registry);
  const relicsWired = /prefix:\s*'sc_relics_'/.test(registry);
  const challengeWired = /id:\s*'skull-curse'/.test(challenges);
  console.log('  wiring (manager-owned, not a failure here):');
  console.log(`    registry sc_curse_ prefix ....... ${curseWired ? 'present' : 'PENDING'}`);
  console.log(`    registry sc_relics_ prefix ...... ${relicsWired ? 'present' : 'PENDING'}`);
  console.log(`    CHALLENGES skull-curse entry .... ${challengeWired ? 'present' : 'PENDING'}`);
  /* The route carries handlers, so it is auto-routed — no NON_ROUTE edit. */
  ok('skull-curse.js exports onRequestGet/onRequestPost',
    typeof curse.onRequestGet === 'function' && typeof curse.onRequestPost === 'function');
}

/* ══ DETERMINISM ══ */
{
  const a = curse.todaysCurse(today);
  const b = curse.todaysCurse(today);
  check('same day → same curse index', a.index, b.index);
  ok('curse index in range', a.index >= 0 && a.index < curse.CURSES.length);

  /* Spread across a year of days, every pick is valid and stable on a re-call. */
  let allStable = true, allInRange = true;
  for (let d = 0; d < 370; d++) {
    const key = dayKey(new Date(Date.UTC(2026, 0, 1 + d, 12)));
    const i1 = curse.todaysCurse(key).index, i2 = curse.todaysCurse(key).index;
    if (i1 !== i2) allStable = false;
    if (!(i1 >= 0 && i1 < curse.CURSES.length)) allInRange = false;
  }
  ok('every day maps to a stable in-range curse', allStable && allInRange);

  /* Every curse is beatable and sanely bounded. */
  let beatable = true, boundedTarget = true;
  for (const c of curse.CURSES) {
    if (!(c.perStrike > 0 && c.target > 0 && c.reqCap > 0)) beatable = false;
    if (c.target > 5000) boundedTarget = false;         /* a few minutes, not a slog */
  }
  ok('every curse has positive perStrike/target/reqCap', beatable);
  ok('every curse target is bounded', boundedTarget);

  /* Two different users on the same day see the SAME curse (no per-user roll). */
  const env = fakeEnv();
  const g1 = await (await curse.onRequestGet({ env, request: req('/api/skull-curse', { userId: 'a' }) })).json();
  const g2 = await (await curse.onRequestGet({ env, request: req('/api/skull-curse', { userId: 'b' }) })).json();
  check('same curse for every player that day', g1.curse.id, g2.curse.id);
}

/* ══ LOGIN GATE ══ */
{
  const env = fakeEnv();
  const anonGet = await (await curse.onRequestGet({ env, request: req('/api/skull-curse') })).json();
  check('anonymous GET is logged-out', anonGet.loggedIn, false);
  ok('anonymous GET still ships the curse', !!(anonGet.curse && anonGet.curse.id));

  const anonPost = await strike(env, null, 10);
  check('anonymous strike is a 401', anonPost.status, 401);
}

/* ══ FRESH STATE ══ */
{
  const env = fakeEnv();
  const g = await (await curse.onRequestGet({ env, request: req('/api/skull-curse', { userId: 'u1' }) })).json();
  check('fresh run: no bones', g.run.bones, 0);
  check('fresh run: not done', g.run.done, false);
  check('fresh run: target is the curse target', g.run.target, curse.todaysCurse(today).target);
  check('fresh run: no relics', g.run.relics, 0);
}

/* ══ SERVER-AUTHORITATIVE: one POST cannot one-shot the target ══ */
{
  const env = fakeEnv();
  const res = await strike(env, 'u2', 1e9);          /* claim a billion strikes */
  const d = await res.json();
  const c = curse.todaysCurse(today);
  ok('a single giant strike is clamped below the target', d.run.bones < c.target && !d.run.done);
  ok('clamped bones never exceed reqCap worth', d.run.bones <= c.reqCap * c.perStrike);
}

/* ══ SERVER-AUTHORITATIVE: a zero-time flood cannot speed-clear ══ */
{
  const env = fakeEnv();
  const c = curse.todaysCurse(today);
  let last = null;
  for (let i = 0; i < 40; i++) last = await (await strike(env, 'uf', c.reqCap)).json();  /* no delay at all */
  ok('a flood of instant flushes is throttled below the target (cumulative rate cap)',
    !last.run.done && last.run.bones < c.target);
}

/* ══ A FULL CLEAR: completion, reward, hub report, idempotency ══ */
{
  const env = fakeEnv();
  const c = curse.todaysCurse(today);
  const last = await clearIt(env, 'u3', c.reqCap);
  ok('the run completes with honest mashing', last && last.run.done === true);
  check('completing the run is a clear', last.cleared, true);
  check('completion caps bones at the target', last.run.bones, c.target);
  check('a clear grants exactly one Cursed Relic', last.run.relics, 1);

  /* The shared daily record was marked — exactly once, under 'skull-curse'. */
  const rec = await readDaily(env, 'u3');
  ok("markDailyComplete recorded 'skull-curse' today",
    rec && rec.done && Array.isArray(rec.done[today]) && rec.done[today].includes('skull-curse'));
  check("it recorded skull-curse once", (rec.done[today] || []).filter(x => x === 'skull-curse').length, 1);

  /* Idempotent: striking again the same day neither re-clears nor re-pays. */
  const again = await strike(env, 'u3', c.reqCap);
  const ad = await again.json();
  check('re-strike after a clear is not a new clear', ad.cleared, false);
  check('re-strike grants no second relic', ad.run.relics, 1);
  check('re-strike leaves the run done', ad.run.done, true);
  const relicRec = await env.MARKETPLACE.get('sc_relics_u3', 'json');
  check('relic ledger holds exactly one relic', relicRec.relics, 1);
}

/* ══ SEPARATION: the main save is never touched ══ */
{
  /* Seed a realistic main save; it must survive a full curse run byte-for-byte. */
  const savedMain = { prestige: 7, lifetimeSkulls: '1.2e40', boneShards: 99, savedAt: 123 };
  const env = fakeEnv({ 'sc_save_u4': savedMain });
  const before = env.MARKETPLACE.store.get('sc_save_u4');

  const c = curse.todaysCurse(today);
  const last = await clearIt(env, 'u4', c.reqCap);
  ok('the run still completes', last.run.done === true);

  const after = env.MARKETPLACE.store.get('sc_save_u4');
  check('the main save is byte-identical after a full curse run', after, before);

  /* The curse wrote only its own, clearly-separate keys. */
  const keys = [...env.MARKETPLACE.store.keys()];
  ok('a curse run writes sc_curse_<user>', keys.includes('sc_curse_u4'));
  ok('a curse run writes sc_relics_<user>', keys.includes('sc_relics_u4'));
  ok('a curse run writes the shared daily_<user>', keys.includes(dailyKey('u4')));
  ok('the curse never created a stray sc_save_ for anyone else',
    keys.filter(k => k.startsWith('sc_save_')).length === 1);
}

/* ══ RESET: abandon restarts the run, a clear is never un-cleared ══ */
{
  const env = fakeEnv();
  const c = curse.todaysCurse(today);
  await strike(env, 'u5', c.reqCap);                 /* some progress */
  const reset = await (await curse.onRequestPost({ env, request: req('/api/skull-curse', { userId: 'u5', method: 'POST', body: { action: 'reset' } }) })).json();
  check('reset zeroes the bones', reset.run.bones, 0);
  check('reset zeroes the strikes', reset.run.strikes, 0);
  check('reset keeps the run undone', reset.run.done, false);

  /* After a clear, reset must NOT un-clear the day. */
  await clearIt(env, 'u5', c.reqCap);
  const resetAfter = await (await curse.onRequestPost({ env, request: req('/api/skull-curse', { userId: 'u5', method: 'POST', body: { action: 'reset' } }) })).json();
  check('reset after a clear leaves it cleared', resetAfter.run.done, true);
}

/* ══ RELIC GRANT IS DAY-GUARDED ══ */
{
  /* A relic ledger already stamped today: a clear must not add a second. */
  const env = fakeEnv({ 'sc_relics_u6': { relics: 4, lastDay: today, history: [] } });
  const c = curse.todaysCurse(today);
  const last = await clearIt(env, 'u6', c.reqCap);
  ok('the run still completes', last.run.done === true);
  check('no second relic when today was already rewarded', last.run.relics, 4);
}

console.log('');
if (failures.length) {
  console.log(`[skull-curse] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[skull-curse] ${passed} assertions passed.`);
