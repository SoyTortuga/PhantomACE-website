#!/usr/bin/env node
/* ══════════════════════════════════════════════
   THE SERVER'S ZONE TABLE AGREES WITH THE PALETTE

     node server/scripts/test-park-zones.js

   functions/api/park-zones.js is a hand-synced mirror of what each tile
   set means for walkability. The real table is park-tiles/palette.json,
   which lives in the gitignored pack-art tree and reaches the rig by
   manual copy — the server cannot import it, the same reason
   dino-species.js mirrors the client roster.

   A MIRROR THAT DRIFTS IS WORSE THAN NO MIRROR HERE, because the server
   now REFUSES a background whose mask disagrees with it. A set missing
   from the mirror resolves to X, so a member painting with it would be
   told their mask is wrong at a cell they painted correctly, with
   nothing on screen to explain it. That is the failure this guards.

   IT USED TO SKIP THE COMPARISON when palette.json was absent — which is
   a fresh clone, CI, and the rig straight after a pull, i.e. everywhere
   except a machine someone had hand-copied 1,294 PNGs to. The half of
   this suite that matters therefore almost never ran, and said so in a
   note that still exited zero.

   The zone metadata is committed now, at server/data/park-zone-manifest
   .json: set ids and walkability flags, no artwork and no filenames from
   the pack. The mirror is checked against THAT on every machine. Where
   the real palette is present it is checked too, so the committed copy
   cannot quietly go stale — regenerate it with
   server/scripts/sync-park-zones.js.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SET_ZONE, SET_KIND, zoneOfRef, isOverlaySet } from '../../functions/api/park-zones.js';
import { buildManifest, readManifest, readPalette } from './sync-park-zones.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PALETTE = path.join(REPO, 'games/dino-park/assets/dino-assets/park-tiles/palette.json');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── What the mirror promises on its own ─────────────────────────────── */
{
  const zones = Object.values(SET_ZONE);
  ok('every zone is one of the four the game reads',
     zones.every(z => ['L', 'R', 'O', 'X'].includes(z)));
  ok('every kind is one the picker groups by',
     Object.values(SET_KIND).every(k => ['ground', 'water', 'fence', 'decoration'].includes(k)));
  check('zones and kinds cover the same sets',
        Object.keys(SET_ZONE).sort(), Object.keys(SET_KIND).sort());

  /* An unknown set must be impassable, never guessed at. A background
     naming a set this build does not have is a background whose cells
     nothing should walk onto. */
  check('an unknown set is impassable', zoneOfRef('nosuchset/00'), 'X');
  check('so is a malformed ref', zoneOfRef(null), 'X');
  check('and a bare set name', zoneOfRef('jungle'), SET_ZONE.jungle || 'X');

  ok('fences are overlay', isOverlaySet('fencewood'));
  ok('decorations are overlay', isOverlaySet('decoreef'));
  ok('ground is not', !isOverlaySet('jungle'));

  /* The kinds have to be consistent with the zones they describe, or the
     picker and the mask disagree about the same set. */
  for (const [id, kind] of Object.entries(SET_KIND)) {
    const z = SET_ZONE[id];
    if (kind === 'ground') ok(`${id}: ground is land`, z === 'L' || z === 'R');
    if (kind === 'water') ok(`${id}: water is swimmable`, z === 'O' || z === 'R');
    if (kind === 'fence') ok(`${id}: a fence is impassable`, z === 'X');
  }
}

/* ── The mirror against the committed zone table — ALWAYS ────────────── */
{
  const manifest = readManifest();
  ok('the committed zone manifest is present', !!(manifest && manifest.sets));
  const real = manifest ? manifest.sets : {};
  ok('and has sets in it', Object.keys(real).length > 5);

  check('the mirror has every set the palette does',
        Object.keys(real).filter(id => !(id in SET_ZONE)), []);
  check('and no sets the palette does not',
        Object.keys(SET_ZONE).filter(id => !(id in real)), []);

  check('every zone matches',
        Object.keys(real).filter(id => SET_ZONE[id] !== real[id].zone), []);
  check('every kind matches',
        Object.keys(real).filter(id => SET_KIND[id] !== real[id].kind), []);
}

/* ── And the committed table against the real one, where it exists ───── */
{
  const pal = readPalette();
  if (!pal) {
    /* Not a skipped assertion: everything above already ran. This only
       checks the committed copy has not drifted from the pack art, which
       needs the pack art. */
    console.log('');
    console.log('[park-zones] palette.json is not on this machine (gitignored pack');
    console.log('             art). The mirror was still checked against the');
    console.log('             committed manifest; only its freshness is unverified.');
  } else {
    const built = buildManifest(pal);
    const committed = readManifest();
    check('the committed manifest matches the real palette',
          JSON.stringify(committed && committed.sets), JSON.stringify(built.sets));

    /* The thing the server actually does with it: resolve a real ref. */
    const sample = pal.sets[0];
    check('a real ref resolves to its set zone',
          zoneOfRef(sample.tiles[0].file.replace('.png', '')), sample.zone);
  }
}

console.log('');
if (failures.length) {
  console.log(`[park-zones] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[park-zones] ${passed} assertions passed.`);
console.log('');
