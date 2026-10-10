/* ══════════════════════════════════════════════
   PARK BACKGROUND STUDIO

   Paint a 32×32 tilemap from the palette; the walkability mask falls out
   of the painting. Saving through /api/park-backgrounds IS the release —
   the game and the visit view compose the same tiles from the same data.

   THE MASK IS NEVER EDITED, ONLY DERIVED. Each palette set carries the
   zone its tiles imply (grass is land, ocean is ocean), so the map cannot
   disagree with its own art: where you painted water is exactly where an
   aquatic dino may swim. An empty cell derives X — visible ground the
   game will not path onto — which is also why publish warns about
   unpainted cells instead of quietly shipping holes.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var GRID = 32;
  var PALETTE_URL = '/games/dino-park/assets/dino-assets/park-tiles/';
  var API = '/api/park-backgrounds';

  var palette = null;          /* palette.json: {cell, sets:[{id,name,zone,tiles}]} */
  var zoneOf = {};             /* set id -> L/R/O/X */
  var tileImgs = {};           /* "set/NN" -> HTMLImageElement */

  var tilemap = blankMap();    /* GRID×GRID of "set/NN" or null */
  var currentId = '';          /* '' while unsaved */
  var brush = null;            /* {set, tile:'set/NN'} or {set, random:true} */
  var brushRot = 0;            /* 0/90/180/270, applied to whatever is painted */
  var fences = null;           /* the layer above the ground; same shape, nullable cells */
  var brushKind = 'ground';    /* which layer the current brush paints into */
  var painting = 0;            /* 1 = paint, 2 = erase, 0 = idle */
  var showZones = false;

  var $ = function (id) { return document.getElementById(id); };

  function blankMap() {
    var m = [];
    for (var y = 0; y < GRID; y++) m.push(new Array(GRID).fill(null));
    return m;
  }

  /**
   * The mask, from the map — the one derivation, shared verbatim with the
   * test suite, which lifts this exact function. Change it here and the
   * suite re-checks the property that matters: the mask can never disagree
   * with the tiles, because it has no independent existence.
   */
  function deriveMask(map, zones, fenceLayer) {
    var rows = [];
    for (var y = 0; y < GRID; y++) {
      var row = '';
      for (var x = 0; x < GRID; x++) {
        /* A FENCE WINS. The cell may have grass painted under it, but a
           fence is there to stop things crossing, so it is X whatever the
           ground says. Checking the fence first is the whole rule. */
        if (fenceLayer && fenceLayer[y] && fenceLayer[y][x]) { row += 'X'; continue; }
        var cell = map[y][x];
        var zone = cell ? zones[cell.split('/')[0]] : null;
        row += (zone === 'L' || zone === 'R' || zone === 'O') ? zone : 'X';
      }
      rows.push(row);
    }
    return rows;
  }

  /* ── boot ── */

  init();
  async function init() {
    var notice = $('bgsNotice');
    try {
      /* Staff check by asking the API for drafts: it answers with them for
         staff and without for anyone else, so the page needs no duplicate
         copy of the moderator rules. */
      var res = await fetch(API + '?drafts=1', { cache: 'no-store' });
      var data = await res.json();

      var pal = await fetch(PALETTE_URL + 'palette.json', { cache: 'no-store' });
      if (!pal.ok) { notice.textContent = 'The tile palette is not on this server yet — copy park-tiles/ to the rig first.'; return; }
      palette = await pal.json();
      palette.sets.forEach(function (s) {
        zoneOf[s.id] = s.zone;
        kindOfSet[s.id] = s.kind || 'ground';
      });

      buildPalette();
      populateLoadList(data.backgrounds || []);
      bindGrid();
      bindToolbar();
      bindRotate();
      render();

      notice.style.display = 'none';
      $('bgsStudio').style.display = '';
    } catch (e) {
      notice.textContent = 'Could not load the studio: ' + e.message;
    }
  }

  /* ── palette UI ── */

  /* GROUND, WATER, FENCES. Twenty-nine flat sets is a lot to hand someone
     who has never opened this; three choices is not. The grouping is by
     the `kind` each set carries in palette.json, which is derived from its
     zone — so this is a label on the existing walkability contract, not a
     second source of truth about it. */
  /* set id -> kind, so a brush knows which layer it paints into. */
  var kindOfSet = {};

  var KINDS = [
    { id: 'ground',     label: 'Ground Tiles', hint: 'Land dinosaurs walk here' },
    { id: 'water',      label: 'Water Tiles',  hint: 'Only aquatic dinosaurs swim here' },
    { id: 'fence',      label: 'Fences',       hint: 'Sits above the ground, and nothing crosses it' },
    { id: 'decoration', label: 'Decorations',  hint: 'Sits above the ground, and does not block' },
  ];

  var openKind = 'ground';

  /**
   * Build the picker.
   *
   * One category open at a time. Thirty-four themes in a flat list is
   * unusable and three tabs still showed every theme of the selected kind
   * at once; collapsing to a single open section is what keeps the panel
   * readable as more packs are sliced in.
   */
  function buildPalette() {
    var root = $('bgsKinds');
    root.innerHTML = '';

    KINDS.forEach(function (k) {
      var sets = palette.sets.filter(function (x) { return (x.kind || 'ground') === k.id; });
      if (!sets.length) return;

      var sec = document.createElement('div');
      sec.className = 'bgs-cat';
      sec.dataset.kind = k.id;

      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'bgs-cat-head';
      head.innerHTML = '<span class="bgs-cat-caret"></span>' +
        '<span class="bgs-cat-label">' + escapeHtml(k.label) + '</span>' +
        '<span class="bgs-cat-count">' + sets.length + '</span>';
      head.onclick = function () {
        openKind = (openKind === k.id) ? null : k.id;
        paintOpenState();
      };

      var body = document.createElement('div');
      body.className = 'bgs-cat-body';
      var hint = document.createElement('div');
      hint.className = 'bgs-kind-hint';
      hint.textContent = k.hint;
      body.appendChild(hint);

      var setsEl = document.createElement('div');
      setsEl.className = 'bgs-sets';
      sets.forEach(function (st) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'bgs-set-btn';
        b.dataset.set = st.id;
        b.textContent = st.name;
        b.onclick = function () {
          root.querySelectorAll('.bgs-set-btn').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          showTiles(st);
        };
        setsEl.appendChild(b);
      });
      body.appendChild(setsEl);

      sec.appendChild(head);
      sec.appendChild(body);
      root.appendChild(sec);
    });

    paintOpenState();

    /* Start on the first theme of the open category, so the tile strip is
       never empty on load. */
    var first = palette.sets.filter(function (x) { return (x.kind || 'ground') === openKind; })[0];
    if (first) {
      var btn = root.querySelector('.bgs-set-btn[data-set="' + first.id + '"]');
      if (btn) btn.classList.add('active');
      showTiles(first);
    }
  }

  function paintOpenState() {
    var root = $('bgsKinds');
    root.querySelectorAll('.bgs-cat').forEach(function (sec) {
      sec.classList.toggle('open', sec.dataset.kind === openKind);
    });
  }

  function showTiles(set) {
    var wrap = $('bgsTiles');
    wrap.innerHTML = '';

    /* The random swatch first: painting terrain one identical tile at a
       time looks stamped; a set-random brush is how ground gets texture. */
    var rnd = document.createElement('button');
    rnd.className = 'bgs-tile-btn set-random';
    rnd.textContent = 'RANDOM from set';
    rnd.onclick = function () { select(rnd, { set: set.id, random: true }); };
    wrap.appendChild(rnd);

    set.tiles.forEach(function (t, i) {
      var ref = set.id + '/' + String(i).padStart(2, '0');
      var b = document.createElement('button');
      b.className = 'bgs-tile-btn';
      var img = document.createElement('img');
      img.src = PALETTE_URL + t.file;
      img.alt = '';
      b.appendChild(img);
      b.onclick = function () { select(b, { set: set.id, tile: ref }); };
      wrap.appendChild(b);
    });

    function select(el, br) {
      wrap.querySelectorAll('.bgs-tile-btn').forEach(function (x) { x.classList.remove('selected'); });
      el.classList.add('selected');
      brush = br;
      brushKind = (kindOfSet[br.set] || 'ground');
      applyRot();
    }
    select(rnd, { set: set.id, random: true });
  }

  /* ── painting ── */

  function pick(setId) {
    var set = palette.sets.find(function (s) { return s.id === setId; });
    var i = Math.floor(Math.random() * set.tiles.length);
    return setId + '/' + String(i).padStart(2, '0');
  }

  function cellAt(ev) {
    var c = $('bgsGrid');
    var r = c.getBoundingClientRect();
    var x = Math.floor((ev.clientX - r.left) / r.width * GRID);
    var y = Math.floor((ev.clientY - r.top) / r.height * GRID);
    if (x < 0 || y < 0 || x >= GRID || y >= GRID) return null;
    return { x: x, y: y };
  }

  function applyAt(ev) {
    var at = cellAt(ev);
    if (!at) return;
    if (painting === 2) {
      /* Top down: a right-click clears the fence or decoration standing on
         the cell, and only takes the ground once the cell is bare. Erasing
         the ground out from under a fence would leave the fence hanging
         over the background colour. */
      if (fences && fences[at.y][at.x]) fences[at.y][at.x] = null;
      else tilemap[at.y][at.x] = null;
    } else if (brush) {
      var vary = $('bgsVary').checked;
      /* Re-rolling under a drag repaints the same cell with a new random
         tile every mousemove, which shimmers. Only roll when the cell is
         empty or holds a different set. */
      var layer = layerFor(brushKind);
      var cur = layer[at.y][at.x];
      var want = brush.random
        ? ((vary || !cur || cur.split('/')[0] !== brush.set) ? withRot(pick(brush.set)) : cur)
        : withRot(brush.tile);
      if (brush.random && cur && cur.split('/')[0] === brush.set && !vary) want = cur;
      if (cur === want) return;
      layer[at.y][at.x] = want;
    }
    render();
  }

  function bindGrid() {
    var c = $('bgsGrid');
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    c.addEventListener('pointerdown', function (e) {
      painting = e.button === 2 ? 2 : 1;
      c.setPointerCapture(e.pointerId);
      applyAt(e);
    });
    c.addEventListener('pointermove', function (e) { if (painting) applyAt(e); });
    var stop = function () { painting = 0; };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointercancel', stop);
    $('bgsZones').addEventListener('change', function (e) { showZones = e.target.checked; render(); });
    $('bgsFill').addEventListener('click', function () {
      if (!brush) return;
      var layer = layerFor(brushKind);
      for (var y = 0; y < GRID; y++) for (var x = 0; x < GRID; x++) {
        if (!layer[y][x]) layer[y][x] = withRot(brush.random ? pick(brush.set) : brush.tile);
      }
      render();
    });
  }

  /* ── rendering ── */

  var ZONE_TINT = { L: 'rgba(60,200,60,0.35)', R: 'rgba(80,160,255,0.35)',
                    O: 'rgba(20,60,220,0.45)', X: 'rgba(200,40,40,0.45)' };

  /* `fencewire/03` or `fencewire/03r90` — see the server's TILE_RE. */
  /* Fences and decorations share the overlay; ground and water are the
     base. `brushKind` is set when a tile is selected, from the set's own
     kind, so the brush always knows which array it writes into. */
  function blankLayer() {
    var rows = [];
    for (var y = 0; y < GRID; y++) {
      var row = [];
      for (var x = 0; x < GRID; x++) row.push(null);
      rows.push(row);
    }
    return rows;
  }

  function isOverlay(kind) { return kind === 'fence' || kind === 'decoration'; }

  function layerFor(kind) {
    if (!isOverlay(kind)) return tilemap;
    if (!fences) fences = blankLayer();
    return fences;
  }

  function refParts(ref) {
    var parts = String(ref).split('/');
    var m = /^(\d{2})(?:r(90|180|270))?$/.exec(parts[1] || '');
    return { set: parts[0], idx: m ? m[1] : parts[1], rot: m && m[2] ? Number(m[2]) : 0 };
  }


  /* Rotation rides on the ref — `fencewire/03r90` — so a painted cell
     remembers its own angle and nothing else has to track it. */
  function withRot(ref) {
    if (!ref || !brushRot) return ref;
    return String(ref).replace(/r(?:90|180|270)$/, '') + 'r' + brushRot;
  }

  function applyRot() {
    var v = document.getElementById('bgsRotateVal');
    if (v) v.textContent = brushRot + '\u00b0';
  }

  function bindRotate() {
    var b = document.getElementById('bgsRotate');
    function turn() { brushRot = (brushRot + 90) % 360; applyRot(); }
    if (b) b.onclick = turn;
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'r' && e.key !== 'R') return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      turn();
    });
  }

  function imgFor(ref) {
    if (tileImgs[ref]) return tileImgs[ref];
    var p = refParts(ref);
    var img = new Image();
    img.onload = render;
    img.src = PALETTE_URL + p.set + '/' + p.idx + '.png';
    tileImgs[ref] = img;
    return img;
  }

  function render() {
    var c = $('bgsGrid');
    var ctx = c.getContext('2d');
    var cell = c.width / GRID;
    ctx.clearRect(0, 0, c.width, c.height);

    var mask = deriveMask(tilemap, zoneOf, fences);
    var empty = 0;

    /* The colour the gaps will show once this is published — the editor
       has to paint it too, or it lies about the result. */
    var colEl = $('bgsColor');
    ctx.fillStyle = (colEl && /^#[0-9a-f]{6}$/i.test(colEl.value)) ? colEl.value : '#0a0a0a';
    ctx.fillRect(0, 0, c.width, c.height);

    for (var y = 0; y < GRID; y++) {
      for (var x = 0; x < GRID; x++) {
        var ref = tilemap[y][x];
        if (ref) {
          var img = imgFor(ref);
          if (img.complete && img.naturalWidth) {
            var rot = refParts(ref).rot;
            if (rot) {
              ctx.save();
              ctx.translate(x * cell + cell / 2, y * cell + cell / 2);
              ctx.rotate(rot * Math.PI / 180);
              ctx.drawImage(img, -cell / 2, -cell / 2, cell, cell);
              ctx.restore();
            } else {
              ctx.drawImage(img, x * cell, y * cell, cell, cell);
            }
          }
        } else {
          empty++;
          ctx.fillStyle = '#141414';
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
        var over = fences && fences[y][x];
        if (over) {
          var oimg = imgFor(over);
          if (oimg.complete && oimg.naturalWidth) {
            var orot = refParts(over).rot;
            if (orot) {
              ctx.save();
              ctx.translate(x * cell + cell / 2, y * cell + cell / 2);
              ctx.rotate(orot * Math.PI / 180);
              ctx.drawImage(oimg, -cell / 2, -cell / 2, cell, cell);
              ctx.restore();
            } else {
              ctx.drawImage(oimg, x * cell, y * cell, cell, cell);
            }
          }
        }
        if (showZones) {
          ctx.fillStyle = ZONE_TINT[mask[y][x]];
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }

    /* A faint grid so cells are targetable without counting pixels. */
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (var i = 0; i <= GRID; i++) {
      ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, c.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(c.width, i * cell); ctx.stroke();
    }

    var cov = $('bgsCoverage');
    var flat = mask.join('');
    var water = (flat.match(/O|R/g) || []).length;
    cov.innerHTML = (empty
      ? '<span class="warn">' + empty + ' unpainted cells (they become unwalkable)</span> · '
      : 'fully painted · ') + water + ' water cells';
  }

  /* ── save / load ── */

  function bindToolbar() {
    /* Save = keep my edits, change nothing about visibility. Publishing
       is its own deliberate click. save(undefined) omits the flag and the
       server keeps whatever state the background is in. */
    $('bgsSaveDraft').onclick = function () { save(undefined); };
    $('bgsPublish').onclick = function () { save(true); };
    $('bgsDelete').onclick = del;
    $('bgsLoad').onchange = loadSelected;
  }

  async function save(publish) {
    var status = $('bgsStatus');
    var mask = deriveMask(tilemap, zoneOf, fences);

    if (publish && tilemap.some(function (r) { return r.some(function (c) { return !c; }); })) {
      if (!confirm('There are unpainted cells — they will be unwalkable ground. Publish anyway?')) return;
    }

    status.textContent = 'Saving…';
    try {
      var res = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          bgColor: ($('bgsColor') && $('bgsColor').value) || '#0a0a0a',
          id: currentId || undefined,
          name: $('bgsName').value,
          tilemap: tilemap,
          fences: fences,
          mask: mask,
          publish: publish,
        }),
      });
      var data = await res.json();
      if (!res.ok) { status.textContent = data.error || 'Save failed'; return; }
      currentId = data.background.id;
      $('bgsDelete').style.display = '';
      status.textContent = (data.background.published ? 'Saved & live' : 'Draft saved') + ' as "' + data.background.id + '"';
      refreshLoadList();
    } catch (e) {
      status.textContent = 'Save failed: ' + e.message;
    }
  }

  async function del() {
    if (!currentId) return;
    if (!confirm('Delete "' + currentId + '"? Parks using it fall back to the classic background.')) return;
    $('bgsStatus').textContent = 'Deleting…';
    try {
      var res = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: currentId }),
      });
      var data = await res.json().catch(function () { return {}; });
      // Only tear down local state once the server confirms the delete —
      // otherwise a 403/500/network drop wiped the loaded map and lied "Deleted".
      if (!res.ok) { $('bgsStatus').textContent = data.error || 'Delete failed'; return; }
    } catch (e) {
      $('bgsStatus').textContent = 'Delete failed: ' + e.message;
      return;
    }
    currentId = '';
    tilemap = blankMap();
    fences = null;
    $('bgsName').value = '';
    $('bgsDelete').style.display = 'none';
    $('bgsStatus').textContent = 'Deleted';
    refreshLoadList();
    render();
  }

  function populateLoadList(list) {
    var sel = $('bgsLoad');
    while (sel.options.length > 1) sel.remove(1);
    list.forEach(function (bg) {
      var o = document.createElement('option');
      o.value = bg.id;
      o.textContent = bg.name + (bg.published ? '' : ' (draft)');
      sel.appendChild(o);
    });
  }

  async function refreshLoadList() {
    var res = await fetch(API + '?drafts=1', { cache: 'no-store' });
    var data = await res.json();
    populateLoadList(data.backgrounds || []);
    if (currentId) $('bgsLoad').value = currentId;
  }

  async function loadSelected() {
    var id = $('bgsLoad').value;
    if (!id) {
      currentId = ''; tilemap = blankMap(); fences = null; $('bgsName').value = '';
      $('bgsDelete').style.display = 'none';
      render(); return;
    }
    var res = await fetch(API + '?id=' + encodeURIComponent(id), { cache: 'no-store' });
    var data = await res.json();
    if (!res.ok) { $('bgsStatus').textContent = data.error || 'Could not load'; return; }
    currentId = data.background.id;
    $('bgsName').value = data.background.name;
    tilemap = data.background.tilemap;
    /* Absent on anything saved before fences existed, which reads the same
       as an empty overlay. */
    fences = data.background.fences || null;
    var col = $('bgsColor');
    if (col) col.value = data.background.bgColor || '#0a0a0a';
    $('bgsDelete').style.display = '';
    render();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
