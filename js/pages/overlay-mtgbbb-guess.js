/* ══════════════════════════════════════════════
   MTGBBB GUESS THE RARE — the overlay panel.

   Chat's whole feedback loop for the guess round, because the command itself
   is silent: nothing about !guess appears in chat, so if it is not on screen
   it did not happen. Shows the window closing, how many are in, then who
   called it.

   MARATHON SAFETY. A box crack runs for an hour and this panel opens and
   closes thirty times inside it:
   - Hidden means display:none, guarded in CSS, not just the hidden attribute.
   - The poller backs off hard when no round is live — this is idle for most of
     every stream, including every stream that is not a box crack.
   - The countdown is re-rendered from a server-sent seconds value, never from
     a local clock, and its interval is cleared the moment the panel hides.
   - The winners list is rebuilt by replacing children, never appended to.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1500;          // a window is 2 minutes; this is its countdown
  var IDLE_POLL_MS = 15000;    // nothing running: check rarely

  var panel = document.getElementById('ovMtgGuess');
  if (!panel) return;
  /* Layout mode owns the screen: overlay-samples fills every panel so OBS can
     be arranged offline, and the live pollers stand down. */
  if (new URLSearchParams(location.search).get('layout')) return;

  var timerEl = document.getElementById('ovMtgGuessTimer');
  var bodyEl = document.getElementById('ovMtgGuessBody');
  var noteEl = document.getElementById('ovMtgGuessNote');

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
      timerEl.textContent = '';
      lastKey = '';
    }
  }

  function renderOpen(d) {
    var n = Number(d.count) || 0;
    timerEl.textContent = (Number(d.secondsLeft) || 0) + 's';
    /* Keyed so an unchanged body is not rewritten every poll — the count and
       the pack are the only things that move. */
    var key = 'open:' + d.pack + ':' + n;
    if (key !== lastKey) {
      lastKey = key;
      bodyEl.innerHTML =
        '<div class="ov-mtgguess-pack">Pack ' + (Number(d.pack) || 0) + '</div>' +
        '<div class="ov-mtgguess-count">' + n + (n === 1 ? ' call in' : ' calls in') + '</div>';
    }
    noteEl.innerHTML = 'Type <b>!guess &lt;card&gt;</b> — first call counts';
  }

  function renderResolved(d) {
    var r = d.result || {};
    var winners = r.winners || [];
    var key = 'done:' + d.pack + ':' + (r.card || '') + ':' + winners.length;
    timerEl.textContent = '';
    if (key === lastKey) return;
    lastKey = key;

    var html = '<div class="ov-mtgguess-card">' + esc(r.card || '') + '</div>';
    if (!winners.length) {
      html += '<div class="ov-mtgguess-miss">' +
        (r.guessed ? 'Nobody called it — ' + r.guessed + ' tried' : 'Nobody called it') +
        '</div>';
      bodyEl.innerHTML = html;
      noteEl.innerHTML = 'Next pack, next chance';
      return;
    }

    html += '<ol class="ov-mtgguess-winners">' + winners.map(function (w) {
      /* The unpaid marker is not a scold — it is the only place a chat-only
         winner learns that signing in would have paid. */
      return '<li' + (w.paid ? '' : ' class="is-unpaid"') + '>' + esc(w.name) +
        (w.paid ? '<span class="ov-mtgguess-paid">+' + (Number(d.entries) || 0) + '</span>' : '') +
        '</li>';
    }).join('') + '</ol>';

    var more = (Number(r.total) || winners.length) - winners.length;
    if (more > 0) html += '<div class="ov-mtgguess-more">+' + more + ' more called it</div>';

    bodyEl.innerHTML = html;
    noteEl.innerHTML = (Number(r.paid) || 0) < (Number(r.total) || 0)
      ? 'Log in at phantomace.tv to collect entries'
      : 'Called it — entries added';
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  function poll() {
    fetch('/api/mtgbbb-chat', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || d.status === 'none') { hide(); schedule(IDLE_POLL_MS); return; }
        panel.hidden = false;
        if (d.status === 'resolved') renderResolved(d);
        else renderOpen(d);
        schedule(POLL_MS);
      })
      .catch(function () {
        /* Silent. A stream must never carry a debug banner because one poll
           blipped; the panel keeps showing what it last had. */
        schedule(IDLE_POLL_MS);
      });
  }

  poll();
})();
