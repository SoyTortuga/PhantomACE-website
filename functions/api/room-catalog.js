/* ══════════════════════════════════════════════
   MY ROOM — the catalog, the rules, and the validator

   A room is public content built by one person and rendered on a page
   everyone else reads, so it is the same kind of thing as a favourite
   dino: every field either comes from a server-held list or is refused.
   This module is that list and that refusal.

   validateRoom(input, owned) is PURE: it takes the document a browser
   sent and the set of categories the owner may use, and returns either
   { ok: true, room } — a clean copy with only the known fields — or
   { ok: false, error } with a message a person can read. Nothing async,
   nothing from env, so server/scripts/test-room-validator.js can try one
   bad field at a time and a mutation can prove each check is real.

   The catalog is assets/room/catalog.json, built by tools/build-room-atlas.py
   from the asset pack and read once here at import.

   Library, not a route: declared in NON_ROUTE_MODULES.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';

const CATALOG = JSON.parse(fs.readFileSync(new URL('../../assets/room/catalog.json', import.meta.url), 'utf8'));

export const CELL = CATALOG.cell;                       // 128
export const WALL_H = 176;
export const SNAP = 32;                                  // props sit on a quarter-cell grid
export const SCALES = [0.5, 0.75, 1, 1.5, 2];
export const SIZES = { S: { w: 9, h: 6 }, M: { w: 12, h: 8 }, L: { w: 15, h: 10 } };
export const ROOM_PROP_CAP = 100;
export const SETUP = { w: 1024, h: 576, cap: 40 };
export const DEFAULT_SIZE = 'M';

const BY_ID = new Map(CATALOG.pieces.map(p => [p.id, p]));
const CATEGORIES = CATALOG.categories;

export function piece(id) { return BY_ID.get(String(id)) || null; }
export function categories() { return CATEGORIES; }
export function pieces() { return CATALOG.pieces; }

/** The categories everyone has. */
export function basicCategories() {
  return new Set(Object.entries(CATEGORIES).filter(([, c]) => c.tier === 'basic').map(([k]) => k));
}

/** The categories THIS person has: the basic ones, plus every `room-set`
    item in their inventory whose meta.category is real. */
export function ownedCategories(inventory) {
  const owned = basicCategories();
  const items = inventory && Array.isArray(inventory.items) ? inventory.items : [];
  for (const it of items) {
    if (!it || it.type !== 'room-set') continue;
    const cat = it.meta && it.meta.category;
    if (cat && CATEGORIES[cat]) owned.add(cat);
  }
  return owned;
}

/** Single pieces out of sets they do NOT own outright.
 *
 * TWO GRAINS OF UNLOCK, ON PURPOSE. A `room-set` opens a whole category;
 * a `room-piece` opens one piece of one. The Phamily Time pass drips
 * pieces — roughly a tenth of each set a month — so somebody working the
 * pass owns a handful of keyboards long before they own "keyboards".
 * Anything that asks "may they use this?" has to ask both. */
export function ownedPieces(inventory) {
  const out = new Set();
  const items = inventory && Array.isArray(inventory.items) ? inventory.items : [];
  for (const it of items) {
    if (!it || it.type !== 'room-piece') continue;
    const id = it.meta && it.meta.piece;
    if (id && BY_ID.has(id)) out.add(String(id));
  }
  return out;
}

/** May this person place this piece? The category, or the piece itself. */
export function mayUse(p, owned, pieceIds) {
  return owned.has(p.category) || !!(pieceIds && pieceIds.has(p.id));
}

/** How many rooms this person may keep: one, plus a `room-slot` item each. */
export function roomSlots(inventory) {
  const items = inventory && Array.isArray(inventory.items) ? inventory.items : [];
  return 1 + items.filter(it => it && it.type === 'room-slot').length;
}

/** An empty room: a plain floor, walls on the back and sides, nothing in
    it. What a profile shows when nobody has built anything yet. */
export function defaultRoom(size = DEFAULT_SIZE) {
  const dims = SIZES[size] || SIZES[DEFAULT_SIZE];
  const floor = CATALOG.pieces.find(p => p.layer === 'floor');
  const wall = CATALOG.pieces.find(p => p.layer === 'wall');
  return {
    size: SIZES[size] ? size : DEFAULT_SIZE,
    floor: floor ? floor.id : null,
    cells: {},
    walls: {
      back: Array.from({ length: dims.w }, () => (wall ? wall.id : null)),
      left: Array.from({ length: dims.h }, () => (wall ? wall.id : null)),
      right: Array.from({ length: dims.h }, () => (wall ? wall.id : null)),
    },
    props: [],
    setup: { props: [] },
  };
}

/* ── The validator ──────────────────────────────────────────────────── */

const bad = (error) => ({ ok: false, error });
const isInt = (n) => Number.isInteger(n);
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

function validateTile(id, layer, owned, what, pieceIds) {
  const p = piece(id);
  if (!p) return `${what}: no such piece.`;
  if (p.layer !== layer) return `${what}: ${p.id} is not a ${layer} tile.`;
  if (!mayUse(p, owned, pieceIds)) return `${what}: you have not unlocked ${p.category}.`;
  return null;
}

