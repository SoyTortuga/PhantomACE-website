#!/usr/bin/env node
/* ══════════════════════════════════════════════
   EVERY MEDIA TYPE DRAWS SOMETHING — test suite

     node server/scripts/test-media-tiles.js

   THE BUG, FOR THE THIRD TIME. /api/media gained Twitch clips, then
   YouTube videos. Both are REFERENCES: the record holds a thumbnail, a
   slug or a video id, and no `url` at all. The media page learned that.
   The home page did not — its tile fell through to
   `<img src="${item.url}">`, so every clip on the front page was a broken
   image with no preview, on the one page most visitors see first.

   The same shape had already bitten twice: Dino Park's background loader
   dropped `fences`/`bgColor`, and /api/media's own field whitelist dropped
   `slug`/`thumbnail`. Each time the fix was to the one renderer that was
   reported, and each time a second renderer was left behind.

   SO THIS TEST DOES NOT NAME THE TYPES. It reads them out of the API
   source and RUNS the home page's tile function over one item of each. A
   type the renderer has never heard of lands in the image fall-through,
   produces an empty `src`, and fails here — which is exactly what a sixth
   media type would do on the front page.
   ══════════════════════════════════════════════ */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');
const stripJs = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── What types can reach a renderer at all ──────────────────────────
   Read off the handlers that WRITE a media record, so the list cannot go
   stale: upload.js picks between audio/video/image on one line, clip.js
   stamps its two reference types. */
const TYPES = (() => {
  const found = new Set();
  for (const f of readdirSync(join(REPO, 'functions/api/media'))) {
    if (!f.endsWith('.js')) continue;
    const src = stripJs(read('functions/api/media/' + f));
    for (const m of src.matchAll(/\btype:\s*([^\n]*)/g)) {
      /* The whole right-hand side, ternary and all — every quoted literal
         on it is a type this handler can store. */
      for (const lit of m[1].matchAll(/'([a-z][a-z-]*)'/g)) found.add(lit[1]);
    }
  }
  return [...found].sort();
})();

{
  ok('types were found in the API source', TYPES.length >= 3);
  /* The reference types are the whole reason this file exists; if the
     scrape ever stops seeing them it is silently testing nothing. */
  ok('including twitch-clip', TYPES.includes('twitch-clip'));
  ok('and youtube', TYPES.includes('youtube'));
  ok('and the uploaded kinds', ['audio', 'video', 'image'].every(t => TYPES.includes(t)));
}

/* ── The home page's tile, lifted out and run ───────────────────────── */

function loadMediaTile() {
  const src = read('js/pages/home.js');
  const start = src.indexOf('function mediaTile(item) {');
  if (start === -1) throw new Error('mediaTile not found in js/pages/home.js');
  /* Brace-match to the end of the function rather than guessing a length —
     the body grows every time a type is added, which is the point. */
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error('mediaTile has no closing brace');
  const body = src.slice(start, end);
  /* esc is the page's own escaper; the tile is pure string building
     otherwise, so this needs no DOM. */
  const make = new Function(
    'esc',
    body + '\nreturn mediaTile;'
  );
  return make((s) => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
}

const mediaTile = loadMediaTile();

/* One plausible record per type, shaped the way /api/media really answers:
   an upload carries `url`, a reference carries `thumbnail` and NO url. */
function record(type) {
  const base = { id: 'm1', title: 'A thing', category: 'highlights', type, uploadedAt: 1 };
  if (type === 'twitch-clip') return { ...base, slug: 'SpicyClip', thumbnail: 'https://clips-media.twitch/x.jpg', duration: '0:28' };
  if (type === 'youtube') return { ...base, videoId: 'aqz-KE-bpKQ', short: false, thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg' };
  return { ...base, url: '/cdn/media/x', file: 'x' };
}

/* THE ASSERTION THAT WOULD HAVE CAUGHT IT. Every type must paint
   something: an <img>/<video> with a real src, or an <audio> player. A
   `src=""` is the broken-image tile this suite is named after. */
for (const type of TYPES) {
  const html = mediaTile(record(type));
  ok(`${type}: the tile is not empty`, html.length > 0);
  ok(`${type}: no empty src`, !/src=""/.test(html));
  ok(`${type}: it paints something`, /<img |<video |<audio /.test(html));
}

/* ── The reference types, specifically ──────────────────────────────── */
{
  const clip = mediaTile(record('twitch-clip'));
  ok('a clip shows Twitch’s thumbnail', /src="https:\/\/clips-media\.twitch\/x\.jpg"/.test(clip));
  /* THE ACTUAL BUG: `url` is undefined on a reference, and the old tile
     interpolated it anyway. */
  ok('and never the word undefined', !/undefined/.test(clip));
  ok('it reads as playable', /home-media-play/.test(clip));

  const yt = mediaTile(record('youtube'));
  ok('a YouTube video shows its thumbnail', /i\.ytimg\.com/.test(yt));
  ok('and reads as playable', /home-media-play/.test(yt));

  const short = mediaTile({ ...record('youtube'), short: true });
  ok('a Short is marked as one', /home-media-tag/.test(short));
  ok('and a normal video is not', !/home-media-tag/.test(yt));

  /* A record whose thumbnail never arrived — the far side is somebody
     else's CDN, so this is a real state. An empty tile beats a broken
     image icon. */
  const bare = mediaTile({ ...record('twitch-clip'), thumbnail: '' });
  ok('a thumbnail-less clip renders no broken image', !/<img /.test(bare));
  ok('but still reads as a clip', /home-media-play/.test(bare));
}

/* ── The uploaded types still work ──────────────────────────────────── */
{
  ok('an image is an img', /<img [^>]*src="\/cdn\/media\/x"/.test(mediaTile(record('image'))));
  ok('a video is a video', /<video [^>]*src="\/cdn\/media\/x"/.test(mediaTile(record('video'))));
  const audio = mediaTile(record('audio'));
  ok('audio gets a player', /<audio /.test(audio));
  /* Audio carries its own controls, so its tile must not also be a link —
     the click would fight the play button. */
  ok('and is not wrapped in a link', !/^<a /.test(audio.trim()));
}

/* ── The fields the tile needs survive the API ──────────────────────── */
{
  /* /api/media returns named fields; forgetting one here is invisible
     until a reload, which is how the clip fields got dropped the first
     time. The home tile reads these two. */
  const api = read('functions/api/media/index.js');
  for (const f of ['thumbnail', 'short', 'type', 'url']) {
    ok(`${f} survives the API whitelist`, new RegExp('^\\s*' + f + ':', 'm').test(api));
  }
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[media-tiles] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[media-tiles] ${passed} assertions passed (types: ${TYPES.join(', ')}).`);
