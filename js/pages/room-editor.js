/* ══════════════════════════════════════════════
   MY ROOM — the editor at /room/edit

   The same renderer as the profile (PhamRoom) with a palette beside it
   and pointer handling over it. Everything the editor changes is a plain
   room document in memory; every change goes through PhamRoomEdit so
   the result is something the server will accept; Save posts it and
   shows the server's answer as written.

   Layout: palette (categories, then a category's pieces) on the left;
   toolbar (room switcher, size, Room/Desk tab, undo, save) above the
   stage; inspector (scale, flip, order, delete) under it for the
   selected piece. Floor and wall tiles are painted: pick one, click
   cells. Props are placed by clicking a piece, then dragged.

   Undo is a stack of JSON snapshots taken before each change — simple,
   and correct by construction.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var R = window.PhamRoom, E = window.PhamRoomEdit;
  var state = {
    catalog: null, rooms: [], current: 0, publicIndex: 0, slots: 1, owned: new Set(),
    tab: 'room',                 // 'room' | 'desk'
    category: null,              // palette category open
    tool: null,                  // null (select) | { paint: id, layer: 'floor' | 'wall' }
    selected: null,              // index into the current tab's prop list
    undo: [], dirty: false,
  };
  var els = {};

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function me() { try { return typeof getSession === 'function' ? getSession() : null; } catch (e) { return null; } }
  function room() { return state.rooms[state.current]; }
  function props() { return E.list(room(), state.tab); }
  function pieceOf(id) { return R.piece(state.catalog, id); }
  function surfaceOk(cat) { var s = state.catalog.categories[cat].surface; return s === 'both' || s === state.tab; }

  function api(path, body) {
    var opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' }
      : { cache: 'no-store' };
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }

  function status(msg, kind) {
    els.status.textContent = msg;
    els.status.className = 're-status' + (kind ? ' re-status-' + kind : '');
    els.status.hidden = !msg;
  }

  /* ── Changes: snapshot, then mutate, then redraw ─────────────────── */
  function snapshot() {
    state.undo.push(JSON.stringify(room()));
    if (state.undo.length > 60) state.undo.shift();
    state.dirty = true;
  }
  function undo() {
    if (!state.undo.length) return;
    state.rooms[state.current] = JSON.parse(state.undo.pop());
    state.selected = null;
    redraw();
    renderToolbar();
  }

  /* ── Drawing ─────────────────────────────────────────────────────── */
  function redraw() {
    var built = state.tab === 'desk' ? R.buildSetup(room(), state.catalog) : R.build(room(), state.catalog);
    R.mount(els.stage, built);
    els.stage.dataset.floorX = built.floor ? built.floor.x : 0;
    els.stage.dataset.floorY = built.floor ? built.floor.y : 0;
    if (state.selected != null) {
      var el = els.stage.querySelector('[data-index="' + state.selected + '"]');
      if (el) el.classList.add('rm-selected');
    }
    els.stage.classList.toggle('re-painting', !!state.tool);
    renderInspector();
  }

  function renderToolbar() {
    var r = room();
    var html = '';
    if (state.slots > 1) {
      html += '<label class="re-field">Room <select id="reRoomPick">' +
        state.rooms.map(function (_, i) {
          return '<option value="' + i + '"' + (i === state.current ? ' selected' : '') + '>Room ' + (i + 1) + (i === state.publicIndex ? ' (on profile)' : '') + '</option>';
        }).join('') + '</select></label>';
      if (state.current !== state.publicIndex) html += '<button type="button" class="pill-btn" data-act="public">Show on profile</button>';
    }
    html += '<label class="re-field">Size <select id="reSize">' +
      ['S', 'M', 'L'].map(function (s) { return '<option value="' + s + '"' + (r.size === s ? ' selected' : '') + '>' + s + ' · ' + E.SIZES[s].w + '×' + E.SIZES[s].h + '</option>'; }).join('') +
      '</select></label>';
    html += '<div class="re-tabs">' +
      '<button type="button" class="re-tab' + (state.tab === 'room' ? ' active' : '') + '" data-tab="room">Room</button>' +
      '<button type="button" class="re-tab' + (state.tab === 'desk' ? ' active' : '') + '" data-tab="desk">Desk setup</button></div>';
    html += '<div class="re-spacer"></div>';
    html += '<button type="button" class="pill-btn" data-act="undo"' + (state.undo.length ? '' : ' disabled') + '>Undo</button>';
    html += '<button type="button" class="pill-btn" data-act="clear">Clear</button>';
    html += '<button type="button" class="btn-primary re-save" data-act="save">Save</button>';
    els.toolbar.innerHTML = html;
  }

  function renderPalette() {
    var cats = state.catalog.categories;
    var names = Object.keys(cats).filter(function (c) { return surfaceOk(c); });
    var html = '<div class="re-cats">' + names.map(function (c) {
      var locked = !state.owned.has(c);
      return '<button type="button" class="re-cat' + (state.category === c ? ' active' : '') + (locked ? ' locked' : '') + '" data-cat="' + esc(c) + '">' +
        esc(c.replace(/-/g, ' ')) + (locked ? ' <span class="re-lock" title="Unlocked around the site">🔒</span>' : '') + '</button>';
    }).join('') + '</div>';

    if (state.category) {
      var c = state.category;
      var locked = !state.owned.has(c);
      var list = state.catalog.pieces.filter(function (p) { return p.category === c; });
      html += '<div class="re-pieces' + (locked ? ' locked' : '') + '">';
      if (locked) html += '<p class="re-hint">Not unlocked yet. Pieces in this set are earned around the site.</p>';
      if (cats[c].layer === 'floor') html += '<p class="re-hint">Pick a tile, then click cells to paint them — or set it as the whole floor.</p>';
      if (cats[c].layer === 'wall') html += '<p class="re-hint">Pick a tile, then click along the back or side walls.</p>';
      html += list.map(function (p) {
        var active = state.tool && state.tool.paint === p.id;
        return '<button type="button" class="re-piece' + (active ? ' active' : '') + '" data-piece="' + esc(p.id) + '"' + (locked ? ' disabled' : '') + ' title="' + esc(p.id) + '">' +
          '<img src="' + esc(R.src(p)) + '" alt="" loading="lazy"></button>';
      }).join('') + '</div>';
    }
    els.palette.innerHTML = html;
  }

  function renderInspector() {
    var i = state.selected;
    var list = props();
    if (state.tool) {
      var t = pieceOf(state.tool.paint);
      els.inspector.innerHTML = '<div class="re-insp-row"><span class="re-insp-label">Painting</span> <b>' + esc(t ? t.id : '') + '</b>' +
        (state.tool.layer === 'floor' ? '<button type="button" class="pill-btn" data-act="fill-floor">Use as whole floor</button>' : '') +
        '<button type="button" class="pill-btn" data-act="stop-paint">Done</button></div>';
      return;
    }
    if (i == null || !list[i]) {
      els.inspector.innerHTML = '<div class="re-insp-row re-insp-empty">' +
        (state.tab === 'desk' ? 'Pick pieces from the palette to arrange your desk.' : 'Pick pieces from the palette; click one on the floor to move, scale or flip it.') +
        ' <span class="re-count">' + list.length + ' / ' + E.CAPS[state.tab] + '</span></div>';
      return;
    }
    var p = list[i], piece = pieceOf(p.id);
    els.inspector.innerHTML = '<div class="re-insp-row">' +
      '<b>' + esc(piece ? piece.id : p.id) + '</b>' +
      '<span class="re-insp-group">Scale <button type="button" data-act="scale" data-dir="-1">−</button><span class="re-scale">' + p.scale + '×</span><button type="button" data-act="scale" data-dir="1">+</button></span>' +
      '<button type="button" class="pill-btn" data-act="flip">' + (p.flip ? 'Unflip' : 'Flip') + '</button>' +
      '<span class="re-insp-group"><button type="button" class="pill-btn" data-act="order" data-dir="-1">Send back</button><button type="button" class="pill-btn" data-act="order" data-dir="1">Bring forward</button></span>' +
      '<button type="button" class="pill-btn re-danger" data-act="delete">Remove</button>' +
      '<span class="re-count">' + list.length + ' / ' + E.CAPS[state.tab] + '</span>' +
    '</div>';
  }

  /* ── Stage coordinates ───────────────────────────────────────────── */
  function toStage(ev) {
    var rect = els.stage.getBoundingClientRect();
    var s = parseFloat(els.stage.dataset.scale || '1');
    var fx = Number(els.stage.dataset.floorX || 0), fy = Number(els.stage.dataset.floorY || 0);
    return { x: (ev.clientX - rect.left) / s - fx, y: (ev.clientY - rect.top) / s - fy, sx: (ev.clientX - rect.left) / s, sy: (ev.clientY - rect.top) / s };
  }

  /* ── Painting tiles ──────────────────────────────────────────────── */
  function paintAt(pt) {
    var r = room(), d = E.SIZES[r.size] || E.SIZES.M;
    var id = state.tool.paint;
    if (state.tool.layer === 'floor') {
      var c = Math.floor(pt.x / E.CELL), row = Math.floor(pt.y / E.CELL);
      if (c < 0 || row < 0 || c >= d.w || row >= d.h) return false;
      snapshot();
      if (id === r.floor) delete r.cells[c + ',' + row]; else r.cells[c + ',' + row] = id;
      return true;
    }
    /* Walls: the band above the floor is the back; the bands beside it
       are the sides. */
    var W = R.WALL_H;
    if (pt.y < 0 && pt.y >= -W && pt.x >= 0 && pt.x < d.w * E.CELL) {
      snapshot(); r.walls.back[Math.floor(pt.x / E.CELL)] = id; return true;
    }
    if (pt.x < 0 && pt.x >= -W && pt.y >= 0 && pt.y < d.h * E.CELL) {
      snapshot(); r.walls.left[Math.floor(pt.y / E.CELL)] = id; return true;
    }
    if (pt.x >= d.w * E.CELL && pt.x < d.w * E.CELL + W && pt.y >= 0 && pt.y < d.h * E.CELL) {
      snapshot(); r.walls.right[Math.floor(pt.y / E.CELL)] = id; return true;
    }
    return false;
  }

  /* ── Props ───────────────────────────────────────────────────────── */
  function addProp(piece) {
    var list = props();
    if (list.length >= E.CAPS[state.tab]) { status('That surface is full (' + E.CAPS[state.tab] + ' pieces).', 'err'); return; }
    snapshot();
    list.push(E.place(piece, E.bounds(room(), state.tab)));
    state.selected = list.length - 1;
    redraw();
    renderToolbar();
  }

  var drag = null;
  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    var pt = toStage(ev);
    if (state.tool) {
      if (paintAt(pt)) { redraw(); renderToolbar(); }
      return;
    }
    var target = ev.target.closest('[data-index]');
    if (!target) { state.selected = null; redraw(); return; }
    var i = Number(target.dataset.index);
    state.selected = i;
    var p = props()[i];
    drag = { i: i, startX: pt.x, startY: pt.y, ox: p.x, oy: p.y, moved: false, snap: null };
    /* Capture keeps the drag alive when the pointer leaves the stage. A
       pointer that cannot be captured (a synthetic event) just drags
       without it. */
    try { els.stage.setPointerCapture(ev.pointerId); } catch (e) { /* no capture, still draggable */ }
    redraw();
  }
  function onPointerMove(ev) {
    if (!drag) return;
    var pt = toStage(ev);
    var p = props()[drag.i], piece = pieceOf(p.id);
    if (!piece) return;
    if (!drag.moved) { drag.snap = JSON.stringify(room()); drag.moved = true; }
    p.x = drag.ox + (pt.x - drag.startX);
    p.y = drag.oy + (pt.y - drag.startY);
    E.clamp(p, piece, E.bounds(room(), state.tab));
    var el = els.stage.querySelector('[data-index="' + drag.i + '"]');
    if (el) {
      var fx = state.tab === 'desk' ? 0 : R.WALL_H, fy = state.tab === 'desk' ? 0 : R.WALL_H;
      el.style.left = (fx + p.x) + 'px'; el.style.top = (fy + p.y) + 'px';
    }
  }
  function onPointerUp() {
    if (!drag) return;
    if (drag.moved && drag.snap) { state.undo.push(drag.snap); state.dirty = true; }
    drag = null;
    redraw();
    renderToolbar();
  }

  /* ── Actions ─────────────────────────────────────────────────────── */
  function act(a, el) {
    var list = props(), i = state.selected, p = i != null ? list[i] : null;
    if (a === 'undo') return undo();
    if (a === 'save') return save();
    if (a === 'clear') return clear();
    if (a === 'public') return setPublic();
    if (a === 'stop-paint') { state.tool = null; renderPalette(); redraw(); return; }
    if (a === 'fill-floor') { snapshot(); room().floor = state.tool.paint; room().cells = {}; redraw(); renderToolbar(); return; }
    if (!p) return;
    var piece = pieceOf(p.id);
    if (a === 'scale') { snapshot(); p.scale = E.nextScale(p.scale, Number(el.dataset.dir)); E.clamp(p, piece, E.bounds(room(), state.tab)); }
    if (a === 'flip') { snapshot(); p.flip = !p.flip; }
    if (a === 'order') { snapshot(); state.selected = E.reorder(list, i, Number(el.dataset.dir)); }
    if (a === 'delete') { snapshot(); list.splice(i, 1); state.selected = null; }
    redraw();
    renderToolbar();
  }

  function save() {
    status('Saving…');
    var r = JSON.parse(JSON.stringify(room()));
    delete r.updatedAt;
    api('/api/room', { index: state.current, room: r }).then(function (res) {
      if (!res.ok) return status(res.data.error || 'Could not save.', 'err');
      state.rooms[state.current] = res.data.room;
      state.dirty = false;
      status('Saved.', 'ok');
      redraw();
    }).catch(function () { status('Network error — try again.', 'err'); });
  }

  function clear() {
    if (!window.confirm('Empty this room? This cannot be undone once saved.')) return;
    api('/api/room', { action: 'clear', index: state.current }).then(function (res) {
      if (!res.ok) return status(res.data.error || 'Could not clear.', 'err');
      state.rooms[state.current] = res.data.room;
      state.undo = []; state.selected = null; state.dirty = false;
      status('Room emptied.', 'ok');
      redraw(); renderToolbar();
    });
  }

  function setPublic() {
    api('/api/room', { action: 'public', index: state.current }).then(function (res) {
      if (!res.ok) return status(res.data.error || 'Could not change that.', 'err');
      state.publicIndex = res.data.public;
      status('This room is now on your profile.', 'ok');
      renderToolbar();
    });
  }

  /* ── Wiring ──────────────────────────────────────────────────────── */
  function wire() {
    els.palette.addEventListener('click', function (ev) {
      var cat = ev.target.closest('[data-cat]');
      if (cat) { state.category = cat.dataset.cat; renderPalette(); return; }
      var pc = ev.target.closest('[data-piece]');
      if (!pc || pc.disabled) return;
      var piece = pieceOf(pc.dataset.piece);
      if (!piece) return;
      if (piece.layer === 'floor' || piece.layer === 'wall') {
        state.tool = { paint: piece.id, layer: piece.layer };
        state.selected = null;
        renderPalette(); redraw();
      } else {
        addProp(piece);
      }
    });

    els.toolbar.addEventListener('click', function (ev) {
      var tab = ev.target.closest('[data-tab]');
      if (tab) { state.tab = tab.dataset.tab; state.selected = null; state.tool = null; state.category = null; renderPalette(); renderToolbar(); redraw(); return; }
      var b = ev.target.closest('[data-act]');
      if (b) act(b.dataset.act, b);
    });
    els.toolbar.addEventListener('change', function (ev) {
      if (ev.target.id === 'reSize') {
        snapshot();
        var wall = state.catalog.pieces.find(function (p) { return p.layer === 'wall'; });
        E.resize(room(), ev.target.value, pieceOf, wall ? wall.id : null);
        state.selected = null;
        redraw(); renderToolbar();
      }
      if (ev.target.id === 'reRoomPick') {
        if (state.dirty && !window.confirm('Switch rooms without saving? Unsaved changes are lost.')) { renderToolbar(); return; }
        state.current = Number(ev.target.value);
        state.undo = []; state.selected = null; state.dirty = false;
        redraw(); renderToolbar();
      }
    });

    els.inspector.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]');
      if (b) act(b.dataset.act, b);
    });

    els.stage.addEventListener('pointerdown', onPointerDown);
    els.stage.addEventListener('pointermove', onPointerMove);
    els.stage.addEventListener('pointerup', onPointerUp);
    els.stage.addEventListener('pointercancel', onPointerUp);

    document.addEventListener('keydown', function (ev) {
      if (ev.target.matches('input, textarea, select')) return;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); return undo(); }
      if (ev.key === 'Escape') { state.tool = null; state.selected = null; renderPalette(); redraw(); return; }
      var i = state.selected, p = i != null ? props()[i] : null;
      if (!p) return;
      if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); return act('delete'); }
      var dx = ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1 : 0;
      var dy = ev.key === 'ArrowUp' ? -1 : ev.key === 'ArrowDown' ? 1 : 0;
      if (!dx && !dy) return;
      ev.preventDefault();
      snapshot();
      p.x += dx * E.SNAP; p.y += dy * E.SNAP;
      E.clamp(p, pieceOf(p.id), E.bounds(room(), state.tab));
      redraw(); renderToolbar();
    });

    window.addEventListener('resize', function () { R.fit(els.stage); });
    window.addEventListener('beforeunload', function (ev) { if (state.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
  }

  /* ── Boot ────────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    els = {
      state: document.getElementById('reState'), app: document.getElementById('reApp'),
      palette: document.getElementById('rePalette'), toolbar: document.getElementById('reToolbar'),
      stage: document.getElementById('reStage'), inspector: document.getElementById('reInspector'),
      status: document.getElementById('reStatus'),
    };
    if (!me()) {
      els.state.innerHTML = 'Log in with Twitch to build your room. <button class="btn-primary" type="button" onclick="loginWithTwitch()">Log In</button>';
      return;
    }
    Promise.all([
      fetch('/assets/room/catalog.json', { cache: 'force-cache' }).then(function (r) { return r.json(); }),
      api('/api/room?mine=1'),
    ]).then(function (res) {
      var cat = res[0], mine = res[1];
      if (!mine.ok) { els.state.textContent = mine.data.error || 'Could not load your rooms.'; return; }
      state.catalog = R.index(cat);
      state.rooms = mine.data.rooms;
      state.publicIndex = mine.data.public;
      state.slots = mine.data.slots;
      state.owned = new Set(mine.data.owned);
      state.category = 'floor';
      els.state.hidden = true;
      els.app.hidden = false;
      wire();
      renderPalette(); renderToolbar(); redraw();
    }).catch(function () { els.state.textContent = 'Could not load the editor right now.'; });
  });
})();
