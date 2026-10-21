#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MANA CLASH — the Daily Seed (mana-seed)

     node server/scripts/test-mana-seed.js

   Isolation-only: a fake in-memory KV and fake pham_session cookies, no
   network and no Postgres. (The real route 500s until the manager maps this
   daily's keys — but those keys already exist in the registry; the Daily Seed
   reuses mcd_board_/mcd_user_ and the shared daily_ hub, and introduces NO new
   KV key: the in-progress "resume" pointer lives on the existing mcd_user_
   record.)

   What it proves, matching the framework contract (functions/api/daily/state.js):
     1. WIRING (grep): the handler reports to the hub via markDailyComplete with
        id 'mana-seed', imports daily/state.js, and the mcd_ keys it writes are
        in the registry. The client page drives start-daily and the daily board.
     2. DETERMINISM: the day's dice stream is pure per (dayKey, position), so two
        players on the same day draw the identical opening roll — the puzzle is
        the choices, not the luck.
     3. RESUME, NOT RE-DEAL: start-daily returns the in-progress run rather than
        minting a fresh one, so a restart can't reset the total and replay the
        fixed dice for a better score. Server-authoritative — re-checked against
        the stored record.
     4. ONE SCORED RUN PER PACIFIC DAY: recordDaily records the first completion
        only; a second is a no-op on the board and on the hub.
     5. markDailyComplete FIRES once, marks 'mana-seed' done on the shared
        record, and pays NO giveaway entries (Mana Clash pays its own reward).
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as mc from '../../functions/api/mana-clash.js';
import { streamFace, dailyDeal, recordDaily } from '../../functions/api/mana-clash.js';
import { getDailyState, readDaily, CHALLENGES } from '../../functions/api/daily/state.js';
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

/* ── A KV stand-in with the mutate() the handlers rely on. The options arg
   (TTL) is accepted and ignored, exactly as the real layer's tests do. ── */
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
    async listValues() { return []; },
    async mutate(key, fn) {
      const cur = store.has(key) ? JSON.parse(store.get(key)) : null;
      const next = await fn(cur);
      if (next !== undefined) store.set(key, JSON.stringify(next));
      return next === undefined ? cur : next;
    },
  };
}
const fakeEnv = (seed) => ({ MARKETPLACE: fakeKV(seed) });

