/* ══════════════════════════════════════════════
   OVERLAY CLIENT

   Polls the event feed and shows one alert at a time.

   THE QUEUE IS THE POINT. Twenty gift subs arrive as twenty events within a
   second. Rendering them as they land would bury the stream; dropping all
   but the last would hide the generosity that earned the alert. They queue
   and play in order, so the screen stays readable and nothing is lost.

   IT SURVIVES A RELOAD. OBS reloads a browser source whenever the scene
   changes, the stream restarts, or someone clicks refresh — and it shuts
   the source down entirely while its scene is hidden, unless told not to.
   The overlay remembers where it was and picks up from there, so a sub that
   lands during the BRB scene still gets its alert when the scene comes back.

   BUT IT DOES NOT REPLAY A BACKLOG. Resuming from a position that is hours
   old would dump yesterday's alerts on air the moment OBS opens. Anything
   older than the replay window is counted as seen and dropped, so the
   overlay catches up across a scene switch and never across a night off.

   Covered by server/scripts/test-overlay-resume.js — cold start, resume and
   stale-drop are three behaviours that any two-out-of-three change breaks.

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
  /* How far back a reload will replay. OBS shuts a browser source down when
     its scene is not visible unless told otherwise, and a page that skips
     straight to "now" on every load drops every alert that fired while it
     was down — a sub during the BRB scene simply never appears.

     Not unlimited, though: starting the overlay at the top of a stream
     should not dump an hour of yesterday's alerts on screen. Two minutes is
     long enough to cover a scene switch or a reload and short enough that
     nothing stale arrives. */
  var MAX_REPLAY_MS = 120000;
  var CURSOR_KEY = 'ov_cursor';

  /* Resumed from the last run rather than starting blind. Wrapped because
     storage throws in a private window and is simply absent in some embedded
     browsers — an overlay must not fail to start over a convenience. */
  var cursor = null;           // null = "tell me where we are, send nothing"
  try {
    var saved = parseInt(window.localStorage.getItem(CURSOR_KEY), 10);
    if (Number.isFinite(saved) && saved > 0) cursor = saved;
  } catch (e) { /* no storage; behaves as it did before */ }

  function rememberCursor(seq) {
    try { window.localStorage.setItem(CURSOR_KEY, String(seq)); } catch (e) {}
  }
  var queue = [];
  var showing = false;
  var faults = 0;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /* ── ARTWORK ───────────────────────────────────────────────────────────
     Channel emotes first. They are PhantomACE's own art, viewers already
     recognise them, several are animated so the alert moves for free, and
     they carry no licensing question the way a bought asset pack does.

     Emotes come from Twitch's CDN, which is hotlinkable by design — that is
     how every chat client renders them. The cost is a dependency: if Twitch
     is unreachable the image would break ON STREAM, so every one falls back
     to a LOCAL file. A local fallback is the point; falling back to another
     CDN URL would fail in exactly the same moment. */
  var EMOTE = function (id, fmt) {
    return 'https://static-cdn.jtvnw.net/emoticons/v2/' + id + '/' + (fmt || 'static') + '/dark/3.0';
  };

  var ART = {
    coinroll: EMOTE('emotesv2_26bf7acbf75644e69473adf3952110b7', 'animated'), // phamCoinroll
    hype:     EMOTE('152733'),                                                // phamHype
    pham:     EMOTE('121671'),                                                // phamPham
    love:     EMOTE('120322'),                                                // phamLove
    love2:    EMOTE('168361'),                                                // phamLove2
    love3:    EMOTE('168352'),                                                // phamLove3
    hi:       EMOTE('121673'),                                                // phamHi
    lit:      EMOTE('120782'),                                                // phamLit
  };

  /* The same mark the site header and footer use, so a fallback still looks
     like PhantomACE rather than a stray graphic. It carries a baked-in
     red/black background — that is deliberate in the artwork, and the header
     presents it as a square badge with a 4px radius, which .is-fallback
     mirrors. */
  var FALLBACK = '/assets/images/phantomace-logo.png';

  /* Egg drops show the actual egg, matched to its rarity. Local files:
     copied into the repo rather than referenced inside
     games/dino-park/assets/dino-assets/, which is gitignored and shipped to
     the server out of band — an overlay should not depend on a tree that is
     not version controlled. */
  var EGGS = {
    common:   '/assets/images/eggs/egg-common.png',
    uncommon: '/assets/images/eggs/egg-uncommon.png',
    rare:     '/assets/images/eggs/egg-rare.png',
    mythic:   '/assets/images/eggs/egg-mythic.png',
  };

  /* 1-4 -> phamLove, 5-10 -> phamLove2, 11+ -> phamLove3. The 2-4 band was
     not specified and is folded into the first, so no gift count can fall
     through to no artwork at all. */
  function giftArt(n) {
    if (n >= 11) return ART.love3;
    if (n >= 5) return ART.love2;
    return ART.love;
  }

  function isEgg(ev) {
    return ev.kind === 'item' && /egg/i.test(ev.itemName || '');
  }

  /* ── What each event looks like on screen ── */
  function describe(ev) {
    if (ev.type === 'drop') {
      var rarity = ev.rarity || 'common';
      if (isEgg(ev)) {
        return {
          art: EGGS[rarity] || EGGS.common, pixel: true,
          kind: 'Egg Drop', title: esc(ev.itemName || 'Dino Egg'),
          sub: 'Redeem at phantomace.tv/redeem', code: ev.code, rarity: rarity,
        };
      }
      if (ev.kind === 'item') {
        return {
          art: ART.lit,
          kind: 'Item Drop', title: esc(ev.itemName || 'Item Drop'),
          sub: 'Redeem at phantomace.tv/redeem', code: ev.code, rarity: rarity,
        };
      }
      return {
        art: ART.coinroll,
        kind: 'Code Drop', title: 'Claim it fast',
        sub: (ev.entries ? '+' + ev.entries + ' entries • ' : '') + 'Claim at phantomace.tv/giveaway',
        code: ev.code, rarity: rarity,
      };
    }
    if (ev.type === 'sub') {
      return { art: ART.pham, kind: 'New Subscriber', title: esc(ev.who) + ' subscribed!', sub: 'Welcome to the Phamily', rarity: 'rare' };
    }
    if (ev.type === 'giftsub') {
      var n = ev.count || 1;
      return {
        art: giftArt(n), kind: 'Gift Subs',
        title: esc(ev.who) + ' gifted ' + n + ' sub' + (n === 1 ? '' : 's') + '!',
        sub: 'Absolute legend', rarity: 'mythic',
      };
    }
    if (ev.type === 'raid') {
      return { art: ART.hi, kind: 'Raid', title: esc(ev.who) + ' raided!', sub: (ev.viewers || 0) + ' raiders incoming', rarity: 'rare' };
    }
    if (ev.type === 'hype-level') {
      return { art: ART.hype, kind: 'Hype Train', title: 'Level ' + esc(ev.level) + '!', sub: 'Keep it rolling', rarity: 'mythic' };
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

    var img = document.createElement('img');
    img.className = 'ov-mark' + (d.pixel ? ' is-pixel' : '');
    img.alt = '';
    img.src = d.art;
    /* One retry to the local mark, then give up. Without the guard a
       fallback that also failed would loop onerror forever. */
    img.addEventListener('error', function handler() {
      img.removeEventListener('error', handler);
      img.classList.remove('is-pixel');
      img.classList.add('is-fallback');
      img.src = FALLBACK;
    });

    var text = document.createElement('div');
    text.className = 'ov-text';
    /* Titles mix fixed wording with Twitch display names; the event-derived
       pieces are escaped inside describe(). */
    text.innerHTML =
      '<span class="ov-kind">' + esc(d.kind) + '</span>' +
      '<p class="ov-title">' + d.title + '</p>' +
      '<p class="ov-sub">' + esc(d.sub) + '</p>' +
      (d.code ? '<div class="ov-code">' + esc(d.code) + '</div>' : '');

    card.appendChild(img);
    card.appendChild(text);
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

        /* No stored position — a genuinely first run. Take the current
           place and show nothing, or every alert since the server started
           would arrive at once. */
        if (cursor === null) {
          cursor = data.latestSeq || 0;
          rememberCursor(cursor);
          return;
        }

        if (data.events && data.events.length) {
          var now = Date.now();
          for (var i = 0; i < data.events.length; i++) {
            var ev = data.events[i];
            /* Anything older than the replay window is counted as seen and
               dropped. This is what stops a resumed cursor from replaying a
               backlog after the overlay has been closed for hours. */
            if (ev.at && now - ev.at > MAX_REPLAY_MS) continue;
            queue.push(ev);
          }
          cursor = data.latestSeq;
          rememberCursor(cursor);
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
