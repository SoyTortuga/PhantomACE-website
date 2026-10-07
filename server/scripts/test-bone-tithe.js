#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SKULL CLICKER — the Bone Tithe (community offering goal)

     node server/scripts/test-bone-tithe.js

   A shared stream goal the whole site fills by offering skulls together. These
   tests cover the moderator gate on starting/stopping a goal, offerings that
   accumulate under the per-key lock without racing, the lifetime ceiling that
   stops a forged client amount from crediting more than the player has earned,
   the bounded contributor map (no per-offering growth), the goal-met → complete
   flip (with its community frenzy), and the public state shape the game and
   overlay read (hidden when no goal is live), plus the client/overlay wiring.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet, onRequestPost, titheFromChat } from '../../functions/api/bone-tithe.js';

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
    async delete(k) { store.delete(k); },
    async mutate(k, fn) { const cur = store.has(k) ? JSON.parse(store.get(k)) : null; const out = await fn(cur); if (out === undefined) return; store.set(k, JSON.stringify(out)); },
  };
}
const BC = '555';
const cookie = (id, name) => id ? { Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: name || ('U' + id) })) } : {};
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/bone-tithe', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });
const GET = (e, h) => onRequestGet({ env: e, request: new Request('https://x/api/bone-tithe', { headers: { ...h } }) });
const envWith = (seed) => ({ MARKETPLACE: fakeKV(seed), TWITCH_BROADCASTER_ID: BC });

/* A live goal. */
function tithe(over = {}) {
  return Object.assign({
    status: 'active', title: 'Bone Tithe', goal: 1_000_000, progress: 0,
    startedAt: Date.now(), endsAt: 0, completedAt: 0, contributors: {},
  }, over);
}
/* A player's save, as skull-clicker.js stores it (lifetime is a big-number string). */
const save = (life) => ({ lifetimeSkulls: String(life), totalSkulls: String(life) });

/* ══ The start/stop gate ═══════════════════════════════════════════════ */
{
  const e = envWith();
  check('a stranger cannot start a tithe', (await POST(e, { action: 'start', goal: 5000 }, cookie('9'))).status, 403);
  const res = await (await POST(e, { action: 'start', goal: 5000, title: 'Feed the Reaper' }, cookie(BC))).json();
  check('the broadcaster starts a tithe', res.success, true);
  check('with the requested goal', res.tithe.goal, 5000);
  check('and the requested title', res.tithe.title, 'Feed the Reaper');
  check('and it is active', e.MARKETPLACE.read('bone_tithe').status, 'active');

  check('a stranger cannot stop it', (await POST(e, { action: 'stop' }, cookie('9'))).status, 403);
  await POST(e, { action: 'stop' }, cookie(BC));
  check('the broadcaster stops it', (await (await GET(e)).json()).status, 'none');
  check('by an ended marker written under the lock', e.MARKETPLACE.read('bone_tithe').status, 'ended');
}

