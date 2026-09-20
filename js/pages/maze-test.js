/* ══════════════════════════════════════════════
   CHAT MAZE — the staff test page.

   Watches /api/bot/maze at chat speed and renders the board the way the
   overlay eventually will: a CSS grid whose borders ARE the walls, one
   hex digit per cell straight off the wire. The transition is the spec's
   sentence made literal — on a clear, the old board fades out, then the
   next one renders a cell larger in each direction.

   Controls are cosmetic-gated on the GET's `staff` flag; the server
   re-checks every POST for real. Test moves are named "(test)" and their
   clear announcements come back in the response instead of going to the
   channel, so testing before stream never narrates into a live chat.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1000;
  var CELL_MAX = 52, BOARD_MAX = 440;

  var lastTransitionAt = null;   /* fade only on a transition we WATCHED */
  var lastRenderedLevel = null;
  var fading = false;
  var staff = false;

  var $ = function (id) { return document.getElementById(id); };

  function render(data) {
    $('status').textContent = data.status === 'active'
      ? 'ACTIVE — maze ' + data.level + ' (' + data.size + '×' + data.size + ')'
      : 'no maze running';
    $('startBtn').disabled = !staff || data.status === 'active';
    $('stopBtn').disabled = !staff || data.status !== 'active';
    $('padPanel').style.display = (staff && data.status === 'active') ? '' : 'none';

    if (data.status !== 'active') {
      $('board').innerHTML = '';
      $('levelLine').textContent = '—';
      $('statLine').textContent = '';
      $('lastLine').textContent = '';
      renderHistory(data.history || []);
      lastRenderedLevel = null;
      return;
    }

    /* THE FADE. A transition stamped since our last look means the board
       we are showing was just cleared: fade it, and only rebuild once the
       fade has been seen. First sight of the page skips the theatre. */
    var t = data.transition;
    if (t && lastTransitionAt !== null && t.at !== lastTransitionAt && !fading) {
      lastTransitionAt = t.at;
      fading = true;
      $('board').classList.add('fading');
      setTimeout(function () {
        fading = false;
        $('board').classList.remove('fading');
        lastRenderedLevel = null;      /* force the bigger board to build */
      }, 1000);
      return;                          /* keep the old board while it fades */
    }
    if (t && lastTransitionAt === null) lastTransitionAt = t.at;
    if (fading) return;

    buildBoard(data);
    $('levelLine').textContent = 'Maze ' + data.level + ' · ' + data.size + '×' + data.size;
    $('statLine').textContent = data.moves + ' moves this maze · ' + data.bonks + ' bonks · '
      + data.totalMoves + ' total' + (data.topMover ? ' · top: ' + data.topMover.name + ' (' + data.topMover.moves + ')' : '');
    $('lastLine').textContent = data.lastMove
      ? 'last: ' + data.lastMove.dir + ' by ' + data.lastMove.by + (data.lastMove.blocked ? ' — BONK' : '')
      : '';
    renderHistory(data.history || []);
  }

  function buildBoard(data) {
    var board = $('board');
    var size = data.size;
    var cell = Math.min(CELL_MAX, Math.floor(BOARD_MAX / size));

    if (lastRenderedLevel !== data.level) {
      board.style.gridTemplateColumns = 'repeat(' + size + ', ' + cell + 'px)';
      board.style.gridAutoRows = cell + 'px';
      var html = '';
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var bits = parseInt(data.walls[y][x], 16);
          html += '<div class="cell' +
            ((bits & 1) ? ' n' : '') + ((bits & 2) ? ' e' : '') +
            ((bits & 4) ? ' s' : '') + ((bits & 8) ? ' w' : '') +
            '" id="mz_' + x + '_' + y + '"></div>';
        }
      }
      board.innerHTML = html;
      lastRenderedLevel = data.level;
    }

    /* The dot and the flag move; the walls never do within a level. */
    var old = board.querySelectorAll('.dot, .flag');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    var goalCell = $('mz_' + data.goal.x + '_' + data.goal.y);
    if (goalCell) goalCell.insertAdjacentHTML('beforeend', '<span class="flag">🏁</span>');
    var posCell = $('mz_' + data.pos.x + '_' + data.pos.y);
    if (posCell) {
      posCell.insertAdjacentHTML('beforeend', '<span class="dot"></span>');
      posCell.classList.toggle('bonked', !!(data.lastMove && data.lastMove.blocked));
    }
  }

  function renderHistory(history) {
    var ul = $('historyList');
    if (!history.length) { ul.innerHTML = '<li>none yet</li>'; return; }
    ul.innerHTML = history.slice().reverse().map(function (h) {
      return '<li>Maze ' + h.level + ' (' + h.size + '×' + h.size + ') — ' +
        h.moves + ' moves, cleared by ' + escapeHtml(h.clearedBy) + '</li>';
    }).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function poll() {
    try {
      var res = await fetch('/api/bot/maze', { cache: 'no-store' });
      var data = await res.json();
      staff = !!data.staff;
      render(data);
    } catch (e) { $('status').textContent = 'unreachable'; }
  }

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
    if (await post({ action: 'start' })) { lastTransitionAt = null; lastRenderedLevel = null; poll(); }
  };
  $('stopBtn').onclick = async function () {
    if (await post({ action: 'stop' })) poll();
  };

  async function move(dir) {
    var data = await post({ action: 'move', dir: dir });
    if (data && data.said && data.said.length) $('said').textContent = data.said.join(' ');
    poll();
  }
  document.querySelectorAll('.pad .btn').forEach(function (b) {
    b.onclick = function () { move(b.getAttribute('data-dir')); };
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
