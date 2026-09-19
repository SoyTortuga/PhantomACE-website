#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PHAMSHOCK WEAPONS — the two tables must agree

     node server/scripts/test-phamshock-weapons.js

   The weapon table is written twice. functions/api/pham-shock.js is the
   authority: it flies every shell, digs the terrain, scores the damage and
   records what happened. games/phamshock/index.html carries a copy with a
   name and a colour added, and RE-SIMULATES each shot with the same physics
   so it can animate the round.

   So a disagreement does not throw. It draws a different battle from the
   one that was scored — a shell landing somewhere it did not, a crater the
   wrong size, a cluster bomb splitting at the wrong height — while the
   scoreboard shows the server's answer. Players would see the game cheat.

   Mechanics live here too, and each one is a chance for the halves to drift
   apart on its own:

     splitter/subs  how many sub-shells on impact
     airburst       how many steps before it breaks up in the air
     digs           how many extra craters straight down after the first

   The physics constants are checked as well, because the client's
   re-simulation is only faithful while gravity, wind and the step count
   match the server's.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CLIENT = path.join(REPO, 'games', 'phamshock', 'index.html');
const SERVER = path.join(REPO, 'functions', 'api', 'pham-shock.js');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const clientSrc = fs.readFileSync(CLIENT, 'utf8');
const serverSrc = fs.readFileSync(SERVER, 'utf8');

/** The literal table out of a file, evaluated rather than parsed by hand. */
function weapons(src, what) {
  const m = src.match(/const WEAPONS\s*=\s*\[[\s\S]*?\n\];/);
  if (!m) throw new Error(`no WEAPONS table in ${what}`);
  // eslint-disable-next-line no-eval
  return eval(m[0].replace(/^const WEAPONS\s*=\s*/, ''));
}

const cli = weapons(clientSrc, 'the client');
const srv = weapons(serverSrc, 'the server');

/* ── Same weapons, same order ────────────────────────────────────────── */
{
  check('both tables hold the same number of weapons', cli.length, srv.length);
  ok('and there are ten of them', cli.length === 10);

  /* ORDER IS THE IDENTITY. A shot is submitted as an index, so inserting a
     weapon anywhere but the end renumbers every one after it -- and an
     in-flight submission, or a room mid-match, would fire the wrong gun. */
  ok('every weapon has a name for its button', cli.every(w => typeof w.name === 'string' && w.name));
  ok('and a colour to draw its shell', cli.every(w => /^#[0-9a-f]{6}$/i.test(w.color || '')));
}

/* ── The shared fields ───────────────────────────────────────────────── */
{
  /* Infinite ammo is written two ways: the client uses Infinity so its
     button hides the counter, the server uses 999 because JSON has no
     Infinity and the room document round-trips through it. */
  const norm = (w) => ({
    radius: w.radius,
    damage: w.damage,
    ammo: (w.ammo === Infinity || w.ammo >= 999) ? 'unlimited' : w.ammo,
    splitter: !!w.splitter,
    subs: w.subs || null,
    airburst: w.airburst || null,
    digs: w.digs || null,
  });

  const drift = [];
  for (let i = 0; i < Math.max(cli.length, srv.length); i++) {
    const a = norm(cli[i] || {}), b = norm(srv[i] || {});
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      drift.push(`[${i}] ${(cli[i] || {}).name || '?'}: client ${JSON.stringify(a)} server ${JSON.stringify(b)}`);
    }
  }
  check('every weapon agrees field for field', drift, []);
}

/* ── The mechanics are coherent ──────────────────────────────────────── */
{
  /* A sub-shell count on something that does not split does nothing, and
     an airburst that does not split is a shell that vanishes in mid-air. */
  const orphanSubs = srv.filter((w, i) => w.subs && !w.splitter).map((w, i) => i);
  check('nothing carries a sub-shell count without splitting', orphanSubs, []);
  const burstNoSplit = srv.map((w, i) => ({ w, i })).filter(x => x.w.airburst && !x.w.splitter).map(x => x.i);
  check('and nothing bursts in the air without splitting', burstNoSplit, []);

  /* A fuse has to be long enough to clear the barrel and short enough to
     go off before a normal shot would land. */
  for (const w of srv.filter(x => x.airburst)) {
    ok(`an airburst fuse of ${w.airburst} is a sane flight length`, w.airburst > 5 && w.airburst < 200);
  }
  for (const w of srv.filter(x => x.digs)) {
    ok(`a shaft of ${w.digs} craters is bounded`, w.digs > 0 && w.digs <= 8);
  }

  /* Unlimited ammo is the fallback weapon and there must be exactly one,
     or a player can run dry with no way to take a turn. */
  const unlimited = srv.filter(w => w.ammo >= 999).length;
  check('exactly one weapon never runs out', unlimited, 1);
  check('and it is the first, which is the default selection', srv[0].ammo >= 999, true);
}

/* ── Both halves implement both new mechanics ────────────────────────── */
{
  /* The table can agree perfectly while only one side acts on a flag,
     which looks like the weapon quietly not working. */
  ok('the server gives an airburst a fuse', /simShot\([^)]*w\.airburst\)/.test(serverSrc));
  ok('and does not crater where it bursts', /if \(!hit\.burst\) \{/.test(serverSrc));
  ok('the client breaks the shell up in flight', /wf\.airburst && !p\.isSplit && p\.steps >= wf\.airburst/.test(clientSrc));

  ok('the server digs the shaft', /d <= \(w\.digs \|\| 0\)/.test(serverSrc));
  ok('and the client draws it', /d <= \(w\.digs \|\| 0\)/.test(clientSrc));

  ok('the sub-shell count is read, not hardcoded at four',
     /j < \(w\.subs \|\| 4\)/.test(serverSrc));
}

/* ── The physics the client re-simulates with ────────────────────────── */
{
  /* The client flies its own copy of every shell. These numbers are what
     make that copy land where the server said it did.

     EVERY step, not the first one found. The client integrates in more
     than one place — a helper and the animation loop — and an earlier
     version of this read whichever matched first, so changing the loop
     that actually draws the shells passed happily. Projectile physics is
     picked out by the wind term: a shell is pushed by wind, and the
     cosmetic particles, which use a different gravity on purpose, are not. */
  const steps = (src) =>
    [...src.matchAll(/vy \+= (0\.\d+);[\s\S]{0,40}?wind \* (0\.\d+)/g)]
      .map(m => `${m[1]}/${m[2]}`);

  const srvSteps = steps(serverSrc), cliSteps = steps(clientSrc);
  ok('the server integrates a shell somewhere', srvSteps.length >= 1);
  ok('and so does the client', cliSteps.length >= 1);
  check('every shell the client flies uses the server\'s gravity and wind',
        [...new Set(cliSteps)].sort(), [...new Set(srvSteps)].sort());

  /* The client calls them GW/GH and the server GAME_W/GAME_H — the same
     arena under two names, which is itself a reason to check the numbers. */
  const dims = (src) => [
    (src.match(/\bG(?:AME_)?W\s*=\s*(\d+)/) || [])[1],
    (src.match(/\bG(?:AME_)?H\s*=\s*(\d+)/) || [])[1],
  ];
  check('the arena is the same size on both sides', dims(clientSrc), dims(serverSrc));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[phamshock-weapons] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[phamshock-weapons] ${passed} assertions passed.`);
console.log('');