/* ══ Offering: login required, accumulates, bounded ════════════════════ */
{
  const e = envWith({ bone_tithe: tithe({ goal: 10000 }), sc_save_7: save(1e9) });
  check('an anonymous offer is refused', (await POST(e, { action: 'offer', amount: 100 })).status, 401);

  let s = await (await POST(e, { action: 'offer', amount: 100 }, cookie('7', 'Reaper7'))).json();
  check('an offer raises progress', s.progress, 100);
  check('and credits exactly what was offered', s.credited, 100);
  check('and counts the contributor', s.contributors, 1);
  check('and records them in the top list', s.top[0].amt, 100);

  s = await (await POST(e, { action: 'offer', amount: 250 }, cookie('7', 'Reaper7'))).json();
  check('a second offer from the same player accumulates', s.progress, 350);
  check('still one contributor', s.contributors, 1);

  const rec = e.MARKETPLACE.read('bone_tithe');
  check('the record keeps a single contributor row (no per-offering log)', Object.keys(rec.contributors).length, 1);
  check('the row is the running total, not a list', rec.contributors.u_7.amt, 350);
  ok('and the record grows no per-offering array', !JSON.stringify(rec).match(/"(offers|log|history|entries)"\s*:\s*\[/));
}

/* ══ Many offers never grow the record past the contributor map ════════ */
{
  const seed = { bone_tithe: tithe({ goal: 1e12 }) };
  const e = envWith(seed);
  for (let i = 0; i < 25; i++) e.MARKETPLACE.store.set('sc_save_' + i, JSON.stringify(save(1e9)));
  for (let i = 0; i < 25; i++) for (let j = 0; j < 4; j++) await POST(e, { action: 'offer', amount: 10 }, cookie(String(i)));
  const rec = e.MARKETPLACE.read('bone_tithe');
  check('100 offerings from 25 players leave 25 contributor rows', Object.keys(rec.contributors).length, 25);
  check('and the aggregate progress is their sum', rec.progress, 25 * 4 * 10);
}

/* ══ The lifetime ceiling — a forged amount cannot exceed what you earned ══ */
{
  const e = envWith({ bone_tithe: tithe({ goal: 1e9 }), sc_save_7: save(500) });   /* lifetime only 500 */
  let s = await (await POST(e, { action: 'offer', amount: 1e9 }, cookie('7'))).json();
  check('a forged huge offer is clamped to the player\'s lifetime', s.credited, 500);
  check('so progress cannot exceed what they earned', s.progress, 500);
  s = await (await POST(e, { action: 'offer', amount: 1e9 }, cookie('7'))).json();
  check('and once their lifetime is spent, nothing more credits', s.credited, 0);
  check('leaving progress where it was', s.progress, 500);

  const noSave = envWith({ bone_tithe: tithe({ goal: 1000 }) });
  const t = await (await POST(noSave, { action: 'offer', amount: 100 }, cookie('nobody'))).json();
  check('a player with no synced save yet can tithe nothing', t.credited, 0);
  check('and is not added as a contributor', (noSave.MARKETPLACE.read('bone_tithe').contributors || {}).u_nobody, undefined);
}

/* ══ An offer never over-fills the goal; the remainder is reported ══════ */
{
  const e = envWith({ bone_tithe: tithe({ goal: 100, progress: 90 }), sc_save_7: save(1e9) });
  const s = await (await POST(e, { action: 'offer', amount: 1000 }, cookie('7'))).json();
  check('only what the goal still needs is credited', s.credited, 10);
  check('progress lands exactly on the goal', s.progress, 100);
}

/* ══ Goal met → complete, with the community frenzy ════════════════════ */
{
  const e = envWith({ bone_tithe: tithe({ goal: 100 }), sc_save_7: save(1e9) });
  const s = await (await POST(e, { action: 'offer', amount: 1000 }, cookie('7'))).json();
  check('reaching the goal flips it to complete', s.status, 'complete');
  check('progress is pinned at the goal', s.progress, 100);
  ok('completion is stamped', e.MARKETPLACE.read('bone_tithe').completedAt > 0);
  const ev = e.MARKETPLACE.read('sc_event');
  ok('a community frenzy is fired on completion', ev && ev.type === 'frenzy' && ev.until > Date.now());

  const late = await (await POST(e, { action: 'offer', amount: 50 }, cookie('9', 'Latecomer')).then(r => r)).json();
  check('an offer after completion credits nothing', late.credited, 0);
}

/* ══ The lifecycle resolves on read (hides when inactive) ══════════════ */
{
  check('no record reads as none', (await (await GET(envWith())).json()).status, 'none');

  const active = envWith({ bone_tithe: tithe({ goal: 400, progress: 100 }) });
  const s = await (await GET(active)).json();
  check('a live goal reads active', s.status, 'active');
  check('with a percentage', s.pct, 25);
  check('and the contributor map is never exposed, only a count', s.contributors, 0);
  ok('the top list is an array', Array.isArray(s.top));
  ok('no raw contributor map leaks into the public shape', !('u_7' in s) && typeof s.contributors === 'number');

  const freshDone = envWith({ bone_tithe: tithe({ status: 'complete', goal: 100, progress: 100, completedAt: Date.now() - 1000 }) });
  check('a just-met goal still shows its celebration', (await (await GET(freshDone)).json()).status, 'complete');
  const oldDone = envWith({ bone_tithe: tithe({ status: 'complete', goal: 100, progress: 100, completedAt: Date.now() - 60000 }) });
  check('a long-completed goal reads as gone', (await (await GET(oldDone)).json()).status, 'none');

  const timedOut = envWith({ bone_tithe: tithe({ goal: 1000, progress: 10, endsAt: Date.now() - 1 }) });
  check('an unmet goal past its deadline reads as gone', (await (await GET(timedOut)).json()).status, 'none');
  const ended = envWith({ bone_tithe: { status: 'ended', endedAt: Date.now() } });
  check('a stopped goal reads as gone', (await (await GET(ended)).json()).status, 'none');
}

/* ══ Concurrent offerings do not race (the re-read happens under the lock) ══
   Hook the save read so that, between reading the player's lifetime and taking
   the lock, a DIFFERENT offering lands directly on the stored record. The
   mutate() must re-read the updated record and add on top — never clobber it. */
{
  const e = envWith({ bone_tithe: tithe({ goal: 1e6 }), sc_save_7: save(1e9) });
  const kv = e.MARKETPLACE;
  const realGet = kv.get.bind(kv);
  let fired = false;
  kv.get = async (k, t) => {
    const v = await realGet(k, t);
    if (k === 'sc_save_7' && !fired) {
      fired = true;
      const r = kv.read('bone_tithe');
      r.progress = 5000; r.contributors = { u_9: { name: 'U9', amt: 5000 } };
      kv.store.set('bone_tithe', JSON.stringify(r));
    }
    return v;
  };
  const s = await (await POST(e, { action: 'offer', amount: 300 }, cookie('7'))).json();
  check('the new offer is added on top of the concurrent one', s.progress, 5300);
  check('and the concurrent contributor is preserved', kv.read('bone_tithe').contributors.u_9.amt, 5000);
  check('alongside the offering player', kv.read('bone_tithe').contributors.u_7.amt, 300);
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const html = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay has the bone-tithe panel and loads it',
     /id="ovTithe"/.test(html) && /overlay-bone-tithe\.js/.test(html));

  const ovjs = fs.readFileSync(path.join(REPO, 'js/pages/overlay-bone-tithe.js'), 'utf8');
  ok('the overlay panel polls its own state', /\/api\/bone-tithe/.test(ovjs));
  ok('and hides to display:none when inactive', /panel\.hidden = true/.test(ovjs));
  /* Marathon-safe: no setInterval animation loop — only a self-rescheduling poll
     that backs off when idle, so nothing runs while the panel is hidden. */
  ok('the panel uses a backing-off poll, not an animation interval', !/setInterval/.test(ovjs) && /IDLE_POLL_MS/.test(ovjs));
  ok('no backdrop-filter on the panel script', !/backdrop-filter/.test(ovjs));

  const css = fs.readFileSync(path.join(REPO, 'css/pages/overlay.css'), 'utf8');
  ok('the panel has a [hidden]{display:none} guard', /\.ov-tithe\[hidden\]\s*\{\s*display:\s*none/.test(css));
  ok('and no box-shadow in its styles', !/\.ov-tithe[^{]*\{[^}]*box-shadow/.test(css));

  const game = fs.readFileSync(path.join(REPO, 'games/skull-clicker/index.html'), 'utf8');
  ok('the game polls the tithe', /function pollTithe/.test(game) && /\/api\/bone-tithe/.test(game));
  ok('the game can offer toward the tithe', /function offerToTithe/.test(game) && /action: 'offer'/.test(game));
  ok('the game shows a progress affordance', /id="titheBanner"/.test(game) && /function renderTitheBanner/.test(game));
  ok('an in-game login link targets the top frame for OAuth', /target="_top" href="' \+ titheLoginUrl/.test(game));
}

/* ══ CHAT'S DOOR INTO THE TITHE ════════════════════════════════════════
   A tithe costs site players skulls they earned; chat types a word. The
   design question is letting chat matter without making that sacrifice
   meaningless, so these are balance rules, not conveniences:

     - Chat is capped at a QUARTER of the goal and can never finish one alone.
     - One contribution per chatter per goal, so the total measures how many
       PEOPLE turned up rather than how fast somebody can type.
     - They land as ONE aggregate contributor, or a top-five list fills with
       chatters and buries the players who actually spent something. */
{
  const e = envWith({ bone_tithe: tithe({ goal: 1000 }) });

  const r = await titheFromChat(e, { userId: '1', name: 'Alice' });
  check('a chatter can tithe', r.ok, true);
  ok('and it credits something', r.credited > 0);

  let s = await (await GET(e)).json();
  ok('the goal moves', s.progress > 0);
  const row = s.top.find(t => /^Chat/.test(t.name));
  ok('chat shows as one contributor', !!row);
  ok('carrying its headcount', /Chat \(1\)/.test(row.name));

  check('the same chatter cannot tithe twice', (await titheFromChat(e, { userId: '1', name: 'Alice' })).ok, false);
  const after = await (await GET(e)).json();
  check('and the goal did not move again', after.progress, s.progress);

  await titheFromChat(e, { userId: '2', name: 'Bob' });
  s = await (await GET(e)).json();
  ok('a second chatter adds more', s.progress > after.progress);
  ok('and the headcount follows', /Chat \(2\)/.test(s.top.find(t => /^Chat/.test(t.name)).name));
  check('still exactly one chat row', s.top.filter(t => /^Chat/.test(t.name)).length, 1);
  check('and one contributor row in the record', Object.keys(e.MARKETPLACE.read('bone_tithe').contributors).length, 1);
}

/* ══ CHAT CANNOT FINISH A TITHE ALONE ══════════════════════════════════ */
{
  const goal = 1000;
  const e = envWith({ bone_tithe: tithe({ goal }) });
  for (let i = 0; i < 600; i++) await titheFromChat(e, { userId: 'c' + i, name: 'c' + i });

  const s = await (await GET(e)).json();
  ok('chat contributed', s.progress > 0);
  ok('but no more than a quarter of the goal', s.progress <= Math.floor(goal * 0.25));
  check('so the goal is still open', s.status, 'active');
  check('and no frenzy fired', e.MARKETPLACE.read('sc_event'), null);
}

/* ══ A player still finishes it, and chat's help counts ════════════════ */
{
  const e = envWith({ bone_tithe: tithe({ goal: 1000 }), sc_save_7: save(1e9) });
  for (let i = 0; i < 50; i++) await titheFromChat(e, { userId: 'c' + i, name: 'c' + i });
  const helped = (await (await GET(e)).json()).progress;
  ok('chat moved it off zero', helped > 0);

  await POST(e, { action: 'offer', amount: 1000 }, cookie('7', 'Reaper7'));
  const s = await (await GET(e)).json();
  check('the goal completes', s.status, 'complete');
  ok('the frenzy fires', !!e.MARKETPLACE.read('sc_event'));
  ok('and chat is still on the board', s.top.some(t => /^Chat/.test(t.name)));
}

/* ══ Chat can land the final blow, and it pays out properly ════════════ */
{
  /* A goal small enough that chat's quarter-share covers what is left. */
  const e = envWith({ bone_tithe: tithe({ goal: 1000, progress: 960 }), sc_save_7: save(1e9) });
  for (let i = 0; i < 100 && (await (await GET(e)).json()).status === 'active'; i++) {
    await titheFromChat(e, { userId: 'z' + i, name: 'z' + i });
  }
  const s = await (await GET(e)).json();
  check('chat can close out a nearly-met goal', s.status, 'complete');
  check('progress never overshoots', s.progress, 1000);
  ok('and the frenzy fires from the chat path too', !!e.MARKETPLACE.read('sc_event'));
}

/* ══ No live goal, no tithe ════════════════════════════════════════════ */
{
  const e = envWith();
  check('a tithe with no goal is a no-op', (await titheFromChat(e, { userId: '1', name: 'a' })).ok, false);

  const e2 = envWith({ bone_tithe: tithe({ goal: 1000 }) });
  await POST(e2, { action: 'stop' }, cookie(BC));
  check('and a stopped goal takes none either', (await titheFromChat(e2, { userId: '1', name: 'a' })).ok, false);
}

{
  const cmds = fs.readFileSync(path.join(REPO, 'functions/api/bot/commands.js'), 'utf8');
  ok('chat dispatches !tithe', /parsed\.command === '!tithe'/.test(cmds));
  ok('as a PUBLIC command, before the moderator gate',
     cmds.indexOf("'!tithe'") < cmds.indexOf('if (!isAuthorizedSender(env, event)) return;'));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[bone-tithe] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[bone-tithe] ${passed} assertions passed.`);
console.log('');
