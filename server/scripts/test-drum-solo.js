#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DRUM SOLO METER — chat fills a hype meter with !solo

     node server/scripts/test-drum-solo.js

   A collaborative, chat-only stream mode: the broadcaster starts it, chat
   smashes !solo to fill a meter before a countdown runs out, and a fill throws
   a celebration (no loss state). These tests pin the behaviours that actually
   break a mode like this:

     - the command does NOTHING when no solo is live (and writes nothing);
     - one contributing hit per chatter per cooldown, so a lone masher can never
       fill it alone — crowd size is what matters;
     - distinct-participant dedup (the meter moves, the headcount does not
       double-count);
     - the participation achievement fires EXACTLY once per user per event,
       whether or not the meter filled;
     - the meter fills → 'filled' celebration that self-clears after its linger;
     - the countdown expiring unfilled clears the panel quietly (no penalty);
     - ending writes a tombstone a straggling !solo cannot resurrect;
     - the record never grows past the chatter cap (no per-message log);
     - the public shape never leaks the raw rate-limit map;
     - and the whole wiring: overlay panel + its hygiene, the chat dispatch as a
       PUBLIC command before the mod gate, the Bot Control trigger, the registry
       key and the layout/legend registration.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  onRequestGet, startDrumSolo, stopDrumSolo, soloFromChat, publicDrum,
  DRUM_KEY, DEFAULT_GOAL, DEFAULT_SECONDS, DEFAULT_COOLDOWN_MS,
} from '../../functions/api/drum-solo.js';
import { achKey } from '../../functions/api/achievements.js';

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
const envWith = (seed) => ({ MARKETPLACE: fakeKV(seed), TWITCH_BROADCASTER_ID: '555' });
const GET = (e) => onRequestGet({ env: e });

/* A live event, every field controllable. */
function drum(over = {}) {
  return Object.assign({
    status: 'active', startedAt: Date.now(), endsAt: Date.now() + 30000,
    by: 'PhantomACE', goal: DEFAULT_GOAL, cooldownMs: DEFAULT_COOLDOWN_MS,
    hits: 0, participants: 0, filledAt: 0, seen: {},
  }, over);
}

/* ══ No live solo, no !solo ════════════════════════════════════════════ */
{
  const e = envWith();
  const r = await soloFromChat(e, { userId: '1', name: 'Alice' });
  check('a !solo with no live event is a no-op', r.ok, false);
  check('and writes nothing', e.MARKETPLACE.read(DRUM_KEY), null);
  check('GET reads none', (await (await GET(e)).json()).status, 'none');
}

/* ══ Start raises a live meter ═════════════════════════════════════════ */
{
  const e = envWith();
  const res = await startDrumSolo(e, { by: 'PhantomACE' });
  check('the broadcaster starts a drum solo', res.ok, true);
  check('GET reads active', (await (await GET(e)).json()).status, 'active');
  const rec = e.MARKETPLACE.read(DRUM_KEY);
  check('with the default goal', rec.goal, DEFAULT_GOAL);
  check('and the default per-chatter cooldown', rec.cooldownMs, DEFAULT_COOLDOWN_MS);
  check('and the default countdown', rec.endsAt - rec.startedAt, DEFAULT_SECONDS * 1000);
  check('the meter starts empty', rec.hits, 0);
}

/* ══ One hit per chatter per cooldown; participation counts once ═══════ */
{
  const e = envWith({ [DRUM_KEY]: drum({ goal: 100 }) });

  let r = await soloFromChat(e, { userId: '7', name: 'Reaper' });
  check('a chatter can fill the meter', r.ok, true);
  check('and is a new participant', r.newParticipant, true);
  check('one hit landed', e.MARKETPLACE.read(DRUM_KEY).hits, 1);
  check('one participant', e.MARKETPLACE.read(DRUM_KEY).participants, 1);

  r = await soloFromChat(e, { userId: '7', name: 'Reaper' });
  check('a second hit within the cooldown is a no-op', r.ok, false);
  check('the meter did not move', e.MARKETPLACE.read(DRUM_KEY).hits, 1);

  /* Simulate the cooldown elapsing (the same trick the wind-night/tithe tests
     use — push the stored timestamp into the past). */
  const rec = e.MARKETPLACE.read(DRUM_KEY);
  rec.seen['7'] = Date.now() - DEFAULT_COOLDOWN_MS - 1;
  e.MARKETPLACE.store.set(DRUM_KEY, JSON.stringify(rec));

  r = await soloFromChat(e, { userId: '7', name: 'Reaper' });
  check('after the cooldown the same chatter adds again', r.ok, true);
  check('but not as a new participant', r.newParticipant, false);
  check('the meter moves', e.MARKETPLACE.read(DRUM_KEY).hits, 2);
  check('still exactly one participant', e.MARKETPLACE.read(DRUM_KEY).participants, 1);

  /* The participation join is recorded once per user per event, via the
     achievements engine (not minted inline). */
  const ach = e.MARKETPLACE.read(achKey('drum-solo', '7'));
  ok('the achievement engine recorded the join', !!ach);
  check('and counted it EXACTLY once despite two hits', ach.progress.solos, 1);
}

