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

  /* ── WHAT'S ON STREAM — the one pointer the game panels read ────────────
     The server returns `whatsOn` on every poll (the single pointer that
     replaced the four per-game panel polls). This publishes it to the four
     standing-game panels (bingo/mtgbbb/maze/scramble) so each shows only when
     it is the live game and does not poll its own state endpoint while hidden.

     A tiny get/subscribe bus on window. `get()` returns `undefined` until the
     first poll answers — a panel treats that as "bus not ready yet" and falls
     back to its own poll, so it still works if this file ever fails to load.
     After the first answer `get()` returns the value (null = nothing on). */
  window.PhamWhatsOn = (function () {
    var last, has = false, subs = [];
    return {
      get: function () { return has ? last : undefined; },
      subscribe: function (fn) {
        if (typeof fn !== 'function') return;
        subs.push(fn);
        if (has) { try { fn(last); } catch (e) {} }
      },
      _set: function (v) {
        last = v; has = true;
        for (var i = 0; i < subs.length; i++) { try { subs[i](v); } catch (e) {} }
      },
    };
  })();
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

  /* ── QUEUE POLICY ──────────────────────────────────────────────────────
     A follow-bot wave is two hundred follows in a minute; played one card at
     a time that is ~25 minutes of "X followed!" standing in front of every
     sub and raid. So:
       • MERGE: a follow arriving while another follow is still QUEUED folds
         into it, so the whole wave becomes one "+N new followers" card. The
         merged card shows only the count — a hate-raid's usernames are
         exactly the thing that must not reach the stream.
       • PRIORITY: the queue is kept sorted by tier (stable within a tier), so
         a sub/raid/gift/drop/giveaway jumps ahead of queued follows instead
         of waiting behind them.
       • CAP: at most MAX_QUEUE waiting cards. Over the cap, the newest
         lowest-tier card is dropped first; a giveaway/wheel reveal is never
         dropped (a moderator pressed a button and is watching for it). */
  var MAX_QUEUE = 25;
  var ALERT_TIER = {
    'giveaway-spin': 3, 'wheel-spin': 3, raid: 3, giftsub: 3, sub: 3, resub: 3, 'hype-level': 3, drop: 3,
    cheer: 2, 'bingo-call': 2, 'bingo-win': 2, 'bingo-claim': 2, 'mtgbbb-pull': 2, 'mtgbbb-bingo': 2,
    follow: 1,
  };
  var NEVER_DROP = { 'giveaway-spin': true, 'wheel-spin': true };
  var MERGEABLE = { follow: true };

  function tierOf(ev) { return ALERT_TIER[ev.type] || 2; }

  function mergeAlert(into, ev) {
    var merged = {};
    for (var k in into) merged[k] = into[k];
    merged.count = (Number(into.count) || 1) + (Number(ev.count) || 1);
    merged.seq = ev.seq;
    return merged;
  }

  function enqueue(ev) {
    if (MERGEABLE[ev.type]) {
      for (var m = queue.length - 1; m >= 0; m--) {
        if (queue[m].type === ev.type) { queue[m] = mergeAlert(queue[m], ev); return; }
      }
    }
    var tier = tierOf(ev);
    var at = queue.length;
    while (at > 0 && tierOf(queue[at - 1]) < tier) at--;
    queue.splice(at, 0, ev);
    while (queue.length > MAX_QUEUE) {
      var drop = -1;
      for (var d = queue.length - 1; d >= 0; d--) {
        if (!NEVER_DROP[queue[d].type]) { drop = d; break; }
      }
      if (drop === -1) break;
      queue.splice(drop, 1);
    }
  }

  /* ── SERVER CLOCK ──────────────────────────────────────────────────────
     Event times (ev.at) and Twitch's lock times are SERVER clock values, but
     this page runs on the streaming PC, whose clock can be minutes out. A PC
     two minutes fast used to read every alert as older than the replay window
     and silently drop all of them. Each poll's serverNow gives a sample of
     (server - local), taken at the midpoint of the round trip; the estimate
     is smoothed so one slow reply cannot jerk it, and re-seated outright when
     a sample disagrees by more than any round trip could explain (the PC's
     clock was stepped). Until the first sample it is 0 — the old behaviour. */
  var serverOffset = 0;
  var serverOffsetKnown = false;
  var OFFSET_MAX_RTT_MS = 5000;
  var OFFSET_RESEAT_MS = 5000;
  var OFFSET_SMOOTHING = 0.2;

  function noteServerClock(serverNow, sentAt, recvAt) {
    if (typeof serverNow !== 'number' || !isFinite(serverNow)) return;
    var rtt = recvAt - sentAt;
    if (!(rtt >= 0) || rtt > OFFSET_MAX_RTT_MS) return;
    var sample = serverNow - (sentAt + rtt / 2);
    if (!serverOffsetKnown || Math.abs(sample - serverOffset) > OFFSET_RESEAT_MS) {
      serverOffset = sample;
      serverOffsetKnown = true;
      return;
    }
    serverOffset += (sample - serverOffset) * OFFSET_SMOOTHING;
  }

  function serverTime() { return Date.now() + serverOffset; }

  /* The reload token this page loaded with. `undefined` until the first
     answer arrives; once set, any change means somebody pressed the button
     in the control panel. */
  var reloadToken;

  /* The latest panic command token this page has acted on. `undefined` until
     the first answer arrives; once set, any change means a moderator pressed
     Clear or Skip in the dashboard. */
  var controlToken;

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

  /* ── Dino hatch minigame ───────────────────────────────────────────────
     A gift sub, a 300-bit Power-up or 30,000 channel points rolls the hatch
     on the server; this plays it. The egg-crack strip runs once, THEN the
     rolled dino(s) are revealed together — one animation, batch reveal — with
     the triggerer's name. The strip is the same sheet Dino Park hatches with
     (52 frames, native 40x49, drawn at 4x), tracked in the repo rather than
     pulled from the gitignored dino-assets tree. The dino sprites themselves
     DO come from dino-assets (server-supplied icon URLs) with an onerror
     fallback to the PhantomACE mark, so a missing sprite never breaks on air. */
  var HATCH_STRIP = '/assets/images/eggs/egg-hatch.png';
  var HATCH_FRAMES = 52;
  var HATCH_FW = 160;             // displayed frame width (native 40px, drawn 4x)
  var HATCH_STEP_MS = 33;        // ~1.7s for the whole crack
  var HATCH_ANIM_MS = HATCH_FRAMES * HATCH_STEP_MS;
  var HATCH_HOLD_MS = 6500;      // single-hatch reveal hold after the crack
  var HATCH_TILE_CAP = 50;       // reel scrolls up to this many, then "+N more"
  var PARADE_TAIL_MS = 900;      // rest on the reel's last frame before leaving
  /* Preload the strip so the first hatch of a stream does not clip its opening
     frames while the image is still fetching. */
  try { new Image().src = HATCH_STRIP; } catch (e) {}

  function capRarity(r) {
    r = String(r || 'common');
    return r.charAt(0).toUpperCase() + r.slice(1);
  }

  /* Bigger clutch scrolls faster, capped so even a 50-bomb wraps up promptly
     (~0.6s/dino at 10, ~0.2s at 50). Mirrors the server/artifact pacing. */
  function paradeDurMs(count) {
    return Math.round(Math.max(5500, Math.min(11000, count * 150 + 4500)));
  }

  /* Mutations — the eight Dino Park globals. The server sends only the id; this
     maps it to a label, the CSS recolour filter the game recolours art with, and
     a tag accent. HATCH_HUEFIX pre-rotates the far-off (mostly marine) species so
     a fixed hue-rotate lands on the right colour — the same correction Dino
     Park's getMutFilter applies. */
  var MUT = {
    albino:    { l: 'Albino',     f: 'brightness(2) saturate(0)',                                              c: '#FF6B6B' },
    melanistic:{ l: 'Melanistic', f: 'brightness(0.28) saturate(0.4)',                                         c: '#9aa0a6' },
    golden:    { l: 'Golden',     f: 'sepia(1) brightness(1.3) saturate(2.5)',                                 c: '#FFCE45' },
    crystal:   { l: 'Crystal',    f: 'brightness(1.4) saturate(0.3) hue-rotate(180deg)',                       c: '#7EA8FF' },
    volcanic:  { l: 'Volcanic',   f: 'brightness(0.7) sepia(0.6) hue-rotate(-15deg) saturate(3)',              c: '#FF6600' },
    phantomace:{ l: 'PhantomACE', f: 'sepia(1) saturate(8) hue-rotate(-40deg) brightness(0.55) contrast(1.9)', c: '#FF0000' },
    spectral:  { l: 'Spectral',   f: 'brightness(1.4) saturate(0.15) opacity(0.7)',                            c: '#D9CCFF' },
    toxic:     { l: 'Toxic',      f: 'hue-rotate(90deg) saturate(2.2) brightness(0.95)',                       c: '#ADFF2F' },
  };
  var HATCH_HUEFIX = {apato:286,archae:205,argent:147,bronto:153,dodo:177,dunky:172,elasmo:189,ichthy:190,liopl:183,mamen:240,megalo:102,megarach:78,megashark:168,micro:312,mosa:205,plesio:189,shoni:210,sinosaur:51,therizo:105,tylo:172};
  function mutFilter(speciesId, mut) {
    if (!mut || !MUT[mut]) return '';
    var fltr = MUT[mut].f, fix = HATCH_HUEFIX[speciesId];
    return (fix && fltr.indexOf('hue-rotate') !== -1) ? ('hue-rotate(' + fix + 'deg) ' + fltr) : fltr;
  }
  /* One dino <img> (portrait), recoloured if mutated, falling back to the mark
     on load error — the fallback drops the filter so the logo shows true. */
  function hatchPortrait(dino, cls) {
    var im = document.createElement('img');
    im.className = cls; im.alt = '';
    var mf = mutFilter(dino.speciesId, dino.mutation);
    if (mf) im.style.filter = mf;
    im.src = dino.portrait || dino.icon || FALLBACK;
    im.addEventListener('error', function handler() {
      im.removeEventListener('error', handler);
      im.classList.add('is-fallback'); im.style.filter = '';
      im.src = FALLBACK;
    });
    return im;
  }

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

  /* After the reel lands, the reveal rains confetti for CONFETTI_MS, so the
     card holds the stage for the spin plus the full confetti window plus a
     small tail (so the last piece is never clipped). CONFETTI_MS is the single
     knob for how long the confetti lasts; describe() adds it onto the spin
     time. NOTE: at 30s the whole giveaway alert holds the stage ~36s, blocking
     other alerts for that window. */
  var CONFETTI_MS = 30000;
  var REEL_LAND_BUFFER = 900;   // tail after the confetti before the card leaves

  /* Bounded confetti piece counts — a hard cap per rarity so a win can never
     spawn an unbounded number of nodes; density scales a little with rarity.
     A bounded set is spread across the whole ~30s with randomized delays and
     fall durations so it reads as continuous rain. Each piece is a plain
     red/black/white rect animated with transform/opacity only (no
     filter/blur/shadow) that removes itself on animationend; see .ov-confetti
     in overlay.css. */
  var CONFETTI_PIECES = { rare: 300, mythic: 400 };

  /* Bounded ember counts for the landing burst — a hard cap per rarity so a
     mythic win can never spawn an unbounded number of particle nodes. Each
     ember is a plain colour div animated with transform/opacity only (no
     filter/blur) that removes itself on animationend; see .ov-ember in
     overlay.css. */
  var REEL_EMBERS = { rare: 16, mythic: 28 };

  /* ── Customizable wheel reveal ─────────────────────────────────────────
     A one-shot stage reveal like the giveaway reel: the wheel spins with a
     SINGLE CSS rotate transition (no rAF loop, no interval), decelerates onto
     the winning segment the SERVER chose, holds the result, then the card
     leaves and the stage returns to idle. describe() sets ms to cover the whole
     thing. */
  var WHEEL_SPIN_MS = 5200;
  var WHEEL_HOLD_MS = 4800;
  var WHEEL_SPINS = 6;          // full turns before it lands, so it reads as a spin

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
    /* RESUB — a returning subscriber, headlined with their month count. Distinct
       from a first-time 'sub': the streak/months are the whole point, and the
       viewer's shared message rides along when there is one. */
    if (ev.type === 'resub') {
      var months = Number(ev.months) || 1;
      var streak = Number(ev.streak) || 0;
      var streakNote = streak > 1 ? streak + '-month streak' : '';
      var resubMsg = ev.message ? esc(ev.message) : 'Thanks for sticking around';
      return {
        art: ART.love2, kind: 'Resub',
        title: esc(ev.who) + ' resubscribed — ' + months + ' month' + (months === 1 ? '' : 's') + '!',
        sub: streakNote ? streakNote + ' • ' + resubMsg : resubMsg,
        rarity: 'rare',
      };
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
    /* Twitch-native FOLLOW — a warm, low-key alert (common tier). */
    if (ev.type === 'follow') {
      /* A merged wave (see enqueue) — the count only, never the names. */
      var followers = Number(ev.count) || 1;
      if (followers > 1) {
        return { art: ART.love, kind: 'New Followers', title: '+' + followers + ' new followers', sub: 'Welcome to the crypt', rarity: 'common' };
      }
      return { art: ART.love, kind: 'New Follower', title: esc(ev.user || 'Someone') + ' followed!', sub: 'Welcome to the crypt', rarity: 'common' };
    }
    /* Twitch-native CHEER — bits amount headlined, tier by amount using the
       existing rarity emphasis (no new colours). Shows the message if there is
       one. */
    if (ev.type === 'cheer') {
      var bits = Number(ev.bits) || 0;
      var cheerRarity = bits >= 10000 ? 'mythic' : bits >= 1000 ? 'rare' : bits >= 100 ? 'uncommon' : 'common';
      return {
        art: ART.coinroll,
        kind: 'Cheer',
        title: esc(ev.user || 'Someone') + ' cheered ' + bits + ' bit' + (bits === 1 ? '' : 's') + '!',
        sub: ev.message ? esc(ev.message) : 'Thank you for the bits',
        rarity: cheerRarity,
      };
    }

    /* Dino hatch is NOT a queued stage alert — it has its own movable panel and
       is handled off-queue in poll() via showHatch(). See hatchData(). */

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

    /* ── Verified `!bingo` from chat ─────────────────────────────────────
       A viewer claimed a bingo in chat and the server checked their card
       against the called squares. Distinct from bingo-win, which is a prize
       the host already awarded: this is the moment the claim lands, before the
       host confirms. The name is event-derived, so it is escaped here. */
    if (ev.type === 'bingo-claim') {
      return {
        art: ART.hype, ms: 5000,
        kind: 'VERIFIED BINGO',
        title: esc(ev.who || 'A player') + ' called bingo!',
        sub: 'Verified — host to award the prize',
        rarity: 'rare',
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
        /* Optional overrides so the SAME grand reveal can serve the monthly
           ledger draw: a custom heading ("Monthly Giveaway") in place of the
           rarity label, and a pool note ("drawn from N entries…"). Absent for
           the Big Prize spin, which keeps its rarity heading and no note. */
        label: ev.label ? String(ev.label) : '',
        note: ev.note ? String(ev.note) : '',
        /* Life covers the spin, the landing pop, and the FULL confetti window
           plus a tail — so nothing is cut off. Same for both rarities. */
        ms: spinMs + CONFETTI_MS + REEL_LAND_BUFFER,
      };
    }

    /* ── Customizable wheel ─────────────────────────────────────────────
       A one-shot stage reveal: the wheel spins and lands on the segment the
       server weighted-picked. Segments carry their own on-palette colour and
       weight (arc size ∝ weight, so the wheel reads honestly). */
    if (ev.type === 'wheel-spin') {
      return {
        wheel: true,
        segments: Array.isArray(ev.segments) ? ev.segments : [],
        winnerIndex: ev.winnerIndex,
        who: ev.who || '',
        ms: WHEEL_SPIN_MS + WHEEL_HOLD_MS,
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
  /* A burst of check-ins at stream start (many viewers redeeming at once, plus
     Twitch's webhook redeliveries) would replay the chime every few seconds.
     Rate-limit the SOUND — the visual nudge still rises each time — so the one
     reused element plays at most once per window. */
  var CHECKIN_CHIME_COOLDOWN_MS = 20000;
  var lastCheckinChimeAt = 0;
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
  /* A random id for THIS overlay instance. The server sees it on every poll
     and names one open overlay the audio leader, so the check-in chime plays
     once however many overlay sources OBS has open. A muted source sends no id
     and never competes. `isAudioLeader` starts true so a lone overlay plays
     from the very first event; the server settles it within a poll. */
  var overlayIid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var isAudioLeader = true;

  /* ── AUDIO MONITOR MODE (overlay.html?monitor=1) ────────────────────────
     OBS captures the overlay's audio INTO the stream, so chat hears every
     alert/chime/hatch/egg clip but the streamer at the desk does not. The
     monitor is a copy the streamer keeps open in a NORMAL browser window (never
     an OBS source) purely so THEY hear that audio too. It differs from a normal
     overlay in exactly three ways, each gated behind this flag:
       1. It always plays locally — isAudioLeader is forced true and the poll
          NEVER overrides it from the server's election (see poll()).
       2. It stays OUT of the stream's leader election — it never sends &iid, so
          electAudioLeader never sees it and the OBS source stays the one true
          leader. The stream mix is unchanged; no doubling.
       3. It uses its OWN volume + mute, persisted in localStorage, independent
          of the control panel's master alertVolume (which still drives the OBS
          source on stream). A small on-page control bar (built only here, never
          captured) exposes that volume + mute to the streamer.
     Non-monitor behaviour is byte-for-byte unchanged. */
  var isMonitor = (function () {
    try { return new URLSearchParams(location.search).get('monitor') === '1'; }
    catch (e) { return false; }
  })();
  var MONITOR_VOL_KEY = 'ov_monitor_vol';
  var MONITOR_MUTE_KEY = 'ov_monitor_mute';
  var monitorVolume = 0.7;                    // 0..1, the monitor's own default
  if (isMonitor) {
    try {
      var mv = parseFloat(window.localStorage.getItem(MONITOR_VOL_KEY));
      if (Number.isFinite(mv) && mv >= 0 && mv <= 1) monitorVolume = mv;
    } catch (e) { /* no storage; default volume */ }
    var mm = false;
    try { mm = window.localStorage.getItem(MONITOR_MUTE_KEY) === '1'; } catch (e) {}
    /* Force the monitor to behave as the local audio leader; its mute is its own
       toggle, not the stream's ?muted flag. */
    isAudioLeader = true;
    audioMuted = mm;
    alertVolume = monitorVolume;              // playback volume = local value, never the server's
  }

  /* ── Dino hatch sounds ────────────────────────────────────────────────
     One sting per rarity, played once on the reveal keyed to the clutch's TOP
     rarity — a 50-gift bomb is one animation and one sound, never fifty.

     Marathon-safe like the check-in chime: FIVE reused Audio elements, one per
     rarity, created once and replayed by resetting currentTime — never
     `new Audio()` per hatch (that was the check-in duplicate-and-leak bug).
     Gated on the audio leader, the mute flag and the shared alert volume, so it
     plays once across however many OBS sources are open and never on a muted
     one. Files are optional: a missing rarity simply plays nothing (play()
     rejects and is swallowed), so this stays inert until the mp3s are in place. */
  var HATCH_SOUND_SRC = {
    common:    '/assets/audio/common.mp3',
    uncommon:  '/assets/audio/uncommon.mp3',
    rare:      '/assets/audio/rare.mp3',
    epic:      '/assets/audio/epic.mp3',
    legendary: '/assets/audio/legendary.mp3',
  };
  var hatchSounds = {};
  (function preloadHatchSounds() {
    try {
      for (var k in HATCH_SOUND_SRC) {
        var a = new Audio();
        a.preload = 'auto';
        a.src = HATCH_SOUND_SRC[k];
        hatchSounds[k] = a;
      }
    } catch (e) { /* no Audio in this embed — hatches just play silently */ }
  })();

  /* Hatch stings are off until the server says otherwise (muted by default,
     flipped from the bot panel). Starts false so nothing plays before the first
     poll settles it. */
  var hatchSoundOn = false;

  function playHatchSound(rarity) {
    if (!hatchSoundOn || audioMuted || !isAudioLeader) return;
    var a = hatchSounds[rarity] || hatchSounds.common;
    if (!a) return;
    try {
      a.volume = alertVolume;
      a.currentTime = 0;
      a.play().catch(function () { /* autoplay-with-sound blocked outside OBS, or file absent — silent */ });
    } catch (e) { /* the reveal still shows without the sting */ }
  }

  /* How long the whole hatch card stays up: the crack plus a hold that is at
     least long enough for the rarity's sting to finish (plus a short tail), so
     a big legendary fanfare is never cut off by the card leaving. Read from the
     preloaded audio's real duration, so swapping the mp3s needs no code change;
     falls back to the base hold before metadata loads, and is capped so even a
     very long file can't hold the stage — and every source computes the same
     length whether or not it is the one playing audio, keeping them in sync. */
  var HATCH_SOUND_TAIL = 500;   // card lingers this long after the sting ends
  var HATCH_MAX_MS = 15000;     // hard ceiling on stage time
  function hatchRevealMs(rarity) {
    var hold = HATCH_HOLD_MS;
    var a = hatchSounds[rarity];
    var sndMs = (a && isFinite(a.duration) && a.duration > 0) ? (a.duration * 1000) : 0;
    if (sndMs) hold = Math.max(hold, sndMs + HATCH_SOUND_TAIL);
    return Math.min(HATCH_MAX_MS, HATCH_ANIM_MS + hold);
  }

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

    if (ev && ev.sound && !audioMuted && isAudioLeader) {
      /* Cooldown so a wave of check-ins does not machine-gun the chime; the
         nudge above still shows for each one. */
      var nowChime = Date.now();
      if (nowChime - lastCheckinChimeAt >= CHECKIN_CHIME_COOLDOWN_MS) {
        lastCheckinChimeAt = nowChime;
        try {
          if (!checkinAudio) checkinAudio = new Audio(CHECKIN_AUDIO);
          checkinAudio.volume = alertVolume;
          checkinAudio.currentTime = 0;      // restart the one element rather than layering a new one
          checkinAudio.play().catch(function () { /* autoplay-with-sound blocked outside OBS — silent */ });
        } catch (e) { /* no audio element — the nudge still shows */ }
      }
    }

    checkinTimers.push(setTimeout(function () {
      panel.classList.remove('is-in');       // fade out
      checkinTimers.push(setTimeout(function () { panel.hidden = true; }, 360));
    }, CHECKIN_MS));
  }

  /* ── Alert sounds ──────────────────────────────────────────────────────
     The alert box played NO audio before — only the check-in chime did. A
     single default sting now plays when a celebratory alert shows (sub, resub,
     giftsub, raid, follow, cheer). Marathon-safe exactly like the check-in and
     hatch audio: ONE reused Audio element (never `new Audio()` per fire, which
     is the layering/leak bug that hit the check-in chime), rate-limited so a
     gift-sub bomb cannot machine-gun it, gated on the audio leader, the mute
     flag and the shared alert volume so it plays once across however many OBS
     sources are open and never on a muted one. The file is OPTIONAL: a missing
     mp3 makes play() reject, which is swallowed, so this stays silent rather
     than throwing until the sound is in place. Per-alert custom sounds are #2;
     this is the simple default. */
  var ALERT_SOUND_SRC = '/assets/audio/alert.mp3';
  var SOUND_ALERT_TYPES = { sub: true, resub: true, giftsub: true, raid: true, follow: true, cheer: true };
  var ALERT_SOUND_COOLDOWN_MS = 1500;
  var lastAlertSoundAt = 0;
  var alertSound = null;
  var alertSoundSrcNow = '';     // src currently loaded on the reused element
  /* Per-alert custom sounds set from the Overlay Dashboard, refreshed from the
     poll (see poll()). { type: { url, volume } }. A type not listed falls back
     to the default sting. */
  var alertSoundCfg = {};
  function playAlertSound(type) {
    if (!SOUND_ALERT_TYPES[type]) return;
    if (audioMuted || !isAudioLeader) return;
    var now = Date.now();
    if (now - lastAlertSoundAt < ALERT_SOUND_COOLDOWN_MS) return;
    lastAlertSoundAt = now;
    /* Per-type uploaded sound → default sting → silence. The per-type volume is
       relative to the shared alert volume, so the master slider still attenuates
       and muting still silences everything. */
    var cfg = alertSoundCfg[type];
    var src = (cfg && typeof cfg.url === 'string' && cfg.url) ? cfg.url : ALERT_SOUND_SRC;
    var perVol = (cfg && typeof cfg.volume === 'number') ? Math.max(0, Math.min(1, cfg.volume)) : 1;
    try {
      if (!alertSound) alertSound = new Audio();                  // created once, reused
      /* Swap src only when the chosen sound changes — not every fire — so the
         same sting is not re-fetched each time. */
      if (src !== alertSoundSrcNow) { alertSound.src = src; alertSoundSrcNow = src; }
      alertSound.volume = alertVolume * perVol;
      alertSound.currentTime = 0;                                 // restart the one element
      alertSound.play().catch(function () { /* blocked outside OBS, or file absent — silent */ });
    } catch (e) { /* no Audio element — the card still shows */ }
  }

  /* ── Egg-drop video ────────────────────────────────────────────────────
     A short transparent clip (VP9 + alpha) played bottom-right whenever the
     bot drops a dino egg — EVERY egg, any rarity or mutation. OFF the alert
     queue (like the check-in nudge and the hatch panel), so it never blocks or
     is blocked by a sub/raid card.

     MARATHON-SAFE: ONE reused <video> element (#ovEggVideo in overlay.html),
     never created or cloned per fire. It is played by rewinding and calling
     play(); two eggs landing together just restart the one element rather than
     stacking. On the clip's `ended` event — and a safety timeout, should
     `ended` never arrive (a decode stall, a codec fallback) — it pauses,
     resets currentTime to 0 and hides to display:none via the .ov-egg-video
     [hidden] guard, so the element neither composites nor decodes while idle.

     AUDIO: the clip carries its own audio, driven by the SAME master alert
     volume + mute + audio-leader plumbing as playAlertSound and the check-in
     chime — only the leader source plays it, a muted (?muted=1) source plays it
     silently, and the master alert-volume slider attenuates it. No new slider. */
  var EGG_VIDEO_MAX_MS = 8000;        // safety ceiling if `ended` never fires
  var eggVideoTimer = null;
  function hideEggVideo() {
    if (eggVideoTimer) { clearTimeout(eggVideoTimer); eggVideoTimer = null; }
    var v = document.getElementById('ovEggVideo');
    if (!v) return;
    try { v.pause(); } catch (e) {}
    try { v.currentTime = 0; } catch (e) {}
    v.hidden = true;
  }
  function showEggVideo(ev) {
    var v = document.getElementById('ovEggVideo');
    if (!v) return;
    /* Restart the ONE element — a pending safety timer from a previous fire is
       cleared so a quick second egg does not get torn down by the first. */
    if (eggVideoTimer) { clearTimeout(eggVideoTimer); eggVideoTimer = null; }

    /* Audio = the master alert volume, on the leader only. A muted or
       non-leader source plays the clip silently; OBS mixes just the leader's
       audio onto the stream. */
    var silent = audioMuted || !isAudioLeader;
    v.muted = silent;
    try { v.volume = silent ? 0 : alertVolume; } catch (e) {}

    /* Bind the end-of-clip teardown ONCE to this reused element. */
    if (!v._eggBound) {
      v._eggBound = true;
      v.addEventListener('ended', hideEggVideo);
    }

    v.hidden = false;
    try { v.currentTime = 0; } catch (e) {}
    var p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function () {
        /* Unmuted autoplay can be blocked outside OBS (a browser preview). Retry
           muted so the clip still shows; in OBS the first play succeeds. */
        try { v.muted = true; v.play().catch(hideEggVideo); } catch (e) { hideEggVideo(); }
      });
    }
    eggVideoTimer = setTimeout(hideEggVideo, EGG_VIDEO_MAX_MS);
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
    /* A custom label (the monthly draw) overrides the rarity heading. */
    kind.textContent = d.label || ((d.rarity === 'mythic' ? 'Mythic' : 'Rare') + ' Giveaway');
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

    /* Optional pool note (the monthly draw), e.g. "Drawn from N entries across
       M people". A server-composed plain string; textContent needs no escaping.
       It is a child of the card, so it leaves with the card like everything
       else — no extra teardown. */
    if (d.note) {
      var note = document.createElement('p');
      note.className = 'ov-reel-note';
      note.textContent = d.note;
      card.appendChild(note);
    }

    /* Every timer/frame this card starts is registered here; render() calls
       card._cleanup the instant the card detaches, so nothing ticks or holds
       a node off-screen on a marathon. The celebration nodes celebrateReel()
       adds (winner pop, prize line, embers, confetti) are children of the card
       and leave with it — the embers and confetti also self-remove on
       animationend — so none survive the reveal even if the card is torn down
       mid-flight. */
    var landTimer = null, raf1 = 0, raf2 = 0;
    card._cleanup = function () {
      if (landTimer) { clearTimeout(landTimer); landTimer = null; }
      if (raf1) { cancelAnimationFrame(raf1); raf1 = 0; }
      if (raf2) { cancelAnimationFrame(raf2); raf2 = 0; }
    };

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
      raf1 = requestAnimationFrame(function () {
        void strip.offsetHeight;   // now attached — a real reflow at the top
        raf2 = requestAnimationFrame(function () {
          strip.style.transition = 'transform ' + (spinMs / 1000) + 's cubic-bezier(0.12, 0.8, 0.18, 1)';
          strip.style.transform = 'translateY(' + plan.offset + 'px)';
        });
      });

      landTimer = setTimeout(function () {
        landTimer = null;
        celebrateReel(card, caption, d);
      }, spinMs + 100);
    } else {
      caption.textContent = 'No entrants to draw from.';
    }

    return card;
  }

  /* ── The landing moment ────────────────────────────────────────────────
     The reel has stopped on the winner. This turns the stop into the hype
     beat: the name pops up big and centred, the prize and claim URL appear,
     the card border flares (via .is-landed in overlay.css),
     a bounded burst of rarity-coloured embers rises and clears itself, and
     then RED/BLACK/WHITE confetti rains for ~CONFETTI_MS. MYTHIC is grander
     than RARE — bigger name, gold glow, more embers, denser confetti — all
     driven by [data-rarity] in the stylesheet.

     This reveal is PURELY VISUAL — it plays no sound and creates no Audio
     element, and it does not touch the overlay's audio plumbing.

     MARATHON-SAFE: every node here is a child of the card, so render()'s
     removal takes them all; embers AND confetti additionally remove themselves
     on animationend. Nothing starts a timer, interval, or rAF loop — the
     pop/rise/fall motion is one-shot CSS that ends on its own, and the confetti
     is a BOUNDED set whose randomized delays spread it across the whole window
     rather than an ongoing spawner. */
  function celebrateReel(card, caption, d) {
    card.classList.add('is-landed');
    /* textContent, not the innerHTML esc() elsewhere is for — plain string
       assignments here need no escaping of their own. */
    caption.textContent = 'Claim at phantomace.tv/giveaway';

    var winner = document.createElement('p');
    winner.className = 'ov-reel-winner';
    winner.textContent = d.who || 'We have a winner';   // a Twitch username, not markup
    card.insertBefore(winner, caption);

    var prize = document.createElement('p');
    prize.className = 'ov-reel-prize';
    prize.textContent = 'wins the ' + (d.rarity === 'mythic' ? 'Mythic' : 'Rare') + ' prize!';
    card.insertBefore(prize, caption);

    /* One shared handler so every particle removes itself the instant its
       animation ends — bounded set in, nothing left behind. */
    var removeSelf = function (e) {
      var t = e.currentTarget;
      if (t && t.parentNode) t.parentNode.removeChild(t);
    };

    /* Motion is skipped entirely under reduced motion — the winner card still
       shows, just without the embers/confetti. */
    if (!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      /* Embers — a bounded, one-shot rising burst at the moment of landing. */
      var fx = document.createElement('div');
      fx.className = 'ov-reel-fx';
      var count = REEL_EMBERS[d.rarity] || REEL_EMBERS.rare;
      for (var i = 0; i < count; i++) {
        var ember = document.createElement('span');
        ember.className = 'ov-ember';
        var sz = 4 + Math.round(Math.random() * 5);
        ember.style.left = Math.round(Math.random() * 100) + '%';
        ember.style.width = sz + 'px';
        ember.style.height = sz + 'px';
        ember.style.animationDuration = (1.5 + Math.random() * 1.3).toFixed(2) + 's';
        ember.style.animationDelay = (Math.random() * 0.7).toFixed(2) + 's';
        ember.addEventListener('animationend', removeSelf);
        fx.appendChild(ember);
      }
      card.appendChild(fx);

      /* Confetti — RED / BLACK / WHITE only. A BOUNDED set of small rects whose
         randomized delays are spread across [0, CONFETTI_MS - fall] and whose
         fall durations vary, so the fixed set reads as continuous rain for the
         whole window while every piece still finishes (delay + duration never
         exceeds CONFETTI_MS) and removes itself on animationend. Falls, drifts
         and rotates via transform + opacity only — no filter/blur/shadow. */
      var confetti = document.createElement('div');
      confetti.className = 'ov-reel-confetti';
      var colours = ['is-red', 'is-black', 'is-white'];
      var pieces = CONFETTI_PIECES[d.rarity] || CONFETTI_PIECES.rare;
      for (var c = 0; c < pieces; c++) {
        var bit = document.createElement('span');
        bit.className = 'ov-confetti ' + colours[Math.floor(Math.random() * colours.length)];
        var durMs = 2200 + Math.round(Math.random() * 2300);          // 2.2–4.5s fall
        var maxDelay = Math.max(0, CONFETTI_MS - durMs);              // finish within the window
        var bw = 5 + Math.round(Math.random() * 4);
        var bh = 8 + Math.round(Math.random() * 7);
        bit.style.left = (Math.random() * 100).toFixed(2) + '%';
        bit.style.width = bw + 'px';
        bit.style.height = bh + 'px';
        bit.style.animationDuration = durMs + 'ms';
        bit.style.animationDelay = Math.round(Math.random() * maxDelay) + 'ms';
        bit.style.setProperty('--dx', (Math.round(Math.random() * 120) - 60) + 'px');
        bit.style.setProperty('--rot', (360 + Math.round(Math.random() * 720)) + 'deg');
        bit.addEventListener('animationend', removeSelf);
        confetti.appendChild(bit);
      }
      card.appendChild(confetti);
    }
  }

  /* ── Dino hatch card ──────────────────────────────────────────────────
     `.is-hatching` shows the egg strip and withholds the reveal; the strip
     plays once, then a SINGLE hatch shows one portrait and a BOMB scrolls a reel
     through the whole clutch. Portraits, names and the headline are event-derived
     and set via img.src / textContent — no innerHTML, so nothing needs escaping.
     Every timer the card starts is registered on `card._cleanup`, which render()
     calls the instant the card detaches, so nothing ticks off-screen on a
     marathon. */
  function buildHatchCard(ev, d) {
    var card = document.createElement('div');
    /* NOT an .ov-alert: the hatch lives in its own movable, transparent panel
       (#ovHatch), not the shared alert card, so it has no black card chrome. */
    card.className = 'ov-hatch is-hatching';
    card.dataset.type = ev.type;
    card.dataset.rarity = d.rarity || 'common';

    var egg = document.createElement('div');
    egg.className = 'ov-hatch-egg';
    egg.style.backgroundImage = 'url(' + HATCH_STRIP + ')';
    card.appendChild(egg);

    var reveal = document.createElement('div');
    reveal.className = 'ov-hatch-reveal';
    card.appendChild(reveal);

    var timer = null;
    card._cleanup = function () { if (timer) { clearInterval(timer); timer = null; } };

    var f = 0;
    timer = setInterval(function () {
      f++;
      if (f >= HATCH_FRAMES) {
        clearInterval(timer); timer = null;
        card.classList.remove('is-hatching');   // the reveal appears
        playHatchSound(d.rarity);                // …and the rarity sting lands with it
        if (d.bomb) buildHatchParade(reveal, d);
        else buildHatchSingle(reveal, d);
        return;
      }
      egg.style.backgroundPositionX = '-' + (f * HATCH_FW) + 'px';
    }, HATCH_STEP_MS);

    return card;
  }

  /* One dino: the portrait, a rarity chip, the mutation chip if it rolled one,
     and the headline. */
  function buildHatchSingle(reveal, d) {
    var only = d.results[0];
    if (!only) return;

    reveal.appendChild(hatchPortrait(only, 'ov-hatch-portrait'));

    var tags = document.createElement('div');
    tags.className = 'ov-hatch-tags';
    var rc = document.createElement('span');
    rc.className = 'ov-hatch-rchip'; rc.dataset.rarity = only.rarity || 'common';
    rc.textContent = capRarity(only.rarity);
    tags.appendChild(rc);
    if (only.mutation && MUT[only.mutation]) {
      var mc = document.createElement('span');
      mc.className = 'ov-hatch-mchip'; mc.style.setProperty('--mc', MUT[only.mutation].c);
      mc.textContent = '✦ ' + MUT[only.mutation].l;
      tags.appendChild(mc);
    }
    reveal.appendChild(tags);

    var title = document.createElement('p');
    title.className = 'ov-title';
    var mutName = (only.mutation && MUT[only.mutation]) ? (MUT[only.mutation].l + ' ') : '';
    title.textContent = d.who + ' hatched a ' + mutName + capRarity(only.rarity) + ' ' + only.name + '!';
    reveal.appendChild(title);

    var sub = document.createElement('p');
    sub.className = 'ov-sub';
    sub.textContent = 'Straight to their Dino Park';
    reveal.appendChild(sub);
  }

  /* A gift bomb: the whole clutch scrolls past in hatch order, edge-faded like a
     slot reel, then rests on the last frame until the card leaves (d.ms covers
     the crack + this scroll + a tail). No grid follows — the scroll is the
     reveal. The reel is a CSS transform, so removing the card ends it; no timer
     to clear here beyond the strip interval buildHatchCard already owns. */
  function buildHatchParade(reveal, d) {
    var head = document.createElement('p');
    head.className = 'ov-title ov-hatch-phead';
    head.textContent = d.who + ' hatched ' + d.count + ' dinos!';
    reveal.appendChild(head);

    var view = document.createElement('div');
    view.className = 'ov-hatch-pview';
    var strip = document.createElement('div');
    strip.className = 'ov-hatch-pstrip';

    var shown = d.results.slice(0, HATCH_TILE_CAP);
    shown.forEach(function (x) {
      var row = document.createElement('div');
      row.className = 'ov-hatch-prow';
      row.appendChild(hatchPortrait(x, 'ov-hatch-pportrait'));

      var meta = document.createElement('div');
      meta.className = 'ov-hatch-pmeta';
      var rc = document.createElement('span');
      rc.className = 'ov-hatch-rchip'; rc.dataset.rarity = x.rarity || 'common';
      rc.textContent = x.rarity;
      var nm = document.createElement('span');
      nm.className = 'ov-hatch-pname'; nm.dataset.rarity = x.rarity || 'common';
      nm.textContent = x.name;
      meta.appendChild(rc); meta.appendChild(nm);
      if (x.mutation && MUT[x.mutation]) {
        var mm = document.createElement('span');
        mm.className = 'ov-hatch-pmut'; mm.style.setProperty('--mc', MUT[x.mutation].c);
        mm.textContent = '✦ ' + MUT[x.mutation].l;
        meta.appendChild(mm);
      }
      row.appendChild(meta);
      strip.appendChild(row);
    });
    if (d.more > 0) {
      var moreRow = document.createElement('div');
      moreRow.className = 'ov-hatch-prow ov-hatch-pmore';
      moreRow.textContent = '+' + d.more + ' more';
      strip.appendChild(moreRow);
    }
    view.appendChild(strip);
    reveal.appendChild(view);

    requestAnimationFrame(function () {
      var dist = Math.max(0, strip.scrollHeight - view.clientHeight);
      var dur = paradeDurMs(shown.length);
      strip.style.transform = 'translateY(0)';
      void strip.offsetHeight;
      strip.style.transition = 'transform ' + dur + 'ms cubic-bezier(0.33, 0, 0.9, 1)';
      strip.style.transform = 'translateY(-' + dist + 'px)';
    });
  }

  /* ── The dino hatch panel (#ovHatch) ──────────────────────────────────
     Its own MOVABLE, transparent panel — not the shared alert queue — because
     the reveal is a different size from the stage alerts and the broadcaster
     places it in the layout editor. Off-queue, so a hatch never delays (or is
     delayed by) a sub/raid card; a new hatch replaces any in-progress one, and
     everything clears when it's done (panel back to hidden, timers cleared) so
     nothing lingers on a marathon. */
  var hatchHideTimer = null;

  function hatchData(ev) {
    var results = Array.isArray(ev.results) ? ev.results : [];
    var top = ev.top || (results[0] && results[0].rarity) || 'common';
    var count = Number(ev.count) || results.length || 1;
    var bomb = count > 1;
    return {
      who: ev.who || 'Someone', count: count, results: results,
      more: Number(ev.more) || 0, rarity: top, bomb: bomb,
      ms: bomb
        ? (HATCH_ANIM_MS + paradeDurMs(Math.min(results.length, HATCH_TILE_CAP)) + PARADE_TAIL_MS)
        : hatchRevealMs(top),
    };
  }

  function clearHatch() {
    if (hatchHideTimer) { clearTimeout(hatchHideTimer); hatchHideTimer = null; }
    var panel = document.getElementById('ovHatch');
    if (!panel) return;
    var kids = panel.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i]._cleanup) { try { kids[i]._cleanup(); } catch (e) {} }
    }
    panel.replaceChildren();
    panel.hidden = true;
  }

  function showHatch(ev) {
    var panel = document.getElementById('ovHatch');
    if (!panel) return;
    clearHatch();
    var d = hatchData(ev);
    panel.appendChild(buildHatchCard(ev, d));
    panel.hidden = false;
    hatchHideTimer = setTimeout(clearHatch, d.ms);
  }

  /* ── Channel point Prediction panel (#ovPrediction) ────────────────────
     A MOVABLE standing panel, off the alert queue (so it never blocks a
     sub/raid card). Driven by 'prediction' overlay events: it shows while a
     prediction is ACTIVE or LOCKED, reveals the winner briefly on resolve,
     then HIDES to display:none.

     MARATHON-SAFE: the ONLY timer is the lock countdown (a 1s interval while
     ACTIVE) plus a single hide timeout on end/cancel — both registered in
     predTimers and cleared on every state change and on clear. The countdown
     bails the instant the panel is hidden or the lock time passes, so nothing
     ticks while the panel is down. The outcome list is REBUILT by replacing
     children each update (never appended), and clearPrediction empties it so no
     removed node is retained. The panel reaches display:none via its
     .ov-prediction[hidden] guard in overlay.css. */
  var PRED_REVEAL_MS = 8000;    // how long the resolved winner stays before hiding
  var PRED_CANCEL_MS = 3500;    // brief "canceled" note, then hide
  /* SAFETY CAPS. The panel normally hides on 'end', but an 'end' can fail to
     arrive — a revoked EventSub subscription, the overlay reloading after it
     fired, a lost webhook. A panel that never hides also blocks the idle
     self-reload for the rest of the stream. So every shown state carries its
     own hide timer (in predTimers, so the next state replaces it):
       • ACTIVE hides at the prediction's own lock time + a grace (Twitch's
         window is at most 30 min, so no lock time means 30 min + grace);
       • LOCKED hides 30 min after the lock. */
  var PRED_WINDOW_MAX_MS = 30 * 60 * 1000;
  var PRED_LOCK_GRACE_MS = 5 * 60 * 1000;
  var PRED_LOCKED_MAX_MS = 30 * 60 * 1000;
  var predTimers = [];
  function clearPredTimers() {
    predTimers.forEach(clearInterval);
    predTimers.forEach(clearTimeout);
    predTimers = [];
  }

  function renderPredOutcomes(ev, winningId) {
    var list = document.getElementById('ovPredOutcomes');
    if (!list) return;
    var outcomes = Array.isArray(ev.outcomes) ? ev.outcomes : [];
    var total = 0;
    for (var t = 0; t < outcomes.length; t++) total += Number(outcomes[t].points) || 0;

    var rows = outcomes.map(function (o) {
      var pts = Number(o.points) || 0;
      var users = Number(o.users) || 0;
      var pct = total > 0 ? Math.round((pts / total) * 100) : 0;

      var row = document.createElement('li');
      row.className = 'ov-pred-outcome' + (winningId && o.id === winningId ? ' is-winner' : '');

      var head = document.createElement('div');
      head.className = 'ov-pred-outcome-head';
      var name = document.createElement('span');
      name.className = 'ov-pred-outcome-name';
      name.textContent = o.title || '';                 // broadcaster text — textContent, not markup
      var pctEl = document.createElement('span');
      pctEl.className = 'ov-pred-outcome-pct';
      pctEl.textContent = pct + '%';
      head.appendChild(name);
      head.appendChild(pctEl);

      var bar = document.createElement('div');
      bar.className = 'ov-pred-bar';
      var fill = document.createElement('i');
      fill.style.width = pct + '%';
      bar.appendChild(fill);

      var meta = document.createElement('div');
      meta.className = 'ov-pred-outcome-meta';
      meta.textContent = pts.toLocaleString() + ' pts · ' + users + (users === 1 ? ' voter' : ' voters');

      row.appendChild(head);
      row.appendChild(bar);
      row.appendChild(meta);
      return row;
    });

    /* Rebuild by REPLACING children — never append onto a growing list. */
    list.replaceChildren.apply(list, rows);
  }

  function clearPrediction() {
    clearPredTimers();
    var panel = document.getElementById('ovPrediction');
    if (!panel) return;
    var list = document.getElementById('ovPredOutcomes');
    if (list) list.replaceChildren();   // retain no removed nodes
    panel.hidden = true;                // → display:none via the [hidden] guard
  }

  function showPrediction(ev) {
    var panel = document.getElementById('ovPrediction');
    if (!panel) return;
    /* Every update starts by clearing the previous state's timers, so at most
       one countdown/hide timer is ever live. */
    clearPredTimers();

    var labelEl = document.getElementById('ovPredLabel');
    var titleEl = document.getElementById('ovPredTitle');
    var timerEl = document.getElementById('ovPredTimer');
    if (titleEl) titleEl.textContent = ev.title || 'Prediction';

    var state = ev.state;

    /* A teardown for a prediction alert that was switched off (events.js
       sends it `quiet`): close whatever is up, show no reveal. */
    if (ev.quiet) { clearPrediction(); return; }

    if (state === 'end') {
      var status = String(ev.status || '').toUpperCase();
      if (status === 'CANCELED') {
        panel.dataset.state = 'canceled';
        if (labelEl) labelEl.textContent = 'Canceled';
        if (timerEl) timerEl.textContent = '';
        renderPredOutcomes(ev, null);
        panel.hidden = false;
        predTimers.push(setTimeout(clearPrediction, PRED_CANCEL_MS));
      } else {
        panel.dataset.state = 'resolved';
        if (labelEl) labelEl.textContent = 'Winner';
        if (timerEl) timerEl.textContent = '';
        renderPredOutcomes(ev, ev.winningOutcomeId);
        panel.hidden = false;
        predTimers.push(setTimeout(clearPrediction, PRED_REVEAL_MS));
      }
      return;
    }

    if (state === 'lock') {
      panel.dataset.state = 'locked';
      if (labelEl) labelEl.textContent = 'Locked';
      if (timerEl) timerEl.textContent = 'LOCKED';
      renderPredOutcomes(ev, null);
      panel.hidden = false;
      /* No countdown, nothing ticking — only the one safety hide timer,
         measured from the lock (server clock) and never longer than the cap. */
      var lockedAt = ev.locksAt ? Date.parse(ev.locksAt) : NaN;
      var lockedLeft = isFinite(lockedAt) ? lockedAt + PRED_LOCKED_MAX_MS - serverTime() : PRED_LOCKED_MAX_MS;
      predTimers.push(setTimeout(clearPrediction, Math.max(0, Math.min(PRED_LOCKED_MAX_MS, lockedLeft))));
      return;
    }

    /* begin / progress → ACTIVE */
    panel.dataset.state = 'active';
    if (labelEl) labelEl.textContent = 'Prediction';
    renderPredOutcomes(ev, null);
    panel.hidden = false;

    var locksAt = ev.locksAt ? Date.parse(ev.locksAt) : 0;
    var hasLock = !!locksAt && !Number.isNaN(locksAt);
    var activeLeft = hasLock ? locksAt - serverTime() + PRED_LOCK_GRACE_MS : PRED_WINDOW_MAX_MS + PRED_LOCK_GRACE_MS;
    predTimers.push(setTimeout(clearPrediction,
      Math.max(0, Math.min(PRED_WINDOW_MAX_MS + PRED_LOCK_GRACE_MS, activeLeft))));

    if (!timerEl) return;
    if (!hasLock) { timerEl.textContent = ''; return; }

    var tick = function () {
      /* NOTHING RUNS WHILE HIDDEN: bail (and stop) the instant the panel is
         down or the lock time has passed. Measured on the SERVER clock — the
         lock time is Twitch's, and the streaming PC's clock may be off. */
      if (panel.hidden) { clearInterval(iv); return; }
      var ms = locksAt - serverTime();
      if (ms <= 0) { timerEl.textContent = 'Locking…'; clearInterval(iv); return; }
      var secs = Math.ceil(ms / 1000);
      var mins = Math.floor(secs / 60);
      timerEl.textContent = mins + ':' + String(secs % 60).padStart(2, '0');
    };
    var iv = setInterval(tick, 1000);
    predTimers.push(iv);
    tick();
  }

  /* ── OVERLAY STATE SNAPSHOT (overlay #3) ────────────────────────────────
     The server returns one `overlayState` record on every poll holding the
     CURRENT prediction, hype-train progress and ad countdown. The overlay reads
     all three from HERE — one place — so a reloaded OBS source (it reloads
     constantly) rehydrates these standing panels instead of losing them when
     their originating event falls outside the alert replay window.

     FIRST-SIGHTING-WITHOUT-ACTING, the same rule the reload/control tokens use:
     on the first snapshot this source sees, a RESOLVED prediction is restored as
     hidden rather than replaying its winner reveal on air. A live resolve (the
     slice's ver changing while the source is already open) still plays once.
     Standing state — an active/locked prediction, the hype bar, the ad countdown
     — is idempotent to apply, so restoring it is never a "replay".

     Each slice carries the `ver` it was written at, so a slice is re-applied
     only when it actually changed. */
  var seenOverlayState = false;
  var predSliceVer = null, hypeSliceVer = null, adSliceVer = null;

  function applyHypeBar(h) {
    var panel = document.getElementById('ovHype');
    if (!panel) return;
    if (!h || h.active === false) { panel.hidden = true; return; }
    var levelEl = document.getElementById('ovHypeLevel');
    var bar = document.getElementById('ovHypeBar');
    if (levelEl) levelEl.textContent = 'Level ' + (Number(h.level) || 1);
    var total = Number(h.total) || 0, goal = Number(h.goal) || 0;
    var pct = goal > 0 ? Math.max(0, Math.min(100, Math.round((total / goal) * 100))) : 0;
    if (bar) bar.style.width = pct + '%';
    panel.hidden = false;   // no timers: a standing bar is inherently marathon-safe
  }

  /* The ad countdown is the ONE snapshot panel that ticks. endsAt is absolute
     (server clock), so it counts down from it and hides itself when it passes —
     there is no ad_break.end event to clear it. Marathon-safe: one interval,
     bailed the instant the panel is hidden or the time is up. */
  var adTimer = null;
  function clearAdTimer() { if (adTimer) { clearInterval(adTimer); adTimer = null; } }
  function applyAdBreak(a) {
    var panel = document.getElementById('ovAdBreak');
    if (!panel) return;
    clearAdTimer();
    var endsAt = a && Number(a.endsAt);
    if (!endsAt || serverTime() >= endsAt) { panel.hidden = true; return; }
    var timerEl = document.getElementById('ovAdBreakTimer');
    function tick() {
      if (panel.hidden) { clearAdTimer(); return; }           // nothing runs while hidden
      var ms = endsAt - serverTime();
      if (ms <= 0) { panel.hidden = true; clearAdTimer(); return; }
      var secs = Math.ceil(ms / 1000);
      if (timerEl) timerEl.textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
    }
    panel.hidden = false;
    tick();
    adTimer = setInterval(tick, 1000);
  }

  function applyOverlayState(st) {
    var first = !seenOverlayState;
    seenOverlayState = true;
    st = st && typeof st === 'object' ? st : {};

    /* PREDICTION — driven from the snapshot (one place), not the alert queue. */
    var p = st.prediction || null;
    var pv = p ? Number(p.ver) : 0;
    if (pv !== predSliceVer) {
      if (p) {
        /* On the first sight of an already-resolved prediction, restore to
           hidden — do not replay the reveal. A live resolve (not first) plays. */
        if (first && p.state === 'end') clearPrediction();
        else showPrediction(p);
      } else if (!first) {
        clearPrediction();
      }
      predSliceVer = pv;
    }

    /* HYPE BAR — a standing bar, safe to re-apply. */
    var h = st.hype || null;
    var hv = h ? Number(h.ver) : 0;
    if (hv !== hypeSliceVer) { applyHypeBar(h); hypeSliceVer = hv; }

    /* AD COUNTDOWN. */
    var a = st.ad || null;
    var av = a ? Number(a.ver) : 0;
    if (av !== adSliceVer) { applyAdBreak(a); adSliceVer = av; }
  }

  /* ── Customizable wheel card ───────────────────────────────────────────
     A one-shot stage reveal. The wheel is an <svg> whose whole element rotates
     via a SINGLE CSS transform transition (no rAF loop, no interval); a fixed
     HTML pointer sits over the top. Slices are sized by weight so the picture is
     honest, and the wheel lands the winning slice's centre under the pointer —
     the SERVER's weighted pick is authoritative. Every node is a child of the
     card, so render()'s end-of-life teardown removes them; card._cleanup also
     clears the one landing timer and cancels the two deferred-start rAFs. */
  var SVGNS = 'http://www.w3.org/2000/svg';
  function wheelPoint(cx, cy, r, deg) {
    var t = deg * Math.PI / 180;                 // clockwise from the top (12 o'clock)
    return { x: cx + r * Math.sin(t), y: cy - r * Math.cos(t) };
  }

  function buildWheelCard(ev, d) {
    var card = document.createElement('div');
    card.className = 'ov-alert ov-wheel-card';
    card.dataset.type = ev.type;

    var kind = document.createElement('span');
    kind.className = 'ov-kind';
    kind.textContent = 'Wheel';
    card.appendChild(kind);

    var wrap = document.createElement('div');
    wrap.className = 'ov-wheel-wrap';
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'ov-wheel');
    svg.setAttribute('viewBox', '0 0 220 220');
    var spinG = document.createElementNS(SVGNS, 'g');   // (the whole svg rotates; g just groups)
    svg.appendChild(spinG);
    /* Fixed pointer over the top, drawn as an SVG triangle (no border-triangle,
       no shadow); it does not rotate with the wheel. */
    var pointer = document.createElementNS(SVGNS, 'svg');
    pointer.setAttribute('class', 'ov-wheel-pointer');
    pointer.setAttribute('viewBox', '0 0 24 20');
    var tri = document.createElementNS(SVGNS, 'polygon');
    tri.setAttribute('points', '12,20 0,0 24,0');
    pointer.appendChild(tri);
    var hub = document.createElement('div');
    hub.className = 'ov-wheel-hub';
    wrap.appendChild(svg);
    wrap.appendChild(pointer);
    wrap.appendChild(hub);
    card.appendChild(wrap);

    var caption = document.createElement('p');
    caption.className = 'ov-sub ov-wheel-caption';
    caption.textContent = 'Spinning the wheel…';
    card.appendChild(caption);

    var winner = document.createElement('p');
    winner.className = 'ov-wheel-winner';
    card.appendChild(winner);

    var landTimer = null, raf1 = 0, raf2 = 0;
    card._cleanup = function () {
      if (landTimer) { clearTimeout(landTimer); landTimer = null; }
      if (raf1) { cancelAnimationFrame(raf1); raf1 = 0; }
      if (raf2) { cancelAnimationFrame(raf2); raf2 = 0; }
    };

    var segs = d.segments || [];
    if (segs.length >= 2) {
      var cx = 110, cy = 110, r = 100;
      var total = 0;
      for (var t = 0; t < segs.length; t++) total += Number(segs[t].weight) > 0 ? Number(segs[t].weight) : 1;

      var angle = 0;
      var winnerCenter = 0;
      segs.forEach(function (seg, i) {
        var w = Number(seg.weight) > 0 ? Number(seg.weight) : 1;
        var arc = (w / total) * 360;
        var a0 = angle, a1 = angle + arc;
        var p0 = wheelPoint(cx, cy, r, a0), p1 = wheelPoint(cx, cy, r, a1);
        var large = arc > 180 ? 1 : 0;

        var path = document.createElementNS(SVGNS, 'path');
        path.setAttribute('d', 'M ' + cx + ' ' + cy + ' L ' + p0.x.toFixed(2) + ' ' + p0.y.toFixed(2) +
          ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1.x.toFixed(2) + ' ' + p1.y.toFixed(2) + ' Z');
        /* seg.color is a curated on-palette hex the server resolved; a fallback
           keeps a missing colour on-brand rather than transparent. */
        path.setAttribute('fill', seg.color || (i % 2 ? '#1a1a1a' : '#6b0f0f'));
        path.setAttribute('stroke', '#0a0a0a');
        path.setAttribute('stroke-width', '1.5');
        spinG.appendChild(path);

        var mid = a0 + arc / 2;
        var lp = wheelPoint(cx, cy, r * 0.62, mid);
        var label = document.createElementNS(SVGNS, 'text');
        label.setAttribute('x', lp.x.toFixed(2));
        label.setAttribute('y', lp.y.toFixed(2));
        label.setAttribute('class', 'ov-wheel-label');
        /* Radial text, kept upright-ish; the dark stroke (paint-order) makes
           #fff readable on any curated fill without a box-shadow. */
        label.setAttribute('transform', 'rotate(' + mid.toFixed(2) + ' ' + lp.x.toFixed(2) + ' ' + lp.y.toFixed(2) + ')');
        label.textContent = (seg.label == null ? '' : String(seg.label)).slice(0, 24);
        spinG.appendChild(label);

        if (i === d.winnerIndex) winnerCenter = mid;
        angle = a1;
      });

      /* Rotating the group clockwise by R brings the winner's centre (at
         clockwise angle winnerCenter) to the top pointer: R ≡ -winnerCenter,
         plus whole turns for the spin. */
      var targetRot = WHEEL_SPINS * 360 + (360 - winnerCenter);

      svg.style.transform = 'rotate(0deg)';
      raf1 = requestAnimationFrame(function () {
        void svg.getBoundingClientRect();       // now attached — a real reflow at 0deg
        raf2 = requestAnimationFrame(function () {
          svg.style.transition = 'transform ' + (WHEEL_SPIN_MS / 1000) + 's cubic-bezier(0.16, 0.84, 0.2, 1)';
          svg.style.transform = 'rotate(' + targetRot.toFixed(2) + 'deg)';
        });
      });

      landTimer = setTimeout(function () {
        landTimer = null;
        card.classList.add('is-landed');
        caption.textContent = 'Winner';
        winner.textContent = d.who || (segs[d.winnerIndex] && segs[d.winnerIndex].label) || '';
      }, WHEEL_SPIN_MS + 100);
    } else {
      caption.textContent = 'No wheel configured.';
    }

    return card;
  }

  function render(ev) {
    var d = describe(ev);
    if (!d) return false;

    var card = d.reel ? buildReelCard(ev, d)
      : d.wheel ? buildWheelCard(ev, d)
      : buildStandardCard(ev, d);
    stage.appendChild(card);

    /* The alert sting, for the celebratory types — one reused element, rate
       limited and leader-gated (see playAlertSound). */
    playAlertSound(ev.type);

    /* PUBLISHED, NOT ENFORCED. The standing panels — Mana Clash, the
       scramble — are things a viewer can look at whenever; an alert is the
       thing they must not miss. Rather than teach this file where each
       panel sits, it says only that a card is up, and the stylesheet gets
       out of the way. One class, and a new panel costs nothing here. */
    document.body.classList.add('ov-alerting');

    card._showTimer = setTimeout(function () {
      card._showTimer = null;
      card.classList.add('is-leaving');
      card._leaveTimer = setTimeout(function () {
        card._leaveTimer = null;
        detachCard(card);
        finishShowing();
      }, 340);
    }, d.ms || SHOW_MS);

    return true;
  }

  /* Detach one alert card and stop EVERYTHING it started — its own per-card
     animation loop (_cleanup) and the show/leave timers this file owns — before
     it leaves the DOM, so nothing ticks against an off-screen node on a
     marathon. Shared by the normal end-of-life, Skip and Clear. */
  function detachCard(card) {
    if (!card) return;
    if (card._showTimer) { clearTimeout(card._showTimer); card._showTimer = null; }
    if (card._leaveTimer) { clearTimeout(card._leaveTimer); card._leaveTimer = null; }
    if (card._cleanup) { try { card._cleanup(); } catch (e) {} card._cleanup = null; }
    if (card.parentNode) card.parentNode.removeChild(card);
  }

  /* Back to "nothing on the stage", in one place so `showing` and the body flag
     can never disagree about whether anything is up. */
  function finishShowing() {
    showing = false;
    document.body.classList.remove('ov-alerting');
    setTimeout(pump, GAP_MS);
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

  /* ── PANIC CONTROLS ────────────────────────────────────────────────────────
     Driven by the dashboard's Clear/Skip through the event feed (see poll()).

     SKIP dismisses the alert on screen and lets the next queued one play.
     CLEAR wipes everything a moderator can see go wrong: the queued and
     on-screen alerts, and the three off-queue panels (check-in, hatch,
     prediction). The standing GAME panels are left alone — their own pollers
     reflect live game state, so hiding them here would only flip back on the
     next poll. Every path returns the overlay to its idle state (0 stage
     children, panels at display:none, all timers cleared). */
  function skipCurrent() {
    while (stage.firstElementChild) detachCard(stage.firstElementChild);
    finishShowing();
  }

  function clearAll() {
    queue.length = 0;
    while (stage.firstElementChild) detachCard(stage.firstElementChild);
    showing = false;
    document.body.classList.remove('ov-alerting');
    clearPrediction();
    clearHatch();
    clearCheckinTimers();
    var ci = document.getElementById('ovCheckin');
    if (ci) { ci.classList.remove('is-in'); ci.hidden = true; }
    /* The snapshot panels (hype bar, ad countdown) come down too. Reset the
       seen flags so the NEXT poll re-applies current standing state from the
       snapshot — a live hype train or ad break reappears on its own, the same
       way the standing game panels do, without replaying anything. */
    clearAdTimer();
    var hp = document.getElementById('ovHype');
    if (hp) hp.hidden = true;
    var ab = document.getElementById('ovAdBreak');
    if (ab) ab.hidden = true;
    seenOverlayState = false;
    predSliceVer = hypeSliceVer = adSliceVer = null;
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

  /* ONE POLL IN FLIGHT. A fixed setInterval fired the next request whether or
     not the last had answered, so on a slow link replies landed out of order
     and an older reply could move the cursor BACKWARDS and replay alerts. Each
     poll now schedules the next only when it settles. A watchdog abandons a
     request that never answers (aborting it where the browser can), counts it
     as a fault, and moves on — a hung fetch must not stop the chain. A reply
     that lands after its watchdog fired is ignored. */
  var POLL_TIMEOUT_MS = 8000;
  var pollTimer = null;

  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }

  function pollFailed() {
    faults++;
    if (faults >= FAULTS_BEFORE_NOTICE) setFault(true);
  }

  function poll() {
    pollTimer = null;
    var url = '/api/overlay/events?key=' + encodeURIComponent(key) +
              (cursor === null ? '' : '&since=' + cursor) +
              /* A muted source — and the desktop monitor — never sends its iid, so
                 electAudioLeader never counts it and the OBS source stays the one
                 true audio leader for the stream. */
              ((audioMuted || isMonitor) ? '' : '&iid=' + encodeURIComponent(overlayIid));

    var settled = false;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var watchdog = setTimeout(function () {
      if (settled) return;
      settled = true;
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
      pollFailed();
      schedulePoll(POLL_MS);
    }, POLL_TIMEOUT_MS);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      schedulePoll(POLL_MS);
    }

    var sentAt = Date.now();
    fetch(url, ctrl ? { cache: 'no-store', signal: ctrl.signal } : { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (settled) return;            // the watchdog already gave up on this one
        faults = 0;
        setFault(false);
        noteServerClock(data.serverNow, sentAt, Date.now());

        /* Alert volume, set from the control panel. Sent on every poll so a
           change reaches the open overlay within a second, no reload. The
           desktop monitor ignores it — it drives playback from its OWN local
           volume so changing the stream's master slider never touches it. */
        if (!isMonitor && typeof data.alertVolume === 'number') {
          alertVolume = Math.max(0, Math.min(1, data.alertVolume / 100));
        }
        /* One overlay plays the check-in chime. The server picks it; every
           other open source stays silent so the stream doesn't hear it two or
           three times. Absent field (older server) leaves us free to play. The
           monitor never yields — it forces isAudioLeader true and skips this so
           it always plays locally, while staying out of the election entirely
           (it sends no iid, so it is never chosen as the stream's leader). */
        if (!isMonitor && typeof data.audioLeader === 'string') {
          isAudioLeader = (data.audioLeader === overlayIid);
        }
        /* Hatch stings on/off, set from the bot panel; reaches the overlay
           within a poll, no reload. */
        if (typeof data.hatchSound === 'boolean') {
          hatchSoundOn = data.hatchSound;
        }
        /* Per-alert custom sounds, set from the dashboard; reaches the overlay
           within a poll, no reload. Absent field (older server) leaves the
           default sting in place. */
        if (data.alertSounds && typeof data.alertSounds === 'object') {
          alertSoundCfg = data.alertSounds;
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

        /* PANIC COMMAND. A moderator's Clear/Skip from the dashboard, carried on
           this same feed. Like the reload token, the FIRST sighting is only
           recorded — a command issued before this source opened is never
           replayed onto it — and each later change is applied exactly once. */
        var ctl = data.control || null;
        var ctlToken = ctl && ctl.token ? String(ctl.token) : '';
        if (controlToken === undefined) {
          controlToken = ctlToken;
        } else if (ctlToken && ctlToken !== controlToken) {
          controlToken = ctlToken;
          if (ctl.cmd === 'clear') clearAll();
          else if (ctl.cmd === 'skip') skipCurrent();
        }

        /* STANDING STATE. Applied every poll, including the first-run path below
           that returns before any alert is processed — so a freshly opened
           source rehydrates its prediction/hype/ad panels immediately, without
           replaying (see applyOverlayState). */
        applyOverlayState(data.overlayState);

        /* WHAT'S ON STREAM. Publish the one pointer to the game panels every
           poll, including the first-run path that returns just below — so a
           freshly opened source shows the live game at once. `whatsOn` is absent
           on an older server; publish null then (nothing on) rather than leaving
           the panels to poll forever. */
        if (window.PhamWhatsOn) window.PhamWhatsOn._set(data.whatsOn || null);

        /* No stored position — a genuinely first run. Take the current
           place and show nothing, or every alert since the server started
           would arrive at once. */
        var latest = Number(data.latestSeq) || 0;
        if (cursor === null) {
          cursor = latest;
          rememberCursor(cursor);
          return;
        }

        /* THE FEED WAS RESET. The server's position is behind ours — its store
           was wiped or restarted, and its seq numbering started over. Waiting
           for it to climb past our old cursor would silently swallow every
           alert until then. Restart from the beginning of the new feed; the
           replay window still keeps anything stale off air. */
        if (latest < cursor) {
          cursor = 0;
          return;
        }

        if (data.events && data.events.length) {
          var now = serverTime();
          var from = cursor;
          for (var i = 0; i < data.events.length; i++) {
            var ev = data.events[i];
            /* Already played (or counted as seen). The cursor only ever moves
               forward, and anything at or behind it is never shown twice. */
            if (!(Number(ev.seq) > from)) continue;
            /* Anything older than the replay window is counted as seen and
               dropped. This is what stops a resumed cursor from replaying a
               backlog after the overlay has been closed for hours. Compared on
               the SERVER clock (ev.at is server time), so a streaming PC whose
               clock runs fast or slow neither drops live alerts nor replays
               stale ones. */
            if (ev.at && now - ev.at > MAX_REPLAY_MS) continue;
            /* The check-in nudge is not a stage alert — show it in the corner
               directly, off the queue, so it never delays or is delayed by a
               sub/raid card. */
            if (ev.type === 'pham-checkin') { showCheckinReminder(ev); continue; }
            /* The hatch has its own movable panel and plays off the queue, so a
               big reveal never blocks a sub/raid card and vice versa. */
            if (ev.type === 'dino-hatch') { showHatch(ev); continue; }
            /* The egg-drop clip plays in its own reused corner <video>, off the
               queue, so a 3-second flourish never delays a sub/raid card. */
            if (ev.type === 'egg-video') { showEggVideo(ev); continue; }
            /* The prediction panel is now driven from the overlay_state snapshot
               (applyOverlayState), not the alert queue — so a reloaded source
               rehydrates it. Any 'prediction' event still in the feed is skipped
               here rather than enqueued. */
            if (ev.type === 'prediction') continue;
            enqueue(ev);
          }
        }

        /* Monotonic: only ever forward, and only written when it moves.
           Advanced BEFORE pump(), so a card that throws while rendering can
           never leave the batch unacknowledged and replay it next poll. */
        if (latest > cursor) {
          cursor = latest;
          rememberCursor(cursor);
        }
        pump();
      })
      .catch(function () {
        if (settled) return;
        pollFailed();
      })
      .then(finish);
  }

  /* PERIODIC IDLE SELF-RELOAD.
     OBS holds this page open for an entire marathon, and CEF's GPU/compositor
     memory creeps over many hours. Reloading the source flushes it — the alert
     cursor lives in localStorage, so a reload never loses or replays an alert.

     It only fires during a genuinely IDLE moment: no alert in flight, no
     standing game panel up, no hatch/check-in, and the feed connected — so
     nothing on stream is ever cut off. If the overlay is never idle (a game is
     always up), it simply waits; better to grow a little than to cut a game.

     Default every 3h; tune with ?reloadHours=N, disable with ?reloadHours=0. */
  var RELOAD_AFTER_MS = 3 * 60 * 60 * 1000;
  var reloadHoursParam = parseFloat(new URLSearchParams(location.search).get('reloadHours'));
  if (Number.isFinite(reloadHoursParam)) RELOAD_AFTER_MS = reloadHoursParam * 3600000;
  var RELOAD_CHECK_MS = 60000;
  var loadedAt = Date.now();
  var IDLE_PANEL_IDS = ['ovScramble', 'ovMaze', 'ovMtg', 'ovRaid', 'ovBingo', 'ovMc', 'ovCheckin', 'ovHatch', 'ovEggVideo', 'ovPrediction', 'ovHype', 'ovAdBreak'];

  /* A panel is down if its poller hid it OR a layout preset switched it off
     (overlay-apply-layout.js forces style.display = 'none' and leaves the
     `hidden` attribute to the game). Either way nothing is on screen, so it
     must not hold off the idle reload. */
  function panelIsDown(el) {
    return el.hidden || el.style.display === 'none';
  }

  function overlayIsIdle() {
    if (showing || queue.length) return false;
    if (document.body.classList.contains('ov-alerting')) return false;
    for (var i = 0; i < IDLE_PANEL_IDS.length; i++) {
      var el = document.getElementById(IDLE_PANEL_IDS[i]);
      if (el && !panelIsDown(el)) return false;
    }
    return true;
  }

  function selfReload() {
    /* Cache-bust like the command reload does, and preserve key/muted/etc. */
    var u = new URL(location.href);
    u.searchParams.set('sr', String(Date.now()));
    location.replace(u.toString());
  }

  if (RELOAD_AFTER_MS > 0) {
    setInterval(function () {
      if (Date.now() - loadedAt < RELOAD_AFTER_MS) return;
      if (faults > 0) return;         // don't reload into a disconnected server
      if (!overlayIsIdle()) return;   // wait for a quiet moment
      selfReload();
    }, RELOAD_CHECK_MS);
  }

  /* ── Monitor control bar ────────────────────────────────────────────────
     Built ONLY in monitor mode, so an OBS source never gets these nodes and the
     stream is never at risk of capturing them. A small control strip the
     streamer uses to set the monitor's own volume + mute; both persist in
     localStorage and drive only the LOCAL alertVolume/audioMuted, never the
     stream's master slider. Styled with the shared tokens (variables.css is
     linked on the page) — no box-shadow, no side-border rails, no blur. */
  function persistMonitor() {
    try { window.localStorage.setItem(MONITOR_VOL_KEY, String(monitorVolume)); } catch (e) {}
    try { window.localStorage.setItem(MONITOR_MUTE_KEY, audioMuted ? '1' : '0'); } catch (e) {}
  }
  function buildMonitorBar() {
    if (document.getElementById('ovMonitorBar')) return;

    var style = document.createElement('style');
    style.textContent =
      '.ov-monitor-bar{position:fixed;left:16px;bottom:16px;z-index:9999;' +
      'display:flex;align-items:center;gap:12px;' +
      'padding:10px 14px;border-radius:8px;' +
      'background:var(--black,#0a0a0a);border:1px solid var(--red,#FF0000);' +
      'font-family:var(--font-ui,system-ui);font-size:14px;color:var(--white,#fff);}' +
      '.ov-monitor-bar .ov-mon-dot{width:9px;height:9px;border-radius:50%;' +
      'background:var(--red,#FF0000);}' +
      '.ov-monitor-bar.is-muted .ov-mon-dot{background:var(--gray-500,#888);}' +
      '.ov-monitor-bar label{text-transform:uppercase;letter-spacing:.06em;' +
      'font-size:12px;color:var(--text-muted,#aaa);}' +
      '.ov-monitor-bar input[type=range]{width:140px;accent-color:var(--red,#FF0000);cursor:pointer;}' +
      '.ov-monitor-bar button{font-family:inherit;font-size:13px;cursor:pointer;' +
      'padding:6px 12px;border-radius:6px;color:#fff;' +
      'background:var(--red,#FF0000);border:1px solid var(--red,#FF0000);}' +
      '.ov-monitor-bar.is-muted button{background:transparent;color:var(--white,#fff);' +
      'border:1px solid var(--border,#333);}' +
      '.ov-monitor-bar .ov-mon-val{min-width:38px;text-align:right;' +
      'font-variant-numeric:tabular-nums;color:var(--text-muted,#aaa);}';
    document.head.appendChild(style);

    var bar = document.createElement('div');
    bar.className = 'ov-monitor-bar' + (audioMuted ? ' is-muted' : '');
    bar.id = 'ovMonitorBar';

    var dot = document.createElement('span');
    dot.className = 'ov-mon-dot';

    var title = document.createElement('label');
    title.textContent = 'Audio Monitor';

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(Math.round(monitorVolume * 100));

    var val = document.createElement('span');
    val.className = 'ov-mon-val';
    val.textContent = Math.round(monitorVolume * 100) + '%';

    var muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.textContent = audioMuted ? 'Unmute' : 'Mute';

    slider.addEventListener('input', function () {
      monitorVolume = Math.max(0, Math.min(1, (Number(slider.value) || 0) / 100));
      alertVolume = monitorVolume;             // drives every local playback path
      val.textContent = Math.round(monitorVolume * 100) + '%';
      persistMonitor();
    });

    muteBtn.addEventListener('click', function () {
      audioMuted = !audioMuted;                // reuses the existing audio gate
      muteBtn.textContent = audioMuted ? 'Unmute' : 'Mute';
      bar.classList.toggle('is-muted', audioMuted);
      persistMonitor();
    });

    bar.appendChild(dot);
    bar.appendChild(title);
    bar.appendChild(slider);
    bar.appendChild(val);
    bar.appendChild(muteBtn);
    document.body.appendChild(bar);
  }

  if (isMonitor) buildMonitorBar();

  poll();
})();
