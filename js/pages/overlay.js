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
  /* Layout mode owns the screen: overlay-layout.js fills every panel with
     sample content so OBS can be arranged offline. The live pollers stand
     down so nothing fetches and nothing hides what layout placed. */
  if (new URLSearchParams(location.search).get('layout')) return;

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

  /* The reload token this page loaded with. `undefined` until the first
     answer arrives; once set, any change means somebody pressed the button
     in the control panel. */
  var reloadToken;

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

  /* A booster box is opened at pace — thirty-odd rares in forty minutes,
     sometimes three in a row while the moderator catches up. At the normal
     seven seconds a burst would queue and the alerts would drift behind the
     card actually in the broadcaster's hand, which is worse than showing
     less. Pulls get four. */
  var PULL_MS = 4000;

  /* How long the winner's name stays up, landed, after the reel itself
     stops spinning — long enough to read on stream before the card leaves. */
  var REEL_HOLD_MS = 2600;

  /* ── Pham Check-In reminder ───────────────────────────────────────────
     Deliberately NOT a full alert: a small nudge in the corner telling
     viewers to go redeem their check-in, not a center-stage card that
     queues behind subs and raids. It has its own transient element and
     bypasses the alert queue entirely (see poll()). The reaper raises a
     "Pham-Check-In" sign, stepped through the 7-frame strip and held.
     Sound only when a MODERATOR fires it by hand (ev.sound) — the timer
     version is silent, so a periodic nudge never blasts audio on a loop. */
  var CHECKIN_AUDIO = '/assets/audio/phamCheckIn.mp3';   // strip image lives in overlay.css
  var CHECKIN_FRAMES = 7;
  var CHECKIN_FW = 283, CHECKIN_FH = 424;   // native cell size in the strip
  var CHECKIN_STEP_MS = 150;                // per raise frame
  var CHECKIN_DISP_H = 130;                 // display height; width scales (must match the CSS sprite size)
  var CHECKIN_MS = 8000;                    // how long the nudge stays up

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

    /* ── MTGBBB ──────────────────────────────────────────────────────
       The card that just came out of the pack, and how much of the room
       was holding it. That second number is the point: it turns a pull
       into something the whole chat reacts to at once, and it reads just
       as loudly at 3 of 62 as at 58 of 62. */
    if (ev.type === 'mtgbbb-pull') {
      var held = Number(ev.holders);
      var total = Number(ev.players);
      var line;
      if (!Number.isFinite(held) || !Number.isFinite(total) || total <= 0) {
        line = 'Pulled';                       // counts missing: say nothing false
      } else if (held === 0) {
        line = 'Nobody had this one';
      } else if (held === total) {
        line = 'Everyone had this — all ' + total + ' cards';
      } else {
        line = held + ' of ' + total + ' cards had this';
      }

      return {
        art: ev.image || FALLBACK, card: true, ms: PULL_MS,
        kind: (ev.rarity === 'mythic' ? 'Mythic' : 'Rare') + ' Pull',
        title: esc(ev.card || 'Unknown card'),
        sub: line,
        chips: Array.isArray(ev.treatments) ? ev.treatments : [],
        rarity: ev.rarity === 'mythic' ? 'mythic' : 'rare',
      };
    }

    if (ev.type === 'mtgbbb-bingo') {
      var blackout = /blackout/i.test(ev.pattern || '');
      return {
        art: blackout ? ART.love3 : ART.hype,
        kind: blackout ? 'BLACKOUT' : 'Bingo',
        title: esc(ev.who) + (blackout ? ' blacked out!' : ' got a bingo!'),
        sub: (blackout ? 'All twenty-five' : esc(ev.pattern || 'A line')) +
             (Number.isFinite(Number(ev.points)) ? ' — ' + ev.points + ' pts' : ''),
        rarity: blackout ? 'mythic' : 'rare',
      };
    }

    /* ── Commander Bingo ─────────────────────────────────────────────────
       The host calling a square — the moment a chat player marks their card.
       Given a slightly shorter life than a normal alert because a host who
       spots two things at once should not back the stage up for fourteen
       seconds. The label is the square's own text, escaped in call.js's
       source but re-escaped here since it is event-derived. */
    if (ev.type === 'bingo-call') {
      var called = Number(ev.called);
      var totalSq = Number(ev.total);
      var progress = (Number.isFinite(called) && Number.isFinite(totalSq) && totalSq > 0)
        ? called + ' of ' + totalSq + ' called'
        : 'Mark your card';
      return {
        art: ART.lit, ms: 5000,
        kind: 'Bingo Call',
        title: esc(ev.label || 'A square was called'),
        sub: progress,
        rarity: 'common',
      };
    }

    if (ev.type === 'bingo-win') {
      var r = String(ev.rarity || 'rare').toLowerCase();
      var big = r === 'mythic';
      return {
        art: big ? ART.love3 : ART.hype,
        kind: big ? 'BINGO!' : 'Bingo',
        title: esc(ev.who) + ' got a bingo!',
        sub: (big ? 'Mythic prize' : (r.charAt(0).toUpperCase() + r.slice(1)) + ' prize') +
             (Number.isFinite(Number(ev.entries)) ? ' — +' + ev.entries + ' entries' : ''),
        rarity: big ? 'mythic' : 'rare',
      };
    }

    /* ── Big Prize Giveaway ────────────────────────────────────────────
       The same spin the control panel just showed the moderator, replayed
       on stream so the draw is something viewers watch happen rather than
       a name that just appears. Held up for the whole spin plus a pause on
       the winner's name — everything else here is a fixed SHOW_MS/PULL_MS,
       this is the one alert whose life is dictated by an animation. */
    if (ev.type === 'giveaway-spin') {
      var rarity = ev.rarity === 'mythic' ? 'mythic' : 'rare';
      var spinMs = (window.PhamReel && window.PhamReel.SPIN_MS) || 6000;
      return {
        reel: true,
        entrants: Array.isArray(ev.entrants) ? ev.entrants : [],
        winnerIndex: ev.winnerIndex,
        who: ev.who || '',
        rarity: rarity,
        ms: spinMs + REEL_HOLD_MS,
      };
    }

    return null;
  }

  /* ── Pham Check-In reminder ────────────────────────────────────────────
     Drives the #ovCheckin panel — a MOVABLE panel positioned by the layout
     editor like the raid/Mana panels, not a fixed corner and not a stage
     alert (it bypasses the alert queue, so it never blocks a sub or raid).
     Shows the panel, steps the sign-raise strip once and holds the overhead
     pose for CHECKIN_MS, then fades out. Audio only when ev.sound is set
     (the manual button); the timer nudge is silent. The sprite's size and
     image live in overlay.css so layout mode can show it without this. */
  var CHECKIN_DISP_W = Math.round(CHECKIN_FW * (CHECKIN_DISP_H / CHECKIN_FH));
  var checkinTimers = [];
  function clearCheckinTimers() { checkinTimers.forEach(clearTimeout); checkinTimers.forEach(clearInterval); checkinTimers = []; }

  /* ONE audio element, reused. A fresh `new Audio()` per fire meant rapid
     presses (several events arriving in a single poll) each spawned their
     own sound and they layered — "it plays once for every press". Restarting
     one element plays at most one check-in sound at a time. */
  var checkinAudio = null;
  /* Overlay alert volume, 0..1, driven by the control panel through the poll
     response. Matches the server default (35) until the first poll lands, so a
     redemption in the first second isn't briefly loud. */
  var alertVolume = 0.35;
  /* Each open overlay has its OWN audio element, so a check-in with sound plays
     once PER overlay source, and OBS mixes them all into the stream — three
     overlay sources means viewers hear the chime three times even though the
     streamer, monitoring one, hears it once. Add ?muted=1 (or ?sound=off) to
     every overlay source except the ONE that should carry the chime. */
  var audioMuted = (function () {
    try {
      var p = new URLSearchParams(location.search);
      return p.get('muted') === '1' || p.get('sound') === 'off';
    } catch (e) { return false; }
  })();

  function showCheckinReminder(ev) {
    var panel = document.getElementById('ovCheckin');
    var sprite = document.getElementById('ovCheckinSprite');
    if (!panel || !sprite) return;
    clearCheckinTimers();

    sprite.style.backgroundPositionX = '0px';
    panel.hidden = false;
    void panel.offsetWidth;                 // let the fade restart on a re-fire
    panel.classList.add('is-in');

    var frame = 0;
    var step = setInterval(function () {
      frame++;
      sprite.style.backgroundPositionX = '-' + (frame * CHECKIN_DISP_W) + 'px';
      if (frame >= CHECKIN_FRAMES - 1) clearInterval(step);
    }, CHECKIN_STEP_MS);
    checkinTimers.push(step);

    if (ev && ev.sound && !audioMuted) {
      try {
        if (!checkinAudio) checkinAudio = new Audio(CHECKIN_AUDIO);
        checkinAudio.volume = alertVolume;
        checkinAudio.currentTime = 0;      // restart the one element rather than layering a new one
        checkinAudio.play().catch(function () { /* autoplay-with-sound blocked outside OBS — silent */ });
      } catch (e) { /* no audio element — the nudge still shows */ }
    }

    checkinTimers.push(setTimeout(function () {
      panel.classList.remove('is-in');       // fade out
      checkinTimers.push(setTimeout(function () { panel.hidden = true; }, 360));
    }, CHECKIN_MS));
  }

  function buildStandardCard(ev, d) {
    var card = document.createElement('div');
    card.className = 'ov-alert';
    card.dataset.type = ev.type;
    card.dataset.rarity = d.rarity || 'common';

    var img = document.createElement('img');
    img.className = 'ov-mark' + (d.pixel ? ' is-pixel' : '') + (d.card ? ' is-card' : '');
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
    /* Chips are event-derived, so each is escaped individually rather than
       trusted because the surrounding markup is ours. */
    var chips = '';
    if (d.chips && d.chips.length) {
      chips = '<div class="ov-chips">';
      for (var c = 0; c < d.chips.length; c++) {
        chips += '<span class="ov-chip">' + esc(d.chips[c]) + '</span>';
      }
      chips += '</div>';
    }

    text.innerHTML =
      '<span class="ov-kind">' + esc(d.kind) + '</span>' +
      '<p class="ov-title">' + d.title + '</p>' +
      '<p class="ov-sub">' + esc(d.sub) + '</p>' +
      chips +
      (d.code ? '<div class="ov-code">' + esc(d.code) + '</div>' : '');

    card.appendChild(img);
    card.appendChild(text);
    return card;
  }

  /* ── Big Prize Giveaway spin ──────────────────────────────────────────
     The same PhamReel arithmetic bot-control.js drives its panel with,
     replayed here so the winner it lands on is never a second computation
     that could disagree with the one the moderator watched — same names,
     same offset, same landing row, only the row height is untouched (it is
     shared with the CSS transform math) while the type size around it is
     bumped up for a stream instead of a control panel. */
  function buildReelCard(ev, d) {
    var card = document.createElement('div');
    card.className = 'ov-alert ov-reel-card';
    card.dataset.type = ev.type;
    card.dataset.rarity = d.rarity;

    var kind = document.createElement('span');
    kind.className = 'ov-kind';
    kind.textContent = (d.rarity === 'mythic' ? 'Mythic' : 'Rare') + ' Giveaway';
    card.appendChild(kind);

    var wrap = document.createElement('div');
    wrap.className = 'ov-reel-wrap';
    var win = document.createElement('div');
    win.className = 'ov-reel-window';
    var strip = document.createElement('div');
    strip.className = 'ov-reel-strip';
    win.appendChild(strip);
    wrap.appendChild(win);
    card.appendChild(wrap);

    var caption = document.createElement('p');
    caption.className = 'ov-sub ov-reel-caption';
    caption.textContent = 'Spinning for the winner…';
    card.appendChild(caption);

    if (window.PhamReel && d.entrants.length) {
      var plan = window.PhamReel.strip(d.entrants, d.winnerIndex);
      plan.names.forEach(function (name, i) {
        var row = document.createElement('div');
        row.className = 'ov-reel-row' + (i === plan.landing ? ' winner' : '');
        row.textContent = name;               // a Twitch username, not markup
        strip.appendChild(row);
      });

      var spinMs = window.PhamReel.SPIN_MS;
      /* Start pinned at the top row. Unlike the control panel — whose strip
         is a live element already in the document — THIS card is still
         DETACHED here: render() appends it only after buildReelCard returns.
         A forced reflow on a detached node does nothing, so the panel's
         single-rAF trick would let the browser coalesce the start state and
         the travel into one jump, and the reel lands on the winner with no
         spin at all (which is exactly what it did). So defer both steps to
         after the append with two rAFs: the first fires once the card is in
         the DOM and forces a REAL layout at translateY(0); the second sets
         the transition and the target, giving a painted start frame to
         animate away from. */
      strip.style.transform = 'translateY(0)';
      requestAnimationFrame(function () {
        void strip.offsetHeight;   // now attached — a real reflow at the top
        requestAnimationFrame(function () {
          strip.style.transition = 'transform ' + (spinMs / 1000) + 's cubic-bezier(0.12, 0.8, 0.18, 1)';
          strip.style.transform = 'translateY(' + plan.offset + 'px)';
        });
      });

      setTimeout(function () {
        /* textContent, not the innerHTML esc() elsewhere is for — a plain
           string assignment here needs no escaping of its own. */
        caption.textContent = d.who ? (d.who + ' wins!') : 'We have a winner!';
        card.classList.add('is-landed');
      }, spinMs + 100);
    } else {
      caption.textContent = 'No entrants to draw from.';
    }

    return card;
  }

  function render(ev) {
    var d = describe(ev);
    if (!d) return false;

    var card = d.reel ? buildReelCard(ev, d) : buildStandardCard(ev, d);
    stage.appendChild(card);

    /* PUBLISHED, NOT ENFORCED. The standing panels — Mana Clash, the
       scramble — are things a viewer can look at whenever; an alert is the
       thing they must not miss. Rather than teach this file where each
       panel sits, it says only that a card is up, and the stylesheet gets
       out of the way. One class, and a new panel costs nothing here. */
    document.body.classList.add('ov-alerting');

    setTimeout(function () {
      card.classList.add('is-leaving');
      setTimeout(function () {
        if (card.parentNode) card.parentNode.removeChild(card);
        showing = false;
        /* Cleared in the same place `showing` is, so the two can never
           disagree about whether anything is on screen. */
        document.body.classList.remove('ov-alerting');
        setTimeout(pump, GAP_MS);
      }, 340);
    }, d.ms || SHOW_MS);

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

/* ONE INDICATOR, SEVERAL REPORTERS. The alert stream is not the only thing
   that can be broken -- a standing panel polling with a rejected key fails
   silently and looks exactly like being switched off, which is how an
   overlay problem becomes forty minutes of "is it just me". Each panel
   names its own fault; the element shows while any of them is set, and its
   text says which, so the cause is readable off the stream rather than
   guessed at. Published on window because these files are separate IIFEs
   loaded in one page. */
  var faultsBySource = {};
  window.ovSetFault = function (source, on, label) {
    if (on) faultsBySource[source] = label || source;
    else delete faultsBySource[source];
    if (!faultEl) return;
    var active = Object.keys(faultsBySource);
    faultEl.hidden = active.length === 0;
    if (active.length) {
      faultEl.textContent = active.map(function (k) { return faultsBySource[k]; }).join(' · ');
    }
  };

  function setFault(on) {
    window.ovSetFault('alerts', on, 'overlay disconnected');
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

        /* Alert volume, set from the control panel. Sent on every poll so a
           change reaches the open overlay within a second, no reload. */
        if (typeof data.alertVolume === 'number') {
          alertVolume = Math.max(0, Math.min(1, data.alertVolume / 100));
        }

        /* RELOAD ON COMMAND. An OBS browser source holds this page open for
           days, so without it a change to the overlay never reaches the
           stream until somebody walks to the streaming PC.

           The URL gains a cache-busting parameter rather than calling
           location.reload(), which browsers may answer from cache — and the
           whole point of pressing the button is usually that the cached
           copy is the stale one. The key is preserved; nothing else in the
           URL matters. */
        var token = data.reloadToken || '';
        if (reloadToken === undefined) {
          reloadToken = token;
        } else if (token !== reloadToken) {
          var u = new URL(location.href);
          u.searchParams.set('r', token || String(Date.now()));
          location.replace(u.toString());
          return;
        }

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
            /* The check-in nudge is not a stage alert — show it in the corner
               directly, off the queue, so it never delays or is delayed by a
               sub/raid card. */
            if (ev.type === 'pham-checkin') { showCheckinReminder(ev); continue; }
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
