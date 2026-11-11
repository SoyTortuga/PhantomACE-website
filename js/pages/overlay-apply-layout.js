/* ══════════════════════════════════════════════
   APPLY THE SAVED OVERLAY LAYOUT.

   Runs on the live overlay AND in layout mode: fetch the saved positions
   once and pin each panel to its corner. Percentages of the viewport, so
   whatever the OBS source size, a panel saved at 20%/70% lands there.

   NORMALISES EVERY PANEL to top-left anchoring: the defaults are a mix of
   left/right/bottom corners and a couple of centring transforms, so a
   saved position sets left/top and clears the rest, or a panel would fight
   its own default anchor. A panel with no saved position keeps its CSS
   default untouched — the layout is opt-in per panel.

   Exposes applyOne() so the editor can pin a panel live as it is dragged,
   from the same code that positions it on stream — what you drag is what
   airs.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  function applyOne(el, x, y, s) {
    if (!el) return;
    var scale = (s === undefined || s === null) ? 1 : Number(s) || 1;
    el.style.left = x + '%';
    el.style.top = y + '%';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    /* Scale from the TOP-LEFT, so the pinned corner is the anchor and the
       panel grows down-and-right rather than drifting off its saved spot.
       This also overrides the centring transforms ovMc/ovStage default to. */
    el.style.transformOrigin = 'top left';
    el.style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')';
  }

  /* Every inline property applyOne can set, back to nothing — so the panel
     falls back to its CSS default and its own [hidden] guard governs it again. */
  function clearOne(el) {
    if (!el) return;
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
    el.style.transform = '';
    el.style.transformOrigin = '';
    el.style.display = '';
  }

  /* The ids the CURRENT layout positioned. Presets are swapped live (a
     category change can do it mid-stream), and without this a panel the old
     preset placed or hid would keep those inline styles forever when the new
     preset simply does not mention it — stuck off-screen, or stuck hidden,
     with nothing in the new layout to explain why. */
  var applied = [];

  function applyAll(panels) {
    if (!panels) return;
    var next = [];
    Object.keys(panels).forEach(function (id) {
      var el = document.getElementById(id);
      var p = panels[id];
      if (!el || !p) return;
      next.push(id);
      /* Removed from this preset: force it off, over-riding whatever its game
         poller does with the `hidden` attribute. A panel NOT in the map, or
         one without `hidden`, keeps its game-driven visibility untouched. */
      if (p.hidden) { el.style.display = 'none'; return; }
      el.style.display = '';
      applyOne(el, p.x, p.y, p.s);
    });
    applied.forEach(function (id) {
      if (next.indexOf(id) === -1) clearOne(document.getElementById(id));
    });
    applied = next;
  }

  /* The version of the layout now on screen, so the live overlay can tell
     whether the one the poll advertises is new. */
  var ver = 0;
  var inFlight = false;

  function refresh() {
    if (inFlight) return Promise.resolve(ver);
    inFlight = true;
    return fetch('/api/overlay/layout', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.panels) applyAll(d.panels);
        if (d) ver = Number(d.ver) || 0;
        return ver;
      })
      .catch(function () { return ver; })
      .then(function (v) { inFlight = false; return v; });
  }

  window.OverlayLayout = {
    applyOne: applyOne,
    applyAll: applyAll,
    refresh: refresh,
    version: function () { return ver; },
  };

  /* The live fetch. The editor sets window.__ovLayoutManaged so this does
     not also fetch underneath it. Silent on failure — a missing layout is
     the ordinary first-run case, and the panels simply keep their defaults. */
  if (window.__ovLayoutManaged) return;
  refresh();
})();
