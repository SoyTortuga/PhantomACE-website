/* ══════════════════════════════════════════════
   DINO STREAM SAFARI — the overlay panel.

   A standing panel, sibling to overlay-pham-wind.js, independent of everything
   else: it polls its own endpoint, /api/dino-safari, for the live Safari and
   draws the current wild dino, the catch countdown, and the winner when a spawn
   resolves. The server spawns, times and resolves everything; this only draws.

   MARATHON-SAFE, like every overlay panel: it hides to display:none when no
   Safari is live (the [hidden] attribute + a CSS guard), polls slowly while idle
   so nothing runs on a hot loop with nothing to show, and never appends — it
   overwrites a fixed set of fields, so it cannot grow across an all-night
   source. No box-shadow, no backdrop-filter.

   IT YIELDS TO ALERTS the same way the other panels do: overlay.js puts
   `ov-alerting` on the body while a card is up and the stylesheet moves this
   aside. Nothing here has to know what an alert looks like.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1000;         // live: snappy enough for the catch countdown
  var IDLE_POLL_MS = 8000;    // nothing on: check rarely
  var FALLBACK = '/assets/images/phantomace-logo.png';

  var panel = document.getElementById('ovSafari');
  if (!panel) return;
  /* Layout mode owns the screen — stand down so nothing fetches or hides what
     the layout editor placed. */
  if (new URLSearchParams(location.search).get('layout')) return;

  var artEl = document.getElementById('ovSafariArt');
  var nameEl = document.getElementById('ovSafariName');
  var rarityEl = document.getElementById('ovSafariRarity');
  var timerEl = document.getElementById('ovSafariTimer');
  var noteEl = document.getElementById('ovSafariNote');
  var rollsEl = document.getElementById('ovSafariRolls');

  var timer = null;
  var key = new URLSearchParams(location.search).get('key') || '';
  var artSrcNow = '';

  function hide() { panel.hidden = true; }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

  /* Set the art only when the URL actually changes, so a once-a-second poll does
     not re-request the same sprite. onerror falls back to the PhantomACE mark
     rather than a broken image on stream, guarded so a failing fallback cannot
     loop. */
  function setArt(src) {
    var want = src || FALLBACK;
    if (want === artSrcNow) return;
    artSrcNow = want;
    artEl.onerror = function () {
      artEl.onerror = null;
      artEl.src = FALLBACK;
      artSrcNow = FALLBACK;
    };
    artEl.src = want;
  }

  function render(d) {
    var win = d.lastWin || null;
    var spawn = d.spawn || null;

    if (d.phase === 'catch' && spawn) {
      panel.classList.remove('is-won');
      panel.setAttribute('data-rarity', spawn.rarity || 'common');
      setArt(spawn.portrait || spawn.icon);
      nameEl.textContent = spawn.name || '';
      rarityEl.textContent = (spawn.mutation ? cap(spawn.mutation) + ' · ' : '') + cap(spawn.rarity);
      var secs = Math.ceil((Number(d.msLeft) || 0) / 1000);
      timerEl.textContent = secs + 's';
      var catchers = Number(d.catchers) || 0;
      noteEl.innerHTML = catchers
        ? 'Type <b>!catch</b> — ' + catchers + (catchers === 1 ? ' hunter' : ' hunters')
        : 'A wild dino appeared — type <b>!catch</b>';
      /* What the gap's tracking bought, shown on the dino it bought — the
         payoff is only meaningful next to the result. */
      rollsEl.textContent = (Number(d.rolls) || 1) > 1
        ? (d.rolls + '× roll from ' + d.trackedBy + ' tracking')
        : '';
      return;
    }

    /* Between spawns: show the winner banner if one is fresh, else a wait line. */
    if (win) {
      panel.classList.add('is-won');
      panel.setAttribute('data-rarity', win.rarity || 'common');
      setArt(win.portrait || win.icon);
      nameEl.textContent = win.name || '';
      rarityEl.textContent = (win.mutation ? cap(win.mutation) + ' · ' : '') + cap(win.rarity);
      timerEl.textContent = '';
      rollsEl.textContent = '';
      if (win.caught && win.winnerName) {
        noteEl.innerHTML = esc(win.winnerName) + ' caught the ' + esc(win.name) + '!';
      } else if (win.caught) {
        noteEl.textContent = 'Caught!';
      } else {
        noteEl.textContent = 'It got away!';
      }
      return;
    }

    panel.classList.remove('is-won');
    panel.removeAttribute('data-rarity');
    nameEl.textContent = 'Tracking…';
    rarityEl.textContent = '';
    timerEl.textContent = '';
    setArt(FALLBACK);

    /* The gap is most of a Safari, so this is the line chat looks at longest.
       It shows what the turnout has already earned, not just an instruction. */
    var trackers = Number(d.trackers) || 0;
    var rolls = Number(d.rolls) || 1;
    rollsEl.textContent = rolls > 1 ? rolls + '× roll' : '';
    noteEl.innerHTML = trackers
      ? trackers + (trackers === 1 ? ' tracker' : ' trackers') + ' — <b>!track</b> for better odds'
      : 'Type <b>!track</b> to improve the next dino';
  }

  function esc(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
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
    window.ovSetFault('dinoSafari', true,
      status === 403 ? 'safari: overlay key rejected'
      : status === 404 ? 'safari: route not deployed'
      : 'safari: unreachable');
  }

  function clearFault() {
    faults = 0;
    if (typeof window.ovSetFault === 'function') window.ovSetFault('dinoSafari', false);
  }

  function poll() {
    fetch('/api/dino-safari?key=' + encodeURIComponent(key), { cache: 'no-store' })
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

  poll();
})();
