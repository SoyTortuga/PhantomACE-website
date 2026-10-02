#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SKULL CLICKER — the cross-device save

     node server/scripts/test-skull-save.js

   Skull Clicker kept its whole state in localStorage and nothing else, so
   a cleared browser lost every upgrade — the server held only a single
   leaderboard number, which cannot rebuild a save. This adds a real
   server save, and the one rule that makes it safe to sync across devices
   is HIGHEST LIFETIME TOTAL WINS: totalSkulls only ever climbs, so an old
   tab or a wiped browser can never overwrite a better save with a worse
   one. These tests are that rule, from both directions, plus the gate
   (login only — a guest's id died with the localStorage this fixes).
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost } from '../../functions/api/skull-clicker.js';
import { monthKey } from '../../functions/api/season-time.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

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
    async mutate(k, fn) {
      const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
      const out = await fn(cur);
      if (out === undefined) return;
      store.set(k, JSON.stringify(out));
    },
  };
}
const as = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) });
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/skull-clicker', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });

const state = (total, over = {}) => ({
  skulls: total, totalSkulls: total, lifetimeSkulls: total, prestige: 0,
  totalClicks: 10, owned: { a: 1 },
  boughtUpgrades: ['u1'], hitMilestones: ['m1'], savedAt: 1, version: 2, ...over,
});

/* ══ Login only ════════════════════════════════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  check('a guest cannot save', (await POST(e, { action: 'save-state', state: state(100), guestId: 'g', guestName: 'G' })).status, 401);
  check('nor load', (await POST(e, { action: 'load-state', guestId: 'g' })).status, 401);
  check('anonymous cannot save', (await POST(e, { action: 'save-state', state: state(100) })).status, 401);
  ok('and nothing was written', e.MARKETPLACE.store.size === 0);
}

/* ══ Save, load, round-trip ════════════════════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  const res = await POST(e, { action: 'save-state', state: state(500) }, as('7'));
  check('a logged-in save succeeds', res.status, 200);
  check('and is keyed by user', !!e.MARKETPLACE.read('sc_save_7'), true);
  check('with a fresh savedAt stamped', e.MARKETPLACE.read('sc_save_7').totalSkulls, 500);

  const loaded = await (await POST(e, { action: 'load-state' }, as('7'))).json();
  check('load returns the saved upgrades', loaded.state.boughtUpgrades, ['u1']);
  check('a user with no save loads null', (await (await POST(e, { action: 'load-state' }, as('nobody'))).json()).state, null);
}

/* ══ THE RULE: highest lifetime total wins ═════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  await POST(e, { action: 'save-state', state: state(1000) }, as('7'));

  /* A worse save arrives — an old tab, or a device behind the others. It
     must NOT overwrite, and it must be TOLD the server is ahead so the
     client adopts the better one instead of clobbering. */
  const lower = await (await POST(e, { action: 'save-state', state: state(400) }, as('7'))).json();
  check('a lower total does not overwrite', e.MARKETPLACE.read('sc_save_7').totalSkulls, 1000);
  check('and the client is told to adopt the server save', lower.adopted, true);
  check('which is the higher one', lower.state.totalSkulls, 1000);

  /* A better save advances it. */
  const higher = await (await POST(e, { action: 'save-state', state: state(2500) }, as('7'))).json();
  check('a higher total overwrites', e.MARKETPLACE.read('sc_save_7').totalSkulls, 2500);
  check('and is not flagged adopted', higher.adopted, false);

  /* THE RECOVERY CASE: cleared browser, local total 0, server has 2500.
     The save it pushes is worse, so the server holds and hands back 2500 —
     the client adopts it and the progress is restored. */
  const wiped = await (await POST(e, { action: 'save-state', state: state(0) }, as('7'))).json();
  check('a wiped browser does not erase the server save', e.MARKETPLACE.read('sc_save_7').totalSkulls, 2500);
  check('and gets the real save back to adopt', wiped.state.totalSkulls, 2500);
}

/* ══ Prestige survives the merge — the collision this feature created ══ */
{
  const e = { MARKETPLACE: fakeKV() };
  /* A long pre-prestige run: high lifetime, prestige 0. */
  await POST(e, { action: 'save-state', state: state(5000, { lifetimeSkulls: 5000, prestige: 0 }) }, as('7'));

  /* The player prestiges: run resets to 0, lifetime UNCHANGED at 5000,
     prestige now 1. The save it pushes has total 0 — under the old
     run-total merge this would LOSE and the sync would undo the prestige.
     It must win on prestige. */
  const afterPrestige = await (await POST(e, { action: 'save-state',
    state: state(0, { lifetimeSkulls: 5000, prestige: 1 }) }, as('7'))).json();
  check('a fresh prestige is stored despite total 0', e.MARKETPLACE.read('sc_save_7').prestige, 1);
  check('and is not told to adopt the old save', afterPrestige.adopted, false);

  /* The old device now syncs (still prestige 0, lifetime 5000). It must be
     told to adopt the prestiged save, not overwrite it. */
  const oldDevice = await (await POST(e, { action: 'save-state',
    state: state(5000, { lifetimeSkulls: 5000, prestige: 0 }) }, as('7'))).json();
  check('the old device does not clobber the prestige', e.MARKETPLACE.read('sc_save_7').prestige, 1);
  check('and is handed the prestiged save to adopt', oldDevice.adopted, true);
  check('which is prestige 1', oldDevice.state.prestige, 1);

  /* Within the same prestige tier, more lifetime still wins normally. */
  await POST(e, { action: 'save-state', state: state(0, { lifetimeSkulls: 9000, prestige: 1 }) }, as('7'));
  check('more lifetime at equal prestige advances', e.MARKETPLACE.read('sc_save_7').lifetimeSkulls, 9000);
}

