#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SOUP, SALAD, OR SANDWICH — the daily

     node server/scripts/test-sss.js

   1. WIRING (grep): the KV prefixes (sss_, sss_agg_) in the registry, the
      CHALLENGES entry, the page's ids, the design-identity bans on the
      stylesheet, and the giveaway label for the daily-sss entry source.
   2. LOGIC (fake KV + fake sessions): the five foods are deterministic per
      Pacific day; the right answer is never revealed before a call; one call
      per food per day (server-authoritative); finishing the set marks the
      daily done; a PERFECT five pays exactly one giveaway entry, once; a
      non-perfect finish pays none.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as sss from '../../functions/api/daily/sss.js';
import { readDaily } from '../../functions/api/daily/state.js';
import { dayKey } from '../../functions/api/season-time.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

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
  if (userId) headers.Cookie = 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'Nyx' }));
  return new Request('https://phantomace.tv' + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
const GET = (env, userId) => sss.onRequestGet({ env, request: sessionReq('/api/daily/sss', { userId }) });
const POST = (env, userId, body) => sss.onRequestPost({ env, request: sessionReq('/api/daily/sss', { userId, method: 'POST', body }) });

const entriesFor = (env, userId) => {
  let total = 0;
  for (const [, v] of env.MARKETPLACE.store) {
    try { const r = JSON.parse(v); if (r && r.userId === String(userId) && r.entries != null) total += Number(r.entries) || 0; } catch { /* skip */ }
  }
  return total;
};

/* ══ 1. WIRING ══════════════════════════════════ */
const registry = read('server/lib/registry.js');
ok('registry maps sss_ prefix', /prefix:\s*'sss_'/.test(registry));
ok('registry maps sss_agg_ prefix', /prefix:\s*'sss_agg_'/.test(registry));
ok('sss_agg_ resolves before sss_ (longest first)',
  registry.indexOf("'sss_agg_'") < registry.indexOf("'sss_'"));

ok('CHALLENGES includes sss', /id:\s*'sss'/.test(read('functions/api/daily/state.js')));

const html = read('soup-salad-sandwich.html');
['sssGuest', 'sssSummary', 'sssList'].forEach((id) => ok('page has #' + id, new RegExp('id="' + id + '"').test(html)));
ok('page uses the shared hero title', /page-hero-title/.test(html));
ok('page loads its script + stylesheet', /js\/pages\/sss\.js/.test(html) && /css\/pages\/sss\.css/.test(html));

const css = read('css/pages/sss.css');
check('no box-shadow', /box-shadow\s*:/.test(css), false);
check('no backdrop-filter / blur', /backdrop-filter\s*:|blur\s*\(/.test(css), false);
check('no border-left rail', /border-left\s*:/.test(css), false);
check('no border-right rail', /border-right\s*:/.test(css), false);

const js = read('js/pages/sss.js');
ok('page talks to /api/daily/sss', /\/api\/daily\/sss/.test(js));

ok('giveaway labels the daily-sss entry source', /daily-sss'\)\s*return/.test(read('giveaway.html')));

/* ══ 2. DETERMINISM ═════════════════════════════ */
const today = dayKey();
const foods = sss.todaysFoods(today);
check('five foods a day', foods.length, sss.PER_DAY);
check('same day → identical set', sss.todaysFoods(today).map(f => f.food), foods.map(f => f.food));
check('no food repeats within a day', new Set(foods.map(f => f.bankIndex)).size, foods.length);
ok('every food has a valid category', foods.every(f => sss.CATS.includes(f.cat)));
ok('the set varies across days',
  JSON.stringify(sss.todaysFoods('2026-01-01').map(f => f.food)) !== JSON.stringify(sss.todaysFoods('2026-06-15').map(f => f.food)));

/* ══ 3. REVEAL ONLY AFTER A CALL ════════════════ */
await (async function hidesAnswer() {
  const env = fakeEnv();
  const res = await GET(env, 'u1');
  const d = await res.json();
  check('GET lists the five foods', (d.foods || []).length, 5);
  ok('no correct category before a call', d.foods.every(f => f.answered === false && f.correctCat === undefined));
})();

/* ══ 4. A CALL RECORDS, REVEALS, AND LOCKS ══════ */
await (async function oneCallPerFood() {
  const env = fakeEnv();
  const right = foods[0].cat;
  const res = await POST(env, 'u1', { pos: 0, pick: right });
  const d = await res.json();
  check('a correct call is graded correct', d.correct, true);
  check('and reveals the right category', d.correctCat, right);

  // A second call on the same food is refused and does not change the record.
  const again = await POST(env, 'u1', { pos: 0, pick: sss.CATS.find(c => c !== right) });
  check('a second call on the same food is 409', again.status, 409);

  // GET now shows food 0 answered with its correct category; others still hidden.
  const g = await (await GET(env, 'u1')).json();
  ok('food 0 shows answered after the call', g.foods[0].answered === true && g.foods[0].correctCat === right);
  ok('unanswered foods still hide the answer', g.foods[1].answered === false && g.foods[1].correctCat === undefined);
})();

await (async function rejectsBadInput() {
  const env = fakeEnv();
  check('a non-category pick is 400', (await POST(env, 'u1', { pos: 0, pick: 'taco' })).status, 400);
  check('an out-of-range food is 400', (await POST(env, 'u1', { pos: 9, pick: 'soup' })).status, 400);
  check('an anonymous call is 401', (await sss.onRequestPost({ env, request: sessionReq('/api/daily/sss', { method: 'POST', body: { pos: 0, pick: 'soup' } }) })).status, 401);
})();

/* ══ 5. FINISH → DONE; PERFECT → ONE ENTRY ══════ */
await (async function perfectRound() {
  const env = fakeEnv();
  let last;
  for (const f of foods) last = await (await POST(env, 'u2', { pos: f.pos, pick: f.cat })).json();
  check('the set is done after five calls', last.done, true);
  check('a flawless set is perfect', last.perfect, true);
  check('perfect pays exactly one entry', entriesFor(env, 'u2'), 1);

  // The hub records the daily done.
  const rec = await readDaily(env, 'u2');
  ok('markDailyComplete recorded sss for today', (rec.done && rec.done[today] || []).includes('sss'));

  // A replay after a perfect set pays nothing more.
  const replay = await POST(env, 'u2', { pos: 0, pick: foods[0].cat });
  check('replaying a finished food is 409', replay.status, 409);
  check('and no second entry is paid', entriesFor(env, 'u2'), 1);
})();

await (async function imperfectRound() {
  const env = fakeEnv();
  // Get one wrong on purpose (pos 0), the rest right.
  const wrong = sss.CATS.find(c => c !== foods[0].cat);
  let last = await (await POST(env, 'u3', { pos: 0, pick: wrong })).json();
  for (let i = 1; i < foods.length; i++) last = await (await POST(env, 'u3', { pos: foods[i].pos, pick: foods[i].cat })).json();
  check('an imperfect set still finishes done', last.done, true);
  check('but is not perfect', last.perfect, false);
  check('and pays no entry', entriesFor(env, 'u3'), 0);
  const rec = await readDaily(env, 'u3');
  ok('an imperfect finish still marks the daily done', (rec.done && rec.done[today] || []).includes('sss'));
})();

/* ══ 6. CROWD STAT ══════════════════════════════ */
await (async function crowdPct() {
  const env = fakeEnv();
  await POST(env, 'a', { pos: 0, pick: foods[0].cat });               // right
  await POST(env, 'b', { pos: 0, pick: sss.CATS.find(c => c !== foods[0].cat) }); // wrong
  const d = await (await POST(env, 'c', { pos: 0, pick: foods[0].cat })).json();  // right
  check('the crowd % reflects 2 of 3 right', d.pctCorrect, 67);
})();

console.log('');
if (failures.length) {
  console.log(`[sss] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[sss] ${passed} assertions passed.`);
