#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MY ROOM — editor core test suite

     node server/scripts/test-room-edit-core.js

   js/room-edit-core.js holds what the editor decides about a room
   without a DOM. The important property is that everything it produces
   is something the server's validator accepts — so after each rule is
   checked on its own, the results are run through validateRoom() too.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  validateRoom, basicCategories, defaultRoom, piece, pieces, placementRegion,
  SNAP, SCALES, ROTATIONS, WALL_H,
} from '../../functions/api/room-catalog.js';

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
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/room-edit-core.js'), 'utf8'), sandbox);
const E = sandbox.PhamRoomEdit;
ok('the script exposes PhamRoomEdit', !!E && typeof E.place === 'function');

const BASIC = basicCategories();
const desk = pieces().find(p => p.category === 'desks');
const rug = pieces().find(p => p.layer === 'rug');
const wallId = pieces().find(p => p.layer === 'wall').id;
const accepted = (room) => { const v = validateRoom(room, BASIC); return v.ok ? 'ok' : v.error; };

/* ── Constants agree with the validator ──────────────────────────────── */
{
  check('snap grid', E.SNAP, SNAP);
  check('scale steps', E.SCALES, SCALES);
  check('rotations', E.ROTATIONS, ROTATIONS);
  /* The editor's region MUST equal the validator's, or the editor can
     produce placements the server refuses. */
  for (const size of ['S', 'M', 'L']) {
    check(`the ${size} room region matches the server`, E.region({ size }, 'room'), placementRegion(size, 'room'));
  }
  check('the desk region matches the server', E.region({ size: 'L' }, 'desk'), placementRegion('L', 'desk'));
  check('an unknown size is M', E.region({ size: 'XL' }, 'room'), placementRegion('M', 'room'));
  /* THE WALL BAND IS IN IT. Wall-hung pieces could not reach a wall while
     the region was the floor rectangle alone. */
  const rM = E.region({ size: 'M' }, 'room');
  check('the region opens into the wall band on three sides',
    [rM.x0, rM.y0, rM.x1 - 12 * 128], [-WALL_H, -WALL_H, WALL_H]);
  check('and not past the open front edge', rM.y1, 8 * 128);
}

/* ── snap and clamp ──────────────────────────────────────────────────── */
{
  check('snap rounds to the grid', [E.snap(0), E.snap(15), E.snap(17), E.snap(-20), E.snap(100)], [0, 0, 32, -32, 96]);
  const b = E.region({ size: 'M' }, 'room');
  const centre = (pr, pc) => ({ x: pr.x + pc.w * pr.scale / 2, y: pr.y + pc.h * pr.scale / 2 });
  const inside = (pr, pc) => {
    const c = centre(pr, pc);
    return c.x >= b.x0 && c.x <= b.x1 && c.y >= b.y0 && c.y <= b.y1;
  };
  const p = E.clamp({ id: desk.id, x: 13, y: 21, scale: 1, flip: false }, desk, b);
  check('clamp snaps a free position', [p.x, p.y], [0, 32]);
  const far = E.clamp({ id: desk.id, x: 5000, y: -5000, scale: 1, flip: false }, desk, b);
  ok('a far-off prop is pulled back inside', inside(far, desk));
  ok('on the grid', far.x % SNAP === 0 && far.y % SNAP === 0);
  const big = E.clamp({ id: desk.id, x: 1500, y: 1000, scale: 2, flip: false }, desk, b);
  ok('scale is accounted for when clamping', inside(big, desk));

  /* THE WALL FIX. A piece dragged up at the back wall now stays there. */
  /* WALL_H is 176, which is not a multiple of the 32px grid, so a piece
     pushed to the top of the band lands on the nearest step below it. */
  const onWall = E.clamp({ id: desk.id, x: 256, y: -WALL_H, scale: 1, flip: false }, desk, b);
  ok('a piece may sit up in the back wall band', onWall.y <= -WALL_H + SNAP && onWall.y % SNAP === 0);
  const pastWall = E.clamp({ id: desk.id, x: 256, y: -1000, scale: 1, flip: false }, desk, b);
  ok('but not above the wall', centre(pastWall, desk).y >= b.y0);
  const onSide = E.clamp({ id: desk.id, x: -WALL_H - desk.w, y: 256, scale: 1, flip: false }, desk, b);
  ok('and it may reach the side wall', centre(onSide, desk).x >= b.x0 && centre(onSide, desk).x < b.x0 + SNAP);
  check('the server accepts a piece on the wall',
    accepted({ ...defaultRoom('M'), props: [{ ...onWall, rot: 0 }] }), 'ok');
}

/* ── place ───────────────────────────────────────────────────────────── */
{
  const b = E.region({ size: 'M' }, 'room');
  const p = E.place(desk, b);
  check('a new prop has the piece id, scale 1, upright, no flip', [p.id, p.scale, p.rot, p.flip], [desk.id, 1, 0, false]);
  ok('it is centred in the region',
    Math.abs((p.x + desk.w / 2) - (b.x0 + b.x1) / 2) <= SNAP && Math.abs((p.y + desk.h / 2) - (b.y0 + b.y1) / 2) <= SNAP);
  ok('and on the grid', p.x % SNAP === 0 && p.y % SNAP === 0);
  const room = { ...defaultRoom('M'), props: [p] };
  check('the server accepts what place() made', accepted(room), 'ok');
  const dp = E.place(pieces().find(x => x.category === 'keyboards'), E.region(room, 'desk'));
  ok('a desk prop is centred on the desk canvas', Math.abs((dp.x + 230 / 2) - 512) <= SNAP * 2);
}

