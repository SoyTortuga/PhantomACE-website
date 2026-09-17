#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MY ROOM — validator test suite

     node server/scripts/test-room-validator.js

   A room is one person's document rendered on everyone's page, so every
   field of it is either from the catalog or refused. This tries one bad
   field at a time against validateRoom() and checks the refusal names it,
   then checks what ownership and slots the inventory grants, and that the
   default room validates against itself.

   LOAD-BEARING (each fails this suite by exit code if removed): the
   ownership check, the surface check, the prop caps, the snap grid, the
   scale steps, the bounds.
   ══════════════════════════════════════════════ */

import {
  validateRoom, defaultRoom, ownedCategories, ownedPieces, basicCategories, roomSlots,
  piece, pieces, categories, SNAP, SCALES, SIZES, ROOM_PROP_CAP, SETUP, CELL,
} from '../../functions/api/room-catalog.js';
import { FOLLOWER_REWARDS, PHAMILY_REWARDS, MILESTONES } from '../../functions/api/phamily-rewards.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);
/** The refusal, or 'ok'. Tests read like sentences this way. */
const verdict = (input, owned, pieceIds) => { const v = validateRoom(input, owned, pieceIds); return v.ok ? 'ok' : v.error; };
const refuses = (label, input, owned, fragment) => {
  const r = verdict(input, owned);
  ok(`${label} → "${fragment}"`, r !== 'ok' && r.includes(fragment));
};

/* Pieces to build with, found by role rather than by name so the test
   survives a rebuild that moves things. */
const floorA = pieces().find(p => p.layer === 'floor');
const floorB = pieces().filter(p => p.layer === 'floor')[1];
const wallA = pieces().find(p => p.layer === 'wall');
const roomProp = pieces().find(p => categories()[p.category].surface === 'room' && p.layer === 'prop');
const deskProp = pieces().find(p => categories()[p.category].surface === 'desk');
const bothProp = pieces().find(p => categories()[p.category].surface === 'both');
const unlockRoomProp = pieces().find(p => categories()[p.category].surface === 'room' && categories()[p.category].tier === 'unlock' && p.layer === 'prop');
const unlockDeskProp = pieces().find(p => categories()[p.category].surface === 'desk' && categories()[p.category].tier === 'unlock');
const rug = pieces().find(p => p.layer === 'rug');

const ALL = new Set(Object.keys(categories()));
const BASIC = basicCategories();

const prop = (p, over = {}) => ({ id: p.id, x: 128, y: 128, scale: 1, flip: false, ...over });
const room = (over = {}) => ({ ...defaultRoom('M'), ...over });

/* ── The default room ────────────────────────────────────────────────── */
{
  const d = defaultRoom('M');
  check('default is M', d.size, 'M');
  check('default floor is a floor tile', piece(d.floor).layer, 'floor');
  check('default walls span the back', d.walls.back.length, SIZES.M.w);
  check('and both sides', [d.walls.left.length, d.walls.right.length], [SIZES.M.h, SIZES.M.h]);
  check('default has no items', [d.props.length, d.setup.props.length], [0, 0]);
  check('the default room validates with basic ownership', verdict(d, BASIC), 'ok');
  check('an unknown size falls back to M', defaultRoom('XL').size, 'M');
  check('L is 15x10', defaultRoom('L').walls.back.length, 15);
}

/* ── Shape ───────────────────────────────────────────────────────────── */
{
  refuses('not an object', 'room', BASIC, 'Not a room');
  refuses('an array', [], BASIC, 'Not a room');
  refuses('no ownership', room(), null, 'ownership');
  refuses('a bad size', room({ size: 'XL' }), BASIC, 'Size must be');
  refuses('no floor', room({ floor: null }), BASIC, 'no such piece');
  refuses('a prop as the floor', room({ floor: roomProp.id }), BASIC, 'not a floor tile');
  refuses('items not a list', room({ props: {} }), BASIC, 'must be a list');
  refuses('setup not a list', room({ setup: { props: 'x' } }), BASIC, 'desk setup');
  check('setup may be omitted', verdict(room({ setup: undefined }), BASIC), 'ok');
}

