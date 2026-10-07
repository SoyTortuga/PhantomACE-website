/* ══════════════════════════════════════════════
   SIEGE OPERATOR DRAFT — the overlay panel.

   The entire feedback loop, because !op is silent: if the tally is not on
   screen, chat cannot see its vote land and cannot coordinate a swing, which
   is the whole game.

   MARATHON SAFETY. A Siege night opens and closes this dozens of times:
   - Hidden means display:none, guarded in CSS, not just the hidden attribute.
   - The poller backs off hard when nothing is running — which is every stream
     that is not Siege.
   - The tally is rebuilt by replacing children, never appended to, and is
     only rewritten when the numbers actually move.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1200;          // a prep phase is ~45s; the tally must feel live
  var IDLE_POLL_MS = 15000;

  var panel = document.getElementById('ovR6Draft');
  if (!panel) return;
  if (new URLSearchParams(location.search).get('layout')) return;

  var sideEl = document.getElementById('ovR6DraftSide');
  var bodyEl = document.getElementById('ovR6DraftBody');
  var noteEl = document.getElementById('ovR6DraftNote');

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
      sideEl.textContent = '';
      panel.removeAttribute('data-side');
      lastKey = '';
    }
  }

  function renderOpen(d) {
    var tally = d.tally || [];
    var total = Number(d.total) || 0;
    var key = 'open:' + d.side + ':' + total + ':' + tally.map(function (t) { return t.operator + t.votes; }).join(',');
    if (key === lastKey) return;
    lastKey = key;

    sideEl.textContent = d.side === 'attack' ? 'Attack' : 'Defence';
    panel.setAttribute('data-side', d.side);

    if (!tally.length) {
      bodyEl.innerHTML = '<div class="ov-r6-empty">No picks yet</div>';
      noteEl.innerHTML = 'Type <b>!op &lt;operator&gt;</b>';
      return;
    }

    /* Bars are a share of the LEADER, not of the total — the question on
       screen is "is my pick catching up", and against the total every bar is
       short and nothing reads at a glance. */
    var top = tally[0].votes || 1;
    bodyEl.innerHTML = '<ol class="ov-r6-tally">' + tally.map(function (t, i) {
      var pct = Math.max(4, Math.round((t.votes / top) * 100));
      return '<li' + (i === 0 ? ' class="is-lead"' : '') + '>' +
        '<span class="ov-r6-op">' + esc(t.operator) + '</span>' +
        '<span class="ov-r6-votes">' + t.votes + '</span>' +
        '<i class="ov-r6-bar" style="width:' + pct + '%"></i>' +
        '</li>';
    }).join('') + '</ol>';
    noteEl.innerHTML = total + (total === 1 ? ' vote' : ' votes') + ' — <b>!op &lt;operator&gt;</b>';
  }

  function renderLocked(d) {
    var w = d.winner || {};
    var key = 'locked:' + (w.operator || '');
    if (key === lastKey) return;
    lastKey = key;

    sideEl.textContent = d.side === 'attack' ? 'Attack' : 'Defence';
    panel.setAttribute('data-side', d.side);
    bodyEl.innerHTML =
      '<div class="ov-r6-winner">' + esc(w.operator || '') + '</div>' +
      '<div class="ov-r6-winner-sub">' + (Number(w.votes) || 0) + ' of ' + (Number(w.total) || 0) + ' votes</div>';
    noteEl.innerHTML = 'Chat picked it — he plays it';
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  function poll() {
    fetch('/api/r6-draft', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || d.status === 'none') { hide(); schedule(IDLE_POLL_MS); return; }
        panel.hidden = false;
        if (d.status === 'locked') renderLocked(d);
        else renderOpen(d);
        schedule(POLL_MS);
      })
      .catch(function () {
        /* Silent — a stream never carries a debug banner because one poll
           blipped; the panel keeps showing what it last had. */
        schedule(IDLE_POLL_MS);
      });
  }

  poll();
})();
