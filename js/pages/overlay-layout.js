/* ══════════════════════════════════════════════
   OVERLAY LAYOUT MODE — arrange the stream overlay with nothing running.

     /overlay?layout=1

   Force-shows every panel with sample content (from overlay-samples.js,
   shared with the layout editor) and NO network, so OBS can be positioned
   offline. Each live poller stands down under the flag; this owns the
   screen. A saved layout, if one exists, is still applied first by
   overlay-apply-layout.js, so the preview shows the real arrangement.

   Purely additive: absent ?layout=1 this does nothing.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';
  if (!new URLSearchParams(location.search).get('layout')) return;

  function caption() {
    var tag = document.createElement('div');
    tag.textContent = 'LAYOUT MODE — sample data, not live. Remove ?layout=1 for the real overlay.';
    tag.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;' +
      'background:rgba(0,0,0,0.85);color:#ffcc44;border:1px solid #ff0000;' +
      'border-radius:6px;padding:6px 14px;font:700 12px system-ui,sans-serif;' +
      'letter-spacing:0.05em;pointer-events:none;';
    document.body.appendChild(tag);
  }

  function run() {
    caption();
    if (window.OverlaySamples) window.OverlaySamples.fillAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