/* ── Cells ───────────────────────────────────────────────────────────── */
{
  check('a painted cell', verdict(room({ cells: { '3,4': floorB.id } }), BASIC), 'ok');
  refuses('a cell key that is not a cell', room({ cells: { 'a,b': floorB.id } }), BASIC, 'not a cell');
  refuses('a cell outside the room', room({ cells: { '12,0': floorB.id } }), BASIC, 'outside');
  refuses('a wall tile in a cell', room({ cells: { '0,0': wallA.id } }), BASIC, 'not a floor');
  refuses('cells not an object', room({ cells: [] }), BASIC, 'object');
  const v = validateRoom(room({ cells: { '3,4': floorB.id, junk: undefined } }), BASIC);
  ok('junk cell keys are refused rather than dropped', !v.ok);
}

/* ── Walls ───────────────────────────────────────────────────────────── */
{
  const w = defaultRoom('M').walls;
  refuses('a short back wall', room({ walls: { ...w, back: w.back.slice(1) } }), BASIC, 'back wall must have 12');
  refuses('a short side wall', room({ walls: { ...w, left: [] } }), BASIC, 'left wall must have 8');
  refuses('a floor tile as a wall', room({ walls: { ...w, back: w.back.map(() => floorA.id) } }), BASIC, 'not a wall tile');
  check('a gap in the wall is allowed', verdict(room({ walls: { ...w, back: w.back.map((id, i) => (i === 2 ? null : id)) } }), BASIC), 'ok');
  refuses('no walls at all', room({ walls: undefined }), BASIC, 'back wall');
}

/* ── Props on the room floor ─────────────────────────────────────────── */
{
  check('a room prop', verdict(room({ props: [prop(roomProp)] }), BASIC), 'ok');
  check('a rug', verdict(room({ props: [prop(rug)] }), BASIC), 'ok');
  check('a both-surface prop on the floor', verdict(room({ props: [prop(bothProp)] }), ALL), 'ok');
  refuses('a desk-only prop on the floor', room({ props: [prop(deskProp)] }), ALL, 'does not go on the room floor');
  refuses('a floor tile as a prop', room({ props: [prop(floorA)] }), BASIC, 'is a tile');
  refuses('an unknown id', room({ props: [prop({ id: 'desks-r99c99' })] }), BASIC, 'no such piece');
  refuses('not an item', room({ props: ['desks-r1c1'] }), BASIC, 'not an item');

  /* LOAD-BEARING: ownership. */
  refuses('an unlockable category not owned', room({ props: [prop(unlockRoomProp)] }), BASIC, 'not unlocked');
  check('the same prop when owned', verdict(room({ props: [prop(unlockRoomProp)] }), ALL), 'ok');

  /* LOAD-BEARING: scale steps, snap, bounds. */
  for (const s of SCALES) check(`scale ${s} is allowed`, verdict(room({ props: [prop(roomProp, { scale: s })] }), BASIC), 'ok');
  refuses('scale 1.3', room({ props: [prop(roomProp, { scale: 1.3 })] }), BASIC, 'scale must be');
  refuses('scale 3', room({ props: [prop(roomProp, { scale: 3 })] }), BASIC, 'scale must be');
  refuses('scale as text', room({ props: [prop(roomProp, { scale: '1' })] }), BASIC, 'scale must be');
  refuses('x off the snap grid', room({ props: [prop(roomProp, { x: SNAP + 1 })] }), BASIC, `${SNAP}px grid`);
  refuses('y off the snap grid', room({ props: [prop(roomProp, { y: 100 })] }), BASIC, `${SNAP}px grid`);
  refuses('a fractional x', room({ props: [prop(roomProp, { x: 32.5 })] }), BASIC, 'whole pixels');
  refuses('x as text', room({ props: [prop(roomProp, { x: '32' })] }), BASIC, 'whole pixels');
  refuses('far off the left', room({ props: [prop(roomProp, { x: -SNAP * 20 })] }), BASIC, 'off the edge');
  refuses('far off the bottom', room({ props: [prop(roomProp, { y: SIZES.M.h * CELL + SNAP * 8 })] }), BASIC, 'off the edge');
  check('half overhanging the left is fine', verdict(room({ props: [prop(roomProp, { x: -Math.floor(roomProp.w / 2 / SNAP) * SNAP })] }), BASIC), 'ok');
  refuses('flip missing', room({ props: [{ id: roomProp.id, x: 0, y: 0, scale: 1 }] }), BASIC, 'flip');
  refuses('flip as a string', room({ props: [prop(roomProp, { flip: 'yes' })] }), BASIC, 'flip');
  check('flip true', verdict(room({ props: [prop(roomProp, { flip: true })] }), BASIC), 'ok');

  /* LOAD-BEARING: the cap. */
  const many = Array.from({ length: ROOM_PROP_CAP }, () => prop(roomProp));
  check(`${ROOM_PROP_CAP} items is allowed`, verdict(room({ props: many }), BASIC), 'ok');
  refuses(`${ROOM_PROP_CAP + 1} items`, room({ props: [...many, prop(roomProp)] }), BASIC, `At most ${ROOM_PROP_CAP}`);

  /* The refusal names the item. */
  refuses('the third item is named', room({ props: [prop(roomProp), prop(roomProp), prop(deskProp)] }), ALL, 'Item 3');
}

