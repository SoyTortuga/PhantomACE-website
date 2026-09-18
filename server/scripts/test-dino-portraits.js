#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO PARK PORTRAITS — test suite

     node server/scripts/test-dino-portraits.js

   The portraits were rebuilt from the pack's original 150-330px art
   (tools/build-dino-portraits.py); the 72x72s the game used to serve were
   downscales of it. Four facts have to stay true, and each has a way of
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

   THE SPRITE IS WHOLE. Some of the pack's individual PNGs are cut off by
   their own source rectangle, and a clipped portrait passes every check
   above: right size, right name, plausible ratio, perfect colours. It took
   someone looking at the Dinodex to notice Mastodon had no legs.

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

  /* The icon fallback is the bug these closed: an ASSET_MAP entry with no
     portrait renders a 32px icon at 144px. Asserted on the map rather than
     the folder, because a built file nothing points at changes nothing. */
  const mapStart = page.indexOf('const ASSET_MAP = {');
  const mapBlock = page.slice(mapStart, page.indexOf('\n};', mapStart));
  for (const id of ['megashark', 'quetz']) {
    /* Scoped to ASSET_MAP: these ids are also keys in the palette and skin
       tables further down, and matching one of those would pass forever. */
    const line = mapBlock.split('\n').find(l => l.trim().startsWith(id + ':'));
    ok(`${id} is in ASSET_MAP`, !!line);
    ok(`and ${id} points at a portrait, not just an icon`,
       !!line && line.includes('portrait: PT+'));
  }

  ok('the page snaps pixel art to its grid', /snapToGrid\(size, 72\)/.test(page));
  ok('and draws everything else smooth', page.includes("indexOf('-72x72') === -1"));
}

/* ── The palette is load-bearing ─────────────────────────────────────── */
{
  /* The build's own gates, re-measured on the shipped folder so "tan stays
     tan" survives every future rebuild. TWO gates, because there are two
     kinds of source and one metric cannot judge both:

       recovered art   the same drawing the 72 was made from, so pixels
                       correspond and palette_mse is meaningful.
       captioned art   evenmoredinos.png, a DIFFERENT drawing of the same
                       species -- different pose, so palette_mse would be
                       reading pose mismatch as colour error. Hue after the
                       transfer is the honest question there, and it is
                       also the one the mutation filters actually care
                       about, being hue-rotations calibrated against these
                       palettes.

     Both limits come from the build, not from a number retyped here, so
     the test cannot drift away from what shipped. */
  const { execFileSync } = await import('node:child_process');
  const script = `
import io, sys, os, json
import importlib.util
spec = importlib.util.spec_from_file_location('bp', ${JSON.stringify(path.join(REPO, 'tools', 'build-dino-portraits.py'))})
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)
from PIL import Image
captioned = {n for sh in bp.LABELLED_SHEETS for row in sh['names'] for n in row if n}
out = {'limits': {'palette': bp.PALETTE_LIMIT, 'hue': bp.MAX_HUE_DRIFT},
       'scores': {}, 'unbased': [], 'cut': [],
       'no_small': sorted(bp.NO_SMALL), 'trunc': bp.TRUNCATION_LIMIT}
folder = ${JSON.stringify(FOLDER)}
old = ${JSON.stringify(OLD72)}
for f in os.listdir(folder):
    if not f.endswith('.png') or f.endswith('-72x72.png'):
        continue
    name = f[:-4]
    small_p = os.path.join(old, name + '-72x72.png')
    if not os.path.exists(small_p):
        # Megalodon and Quetzalcoatlus, which never had a 72 to be judged
        # against. Reported so the JS side can assert they shipped at all.
        out['unbased'].append(name)
        continue
    big = Image.open(os.path.join(folder, f)).convert('RGBA')
    small = Image.open(small_p).convert('RGBA')
    if name in captioned:
        out['scores'][name] = ['hue', round(bp.hue_drift(big, small), 1)]
    else:
        out['scores'][name] = ['palette', round(bp.palette_mse(bp.thumb(big), bp.thumb(small)))]

for f in os.listdir(folder):
    if f.endswith('.png') and not f.endswith('-72x72.png'):
        run = bp.edge_run(Image.open(os.path.join(folder, f)))
        if run > bp.TRUNCATION_LIMIT:
            out['cut'].append([f[:-4], round(run, 2)])
print(json.dumps(out))
`;
  let data = { limits: {}, scores: {}, unbased: [], cut: [], no_small: [] };
  try {
    data = JSON.parse(execFileSync('python', ['-c', script], { encoding: 'utf8' }).trim().split(/\r?\n/).pop());
  } catch (err) {
    failures.push('palette measurement failed to run: ' + err.message);
  }
  const scores = data.scores || {};
  const LIMIT = { palette: data.limits.palette, hue: data.limits.hue };

  const names = Object.keys(scores);
  ok('the upgraded portraits were measured', names.length >= 60);
  /* Both kinds are present, or one of the two gates is silently testing
     nothing -- which is how a guard rots without ever failing. */
  const kinds = new Set(names.map(n => scores[n][0]));
  check('both kinds of source are being judged', [...kinds].sort(), ['hue', 'palette']);

  const off = names
    .filter(n => scores[n][1] > LIMIT[scores[n][0]])
    .map(n => `${n} ${scores[n][0]}=${scores[n][1]} > ${LIMIT[scores[n][0]]}`);
  check('every upgraded portrait keeps its species colours', off, []);

  /* THE TWO WITH NO BASELINE. Megalodon and Quetzalcoatlus have no 72 and
     never did -- the game fell back to a 32x32 icon for them, which on a
     legendary reveal was the most conspicuous place it could happen. They
     are exempt from the gates above for want of anything to measure
     against, so what is asserted is that they shipped: measured, not
     assumed, because the exemption is exactly what would let them quietly
     stop being built. */
  /* NOT CUT OFF BY ITS OWN SOURCE RECTANGLE. Several of the pack's
     individual PNGs are truncated -- Mastodon lost its legs, Mosasaurus its
     lower fins -- and every other check here passed them happily, because
     the colours were perfect and the aspect ratio was plausible. The tell
     is a long flat run of opaque pixels along one border where a whole
     sprite touches its box at a few extremities.

     Empty is the assertion, not a list to grow. If a future portrait lands
     here, the question is whether it has a better source: the build demotes
     a cut candidate only when there is one, so a species with no
     alternative would keep its clipped art and fail this -- Yutyrannus
     already sits at 0.27, just under. That case wants an exemption recorded
     with its reason, not the limit quietly raised. */
  check('no portrait is cut off at its own edge', data.cut || [], []);

  check('the species with no 72 are the two expected',
        (data.unbased || []).sort(), (data.no_small || []).sort());
  check('and there are two of them', (data.no_small || []).length, 2);
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
