/* ══════════════════════════════════════════════
   CULT OF THE LAMB — THE NAMING ROUND, on the overlay.

   The whole feedback loop for !name, which is silent. Chat cannot pile in
   behind a name it cannot see winning.

   MARATHON SAFETY: [hidden] guard in CSS, a hard idle backoff (this is dormant
   on every stream that is not Cult of the Lamb), children replaced rather than
   appended, and nothing rewritten while the numbers have not moved.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1500;
  var IDLE_POLL_MS = 15000;

  var panel = document.getElementById('ovCotl');
  if (!panel) return;
  if (new URLSearchParams(location.search).get('layout')) return;

  var bodyEl = document.getElementById('ovCotlBody');
  var noteEl = document.getElementById('ovCotlNote');

  var timer = null;
  var lastKey = '';

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function hide() {
    if (!panel.hidden) {
      panel.hidden = true;
      bodyEl.textContent = '';
      lastKey = '';
    }
  }

  function renderOpen(d) {
    var tally = d.tally || [];
    var total = Number(d.total) || 0;
    var key = 'open:' + total + ':' + tally.map(function (t) { return t.name + t.votes; }).join(',');
    if (key === lastKey) return;
    lastKey = key;

    if (!tally.length) {
      bodyEl.innerHTML = '<div class="ov-cotl-empty">No names yet</div>';
      noteEl.innerHTML = 'Type <b>!name &lt;name&gt;</b>';
      return;
    }

    var top = tally[0].votes || 1;
    bodyEl.innerHTML = '<ol class="ov-cotl-tally">' + tally.map(function (t, i) {
      var pct = Math.max(4, Math.round((t.votes / top) * 100));
      return '<li' + (i === 0 ? ' class="is-lead"' : '') + '>' +
        '<span class="ov-cotl-name">' + esc(t.name) + '</span>' +
        '<span class="ov-cotl-votes">' + t.votes + '</span>' +
        '<i class="ov-cotl-bar" style="width:' + pct + '%"></i>' +
        '</li>';
    }).join('') + '</ol>';
    noteEl.innerHTML = total + (total === 1 ? ' name in' : ' names in') + ' — <b>!name &lt;name&gt;</b>';
  }

  function renderLocked(d) {
    var w = d.winner || {};
    var key = 'locked:' + (w.name || '');
    if (key === lastKey) return;
    lastKey = key;

    bodyEl.innerHTML =
      '<div class="ov-cotl-winner">' + esc(w.name || '') + '</div>' +
      '<div class="ov-cotl-winner-sub">named by ' + esc(w.namedBy || 'someone') + '</div>';
    /* The unpaid case is the only place a chat-only namer learns that signing
       in would have paid — the name itself is theirs either way. */
    noteEl.innerHTML = w.paid
      ? 'Joined the flock — entries added'
      : 'Joined the flock — log in at phantomace.tv to collect entries';
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  function poll() {
    fetch('/api/cotl-cult', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || d.status === 'none') { hide(); schedule(IDLE_POLL_MS); return; }
        panel.hidden = false;
        if (d.status === 'locked') renderLocked(d);
        else renderOpen(d);
        schedule(POLL_MS);
      })
      .catch(function () { schedule(IDLE_POLL_MS); });
  }

  poll();
})();
