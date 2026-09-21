#!/usr/bin/env node
/* ══════════════════════════════════════════════
   ASEPRITE EXPORT — .aseprite source -> the single-row PNG strips every
   game on this site actually loads (background-position stepped in JS,
   see the game pages' index.html and js/pages/overlay-skull-raid.js).

     node server/scripts/aseprite-export.js --file "<source>.aseprite" --list
     node server/scripts/aseprite-export.js --file "<source>.aseprite" --out "<dir>"
     node server/scripts/aseprite-export.js --file "<source>.aseprite" --out "<dir>" --tag attack --tag "idle1.1:idle"

   WHY THIS EXISTS. Before this, a strip was built by eyeballing which
   frames belonged to which animation and exporting/cropping by hand --
   slow, and it silently drifts from the source the moment an artist
   retags or re-times the file, because nothing re-derives it. Every tag
   Aseprite itself defines (name, frame range, per-frame duration, play
   direction) is available from the CLI; this just turns that into the
   flat strip format the games already expect, so re-running it after an
   edit is the whole update.

   ONE TAG, ONE ASEPRITE CALL. `--tag NAME` has to come BEFORE the input
   file on the command line -- Aseprite treats it as a pending option that
   applies to the next sprite opened, not a filter on the export step.
   Get the order wrong and it silently exports every frame in the file
   instead of just the tag's range (verified the hard way; see the
   comment above run()).

   REVERSE TAGS NEED A SECOND PASS. A tag's `direction` in the file
   (forward/reverse/pingpong/pingpong_reverse) is a playback hint Aseprite
   itself only honours in its own timeline -- `--tag` exports the raw
   frame range in ascending index order regardless. A "reverse" tag
   exported as-is plays backwards on the very first frame step, which is
   exactly the "shrinks instead of grows" bug a manual export has to catch
   by eye. This reverses the frame order in the output strip so the tag's
   own intended direction is what ships. Ping-pong unrolls forward then
   back; nothing here has used it yet, but it would look wrong silently
   if left unhandled.

   MULTIPLE SOURCE FILES, ONE NAMESPACE. A rename (`--tag summon:minion-appear`)
   is not cosmetic here -- two DIFFERENT .aseprite files can each define a
   tag called "summon" for two DIFFERENT animations (the boss's own
   summon-a-minion cast, and the minion's own spawn-in), and only the
   caller knows which output name each one is supposed to land on.

   Never touches functions/ or the rig -- this is a local authoring tool,
   run by hand whenever a source .aseprite file changes, output committed
   or gitignored exactly like any other art under a game's assets folder.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

/* No install is at a fixed path across machines, so this is resolution
   order, not a guess: an explicit flag beats an env var beats the common
   Windows install locations (Steam and the direct-download default). */
function findAseprite(explicit) {
  const candidates = [
    explicit,
    process.env.ASEPRITE_PATH,
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Aseprite\\Aseprite.exe',
    'C:\\Program Files\\Aseprite\\Aseprite.exe',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    'Could not find Aseprite.exe. Pass --aseprite "<path>" or set ASEPRITE_PATH.\n' +
    'Checked: ' + candidates.join(', ')
  );
}

function parseArgs(argv) {
  const out = { tags: [], list: false, file: null, out: null, aseprite: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.file = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--aseprite') out.aseprite = argv[++i];
    else if (a === '--tag') out.tags.push(argv[++i]);
    else if (a === '--list') out.list = true;
    else throw new Error('Unknown argument: ' + a);
  }
  if (!out.file) throw new Error('Missing --file "<source>.aseprite"');
  if (!out.list && !out.out) throw new Error('Missing --out "<dir>" (or pass --list to only inspect the file)');
  return out;
}