function validateWallRun(run, length, owned, what, pieceIds) {
  if (!Array.isArray(run) || run.length !== length) return `${what} wall must have ${length} cells.`;
  for (const id of run) {
    if (id === null) continue;
    const err = validateTile(id, 'wall', owned, `${what} wall`, pieceIds);
    if (err) return err;
  }
  return null;
}

/** One placed prop. `surface` is 'room' or 'desk'; `bounds` the canvas. */
function validateProp(raw, i, surface, bounds, owned, pieceIds) {
  const what = `Item ${i + 1}`;
  if (!plain(raw)) return { error: `${what}: not an item.` };
  const p = piece(raw.id);
  if (!p) return { error: `${what}: no such piece.` };
  if (p.layer === 'floor' || p.layer === 'wall') return { error: `${what}: ${p.id} is a tile, not an item.` };
  const cat = CATEGORIES[p.category];
  if (cat.surface !== 'both' && cat.surface !== surface) {
    return { error: `${what}: ${p.category} does not go on the ${surface === 'desk' ? 'desk' : 'room floor'}.` };
  }
  if (!mayUse(p, owned, pieceIds)) return { error: `${what}: you have not unlocked ${p.category}.` };

  /* A number, not something that converts to one: "1" where 1 belongs is
     a client that is wrong about the format, and refusing it now is
     cheaper than a renderer that trusts the type later. */
  const scale = raw.scale;
  if (typeof scale !== 'number' || !SCALES.includes(scale)) {
    return { error: `${what}: scale must be one of ${SCALES.join(', ')}.` };
  }
  const x = raw.x, y = raw.y;
  if (!isInt(x) || !isInt(y)) return { error: `${what}: position must be whole pixels.` };
  if (x % SNAP !== 0 || y % SNAP !== 0) return { error: `${what}: position must sit on the ${SNAP}px grid.` };
  /* A piece may overhang an edge by up to half its drawn size, so a
     shelf can sit against a wall; further than that and it is off the
     room. */
  const dw = p.w * scale, dh = p.h * scale;
  if (x < -dw / 2 || y < -dh / 2 || x + dw / 2 > bounds.w || y + dh / 2 > bounds.h) {
    return { error: `${what}: off the edge.` };
  }
  if (typeof raw.flip !== 'boolean') return { error: `${what}: flip must be true or false.` };
  return { prop: { id: p.id, x, y, scale, flip: raw.flip } };
}

/**
 * Validate a room document from a browser against the catalog, the
 * limits, and what the owner has: `owned` the categories, `pieceIds` the
 * single pieces out of sets they do not own. Returns a clean copy.
 */
export function validateRoom(input, owned, pieceIds) {
  if (!plain(input)) return bad('Not a room.');
  if (!(owned instanceof Set)) return bad('No ownership given.');

  const size = String(input.size || '');
  const dims = SIZES[size];
  if (!dims) return bad(`Size must be one of ${Object.keys(SIZES).join(', ')}.`);
  const roomW = dims.w * CELL, roomH = dims.h * CELL;

  const floorErr = validateTile(input.floor, 'floor', owned, 'Floor', pieceIds);
  if (floorErr) return bad(floorErr);

  const cells = {};
  if (input.cells !== undefined) {
    if (!plain(input.cells)) return bad('Cells must be an object.');
    for (const [key, id] of Object.entries(input.cells)) {
      const m = /^(\d{1,2}),(\d{1,2})$/.exec(key);
      if (!m) return bad(`Cell "${key}": not a cell.`);
      const c = Number(m[1]), r = Number(m[2]);
      if (c >= dims.w || r >= dims.h) return bad(`Cell "${key}": outside a ${size} room.`);
      const err = validateTile(id, 'floor', owned, `Cell "${key}"`, pieceIds);
      if (err) return bad(err);
      cells[`${c},${r}`] = piece(id).id;
    }
  }

  const w = plain(input.walls) ? input.walls : {};
  for (const [side, len] of [['back', dims.w], ['left', dims.h], ['right', dims.h]]) {
    const err = validateWallRun(w[side], len, owned, side, pieceIds);
    if (err) return bad(err);
  }

  if (!Array.isArray(input.props)) return bad('Items must be a list.');
  if (input.props.length > ROOM_PROP_CAP) return bad(`At most ${ROOM_PROP_CAP} items in a room.`);
  const props = [];
  for (let i = 0; i < input.props.length; i++) {
    const v = validateProp(input.props[i], i, 'room', { w: roomW, h: roomH }, owned, pieceIds);
    if (v.error) return bad(v.error);
    props.push(v.prop);
  }

  const setupIn = input.setup === undefined ? { props: [] } : input.setup;
  if (!plain(setupIn) || !Array.isArray(setupIn.props)) return bad('The desk setup must be a list of items.');
  if (setupIn.props.length > SETUP.cap) return bad(`At most ${SETUP.cap} items on the desk.`);
  const setup = [];
  for (let i = 0; i < setupIn.props.length; i++) {
    const v = validateProp(setupIn.props[i], i, 'desk', { w: SETUP.w, h: SETUP.h }, owned, pieceIds);
    if (v.error) return bad(`Desk: ${v.error}`);
    setup.push(v.prop);
  }

  return {
    ok: true,
    room: {
      size,
      floor: piece(input.floor).id,
      cells,
      walls: { back: [...w.back], left: [...w.left], right: [...w.right] },
      props,
      setup: { props: setup },
    },
  };
}
