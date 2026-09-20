/* ══════════════════════════════════════════════
   OVERLAY LAYOUT MODE — arrange the stream overlay with nothing running.

     /overlay?layout=1

   Every panel the overlay can ever show, on screen at once with sample
   content, so OBS can be positioned without starting a single game — and
   with NO NETWORK, so it works offline while the rig is off. The live
   pollers each stand down when ?layout=1 is present (see the bail near the
   top of every overlay-*.js), so this script owns the screen alone and
   nothing it places gets hidden a second later.

   It renders the REAL panels with plausible data rather than mock boxes,
   so a box positioned here is the box that appears live: same widths, same
   corners, same fonts. A caption names the mode so a layout overlay can
   never be mistaken for a live one and left on air.

   Purely additive: it runs only under the flag, writes nothing, fetches
   nothing. When the flag is absent this file does nothing at all.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  if (!new URLSearchParams(location.search).get('layout')) return;

  var $ = function (id) { return document.getElementById(id); };
  function show(id) { var el = $(id); if (el) el.hidden = false; }
  function set(id, text) { var el = $(id); if (el) el.textContent = text; }

  /* ── A sample alert in the stage ─────────────────────────────────── */
  function alertCard() {
    var stage = $('ovStage');
    if (!stage) return;
    document.body.classList.add('ov-alerting');
    var card = document.createElement('div');
    card.className = 'ov-alert';
    card.dataset.type = 'sub';
    card.dataset.rarity = 'mythic';

    var img = document.createElement('img');
    img.className = 'ov-mark is-fallback';
    img.alt = '';
    /* A data-URI diamond, so the card needs no file and no server. */
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">' +
      '<rect width="80" height="80" rx="10" fill="#1a1a1a" stroke="#ff0000" stroke-width="2"/>' +
      '<text x="40" y="52" font-size="34" text-anchor="middle" fill="#ff0000">◆</text></svg>');

    var text = document.createElement('div');
    text.className = 'ov-text';
    text.innerHTML =
      '<span class="ov-kind">GIFT SUBS</span>' +
      '<p class="ov-title">SampleViewer gifted 10 subs!</p>' +
      '<p class="ov-sub">to the PhantomACE community</p>' +
      '<div class="ov-chips"><span class="ov-chip">Tier 1</span>' +
      '<span class="ov-chip">×10</span></div>';

    card.appendChild(img);
    card.appendChild(text);
    stage.appendChild(card);
  }

  /* ── Scramble ────────────────────────────────────────────────────── */
  function scramble() {
    show('ovScramble');
    set('ovScRound', 'Round 3');
    set('ovScClock', '0:18');
    set('ovScCategory', 'MTG Cards');
    set('ovScAnswered', '2 solved');
    var word = $('ovScWord');
    if (word) {
      word.innerHTML = '';
      'LIGHTNING'.split('').forEach(function (ch) {
        var t = document.createElement('span');
        t.className = 'ov-sc-tile';
        t.textContent = ch;
        word.appendChild(t);
      });
    }
    var scores = $('ovScScores');
    if (scores) {
      scores.innerHTML =
        '<li><span>chatterOne</span><span>3</span></li>' +
        '<li><span>chatterTwo</span><span>2</span></li>' +
        '<li><span>chatterThree</span><span>1</span></li>';
    }
  }

  /* ── Chat Maze: a real little board ──────────────────────────────── */
  function maze() {
    show('ovMaze');
    set('ovMazeTitle', '🧭 MAZE 5 · 8×8');
    set('ovMazeStats', '23 moves · 🦴 1/2');
    var board = $('ovMazeBoard');
    if (board) {
      var size = 8, cell = Math.floor(300 / size);
      board.style.gridTemplateColumns = 'repeat(' + size + ', ' + cell + 'px)';
      board.style.gridAutoRows = cell + 'px';
      var html = '';
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          /* Fog sample: the top-left region lit, the rest dark, one bone
             and the ladder placed so both marks show. */
          var lit = (x <= 3 && y <= 3);
          var cls = 'cell' + (lit ? ' n e' : ' dark');
          var mark = '';
          if (x === 3 && y === 1) mark = '<span class="mark">🦴</span>';
          if (x === size - 1 && y === size - 1) { cls = 'cell'; mark = '<span class="mark">🪜</span>'; }
          html += '<div class="' + cls + '">' + mark + '</div>';
        }
      }
      html += '<div class="rover" id="ovLayoutRover"></div>';
      board.innerHTML = html;
      var rover = $('ovLayoutRover');
      if (rover) {
        var d = Math.round(cell * 0.55);
        rover.style.width = d + 'px';
        rover.style.height = d + 'px';
        var cx = 6 + 1 * cell + cell / 2, cy = 6 + 1 * cell + cell / 2;
        rover.style.transform = 'translate(' + (cx - d / 2) + 'px,' + (cy - d / 2) + 'px)';
      }
    }
    var pad = $('ovMazePad');
    if (pad) {
      var up = pad.querySelector('[data-dir="up"]');
      if (up) up.classList.add('lit');
    }
    var recent = $('ovMazeRecent');
    if (recent) {
      recent.innerHTML =
        '<li>up — viewerA</li><li>left — viewerB</li>' +
        '<li>up (bonk) — viewerC</li><li>right — viewerD</li>';
    }
  }

  /* ── MTGBBB ──────────────────────────────────────────────────────── */
  function mtg() {
    show('ovMtg');
    set('ovMtgSet', 'Bloomburrow');
    set('ovMtgPack', '14 / 36 packs');
    set('ovMtgPlayers', '27 players');
    var bar = $('ovMtgBar'); if (bar) bar.style.width = '39%';
    var top = $('ovMtgTop');
    if (top) {
      top.innerHTML =
        '<li><span>topPlayer</span><span>4 lines</span></li>' +
        '<li><span>secondPlace</span><span>3 lines</span></li>' +
        '<li><span>thirdPlace</span><span>2 lines</span></li>';
    }
  }

  /* ── Mana Clash ──────────────────────────────────────────────────── */
  function manaClash() {
    show('ovMc');
    set('ovMcRound', 'Round 4');
    set('ovMcNote', 'FINAL ROUND');
    set('ovMcGoal', '5,000');
    var bar = $('ovMcBar'); if (bar) bar.style.width = '72%';
    var list = $('ovMcList');
    if (list) {
      list.innerHTML =
        '<li><span>duelistOne</span><span>4,100</span></li>' +
        '<li><span>duelistTwo</span><span>3,600</span></li>' +
        '<li><span>duelistThree</span><span>2,900</span></li>';
    }
  }

  /* ── A caption, so a layout overlay never gets left on air ───────── */
  function caption() {
    var tag = document.createElement('div');
    tag.textContent = 'LAYOUT MODE — sample data, not live. Remove ?layout=1 for the real overlay.';
    tag.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;' +
      'background:rgba(0,0,0,0.85);color:#ffcc44;border:1px solid #ff0000;' +
      'border-radius:6px;padding:6px 14px;font:700 12px system-ui,sans-serif;' +
      'letter-spacing:0.05em;pointer-events:none;';
    document.body.appendChild(tag);
  }

  function run() {
    caption();
    alertCard();
    scramble();
    maze();
    mtg();
    manaClash();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
