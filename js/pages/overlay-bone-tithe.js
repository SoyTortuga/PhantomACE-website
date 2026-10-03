/* ══════════════════════════════════════════════
   SKULL CLICKER BONE TITHE — the overlay panel.

   A single horizontal progress bar toward the community offering goal. The
   whole site fills it by tithing skulls together; this just shows how close the
   stream is. It finds its own goal (the server holds one at a time), so OBS
   never needs a code. Hidden unless a tithe is live.

   Marathon-safe: no animation loop — only a self-rescheduling poll that backs
   off to a slow idle interval and hides the panel to display:none (the
   [hidden]{display:none} guard in overlay.css) whenever no goal is active, so
   nothing runs and nothing grows while idle. The bar width is a plain CSS
   transition. On completion it shows a "goal met" state briefly, then the
   server-derived status flips to 'none' and the panel clears itself.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 3000;
  var IDLE_POLL_MS = 10000;

  var panel = document.getElementById('ovTithe');
  if (!panel) return;
  if (new URLSearchParams(location.search).get('layout')) return;   // layout mode fills panels itself

  var titleEl = document.getElementById('ovTitheTitle');
  var pctEl = document.getElementById('ovTithePct');
  var barEl = document.getElementById('ovTitheBar');
  var amtEl = document.getElementById('ovTitheAmt');
  var subEl = document.getElementById('ovTitheSub');
  var topEl = document.getElementById('ovTitheTop');

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function fmt(n) {
    n = Math.floor(n || 0);
    if (n < 1000) return String(n);
    var u = ['', 'K', 'M', 'B', 'T', 'Qa'], t = Math.min(Math.floor(Math.log10(n) / 3), u.length - 1);
    var s = n / Math.pow(10, t * 3);
    return (s < 10 ? s.toFixed(1) : Math.round(s)) + u[t];
  }

  var timer = null;
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }

  function render(s) {
    var complete = s.status === 'complete';
    panel.classList.toggle('is-complete', complete);
    titleEl.textContent = s.title || 'Bone Tithe';
    var pct = Math.max(0, Math.min(100, s.pct || 0));
    barEl.style.width = pct + '%';
    pctEl.textContent = complete ? 'GOAL MET' : Math.floor(pct) + '%';
    amtEl.textContent = fmt(s.progress) + ' / ' + fmt(s.goal) + ' skulls';
    var n = s.contributors || 0;
    subEl.textContent = complete
      ? 'The Reaper is sated — ' + n + ' offered'
      : n + (n === 1 ? ' reaper offering' : ' reapers offering');
    var top = Array.isArray(s.top) ? s.top.slice(0, 3) : [];
    topEl.innerHTML = top.length
      ? top.map(function (t) { return '<li>' + esc(t.name) + ' · ' + fmt(t.amt) + '</li>'; }).join('')
      : '';
  }

  function poll() {
    fetch('/api/bone-tithe', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s || (s.status !== 'active' && s.status !== 'complete')) {
          panel.hidden = true;
          schedule(IDLE_POLL_MS);
          return;
        }
        panel.hidden = false;
        render(s);
        schedule(s.status === 'complete' ? IDLE_POLL_MS : POLL_MS);
      })
      .catch(function () { panel.hidden = true; schedule(IDLE_POLL_MS); });
  }

  poll();
})();
