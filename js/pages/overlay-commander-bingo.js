/* ══════════════════════════════════════════════
   COMMANDER BINGO — the overlay panel.

   The same idea as the MTGBBB panel: the calls and the wins are alerts and
   go through the shared queue in overlay.js; what lives here is the standing
   STATE you want to glance at all game — how far through the squares we are,
   how many are playing, and who has WON.

   No leaderboard of points, because the game has none: the host calls
   squares, players spot their own bingos, and the host awards a prize. So
   "who's winning" is the winners board — everyone the host has awarded.

   HIDDEN UNLESS A GAME IS RUNNING, so the overlay stays a transparent alert
   layer otherwise and can be left in every scene.

   IT FINDS ITS OWN GAME via bingo_current, so OBS never needs a room code in
   its URL — the same reason MTGBBB does it.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 2000;
  var IDLE_POLL_MS = 10000;    // nothing running: check rarely
  var TOP_N = 6;
  var CALLED_N = 7;            // most-recent called squares shown, then "+N"

  var panel = document.getElementById('ovBingo');
  if (!panel) return;
  /* Layout mode owns the screen: overlay-samples fills every panel with
     sample content so OBS can be arranged offline. The live pollers stand
     down so nothing fetches and nothing hides what layout placed. */
  if (new URLSearchParams(location.search).get('layout')) return;

  var progressEl = document.getElementById('ovBingoProgress');
  var barEl = document.getElementById('ovBingoBar');
  var playersEl = document.getElementById('ovBingoPlayers');
  var callLabelEl = document.getElementById('ovBingoCallLabel');
  var moreEl = document.getElementById('ovBingoMore');
  var calledEl = document.getElementById('ovBingoCalled');
  var winLabelEl = document.getElementById('ovBingoWinLabel');
  var listEl = document.getElementById('ovBingoTop');

  var timer = null;

  /* id -> square text, from the shared BINGO_EVENTS list overlay.html loads.
     Absent only if that file failed to load, in which case a called square
     falls back to its number rather than breaking the panel. */
  var NAMES = {};
  if (typeof BINGO_EVENTS !== 'undefined' && Array.isArray(BINGO_EVENTS)) {
    for (var i = 0; i < BINGO_EVENTS.length; i++) NAMES[BINGO_EVENTS[i].id] = BINGO_EVENTS[i].text;
  }
  function nameFor(id) { return NAMES[id] || ('Square ' + id); }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function hide() { panel.hidden = true; }

  function render(g) {
    var called = Number(g.calledCount) || 0;
    var total = Number(g.total) || 0;

    progressEl.textContent = total > 0
      ? called + ' / ' + total + ' called'
      : (called ? called + ' called' : 'No squares called yet');

    var pct = total > 0 ? Math.max(0, Math.min(100, (called / total) * 100)) : 0;
    barEl.style.width = pct + '%';

    var players = Number(g.playerCount) || 0;
    playersEl.textContent = players === 1 ? '1 player' : players + ' players';

    /* The game in progress: the squares called so far, most recent first so
       the newest is always at the top where the eye lands. Capped, with a
       "+N" so a full board does not run off the screen. */
    var ids = Array.isArray(g.calledEvents) ? g.calledEvents : [];
    if (!ids.length) {
      callLabelEl.hidden = true;
      calledEl.innerHTML = '<li class="ov-bingo-empty">No squares called yet</li>';
    } else {
      callLabelEl.hidden = false;
      var recent = ids.slice().reverse();
      var shown = recent.slice(0, CALLED_N);
      moreEl.textContent = recent.length > CALLED_N ? '+' + (recent.length - CALLED_N) : '';
      var chtml = '';
      for (var c = 0; c < shown.length; c++) {
        chtml += '<li>' + esc(nameFor(shown[c])) + '</li>';
      }
      calledEl.innerHTML = chtml;
    }

    var winners = Array.isArray(g.winners) ? g.winners.slice(0, TOP_N) : [];
    if (!winners.length) {
      winLabelEl.hidden = true;
      listEl.innerHTML = '<li class="ov-bingo-empty">No winners yet</li>';
      return;
    }

    winLabelEl.hidden = false;
    var html = '';
    for (var i = 0; i < winners.length; i++) {
      var w = winners[i];
      var rarity = String(w.rarity || '').toLowerCase();
      html += '<li>' +
        '<span class="ov-bingo-name">' + esc(w.name) + '</span>' +
        '<span class="ov-bingo-rarity" data-rarity="' + esc(rarity) + '">' + esc(rarity) + '</span>' +
        '</li>';
    }
    listEl.innerHTML = html;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  function poll() {
    fetch('/api/bingo/state?current=1', { cache: 'no-store' })
      .then(function (r) {
        /* A 404 is the ordinary "no game right now" case, not a fault. Only a
           running game should ever put this on screen. */
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (g) {
        if (!g || !g.code || g.status !== 'active') {
          hide();
          schedule(IDLE_POLL_MS);
          return;
        }
        render(g);
        panel.hidden = false;
        schedule(POLL_MS);
      })
      .catch(function () {
        /* Silent — a stream must never carry a debug banner because one poll
           blipped, and the panel keeps showing what it last had. */
        schedule(IDLE_POLL_MS);
      });
  }

  poll();
})();
