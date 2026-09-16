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
  var SIZES = { S: { w: 9, h: 6 }, M: { w: 12, h: 8 }, L: { w: 15, h: 10 } };
  var SETUP = { w: 1024, h: 576 };
  var CAPS = { room: 100, desk: 40 };

  function snap(v) { return Math.round(v / SNAP) * SNAP; }

  /** The canvas a surface's props live in. */
  function bounds(room, surface) {
    if (surface === 'desk') return { w: SETUP.w, h: SETUP.h };
    var d = SIZES[room.size] || SIZES.M;
    return { w: d.w * CELL, h: d.h * CELL };
  }

  function list(room, surface) {
    if (surface === 'desk') {
      if (!room.setup) room.setup = { props: [] };
      return room.setup.props;
    }
    return room.props;
  }

  /** Snap a prop to the grid and keep it within the half-overhang rule
      the server enforces: no further out than half its drawn size. */
  function clamp(prop, piece, b) {
    var dw = piece.w * prop.scale, dh = piece.h * prop.scale;
    var x = snap(prop.x), y = snap(prop.y);
    while (x < -dw / 2) x += SNAP;
    while (x + dw / 2 > b.w) x -= SNAP;
    while (y < -dh / 2) y += SNAP;
    while (y + dh / 2 > b.h) y -= SNAP;
    prop.x = x;
    prop.y = y;
    return prop;
  }

  /** A new prop, centred on the canvas. */
  function place(piece, b) {
    var prop = { id: piece.id, x: b.w / 2 - piece.w / 2, y: b.h / 2 - piece.h / 2, scale: 1, flip: false };
    return clamp(prop, piece, b);
  }

  /** The scale one step up (+1) or down (-1); the same at the ends. */
  function nextScale(scale, dir) {
    var i = SCALES.indexOf(scale);
    if (i < 0) i = SCALES.indexOf(1);
    return SCALES[Math.max(0, Math.min(SCALES.length - 1, i + dir))];
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
    var b = bounds(room, 'room');
    (room.props || []).forEach(function (p) {
      var piece = pieceOf(p.id);
      if (piece) clamp(p, piece, b);
    });
    return room;
  }

  root.PhamRoomEdit = {
    SNAP: SNAP, CELL: CELL, SCALES: SCALES, SIZES: SIZES, SETUP: SETUP, CAPS: CAPS,
    snap: snap, bounds: bounds, list: list, clamp: clamp, place: place,
    nextScale: nextScale, reorder: reorder, resizeRun: resizeRun, resize: resize,
  };
})(typeof window !== 'undefined' ? window : globalThis);