/* ── scale steps ─────────────────────────────────────────────────────── */
{
  check('up from 1 is 1.5', E.nextScale(1, 1), 1.5);
  check('down from 1 is 0.75', E.nextScale(1, -1), 0.75);
  check('up from 2 stays 2', E.nextScale(2, 1), 2);
  check('down from 0.5 stays 0.5', E.nextScale(0.5, -1), 0.5);
  check('an unknown scale steps from 1', E.nextScale(1.3, 1), 1.5);
}

/* ── rotation ────────────────────────────────────────────────────────── */
{
  check('clockwise from upright', E.nextRot(0, 1), 90);
  check('and round to upright again', [E.nextRot(90, 1), E.nextRot(180, 1), E.nextRot(270, 1)], [180, 270, 0]);
  check('anticlockwise wraps the other way', [E.nextRot(0, -1), E.nextRot(90, -1)], [270, 0]);
  check('a missing rotation is upright', E.nextRot(undefined, 1), 90);
  check('an off-step rotation starts again from upright', E.nextRot(45, 1), 90);
  const b = E.region({ size: 'M' }, 'room');
  const p = E.place(desk, b);
  const before = { x: p.x, y: p.y };
  p.rot = E.nextRot(p.rot, 1);
  E.clamp(p, desk, b);
  check('turning a piece does not move it', [p.x, p.y], [before.x, before.y]);
  check('the server accepts every quarter turn',
    ROTATIONS.map(rot => accepted({ ...defaultRoom('M'), props: [{ ...p, rot }] })), ROTATIONS.map(() => 'ok'));
  ok('but not an arbitrary angle',
    accepted({ ...defaultRoom('M'), props: [{ ...p, rot: 45 }] }).includes('rotation must be'));
}

/* ── reorder ─────────────────────────────────────────────────────────── */
{
  const arr = ['a', 'b', 'c'];
  check('forward moves later', [E.reorder(arr, 0, 1), arr], [1, ['b', 'a', 'c']]);
  check('back moves earlier', [E.reorder(arr, 2, -1), arr], [1, ['b', 'c', 'a']]);
  check('past the end stays', [E.reorder(arr, 2, 1), arr], [2, ['b', 'c', 'a']]);
  check('before the start stays', [E.reorder(arr, 0, -1), arr], [0, ['b', 'c', 'a']]);
  check('a bad index is returned unchanged', E.reorder(arr, 9, 1), 9);
}

/* ── list ────────────────────────────────────────────────────────────── */
{
  const room = { props: [1], setup: { props: [2] } };
  check('room list', E.list(room, 'room'), [1]);
  check('desk list', E.list(room, 'desk'), [2]);
  const bare = { props: [] };
  check('a room with no setup grows one', E.list(bare, 'desk'), []);
  ok('and keeps it', Array.isArray(bare.setup.props));
}

/* ── resize ──────────────────────────────────────────────────────────── */
{
  const room = defaultRoom('M');
  room.cells['11,7'] = room.floor;      // the far corner of an M room
  room.cells['2,2'] = room.floor;
  room.props.push({ id: desk.id, x: 1280, y: 800, scale: 1, flip: false });
  room.walls.back[3] = null;
  const wallFirst = room.walls.back[0];

  E.resize(room, 'S', piece, wallId);
  check('size becomes S', room.size, 'S');
  check('the back wall is 9 long', room.walls.back.length, 9);
  check('the sides are 6', [room.walls.left.length, room.walls.right.length], [6, 6]);
  check('existing wall cells are kept, gap included', room.walls.back[3], null);
  check('the far cell is dropped, the near one kept', Object.keys(room.cells), ['2,2']);
  /* Inside the REGION, which reaches WALL_H past the floor on three
     sides — not inside the floor rectangle. */
  ok('the prop is pulled back inside the smaller room',
    room.props[0].x + desk.w / 2 <= 9 * 128 + WALL_H);
  check('the server accepts the resized room', accepted(room), 'ok');

  E.resize(room, 'L', piece, wallId);
  check('growing fills the new cells with the run\'s first tile', room.walls.back.slice(9), Array(6).fill(wallFirst));
  check('the gap survives growing too', room.walls.back[3], null);
  check('the server accepts the grown room', accepted(room), 'ok');

  const empty = { size: 'M', floor: defaultRoom().floor, cells: {}, walls: { back: [], left: [], right: [] }, props: [] };
  E.resize(empty, 'S', piece, wallId);
  check('empty runs fill with the default wall', empty.walls.left, Array(6).fill(wallId));
  check('an unknown size changes nothing', E.resize({ size: 'M' }, 'XL', piece, wallId).size, 'M');
}

/* ── A rug and a desk placed by the core validate together ───────────── */
{
  const room = defaultRoom('L');
  const b = E.region(room, 'room');
  room.props.push(E.place(rug, b), E.place(desk, b));
  room.props[1].scale = E.nextScale(room.props[1].scale, 1);
  E.clamp(room.props[1], desk, b);
  room.props[1].flip = true;
  E.reorder(room.props, 1, -1);
  check('every step the core took is something the server accepts', accepted(room), 'ok');
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[room-edit-core] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[room-edit-core] ${passed} assertions passed.`);
console.log('');
process.exit(0);
