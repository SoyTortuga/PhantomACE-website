#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO PARK PORTRAITS — test suite

     node server/scripts/test-dino-portraits.js

   The portraits were rebuilt from the pack's original 150-330px art
   (tools/build-dino-portraits.py); the 72x72s the game used to serve were
   downscales of it. Three facts have to stay true, and each has a way of
   failing silently:

   THE MAP AND THE FOLDER AGREE. ASSET_MAP's portrait paths are rewritten
   by the same script that writes the folder. If they drift — a species
   renamed, a file dropped — the Dinodex shows a broken image only for the
   species that drifted, which nobody reproduces on demand.

   THE FILENAME IS THE RENDERING CONTRACT. A -72x72 file is pixel art and
   is drawn nearest-neighbour at a whole multiple of its grid; everything
   else is larger than any size the page draws it at and is scaled DOWN
   smoothly. A large file misnamed -72x72 would render as mush; a 72 file
   without the suffix would be smoothly blurred.

   THE PALETTE IS LOAD-BEARING. The mutation system is CSS
   hue-rotate/saturate stacked on the base art, calibrated against the tan
   72px palettes — a portrait that arrives in the pack's alternate blue
   renders every mutation of that species wrong. The build re-palettes all
   recovered art onto its own 72's colours, and this asserts the result:
   every upgraded portrait must sit in the same-palette band of its 72.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const GAME = path.join(REPO, 'games', 'dino-park');
const FOLDER = path.join(GAME, 'assets', 'portraits');
const OLD72 = path.join(GAME, 'assets', 'dino-assets', 'AncientBeastsPack');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function dims(p) {
  const b = fs.readFileSync(p);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const page = fs.readFileSync(path.join(GAME, 'index.html'), 'utf8');

/* ── The map and the folder agree ────────────────────────────────────── */
{
  const mapped = [...page.matchAll(/portrait: PT\+'([^']+)'/g)].map(m => m[1]);
  ok('the map points portraits at the tracked folder', mapped.length >= 80);
  ok('and nothing still points at the gitignored tree', !/portrait: BP\+/.test(page));

  const missing = mapped.filter(f => !fs.existsSync(path.join(FOLDER, f)));
  check('every mapped portrait exists on disk', missing, []);

  /* Strays are allowed — the folder covers species the map has not adopted
     yet — but every stray must still be a portrait, not debris. */
  const files = fs.readdirSync(FOLDER).filter(f => f.endsWith('.png'));
  ok('the folder is not empty', files.length >= 80);
}

/* ── The filename is the rendering contract ──────────────────────────── */
{
  const files = fs.readdirSync(FOLDER).filter(f => f.endsWith('.png'));
  const wrong = [];
  for (const f of files) {
    const [w, h] = dims(path.join(FOLDER, f));
    if (f.endsWith('-72x72.png')) {
      /* Pixel art, drawn nearest-neighbour at a whole multiple of its
         grid, so this one IS square and the name promises the number. */
      if (w !== 72 || h !== 72) wrong.push(`${f} claims 72x72 and is ${w}x${h}`);
    } else {
      /* Recovered art, trimmed to its own content: NOT square, on purpose.
         A pterosaur is three times wider than tall and squaring it meant
         padding most of the file with transparency. What still has to hold
         is that the long edge starts above the 144 the page draws it at --
         below that the browser would scale it UP, which is the blur this
         whole job existed to remove. */
      if (Math.max(w, h) < 145) {
        wrong.push(`${f} is ${w}x${h} — long edge too small to be a smooth portrait`);
      }
      /* And that the crop is a sprite rather than a sliver: a bounding box
         gone wrong (a stray fleck surviving the blob filter, an empty
         component) shows up as an absurd ratio long before it shows up on
         a profile. */
      if (Math.max(w, h) / Math.max(1, Math.min(w, h)) > 6) {
        wrong.push(`${f} is ${w}x${h} — ratio too extreme to be a whole sprite`);
      }
    }
  }
  check('every file honours its name', wrong, []);

  ok('the page snaps pixel art to its grid', /snapToGrid\(size, 72\)/.test(page));
  ok('and draws everything else smooth', page.includes("indexOf('-72x72') === -1"));
}

/* ── The palette is load-bearing ─────────────────────────────────────── */
{
  /* The build's own gate: every shipped large portrait sat within
     PALETTE_LIMIT of its 72 on mutually solid pixels, or it was demoted to
     the 72 itself. This re-measures the folder with the build's own
     palette_mse, so "tan stays tan" is enforced on every future rebuild --
     the mutation filters are hue-rotations calibrated against these
     palettes, and a portrait that drifts breaks every mutation of its
     species while looking perfectly fine itself. */
  const LIMIT = 3500;
  /* Measured via PIL through Python -- the build already requires it, and
     the numbers here mean exactly what the build's gate meant. */
  const { execFileSync } = await import('node:child_process');
  const script = `
import io, sys, os, json
import importlib.util
spec = importlib.util.spec_from_file_location('bp', ${JSON.stringify(path.join(REPO, 'tools', 'build-dino-portraits.py'))})
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)
from PIL import Image
out = {}
folder = ${JSON.stringify(FOLDER)}
old = ${JSON.stringify(OLD72)}
for f in os.listdir(folder):
    if not f.endswith('.png') or f.endswith('-72x72.png'):
        continue
    name = f[:-4]
    small = os.path.join(old, name + '-72x72.png')
    if not os.path.exists(small):
        continue
    a = bp.thumb(Image.open(os.path.join(folder, f)).convert('RGBA'))
    b = bp.thumb(Image.open(small).convert('RGBA'))
    out[name] = round(bp.palette_mse(a, b))
print(json.dumps(out))
`;
  let scores = {};
  try {
    scores = JSON.parse(execFileSync('python', ['-c', script], { encoding: 'utf8' }).trim().split(/\r?\n/).pop());
  } catch (err) {
    failures.push('palette measurement failed to run: ' + err.message);
  }

  const names = Object.keys(scores);
  ok('the upgraded portraits were measured', names.length >= 40);
  const offPalette = names.filter(n => scores[n] > LIMIT).map(n => `${n} (${scores[n]})`);
  check('every upgraded portrait keeps its species colours', offPalette, []);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[dino-portraits] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[dino-portraits] ${passed} assertions passed.`);
console.log('');
