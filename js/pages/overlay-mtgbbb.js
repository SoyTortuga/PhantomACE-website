/* ══════════════════════════════════════════════
   MTGBBB — the overlay panel.

   Separate from overlay.js for the same reason the scramble panel is: that
   file is an alert QUEUE, one thing at a time, each shown and dismissed.
   This is standing STATE that sits on screen for a whole box.

   The pulls themselves are alerts and go through the queue — card art, the
   treatments, and how much of the room was holding it. What lives here is
   what you want to be able to glance at: how far through the box we are,
   and who is winning.

   HIDDEN UNLESS A GAME IS RUNNING, so the overlay stays a transparent alert
   layer the rest of the time and can be left in every scene rather than
   only the one.

   IT FINDS ITS OWN GAME. Asking the broadcaster to edit the OBS browser
   source URL with a room code every stream is the kind of step that gets
   forgotten once and silently shows nothing all night, so the server keeps
   a pointer to the live room and this asks for that.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 2000;
  var IDLE_POLL_MS = 10000;    // nothing running: check rarely
  var TOP_N = 5;

  var panel = document.getElementById('ovMtg');
  if (!panel) return;

  var setEl = document.getElementById('ovMtgSet');
  var packEl = document.getElementById('ovMtgPack');
  var barEl = document.getElementById('ovMtgBar');
  var listEl = document.getElementById('ovMtgTop');
  var playersEl = document.getElementById('ovMtgPlayers');

  var timer = null;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function hide() {
    panel.hidden = true;
  }

  function render(g) {
    var opened = Number(g.packsOpened) || 0;
    var total = Number(g.packCount) || 0;

    setEl.textContent = g.setName || g.setCode || '';

    /* "Pack 12 of 30" only means something if we know the total. A box count
       we do not have is better left off than shown as "of 0". */
    packEl.textContent = total > 0
      ? 'Pack ' + Math.min(opened, total) + ' / ' + total
      : (opened ? 'Pack ' + opened : '');

    var pct = total > 0 ? Math.max(0, Math.min(100, (opened / total) * 100)) : 0;
    barEl.style.width = pct + '%';

    var players = Number(g.playerCount) || 0;
    playersEl.textContent = players === 1 ? '1 player' : players + ' players';

    var board = Array.isArray(g.standings) ? g.standings.slice(0, TOP_N) : [];
    if (!board.length) {
      listEl.innerHTML = '<li class="ov-mtg-empty">Waiting for the first pull</li>';
      return;
    }

    /* Ties share a rank. The host flips a coin on stream to break them, so a
       board that silently ordered two equal scores 3rd and 4th would be
       showing a decision nobody has made. */
    var html = '';
    var rank = 0;
    var lastPoints = null;
    for (var i = 0; i < board.length; i++) {
      var p = board[i];
      var pts = Number(p.points) || 0;
      if (pts !== lastPoints) { rank = i + 1; lastPoints = pts; }
      html += '<li>' +
        '<span class="ov-mtg-rank">' + rank + '</span>' +
        '<span class="ov-mtg-name">' + esc(p.name) + '</span>' +
        '<span class="ov-mtg-pts">' + pts + '</span>' +
        '</li>';
    }
    listEl.innerHTML = html;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  function poll() {
    fetch('/api/mtgbbb/state?current=1', { cache: 'no-store' })
      .then(function (r) {
        /* A 404 is the ordinary case, not a fault: it is what "no game right
           now" looks like. Only a running game should ever put this on
           screen. */
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
        /* Silent. A stream must never carry a debug banner because one poll
           blipped, and the panel simply keeps showing what it last had. */
        schedule(IDLE_POLL_MS);
      });
  }

  poll();
})();
