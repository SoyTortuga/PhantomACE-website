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
  function deriveMask(map, zones) {
    var rows = [];
    for (var y = 0; y < GRID; y++) {
      var row = '';
      for (var x = 0; x < GRID; x++) {
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
      palette.sets.forEach(function (s) { zoneOf[s.id] = s.zone; });

      buildPalette();
      populateLoadList(data.backgrounds || []);
      bindGrid();
      bindToolbar();
      render();

      notice.style.display = 'none';
      $('bgsStudio').style.display = '';
    } catch (e) {
      notice.textContent = 'Could not load the studio: ' + e.message;
    }
  }

  /* ── palette UI ── */

  function buildPalette() {
    var setsEl = $('bgsSets');
    palette.sets.forEach(function (s, i) {
      var b = document.createElement('button');
      b.className = 'bgs-set-btn' + (i === 0 ? ' active' : '');
      b.innerHTML = escapeHtml(s.name) +
        (s.zone !== 'L' ? ' <span class="zone-tag">' + s.zone + '</span>' : '');
      b.onclick = function () {
        setsEl.querySelectorAll('.bgs-set-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        showTiles(s);
      };
      setsEl.appendChild(b);
    });
    showTiles(palette.sets[0]);
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
      tilemap[at.y][at.x] = null;
    } else if (brush) {
      var vary = $('bgsVary').checked;
      /* Re-rolling under a drag repaints the same cell with a new random
         tile every mousemove, which shimmers. Only roll when the cell is
         empty or holds a different set. */
      var cur = tilemap[at.y][at.x];
      var want = brush.random
        ? ((vary || !cur || cur.split('/')[0] !== brush.set) ? pick(brush.set) : cur)
        : brush.tile;
      if (brush.random && cur && cur.split('/')[0] === brush.set && !vary) want = cur;
      if (cur === want) return;
      tilemap[at.y][at.x] = want;
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
      for (var y = 0; y < GRID; y++) for (var x = 0; x < GRID; x++) {
        if (!tilemap[y][x]) tilemap[y][x] = brush.random ? pick(brush.set) : brush.tile;
      }
      render();
    });
  }

  /* ── rendering ── */

  var ZONE_TINT = { L: 'rgba(60,200,60,0.35)', R: 'rgba(80,160,255,0.35)',
                    O: 'rgba(20,60,220,0.45)', X: 'rgba(200,40,40,0.45)' };

  function imgFor(ref) {
    if (tileImgs[ref]) return tileImgs[ref];
    var parts = ref.split('/');
    var img = new Image();
    img.onload = render;
    img.src = PALETTE_URL + parts[0] + '/' + parts[1] + '.png';
    tileImgs[ref] = img;
    return img;
  }

  function render() {
    var c = $('bgsGrid');
    var ctx = c.getContext('2d');
    var cell = c.width / GRID;
    ctx.clearRect(0, 0, c.width, c.height);

    var mask = deriveMask(tilemap, zoneOf);
    var empty = 0;

    for (var y = 0; y < GRID; y++) {
      for (var x = 0; x < GRID; x++) {
        var ref = tilemap[y][x];
        if (ref) {
          var img = imgFor(ref);
          if (img.complete && img.naturalWidth) {
            ctx.drawImage(img, x * cell, y * cell, cell, cell);
          }
        } else {
          empty++;
          ctx.fillStyle = '#141414';
          ctx.fillRect(x * cell, y * cell, cell, cell);
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
    var mask = deriveMask(tilemap, zoneOf);

    if (publish && tilemap.some(function (r) { return r.some(function (c) { return !c; }); })) {
      if (!confirm('There are unpainted cells — they will be unwalkable ground. Publish anyway?')) return;
    }

    status.textContent = 'Saving…';
    try {
      var res = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          id: currentId || undefined,
          name: $('bgsName').value,
          tilemap: tilemap,
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
      currentId = ''; tilemap = blankMap(); $('bgsName').value = '';
      $('bgsDelete').style.display = 'none';
      render(); return;
    }
    var res = await fetch(API + '?id=' + encodeURIComponent(id), { cache: 'no-store' });
    var data = await res.json();
    if (!res.ok) { $('bgsStatus').textContent = data.error || 'Could not load'; return; }
    currentId = data.background.id;
    $('bgsName').value = data.background.name;
    tilemap = data.background.tilemap;
    $('bgsDelete').style.display = '';
    render();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
