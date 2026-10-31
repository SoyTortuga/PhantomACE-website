#!/usr/bin/env node
/* ══════════════════════════════════════════════
   FIND THE FACECAM AND GAMEPLAY REGIONS, without guessing.

     node server/clipper/scripts/layout-preview.js --slug <clipSlug>
     node server/clipper/scripts/layout-preview.js --input C:\path\clip.mp4

   With no regions it writes GRID.png: one frame of the clip with a labelled
   10% grid over it. Read the facecam's box off the grid, then pass it back:

     ... --slug <slug> --cam 0.76,0.60,0.22,0.30 --game 0.04,0.06,0.70,0.82

   Now it writes BOXES.png (the regions drawn on the frame) and preview.mp4
   (three seconds rendered exactly as the bot would). Nudge the numbers and
   re-run; it is seconds per iteration instead of a whole clip.

   Regions are x,y,w,h as FRACTIONS of the frame, which is what config.json
   wants — so a set of numbers that looks right here can be pasted straight in.

   Nothing is uploaded and nothing is recorded.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootEnv, serviceArg } from '../env-boot.js';
import { renderVertical } from '../render.js';

await bootEnv(serviceArg());

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../../..');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

function rect(spec, name) {
  if (!spec) return null;
  const n = spec.split(',').map(Number);
  if (n.length !== 4 || n.some(v => !Number.isFinite(v))) {
    console.error(`\n✗ --${name} must be x,y,w,h — four numbers, e.g. 0.76,0.60,0.22,0.30\n`);
    process.exit(2);
  }
  if (n.some(v => v > 1)) {
    console.error(`\n✗ --${name} looks like pixels. Use FRACTIONS of the frame (0-1).`);
    console.error(`  For a 1920x1080 clip, divide x and w by 1920, y and h by 1080.\n`);
    process.exit(2);
  }
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

const outDir = arg('--out', path.join(os.tmpdir(), 'clipper-layout'));
fs.mkdirSync(outDir, { recursive: true });

/* ── get a clip to look at ───────────────────────────────────────────── */
let input = arg('--input');
if (!input) {
  const slug = arg('--slug');
  if (!slug) {
    console.error('\n✗ Give --slug <clipSlug> or --input <file.mp4>.');
    console.error('  Slugs are printed by: node server/clipper/run.js --dry-run\n');
    process.exit(2);
  }
  const { downloadClip } = await import('../twitch.js');
  input = path.join(outDir, 'source.mp4');
  console.log(`[layout] downloading ${slug}...`);
  await downloadClip({ slug, thumbnailUrl: '' }, input);
}
if (!fs.existsSync(input)) { console.error(`\n✗ No such file: ${input}\n`); process.exit(2); }

const cam = rect(arg('--cam'), 'cam');
const game = rect(arg('--game'), 'game');

/* ── no regions yet: hand back a grid to read them off ───────────────── */
if (!cam || !game) {
  const grid = path.join(outDir, 'GRID.png');
  /* A line every 10%, labelled along the top and down the left. */
  const lines = [];
  for (let i = 1; i < 10; i++) {
    lines.push(`drawbox=x=iw*${i / 10}:y=0:w=2:h=ih:color=0xFF0000@0.55:t=fill`);
    lines.push(`drawbox=x=0:y=ih*${i / 10}:w=iw:h=2:color=0xFF0000@0.55:t=fill`);
    lines.push(`drawtext=text='${(i / 10).toFixed(1)}':fontfile=font.ttf:fontsize=28:fontcolor=yellow:x=iw*${i / 10}+6:y=8`);
    lines.push(`drawtext=text='${(i / 10).toFixed(1)}':fontfile=font.ttf:fontsize=28:fontcolor=yellow:x=8:y=ih*${i / 10}+4`);
  }
  fs.copyFileSync(path.join(ROOT, 'assets/fonts/Grenze.ttf'), path.join(outDir, 'font.ttf'));
  const r = spawnSync(FFMPEG, ['-y', '-i', path.resolve(input), '-frames:v', '1',
    '-vf', lines.join(','), path.basename(grid)], { cwd: outDir, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr.slice(-1500)); process.exit(1); }

  console.log(`\n[layout] wrote ${grid}`);
  console.log('\nOpen it and read off the two regions as x,y,w,h fractions:');
  console.log('  cam   — the facecam box');
  console.log('  game  — the part of the gameplay worth keeping');
  console.log('\nThen re-run, e.g.:');
  console.log('  node server/clipper/scripts/layout-preview.js \\');
  console.log(`    --input "${input}" --cam 0.76,0.60,0.22,0.30 --game 0.04,0.06,0.70,0.82\n`);
  process.exit(0);
}

/* ── regions given: draw them, then render what the bot would make ───── */
const camShare = Number(arg('--cam-share', '0.33'));
const boxes = path.join(outDir, 'BOXES.png');
fs.copyFileSync(path.join(ROOT, 'assets/fonts/Grenze.ttf'), path.join(outDir, 'font.ttf'));

const draw = (r, colour, label) => [
  `drawbox=x=iw*${r.x}:y=ih*${r.y}:w=iw*${r.w}:h=ih*${r.h}:color=${colour}:t=5`,
  `drawtext=text='${label}':fontfile=font.ttf:fontsize=34:fontcolor=${colour}:x=iw*${r.x}+10:y=ih*${r.y}+10`,
].join(',');

let r = spawnSync(FFMPEG, ['-y', '-i', path.resolve(input), '-frames:v', '1',
  '-vf', `${draw(cam, 'yellow', 'CAM')},${draw(game, 'cyan', 'GAME')}`,
  path.basename(boxes)], { cwd: outDir, encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr.slice(-1500)); process.exit(1); }

const preview = path.join(outDir, 'preview.mp4');
await renderVertical({
  input: path.resolve(input), output: preview,
  title: arg('--title', 'Layout preview'),
  fontFile: path.join(ROOT, 'assets/fonts/GODOFWAR.TTF'),
  logoFile: path.join(ROOT, 'assets/images/phantomace-logo.png'),
  layout: { mode: 'stack', cam, game, camShare },
  maxDurationSec: Number(arg('--seconds', '3')),
});

console.log(`\n[layout] ${boxes}      <- the regions drawn on the frame`);
console.log(`[layout] ${preview}   <- what the bot would produce\n`);
console.log('Happy with it? Paste into the route in server/clipper/config.json:\n');
console.log(JSON.stringify({ layout: { mode: 'stack', cam, game, camShare } }, null, 2));
console.log('');
