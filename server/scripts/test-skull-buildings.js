#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SKULL CLICKER — every building has a sprite

     node server/scripts/test-skull-buildings.js

   The building list and the sprite files are two halves of one contract:
   renderBuildings() points each row at assets/buildings/<id>.png, so every
   id in the BUILDINGS array must have a file on disk or the row renders an
   empty box. The sprites are gitignored (licensed packs, like dino-assets),
   so this test is also the thing that catches a rig that pulled the code
   but never copied the art — it asserts the files are actually present.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const GAME = path.join(REPO, 'games/skull-clicker/index.html');
const SPRITES = path.join(REPO, 'games/skull-clicker/assets/buildings');

let passed = 0;
const failures = [];
const ok = (label, cond) => { if (cond) passed++; else failures.push(label); };

const html = fs.readFileSync(GAME, 'utf8');

/* Pull the building ids straight out of the source array, so the test tracks
   whatever the game actually ships rather than a hand-kept copy. */
const start = html.indexOf('const BUILDINGS');
const arr = html.slice(start, html.indexOf('];', start));
const ids = [...arr.matchAll(/id\s*:\s*'([^']+)'/g)].map(m => m[1]);

ok('the BUILDINGS array was found and parsed', ids.length >= 15);

for (const id of ids) {
  const file = path.join(SPRITES, `${id}.png`);
  const exists = fs.existsSync(file);
  ok(`building '${id}' has a sprite`, exists);
  if (exists) ok(`building '${id}' sprite is non-empty`, fs.statSync(file).size > 0);
}

/* No stray sprites for buildings that no longer exist — a renamed building
   would otherwise leave dead art around and hide a broken row. */
if (fs.existsSync(SPRITES)) {
  const files = fs.readdirSync(SPRITES).filter(f => f.endsWith('.png'));
  for (const f of files) {
    ok(`sprite '${f}' belongs to a real building`, ids.includes(f.replace(/\.png$/, '')));
  }
}

/* The render wires the sprite by id and shows the owned count as a badge,
   not as the icon itself. */
ok('renderBuildings points the icon at the sprite by id',
   /building-icon"><img src="assets\/buildings\/\$\{b\.id\}\.png"/.test(html));
ok('the owned count renders as a badge, not the icon',
   /class="building-count">\$\{cnt\}<\/span>/.test(html));
ok('a missing sprite degrades gracefully', /onerror="this\.remove\(\)"/.test(html));

/* The living world: a Cookie-Clicker-style panel that draws owned buildings
   and fills up as you buy, capped so a band never overflows. */
ok('the page has the world panel', /id="worldGround"/.test(html) && /id="worldPanel"/.test(html));
ok('renderWorld draws the owned buildings from their sprites',
   /function renderWorld/.test(html) && /assets\/buildings\/'\s*\+\s*b\.id/.test(html));
ok('the world caps how many sprites a band draws', /WORLD_CAP/.test(html) && /Math\.min\(cnt, WORLD_CAP\)/.test(html));
ok('a buy grows the world and pops the new one',
   /lastBought = b\.id;[\s\S]*renderWorld\(\)/.test(html) && /world-sprite\.fresh/.test(html));
ok('the world is rebuilt on buy, load, prestige and boot',
   (html.match(/renderWorld\(\);/g) || []).length >= 4);
/* Never in the 10/s tick loop — that would rebuild hundreds of sprites ten
   times a second. Scoped to the tick body so the check cannot leak past it. */
const tickBody = html.slice(html.indexOf('function tick'), html.indexOf('setInterval(tick'));
ok('the world is not rebuilt in the tick loop', tickBody.length > 0 && !/renderWorld/.test(tickBody));

console.log('');
if (failures.length) {
  console.log(`[skull-buildings] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[skull-buildings] ${passed} assertions passed — ${ids.length} buildings, all with sprites.`);
console.log('');
