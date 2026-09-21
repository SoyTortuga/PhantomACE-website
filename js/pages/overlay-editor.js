/* ══════════════════════════════════════════════
   OVERLAY LAYOUT EDITOR — drag the real panels, save where they sit.

   The stage is an iframe of /overlay?layout=1 at native 1920×1080, scaled
   to fit. Because it is same-origin, the editor reaches into its document
   and drags the ACTUAL panels using the overlay's own applyOne() — what is
   dragged is exactly what airs, with no second copy to drift. On drop, each
   panel's top-left is read back as a percentage of the canvas and saved.

   CANVAS is 1920×1080. Positions are stored and applied as percentages, so
   the same layout holds whether the OBS source is 1080p or 720p.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var CANVAS_W = 1920, CANVAS_H = 1080;
  var API = '/api/overlay/layout';

  var frame = document.getElementById('ovFrame');
  var stageFrame = document.getElementById('stageFrame');
  var notice = document.getElementById('notice');
  var scale = 1;

  /* Multi-preset state. `presets` mirrors the server: name -> { panels }.
     `activeName` is the live one; `currentName` is the one being edited. */
  var presets = {};
  var activeName = '';
  var currentName = '';

  function currentPanels() { return (presets[currentName] && presets[currentName].panels) || {}; }

  /* The legend is drawn from OverlaySamples.PANELS — the same source that
     lists the movable panels — so it can never claim a panel shows
     something the panel does not, and a new panel documents itself by
     appearing in that one list. */
  function renderLegend() {
    /* From the PARENT's copy of the shared samples, loaded on this page, so
       the legend renders immediately without waiting on the iframe. */
    var panels = (window.OverlaySamples && window.OverlaySamples.PANELS) || [];
    var body = document.getElementById('legendBody');
    if (!body) return;
    body.innerHTML = panels.map(function (p) {
      var items = (p.holds || []).map(function (h) {
        return '<li>' + escapeHtml(h) + '</li>';
      }).join('');
      return '<div class="lg-panel"><div class="lg-name">' + escapeHtml(p.label) +
        '</div><ul>' + items + '</ul></div>';
    }).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fitScale() {
    scale = stageFrame.clientWidth / CANVAS_W;
    frame.style.transform = 'scale(' + scale + ')';
    stageFrame.style.height = (CANVAS_H * scale) + 'px';
  }

  async function boot() {
    var data;
    try {
      var res = await fetch(API + '?full=1', { cache: 'no-store' });
      data = await res.json();
    } catch (e) { notice.textContent = 'Could not reach the server.'; return; }

    if (!data.staff) {
      notice.textContent = 'The overlay layout editor is for the broadcaster and moderators. '
        + 'Sign in on the main site as staff.';
      return;
    }
    presets = data.presets || {};
    activeName = data.active || '';
    /* Always have something to edit: fall back to a fresh, unsaved Default. */
    currentName = activeName || Object.keys(presets)[0] || 'Default';
    if (!presets[currentName]) presets[currentName] = { panels: {} };

    notice.style.display = 'none';
    document.getElementById('editor').style.display = '';

    /* The iframe must not run its own live fetch under us. */
    try { frame.contentWindow.__ovLayoutManaged = true; } catch (e) {}

    renderLegend();
    renderPresetBar();
    fitScale();
    window.addEventListener('resize', function () { fitScale(); });

    if (frame.contentDocument && frame.contentDocument.readyState === 'complete') wireFrame();
    else frame.addEventListener('load', wireFrame);

    bindButtons();
  }

  function renderPresetBar() {
    var sel = document.getElementById('presetSelect');
    var names = Object.keys(presets);
    sel.innerHTML = names.map(function (n) {
      return '<option value="' + escapeHtml(n) + '"' + (n === currentName ? ' selected' : '') + '>' +
        escapeHtml(n) + (n === activeName ? ' (live)' : '') + '</option>';
    }).join('') || '<option>Default</option>';
    var tag = document.getElementById('liveTag');
    tag.textContent = activeName ? ('Live: ' + activeName) : 'No preset is live yet';
  }

  /* Switch which preset is being edited: reload the iframe to a clean slate,
     then pin from that preset's saved panels. */
  function selectPreset(name) {
    currentName = name;
    if (!presets[currentName]) presets[currentName] = { panels: {} };
    renderPresetBar();
    reloadFrame('Editing "' + currentName + '".');
  }

  function reloadFrame(msg) {
    wired = false;
    frame.contentWindow.location.reload();
    frame.addEventListener('load', wireFrame, { once: true });
    if (msg) document.getElementById('status').textContent = msg;
  }

  var wired = false;
  function wireFrame() {
    if (wired) return;
    var doc = frame.contentDocument;
    if (!doc) { notice.style.display = ''; notice.textContent = 'Preview blocked — reload the page.'; return; }
    wired = true;

    var win = frame.contentWindow;
    var apply = win.OverlayLayout && win.OverlayLayout.applyOne;
    var samples = (win.OverlaySamples && win.OverlaySamples.PANELS) || [];

    samples.forEach(function (spec) {
      var el = doc.getElementById(spec.id);
      if (!el) return;

      /* Pin every panel to top-left in canvas %, from the saved layout if
         it has one, else from where its default CSS currently places it —
         so dragging starts from the real position either way. */
      var pos = currentPanels()[spec.id];
      if (!pos) {
        /* Inside the same-origin iframe the document lays out at native
           1920×1080 — the CSS scale lives in the PARENT and is invisible
           here — so this rect is already in canvas pixels. No /scale. */
        var r = el.getBoundingClientRect();
        pos = { x: r.left / CANVAS_W * 100, y: r.top / CANVAS_H * 100, s: 1 };
      }
      if (apply) apply(el, pos.x, pos.y, pos.s);
      el.dataset.px = pos.x;
      el.dataset.py = pos.y;
      el.dataset.ps = (pos.s === undefined || pos.s === null) ? 1 : pos.s;

      makeDraggable(el, apply);
      addResizeHandle(el, apply);
      tagPanel(el, spec.label);
    });
  }

  function tagPanel(el, label) {
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'move';
    el.style.outline = '1px dashed #ff000066';
    var tag = frame.contentDocument.createElement('div');
    tag.textContent = label;
    tag.style.cssText =
      'position:absolute;top:-2px;left:0;transform:translateY(-100%);' +
      'background:#ff0000;color:#fff;font:700 11px system-ui;padding:1px 6px;' +
      'border-radius:3px 3px 0 0;white-space:nowrap;pointer-events:none;';
    el.appendChild(tag);
  }

  function makeDraggable(el, apply) {
    var startX, startY, startPx, startPy;

    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      startX = e.clientX; startY = e.clientY;
      startPx = Number(el.dataset.px); startPy = Number(el.dataset.py);
      el.setPointerCapture(e.pointerId);
      el.style.zIndex = 999;
      document.getElementById('status').textContent = '';
    });

    el.addEventListener('pointermove', function (e) {
      if (startX === undefined) return;
      /* The pointer events fire INSIDE the iframe, whose coordinate space
         is the unscaled 1920×1080 canvas, so clientX deltas are already in
         canvas pixels — the parent's CSS scale does not enter into it. */
      var dxPct = (e.clientX - startX) / CANVAS_W * 100;
      var dyPct = (e.clientY - startY) / CANVAS_H * 100;
      var x = clamp(startPx + dxPct), y = clamp(startPy + dyPct);
      el.dataset.px = x; el.dataset.py = y;
      if (apply) apply(el, x, y, Number(el.dataset.ps) || 1);
    });

    function end(e) {
      if (startX === undefined) return;
      startX = undefined;
      el.style.zIndex = '';
      try { el.releasePointerCapture(e.pointerId); } catch (ex) {}
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function clamp(v) { return Math.max(0, Math.min(96, Math.round(v * 100) / 100)); }
  function clampScale(v) { return Math.max(0.3, Math.min(3, Math.round(v * 1000) / 1000)); }

  /* A grab handle at the panel's bottom-right. offsetWidth is the panel's
     UNSCALED layout width (transforms don't change it), so dragging the
     corner right by dx canvas px grows the rendered width by dx —
     WYSIWYG — via scale = startScale + dx/baseWidth. Counter-scaled so the
     handle stays the same grab size whatever the panel's scale. */
  function addResizeHandle(el, apply) {
    var doc = frame.contentDocument;
    var h = doc.createElement('div');
    h.className = 'ov-resize-handle';
    h.style.cssText =
      'position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;' +
      'background:#ff0000;border:2px solid #fff;border-radius:3px;' +
      'cursor:nwse-resize;z-index:1000;transform-origin:bottom right;';
    el.appendChild(h);

    var startX, startScale, baseW;
    h.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      startX = e.clientX;
      startScale = Number(el.dataset.ps) || 1;
      baseW = el.offsetWidth || 300;
      h.setPointerCapture(e.pointerId);
    });
    h.addEventListener('pointermove', function (e) {
      if (startX === undefined) return;
      var sc = clampScale(startScale + (e.clientX - startX) / baseW);
      el.dataset.ps = sc;
      if (apply) apply(el, Number(el.dataset.px), Number(el.dataset.py), sc);
      h.style.transform = 'scale(' + (1 / sc) + ')';   /* stay grabbable */
      var st = document.getElementById('status');
      if (st) st.textContent = 'scale ' + Math.round(sc * 100) + '%';
    });
    function end(e) {
      if (startX === undefined) return;
      startX = undefined;
      try { h.releasePointerCapture(e.pointerId); } catch (ex) {}
    }
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  }

  function collect() {
    var doc = frame.contentDocument;
    var out = {};
    ((frame.contentWindow.OverlaySamples || {}).PANELS || []).forEach(function (spec) {
      var el = doc.getElementById(spec.id);
      if (el && el.dataset.px !== undefined) {
        out[spec.id] = { x: Number(el.dataset.px), y: Number(el.dataset.py),
                         s: Number(el.dataset.ps) || 1 };
      }
    });
    return out;
  }

  function setStatus(t) { document.getElementById('status').textContent = t; }

  async function post(bodyObj) {
    var res = await fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(bodyObj),
    });
    var data = await res.json().catch(function () { return {}; });
    return { ok: res.ok, data: data };
  }

  function bindButtons() {
    document.getElementById('presetSelect').onchange = function (e) { selectPreset(e.target.value); };

    document.getElementById('newBtn').onclick = function () {
      var name = (prompt('Name the new preset (e.g. "Gaming", "Bingo night"):') || '').trim().slice(0, 40);
      if (!name) return;
      if (presets[name]) { selectPreset(name); setStatus('That preset already exists — editing it.'); return; }
      presets[name] = { panels: {} };            /* unsaved until Save */
      selectPreset(name);
      setStatus('New preset "' + name + '" — arrange it, then Save.');
    };

    document.getElementById('saveBtn').onclick = async function () {
      setStatus('Saving…');
      try {
        var r = await post({ action: 'save', name: currentName, panels: collect() });
        if (!r.ok) { setStatus(r.data.error || 'Save failed'); return; }
        presets[currentName] = { panels: r.data.panels || {} };
        activeName = r.data.active || activeName;
        renderPresetBar();
        setStatus('Saved "' + currentName + '".' + (currentName === activeName ? ' It is live.' : ' Make it live to air it.'));
      } catch (e) { setStatus('Save failed: ' + e.message); }
    };

    document.getElementById('activateBtn').onclick = async function () {
      setStatus('Making live…');
      try {
        /* Save the current arrangement first, so "Make Live" always airs what
           is on screen and a brand-new preset exists before it is activated. */
        var s = await post({ action: 'save', name: currentName, panels: collect() });
        if (!s.ok) { setStatus(s.data.error || 'Save failed'); return; }
        presets[currentName] = { panels: s.data.panels || {} };
        var r = await post({ action: 'activate', name: currentName });
        if (!r.ok) { setStatus(r.data.error || 'Could not make it live'); return; }
        activeName = r.data.active || currentName;
        renderPresetBar();
        setStatus('"' + currentName + '" is live. Hit "Reload OBS Overlay" in Bot Control to swap it now.');
      } catch (e) { setStatus('Failed: ' + e.message); }
    };

    document.getElementById('deleteBtn').onclick = async function () {
      var names = Object.keys(presets);
      if (names.length <= 1) { setStatus('Keep at least one preset.'); return; }
      if (!confirm('Delete the preset "' + currentName + '"?')) return;
      try {
        var r = await post({ action: 'delete', name: currentName });
        if (!r.ok) { setStatus(r.data.error || 'Delete failed'); return; }
        delete presets[currentName];
        activeName = r.data.active || '';
        currentName = activeName || Object.keys(presets)[0] || 'Default';
        if (!presets[currentName]) presets[currentName] = { panels: {} };
        renderPresetBar();
        reloadFrame('Deleted. Now editing "' + currentName + '".');
      } catch (e) { setStatus('Delete failed: ' + e.message); }
    };

    document.getElementById('reloadBtn').onclick = function () {
      reloadFrame('Reverted "' + currentName + '" to its last saved state.');
    };

    document.getElementById('resetBtn').onclick = async function () {
      if (!confirm('Reset "' + currentName + '" — every panel back to its default position?')) return;
      try {
        var r = await post({ action: 'reset', name: currentName });
        if (!r.ok) { setStatus('Reset failed'); return; }
        presets[currentName] = { panels: {} };
        reloadFrame('"' + currentName + '" reset to defaults.');
      } catch (e) { setStatus('Reset failed: ' + e.message); }
    };
  }

  boot();
})();
