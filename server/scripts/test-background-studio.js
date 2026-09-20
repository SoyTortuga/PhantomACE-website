#!/usr/bin/env node
/* ══════════════════════════════════════════════
   BACKGROUND STUDIO — the painter and its contract with the API

     node server/scripts/test-background-studio.js

   The studio's one derivation is the mask, and the mask is the thing
   other players' dinos will obey. So the tests here are the handshake:
   what deriveMask produces from a painted map must be exactly what
   validateBackground accepts, with no third understanding in between.
   deriveMask is lifted from the page verbatim — testing a copy would let
   the two drift, which is the entire failure mode this file exists for.

   The palette is data with promises in it too: every tile file it names
   must exist, every zone must be a real zone, and the water set must
   actually be water — a palette that lies makes every derived mask lie
   with it, silently, on every background painted from it.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBackground, GRID } from '../../functions/api/park-backgrounds.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PAGE_JS = fs.readFileSync(path.join(REPO, 'js/pages/background-studio.js'), 'utf8').replace(/\r\n/g, '\n');
const PAGE_HTML = fs.readFileSync(path.join(REPO, 'background-studio.html'), 'utf8');
const CSS = fs.readFileSync(path.join(REPO, 'css/pages/background-studio.css'), 'utf8');
const TILES = path.join(REPO, 'games/dino-park/assets/dino-assets/park-tiles');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Lift the real deriveMask out of the page. */
const lifted = /function deriveMask\(map, zones\) \{[\s\S]*?\n  \}/.exec(PAGE_JS);
ok('deriveMask can be lifted from the page', !!lifted);
const deriveMask = new Function('GRID', `return ${lifted[0].replace(/^function deriveMask/, 'function')}`)(GRID);

const fill = (ref) => Array.from({ length: GRID }, () => Array(GRID).fill(ref));
const ZONES = { jungle: 'L', water: 'O', shallows: 'R' };

/* ── The derivation itself ───────────────────────────────────────────── */
{
  check('land tiles derive L', deriveMask(fill('jungle/03'), ZONES)[0][0], 'L');
  check('water tiles derive O', deriveMask(fill('water/00'), ZONES)[5], 'O'.repeat(GRID));
  check('river-zone sets derive R', deriveMask(fill('shallows/01'), ZONES)[0][0], 'R');
  check('an empty cell derives X', deriveMask(fill(null), ZONES)[0][0], 'X');
  check('an unknown set derives X, never a guess', deriveMask(fill('mystery/00'), ZONES)[0][0], 'X');

  const mixed = fill('jungle/00');
  for (let y = 20; y < GRID; y++) for (let x = 0; x < GRID; x++) mixed[y][x] = 'water/04';
  const mask = deriveMask(mixed, ZONES);
  check('a painted shoreline lands exactly where painted', [mask[19][0], mask[20][0]], ['L', 'O']);
}

/* ── The handshake: studio output is API input, verbatim ─────────────── */
{
  const map = fill('jungle/00');
  for (let y = 24; y < GRID; y++) for (let x = 0; x < GRID; x++) map[y][x] = 'water/07';
  const submission = { name: 'Round Trip', tilemap: map, mask: deriveMask(map, ZONES) };
  const out = validateBackground(submission);
  ok('a painted map validates as submitted', !out.error);
  check('with the mask unchanged', out.mask, submission.mask);

  /* The API's floor rule and the studio's derivation must agree on the
     degenerate case: all water derives all O, and all O is refused. */
  const drowned = validateBackground({ name: 'Sea', tilemap: fill('water/00'),
                                       mask: deriveMask(fill('water/00'), ZONES) });
  ok('an all-water painting is refused by the API', !!drowned.error);

  /* Unpainted cells derive X and X-heavy maps still validate — drafts of
     half-painted maps must be saveable, only walkability-free ones die. */
  const half = fill(null);
  half[0] = Array(GRID).fill('jungle/00');
  ok('a half-painted draft still validates', !validateBackground({
    name: 'WIP', tilemap: half, mask: deriveMask(half, ZONES) }).error);
}

