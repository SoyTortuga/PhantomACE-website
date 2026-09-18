/* ══════════════════════════════════════════════
   MANA CLASH — the overlay panel.

   Standing state, like the MTGBBB panel and unlike overlay.js, which is an
   alert queue. This sits on screen for a whole game.

   IT DOES NOT PICK ITS OWN ROOM. Unlike MTGBBB, where one game is live at a
   time and the server can point at it, several Mana Clash rooms can exist
   at once and only a human knows which one is worth watching. The control
   panel writes the pointer; this reads it. The OBS URL is still set once
   and never edited, which was the point of the MTGBBB design.

   ROUNDS ARE SIMULTANEOUS, so several players have dice on the table at the
   same moment. Each row carries its own dice rather than there being one
   "active player" — a single dice tray would have to choose somebody, and
   the choice would be wrong most of the time.

   IT YIELDS TO ALERTS. A code drop is the thing a viewer must not miss, and
   this panel is something they can look at whenever. overlay.js puts
   `ov-alerting` on the body while a card is up; the stylesheet does the
   rest. Nothing here has to know what an alert looks like.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1000;         // a turn resolves in well under a second
  var IDLE_POLL_MS = 8000;    // switched off, or no room: check rarely
  var MAX_ROWS = 8;

  var panel = document.getElementById('ovMc');
  if (!panel) return;

  var roundEl = document.getElementById('ovMcRound');
  var goalEl = document.getElementById('ovMcGoal');
  var barEl = document.getElementById('ovMcBar');
  var listEl = document.getElementById('ovMcList');
  var noteEl = document.getElementById('ovMcNote');

  var timer = null;
  var key = new URLSearchParams(location.search).get('key') || '';

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function hide() {
    panel.hidden = true;
  }

  /* One die. `kept` dice are the ones already set aside this turn and are
     drawn dimmer, so a viewer can see a hand being assembled rather than a
     row of numbers changing. */
  function die(v, kept) {
    return '<i class="ov-mc-die' + (kept ? ' is-kept' : '') + '">' + esc(v) + '</i>';
  }

  function diceFor(p) {
    var out = '';
    var k = Array.isArray(p.kept) ? p.kept : [];
    var d = Array.isArray(p.dice) ? p.dice : [];
    var i;
    for (i = 0; i < k.length; i++) out += die(k[i], true);
    for (i = 0; i < d.length; i++) out += die(d[i], false);
    return out;
  }

  /* What a row says about where the player is, in as few words as will fit.
     Deliberately not a sentence: this is read at a glance, next to a name. */
  function statusFor(p, room) {
    if (room.status === 'finished') return '';
    if ((room.resting || []).indexOf(p.id) !== -1) return 'resting';
    if (p.event === 'bust') return 'bust';
    if (p.done) return 'banked';
    if (p.awaitingSelection) return 'choosing';
    if (p.pending > 0) return 'holding ' + p.pending;
    return '';
  }

  function render(room) {
    var goal = Number(room.goal) || 0;

    if (room.status === 'lobby') {
      roundEl.textContent = 'Lobby';
      noteEl.textContent = room.playerCount === 1
        ? '1 player waiting'
        : room.playerCount + ' players waiting';
    } else if (room.status === 'finished') {
      roundEl.textContent = 'Final';
      var won = (room.players || []).filter(function (p) { return p.id === room.winner; })[0];
      noteEl.textContent = won ? won.name + ' wins' : '';
    } else {
      roundEl.textContent = 'Round ' + (room.round || 1);
      /* The final round is the whole tension of the game — the leader is
         sitting it out while everyone else tries to pass them. */
      noteEl.textContent = room.isFinalRound ? 'FINAL ROUND'
        : room.nextIsFinal ? 'final round next'
        : '';
    }

    goalEl.textContent = goal ? goal.toLocaleString() : '';

    var players = Array.isArray(room.players) ? room.players : [];
    var leader = players.length ? Math.max.apply(null, players.map(function (p) { return Number(p.total) || 0; })) : 0;
    barEl.style.width = (goal > 0 ? Math.max(0, Math.min(100, (leader / goal) * 100)) : 0) + '%';

    var rows = players.slice(0, MAX_ROWS);
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var p = rows[i];
      var status = statusFor(p, room);
      var dice = diceFor(p);
      html += '<li class="ov-mc-row' + (p.id === room.winner ? ' is-winner' : '') +
          (p.event === 'bust' ? ' is-bust' : '') + '">' +
        '<span class="ov-mc-name">' + esc(p.name) + '</span>' +
        '<span class="ov-mc-total">' + (Number(p.total) || 0).toLocaleString() + '</span>' +
        (status ? '<span class="ov-mc-status">' + esc(status) + '</span>' : '') +
        (dice ? '<span class="ov-mc-dice">' + dice + '</span>' : '') +
        '</li>';
    }
    listEl.innerHTML = html || '<li class="ov-mc-empty">Waiting for players</li>';
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  /* SWITCHED OFF AND BROKEN USED TO LOOK THE SAME. A 200 saying
     enabled:false is an ordinary answer and stays silent; a rejected key or
     a route that is not deployed yet is not, and used to hide the panel
     just as quietly -- leaving nothing on screen, nothing in the panel, and
     no way to tell which of the three it was. Named so the reason is
     legible, and only after a run of them, because one dropped request
     during a scene change is not a fault. */
  var FAULTS_BEFORE_NOTICE = 5;
  var faults = 0;

  function reportFault(status) {
    faults++;
    if (faults < FAULTS_BEFORE_NOTICE || typeof window.ovSetFault !== 'function') return;
    window.ovSetFault('manaClash', true,
      status === 403 ? 'mana clash: overlay key rejected'
      : status === 404 ? 'mana clash: route not deployed'
      : 'mana clash: unreachable');
  }

  function clearFault() {
    faults = 0;
    if (typeof window.ovSetFault === 'function') window.ovSetFault('manaClash', false);
  }

  function poll() {
    fetch('/api/overlay/mana-clash?key=' + encodeURIComponent(key), { cache: 'no-store' })
      .then(function (r) {
        if (r.ok) { clearFault(); return r.json(); }
        reportFault(r.status);
        return null;
      })
      .then(function (d) {
        if (!d || !d.enabled || !d.room) {
          hide();
          schedule(IDLE_POLL_MS);
          return;
        }
        render(d.room);
        panel.hidden = false;
        /* A finished game stays up so the result can be read, but there is
           nothing left to poll for quickly. */
        schedule(d.room.status === 'playing' ? POLL_MS : IDLE_POLL_MS);
      })
      .catch(function () {
        /* The panel keeps whatever it last had: a stream must never lose
           the scoreboard because one poll blipped. Counted, though -- a
           network that never comes back is a fault, and it took five in a
           row to say so. */
        reportFault(0);
        schedule(IDLE_POLL_MS);
      });
  }

  poll();
})();
