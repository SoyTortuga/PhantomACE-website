/* ══════════════════════════════════════════════
   OVERLAY SAMPLE CONTENT — shared by layout mode and the layout editor.

   One source of plausible panel content, so the offline preview
   (/overlay?layout=1) and the drag-to-arrange editor show the SAME thing,
   and a panel sized in one is sized identically in the other. Writes only
   into panel DOM the caller already owns; fetches nothing.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  /* Every movable panel, with the label the editor shows on its handle and
     the id the saved layout keys on. Order is z-order in the editor. */
  var PANELS = [
    { id: 'ovStage', label: 'Alerts', holds: [
      'One alert at a time, queued — never stacked',
      'New subscriber · gift subs · raid',
      'Hype train level-up',
      'Code, item & egg drops (incl. maze rewards)',
      'MTGBBB rare & mythic PULLS show here, not in the MTGBBB panel',
      'MTGBBB bingo & blackout',
    ] },
    { id: 'ovScramble', label: 'Scramble', holds: [
      'Round number & countdown clock',
      'The scrambled word as tiles',
      'Category · how many have solved it',
      'Top 3 scores',
    ] },
    { id: 'ovMaze', label: 'Chat Maze', holds: [
      'Level & maze size',
      'The board — fogged to what chat has revealed',
      'Move count & 🦴 bones collected',
      'Direction pad — lights up on each chat command',
      'Last few inputs with who sent them',
    ] },
    { id: 'ovMtg', label: 'MTGBBB', holds: [
      'Set name & pack progress bar',
      'Player count',
      'Top 3 players by lines',
      '(individual pulls appear in the Alerts window)',
    ] },
    { id: 'ovMc', label: 'Mana Clash', holds: [
      'Round & FINAL ROUND flag',
      'Target score (goal)',
      'Leader progress bar',
      'Standings',
    ] },
  ];

  function $(id) { return document.getElementById(id); }
  function show(id) { var el = $(id); if (el) el.hidden = false; }
  function set(id, t) { var el = $(id); if (el) el.textContent = t; }

  function alertCard() {
    var stage = $('ovStage');
    if (!stage) return;
    document.body.classList.add('ov-alerting');
    stage.innerHTML = '';
    var card = document.createElement('div');
    card.className = 'ov-alert';
    card.dataset.type = 'sub';
    card.dataset.rarity = 'mythic';
    var img = document.createElement('img');
    img.className = 'ov-mark is-fallback';
    img.alt = '';
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
      '<div class="ov-chips"><span class="ov-chip">Tier 1</span><span class="ov-chip">×10</span></div>';
    card.appendChild(img);
    card.appendChild(text);
    stage.appendChild(card);
  }

  function scramble() {
    show('ovScramble');
    set('ovScRound', 'Round 3'); set('ovScClock', '0:18');
    set('ovScCategory', 'MTG Cards'); set('ovScAnswered', '2 solved');
    var word = $('ovScWord');
    if (word) {
      word.innerHTML = '';
      'LIGHTNING'.split('').forEach(function (ch) {
        var t = document.createElement('span');
        t.className = 'ov-sc-tile'; t.textContent = ch; word.appendChild(t);
      });
    }
    var s = $('ovScScores');
    if (s) s.innerHTML =
      '<li><span>chatterOne</span><span>3</span></li>' +
      '<li><span>chatterTwo</span><span>2</span></li>' +
      '<li><span>chatterThree</span><span>1</span></li>';
  }

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
        rover.style.width = d + 'px'; rover.style.height = d + 'px';
        var cx = 6 + cell + cell / 2, cy = 6 + cell + cell / 2;
        rover.style.transform = 'translate(' + (cx - d / 2) + 'px,' + (cy - d / 2) + 'px)';
      }
    }
    var pad = $('ovMazePad');
    if (pad) { var up = pad.querySelector('[data-dir="up"]'); if (up) up.classList.add('lit'); }
    var r = $('ovMazeRecent');
    if (r) r.innerHTML =
      '<li>up — viewerA</li><li>left — viewerB</li><li>up (bonk) — viewerC</li><li>right — viewerD</li>';
  }

  function mtg() {
    show('ovMtg');
    set('ovMtgSet', 'Bloomburrow'); set('ovMtgPack', '14 / 36 packs'); set('ovMtgPlayers', '27 players');
    var bar = $('ovMtgBar'); if (bar) bar.style.width = '39%';
    var top = $('ovMtgTop');
    if (top) top.innerHTML =
      '<li><span>topPlayer</span><span>4 lines</span></li>' +
      '<li><span>secondPlace</span><span>3 lines</span></li>' +
      '<li><span>thirdPlace</span><span>2 lines</span></li>';
  }

  function manaClash() {
    show('ovMc');
    set('ovMcRound', 'Round 4'); set('ovMcNote', 'FINAL ROUND'); set('ovMcGoal', '5,000');
    var bar = $('ovMcBar'); if (bar) bar.style.width = '72%';
    var list = $('ovMcList');
    if (list) list.innerHTML =
      '<li><span>duelistOne</span><span>4,100</span></li>' +
      '<li><span>duelistTwo</span><span>3,600</span></li>' +
      '<li><span>duelistThree</span><span>2,900</span></li>';
  }

  function fillAll() { alertCard(); scramble(); maze(); mtg(); manaClash(); }

  window.OverlaySamples = { PANELS: PANELS, fillAll: fillAll };
})();