/* ── The palette keeps its promises ──────────────────────────────────── */
{
  const palPath = path.join(TILES, 'palette.json');
  ok('palette.json exists', fs.existsSync(palPath));
  if (fs.existsSync(palPath)) {
    const pal = JSON.parse(fs.readFileSync(palPath, 'utf8'));
    ok('the palette has a healthy number of sets', pal.sets.length >= 10);

    const badZone = pal.sets.filter(s => !['L', 'R', 'O', 'X'].includes(s.zone)).map(s => s.id);
    check('every set zone is a real zone', badZone, []);

    ok('there is at least one water-zone set', pal.sets.some(s => s.zone === 'O'));
    ok('and land is the majority, so maps can be walkable',
       pal.sets.filter(s => s.zone === 'L').length > pal.sets.length / 2);

    const missing = [];
    for (const s of pal.sets) {
      for (const t of s.tiles) {
        if (!fs.existsSync(path.join(TILES, t.file))) missing.push(t.file);
      }
    }
    check('every tile the palette names exists on disk', missing.slice(0, 5), []);

    /* Refs the studio writes must satisfy the API's charset: set ids stay
       within [a-z0-9] and per-set tile counts stay two digits. */
    const badIds = pal.sets.filter(s => !/^[a-z0-9]{1,20}$/.test(s.id)).map(s => s.id);
    check('every set id fits the ref charset', badIds, []);
    const tooMany = pal.sets.filter(s => s.tiles.length > 100).map(s => s.id);
    check('no set outgrows two-digit refs', tooMany, []);
  }
}

/* ── The page wiring ─────────────────────────────────────────────────── */
{
  ok('the page loads the studio script', /js\/pages\/background-studio\.js/.test(PAGE_HTML));
  ok('and its stylesheet', /css\/pages\/background-studio\.css/.test(PAGE_HTML));
  ok('gating rides on the drafts probe, not a duplicated mod list',
     /API \+ '\?drafts=1'/.test(PAGE_JS));
  ok('the random brush exists — texture needs variety', /RANDOM from set/.test(PAGE_JS));
  ok('publish warns about unpainted cells', /unpainted cells[\s\S]{0,80}Publish anyway/.test(PAGE_JS));
  /* Comments stripped first — the header states the rule in the words the
     regex would flag, which is the third time this session that a check on
     raw source has arrested its own documentation. */
  const cssCode = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('no box-shadow, per the permanent rule', !/box-shadow/.test(cssCode));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[background-studio] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[background-studio] ${passed} assertions passed.`);
console.log('');

/* NOTE: appended by phase 4. Kept in this file because the wiring under
   test is the studio's output being CONSUMED — the game and visit view
   composing what the painter produced. */
{
  const GAME = fs.readFileSync(path.join(REPO, 'games/dino-park/index.html'), 'utf8').replace(/\r\n/g, '\n');

  ok('the game fetches the catalogue', /fetch\('\/api\/park-backgrounds', \{ cache: 'no-store' \}\)/.test(GAME));
  ok('at park boot', /function initParkView\(\) \{\n  loadBackgroundCatalog\(\);/.test(GAME));
  ok('the ground cache composes studio tilemaps',
     /if \(entry\.tilemap\) \{[\s\S]{0,400}composeTilemap\(entry, TSIZE/.test(GAME));
  ok('late tiles invalidate the cache, not the world',
     /composeTilemap\(entry, TSIZE, \(\) => \{ groundCache = null; renderTileCanvas\(\); \}\)/.test(GAME));
  ok('the scenery picker lists both kinds',
     /Object\.entries\(PARK_BACKGROUNDS\)\n?\s*\.concat\(Object\.entries\(studioBackgrounds \|\| \{\}\)\)/.test(GAME));
  ok('picker names are escaped', /scenery-btn[\s\S]{0,200}\$\{escapeHtml\(e\.name\)\}/.test(GAME));
  ok('the selection gate admits studio ids',
     /const known = PARK_BACKGROUNDS\[id\] \|\| \(studioBackgrounds && studioBackgrounds\[id\]\);/.test(GAME));
  ok('tile refs resolve inside the palette tree only',
     /img\.src = AB \+ 'park-tiles\/' \+ parts\[0\] \+ '\/' \+ parts\[1\] \+ '\.png';/.test(GAME));

  console.log('');
  if (failures.length) {
    console.log(`[background-studio] ${passed} passed, ${failures.length} FAILED (phase 4 block)`);
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exit(1);
  }
  console.log(`[background-studio] phase-4 wiring: all ${passed} assertions passed.`);
}