/* ── Props on the desk ───────────────────────────────────────────────── */
{
  const dp = (p, over = {}) => ({ id: p.id, x: 256, y: 256, scale: 1, flip: false, ...over });
  check('a desk prop on the desk', verdict(room({ setup: { props: [dp(deskProp)] } }), ALL), 'ok');
  check('a both-surface prop on the desk', verdict(room({ setup: { props: [dp(bothProp)] } }), ALL), 'ok');
  refuses('a room-only prop on the desk', room({ setup: { props: [dp(roomProp)] } }), ALL, 'does not go on the desk');
  refuses('a desk prop not owned', room({ setup: { props: [dp(unlockDeskProp)] } }), BASIC, 'not unlocked');
  refuses('off the desk', room({ setup: { props: [dp(deskProp, { x: SETUP.w + SNAP * 8 })] } }), ALL, 'off the edge');
  refuses('desk errors say so', room({ setup: { props: [dp(deskProp, { scale: 7 })] } }), ALL, 'Desk: Item 1');
  const many = Array.from({ length: SETUP.cap }, () => dp(deskProp));
  check(`${SETUP.cap} desk items is allowed`, verdict(room({ setup: { props: many } }), ALL), 'ok');
  refuses(`${SETUP.cap + 1} desk items`, room({ setup: { props: [...many, dp(deskProp)] } }), ALL, `At most ${SETUP.cap}`);
}

/* ── The clean copy ──────────────────────────────────────────────────── */
{
  const dirty = room({
    props: [prop(roomProp, { onclick: 'alert(1)', extra: 1 })],
    setup: { props: [], junk: true },
    evil: '<script>', updatedAt: 1,
  });
  const v = validateRoom(dirty, BASIC);
  ok('a dirty room validates', v.ok);
  check('only known top-level fields survive', Object.keys(v.room).sort(), ['cells', 'floor', 'props', 'setup', 'size', 'walls']);
  check('only known prop fields survive', Object.keys(v.room.props[0]).sort(), ['flip', 'id', 'rot', 'scale', 'x', 'y']);
  check('setup keeps only its list', Object.keys(v.room.setup), ['props']);
  ok('the copy is not the input', v.room !== dirty && v.room.props !== dirty.props);
}

/* ── Ownership and slots from the inventory ──────────────────────────── */
{
  check('no inventory: the basic categories', [...ownedCategories(null)].sort(), [...BASIC].sort());
  ok('floor and walls are basic', BASIC.has('floor') && BASIC.has('wall'));
  ok('keyboards are not', !BASIC.has('keyboards'));
  const inv = { items: [
    { id: 'rs1', type: 'room-set', meta: { category: 'keyboards' } },
    { id: 'rs2', type: 'room-set', meta: { category: 'not-a-category' } },
    { id: 'b1', type: 'badge', meta: { category: 'monitors' } },        // wrong type: no unlock
    { id: 'sl1', type: 'room-slot' }, { id: 'sl2', type: 'room-slot' },
  ] };
  const owned = ownedCategories(inv);
  ok('a room-set unlocks its category', owned.has('keyboards'));
  ok('an unknown category unlocks nothing', owned.size === BASIC.size + 1);
  ok('a badge does not unlock a category', !owned.has('monitors'));
  check('one room plus a slot each', roomSlots(inv), 3);
  check('one room with no inventory', roomSlots(null), 1);
  check('one room with no slots', roomSlots({ items: [] }), 1);
}

