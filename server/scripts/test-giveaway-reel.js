#!/usr/bin/env node
/* ══════════════════════════════════════════════
   GIVEAWAY REEL — test suite

     node server/scripts/test-giveaway-reel.js

   The reel replaced a wheel, and the one thing that has to be true of
   either is that it stops on the name the SERVER picked. Nobody can verify
   that by watching an animation: a reel that lands on the wrong row looks
   exactly like a reel that lands on the right one, and the mistake is only
   visible to the person whose name was called and did not win.

   So the strip's LAST row is the winner, always, and the offset is a whole
   number of rows. Everything else here guards a case that would show up on
   a live stream: one entrant, an empty draw, a winner index the panel and
   the server disagree about.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const REEL_SRC = path.join(REPO, 'js/giveaway-reel.js');

/* Loaded the way the browser loads it — a plain script hanging itself off a
   global — so the test exercises the same file the panel does. */
const scope = {};
new Function('window', fs.readFileSync(REEL_SRC, 'utf8'))(scope);
const Reel = scope.PhamReel;

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const people = (...names) => names.map(username => ({ username }));

/* A deterministic 0..1 source, so a failure here is reproducible rather
   than something that shows up one run in twenty. */
function seeded(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/* ── It exists and agrees with the stylesheet ────────────────────────── */
{
  ok('the module loads', !!Reel);
  check('one row is 56px', Reel.ROW_H, 56);

  /* The window is one row high and the strip moves by whole rows, so these
     two numbers disagreeing puts a name half out of frame — a thing that
     looks like a rendering bug and is a units bug. */
  const css = fs.readFileSync(path.join(REPO, 'css/pages/bot-control.css'), 'utf8');
  const win = /\.giveaway-reel-window\s*\{[^}]*height:\s*(\d+)px/.exec(css);
  const row = /\.giveaway-reel-row\s*\{[^}]*height:\s*(\d+)px/.exec(css);
  ok('the stylesheet sizes the window', !!win);
  ok('and the row', !!row);
  check('the window is exactly one row high', win && win[1], row && row[1]);
  check('and that row is ROW_H', Number(row && row[1]), Reel.ROW_H);
}

/* ── THE ONE RULE ────────────────────────────────────────────────────── */
{
  const list = people('alice', 'bob', 'carol', 'dave');
  for (let i = 0; i < list.length; i++) {
    const s = Reel.strip(list, i, { rng: seeded(i + 1) });
    check(`the reel stops on entrant ${i}`, s.names[s.names.length - 1], list[i].username);
    check(`and lands on the last row (${i})`, s.landing, s.names.length - 1);
    check(`the row it marks as the winner is that one (${i})`, s.names[s.landing], list[i].username);
  }
}

/* ── The offset is whole rows ────────────────────────────────────────── */
{
  const s = Reel.strip(people('alice', 'bob'), 1, { rng: seeded(7) });
  check('the offset is the landing row, in pixels', s.offset, -s.landing * Reel.ROW_H);
  check('and travels upward', s.offset < 0, true);
  check('a whole number of rows', s.offset % Reel.ROW_H, -0);
}

/* ── Length ──────────────────────────────────────────────────────────── */
{
  const s = Reel.strip(people('alice', 'bob', 'carol'), 0, { rng: seeded(3) });
  check('28 names flick past before the winner', s.names.length, Reel.SPIN_ROWS + 1);

  const short = Reel.strip(people('alice', 'bob'), 0, { rows: 3, rng: seeded(3) });
  check('the row count is adjustable', short.names.length, 4);

  /* Zero rows is a jump cut, not a crash — the winner alone. */
  const none = Reel.strip(people('alice', 'bob'), 1, { rows: 0 });
  check('no spin rows still yields the winner', none.names, ['bob']);
  check('with nowhere to travel', none.offset, -0);
}

/* ── Every name on the reel is a real entrant ────────────────────────── */
{
  const list = people('alice', 'bob', 'carol', 'dave', 'erin');
  const valid = new Set(list.map(e => e.username));
  for (let seed = 1; seed <= 40; seed++) {
    const s = Reel.strip(list, seed % list.length, { rng: seeded(seed) });
    const strangers = s.names.filter(n => !valid.has(n));
    if (strangers.length) { failures.push(`seed ${seed} put non-entrants on the reel: ${strangers}`); break; }
  }
  passed++;
}

/* ── No double name at the stop ──────────────────────────────────────── */
{
  /* The reel decelerates hard into the last row. The same name twice there
     reads as "it stopped a row early and jumped", which on a stream is
     indistinguishable from a rigged draw being corrected. */
  const list = people('alice', 'bob', 'carol');
  let doubled = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const s = Reel.strip(list, seed % list.length, { rng: seeded(seed) });
    if (s.names[s.landing - 1] === s.names[s.landing]) doubled++;
  }
  check('the winner never appears in the row before the stop', doubled, 0);
}

