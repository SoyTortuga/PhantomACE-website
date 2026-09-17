/* ══════════════════════════════════════════════
   MY ROOM — the editor's arithmetic

   Everything the editor decides about a room that does not need a DOM:
   where a new piece lands, how a dragged piece snaps and where it may
   stop, what the next scale step is, how the order list moves, and what
   happens to walls, cells and props when the room changes size. Pure,
   so server/scripts/test-room-edit-core.js can check each rule, and so
   the rules match the validator's (a piece the editor allows must be one
   the server accepts — the constants below are the validator's).

   Loaded as a plain script; exposes window.PhamRoomEdit.
   ══════════════════════════════════════════════ */

(function (root) {
  'use strict';

  var SNAP = 32;
  var CELL = 128;
  var SCALES = [0.5, 0.75, 1, 1.5, 2];
  var ROTATIONS = [0, 90, 180, 270];
  var WALL_H = 176;
  var SIZES = { S: { w: 9, h: 6 }, M: { w: 12, h: 8 }, L: { w: 15, h: 10 } };
  var SETUP = { w: 1024, h: 576 };
  var CAPS = { room: 100, desk: 40 };

  function snap(v) { return Math.round(v / SNAP) * SNAP; }

  /** The region a prop's CENTRE may occupy, in floor-relative pixels.
      The room's includes the wall band — WALL_H deep across the back and
      down both sides — so wall-hung pieces can actually reach a wall.
      Must match placementRegion() in functions/api/room-catalog.js. */
  function region(room, surface) {
    if (surface === 'desk') return { x0: 0, y0: 0, x1: SETUP.w, y1: SETUP.h };
    var d = SIZES[room.size] || SIZES.M;
    return { x0: -WALL_H, y0: -WALL_H, x1: d.w * CELL + WALL_H, y1: d.h * CELL };
  }

  function list(room, surface) {
    if (surface === 'desk') {
      if (!room.setup) room.setup = { props: [] };
      return room.setup.props;
    }
    return room.props;
  }

  /** Snap a prop to the grid and keep its centre inside the region — the
      same rule the server validates with, so the editor cannot produce a
      placement the server refuses. */
  function clamp(prop, piece, rg) {
    var hw = (piece.w * prop.scale) / 2, hh = (piece.h * prop.scale) / 2;
    var x = snap(Math.min(Math.max(prop.x + hw, rg.x0), rg.x1) - hw);
    var y = snap(Math.min(Math.max(prop.y + hh, rg.y0), rg.y1) - hh);
    /* Snapping can push the centre a little back out; one step fixes it. */
    if (x + hw < rg.x0) x += SNAP;
    if (x + hw > rg.x1) x -= SNAP;
    if (y + hh < rg.y0) y += SNAP;
    if (y + hh > rg.y1) y -= SNAP;
    prop.x = x;
    prop.y = y;
    return prop;
  }

  /** A new prop, centred in the region. */
  function place(piece, rg) {
    var prop = {
      id: piece.id,
      x: (rg.x0 + rg.x1) / 2 - piece.w / 2,
      y: (rg.y0 + rg.y1) / 2 - piece.h / 2,
      scale: 1, rot: 0, flip: false,
    };
    return clamp(prop, piece, rg);
  }

  /** The scale one step up (+1) or down (-1); the same at the ends. */
  function nextScale(scale, dir) {
    var i = SCALES.indexOf(scale);
    if (i < 0) i = SCALES.indexOf(1);
    return SCALES[Math.max(0, Math.min(SCALES.length - 1, i + dir))];
  }

  /** A quarter turn clockwise (+1) or anticlockwise (-1), wrapping. */
  function nextRot(rot, dir) {
    var i = ROTATIONS.indexOf(rot || 0);
    if (i < 0) i = 0;
    return ROTATIONS[(i + dir + ROTATIONS.length) % ROTATIONS.length];
  }

  /** Move item i one step later (+1, drawn over more) or earlier (-1).
      Returns the new index. */
  function reorder(arr, i, dir) {
    var j = i + dir;
    if (i < 0 || i >= arr.length || j < 0 || j >= arr.length) return i;
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    return j;
  }

  /** A run of wall cells resized: keep what is there, fill the rest with
      the first tile already in the run, or the given default. */
  function resizeRun(run, length, fill) {
    var out = [];
    var first = null;
    (run || []).forEach(function (id) { if (first === null && id) first = id; });
    for (var i = 0; i < length; i++) out.push(run && i < run.length ? run[i] : (first || fill || null));
    return out;
  }

  /** Change a room's size in place: walls re-run to the new lengths, cells
      outside the new floor dropped, props pulled back inside it. `pieceOf`
      looks up a catalog entry by id. */
  function resize(room, size, pieceOf, wallFill) {
    var d = SIZES[size];
    if (!d) return room;
    room.size = size;
    var w = room.walls || (room.walls = { back: [], left: [], right: [] });
    w.back = resizeRun(w.back, d.w, wallFill);
    w.left = resizeRun(w.left, d.h, wallFill);
    w.right = resizeRun(w.right, d.h, wallFill);
    var cells = room.cells || {};
    var kept = {};
    Object.keys(cells).forEach(function (k) {
      var m = /^(\d+),(\d+)$/.exec(k);
      if (m && Number(m[1]) < d.w && Number(m[2]) < d.h) kept[k] = cells[k];
    });
    room.cells = kept;
    var rg = region(room, 'room');
    (room.props || []).forEach(function (p) {
      var piece = pieceOf(p.id);
      if (piece) clamp(p, piece, rg);
    });
    return room;
  }

  root.PhamRoomEdit = {
    SNAP: SNAP, CELL: CELL, SCALES: SCALES, ROTATIONS: ROTATIONS, WALL_H: WALL_H,
    SIZES: SIZES, SETUP: SETUP, CAPS: CAPS,
    snap: snap, region: region, list: list, clamp: clamp, place: place,
    nextScale: nextScale, nextRot: nextRot, reorder: reorder, resizeRun: resizeRun, resize: resize,
  };
})(typeof window !== 'undefined' ? window : globalThis);
