/* ══════════════════════════════════════════════
   COMMANDER BINGO — CHAT'S SHARED CARD, on the overlay.

   The card IS the feature: !stamp is silent, and a shared card nobody can see
   fill is not a game. This is the only place chat watches it happen.

   MARATHON SAFETY. A bingo night runs for hours with this up the whole time:
   - Hidden means display:none, guarded in CSS.
   - The grid is BUILT ONCE and then only has classes toggled on it. Rebuilding
     25 cells every poll for hours is exactly the unbounded churn that grows
     CEF's memory until OBS goes down.
   - The poller backs off hard when no card is out.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 2000;
  var IDLE_POLL_MS = 15000;

  var panel = document.getElementById('ovBingoChat');
  if (!panel) return;
  if (new URLSearchParams(location.search).get('layout')) return;

  var gridEl = document.getElementById('ovBingoChatGrid');
  var statEl = document.getElementById('ovBingoChatStat');
  var noteEl = document.getElementById('ovBingoChatNote');

  var timer = null;
  var built = false;
  var lastStat = '';

  function hide() {
    if (!panel.hidden) {
      panel.hidden = true;
      gridEl.textContent = '';
      built = false;
      lastStat = '';
    }
  }

  function build(squares) {
    /* One build per card. After this only classes change. */
    var frag = document.createDocumentFragment();
    for (var i = 0; i < squares.length; i++) {
      var cell = document.createElement('div');
      cell.className = 'ov-bgc-cell';
      var n = document.createElement('span');
      n.className = 'ov-bgc-n';
      n.textContent = squares[i].n;
      var t = document.createElement('span');
      t.className = 'ov-bgc-t';
      t.textContent = squares[i].free ? 'FREE' : squares[i].text;
      cell.appendChild(n);
      cell.appendChild(t);
      frag.appendChild(cell);
    }
    gridEl.textContent = '';
    gridEl.appendChild(frag);
    built = true;
  }

  function render(d) {
    var squares = d.squares || [];
    if (!built || gridEl.children.length !== squares.length) build(squares);

    for (var i = 0; i < squares.length; i++) {
      var cell = gridEl.children[i];
      if (!cell) continue;
      var s = squares[i];
      cell.classList.toggle('is-marked', !!s.marked);
      cell.classList.toggle('is-free', !!s.free);
      cell.classList.toggle('is-stamped', !!s.stamped);
      /* The square chat is currently backing, before it is placed — the whole
         tension of the vote is watching it move. */
      cell.classList.toggle('is-leading', d.leading != null && i === d.leading);
    }

    var stat = d.bingos > 0
      ? (d.bingos === 1 ? 'BINGO' : d.bingos + ' BINGOS')
      : d.marked + ' / 25';
    if (stat !== lastStat) { statEl.textContent = stat; lastStat = stat; }
    statEl.classList.toggle('is-bingo', d.bingos > 0);

    noteEl.innerHTML = d.stamp != null
      ? 'Wildcard placed on <b>' + (d.stamp + 1) + '</b>'
      : (d.votes
          ? d.votes + (d.votes === 1 ? ' vote' : ' votes') + ' — <b>!stamp &lt;1-25&gt;</b>'
          : 'Pick the wildcard — <b>!stamp &lt;1-25&gt;</b>');
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  function poll() {
    fetch('/api/bingo-chat', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || d.status !== 'live') { hide(); schedule(IDLE_POLL_MS); return; }
        panel.hidden = false;
        render(d);
        schedule(POLL_MS);
      })
      .catch(function () { schedule(IDLE_POLL_MS); });
  }

  poll();
})();
