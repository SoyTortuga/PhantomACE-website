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

  function applyOne(el, x, y) {
    if (!el) return;
    el.style.left = x + '%';
    el.style.top = y + '%';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';    /* ovMc/ovStage centre themselves by default */
  }

  function applyAll(panels) {
    if (!panels) return;
    Object.keys(panels).forEach(function (id) {
      var el = document.getElementById(id);
      var p = panels[id];
      if (el && p) applyOne(el, p.x, p.y);
    });
  }

  window.OverlayLayout = { applyOne: applyOne, applyAll: applyAll };

  /* The live fetch. The editor sets window.__ovLayoutManaged so this does
     not also fetch underneath it. Silent on failure — a missing layout is
     the ordinary first-run case, and the panels simply keep their defaults. */
  if (window.__ovLayoutManaged) return;
  fetch('/api/overlay/layout', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.panels) applyAll(d.panels); })
    .catch(function () {});
})();