/* ══ Bad input ═════════════════════════════════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  check('a missing state is refused', (await POST(e, { action: 'save-state' }, as('7'))).status, 400);
  const huge = { ...state(10), pad: 'x'.repeat(30000) };
  check('an oversized save is refused', (await POST(e, { action: 'save-state', state: huge }, as('7'))).status, 400);
  ok('and neither wrote anything', !e.MARKETPLACE.read('sc_save_7'));

  /* A save with a nonsense total is treated as total 0 for the merge, so it
     can never win against a real one. */
  await POST(e, { action: 'save-state', state: state(800) }, as('7'));
  await POST(e, { action: 'save-state', state: state(0, { totalSkulls: 'lots' }) }, as('7'));
  check('a non-numeric total cannot clobber', e.MARKETPLACE.read('sc_save_7').totalSkulls, 800);
}

/* ══ Reset All Progress ════════════════════════════════════════════════
   THE BUG: the client removed sc_save and reloaded, but the server copy
   was adopted straight back on boot. The reset must wipe the account's
   save too, and no stale tab or other device may restore it afterwards. */
{
  const e = { MARKETPLACE: fakeKV() };
  const epoch = monthKey(new Date());
  await POST(e, { action: 'save-state', state: state(9000, { prestige: 5, ascensions: 2, graveBlooms: 40, seasonEpoch: epoch }) }, as('7'));
  await POST(e, { action: 'save-state', state: state(777, { prestige: 1 }) }, as('8'));

  check('a reset without confirmation is refused', (await POST(e, { action: 'reset-save' }, as('7'))).status, 400);
  check('a guest cannot reset anything', (await POST(e, { action: 'reset-save', confirm: true, guestId: 'g' })).status, 401);
  check('and the save survived both', e.MARKETPLACE.read('sc_save_7').prestige, 5);

  const r = await (await POST(e, { action: 'reset-save', confirm: true }, as('7'))).json();
  ok('the reset succeeds and hands back the fresh save', r.success === true && r.state && r.state.resetAt > 0);
  const wiped = e.MARKETPLACE.read('sc_save_7');
  ok('ALL progress is gone — run, prestige, ascensions, blooms, lifetime',
     !wiped.prestige && !wiped.ascensions && !wiped.graveBlooms && !wiped.lifetimeSkulls && !wiped.totalSkulls && !wiped.boughtUpgrades);
  check('it carries the server season epoch, so it takes no spurious monthly wipe', wiped.seasonEpoch, epoch);
  check('another account is untouched', e.MARKETPLACE.read('sc_save_8').totalSkulls, 777);

  const loaded = await (await POST(e, { action: 'load-state' }, as('7'))).json();
  check('a boot sync now loads the wiped save, not the old one', loaded.state.resetAt, r.state.resetAt);

  /* A tab that was open before the reset pushes its old (higher) progress —
     same epoch, more ascensions/prestige/lifetime. It must lose. */
  const stale = await (await POST(e, { action: 'save-state', state: state(9000, { prestige: 5, ascensions: 2, seasonEpoch: epoch }) }, as('7'))).json();
  check('a stale tab cannot restore the reset progress', e.MARKETPLACE.read('sc_save_7').prestige, undefined);
  check('and is told to adopt the reset save', stale.adopted, true);
  check('which is the stamped one', stale.state.resetAt, r.state.resetAt);

  /* Fresh play after the reset carries the same stamp and saves normally. */
  await POST(e, { action: 'save-state', state: state(50, { resetAt: r.state.resetAt, seasonEpoch: epoch }) }, as('7'));
  check('play after the reset saves normally', e.MARKETPLACE.read('sc_save_7').totalSkulls, 50);

  const r2 = await (await POST(e, { action: 'reset-save', confirm: true }, as('7'))).json();
  ok('a second reset stamps a strictly newer resetAt', r2.state.resetAt > r.state.resetAt);
}

