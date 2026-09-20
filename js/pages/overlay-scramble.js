/* ══════════════════════════════════════════════
   CHAT SCRAMBLE — the overlay panel.

   Separate from overlay.js on purpose. That file is an alert QUEUE: one
   thing at a time, each shown and dismissed. This is persistent STATE that
   sits on screen for a whole round. Folding a standing panel into a queue
   that exists to make things take turns would fight the design of both.

   Hidden entirely when no game is running, so the overlay stays a
   transparent alert layer the rest of the time and can be left in every
   scene rather than only the BRB one.
   ══════════════════════════════════════════════ */

(function () {
  var POLL_MS = 1000;
  var IDLE_POLL_MS = 5000;     // nothing running: check rarely

  var panel = document.getElementById('ovScramble');
  if (!panel) return;
  /* Layout mode owns the screen: overlay-layout.js fills every panel with
     sample content so OBS can be arranged offline. The live pollers stand
     down so nothing fetches and nothing hides what layout placed. */
  if (new URLSearchParams(location.search).get('layout')) return;

  var wordEl = document.getElementById('ovScWord');
  var catEl = document.getElementById('ovScCategory');
  var clockEl = document.getElementById('ovScClock');
  var roundEl = document.getElementById('ovScRound');
  var answeredEl = document.getElementById('ovScAnswered');
  var scoresEl = document.getElementById('ovScScores');

  var state = null;
  var offset = 0;              // serverNow - Date.now()
  var timer = null;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /* Each letter its own box, so a scramble reads as loose tiles rather than
     a misspelt word. Word breaks get a gap, which is most of what makes a
     two-word answer solvable at all. */
  function renderWord(display) {
    wordEl.innerHTML = '';
    var words = String(display || '').split(' ');

    /* Tiles shrink for a long phrase. CSS cannot count letters, and
       "commander bingo" is fourteen tiles — at the full size it wraps onto
       a second line and stops reading as one answer, which is most of what
       makes a scramble solvable at a glance. */
    var letters = String(display || '').replace(/ /g, '').length;
    wordEl.className = 'ov-sc-word' +
      (letters > 11 ? ' is-tiny' : letters > 8 ? ' is-long' : '');
    for (var w = 0; w < words.length; w++) {
      var group = document.createElement('span');
      group.className = 'ov-sc-group';
      for (var i = 0; i < words[w].length; i++) {
        var tile = document.createElement('span');
        tile.className = 'ov-sc-tile';
        tile.textContent = words[w][i];
        group.appendChild(tile);
      }
      wordEl.appendChild(group);
    }
  }

  function renderScores(scores) {
    scoresEl.innerHTML = '';
    for (var i = 0; i < (scores || []).length; i++) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="ov-sc-name">' + esc(scores[i].name) + '</span>' +
                     '<span class="ov-sc-pts">' + scores[i].points + '</span>';
      scoresEl.appendChild(li);
    }
  }

  function render() {
    if (!state || state.status === 'idle') {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    panel.classList.toggle('is-reveal', state.status === 'reveal');
    roundEl.textContent = 'Round ' + state.round;
    catEl.textContent = state.category || '';

    if (state.status === 'reveal') {
      /* The answer, plainly, and who got it. A round that ends without
         showing the word is the one thing guaranteed to annoy everyone who
         was still thinking. */
      renderWord(String(state.word || '').toUpperCase());
      answeredEl.textContent = state.winner
        ? state.winner.name + ' got it'
        : 'Nobody got it';
    } else {
      renderWord(state.display);
      answeredEl.textContent = state.answered === 1
        ? '1 guessing' : state.answered + ' guessing';
    }

    renderScores(state.scores);
    tick();
  }

  function tick() {
    if (!state || state.status === 'idle') return;
    var left = Math.max(0, state.endsAtLocal - Date.now());
    /* Minutes and seconds past a minute. A three-minute round counting down
       from "180s" reads as a number rather than a clock, and nobody parses
       "104s" as "a minute and a half left" at a glance. */
    var secs = Math.ceil(left / 1000);
    var label = secs >= 60
      ? Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2)
      : secs + 's';
    clockEl.textContent = state.status === 'reveal' ? '' : label;
    clockEl.classList.toggle('is-low', state.status === 'running' && left < 10000);
  }

  function poll() {
    fetch('/api/chat-game', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        offset = (data.serverNow || Date.now()) - Date.now();
        /* Absolute local time, so the countdown runs smoothly between polls
           instead of stepping once a second when a reply lands. */
        data.endsAtLocal = Date.now() + offset + (data.msLeft || 0);
        state = data;
        render();
      })
      .catch(function () { /* a dropped poll is not worth showing on stream */ })
      .finally(function () {
        var next = (state && state.status !== 'idle') ? POLL_MS : IDLE_POLL_MS;
        clearTimeout(timer);
        timer = setTimeout(poll, next);
      });
  }

  setInterval(tick, 200);
  poll();
})();
