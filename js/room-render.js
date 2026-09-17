/* ══════════════════════════════════════════════
   MY ROOM — the renderer

   Turns a room document and the piece catalog into markup: a fixed-size
   stage of absolutely positioned <img>s, drawn at native pixel size with
   image-rendering: pixelated, then scaled as a whole to fit wherever it
   is shown. One renderer, used read-only on the profile and live in the
   editor, so a room can never look different in the two places.

   Geometry (all in room pixels, before fitting):

     stage = [ side wall | floor | side wall ]  wide,  [ back wall / floor ] tall
     WALL_H (176) on the top and both sides; the floor is w×h cells of 128.
     Props are positioned relative to the FLOOR's top-left corner.

   The side walls are the same face tiles as the back, rotated so their
   baseboard meets the floor: -90° on the left, +90° on the right.

   The desk setup is a second, fixed stage: the back-wall tile repeated
   behind, a desk surface across the lower third, props on top.

   Pure: no fetching, no document access except to make elements when
   asked to fit. Loaded as a plain script; exposes window.PhamRoom.
   ══════════════════════════════════════════════ */

(function (root) {
  'use strict';

  var CELL = 128;
  var WALL_H = 176;
  var SIZES = { S: { w: 9, h: 6 }, M: { w: 12, h: 8 }, L: { w: 15, h: 10 } };
  var SETUP = { w: 1024, h: 576, deskTop: 384 };
  var PIECES_URL = '/assets/room/pieces/';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** The catalog with a by-id map added once. */
  function index(catalog) {
    if (!catalog.byId) {
      catalog.byId = {};
      (catalog.pieces || []).forEach(function (p) { catalog.byId[p.id] = p; });
    }
    return catalog;
  }

  function pieceOf(catalog, id) {
    return (catalog.byId && catalog.byId[id]) || null;
  }

  function src(p) {
    return PIECES_URL + encodeURIComponent(p.category) + '/' + encodeURIComponent(p.id) + '.png';
  }

  function img(p, x, y, w, h, cls, extra) {
    return '<img class="rm-piece ' + (cls || '') + '" src="' + esc(src(p)) + '" alt="" draggable="false" ' +
      'style="left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px' + (extra || '') + '">';
  }

  /** One placed prop, at an offset. `i` is its index in the list, kept
      on the element so an editor can find it again. */
  function propHtml(catalog, prop, ox, oy, i) {
    var p = pieceOf(catalog, prop.id);
    if (!p) return '';
    var scale = Number(prop.scale) || 1;
    var w = Math.round(p.w * scale), h = Math.round(p.h * scale);
    /* Right to left, so the sprite is rotated first and THEN mirrored:
       Flip always reads as left-right on screen whatever the rotation.
       Both turn about the element's centre, so neither moves the piece —
       which is why placement never has to know about rotation. */
    var t = [];
    if (prop.flip) t.push('scaleX(-1)');
    if (prop.rot) t.push('rotate(' + prop.rot + 'deg)');
    var transform = t.length ? ';transform:' + t.join(' ') : '';
    return '<img class="rm-piece rm-prop" src="' + esc(src(p)) + '" alt="" draggable="false" data-index="' + i + '" ' +
      'style="left:' + (ox + prop.x) + 'px;top:' + (oy + prop.y) + 'px;width:' + w + 'px;height:' + h + 'px' + transform + '">';
  }

  /** Rugs under everything, then list order. Stable, so two rugs keep
      their own order too. */
  function drawOrder(catalog, props) {
    var out = props.map(function (p, i) { return { p: p, i: i }; });
    out.sort(function (a, b) {
      var ra = (pieceOf(catalog, a.p.id) || {}).layer === 'rug' ? 0 : 1;
      var rb = (pieceOf(catalog, b.p.id) || {}).layer === 'rug' ? 0 : 1;
      return ra - rb || a.i - b.i;
    });
    return out;
  }

  /** The room stage. Returns { html, w, h } — the markup and its natural size. */
  function build(room, catalog) {
    index(catalog);
    var dims = SIZES[room.size] || SIZES.M;
    var roomW = dims.w * CELL, roomH = dims.h * CELL;
    var ox = WALL_H, oy = WALL_H;
    var stageW = WALL_H + roomW + WALL_H, stageH = WALL_H + roomH;
    var html = '';

    /* Floor: the base tile repeated, then any painted cells on top. */
    var floor = pieceOf(catalog, room.floor);
    html += '<div class="rm-floor" style="left:' + ox + 'px;top:' + oy + 'px;width:' + roomW + 'px;height:' + roomH + 'px' +
      (floor ? ';background-image:url(' + esc(src(floor)) + ')' : '') + '"></div>';
    var cells = room.cells || {};
    Object.keys(cells).forEach(function (key) {
      var m = /^(\d+),(\d+)$/.exec(key);
      var p = m && pieceOf(catalog, cells[key]);
      if (!p) return;
      html += img(p, ox + Number(m[1]) * CELL, oy + Number(m[2]) * CELL, CELL, CELL, 'rm-cell');
    });

    /* Walls: corners as plain blocks, the back across the top, the sides
       rotated so their baseboards meet the floor. */
    var walls = room.walls || {};
    html += '<div class="rm-corner" style="left:0;top:0;width:' + WALL_H + 'px;height:' + WALL_H + 'px"></div>';
    html += '<div class="rm-corner" style="left:' + (ox + roomW) + 'px;top:0;width:' + WALL_H + 'px;height:' + WALL_H + 'px"></div>';
    (walls.back || []).forEach(function (id, i) {
      var p = pieceOf(catalog, id);
      if (p) html += img(p, ox + i * CELL, 0, CELL, WALL_H, 'rm-wall rm-wall-back');
    });
    /* A 128×176 tile rotated a quarter turn occupies 176×128. Positioning
       its unrotated box so the centres coincide puts the rotated tile
       exactly in the 176-wide band beside row j. */
    var dx = (WALL_H - CELL) / 2;
    (walls.left || []).forEach(function (id, j) {
      var p = pieceOf(catalog, id);
      if (p) html += img(p, dx, oy + j * CELL - dx, CELL, WALL_H, 'rm-wall rm-wall-left', ';transform:rotate(-90deg)');
    });
    (walls.right || []).forEach(function (id, j) {
      var p = pieceOf(catalog, id);
      if (p) html += img(p, ox + roomW + dx, oy + j * CELL - dx, CELL, WALL_H, 'rm-wall rm-wall-right', ';transform:rotate(90deg)');
    });

    /* Props, rugs first. */
    drawOrder(catalog, room.props || []).forEach(function (e) {
      html += propHtml(catalog, e.p, ox, oy, e.i);
    });

    return { html: html, w: stageW, h: stageH, floor: { x: ox, y: oy, w: roomW, h: roomH } };
  }

  /** The desk setup stage. */
  function buildSetup(room, catalog) {
    index(catalog);
    var back = (room.walls && room.walls.back && room.walls.back.find(function (id) { return !!id; })) || null;
    var wall = back ? pieceOf(catalog, back) : null;
    var html = '<div class="rm-setup-wall" style="left:0;top:0;width:' + SETUP.w + 'px;height:' + SETUP.deskTop + 'px' +
      (wall ? ';background-image:url(' + esc(src(wall)) + ')' : '') + '"></div>';
    html += '<div class="rm-setup-desk" style="left:0;top:' + SETUP.deskTop + 'px;width:' + SETUP.w + 'px;height:' + (SETUP.h - SETUP.deskTop) + 'px"></div>';
    var props = (room.setup && room.setup.props) || [];
    drawOrder(catalog, props).forEach(function (e) {
      html += propHtml(catalog, e.p, 0, 0, e.i);
    });
    return { html: html, w: SETUP.w, h: SETUP.h };
  }

  /** Put a built stage into a host element and scale it to the host's
      width. Call again on resize. Returns the scale used.

      `minScale` stops it shrinking past the point of usefulness: on a
      phone a 12x8 room fits 375px only at 0.17, which draws a floor tile
      22px across and a keyboard the size of a full stop. Passing a
      minimum makes the stage overflow its host instead, and the host
      scrolls — the ordinary answer for a canvas bigger than the screen.
      The profile passes none: there, small but whole is what is wanted. */
  function mount(host, built, minScale) {
    host.innerHTML = '<div class="rm-stage" style="width:' + built.w + 'px;height:' + built.h + 'px">' + built.html + '</div>';
    return fit(host, minScale);
  }

  function fit(host, minScale) {
    var stage = host.querySelector('.rm-stage');
    if (!stage) return 1;
    var w = parseFloat(stage.style.width), h = parseFloat(stage.style.height);
    var avail = host.clientWidth || w;
    var s = Math.min(1, avail / w);
    if (minScale && s < minScale) s = minScale;
    stage.style.transform = 'scale(' + s + ')';
    /* The height the scaled stage needs. CSS may cap it — the editor
       does on a narrow screen — and then the host scrolls. */
    host.style.height = Math.round(h * s) + 'px';
    host.dataset.scale = String(s);
    return s;
  }

  root.PhamRoom = {
    CELL: CELL, WALL_H: WALL_H, SIZES: SIZES, SETUP: SETUP,
    index: index, piece: pieceOf, src: src,
    build: build, buildSetup: buildSetup, mount: mount, fit: fit,
  };
})(typeof window !== 'undefined' ? window : globalThis);
