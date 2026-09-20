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
  var saved = {};           /* {id:{x,y}} last known-good, for Revert */

  function fitScale() {
    scale = stageFrame.clientWidth / CANVAS_W;
    frame.style.transform = 'scale(' + scale + ')';
    stageFrame.style.height = (CANVAS_H * scale) + 'px';
  }

  async function boot() {
    var data;
    try {
      var res = await fetch(API, { cache: 'no-store' });
      data = await res.json();
    } catch (e) { notice.textContent = 'Could not reach the server.'; return; }

    if (!data.staff) {
      notice.textContent = 'The overlay layout editor is for the broadcaster and moderators. '
        + 'Sign in on the main site as staff.';
      return;
    }
    saved = data.panels || {};
    notice.style.display = 'none';
    document.getElementById('editor').style.display = '';

    /* The iframe must not run its own live fetch under us. */
    try { frame.contentWindow.__ovLayoutManaged = true; } catch (e) {}

    fitScale();
    window.addEventListener('resize', function () { fitScale(); });

    if (frame.contentDocument && frame.contentDocument.readyState === 'complete') wireFrame();
    else frame.addEventListener('load', wireFrame);

    bindButtons();
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
      var pos = saved[spec.id];
      if (!pos) {
        /* Inside the same-origin iframe the document lays out at native
           1920×1080 — the CSS scale lives in the PARENT and is invisible
           here — so this rect is already in canvas pixels. No /scale. */
        var r = el.getBoundingClientRect();
        pos = { x: r.left / CANVAS_W * 100, y: r.top / CANVAS_H * 100 };
      }
      if (apply) apply(el, pos.x, pos.y);
      el.dataset.px = pos.x;
      el.dataset.py = pos.y;

      makeDraggable(el, apply);
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
      if (apply) apply(el, x, y);
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

  function collect() {
    var doc = frame.contentDocument;
    var out = {};
    ((frame.contentWindow.OverlaySamples || {}).PANELS || []).forEach(function (spec) {
      var el = doc.getElementById(spec.id);
      if (el && el.dataset.px !== undefined) {
        out[spec.id] = { x: Number(el.dataset.px), y: Number(el.dataset.py) };
      }
    });
    return out;
  }

  function bindButtons() {
    document.getElementById('saveBtn').onclick = async function () {
      var status = document.getElementById('status');
      status.textContent = 'Saving…';
      try {
        var res = await fetch(API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'save', panels: collect() }),
        });
        var data = await res.json();
        if (!res.ok) { status.textContent = data.error || 'Save failed'; return; }
        saved = data.panels || {};
        status.textContent = 'Saved — the overlay will use this on its next load.';
      } catch (e) { status.textContent = 'Save failed: ' + e.message; }
    };

    document.getElementById('reloadBtn').onclick = function () {
      wired = false;
      frame.contentWindow.location.reload();
      frame.addEventListener('load', wireFrame, { once: true });
      document.getElementById('status').textContent = 'Reverted to the last saved layout.';
    };

    document.getElementById('resetBtn').onclick = async function () {
      if (!confirm('Reset every panel to its default position? The saved layout is deleted.')) return;
      var status = document.getElementById('status');
      try {
        var res = await fetch(API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin', body: JSON.stringify({ action: 'reset' }),
        });
        if (!res.ok) { status.textContent = 'Reset failed'; return; }
        saved = {};
        wired = false;
        frame.contentWindow.location.reload();
        frame.addEventListener('load', wireFrame, { once: true });
        status.textContent = 'Reset to defaults.';
      } catch (e) { status.textContent = 'Reset failed: ' + e.message; }
    };
  }

  boot();
})();
