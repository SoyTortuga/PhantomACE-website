#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MANA CLASH DICE FACES — the art contract

     node server/scripts/test-mana-clash-dice-art.js

   THE BUG THIS EXISTS FOR. Three of the six faces shipped without an alpha
   channel and nobody noticed for weeks. w.png and g.png were JPEGs under a
   .png name; b.png was a palette PNG with no tRNS chunk. The die body is a
   coloured CSS box and the art sits on top of it, so each of those three
   rendered as a white rectangle on a pastel die — visible on every roll,
   and invisible to anything that only checked the file was there.

   A filename does not tell you a format and a mode does not tell you the
   alpha is used: a fully opaque RGBA file passes both of those and still
   draws a box. So this reads the actual bytes — the PNG signature, the
   IHDR colour type, and the alpha channel itself.

   No image library: PNG headers are a fixed layout and the alpha question
   only needs the pixels, which zlib can inflate. That keeps the suite
   dependency-free like the rest of them.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const GAME = path.join(REPO, 'games', 'mana-clash');
const ASSETS = path.join(GAME, 'assets');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Chunk types, IHDR fields, and the raw IDAT, straight out of the file. */
function readPng(file) {
  const b = fs.readFileSync(file);
  if (!b.subarray(0, 8).equals(PNG_SIG)) return { png: false, magic: b.subarray(0, 4).toString('hex') };

  const out = { png: true, chunks: [], idat: [] };
  let i = 8;
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString('latin1');
    out.chunks.push(type);
    if (type === 'IHDR') {
      out.width = b.readUInt32BE(i + 8);
      out.height = b.readUInt32BE(i + 12);
      out.depth = b[i + 16];
      out.colourType = b[i + 17];   /* 6 = RGBA, 2 = RGB, 3 = palette */
      out.interlace = b[i + 20];
    }
    if (type === 'IDAT') out.idat.push(b.subarray(i + 8, i + 8 + len));
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return out;
}

/**
 * The share of pixels that are fully transparent, and how many sit part
 * way — an anti-aliased edge rather than a hard cut.
 *
 * Un-filters the scanlines by hand, which is the whole of PNG decoding for
 * a non-interlaced truecolour-alpha image. Only colour type 6 is handled,
 * because that is the only one the contract allows.
 */
function alphaStats(png) {
  const bpp = 4 * (png.depth / 8);
  const stride = png.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(png.idat));

  let clear = 0, partial = 0, total = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < png.height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at];
    const line = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const bPrev = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += bPrev;
      else if (filter === 3) v += Math.floor((a + bPrev) / 2);
      else if (filter === 4) {
        const p = a + bPrev - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - bPrev), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bPrev : c);
      }
      line[x] = v & 0xff;
    }
    for (let x = bpp - 1; x < stride; x += bpp) {
      const alpha = line[x];
      total++;
      if (alpha === 0) clear++;
      else if (alpha !== 255) partial++;
    }
    prev = line;
  }
  return { clear: clear / total, partial, total };
}

/* ── Which files the game actually asks for ──────────────────────────── */
const page = fs.readFileSync(path.join(GAME, 'index.html'), 'utf8');
const mapLine = /const FACE_IMG = \{([^}]*)\}/.exec(page);
ok('the page declares a face map', !!mapLine);
const FACES = Object.fromEntries(
  [...(mapLine ? mapLine[1].matchAll(/([A-Z]):\s*'([^']+)'/g) : [])].map(m => [m[1], m[2]]));

check('all six faces are mapped', Object.keys(FACES).sort(), ['B', 'C', 'G', 'R', 'U', 'W']);

/* THE POINT OF THE WHOLE FILE. Every face the game draws must be a real
   PNG with a real alpha channel that is really used. */
for (const [face, file] of Object.entries(FACES)) {
  const full = path.join(ASSETS, file);
  if (!fs.existsSync(full)) { failures.push(`${face}: ${file} is missing`); continue; }

  const png = readPng(full);
  ok(`${face} (${file}) is a real PNG`, png.png);
  if (!png.png) continue;

  /* A JPEG renamed .png is exactly how two of these shipped. */
  check(`${face} is truecolour with alpha`, png.colourType, 6);
  ok(`${face} is not interlaced`, png.interlace === 0);

  if (png.colourType !== 6 || png.interlace !== 0) continue;

  const a = alphaStats(png);
  /* An all-opaque RGBA file passes every check above and still draws a
     box, which is what b.png did. The art is a disc in a square, so a
     tenth of the canvas being clear is a floor no correct face is near —
     the real ones sit at 20-27%. */
  ok(`${face} actually uses its alpha (${(a.clear * 100).toFixed(0)}% clear)`, a.clear > 0.10);
  /* And the disc edge is anti-aliased rather than stair-stepped, which is
     what separates a proper export from a hard colour-key. */
  ok(`${face} has a feathered edge (${a.partial} px)`, a.partial > 50);
}

/* ── The die body stays CSS ──────────────────────────────────────────── */
{
  /* The art is the glyph only. Colour, rounded corners, the number and the
     selection states all live in CSS, and the border colour is what tells a
     player a die is scoring, held or pushed back. Baking any of that into
     the art would mean rebuilding those states as images. */
  ok('the face colours are still declared in one place', /const DIE_COLOUR = \{/.test(page));
  ok('the number is still drawn by the page', /class="pip-num"/.test(page));
  ok('and the die body is still a styled box', /\.die \{[^}]*border-radius/.test(page));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[mana-clash-dice-art] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[mana-clash-dice-art] ${passed} assertions passed.`);
console.log('');
