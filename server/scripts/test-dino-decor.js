#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO PARK — the decoration catalogue

     node server/scripts/test-dino-decor.js

   A DECORATION IS A FILENAME AND A PROMISE. The table names an image, a
   price, a zone and a band, and every one of those is a thing that can be
   wrong in a way nothing notices: a src that does not exist renders as a
   broken icon in the tray and is only discovered when somebody spends
   coins on it; a band nobody renders hides the item entirely; a duplicate
   id makes getYardType return the wrong entry for every lookup.

   So the files are checked against the asset tree on disk rather than
   eyeballed, which is the same rule the walkability mask follows — see
   _private/GAME-DEV-PRACTICES.md point 1, the data comes from the asset.

   The balance question is settled separately and deliberately: mood feeds
   getYardMoodBonus, which is sqrt-damped and capped, so a bigger
   catalogue cannot trivialise the care loop however it is stacked. That
   cap is asserted here so it cannot be raised without this failing.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const GAME = path.join(REPO, 'games/dino-park');
const src = fs.readFileSync(path.join(GAME, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* The tables, evaluated rather than parsed by hand. */
function lift(name) {
  const m = new RegExp(`const ${name} = \\[[\\s\\S]*?\\n\\];`).exec(src);
  if (!m) throw new Error(`no ${name} in the page`);
  return m[0];
}
const AB = 'assets/dino-assets/';
const IC = AB + 'jurassic-dino-320/icons/';
const { ITEMS, BANDS, MAX_ITEMS } = new Function('IC', 'AB', `
  ${lift('YARD_ITEM_TYPES')}
  ${lift('YARD_BANDS')}
  ${/const MAX_YARD_ITEMS = \d+;/.exec(src)[0]}
  return { ITEMS: YARD_ITEM_TYPES, BANDS: YARD_BANDS, MAX_ITEMS: MAX_YARD_ITEMS };
`)(IC, AB);

/* ── Every image is really there ─────────────────────────────────────── */
{
  /* THE FAILURE THIS EXISTS FOR. A wrong path costs nothing at load: the
     tray shows a broken icon among thirty-two good ones, and the first
     person to notice is whoever paid for it. */
  const missing = ITEMS
    .filter(t => !fs.existsSync(path.join(GAME, t.src)))
    .map(t => `${t.id} -> ${t.src}`);
  check('every decoration image exists on disk', missing, []);
}

/* ── The table is coherent ───────────────────────────────────────────── */
{
  const ids = ITEMS.map(t => t.id);
  check('no duplicate ids', ids.filter((v, i) => ids.indexOf(v) !== i), []);
  ok('the catalogue actually grew', ITEMS.length >= 30);

  const bad = ITEMS.filter(t =>
    !t.name || typeof t.cost !== 'number' || t.cost <= 0 ||
    typeof t.mood !== 'number' || t.mood <= 0 ||
    typeof t.size !== 'number' || t.size <= 0 ||
    typeof t.blocks !== 'boolean' || typeof t.radius !== 'number'
  ).map(t => t.id);
  check('every item is fully specified', bad, []);

  /* A blocker with no radius blocks nothing; a radius on a non-blocker is
     a number that does not do anything, which reads as a bug later. */
  check('blockers all have a radius', ITEMS.filter(t => t.blocks && !(t.radius > 0)).map(t => t.id), []);
  check('and non-blockers have none', ITEMS.filter(t => !t.blocks && t.radius !== 0).map(t => t.id), []);

  /* Price should track what it does, or the tray has obvious traps. */
  const overpriced = ITEMS.filter(t => {
    const cheaper = ITEMS.filter(o => o.cost < t.cost);
    return cheaper.some(o => o.mood > t.mood);
  }).map(t => `${t.id} (${t.cost}c, mood ${t.mood})`);
  check('nothing costs more than a strictly better item', overpriced, []);
}

/* ── Bands: every item is reachable in the tray ───────────────────────── */
{
  /* An item whose band nothing renders is invisible -- bought by nobody,
     and indistinguishable from having never been added. */
  const known = new Set(BANDS.map(b => b.id));
  check('every item is in a rendered band',
        ITEMS.filter(t => !known.has(t.band)).map(t => `${t.id} -> ${t.band}`), []);
  check('every band has at least one item',
        BANDS.filter(b => !ITEMS.some(t => t.band === b.id)).map(b => b.id), []);
  ok('the tray renders by band', /YARD_BANDS\.map\(b => \{/.test(src));
  ok('and the layout wraps rather than scrolling sideways forever',
     /\.yard-tray-items \{ max-height: [^;]+; overflow-y: auto;/.test(src));

  /* The tray must never sit ON the park. It shipped as an overlay pinned
     to the viewport's bottom edge, which made the lowest rows of the
     world impossible to decorate — the menu covered exactly the ground it
     was for. It lives beside the park now, as a sibling in the stage
     flex, and this pins both halves of that: no absolute positioning on
     the tray, and the tray element outside the viewport element. */
  ok('the tray is not an overlay', !/\.yard-tray \{[^}]*position: absolute/.test(src));
  const viewport = /<div class="park-viewport"[\s\S]*?<div class="park-panel" id="parkPanel"><\/div>\s*<\/div>/.exec(src);
  ok('and lives outside the viewport', !!viewport && !viewport[0].includes('id="yardTray"'));
}

/* ── Water decorations actually go in water ──────────────────────────── */
{
  const water = ITEMS.filter(t => t.zone === 'water');
  ok('there are water decorations', water.length >= 1);
  ok('none of them block pathing', water.every(t => !t.blocks));
  check('land is the default, written nowhere',
        ITEMS.filter(t => t.zone === 'land').map(t => t.id), []);

  /* The zone has to be consulted, or a lily pad places on grass. */
  ok('the zone test is derived from the item', /function yardZoneTest\(t\) \{/.test(src));
  ok('placement uses it', /if \(!yardZoneTest\(t\)\(x, y\)\)/.test(src));
  ok('and says which mistake was made',
     /t\.zone === 'water' \? 'Place that in the water\.'/.test(src));

  /* And a background change must re-place each item by ITS zone, or the
     first swap drags every lily pad onto the grass. */
  ok('re-placement respects the zone',
     /const ok = yardZoneTest\(getYardType\(it\.type\)\);/.test(src));
}

/* ── A bigger catalogue cannot trivialise care ───────────────────────── */
{
  /* getYardMoodBonus is sqrt-damped and hard-capped. The cap is what makes
     adding items safe, so it is asserted rather than assumed. */
  const m = /return Math\.min\(([\d.]+), Math\.sqrt\(raw\) \* ([\d.]+)\);/.exec(src);
  ok('the mood bonus is still capped', !!m);
  if (m) {
    const cap = Number(m[1]), rate = Number(m[2]);
    check('the cap is unchanged', cap, 0.5);

    /* A full yard of the most moodful items must not exceed it -- which it
       cannot, but the point is that the ceiling binds well before the
       catalogue matters, so pricing changes are a balance question rather
       than a correctness one. */
    const best = [...ITEMS].sort((a, b) => b.mood - a.mood).slice(0, MAX_ITEMS);
    const raw = best.reduce((s, t) => s + t.mood, 0);
    ok(`the best possible yard (${raw} mood) still hits the cap`, Math.sqrt(raw) * rate >= cap);
  }

  ok('the yard cap grew with the catalogue', MAX_ITEMS >= 20);
  ok('but is still a real constraint', MAX_ITEMS < ITEMS.length);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[dino-decor] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[dino-decor] ${passed} assertions passed — ${ITEMS.length} decorations across ${BANDS.length} bands.`);
console.log('');
