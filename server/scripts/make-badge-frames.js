#!/usr/bin/env node
/* ══════════════════════════════════════════════
   BADGE FRAMES — the blank each achievement badge is drawn on

     node server/scripts/make-badge-frames.js            report
     node server/scripts/make-badge-frames.js --write    write them

   Twelve achievements, twelve badges to draw. The part that does not need
   an artist is the part that must be IDENTICAL across all of them: the
   144x144 canvas, the roundel, and the rarity ring. So that is generated,
   from the catalogue and from the site's own --rarity-* tokens, and the
   glyph is drawn into the middle afterwards.

   Doing it this way means the twelve match by construction rather than by
   care, and that re-running this after a rarity changes re-rings every
   badge without anyone repainting one.

   THE FILES ARE THE REAL ONES. They are written to assets/badges/<id>.png,
   the exact paths functions/api/achievements.js grants, so a framed blank
   shows on a profile today and gains its glyph when the artwork is painted
   over it. Nothing to re-wire later.

   WHAT TO DRAW: the clear middle, a 96x96 square centred on the canvas
   (so 24px in from each edge). Keep inside that and the ring stays clean.

   Sources of truth, neither restated here:
     the twelve and their rarities  functions/api/achievements.js
     the rarity colours             css/variables.css
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { allRewards } from '../../functions/api/achievements.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT = path.join(REPO, 'assets/badges');

const SIZE = 144;
/** The clear middle a glyph is drawn into. */
export const SAFE = 96;

/** The --rarity-* tokens, read from the stylesheet rather than copied. */
export function rarityColours() {
  const css = fs.readFileSync(path.join(REPO, 'css/variables.css'), 'utf8');
  const out = {};
  for (const m of css.matchAll(/--rarity-([a-z]+):\s*(#[0-9a-fA-F]{3,8});/g)) {
    /* The first block is :root — the dark theme, which is the one these are
       drawn for. A later light-mode override must not win. */
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

/* A flat roundel: dark disc, rarity ring, one dimmed inner line for depth.
   No gradient and no shadow — the house rules forbid both, and depth here
   comes from the border exactly as it does everywhere else on the site. */
function frameSvg(colour) {
  const c = SIZE / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <circle cx="${c}" cy="${c}" r="67" fill="#0a0a0a"/>
  <circle cx="${c}" cy="${c}" r="67" fill="none" stroke="${colour}" stroke-width="5"/>
  <circle cx="${c}" cy="${c}" r="58" fill="none" stroke="${colour}" stroke-width="1.5" opacity="0.45"/>
</svg>`;
}

async function build() {
  const colours = rarityColours();
  const rewards = allRewards();
  const missing = rewards.filter(r => !colours[r.rarity]);
  if (missing.length) {
    throw new Error('no colour token for rarity: ' + [...new Set(missing.map(r => r.rarity))].join(', '));
  }
  return rewards.map(r => ({
    ...r,
    colour: colours[r.rarity],
    file: path.join(OUT, `${r.id}.png`),
  }));
}

/* Only when run directly. This file exports rarityColours and SAFE, and
   without the guard importing it would print a report — or, if the importing
   process happened to carry --write in its argv, write files. */
const RUN_DIRECTLY = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (RUN_DIRECTLY) await main();

async function main() {
const write = process.argv.includes('--write');
const planned = await build();

console.log(`[badge-frames] ${planned.length} badges, ${SIZE}x${SIZE}, ${SAFE}x${SAFE} clear middle`);
for (const b of planned) {
  const exists = fs.existsSync(b.file);
  if (!write) {
    console.log(`  ${exists ? 'exists ' : 'missing'}  ${path.basename(b.file).padEnd(19)} ${b.rarity.padEnd(10)} ${b.colour}`);
    continue;
  }
  /* NEVER OVERWRITE REAL ART. Once a glyph has been painted onto one of
     these, re-running must not wipe it back to a blank — which is exactly
     what a regenerate-everything script would do the first time somebody
     ran it to pick up a palette change. */
  if (exists) {
    console.log(`  kept     ${path.basename(b.file)} (already drawn — delete it to reframe)`);
    continue;
  }
  await sharp(Buffer.from(frameSvg(b.colour))).png().toFile(b.file);
  console.log(`  wrote    ${path.basename(b.file).padEnd(19)} ${b.rarity.padEnd(10)} ${b.colour}`);
}

if (!write) {
  console.log('');
  console.log('Dry run. Re-run with --write to create the ones that are missing.');
}
}