function sessionReq(method, body, userId, name = 'Grave') {
  const headers = { 'Content-Type': 'application/json' };
  if (userId) {
    const cookie = encodeURIComponent(JSON.stringify({ user_id: userId, display_name: name }));
    headers.Cookie = 'pham_session=' + cookie;
  }
  return new Request('https://phantomace.tv/api/mana-clash', {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
}
const post = (env, body, userId, name) =>
  mc.onRequestPost({ env, request: sessionReq('POST', body, userId, name) }).then(r => r.json());

/* Read/replace a room JSON in the fake store (to fast-forward progress). */
const getRoom = (env, code) => JSON.parse(env.MARKETPLACE.store.get('mc_room_' + code));
const setRoom = (env, code, room) => env.MARKETPLACE.store.set('mc_room_' + code, JSON.stringify(room));

const today = dayKey();

/* ══ 1. WIRING (grep of source) ══════════════════ */
const src = read('functions/api/mana-clash.js');
ok('handler reports to the hub with markDailyComplete',
  /markDailyComplete\(\s*env\s*,\s*id\s*,\s*p\.displayName\s*,\s*'mana-seed'\s*\)/.test(src));
ok("the daily id is 'mana-seed'", /'mana-seed'/.test(src));
ok('handler imports the hub framework', /import\(['"]\.\/daily\/state\.js['"]\)/.test(src));

const registry = read('server/lib/registry.js');
ok('registry maps mcd_board_ (the day board, with a TTL)', /prefix:\s*'mcd_board_'/.test(registry));
ok('registry maps mcd_user_ (the per-user daily record / resume pointer)', /prefix:\s*'mcd_user_'/.test(registry));
ok('registry maps the daily_ hub prefix', /prefix:\s*'daily_'/.test(registry));

const page = read('games/mana-clash/index.html');
ok('the page has the daily card + button + board', /id="dailyCard"/.test(page) && /id="dailyBtn"/.test(page) && /id="dailyBoard"/.test(page));
ok('the page starts a run via start-daily', /action:\s*'start-daily'/.test(page));
ok('the page reads the daily board endpoint', /action=daily/.test(page));

/* mana-clash.js is a route (exports handlers), so it is NOT a NON_ROUTE module;
   this daily introduces no handler-less library file. */
ok('handler still exports onRequestPost/onRequestGet', typeof mc.onRequestPost === 'function' && typeof mc.onRequestGet === 'function');

/* ══ 2. DETERMINISM ══════════════════════════════ */
(function determinismUnit() {
  for (let i = 0; i < 6; i++) check('streamFace stable at ' + i, streamFace(today, i), streamFace(today, i));
  const open = (dk) => Array.from({ length: 6 }, (_, i) => streamFace(dk, i));
  check('same day → identical opening roll', open(today), open(today));
  ok('a different day generally differs', JSON.stringify(open(today)) !== JSON.stringify(open('1999-01-01')));
})();

await (async function determinismIntegration() {
  const env = fakeEnv();
  const a = await post(env, { action: 'start-daily' }, 'det-a', 'Alpha');
  const b = await post(env, { action: 'start-daily' }, 'det-b', 'Beta');
  ok('two daily runs get distinct room codes', a.code && b.code && a.code !== b.code);
  const ra = await post(env, { action: 'roll', code: a.code }, 'det-a', 'Alpha');
  const rb = await post(env, { action: 'roll', code: b.code }, 'det-b', 'Beta');
  /* kept.concat(dice) is the full opening roll in every branch (burn/clash/
     normal), since kept started empty. Same day, same stream position → equal. */
  const faces = (r) => (r.room.you.kept || []).concat(r.room.you.dice || []);
  const fa = faces(ra), fb = faces(rb);
  ok('both players rolled 6 opening dice', fa.length === 6 && fb.length === 6);
  check('same day → same opening dice for everyone', fa, fb);
  /* The opening roll comes from the canonical daily deal (dailyDeal), which is
     the pure stream on every normal day and the scripted override on a rigged
     day (e.g. the 2026-10-20 solo rig) — so compare against that, not the raw
     streamFace, or the test breaks on the one rigged date. */
  check('and it matches the daily deal', fa, Array.from({ length: 6 }, (_, i) => dailyDeal(today, i)));
})();

/* ══ 3. RESUME, NOT RE-DEAL ══════════════════════ */
await (async function resumeNotRedeal() {
  const env = fakeEnv();
  const first = await post(env, { action: 'start-daily' }, 'res1', 'Nyx');
  ok('first start deals a run', !!first.code && !first.resumed);

  /* The in-progress pointer is on the mcd_user_ record, with NO top-level
     dayKey (so it never reads as "already scored"). */
  const rec = await env.MARKETPLACE.get('mcd_user_res1', 'json');
  ok('an active pointer was stored', rec && rec.active && rec.active.code === first.code && rec.active.dayKey === today);
  check('pointer record is not "scored" (no top-level dayKey)', rec.dayKey, undefined);

  /* Fast-forward progress: bank a total onto the live run. */
  const room = getRoom(env, first.code);
  room.players.res1.total = 777;
  room.round = 3;
  setRoom(env, first.code, room);

  const again = await post(env, { action: 'start-daily' }, 'res1', 'Nyx');
  check('a restart RESUMES the same room', again.code, first.code);
  ok('and is flagged resumed', again.resumed === true);
  check('progress is preserved, not reset', again.room.you.total, 777);
  check('round is preserved, not re-dealt', again.room.round, 3);

  /* The daily board GET still shows the player as NOT played — the pointer-only
     record has no top-level dayKey, so `you.played` stays false. */
  const boardRes = await mc.onRequestGet({
    env, request: new Request('https://phantomace.tv/api/mana-clash?action=daily', {
      headers: { Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: 'res1', display_name: 'Nyx' })) },
    }),
  }).then(r => r.json());
  check('an in-progress (unscored) run reads as not-yet-played on the board', boardRes.you && boardRes.you.played, false);
})();

/* ══ 4 & 5. ONE SCORED RUN PER DAY + markDailyComplete ══ */
await (async function oneScoredRunAndHub() {
  const env = fakeEnv();
  /* A finished solo daily run, the shape settle() hands recordDaily. */
  const finishedRoom = () => ({
    daily: true, dayKey: today, status: 'finished',
    players: { comp1: { displayName: 'Grave', total: 4200, turn: { done: 'banked' } } },
  });

  await recordDaily(env, finishedRoom());

  const board = await env.MARKETPLACE.get('mcd_board_' + today, 'json');
  check('the day board has exactly one entry', Array.isArray(board) ? board.length : -1, 1);
  check('and it carries the scored total', board[0].score, 4200);
  const userRec = await env.MARKETPLACE.get('mcd_user_comp1', 'json');
  check('the user record is the scored result', userRec.dayKey, today);
  check('score recorded', userRec.score, 4200);

  /* The hub was told, on the shared record. 'mana-seed' may not yet be in
     CHALLENGES (the manager appends it), so read the raw done-list rather than
     getDailyState, which only maps the live CHALLENGES. */
  const rec = await readDaily(env, 'comp1');
  ok('the hub marked mana-seed done today', Array.isArray(rec.done[today]) && rec.done[today].includes('mana-seed'));

  /* Mana Clash pays its OWN reward (board + achievements), NOT giveaway
     entries. The framework's meta reward is only for clearing the WHOLE day,
     which one daily cannot do, so no entries were minted here. */
  let entries = 0;
  for (const [, v] of env.MARKETPLACE.store) {
    try { const r = JSON.parse(v); if (r && r.entries != null) entries += Number(r.entries) || 0; } catch {}
  }
  check('no giveaway entries paid by the game daily', entries, 0);

  /* A second completion the same day is a no-op: the board stays at one, and
     the hub done-list still has a single mana-seed. */
  const higher = finishedRoom(); higher.players.comp1.total = 9999;
  await recordDaily(env, higher);
  const board2 = await env.MARKETPLACE.get('mcd_board_' + today, 'json');
  check('second run does not add a board row', board2.length, 1);
  check('second run cannot beat the recorded score', board2[0].score, 4200);
  const rec2 = await readDaily(env, 'comp1');
  check('hub still shows mana-seed done exactly once', rec2.done[today].filter(x => x === 'mana-seed').length, 1);
})();

/* After scoring, start-daily deals a fresh UNSCORED "replay for fun" run — it
   must NOT resume (the recorded result gates the board). */
await (async function replayAfterScoredIsFresh() {
  const env = fakeEnv({ mcd_user_r2: { dayKey: today, score: 50, name: 'Done' } });
  const r = await post(env, { action: 'start-daily' }, 'r2', 'Done');
  ok('a scored player gets a new room', !!r.code);
  ok('and it is not a resume', !r.resumed);
})();

/* Sanity: the framework hub it reports into is the one we expect. */
ok('hub CHALLENGES is an array with the shipped dailies',
  Array.isArray(CHALLENGES) && CHALLENGES.some(c => c.id === 'daily-rite'));

console.log('');
if (failures.length) {
  console.log(`[mana-seed] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[mana-seed] ${passed} assertions passed.`);