/* ── Per-piece unlocks ───────────────────────────────────────────────
   The pass drips single pieces out of sets nobody owns outright, so
   "may they place this?" has two answers: the category, or the piece. */
{
  const locked = unlockRoomProp;                 // a room prop in an unlocked-only set
  const lockedDesk = unlockDeskProp;
  const onePiece = new Set([locked.id]);

  check('no inventory: no loose pieces', [...ownedPieces(null)], []);
  check('a room-piece item grants its piece', [...ownedPieces({ items: [
    { id: 'x', type: 'room-piece', meta: { piece: locked.id } },
  ] })], [locked.id]);
  check('a piece id that is not in the catalog grants nothing', [...ownedPieces({ items: [
    { id: 'x', type: 'room-piece', meta: { piece: 'snacks-r99c99' } },
  ] })], []);
  check('a room-set item grants no loose piece', [...ownedPieces({ items: [
    { id: 'x', type: 'room-set', meta: { category: 'snacks' } },
  ] })], []);
  check('and a room-piece grants no category',
    [...ownedCategories({ items: [{ id: 'x', type: 'room-piece', meta: { piece: locked.id } }] })].sort(),
    [...BASIC].sort());

  /* THE POINT OF THE WHOLE MECHANISM. */
  refuses('a prop from a locked set with no loose pieces', room({ props: [prop(locked)] }), BASIC, 'not unlocked');
  check('the same prop once that one piece is owned', verdict(room({ props: [prop(locked)] }), BASIC, onePiece), 'ok');
  const sibling = pieces().find(p => p.category === locked.category && p.id !== locked.id);
  const r = validateRoom(room({ props: [prop(sibling)] }), BASIC, onePiece);
  ok('but not its neighbour in the same set', !r.ok && r.error.includes('not unlocked'));

  check('a desk prop unlocked piece-wise',
    verdict(room({ setup: { props: [{ id: lockedDesk.id, x: 256, y: 256, scale: 1, flip: false }] } }),
      BASIC, new Set([lockedDesk.id])), 'ok');

  /* Floors and walls take the same rule — a painted tile from a locked
     set is a tile you were given, not a tile you own the set of. */
  const lockedFloor = pieces().find(p => p.layer === 'floor' && !BASIC.has(p.category));
  ok('floors are basic, so there is no locked floor to test', !lockedFloor);

  ok('an empty piece set behaves exactly as none',
    verdict(room({ props: [prop(locked)] }), BASIC, new Set()) === verdict(room({ props: [prop(locked)] }), BASIC));
  ok('owning the whole set still works when loose pieces are also passed',
    validateRoom(room({ props: [prop(locked)] }), ALL, new Set()).ok);
}

/* ── The pass and the catalog cannot drift apart ─────────────────────
   Every room reward names a piece or a category by id. A rebuild of the
   atlas that renamed something would make the pass grant items nothing
   can match — invisibly, because a grant does not fail. */
{
  const all = [...FOLLOWER_REWARDS, ...PHAMILY_REWARDS];
  const roomRewards = all.filter(r => r.type === 'room-piece' || r.type === 'room-set');
  ok('the pass carries room rewards at all', roomRewards.length > 0);

  const badPiece = all.filter(r => r.type === 'room-piece' && !piece(r.cosmeticId));
  check('every room-piece reward names a piece in the catalog', badPiece.map(r => r.cosmeticId), []);
  const badSet = all.filter(r => r.type === 'room-set' && !categories()[r.cosmeticId]);
  check('every room-set reward names a category in the catalog', badSet.map(r => r.cosmeticId), []);

  const milestoneBonuses = MILESTONES.flatMap(m => m.bonusItems || []);
  const badMsSet = milestoneBonuses.filter(b => b.type === 'room-set' && !categories()[b.cosmeticId]);
  check('every milestone room-set names a category', badMsSet.map(b => b.cosmeticId), []);
  const msSlots = milestoneBonuses.filter(b => b.type === 'room-slot');
  ok('every milestone room-slot carries an id, or they would collide', msSlots.every(b => !!b.cosmeticId));
  check('the slot ids are distinct', new Set(msSlots.map(b => b.cosmeticId)).size, msSlots.length);

  /* A piece may only be dripped by a set that is NOT already basic —
     granting a piece of a set everyone has would be a dead reward. */
  const pointless = all.filter(r => r.type === 'room-piece' && BASIC.has(piece(r.cosmeticId).category));
  check('no reward drips a piece everybody already has', pointless.map(r => r.cosmeticId), []);

  /* Nothing is granted twice on one track. */
  for (const [name, list] of [['follower', FOLLOWER_REWARDS], ['sub', PHAMILY_REWARDS]]) {
    const ids = list.filter(r => r.type === 'room-piece').map(r => r.cosmeticId);
    check(`${name}: no piece dripped twice`, ids.length - new Set(ids).size, 0);
  }
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[room-validator] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[room-validator] ${passed} assertions passed.`);
console.log('');
process.exit(0);