/* ══ A lone masher can never fill it alone ═════════════════════════════ */
{
  const e = envWith({ [DRUM_KEY]: drum({ goal: 5 }) });
  for (let i = 0; i < 20; i++) await soloFromChat(e, { userId: '7', name: 'Masher' });
  const rec = e.MARKETPLACE.read(DRUM_KEY);
  check('twenty mashes from one chatter land only one hit (cooldown)', rec.hits, 1);
  check('so the meter is nowhere near full', rec.status, 'active');
}

/* ══ A crowd fills it — and the fill is collaborative ══════════════════ */
{
  const e = envWith({ [DRUM_KEY]: drum({ goal: 5 }) });
  let filledReported = false;
  for (let i = 0; i < 5; i++) {
    const r = await soloFromChat(e, { userId: 'c' + i, name: 'c' + i });
    if (r.filled) filledReported = true;
  }
  const rec = e.MARKETPLACE.read(DRUM_KEY);
  check('five distinct drummers fill a goal-5 meter', rec.hits, 5);
  check('and it flips to filled', rec.status, 'filled');
  ok('the filling blow reports the fill', filledReported);
  check('with five participants', rec.participants, 5);
  ok('and it is stamped', rec.filledAt > 0);

  const s = await (await GET(e)).json();
  check('GET reads filled', s.status, 'filled');
  check('pinned at 100%', s.pct, 100);

  /* Full meter → further !solo is a quiet no-op (not live). */
  const late = await soloFromChat(e, { userId: 'z', name: 'z' });
  check('a !solo after the fill does nothing', late.ok, false);
}

/* ══ Filled lingers for the celebration, then clears ═══════════════════ */
{
  const fresh = envWith({ [DRUM_KEY]: drum({ status: 'filled', goal: 5, hits: 5, participants: 5, filledAt: Date.now() - 1000 }) });
  check('a just-filled meter still celebrates', (await (await GET(fresh)).json()).status, 'filled');
  const old = envWith({ [DRUM_KEY]: drum({ status: 'filled', goal: 5, hits: 5, participants: 5, filledAt: Date.now() - 20000 }) });
  check('a long-filled meter reads gone (self-clears)', (await (await GET(old)).json()).status, 'none');
}

/* ══ Countdown expires unfilled → quiet clear, no penalty ══════════════ */
{
  const e = envWith({ [DRUM_KEY]: drum({ goal: 50, hits: 10, endsAt: Date.now() - 1 }) });
  check('the countdown elapsing unfilled reads gone', (await (await GET(e)).json()).status, 'none');
  const r = await soloFromChat(e, { userId: '9', name: 'late' });
  check('and a straggling !solo after it does nothing', r.ok, false);
}

/* ══ Ending writes a tombstone an in-flight !solo cannot resurrect ═════ */
{
  const e = envWith({ [DRUM_KEY]: drum({ goal: 50 }) });
  await stopDrumSolo(e);
  check('stop writes an ended marker under the lock', e.MARKETPLACE.read(DRUM_KEY).status, 'ended');
  check('GET reads none at once', (await (await GET(e)).json()).status, 'none');
  const r = await soloFromChat(e, { userId: '7', name: 'x' });
  check('an in-flight !solo cannot resurrect a stopped solo', r.ok, false);
  check('and the record stays ended', e.MARKETPLACE.read(DRUM_KEY).status, 'ended');
}

