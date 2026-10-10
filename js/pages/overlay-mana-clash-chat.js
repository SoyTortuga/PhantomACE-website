/* ══════════════════════════════════════════════
   STREAMER vs CHAT — the overlay panel.

   A standing panel, sibling to overlay-mana-clash.js (the room scoreboard)
   and independent of it: it polls its own endpoint, /api/mana-clash-chat, for
   the one live clash session. The server resolves everything; this only draws.

   MARATHON-SAFE, like every overlay panel: it hides to display:none when no
   clash is live (the [hidden] attribute + a CSS guard), polls slowly while
   idle so nothing runs on a hot loop with nothing to show, and rebuilds its
   dice rows by replacing innerHTML rather than appending — no unbounded
   growth across an all-night source. No box-shadow, no backdrop-filter.

   IT YIELDS TO ALERTS the same way the room panel does: overlay.js puts
   `ov-alerting` on the body while a card is up and the stylesheet moves this
   aside. Nothing here has to know what an alert looks like.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1000;         // a 45s event; a second is plenty while live
  var IDLE_POLL_MS = 8000;    // nothing on: check rarely

  var panel = document.getElementById('ovVsc');
  if (!panel) return;
  /* Layout mode owns the screen — stand down so nothing fetches or hides what
     the layout editor placed. */
  if (new URLSearchParams(location.search).get('layout')) return;

  var timerEl = document.getElementById('ovVscTimer');
  var noteEl = document.getElementById('ovVscNote');
  var vsEl = document.getElementById('ovVscVs');
  var streamerSide = document.getElementById('ovVscStreamer');
  var chatSide = document.getElementById('ovVscChat');
  var streamerDice = document.getElementById('ovVscStreamerDice');
  var chatDice = document.getElementById('ovVscChatDice');
  var streamerScore = document.getElementById('ovVscStreamerScore');
  var chatScore = document.getElementById('ovVscChatScore');
  var chatCount = document.getElementById('ovVscChatCount');

  var timer = null;
  var key = new URLSearchParams(location.search).get('key') || '';

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function hide() { panel.hidden = true; }

  /* One mana die. `kept` dice (the ones that actually score in the best keep)
     are drawn brighter, so a viewer can see which dice made the score. */
  function dieHtml(face, kept) {
    var f = String(face == null ? '' : face).toUpperCase();
    return '<i class="ov-vsc-die d-' + esc(f) + (kept ? ' is-kept' : '') + '">' + esc(f) + '</i>';
  }

  /* Draw a hand, marking the kept dice. `kept` is a list of face letters; a
     die is marked kept until its face has been accounted for once, so three
     kept R's light exactly three R dice. */
  function handHtml(dice, kept) {
    var d = Array.isArray(dice) ? dice : [];
    var pool = {};
    var k = Array.isArray(kept) ? kept : [];
    var i;
    for (i = 0; i < k.length; i++) {
      var kf = String(k[i]).toUpperCase();
      pool[kf] = (pool[kf] || 0) + 1;
    }
    var out = '';
    for (i = 0; i < d.length; i++) {
      var f = String(d[i]).toUpperCase();
      var isKept = pool[f] > 0;
      if (isKept) pool[f] -= 1;
      out += dieHtml(f, isKept);
    }
    return out;
  }

  function render(d) {
    var streamer = d.streamer || {};
    var chat = d.chat || {};

    streamerDice.innerHTML = handHtml(streamer.roll, streamer.kept);
    streamerScore.textContent = (Number(streamer.score) || 0).toLocaleString();

    var chatters = Number(chat.chatters) || 0;
    chatCount.textContent = chatters ? '(' + chatters + ')' : '';

    if (d.status === 'collecting') {
      /* The streamer's hand is locked; chat is still rolling in. */
      var secs = Math.ceil((Number(d.msLeft) || 0) / 1000);
      timerEl.textContent = secs + 's — !clash';
      chatDice.innerHTML = '';
      chatScore.textContent = chatters
        ? (chatters + (chatters === 1 ? ' roll' : ' rolls'))
        : 'type !clash';
      vsEl.textContent = 'VS';
      noteEl.textContent = 'Chat: type !clash to roll against the streamer';
      streamerSide.classList.remove('is-win', 'is-lose');
      chatSide.classList.remove('is-win', 'is-lose');
      return;
    }

    /* resolved */
    timerEl.textContent = '';
    chatDice.innerHTML = handHtml(chat.hand, chat.kept);
    chatScore.textContent = (Number(chat.score) || 0).toLocaleString();
    vsEl.textContent = 'VS';

    var winner = d.winner;
    streamerSide.classList.toggle('is-win', winner === 'streamer');
    streamerSide.classList.toggle('is-lose', winner === 'chat');
    chatSide.classList.toggle('is-win', winner === 'chat');
    chatSide.classList.toggle('is-lose', winner === 'streamer');

    noteEl.textContent = winner === 'streamer' ? 'Streamer wins!'
      : winner === 'chat' ? 'Chat wins!'
      : 'Draw!';
  }

  /* ── WHAT'S ON STREAM GATE ──────────────────────────────────────────────
     Fetches only while the one `whatsOn` pointer (js/pages/overlay.js) names
     this event; otherwise it hides and does no network at all. functions/api/mana-clash-chat.js
     already refreshes and clears that pointer for the clash, so the pointer's
     lifetime is exactly the event's -- the server half was wired and this half
     was not, so the panel asked every 8 seconds, for the whole of a
     marathon stream, to be told "nothing on" again.

     mine() is undefined until the bus has answered, and there is no bus at all
     without overlay.js. Both fall through to polling as before, so a panel
     opened standalone is unaffected. */
  var MY_GAME = 'mana-clash';
  var bus = (typeof window !== 'undefined' && window.PhamWhatsOn) ? window.PhamWhatsOn : null;
  function mine() {
    if (!bus) return undefined;
    var w = bus.get();
    if (w === undefined) return undefined;
    return !!(w && w.game === MY_GAME);
  }
  var lastVerdict;
  function onBus() {
    var v = mine();
    if (v === lastVerdict) return;
    lastVerdict = v;
    /* The pointer just changed: look now rather than waiting out the idle
       backoff, so the panel appears the moment the event starts. */
    schedule(0);
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  /* Switched off and broken must not look the same — same reasoning and the
     same shared indicator the room panel uses, keyed separately. */
  var FAULTS_BEFORE_NOTICE = 5;
  var faults = 0;

  function reportFault(status) {
    faults++;
    if (faults < FAULTS_BEFORE_NOTICE || typeof window.ovSetFault !== 'function') return;
    window.ovSetFault('manaClashChat', true,
      status === 403 ? 'clash: overlay key rejected'
      : status === 404 ? 'clash: route not deployed'
      : 'clash: unreachable');
  }

  function clearFault() {
    faults = 0;
    if (typeof window.ovSetFault === 'function') window.ovSetFault('manaClashChat', false);
  }

  function poll() {
    /* Not our event, and the bus has said so: stay hidden, no fetch. */
    if (mine() === false) { hide(); schedule(IDLE_POLL_MS); return; }
    fetch('/api/mana-clash-chat?key=' + encodeURIComponent(key), { cache: 'no-store' })
      .then(function (r) {
        if (r.ok) { clearFault(); return r.json(); }
        reportFault(r.status);
        return null;
      })
      .then(function (d) {
        if (!d || !d.status || d.status === 'none') {
          hide();
          schedule(IDLE_POLL_MS);
          return;
        }
        render(d);
        panel.hidden = false;
        schedule(d.status === 'collecting' ? POLL_MS : IDLE_POLL_MS);
      })
      .catch(function () {
        /* Keep whatever was last shown — one blip must not drop the panel —
           but count it; a network that never comes back is a fault. */
        reportFault(0);
        schedule(IDLE_POLL_MS);
      });
  }

  if (bus) bus.subscribe(onBus);
  poll();
})();
