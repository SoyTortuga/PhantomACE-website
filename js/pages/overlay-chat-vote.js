/* ══════════════════════════════════════════════
   CHAT VOTE — the overlay panel.

   The whole feedback loop for !vote, which is silent. Chat cannot pile in
   behind an option it cannot see winning, and the question itself only exists
   here — he says it out loud once, the panel says it for the next two minutes.

   MARATHON SAFETY: [hidden] guard in CSS, a hard idle backoff (dormant on
   every stream with no vote running), children replaced rather than appended,
   nothing rewritten while the numbers have not moved.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1200;
  var IDLE_POLL_MS = 15000;

  var panel = document.getElementById('ovVote');
  if (!panel) return;
  if (new URLSearchParams(location.search).get('layout')) return;

  var qEl = document.getElementById('ovVoteQuestion');
  var bodyEl = document.getElementById('ovVoteBody');
  var noteEl = document.getElementById('ovVoteNote');

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
      qEl.textContent = '';
      lastKey = '';
    }
  }

  function renderOpen(d) {
    var tally = d.tally || [];
    var total = Number(d.total) || 0;
    var key = 'open:' + d.question + ':' + total + ':' + tally.map(function (t) { return t.answer + t.votes; }).join(',');
    if (key === lastKey) return;
    lastKey = key;

    qEl.textContent = d.question || '';

    if (!tally.length) {
      bodyEl.innerHTML = '<div class="ov-vote-empty">No votes yet</div>';
      noteEl.innerHTML = 'Type <b>!vote</b>';
      return;
    }

    /* Bars are a share of the LEADER, not the total — the question on screen
       is "is my pick catching up", and against the total every bar is short. */
    var top = tally[0].votes || 1;
    bodyEl.innerHTML = '<ol class="ov-vote-tally">' + tally.map(function (t, i) {
      var pct = t.votes > 0 ? Math.max(4, Math.round((t.votes / top) * 100)) : 0;
      return '<li' + (i === 0 && t.votes > 0 ? ' class="is-lead"' : '') + '>' +
        (t.n ? '<span class="ov-vote-n">' + t.n + '</span>' : '') +
        '<span class="ov-vote-answer">' + esc(t.answer) + '</span>' +
        '<span class="ov-vote-votes">' + t.votes + '</span>' +
        '<i class="ov-vote-bar" style="width:' + pct + '%"></i>' +
        '</li>';
    }).join('') + '</ol>';

    /* Fixed votes tell you to type a number, because that is faster and
       cannot be misspelled. Open votes have nothing to number. */
    noteEl.innerHTML = total + (total === 1 ? ' vote' : ' votes') + ' — <b>!vote ' +
      (d.mode === 'fixed' ? '&lt;number&gt;' : '&lt;answer&gt;') + '</b>';
  }

  function renderLocked(d) {
    var w = d.winner || {};
    var key = 'locked:' + (w.answer || '');
    if (key === lastKey) return;
    lastKey = key;

    qEl.textContent = d.question || '';
    bodyEl.innerHTML =
      '<div class="ov-vote-winner">' + esc(w.answer || '') + '</div>' +
      '<div class="ov-vote-winner-sub">' + (Number(w.votes) || 0) + ' of ' + (Number(w.total) || 0) + ' votes' +
        (w.by ? ' · ' + esc(w.by) : '') + '</div>';
    noteEl.innerHTML = w.by && !w.paid
      ? 'Log in at phantomace.tv to collect entries'
      : 'Chat decided';
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  function poll() {
    fetch('/api/chat-vote', { cache: 'no-store' })
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
