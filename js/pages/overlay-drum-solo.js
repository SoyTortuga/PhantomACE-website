/* ══════════════════════════════════════════════
   DRUM SOLO METER — the overlay panel.

   A hype meter chat fills by smashing !solo while PhantomACE plays a solo. The
   phamDrum emote drums beside a progress bar and a countdown; it finds its own
   event (the server holds one at a time), so OBS never needs a code. Hidden
   unless a solo is live.

   COLLABORATIVE — no loss state. Fill the meter and the panel flashes a
   phamDrum "FILLED!" celebration for a beat; the server then flips the status
   to gone and this hides itself. Countdown expires unfilled → it just hides,
   quietly, no penalty banner.

   Marathon-safe: no animation loop in JS — only a self-rescheduling poll that
   backs off to a slow idle interval and hides the panel to display:none (the
   [hidden]{display:none} guard in overlay.css) whenever no solo is active, so
   nothing runs and nothing grows while idle. The bar width is a plain CSS
   transition, and the drumming emote is a CSS animation that is inert while the
   panel is display:none (hidden panels do not animate). Lists are never grown —
   every field is overwritten in place.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1000;        // during a live/filled event — a crisp countdown
  var IDLE_POLL_MS = 8000;   // backed off while nothing is running

  var panel = document.getElementById('ovDrum');
  if (!panel) return;
  if (new URLSearchParams(location.search).get('layout')) return;   // layout mode fills panels itself

  var timerEl = document.getElementById('ovDrumTimer');
  var barEl = document.getElementById('ovDrumBar');
  var pctEl = document.getElementById('ovDrumPct');
  var countEl = document.getElementById('ovDrumCount');
  var noteEl = document.getElementById('ovDrumNote');

  var timer = null;
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }

  function render(s) {
    var filled = s.status === 'filled';
    panel.classList.toggle('is-filled', filled);

    var pct = Math.max(0, Math.min(100, s.pct || 0));
    barEl.style.width = pct + '%';
    pctEl.textContent = filled ? 'FILLED!' : Math.floor(pct) + '%';

    var n = Math.max(0, s.participants || 0);
    countEl.textContent = n + (n === 1 ? ' drummer' : ' drummers');

    if (filled) {
      timerEl.textContent = '';
      noteEl.innerHTML = '🥁🔥 Chat brought the house down!';
    } else {
      /* Server-stamped clock so the countdown is immune to OBS-PC skew: both
         endsAt and serverNow come from the same reply. */
      var left = Math.max(0, Math.ceil(((s.endsAt || 0) - (s.serverNow || 0)) / 1000));
      timerEl.textContent = left + 's';
      noteEl.innerHTML = 'Smash <b>!solo</b> to fill the meter!';
    }
  }

  function poll() {
    fetch('/api/drum-solo', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s || (s.status !== 'active' && s.status !== 'filled')) {
          panel.hidden = true;
          panel.classList.remove('is-filled');
          schedule(IDLE_POLL_MS);
          return;
        }
        panel.hidden = false;
        render(s);
        schedule(POLL_MS);
      })
      .catch(function () { panel.hidden = true; schedule(IDLE_POLL_MS); });
  }

  poll();
})();
