/* ══════════════════════════════════════════════
   CHAT MAZE — the overlay panel.

   Separate file for the same reason the scramble and MTGBBB panels are:
   a broken game panel must never take the alert feed down with it.

   The renderer is the test page's, sized for stream: one rover gliding on
   a transform transition, walls as borders straight off the wire's hex
   digits, the clear choreographed as fade-out → MAZE COMPLETE card →
   new board fades in. The overlay reads ANONYMOUSLY, so the wire itself
   is the fog — unrevealed walls arrive as '.', the ladder and the bones
   only exist once chat has seen them. Nothing here could leak the board
   even if it wanted to.

   The word-pad is a live indicator, not controls (nobody clicks an OBS
   source): whichever direction chat sent lights up, amber on a bonk, and
   the last few inputs scroll beneath with their senders' names.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1000;
  var IDLE_POLL_MS = 5000;
  var BOARD_PX = 300, PAD = 6;

  var panel = document.getElementById('ovMaze');
  if (!panel) return;
  /* Layout mode owns the screen: overlay-layout.js fills every panel with
     sample content so OBS can be arranged offline. The live pollers stand
     down so nothing fetches and nothing hides what layout placed. */
  if (new URLSearchParams(location.search).get('layout')) return;

  var board = document.getElementById('ovMazeBoard');
  var timer = null;
  var lastLevel = null;
  var lastTransitionAt = null;
  var lastMoveAt = null;
  var staging = false;
  var latest = null;
  var cellPx = 0;

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  function poll() {
    fetch('/api/bot/maze', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (g) {
        if (!g || g.status !== 'active') {
          panel.hidden = true;
          lastLevel = null;
          schedule(IDLE_POLL_MS);
          return;
        }
        latest = g;
        render(g);
        panel.hidden = false;
        schedule(POLL_MS);
      })
      .catch(function () {
        /* Silent, like every panel here: the stream never carries a debug
           banner because one poll blipped. */
        schedule(IDLE_POLL_MS);
      });
  }

  function render(g) {
    document.getElementById('ovMazeTitle').textContent =
      '🧭 MAZE ' + g.level + ' · ' + g.size + '×' + g.size;
    document.getElementById('ovMazeStats').textContent =
      g.moves + ' moves · 🦴 ' + g.bonesFound + '/' + g.bonesTotal;

    flashPad(g.lastMove);
    renderRecent(g.recent || []);

    var t = g.transition;
    if (t && lastTransitionAt !== null && t.at !== lastTransitionAt && !staging) {
      lastTransitionAt = t.at;
      staging = true;
      board.classList.add('fading');
      setTimeout(function () {
        document.getElementById('ovMazeDoneText').innerHTML =
          'MAZE ' + t.clearedLevel + ' COMPLETE!' +
          '<small>' + t.moves + ' moves · winning move by ' + escapeHtml(t.by) + '</small>';
        document.getElementById('ovMazeDone').classList.add('show');
      }, 900);
      setTimeout(function () {
        document.getElementById('ovMazeDone').classList.remove('show');
        lastLevel = null;
        buildBoard(latest);
        placeRover(latest, true);
        board.classList.remove('fading');
        staging = false;
      }, 2400);
      return;
    }
    if (t && lastTransitionAt === null) lastTransitionAt = t.at;
    if (staging) return;

    buildBoard(g);
    placeRover(g, false);
  }

  function buildBoard(g) {
    if (!g || g.status !== 'active') return;
    if (lastLevel !== g.level) {
      cellPx = Math.floor(BOARD_PX / g.size);
      board.style.gridTemplateColumns = 'repeat(' + g.size + ', ' + cellPx + 'px)';
      board.style.gridAutoRows = cellPx + 'px';
      var html = '';
      for (var y = 0; y < g.size; y++) {
        for (var x = 0; x < g.size; x++) {
          html += '<div class="cell" id="ovmz_' + x + '_' + y + '"></div>';
        }
      }
      html += '<div class="rover" id="ovMazeRover"></div>';
      board.innerHTML = html;
      lastLevel = g.level;
    }

    /* Dressed every poll: fog lifts between polls, and the wire is the
       fog, so '.' simply draws nothing. */
    var bones = {};
    (g.bones || []).forEach(function (b) { bones[b.x + '_' + b.y] = true; });
    for (var y = 0; y < g.size; y++) {
      for (var x = 0; x < g.size; x++) {
        var cell = document.getElementById('ovmz_' + x + '_' + y);
        if (!cell) continue;
        var digit = g.walls[y][x];
        var hidden = digit === '.';
        var bits = hidden ? 0 : parseInt(digit, 16);
        cell.className = 'cell' +
          ((bits & 1) ? ' n' : '') + ((bits & 2) ? ' e' : '') +
          ((bits & 4) ? ' s' : '') + ((bits & 8) ? ' w' : '') +
          (hidden ? ' dark' : '');
        var marks = '';
        if (bones[x + '_' + y]) marks += '<span class="mark">🦴</span>';
        if (g.goal && x === g.goal.x && y === g.goal.y) marks += '<span class="mark">🪜</span>';
        if (cell.innerHTML !== marks) cell.innerHTML = marks;
      }
    }
  }

  function placeRover(g, instant) {
    var rover = document.getElementById('ovMazeRover');
    if (!rover) return;
    var d = Math.max(8, Math.round(cellPx * 0.55));
    rover.style.width = d + 'px';
    rover.style.height = d + 'px';
    if (instant) rover.classList.add('no-anim');

    var cx = PAD + g.pos.x * cellPx + cellPx / 2;
    var cy = PAD + g.pos.y * cellPx + cellPx / 2;
    var moved = g.lastMove && g.lastMove.at !== lastMoveAt;

    if (moved && g.lastMove.blocked && !instant) {
      var D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[g.lastMove.dir] || [0, 0];
      setXY(rover, cx + D[0] * cellPx * 0.28, cy + D[1] * cellPx * 0.28, d);
      setTimeout(function () { setXY(rover, cx, cy, d); }, 140);
    } else {
      setXY(rover, cx, cy, d);
    }
    if (instant) { void rover.offsetWidth; rover.classList.remove('no-anim'); }
    if (moved) lastMoveAt = g.lastMove.at;
  }

  function setXY(rover, x, y, d) {
    rover.style.transform = 'translate(' + (x - d / 2) + 'px,' + (y - d / 2) + 'px)';
  }

  function flashPad(lastMove) {
    if (!lastMove || lastMove.at === lastMoveAt) return;
    var el = document.querySelector('#ovMazePad span[data-dir="' + lastMove.dir + '"]');
    if (!el) return;
    var cls = lastMove.blocked ? 'lit-bonk' : 'lit';
    el.classList.add(cls);
    setTimeout(function () { el.classList.remove(cls); }, 500);
  }

  function renderRecent(recent) {
    var ol = document.getElementById('ovMazeRecent');
    ol.innerHTML = recent.slice().reverse().slice(0, 5).map(function (m) {
      return '<li>' + m.dir + (m.blocked ? ' (bonk)' : '') + ' — ' + escapeHtml(m.by) + '</li>';
    }).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  poll();
})();
