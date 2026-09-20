#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO PARK — per-dino levelling

     node server/scripts/test-dino-levels.js

   THE BUG THIS REPLACES. Every collection card rendered `Lv ${getLevel()}`
   — the PARK level, a no-argument global computed from everyone's care
   total. So every dino in the roster printed the same number, and on an
   established save that number was 14. The card slot was right; the
   function was the wrong one entirely.

   XP IS ITS OWN POOL, not a second reading of careCount, which already
   drives the growth stage and the PWR/GRD/SPD figures. The hazard in a
   fresh pool is the same one in a different coat: XP awarded for a
   park-wide event moves every dino by the same amount, and a roster that
   levels in lockstep is indistinguishable from the bug. So the assertions
   below care as much about dinos levelling APART as about the arithmetic.

   The functions are read out of the page and evaluated, because they live
   in an inline <script> in a single-file game. That keeps the numbers under
   test as the ones that ship.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PAGE = path.join(REPO, 'games/dino-park/index.html');
/* Newlines normalised: the working copy is CRLF, so anchors like `;\n`
   silently match nothing and every lift below fails at once. */
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/** Lift a top-level declaration out of the page by name. */
function lift(name, kind = 'function') {
  const re = kind === 'function'
    ? new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}`)
    : new RegExp(`\\nconst ${name} = [\\s\\S]*?;\\n`);
  const m = re.exec(src);
  if (!m) throw new Error(`could not find ${kind} ${name} in the page`);
  return m[0];
}

const sandbox = [
  lift('GROWTH_THRESHOLDS', 'const'),
  lift('DINO_XP', 'const'),
  lift('XP_PER_LEVEL', 'const'),
  lift('xpForLevel'), lift('getDinoXp'), lift('getDinoLevel'),
  lift('getDinoLevelProgress'), lift('awardDinoXp'), lift('ensureDinoStats'),
].join('\n');

const api = new Function(sandbox + `
  return { GROWTH_THRESHOLDS, DINO_XP, XP_PER_LEVEL, xpForLevel, getDinoXp,
           getDinoLevel, getDinoLevelProgress, awardDinoXp, ensureDinoStats };
