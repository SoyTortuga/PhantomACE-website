/* ══════════════════════════════════════════════
   BRACKET NIGHT — the overlay panel.

   A standing panel that draws the single-elimination bracket from the public
   /api/mana-clash-tournament. The server owns the bracket; this only renders.

   MARATHON-SAFE, like every overlay panel: it hides to display:none when no
   bracket is active (the [hidden] attribute + a CSS guard), polls slowly while
   idle so nothing runs hot with nothing to show, and rebuilds by replacing
   innerHTML rather than appending — no unbounded growth over an all-night
   source. No box-shadow, no backdrop-filter. It yields to alerts via the body
   `ov-alerting` class the stylesheet handles.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 4000;          // a bracket changes on the scale of whole matches
  var IDLE_POLL_MS = 10000;    // nothing running: check rarely

  var panel = document.getElementById('ovBracket');
  if (!panel) return;
  if (new URLSearchParams(location.search).get('layout')) return;

  var roundEl = document.getElementById('ovBracketRound');
  var bodyEl = document.getElementById('ovBracketBody');
  var champEl = document.getElementById('ovBracketChamp');
  var timer = null;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function hide() { panel.hidden = true; }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }

  function roundName(idx, total) {
    var fromEnd = total - 1 - idx;
    if (fromEnd === 0) return 'Final';
    if (fromEnd === 1) return 'Semifinals';
    if (fromEnd === 2) return 'Quarterfinals';
    return 'Round ' + (idx + 1);
  }

  function matchHtml(m) {
    var aWin = m.winnerName && m.a && m.winnerName === m.a.name;
    var bWin = m.winnerName && m.b && m.winnerName === m.b.name;
    function side(p, win) {
      var name = p ? p.name : '—';
      return '<div class="ov-br-player' + (win ? ' is-win' : '') + '">' + esc(name) + '</div>';
    }
    return '<div class="ov-br-match' + (m.live ? ' is-live' : '') + (m.bye ? ' is-bye' : '') + '">' +
      side(m.a, aWin) + side(m.b, bWin) + '</div>';
  }

  function render(t) {
    if (!t || t.status === 'none' || t.status === 'idle') { hide(); return; }
    panel.hidden = false;

    if (t.status === 'signups') {
      roundEl.textContent = 'Sign-ups open';
      champEl.hidden = true;
      bodyEl.innerHTML = '<div class="ov-br-signups">' +
        (t.playerCount || 0) + ' player' + (t.playerCount === 1 ? '' : 's') + ' in' +
        '</div>';
      return;
    }

    var rounds = t.rounds || [];
    roundEl.textContent = t.status === 'done'
      ? 'Complete'
      : (roundName(t.round || 0, rounds.length) + '');

    var cols = '';
    for (var r = 0; r < rounds.length; r++) {
      var col = '<div class="ov-br-col' + (r === t.round && t.status !== 'done' ? ' is-current' : '') + '">' +
        '<div class="ov-br-col-title">' + esc(roundName(r, rounds.length)) + '</div>';
      for (var j = 0; j < rounds[r].length; j++) col += matchHtml(rounds[r][j]);
      col += '</div>';
      cols += col;
    }
    bodyEl.innerHTML = cols;

    if (t.status === 'done' && t.champion) {
      champEl.hidden = false;
      champEl.innerHTML = '🏆 Champion: <b>' + esc(t.champion.name) + '</b>';
    } else {
      champEl.hidden = true;
    }
  }

  function poll() {
    fetch('/api/mana-clash-tournament', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (t) {
        render(t);
        var live = t && (t.status === 'signups' || t.status === 'active' || t.status === 'done');
        schedule(live ? POLL_MS : IDLE_POLL_MS);
      })
      .catch(function () { schedule(IDLE_POLL_MS); });
  }

  poll();
})();
