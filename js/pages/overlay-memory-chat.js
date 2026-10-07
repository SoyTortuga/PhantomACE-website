/* ══════════════════════════════════════════════
   MEMORY MATCH, TWITCH PLAYS — the overlay board.

   The board IS the game: !flip is silent, and chat cannot remember cards it
   cannot see. Everything about this panel is in service of two things —
   reading a card number at a glance, and seeing a non-match before it turns
   back over.

   MARATHON SAFETY. A 20-pair game is forty-odd moves on screen for twenty
   minutes, polling twice a second:
   - Hidden means display:none, guarded in CSS.
   - The grid is BUILT ONCE per game and then only has classes and faces
     toggled. Rebuilding 40 cells every poll is the churn the overlay rules
     exist to stop.
   - The poller backs off hard when no game is running.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1000;          // a vote window is 8s; the countdown must move
  var IDLE_POLL_MS = 15000;

  var panel = document.getElementById('ovMemChat');
  if (!panel) return;
  if (new URLSearchParams(location.search).get('layout')) return;

  var gridEl = document.getElementById('ovMemChatGrid');
  var statEl = document.getElementById('ovMemChatStat');
  var noteEl = document.getElementById('ovMemChatNote');

  var timer = null;
  var builtFor = 0;

  function hide() {
    if (!panel.hidden) {
      panel.hidden = true;
      gridEl.textContent = '';
      builtFor = 0;
    }
  }

  function build(cards, cols) {
    gridEl.style.gridTemplateColumns = 'repeat(' + (cols || 5) + ', 1fr)';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < cards.length; i++) {
      var cell = document.createElement('div');
      cell.className = 'ov-mmc-card';
      var n = document.createElement('span');
      n.className = 'ov-mmc-n';
      n.textContent = cards[i].n;
      var f = document.createElement('span');
      f.className = 'ov-mmc-f';
      cell.appendChild(n);
      cell.appendChild(f);
      frag.appendChild(cell);
    }
    gridEl.textContent = '';
    gridEl.appendChild(frag);
    builtFor = cards.length;
  }

  function render(d) {
    var cards = d.cards || [];
    if (builtFor !== cards.length) build(cards, d.cols);

    for (var i = 0; i < cards.length; i++) {
      var cell = gridEl.children[i];
      if (!cell) continue;
      var c = cards[i];
      cell.classList.toggle('is-matched', !!c.matched);
      cell.classList.toggle('is-up', !!c.up);
      cell.classList.toggle('is-leading', d.leading != null && i === d.leading);
      /* A face arrives only for a card chat may see — face-down cards carry
         null from the server, so there is nothing here to read ahead. */
      var f = cell.children[1];
      var want = (c.face == null) ? '' : String(c.face + 1);
      if (f.textContent !== want) f.textContent = want;
    }

    /* The reveal beat is the mechanic, so it gets the loudest signal. */
    panel.classList.toggle('is-reveal', d.phase === 'reveal');
    panel.classList.toggle('is-miss', d.phase === 'reveal' && d.lastMatch === false);
    panel.classList.toggle('is-hit', d.phase === 'reveal' && d.lastMatch === true);

    statEl.textContent = d.pairsFound + '/' + d.pairs + ' · ' + d.moves +
      (d.moves === 1 ? ' move' : ' moves');

    if (d.status === 'done') {
      var r = d.result || {};
      noteEl.innerHTML = 'Cleared in <b>' + d.moves + '</b> moves' +
        (r.improved ? ' — a new best!' : (d.best ? ' — best ' + d.best : ''));
      return;
    }
    if (d.phase === 'reveal') {
      noteEl.innerHTML = d.lastMatch ? '<b>Match!</b>' : 'No match';
      return;
    }
    noteEl.innerHTML = d.voters
      ? d.secondsLeft + 's — ' + d.voters + (d.voters === 1 ? ' vote' : ' votes') + ' — <b>!flip &lt;n&gt;</b>'
      : d.secondsLeft + 's — <b>!flip &lt;n&gt;</b>';
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  function poll() {
    fetch('/api/memory-match-chat', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || d.status === 'none') { hide(); schedule(IDLE_POLL_MS); return; }
        panel.hidden = false;
        render(d);
        schedule(POLL_MS);
      })
      .catch(function () { schedule(IDLE_POLL_MS); });
  }

  poll();
})();
