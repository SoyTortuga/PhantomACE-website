/* ══════════════════════════════════════════════
   CHAT MAZE — the staff test page, and the reference for the overlay.

   Everything visual here came from live-testing notes and is meant to be
   lifted onto the stream overlay as-is:

     · the dot is ONE element gliding on a transform transition — moving
       it between cells by re-parenting was why movement felt rigid, and
       a bonk now bounces it toward the wall it hit
     · a clear runs a choreographed sequence: fade the old board out,
       hold a "MAZE N COMPLETE" card, build the next board while still
       invisible, fade that in — the old board can never flash back,
       because it is never made visible again after the fade begins
     · the goal is a ladder going down to the next maze
     · the pad shows Up/Down/Left/Right as words and doubles as a live
       indicator: whichever direction arrives (from chat or here) lights
       its button, amber on a bonk
     · input history lists the last ten moves with their senders; the
       cleared panel is the session's ledger, Maze 1 downward, scrolling
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1000;
  var CELL_MAX = 52, BOARD_MAX = 480, PAD = 10;

  var staff = false;
  var latest = null;              /* freshest state, for the end of staging */
  var lastRenderedLevel = null;
  var lastTransitionAt = null;
  var lastMoveAt = null;
  var staging = false;            /* the clear choreography owns the board */
  var cellPx = 0;

  var $ = function (id) { return document.getElementById(id); };

  /* ── polling ── */

  async function poll() {
    try {
      var res = await fetch('/api/bot/maze', { cache: 'no-store' });
      var data = await res.json();
      staff = !!data.staff;
      latest = data;
      render(data);
    } catch (e) { $('status').textContent = 'unreachable'; }
  }

  function render(data) {
    $('status').textContent = data.status === 'active'
      ? 'ACTIVE — maze ' + data.level + ' (' + data.size + '×' + data.size + ')'
      : 'no maze running';
    $('startBtn').disabled = !staff || data.status === 'active';
    $('stopBtn').disabled = !staff || data.status !== 'active';
    $('padPanel').style.display = data.status === 'active' ? '' : 'none';

    renderRecent(data.recent || []);
    renderHistory(data.history || []);
    flashPad(data.lastMove);

    if (data.status !== 'active') {
      $('board').innerHTML = '';
      $('levelLine').textContent = '—';
      $('statLine').textContent = '';
      $('lastLine').textContent = '';
      lastRenderedLevel = null;
      return;
    }

    /* THE CLEAR, CHOREOGRAPHED. Once the fade starts, the old board is
       never shown again: card over the dark, then the NEW board is built
       while still transparent and fades in. The flash the first version
       had came from un-hiding before rebuilding. */
    var t = data.transition;
    if (t && lastTransitionAt !== null && t.at !== lastTransitionAt && !staging) {
      lastTransitionAt = t.at;
      staging = true;
      $('board').classList.add('fading');
      setTimeout(function () {
        $('levelDoneText').innerHTML =
          'MAZE ' + t.clearedLevel + ' COMPLETE!' +
          '<small>' + t.moves + ' moves' + (t.bonks ? ' · ' + t.bonks + ' bonks' : '') +
          ' · winning move by ' + escapeHtml(t.by) +
          ' · next: ' + (t.clearedSize + 1) + '×' + (t.clearedSize + 1) + '</small>';
        $('levelDone').classList.add('show');
      }, 900);
      setTimeout(function () {
        $('levelDone').classList.remove('show');
        lastRenderedLevel = null;
        buildBoard(latest);
        placeRover(latest, true);
        $('board').classList.remove('fading');   /* the new board fades IN */
        staging = false;
      }, 2400);
      return;
    }
    if (t && lastTransitionAt === null) lastTransitionAt = t.at;
    if (staging) return;

    buildBoard(data);
    placeRover(data, false);

    $('levelLine').textContent = 'Maze ' + data.level + ' · ' + data.size + '×' + data.size;
    $('statLine').textContent = data.moves + ' moves this maze · ' + data.bonks + ' bonks · 🦴 '
      + data.bonesFound + '/' + data.bonesTotal + ' · ' + data.totalMoves + ' total'
      + (data.topMover ? ' · top: ' + data.topMover.name + ' (' + data.topMover.moves + ')' : '');
    $('lastLine').textContent = data.lastMove
      ? 'last: ' + data.lastMove.dir + ' by ' + data.lastMove.by + (data.lastMove.blocked ? ' — BONK' : '')
      : '';
  }

  /* ── the board ── */

  function buildBoard(data) {
    if (!data || data.status !== 'active') return;
    if (lastRenderedLevel !== data.level) {
      var board = $('board');
      var size = data.size;
      cellPx = Math.min(CELL_MAX, Math.floor(BOARD_MAX / size));
      board.style.gridTemplateColumns = 'repeat(' + size + ', ' + cellPx + 'px)';
      board.style.gridAutoRows = cellPx + 'px';
      var html = '';
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          html += '<div class="cell" id="mz_' + x + '_' + y + '"></div>';
        }
      }
      /* One rover, absolutely positioned, glides over everything. */
      html += '<div class="rover" id="rover"></div>';
      board.innerHTML = html;
      lastRenderedLevel = data.level;
    }
    updateCells(data);
  }

  /* FOG LIFTS BETWEEN POLLS, so cells are dressed every poll rather than
     once per level: walls appear as their cells are revealed (the wire
     masks hidden ones to '.'), bones appear in revealed cells and vanish
     when collected, and the ladder exists only once somebody has seen it.
     Staff x-ray: hidden cells render dimmed instead of blank, so the
     tester sees the whole truth AND what chat sees, at once. */
  function updateCells(data) {
    var size = data.size;
    var revealed = data.revealed || [];
    var bones = {};
    (data.bones || []).forEach(function (b) { bones[b.x + '_' + b.y] = true; });

    /* DEFAULT IS THE VIEWER'S TRUTH. Staff receive the full board on the
       wire, but the page masks it back down unless X-ray is ticked — live
       testing read the always-on x-ray as "the fog is too light", which
       it was: it was not the fog at all, it was the answers. */
    var xray = staff && $('xrayToggle') && $('xrayToggle').checked;

    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var cell = $('mz_' + x + '_' + y);
        if (!cell) continue;
        var isRev = !!(revealed[y] && revealed[y][x] === '1');
        var digit = data.walls[y][x];
        var show = isRev || xray;
        var bits = (!show || digit === '.') ? 0 : parseInt(digit, 16);

        cell.className = 'cell' +
          ((bits & 1) ? ' n' : '') + ((bits & 2) ? ' e' : '') +
          ((bits & 4) ? ' s' : '') + ((bits & 8) ? ' w' : '') +
          (isRev ? '' : (xray ? ' xray' : ' dark'));

        var marks = '';
        if (bones[x + '_' + y] && show) marks += '<span class="bone">🦴</span>';
        if (data.goal && x === data.goal.x && y === data.goal.y &&
            (isRev || xray)) {
          marks += '<span class="ladder" title="down to the next maze">🪜</span>';
        }
        if (cell.innerHTML !== marks) cell.innerHTML = marks;
      }
    }
  }

  function roverXY(pos) {
    return {
      x: PAD + pos.x * cellPx + cellPx / 2,
      y: PAD + pos.y * cellPx + cellPx / 2,
    };
  }

  function placeRover(data, instant) {
    var rover = $('rover');
    if (!rover || !data || data.status !== 'active') return;

    var d = Math.max(10, Math.round(cellPx * 0.55));
    rover.style.width = d + 'px';
    rover.style.height = d + 'px';

    if (instant) rover.classList.add('no-anim');
    var at = roverXY(data.pos);
    var moved = data.lastMove && data.lastMove.at !== lastMoveAt;

    if (moved && data.lastMove.blocked && !instant) {
      /* The bonk: lunge a quarter-cell into the wall, then settle back.
         Both legs ride the same transition, so it reads as a bounce. */
      var D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[data.lastMove.dir] || [0, 0];
      setXY(rover, at.x + D[0] * cellPx * 0.28, at.y + D[1] * cellPx * 0.28, d);
      setTimeout(function () { setXY(rover, at.x, at.y, d); }, 140);
    } else {
      setXY(rover, at.x, at.y, d);
    }
    if (instant) {
      void rover.offsetWidth;              /* commit before re-enabling */
      rover.classList.remove('no-anim');
    }
    if (moved) lastMoveAt = data.lastMove.at;
  }

  function setXY(rover, x, y, d) {
    rover.style.transform = 'translate(' + (x - d / 2) + 'px,' + (y - d / 2) + 'px)';
  }

  /* ── the pad as a live indicator ── */

  function flashPad(lastMove) {
    if (!lastMove || lastMove.at === lastMoveAt) return;
    var btn = document.querySelector('.pad .btn[data-dir="' + lastMove.dir + '"]');
    if (!btn) return;
    var cls = lastMove.blocked ? 'lit-bonk' : 'lit';
    btn.classList.add(cls);
    setTimeout(function () { btn.classList.remove(cls); }, 500);
  }

  /* ── side panels ── */

  function renderRecent(recent) {
    var ul = $('recentList');
    if (!recent.length) { ul.innerHTML = '<li>none yet</li>'; return; }
    ul.innerHTML = recent.slice().reverse().map(function (m) {
      return '<li><b>' + m.dir + '</b>' + (m.blocked ? ' (bonk)' : '') +
        ' — ' + escapeHtml(m.by) + '</li>';
    }).join('');
  }

  function renderHistory(history) {
    var ul = $('historyList');
    if (!history.length) { ul.innerHTML = '<li>none yet</li>'; return; }
    /* Maze 1 first, latest at the bottom, and the scroll follows the
       bottom — the ledger reads downward like the session happened. */
    ul.innerHTML = history.map(function (h) {
      return '<li>Maze ' + h.level + ' (' + h.size + '×' + h.size + ') — ' +
        h.moves + ' moves, cleared by ' + escapeHtml(h.clearedBy) + '</li>';
    }).join('');
    ul.scrollTop = ul.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── controls ── */

  async function post(body) {
    var res = await fetch('/api/bot/maze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(body),
    });
    var data = await res.json();
    if (!res.ok) { $('said').textContent = data.error || 'refused'; return null; }
    return data;
  }

  $('startBtn').onclick = async function () {
    $('said').textContent = '';
    if (await post({ action: 'start' })) {
      lastTransitionAt = null; lastRenderedLevel = null; lastMoveAt = null;
      poll();
    }
  };
  $('stopBtn').onclick = async function () { if (await post({ action: 'stop' })) poll(); };

  async function move(dir) {
    var data = await post({ action: 'move', dir: dir });
    if (data && data.said && data.said.length) $('said').textContent = data.said.join(' ');
    poll();
  }
  document.querySelectorAll('.pad .btn').forEach(function (b) {
    b.onclick = function () { if (staff) move(b.getAttribute('data-dir')); };
  });

  var KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
               w: 'up', a: 'left', s: 'down', d: 'right' };
  document.addEventListener('keydown', function (e) {
    var dir = KEYS[e.key] || KEYS[String(e.key).toLowerCase()];
    if (!dir || !staff) return;
    e.preventDefault();
    move(dir);
  });

  poll();
  setInterval(poll, POLL_MS);
})();
