#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MY ROOM — renderer test suite

     node server/scripts/test-room-render.js

   js/room-render.js is a plain browser script; this loads it into a vm
   with a bare global and drives PhamRoom.build / buildSetup directly.
   The output is markup, so the checks are about geometry and order: the
   stage is the size the plan says, walls land where the floor ends,
   props are offset by the wall band, rugs draw first, flips and scales
   come through, and nothing from a document reaches the markup
   unescaped.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/room-render.js'), 'utf8'), sandbox);
const R = sandbox.PhamRoom;
ok('the script exposes PhamRoom', !!R && typeof R.build === 'function');

const catalog = () => ({
  pieces: [
    { id: 'floor-r1c1', category: 'floor', layer: 'floor', w: 128, h: 128 },
    { id: 'floor-r1c2', category: 'floor', layer: 'floor', w: 128, h: 128 },
    { id: 'wall-r1c1', category: 'wall', layer: 'wall', w: 128, h: 176 },
    { id: 'rugs-r1c1', category: 'rugs', layer: 'rug', w: 200, h: 120 },
    { id: 'desks-r1c1', category: 'desks', layer: 'prop', w: 220, h: 200 },
    { id: 'keyboards-r1c1', category: 'keyboards', layer: 'prop', w: 230, h: 130 },
  ],
});

const room = (over = {}) => ({
  size: 'M', floor: 'floor-r1c1', cells: {},
  walls: { back: Array(12).fill('wall-r1c1'), left: Array(8).fill('wall-r1c1'), right: Array(8).fill('wall-r1c1') },
  props: [], setup: { props: [] }, ...over,
});

const count = (html, re) => (html.match(re) || []).length;