/* ══ The record never grows past the chatter cap ═══════════════════════ */
{
  const seen = {};
  for (let i = 0; i < 2000; i++) seen['u' + i] = 0;   // at the cap, all cooldowns long elapsed
  const e = envWith({ [DRUM_KEY]: drum({ goal: 1e9, hits: 2000, participants: 2000, seen }) });

  const r = await soloFromChat(e, { userId: 'NEWCOMER', name: 'new' });
  check('a 2001st distinct chatter is turned away', r.ok, false);
  check('the seen map never grows past the cap', Object.keys(e.MARKETPLACE.read(DRUM_KEY).seen).length, 2000);

  const r2 = await soloFromChat(e, { userId: 'u0', name: 'u0' });
  check('but a chatter already in keeps drumming', r2.ok, true);
  ok('and the record has no per-message log', !JSON.stringify(e.MARKETPLACE.read(DRUM_KEY)).match(/"(hitsLog|log|history|entries)"\s*:\s*\[/));
}

/* ══ The public shape never leaks the rate-limit map ═══════════════════ */
{
  const s = publicDrum(drum({ goal: 10, hits: 3, participants: 2, seen: { '1': 1, '2': 2 } }));
  ok('the raw seen map is never exposed', !('seen' in s));
  check('only a participant count', s.participants, 2);
  check('with a percentage', s.pct, 30);
  ok('and a server clock for a skew-proof countdown', typeof s.serverNow === 'number');
}

/* ══ Achievement config: four drumline tiers at 3/10/25/50 ═════════════ */
{
  /* Wired like sss: a 'drum-solo' game, apply on join, a 4-badge ladder. The
     reachability/uniqueness of the badges is pinned in test-achievements.js;
     here we just confirm the shape this mode depends on. */
  const mod = read('functions/api/drum-solo.js');
  ok('participation records an achievement, wrapped so it cannot break the event',
     /try \{[\s\S]{0,300}recordAchievement[\s\S]{0,200}\} catch/.test(mod) && /'drum-solo'/.test(mod));
  ok('and only a NEW participant is credited (once per user per event)', /newParticipant/.test(mod));

  const ach = read('functions/api/achievements.js');
  ok('the achievements engine registers the drum-solo game', /'drum-solo': DRUM_SOLO/.test(ach));
  ok('with the four drumline badge ids',
     /solo-bronze/.test(ach) && /solo-silver/.test(ach) && /solo-gold/.test(ach) && /solo-diamond/.test(ach));
  ok('join increments the solo count', /p\.solos \+= 1/.test(ach));
}

/* ══ Wiring: the overlay panel and its marathon hygiene ════════════════ */
{
  const html = read('overlay.html');
  ok('the overlay has the drum panel and loads its script',
     /id="ovDrum"/.test(html) && /overlay-drum-solo\.js/.test(html));
  ok('the panel carries the phamDrum emote',
     /assets\/emotes\/phamDrum\.png/.test(html) && /id="ovDrumEmote"/.test(html));

  const ovjs = read('js/pages/overlay-drum-solo.js');
  ok('the panel polls its own state', /\/api\/drum-solo/.test(ovjs));
  ok('and hides to display:none when inactive', /panel\.hidden = true/.test(ovjs));
  /* Marathon-safe: no setInterval animation loop — a self-rescheduling poll that
     backs off when idle, so nothing runs while the panel is hidden. */
  ok('no animation interval — a backing-off poll', !/setInterval/.test(ovjs) && /IDLE_POLL_MS/.test(ovjs));
  ok('no backdrop-filter on the panel script', !/backdrop-filter/.test(ovjs));

  const css = read('css/pages/overlay.css');
  ok('the panel has a [hidden]{display:none} guard', /\.ov-drum\[hidden\]\s*\{\s*display:\s*none/.test(css));

  /* House rules over the drum block only. */
  /* Start at the first RULE (not the header comment, which itself says "no
     box-shadow" and would wrongly trip a naive match), and stop at the next
     section's comment. */
  const start = css.indexOf('.ov-drum[hidden]');
  const block = css.slice(start, css.indexOf('COMMANDER BINGO', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the drum block is found', block.length > 300);
  check('no box-shadow', block.match(/box-shadow/g) || [], []);
  check('no backdrop-filter', block.match(/backdrop-filter/g) || [], []);
  check('no coloured side rail', block.match(/border-(left|right):/g) || [], []);
  ok('the heading is GodOfWar and the body Grenze', /var\(--font-display\)/.test(block) && /var\(--font-ui\)/.test(block));
  ok('colours come from tokens', /var\(--red\)/.test(block));
  check('and no hex is hardcoded', block.match(/#[0-9a-fA-F]{3,6}\b/g) || [], []);
}

/* ══ Wiring: the chat command, the trigger, the registry, the layout ═══ */
{
  const cmds = read('functions/api/bot/commands.js');
  ok('chat dispatches !solo', /parsed\.command === '!solo'/.test(cmds));
  ok('as a PUBLIC command, before the moderator gate',
     cmds.indexOf("'!solo'") < cmds.indexOf('if (!isAuthorizedSender(env, event)) return;'));

  const trig = read('functions/api/bot/trigger.js');
  ok('Bot Control can start the drum solo', /action === 'drum-start'/.test(trig) && /startDrumSolo/.test(trig));
  ok('and stop it', /action === 'drum-stop'/.test(trig) && /stopDrumSolo/.test(trig));

  const botHtml = read('bot-control.html');
  ok('the Bot Control panel has the drum buttons',
     /id="drumSoloStartBtn"/.test(botHtml) && /id="drumSoloStopBtn"/.test(botHtml));
  const botJs = read('js/pages/bot-control.js');
  ok('and wires them to the trigger',
     /action: 'drum-start'/.test(botJs) && /action: 'drum-stop'/.test(botJs));

  const reg = read('server/lib/registry.js');
  ok('the drum_solo key is registered', /drum_solo:\s*\{ table: 'singletons', expiry: 'real' \}/.test(reg));

  const layout = read('functions/api/overlay/layout.js');
  ok('the panel id is in PANEL_IDS', /'ovDrum'/.test(layout));
  const samples = read('js/pages/overlay-samples.js');
  ok('the panel has a layout sample that fills it', /id: 'ovDrum'/.test(samples) && /function drum\(\)/.test(samples) && /drum\(\);/.test(samples));
  const overlay = read('js/pages/overlay.js');
  ok('the idle-reload check knows the panel', /'ovDrum'/.test(overlay));
  const editor = read('js/pages/overlay-editor.js');
  ok('the editor legend groups the panel', /'ovDrum'/.test(editor));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[drum-solo] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[drum-solo] ${passed} assertions passed.`);
console.log('');
