/* ══════════════════════════════════════════════
   OVERLAY CLIENT

   Polls the event feed and shows one alert at a time.

   THE QUEUE IS THE POINT. Twenty gift subs arrive as twenty events within a
   second. Rendering them as they land would bury the stream; dropping all
   but the last would hide the generosity that earned the alert. They queue
   and play in order, so the screen stays readable and nothing is lost.

   A RELOAD REPLAYS NOTHING. OBS reloads a browser source whenever the scene
   changes, the stream restarts, or someone clicks refresh. The first poll
   sends no cursor and the server answers with its position only, so a reload
   mid-stream does not dump the last hour of alerts on air.

   IT FAILS QUIETLY. A stream must never carry a debug banner because one
   poll blipped, so the disconnect notice appears only after several
   consecutive failures and disappears the moment it recovers.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 1000;
  var SHOW_MS = 7000;          // how long one alert stays up
  var GAP_MS = 350;            // breathing room between alerts
  var FAULTS_BEFORE_NOTICE = 5;

  var stage = document.getElementById('ovStage');
  var faultEl = document.getElementById('ovFault');
  if (!stage) return;

  var key = new URLSearchParams(location.search).get('key') || '';
  var cursor = null;           // null = "tell me where we are, send nothing"
  var queue = [];
  var showing = false;
  var faults = 0;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /* ── What each event looks like on screen ──────────────────────────────
     The mark is the PhantomACE logo rather than an emoji. There is no
     per-event artwork in the repo, and inventing a different icon per event
     would mean shipping art that does not exist — so the logo is constant
     and the EVENT TYPE is carried by the kind label and the accent colour.

     assets/images/logo.png is used because it is one of only three assets
     with a genuine transparent cutout. phantomace-logo.png and its mythic
     variant have baked-in backgrounds (the mythic one is white), which would
     render as a solid square on a dark card. */
  var MARK = '/assets/images/logo.png';

  function describe(ev) {
    if (ev.type === 'drop') {
      var isItem = ev.kind === 'item';
      var where = isItem ? 'phantomace.tv/redeem' : 'phantomace.tv/giveaway';
      return {
        kind: isItem ? 'Item Drop' : 'Code Drop',
        title: isItem ? esc(ev.itemName || 'Item Drop') : 'Claim it fast',
        sub: (isItem ? 'Redeem at ' : (ev.entries ? '+' + ev.entries + ' entries • ' : '') + 'Claim at ') + where,
        code: ev.code,
        rarity: ev.rarity || 'common',
      };
    }
    if (ev.type === 'sub') {
      return { kind: 'New Subscriber', title: esc(ev.who) + ' subscribed!', sub: 'Welcome to the Phamily', rarity: 'rare' };
    }
    if (ev.type === 'giftsub') {
      var n = ev.count || 1;
      return {
        kind: 'Gift Subs',
        title: esc(ev.who) + ' gifted ' + n + ' sub' + (n === 1 ? '' : 's') + '!',
        sub: 'Absolute legend', rarity: 'mythic',
      };
    }
    if (ev.type === 'raid') {
      return { kind: 'Raid', title: esc(ev.who) + ' raided!', sub: (ev.viewers || 0) + ' raiders incoming', rarity: 'rare' };
    }
    if (ev.type === 'hype-level') {
      return { kind: 'Hype Train', title: 'Level ' + esc(ev.level) + '!', sub: 'Keep it rolling', rarity: 'mythic' };
    }
    return null;
  }

  function render(ev) {
    var d = describe(ev);
    if (!d) return false;

    var card = document.createElement('div');
    card.className = 'ov-alert';
    card.dataset.type = ev.type;
    card.dataset.rarity = d.rarity || 'common';

    /* Titles are built from Twitch display names, so the pieces that come
       from an event are escaped; the fixed wording around them is not. */
    card.innerHTML =
      '<img class="ov-mark" src="' + MARK + '" alt="">' +
      '<div class="ov-text">' +
        '<span class="ov-kind">' + esc(d.kind) + '</span>' +
        '<p class="ov-title">' + d.title + '</p>' +
        '<p class="ov-sub">' + esc(d.sub) + '</p>' +
        (d.code ? '<div class="ov-code">' + esc(d.code) + '</div>' : '') +
      '</div>';

    stage.appendChild(card);

    setTimeout(function () {
      card.classList.add('is-leaving');
      setTimeout(function () {
        if (card.parentNode) card.parentNode.removeChild(card);
        showing = false;
        setTimeout(pump, GAP_MS);
      }, 340);
    }, SHOW_MS);

    return true;
  }

  function pump() {
    if (showing || !queue.length) return;
    showing = true;
    if (!render(queue.shift())) {
      /* An event type this build does not know about — skip it rather than
         freeze the queue behind it. */
      showing = false;
      pump();
    }
  }

  function setFault(on) {
    if (!faultEl) return;
    faultEl.hidden = !on;
  }

  function poll() {
    var url = '/api/overlay/events?key=' + encodeURIComponent(key) +
              (cursor === null ? '' : '&since=' + cursor);

    fetch(url, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        faults = 0;
        setFault(false);
        /* First reply establishes the position without replaying. */
        if (cursor === null) { cursor = data.latestSeq || 0; return; }
        if (data.events && data.events.length) {
          for (var i = 0; i < data.events.length; i++) queue.push(data.events[i]);
          cursor = data.latestSeq;
          pump();
        }
      })
      .catch(function () {
        faults++;
        if (faults >= FAULTS_BEFORE_NOTICE) setFault(true);
      });
  }

  poll();
  setInterval(poll, POLL_MS);
})();