/* ── One entrant ─────────────────────────────────────────────────────── */
{
  /* A draw with a single entrant is normal on a quiet night, and the
     de-duplication rule above must not try to find a different name and
     fail. */
  const s = Reel.strip(people('alice'), 0, { rows: 5 });
  check('a single entrant fills the reel', s.names, ['alice', 'alice', 'alice', 'alice', 'alice', 'alice']);
  check('and still stops on them', s.names[s.landing], 'alice');
}

/* ── Nothing to spin ─────────────────────────────────────────────────── */
{
  check('an empty draw yields an empty reel', Reel.strip([], 0), { names: [], landing: 0, offset: 0 });
  check('a null entrant list too', Reel.strip(null, 0), { names: [], landing: 0, offset: 0 });
  /* The panel and the server disagreeing about the index must not put a
     stranger's name up as the winner — it puts nobody up. */
  check('an out-of-range winner yields nothing', Reel.strip(people('alice'), 4), { names: [], landing: 0, offset: 0 });
  check('a negative index too', Reel.strip(people('alice'), -1), { names: [], landing: 0, offset: 0 });
}

/* ── The panel actually uses it ──────────────────────────────────────── */
{
  const panel = fs.readFileSync(path.join(REPO, 'js/pages/bot-control.js'), 'utf8');
  ok('the panel calls the shared strip', /window\.PhamReel\.strip\(/.test(panel));
  /* The wheel is gone, not merely unused: a second renderer left behind is
     how a fixed bug comes back. */
  ok('no wheel renderer survives', !/renderGiveawayWheel|giveawaySegments/.test(panel));

  const html = fs.readFileSync(path.join(REPO, 'bot-control.html'), 'utf8');
  ok('the page loads the reel module', /src="\/js\/giveaway-reel\.js"/.test(html));
  /* Order matters: bot-control.js reads window.PhamReel. */
  ok('before the panel script', html.indexOf('/js/giveaway-reel.js') < html.indexOf('/js/pages/bot-control.js'));
  ok('and the strip element exists', /id="giveawayReelStrip"/.test(html));
  ok('the wheel markup is gone', !/giveaway-wheel/.test(html));
}

/* ── The on-stream OVERLAY alert uses it too — and animates correctly ──────
   The overlay's reel card is built DETACHED (render() appends it only after
   buildReelCard returns), so it must defer its reflow-and-transform until
   the card is in the DOM. A single rAF (the pattern the attached panel uses)
   left the reel jumping straight to the winner with no spin on stream: the
   detached reflow was a no-op, so the browser coalesced the start and the
   travel into one step. The fix is a NESTED rAF — reflow once attached, then
   transform on the following frame. Guard that it stays nested. */
{
  const ov = fs.readFileSync(path.join(REPO, 'js/pages/overlay.js'), 'utf8');
  ok('the overlay renders the reel from the shared strip', /window\.PhamReel\.strip\(/.test(ov));
  ok('the overlay loads no separate wheel', !/renderGiveawayWheel|giveawaySegments/.test(ov));

  const card = /function buildReelCard[\s\S]*?\n  \}/.exec(ov);
  ok('buildReelCard exists', !!card);
  const body = card ? card[0] : '';
  /* Nested requestAnimationFrame: the animation is kicked off a frame after
     the card is attached, not synchronously while it is still detached. */
  ok('the reel animation is deferred with a nested rAF',
     /requestAnimationFrame\(function[\s\S]*?requestAnimationFrame\(function/.test(body));
  /* The transform target is set INSIDE the nested rAF, not before it. */
  ok('the travel transform is set inside the deferred callback',
     /requestAnimationFrame\(function[\s\S]*?requestAnimationFrame\(function[\s\S]*?transform = 'translateY\(' \+ plan\.offset/.test(body));

  const ovHtml = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay page loads the reel module', /src="\/js\/giveaway-reel\.js"/.test(ovHtml));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[giveaway-reel] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[giveaway-reel] ${passed} assertions passed.`);
console.log('');