/* Find a function in the page and return its brace-matched body. */
function fnBody(src, name) {
  const at = src.search(new RegExp('(?:async\\s+)?function ' + name + '\\s*\\('));
  if (at < 0) return '';
  let p = src.indexOf('(', at), parens = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parens++;
    else if (src[p] === ')' && --parens === 0) break;
  }
  let i = src.indexOf('{', p), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return '';
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('sc_save_ maps to its own table', /prefix: 'sc_save_',\s*table: 'skull_saves'/.test(reg));

  const schema = fs.readFileSync(path.join(REPO, 'server/sql/001_schema.sql'), 'utf8');
  ok('the schema declares skull_saves', /CREATE TABLE IF NOT EXISTS skull_saves/.test(schema));
  ok('and a standalone migration exists', fs.existsSync(path.join(REPO, 'server/sql/008_skull_saves.sql')));

  const client = fs.readFileSync(path.join(REPO, 'games/skull-clicker/index.html'), 'utf8');
  /* Boot order: local load first, then the server merge is AWAITED before
     the season check acts on the settled save. */
  const boot = client.slice(client.indexOf('═══════ INIT ═══════'));
  const iLoad = boot.search(/\n\s*load\(\);/), iSync = boot.indexOf('await syncFromServer()'), iSeason = boot.indexOf('await checkSeasonReset()');
  ok('the client syncs from the server on boot', /function syncFromServer/.test(client)
     && iLoad >= 0 && iSync > iLoad && iSeason > iSync);
  ok('and the mid-session season check waits for that boot merge',
     /seasonReady = true;/.test(boot) && boot.indexOf('seasonReady = true;') > iSeason);
  ok('adopts the server save only when it outranks by prestige then lifetime',
     /function serverOutranks/.test(client) && /sp > lp/.test(client));
  ok('prestige multiplies all gathering', /function getPrestigeMult/.test(client) && /1 \+ 0\.1 \* prestige/.test(client));
  ok('a prestige resets the run but not lifetime or tier',
     /function doPrestige/.test(client) && /prestige \+= 1/.test(client));
  const submit = fnBody(client, 'submitScore');
  ok('lifetime is the leaderboard score, not the run total',
     /const lifeFloor = lifetimeSkulls\.floor\(\);/.test(submit) && /const lifeStr = lifeFloor\.toString\(\);/.test(submit)
     && /score: lifeStr/.test(submit) && !/totalSkulls\.floor\(\)/.test(submit));
  const earnFn = fnBody(client, 'earn');
  ok('every earn path feeds lifetime', /lifetimeSkulls = lifetimeSkulls\.add\(a\)/.test(earnFn)
     && /skulls = skulls\.add\(a\)/.test(earnFn) && /totalSkulls = totalSkulls\.add\(a\)/.test(earnFn));
  ok('clicks and the auto-clicker both earn through it',
     /earn\(power\)/.test(fnBody(client, 'handleClick')) && /earn\(power\)/.test(fnBody(client, 'autoClickTick')));
  ok('and mirrors each save to the server', /function pushSaveToServer/.test(client) && /submitScore\(\);\s*\n\s*pushSaveToServer/.test(client));
  ok('local load and server adopt share one apply path', /function applyState/.test(client));

  /* Unload saves must survive the page, and the score is written once. */
  ok('the server save survives unload (keepalive)', /keepalive: true/.test(fnBody(client, 'pushSaveToServer')));
  ok('the score submit survives unload (keepalive)', /keepalive: true/.test(submit));
  ok('no duplicate /api/leaderboards write for the same board', !/fetch\(\s*['"]\/api\/leaderboards/.test(submit)
     && (submit.match(/fetch\(/g) || []).length === 1);

  /* Reset All Progress: suppress every save, wipe the server copy, then reload. */
  const saveFn = fnBody(client, 'save');
  ok('every save is a no-op while a reset is in flight', /^\{\s*if \(resetting\) return;/.test(saveFn));
  ok('the unload save goes through that same save()', /addEventListener\('beforeunload', save\)/.test(client));
  const reset = fnBody(client, 'hardReset');
  ok('reset asks the player first', /confirm\(/.test(reset));
  const iSuppress = reset.indexOf('resetting = true'), iServer = reset.indexOf("action: 'reset-save'"), iReload = reset.indexOf('location.reload()');
  ok('reset suppresses saves, wipes the server save, then reloads — in that order',
     iSuppress > 0 && iServer > iSuppress && iReload > iServer);
  ok('a failed server wipe erases nothing', /if \(!fresh\) \{\s*resetting = false;[\s\S]*?return;/.test(reset));
  ok('the reset stamp persists and is restored', /resetAt,\s*\n\s*savedAt/.test(saveFn) && /resetAt = Number\(d\.resetAt\)/.test(fnBody(client, 'applyState')));
  const outr = fnBody(client, 'serverOutranks');
  ok('the client merge ranks the reset stamp first, like the server', outr.indexOf('resetAt') >= 0 && outr.indexOf('resetAt') < outr.indexOf('seasonEpoch'));

  /* Season month: the server's epoch, never the local UTC clock. */
  ok('the leaderboard month comes from the server epoch', !/getUTC/.test(fnBody(client, 'currentMonthKey')) && /serverEpoch/.test(fnBody(client, 'currentMonthKey')));
  const poll = fnBody(client, 'pollSkullEvent');
  ok('a long-open tab takes the monthly reset from the event poll',
     /d\.epoch/.test(poll) && /seasonReady && epochNum\(seasonEpoch\) < epochNum\(d\.epoch\)/.test(poll) && /checkSeasonReset\(d\.epoch\)/.test(poll));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[skull-save] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[skull-save] ${passed} assertions passed.`);
console.log('');