/* ── Stage geometry ──────────────────────────────────────────────────── */
{
  const b = R.build(room(), catalog());
  check('an M room stage is walls + 12 cells + walls wide', b.w, 176 + 12 * 128 + 176);
  check('and back wall + 8 cells tall', b.h, 176 + 8 * 128);
  check('the floor starts after the wall band', [b.floor.x, b.floor.y], [176, 176]);
  check('and is 12x8 cells', [b.floor.w, b.floor.h], [1536, 1024]);
  ok('the floor tile is the background', /rm-floor[^>]*background-image:url\(\/assets\/room\/pieces\/floor\/floor-r1c1\.png\)/.test(b.html));
  check('twelve back wall tiles', count(b.html, /rm-wall-back/g), 12);
  check('eight left, eight right', [count(b.html, /rm-wall-left/g), count(b.html, /rm-wall-right/g)], [8, 8]);
  ok('the first back tile sits at the floor edge, top of stage', /rm-wall-back[^>]*left:176px;top:0px/.test(b.html));
  ok('the last back tile ends at the far floor edge', /rm-wall-back[^>]*left:1584px;top:0px/.test(b.html));
  ok('left walls rotate anticlockwise so the baseboard meets the floor', /rm-wall-left[^>]*rotate\(-90deg\)/.test(b.html));
  ok('right walls rotate clockwise', /rm-wall-right[^>]*rotate\(90deg\)/.test(b.html));
  check('two corner blocks', count(b.html, /rm-corner/g), 2);
  const L = R.build(room({ size: 'L' }), catalog());
  check('an L room is 15x10', [L.floor.w, L.floor.h], [15 * 128, 10 * 128]);
  const S = R.build(room({ size: 'nonsense' }), catalog());
  check('an unknown size draws as M', [S.floor.w, S.floor.h], [1536, 1024]);
  const gap = R.build(room({ walls: { back: [null, 'wall-r1c1'].concat(Array(10).fill(null)), left: Array(8).fill(null), right: Array(8).fill(null) } }), catalog());
  check('a null wall cell draws nothing', count(gap.html, /class="rm-piece rm-wall /g), 1);
}

/* ── Cells ───────────────────────────────────────────────────────────── */
{
  const b = R.build(room({ cells: { '3,2': 'floor-r1c2', 'junk': 'floor-r1c2', '0,0': 'nope' } }), catalog());
  check('one painted cell (junk key and unknown id skipped)', count(b.html, /rm-cell/g), 1);
  ok('at column 3, row 2, offset by the wall band', /rm-cell[^>]*left:560px;top:432px;width:128px;height:128px/.test(b.html));
}

/* ── Props ───────────────────────────────────────────────────────────── */
{
  const b = R.build(room({ props: [
    { id: 'desks-r1c1', x: 256, y: 128, scale: 1, flip: false },
    { id: 'rugs-r1c1', x: 0, y: 0, scale: 1, flip: false },
    { id: 'desks-r1c1', x: 64, y: 64, scale: 2, flip: true },
    { id: 'ghost', x: 0, y: 0, scale: 1, flip: false },
  ] }), catalog());
  check('three props drawn (the unknown id skipped)', count(b.html, /rm-prop/g), 3);
  const rugAt = b.html.indexOf('rugs-r1c1'), deskAt = b.html.indexOf('desks-r1c1.png');
  ok('the rug draws before the desk listed ahead of it', rugAt < deskAt);
  ok('a prop is offset by the wall band', /data-index="0"[^>]*left:432px;top:304px;width:220px;height:200px/.test(b.html));
  ok('scale 2 doubles the drawn size', /data-index="2"[^>]*width:440px;height:400px/.test(b.html));
  ok('flip is a horizontal mirror', /data-index="2"[^>]*scaleX\(-1\)/.test(b.html));
  ok('an unflipped prop has no transform', !/data-index="0"[^>]*transform/.test(b.html));
  ok('the index survives for an editor to find the element', /data-index="1"/.test(b.html));
}

/* ── The desk setup ──────────────────────────────────────────────────── */
{
  const b = R.buildSetup(room({ setup: { props: [{ id: 'keyboards-r1c1', x: 320, y: 416, scale: 1, flip: false }] } }), catalog());
  check('the setup stage is 1024x576', [b.w, b.h], [1024, 576]);
  ok('the back wall tile is the backdrop', /rm-setup-wall[^>]*background-image:url\(\/assets\/room\/pieces\/wall\/wall-r1c1\.png\)/.test(b.html));
  ok('the desk surface spans the lower third', /rm-setup-desk[^>]*top:384px;width:1024px;height:192px/.test(b.html));
  ok('a desk prop is drawn at its own coordinates, no offset', /rm-prop[^>]*left:320px;top:416px/.test(b.html));
  const none = R.buildSetup(room(), catalog());
  check('an empty setup has no props', count(none.html, /rm-prop/g), 0);
}

/* ── Nothing reaches the markup unescaped ────────────────────────────── */
{
  const cat = catalog();
  cat.pieces.push({ id: 'x" onerror="alert(1)', category: 'floor', layer: 'floor', w: 128, h: 128 });
  const b = R.build(room({ floor: 'x" onerror="alert(1)' }), cat);
  ok('a hostile id in the catalog is escaped in a URL, not injected', !/onerror="alert/.test(b.html) && /x%22%20onerror/.test(b.html));
  const b2 = R.build(room({ props: [{ id: '<img src=x onerror=alert(1)>', x: 0, y: 0, scale: 1, flip: false }] }), catalog());
  ok('a hostile prop id not in the catalog draws nothing', !/onerror/.test(b2.html));
}

/* ── Fitting a stage to its host ─────────────────────────────────────
   fit() is the only part of the renderer that touches a DOM, so it gets
   a hand-made one. The minimum scale is what makes the editor usable on
   a phone: without it a 12x8 room fits 375px at 0.17, drawing a floor
   tile 22px across. With it the stage overflows and the host scrolls. */
{
  const host = (clientWidth, w, h) => {
    const stage = { style: { width: w + 'px', height: h + 'px', transform: '' } };
    return { clientWidth, style: {}, dataset: {}, querySelector: () => stage, stage };
  };

  const wide = host(1888, 1888, 1200);
  check('a host as wide as the stage draws it 1:1', R.fit(wide), 1);
  check('and says so on the element', wide.dataset.scale, '1');
  check('the host takes the stage height', wide.style.height, '1200px');

  const half = host(944, 1888, 1200);
  check('a half-width host halves it', R.fit(half), 0.5);
  check('the stage is transformed, not resized', half.stage.style.transform, 'scale(0.5)');
  check('and the host height follows', half.style.height, '600px');

  const big = host(4000, 1888, 1200);
  check('a host wider than the stage does not blow it up', R.fit(big), 1);

  /* THE PHONE CASE. */
  const phone = host(375, 1888, 1200);
  const unbounded = R.fit(phone);
  ok('unbounded, a phone would draw it at about a sixth', unbounded > 0.15 && unbounded < 0.2);
  check('with a minimum it holds that instead', R.fit(phone, 0.35), 0.35);
  check('so the stage is wider than the host and it must scroll',
    1888 * 0.35 > 375, true);
  check('a minimum below the fitted scale changes nothing', R.fit(half, 0.2), 0.5);
  check('and one at exactly the fitted scale is a no-op', R.fit(half, 0.5), 0.5);

  const empty = { querySelector: () => null, style: {}, dataset: {}, clientWidth: 300 };
  check('a host with no stage in it is 1, not a crash', R.fit(empty, 0.35), 1);
  const noWidth = host(0, 1888, 1200);
  check('a host not yet laid out falls back to the stage width', R.fit(noWidth), 1);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[room-render] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[room-render] ${passed} assertions passed.`);
console.log('');
process.exit(0);