function run(exe, args) {
  return execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/* All tags in the file, with frame count/size/duration/direction -- one
   full-file export, not one call per tag, since this is read-only
   inspection and every tag's data comes back in the same JSON. */
function probeTags(exe, file) {
  const tmpJson = path.join(os.tmpdir(), 'aseprite-probe-' + Date.now() + '.json');
  const tmpSheet = path.join(os.tmpdir(), 'aseprite-probe-' + Date.now() + '.png');
  try {
    run(exe, ['-b', file, '--sheet-type', 'horizontal', '--sheet', tmpSheet, '--data', tmpJson, '--format', 'json-array', '--list-tags']);
    const data = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
    const frames = Array.isArray(data.frames) ? data.frames : Object.values(data.frames);
    const tags = (data.meta.frameTags || data.meta.frametags || []).map(t => {
      const span = frames.slice(t.from, t.to + 1);
      const durations = [...new Set(span.map(f => f.duration))];
      return {
        name: t.name, from: t.from, to: t.to, frameCount: span.length,
        direction: t.direction || 'forward',
        size: span[0] ? { w: span[0].sourceSize.w, h: span[0].sourceSize.h } : null,
        durations,
      };
    });
    return { tags, totalFrames: frames.length, size: data.meta.size };
  } finally {
    fs.rmSync(tmpJson, { force: true });
    fs.rmSync(tmpSheet, { force: true });
  }
}

/* sharp's composite() takes ready-made buffers, not "crop this rect of
   that file" -- so each destination frame is extracted from the source
   sheet first, then composited at its (possibly reordered) slot. Its own
   step rather than folded into exportTag so a failure on one frame names
   which one, instead of the whole tag failing silently. */
async function buildReorderedStrip(tmpSheet, frames, order) {
  const w = frames[0].sourceSize.w, h = frames[0].sourceSize.h;
  const crops = await Promise.all(order.map(i => {
    const f = frames[i].frame;
    return sharp(tmpSheet).extract({ left: f.x, top: f.y, width: f.w, height: f.h }).toBuffer();
  }));
  return sharp({ create: { width: w * order.length, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(crops.map((buf, i) => ({ input: buf, left: i * w, top: 0 })))
    .png()
    .toBuffer();
}

/* A fully-transparent frame at the END of a strip is invisible for the
   whole duration it's stepped through — a stepped background-position
   strip has no other way to represent "hold on nothing", so it is never
   an intentional beat, only leftover padding from wherever the frame
   range was originally cut. Checked on the FINAL playback order (after
   any reverse/ping-pong reordering), not raw source order, and only
   trailing ones are dropped -- a blank in the MIDDLE is unusual enough
   that silently removing it could be erasing something a scarier-looking
   diff would at least make visible.

   PIXEL COUNT, NOT stats().max. A frame that reads as empty by eye can
   still have a stray antialiased pixel or two at a sliver of opacity —
   real death/despawn frames in this project's own art have exactly that —
   so requiring the alpha channel's max to be LITERALLY zero missed them
   entirely and never trimmed anything. A small tolerance (up to a couple
   of visible pixels) is what actually matches "nothing to see here". */
const BLANK_ALPHA_THRESHOLD = 10;   // out of 255 — below this reads as fully transparent to the eye
const BLANK_PIXEL_TOLERANCE = 2;    // this many stray visible pixels still counts as blank

async function countTrailingBlankFrames(tmpSheet, frames, order) {
  let blank = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const f = frames[order[i]].frame;
    const buf = await sharp(tmpSheet).extract({ left: f.x, top: f.y, width: f.w, height: f.h })
      .ensureAlpha().raw().toBuffer();
    let visible = 0;
    for (let p = 3; p < buf.length; p += 4) {
      if (buf[p] > BLANK_ALPHA_THRESHOLD && ++visible > BLANK_PIXEL_TOLERANCE) break;
    }
    if (visible <= BLANK_PIXEL_TOLERANCE) blank++;
    else break;
  }
  return blank;
}

/* One tag -> one horizontal strip at outPath, frame order corrected for
   the tag's own playback direction (see the header comment on why the
   raw CLI export can't be trusted for this), trailing blank frames
   dropped (see countTrailingBlankFrames). */
async function exportTag(exe, file, tag, outPath) {
  const tmpJson = path.join(os.tmpdir(), 'aseprite-tag-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  const tmpSheet = path.join(os.tmpdir(), 'aseprite-tag-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.png');
  try {
    run(exe, ['-b', '--tag', tag.name, file, '--sheet-type', 'horizontal', '--sheet', tmpSheet, '--data', tmpJson, '--format', 'json-array']);
    const data = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
    const frames = Array.isArray(data.frames) ? data.frames : Object.values(data.frames);

    let order = frames.map((_, i) => i);
    if (tag.direction === 'reverse') {
      order = order.reverse();
    } else if (tag.direction === 'pingpong' || tag.direction === 'pingpong_reverse') {
      const back = order.slice(1, -1).reverse();
      order = tag.direction === 'pingpong' ? order.concat(back) : order.reverse().concat(back.reverse());
    }

    const trimmed = await countTrailingBlankFrames(tmpSheet, frames, order);
    if (trimmed) order = order.slice(0, order.length - trimmed);

    const buf = await buildReorderedStrip(tmpSheet, frames, order);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return { frameCount: order.length, width: frames[0].sourceSize.w * order.length, height: frames[0].sourceSize.h, trimmed };
  } finally {
    fs.rmSync(tmpJson, { force: true });
    fs.rmSync(tmpSheet, { force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exe = findAseprite(args.aseprite);
  const { tags, totalFrames, size } = probeTags(exe, args.file);

  if (!tags.length) {
    console.log(`No tags defined in ${args.file} (${totalFrames} untagged frames, ${size.w}x${size.h}). Nothing to export by tag.`);
    return;
  }

  console.log(`${path.basename(args.file)} — ${tags.length} tag(s), ${totalFrames} total frames:\n`);
  for (const t of tags) {
    const dur = t.durations.length === 1 ? `${t.durations[0]}ms/frame` : `varies: ${t.durations.join('/')}ms`;
    console.log(`  ${t.name.padEnd(16)} ${String(t.frameCount).padStart(3)} frames  ${(t.size.w + 'x' + t.size.h).padEnd(9)} ${t.direction.padEnd(16)} ${dur}`);
  }
  console.log('');

  if (args.list) return;

  /* --tag NAME[:outName] picks specific tags with an optional rename;
     omit --tag entirely to export every tag under its own name. */
  const requested = args.tags.length
    ? args.tags.map(spec => { const [name, outName] = spec.split(':'); return { name, outName: outName || name }; })
    : tags.map(t => ({ name: t.name, outName: t.name }));

  for (const req of requested) {
    const tag = tags.find(t => t.name === req.name);
    if (!tag) { console.error(`  ✗ no such tag "${req.name}" — skipped`); continue; }
    const outPath = path.join(args.out, req.outName + '.png');
    const result = await exportTag(exe, args.file, tag, outPath);
    const trimNote = result.trimmed ? ` (dropped ${result.trimmed} blank trailing frame${result.trimmed === 1 ? '' : 's'})` : '';
    console.log(`  ✓ ${req.name}${req.outName !== req.name ? ' -> ' + req.outName : ''}: ${result.frameCount} frames, ${result.width}x${result.height}${trimNote} -> ${outPath}`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