`)();

const { DINO_XP, XP_PER_LEVEL, xpForLevel, getDinoLevel, getDinoXp,
        getDinoLevelProgress, awardDinoXp, ensureDinoStats, GROWTH_THRESHOLDS } = api;

const dino = (over = {}) => ({ speciesId: 'rex', careCount: 0, xp: 0, ...over });

/* ── The card shows THIS dino, not the park ──────────────────────────── */
{
  /* The regression in one assertion: the template must pass the dino. */
  ok('the collection card asks for a per-dino level',
     /coll-card-level">Lv \$\{getDinoLevel\(d\)\}/.test(src));
  ok('and getLevel is no longer used for a card',
     !/coll-card-level">Lv \$\{getLevel\(\)\}/.test(src));

  /* And two differently-raised dinos must actually differ. */
  const a = dino({ xp: 0 }), b = dino({ xp: 5000 });
  ok('two dinos can hold different levels', getDinoLevel(a) !== getDinoLevel(b));
}

/* ── The curve and its inverse agree ─────────────────────────────────── */
{
  /* xpForLevel is the only place the curve is written twice. If they drift,
     the bar fills against a boundary the level never crosses. */
  const drift = [];
  for (let lv = 1; lv <= 40; lv++) {
    const at = xpForLevel(lv);
    if (getDinoLevel({ xp: at }) !== lv) drift.push(`level ${lv}: xpForLevel=${at} reads back as ${getDinoLevel({ xp: at })}`);
    if (at > 0 && getDinoLevel({ xp: at - 1 }) !== lv - 1) drift.push(`level ${lv}: one XP short is not level ${lv - 1}`);
  }
  check('every level boundary round-trips', drift, []);

  check('a new dino is level 1', getDinoLevel(dino()), 1);
  check('level 1 costs nothing', xpForLevel(1), 0);
  ok('the curve gets steeper', (xpForLevel(11) - xpForLevel(10)) > (xpForLevel(3) - xpForLevel(2)));
  ok('and never caps', getDinoLevel({ xp: 10_000_000 }) > 100);
}

/* ── Progress stays inside the bar ───────────────────────────────────── */
{
  const bad = [];
  for (let xp = 0; xp < 20_000; xp += 37) {
    const p = getDinoLevelProgress({ xp });
    if (!(p >= 0 && p <= 1)) bad.push(`xp ${xp} → ${p}`);
  }
  check('progress is always 0..1', bad, []);
  check('exactly on a boundary the bar is empty', getDinoLevelProgress({ xp: xpForLevel(5) }), 0);
}

/* ── Awarding ────────────────────────────────────────────────────────── */
{
  const d = dino();
  check('a small award does not level', awardDinoXp(d, 10), null);
  check('but it is banked', getDinoXp(d), 10);

  const e = dino();
  check('crossing a boundary reports the new level', awardDinoXp(e, xpForLevel(4)), 4);
  check('and reports nothing on the next small award', awardDinoXp(e, 1), null);

  /* Garbage must not corrupt the pool — d.xp feeds a sqrt and then the UI. */
  const f = dino({ xp: 500 });
  for (const junk of [0, -50, NaN, undefined, null, 'lots']) awardDinoXp(f, junk);
  check('junk awards change nothing', getDinoXp(f), 500);
  ok('and the level is still a number', Number.isFinite(getDinoLevel(f)));

  check('a null dino is survivable', awardDinoXp(null, 100), null);
}

/* ── The backfill: nobody who already put the hours in gets reset ────── */
{
  /* THE POINT. A roster raised before levelling has careCount and no xp.
     Starting them at zero would show a wall of level 1s — the same insult
     as the bug being fixed, pointing the other way. */
  const veteran = { speciesId: 'rex', careCount: 200 };
  ensureDinoStats(veteran);
  check('a 200-care dino is backfilled', veteran.xp,
        200 * DINO_XP.care + DINO_XP.stageJuvenile + DINO_XP.stageAdult);
  ok('and lands well above level 1', getDinoLevel(veteran) > 5);

  const hatchling = { speciesId: 'rex', careCount: 3 };
  ensureDinoStats(hatchling);
  check('a barely-cared dino gets no stage bonuses', hatchling.xp, 3 * DINO_XP.care);

  const juvie = { speciesId: 'rex', careCount: GROWTH_THRESHOLDS.juvenile };
  ensureDinoStats(juvie);
  check('the juvenile bonus lands exactly on the threshold',
        juvie.xp, GROWTH_THRESHOLDS.juvenile * DINO_XP.care + DINO_XP.stageJuvenile);

  /* IDEMPOTENT. ensureDinoStats runs on every load and on several other
     paths; re-backfilling would inflate a roster a little more each time
     the page was opened. */
  const twice = { speciesId: 'rex', careCount: 50 };
  ensureDinoStats(twice); const first = twice.xp;
  ensureDinoStats(twice); ensureDinoStats(twice);
  check('backfill runs once, not on every load', twice.xp, first);

  /* A dino legitimately at 0 must not be re-backfilled either — which is
     why the guard is `=== undefined` and not `!d.xp`. */
  const zeroed = { speciesId: 'rex', careCount: 90, xp: 0 };
  ensureDinoStats(zeroed);
  check('a real zero is left alone', zeroed.xp, 0);
}

/* ── Dinos must level APART, or nothing has been fixed ───────────────── */
{
  /* Passive park XP is paid to everyone, so it is deliberately the
     smallest source. Care is the largest, and care is per-dino. A loved
     dino and a neglected one sharing a park must not converge. */
  const loved = dino(), ignored = dino();
  for (let hour = 0; hour < 12; hour++) {
    awardDinoXp(loved, DINO_XP.parkHour);
    awardDinoXp(ignored, DINO_XP.parkHour);
    for (let i = 0; i < 5; i++) awardDinoXp(loved, DINO_XP.care);   /* 5 care types */
  }
  ok('care outpaces mere presence', getDinoXp(loved) > getDinoXp(ignored) * 5);
  ok('and they are different levels', getDinoLevel(loved) > getDinoLevel(ignored));

  /* The one park-wide source must not be able to dominate the per-dino
     ones, or the roster converges over a long enough stream. */
  ok('presence alone is a slow climb', getDinoLevel(ignored) < 4);
}

/* ── XP survives the marketplace ─────────────────────────────────────── */
{
  /* The listing object IS the dino once it is sold: marketplace.js
     whitelists fields, so anything missing there is gone. A levelled dino
     arriving as level 1 reads as data loss, not a missing field. */
  const mkt = fs.readFileSync(path.join(REPO, 'functions/api/marketplace.js'), 'utf8');
  ok('the server keeps xp on a listing', /dino: \{[^}]*\bxp:/.test(mkt));
  ok('and sanitises it to a non-negative integer',
     /xp: Math\.max\(0, Math\.floor\(Number\(body\.dino\.xp\) \|\| 0\)\)/.test(mkt));

  ok('the client sends xp when listing', /action: 'list'[\s\S]{0,200}xp: getDinoXp\(dino\)/.test(src));
  check('and restores it on both buy paths',
        (src.match(/xp: data\.dino\.xp \|\| 0,/g) || []).length, 2);
}

/* ── Wiring: every source is actually connected ──────────────────────── */
{
  ok('care awards XP', /awardDinoXp\(dino, DINO_XP\.care\)/.test(src));
  ok('growing up awards XP', /DINO_XP\.stageJuvenile : DINO_XP\.stageAdult/.test(src));
  ok('park presence awards XP', /awardDinoXp\(d, DINO_XP\.parkHour \* xpHours\)/.test(src));
  ok('the daily dig awards XP', /awardDinoXp\(helper, DINO_XP\.dig\)/.test(src));

  /* Paid by the whole hour off its own accumulator, so the remainder
     banks and an hour can never be paid twice. */
  ok('passive XP uses whole live hours', /Math\.floor\(\(\(state\.liveSecAccum \|\| 0\) - \(state\.lastXpLiveSec \|\| 0\)\) \/ 3600\)/.test(src));
  ok('and advances its own clock by what it paid',
     /state\.lastXpLiveSec = \(state\.lastXpLiveSec \|\| 0\) \+ xpHours \* 3600/.test(src));

  /* Vault dinos earn nothing, but must still be backfilled or a stored
     roster comes back at level 1. */
  ok('the vault is backfilled too', /\(state\.vault \|\| \[\]\)\.forEach\(ensureDinoStats\)/.test(src));
  ok('but the passive award only touches the park',
     /state\.park\.forEach\(d => \{ ensureDinoStats\(d\); awardDinoXp\(d, DINO_XP\.parkHour/.test(src));

  ok('new dinos start with an explicit zero', (src.match(/xp: 0 \}/g) || []).length >= 2);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[dino-levels] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[dino-levels] ${passed} assertions passed.`);
console.log('');
