/* ══════════════════════════════════════════════
   PHAMSHOCK WIND NIGHT — the overlay panel.

   A standing panel, sibling to overlay-mana-clash-chat.js, independent of
   everything else: it polls its own endpoint, /api/pham-wind-night, for the one
   live Wind Night session and draws the current wind. The server is
   authoritative; this only draws.

   MARATHON-SAFE, like every overlay panel: it hides to display:none when no
   session is live (the [hidden] attribute + a CSS guard), polls slowly while
   idle so nothing runs on a hot loop with nothing to show, and never appends —
   it overwrites a fixed set of fields, so it cannot grow across an all-night
   source. No box-shadow, no backdrop-filter.

   IT YIELDS TO ALERTS the same way the other panels do: overlay.js puts
   `ov-alerting` on the body while a card is up and the stylesheet moves this
   aside. Nothing here has to know what an alert looks like.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1500;         // live: snappy enough to track chat's gusts
  var IDLE_POLL_MS = 8000;    // nothing on: check rarely

  var panel = document.getElementById('ovWind');
  if (!panel) return;
  /* Layout mode owns the screen — stand down so nothing fetches or hides what
     the layout editor placed. */
  if (new URLSearchParams(location.search).get('layout')) return;

  var arrowEl = document.getElementById('ovWindArrow');
  var strengthEl = document.getElementById('ovWindStrength');
  var barEl = document.getElementById('ovWindBar');

  var timer = null;
  var key = new URLSearchParams(location.search).get('key') || '';

  function hide() { panel.hidden = true; }

  function render(d) {
    var max = Number(d.max) || 8;
    var strength = Math.max(0, Number(d.strength) || 0);
    var frac = Math.max(0, Math.min(1, strength / max));

    arrowEl.textContent = d.dir === 'right' ? '→' : d.dir === 'left' ? '←' : '·';
    strengthEl.textContent = strength.toFixed(1);

    /* The fill grows from the centre toward the wind's side. */
    if (d.dir === 'right') {
      barEl.style.left = '50%';
      barEl.style.width = (frac * 50) + '%';
    } else if (d.dir === 'left') {
      barEl.style.left = (50 - frac * 50) + '%';
      barEl.style.width = (frac * 50) + '%';
    } else {
      barEl.style.left = '50%';
      barEl.style.width = '0%';
    }
  }

  /* ── WHAT'S ON STREAM GATE ──────────────────────────────────────────────
     Fetches only while the one `whatsOn` pointer (js/pages/overlay.js) names
     this event; otherwise it hides and does no network at all. functions/api/pham-wind-night.js
     already refreshes and clears that pointer for Wind Night, so the pointer's
     lifetime is exactly the event's -- the server half was wired and this half
     was not, so the panel asked every 8 seconds, for the whole of a
     marathon stream, to be told "nothing on" again.

     mine() is undefined until the bus has answered, and there is no bus at all
     without overlay.js. Both fall through to polling as before, so a panel
     opened standalone is unaffected. */
  var MY_GAME = 'phamshock';
  var bus = (typeof window !== 'undefined' && window.PhamWhatsOn) ? window.PhamWhatsOn : null;
  function mine() {
    if (!bus) return undefined;
    var w = bus.get();
    if (w === undefined) return undefined;
    return !!(w && w.game === MY_GAME);
  }
  var lastVerdict;
  function onBus() {
    var v = mine();
    if (v === lastVerdict) return;
    lastVerdict = v;
    /* The pointer just changed: look now rather than waiting out the idle
       backoff, so the panel appears the moment the event starts. */
    schedule(0);
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  /* Switched off and broken must not look the same — the shared fault indicator
     the other panels use, keyed separately. */
  var FAULTS_BEFORE_NOTICE = 5;
  var faults = 0;

  function reportFault(status) {
    faults++;
    if (faults < FAULTS_BEFORE_NOTICE || typeof window.ovSetFault !== 'function') return;
    window.ovSetFault('phamWind', true,
      status === 403 ? 'wind: overlay key rejected'
      : status === 404 ? 'wind: route not deployed'
      : 'wind: unreachable');
  }

  function clearFault() {
    faults = 0;
    if (typeof window.ovSetFault === 'function') window.ovSetFault('phamWind', false);
  }

  function poll() {
    /* Not our event, and the bus has said so: stay hidden, no fetch. */
    if (mine() === false) { hide(); schedule(IDLE_POLL_MS); return; }
    fetch('/api/pham-wind-night?key=' + encodeURIComponent(key), { cache: 'no-store' })
      .then(function (r) {
        if (r.ok) { clearFault(); return r.json(); }
        reportFault(r.status);
        return null;
      })
      .then(function (d) {
        if (!d || !d.status || d.status === 'none') {
          hide();
          schedule(IDLE_POLL_MS);
          return;
        }
        render(d);
        panel.hidden = false;
        schedule(POLL_MS);
      })
      .catch(function () {
        /* Keep whatever was last shown — one blip must not drop the panel —
           but count it; a network that never comes back is a fault. */
        reportFault(0);
        schedule(IDLE_POLL_MS);
      });
  }

  if (bus) bus.subscribe(onBus);
  poll();
})();
