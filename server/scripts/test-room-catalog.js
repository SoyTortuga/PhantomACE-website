#!/usr/bin/env node
/* ══════════════════════════════════════════════
   ROOM CATALOG — test suite

     node server/scripts/test-room-catalog.js

   assets/room/catalog.json is the list of every piece a room may contain,
   and the validator will refuse anything not in it. So the catalog has to
   be right in the ways a machine can check: every entry has a file, every
   file has an entry, sizes are sane, floor and wall tiles are exactly the
   cell size, ids are unique and positional, every category has a layer
   and a tier. Whether a piece is one thing or two is the human review's
   job — see tools/build-room-atlas.py.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CATALOG = path.join(ROOT, 'assets/room/catalog.json');
const PIECES = path.join(ROOT, 'assets/room/pieces');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond, note) => check(label + (note ? ` (${note})` : ''), !!cond, true);

/** PNG dimensions from the IHDR chunk, no image library needed. */
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(12) !== 0x49484452) return null;       // 'IHDR'
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

/* ── Shape ───────────────────────────────────────────────────────────── */
{
  check('catalog version', cat.v, 1);
  check('cell size', cat.cell, 128);
  ok('at least one pack', Object.keys(cat.packs || {}).length >= 1);
  ok('twenty categories', Object.keys(cat.categories || {}).length === 20);
  for (const [name, c] of Object.entries(cat.categories)) {
    ok(`category ${name} has a layer`, ['floor', 'wall', 'rug', 'prop'].includes(c.layer), c.layer);
    ok(`category ${name} has a tier`, ['basic', 'unlock'].includes(c.tier), c.tier);
  }
  ok('floor is a basic category', cat.categories.floor && cat.categories.floor.tier === 'basic');
  ok('wall is a basic category', cat.categories.wall && cat.categories.wall.tier === 'basic');
}

/* ── Pieces ──────────────────────────────────────────────────────────── */
{
  const pieces = cat.pieces || [];
  ok('a few hundred pieces', pieces.length > 500 && pieces.length < 1000, pieces.length);
  const ids = new Set();
  let dup = 0, badId = 0, badCat = 0, missingFile = 0, badSize = 0, wrongDim = 0, tooBig = 0, tooSmall = 0;
  for (const p of pieces) {
    if (ids.has(p.id)) dup++;
    ids.add(p.id);
    if (!/^[a-z-]+-r[0-9]+c[0-9]+$/.test(p.id)) badId++;
    if (!cat.categories[p.category] || !p.id.startsWith(p.category + '-r')) badCat++;
    if (p.pack !== 'gaming-room') badCat++;
    const file = path.join(PIECES, p.category, p.id + '.png');
    if (!fs.existsSync(file)) { missingFile++; continue; }
    const s = pngSize(file);
    if (!s || s.w !== p.w || s.h !== p.h) wrongDim++;
    if (p.layer === 'floor' && (p.w !== 128 || p.h !== 128)) badSize++;
    if (p.layer === 'wall' && (p.w !== 128 || p.h !== 176)) badSize++;
    if (p.w > 400 || p.h > 400) tooBig++;
    if (p.w < 24 || p.h < 24) tooSmall++;
  }
  check('no duplicate ids', dup, 0);
  check('every id is category-r<row>c<col>', badId, 0);
  check('every piece names a known category, its own, and the pack', badCat, 0);
  check('every piece has its file', missingFile, 0);
  check('every file is the size the catalog says', wrongDim, 0);
  check('every floor tile is 128x128 and every wall tile 128x176', badSize, 0);
  check('nothing wider or taller than 400 (a merged blob would be)', tooBig, 0);
  check('nothing smaller than 24 (a stray sparkle would be)', tooSmall, 0);

  /* Every file on disk is in the catalog: a piece nobody can place is
     dead weight, and a leftover from an earlier build is a lie. */
  let orphans = 0;
  for (const dir of fs.readdirSync(PIECES)) {
    for (const f of fs.readdirSync(path.join(PIECES, dir))) {
      if (!ids.has(f.replace(/\.png$/, ''))) orphans++;
    }
  }
  check('no files without a catalog entry', orphans, 0);

  const counts = {};
  for (const p of pieces) counts[p.category] = (counts[p.category] || 0) + 1;
  check('45 floor tiles (a 5x9 sheet)', counts.floor, 45);
  check('24 wall tiles (a 3x8 sheet)', counts.wall, 24);
  ok('every category has at least 15 pieces', Object.values(counts).every(n => n >= 15), JSON.stringify(counts));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[room-catalog] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[room-catalog] ${passed} assertions passed.`);
console.log('');
process.exit(0);
