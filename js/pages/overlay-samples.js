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
      'Follows & cheers (Twitch-native)',
      'Hype train level-up',
      'Code, item & egg drops (incl. maze rewards)',
      'Giveaway winner reel & the customizable Wheel spin',
      'MTGBBB rare & mythic PULLS show here, not in the MTGBBB panel',
      'MTGBBB bingo & blackout',
      'Commander Bingo calls & wins',
    ] },
    { id: 'ovHatch', label: 'Dino Hatch', holds: [
      'The dino hatch minigame reveal — its own panel',
      'Single portrait, or a gift-bomb reel that scrolls the clutch',
      'Transparent (no card) — a different size than the Alerts window',
      'Shows on a hatch, then hides — place it clear of your other panels',
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
      'The join URL & room code, so viewers can join mid-box',
      '(individual pulls appear in the Alerts window)',
    ] },
    { id: 'ovRaid', label: 'Raid Boss', holds: [
      'The boss (animated) & its name',
      'A tall vertical health bar',
      'Minions when summoned',
      'Top strikers',
    ] },
    { id: 'ovBingo', label: 'Commander Bingo', holds: [
      'Call progress bar (squares of 68)',
      'Player count',
      'Winners board (name & prize rarity)',
      '(calls & wins appear in the Alerts window)',
    ] },
    { id: 'ovMc', label: 'Mana Clash', holds: [
      'Round & FINAL ROUND flag',
      'Target score (goal)',
      'Leader progress bar',
      'Standings',
    ] },
    { id: 'ovCheckin', label: 'Check-In', holds: [
      'The reaper raising a "Pham-Check-In" sign',
      'Fires on the button (with sound) or the timer (silent)',
      'Shows briefly, then hides — place it where viewers will see it',
    ] },
    { id: 'ovPrediction', label: 'Prediction', holds: [
      'Prediction title & a countdown to lock',
      'Each outcome: a live bar with points, voters and %',
      'ACTIVE → LOCKED → the winner highlighted, then hides',
      'Driven by Twitch channel-point prediction events',
    ] },
    /* ── Stream night modes ──────────────────────────────────────────────
       Each of these is a standing panel that shows while its event runs and
       clears when it ends. They shipped positioned by their own CSS default
       and were never listed here, so the editor could not move them — which
       meant several landed on top of each other mid-stream. */
    { id: 'ovTithe', label: 'Bone Tithe', holds: [
      'Goal progress bar & percentage',
      'Bones tithed against the goal, and time left',
      'Top contributors',
      'Shows while a tithe runs, then clears',
    ] },
    { id: 'ovVsc', label: 'Streamer vs Chat', holds: [
      'The streamer’s frozen six-dice hand',
      'Chat’s best six, drawn from the pooled !clash rolls',
      'Both scores, the chatter count & a countdown',
      'Resolves, reveals the winner, then clears',
    ] },
    { id: 'ovWind', label: 'Wind Night', holds: [
      'Current wind direction & strength',
      'A bar that swings as chat steers it',
      'Chat drives it with !wind left / !wind right',
    ] },
    { id: 'ovSafari', label: 'Dino Safari', holds: [
      'The wild dino’s portrait, name & rarity',
      'Catch countdown & how many have typed !catch',
      'Switches to the winner once caught, then hides',
    ] },
    { id: 'ovBracket', label: 'Bracket Night', holds: [
      'The single-elimination bracket, round by round',
      'Winners highlighted; the live match outlined',
      'Champion banner when the final resolves',
    ] },
    { id: 'ovMtgGuess', label: 'Guess the Rare', holds: [
      'Chat’s guess window during an MTGBBB box crack',
      'The pack number, a countdown, and how many have called it',
      'Then the rare that landed and who called it',
      'Opens when the host clicks the pack counter forward',
    ] },
    { id: 'ovR6Draft', label: 'Siege Draft', holds: [
      'Chat voting the operator he has to play',
      'A live tally, leader first, bars against the leader',
      'Then the locked pick while he loads in',
      'Attack and defence are separate drafts',
    ] },
  ];

  function $(id) { return document.getElementById(id); }
  function show(id) { var el = $(id); if (el) el.hidden = false; }
  function set(id, t) { var el = $(id); if (el) el.textContent = t; }

  function alertCard() {
    var stage = $('ovStage');
    if (!stage) return;
    /* Deliberately NOT setting `ov-alerting`. The live overlay sets it so the
       standing panels duck out of a card's way, but in layout mode every panel
       is up at once to be arranged — the duck would leave the Mana Clash, VS
       Chat, Wind, Safari and Bracket panels at 22% opacity and shifted off
       their real spots, which is exactly what you must not be dragging. */
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
    show('ovMtgJoin'); set('ovMtgCode', 'BLOOM');
  }

  function raidBoss() {
    show('ovRaid');
    set('ovRaidName', 'Undead Executioner');
    set('ovRaidTimer', '11:20');
    set('ovRaidPct', '64%');
    set('ovRaidHp', '3.2K / 5.0K');
    var art = $('ovRaidArt');
    if (art) {
      art.style.backgroundImage = 'url(/games/skull-clicker/assets/raid/idle.png)';
      art.style.backgroundSize = '400px 100px';   // idle.png is 4 frames — see js/pages/overlay-skull-raid.js's BOSS.idle
      art.style.backgroundPositionX = '0';
    }
    var bar = $('ovRaidBar'); if (bar) bar.style.height = '64%';
    var split = $('ovRaidSplit');
    if (split) {
      split.hidden = false;
      var sc = $('ovRaidSplitChat'); if (sc) sc.style.width = '38%';
      var ss = $('ovRaidSplitSite'); if (ss) ss.style.width = '62%';
      set('ovRaidChatDmg', '1.2K');
      set('ovRaidSiteDmg', '2.0K');
    }
    var mins = $('ovRaidMinions'); if (mins) mins.classList.add('empty');
    var top = $('ovRaidTop');
    if (top) top.innerHTML = '<li>chatKnight · 1.2K</li><li>boneMob · 800</li><li>freezy · 540</li>';
  }

  function bingo() {
    show('ovBingo');
    set('ovBingoProgress', '19 / 68 called');
    set('ovBingoPlayers', '12 players');
    var bar = $('ovBingoBar'); if (bar) bar.style.width = '28%';
    var cl = $('ovBingoCallLabel'); if (cl) cl.hidden = false;
    set('ovBingoMore', '+3');
    var called = $('ovBingoCalled');
    if (called) called.innerHTML =
      '<li>Board wipe played</li>' +
      '<li>Sol Ring on turn 1</li>' +
      '<li>Someone scoops early</li>' +
      '<li>Counterspell cast</li>';
    var wl = $('ovBingoWinLabel'); if (wl) wl.hidden = false;
    var top = $('ovBingoTop');
    if (top) top.innerHTML =
      '<li><span class="ov-bingo-name">firstBingo</span>' +
        '<span class="ov-bingo-rarity" data-rarity="mythic">mythic</span></li>' +
      '<li><span class="ov-bingo-name">secondWinner</span>' +
        '<span class="ov-bingo-rarity" data-rarity="rare">rare</span></li>' +
      '<li><span class="ov-bingo-name">thirdWinner</span>' +
        '<span class="ov-bingo-rarity" data-rarity="uncommon">uncommon</span></li>';
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

  function checkin() {
    show('ovCheckin');
    var el = $('ovCheckin'); if (el) el.classList.add('is-in');   // opaque for the editor
    var sp = $('ovCheckinSprite');
    /* Show the held overhead frame (last of 7, each 87px in the CSS sprite)
       so the editor previews the sign raised, not the idle pose. */
    if (sp) sp.style.backgroundPositionX = '-' + (6 * 87) + 'px';
  }

  function hatch() {
    var panel = $('ovHatch');
    if (!panel) return;
    panel.hidden = false;
    /* A single legendary reveal, laid out exactly as the live one so the editor
       previews the real thing. No .is-hatching, so the reveal (not the egg) is
       what shows. */
    panel.innerHTML =
      '<div class="ov-hatch" data-rarity="legendary">' +
        '<div class="ov-hatch-reveal">' +
          '<img class="ov-hatch-portrait" alt="" src="/games/dino-park/assets/portraits/Quetzalcoatlus.png">' +
          '<div class="ov-hatch-tags">' +
            '<span class="ov-hatch-rchip" data-rarity="legendary">Legendary</span>' +
            '<span class="ov-hatch-mchip" style="--mc:#FF0000">&#10022; PhantomACE</span>' +
          '</div>' +
          '<p class="ov-title">SampleViewer hatched a PhantomACE Legendary Quetzalcoatlus!</p>' +
          '<p class="ov-sub">Straight to their Dino Park</p>' +
        '</div>' +
      '</div>';
  }

  function prediction() {
    show('ovPrediction');
    var p = $('ovPrediction'); if (p) p.dataset.state = 'active';
    set('ovPredLabel', 'Prediction'); set('ovPredTimer', '1:12');
    set('ovPredTitle', 'Will PhantomACE win this game?');
    var list = $('ovPredOutcomes');
    if (list) list.innerHTML =
      '<li class="ov-pred-outcome is-winner">' +
        '<div class="ov-pred-outcome-head"><span class="ov-pred-outcome-name">Yes, easy win</span><span class="ov-pred-outcome-pct">72%</span></div>' +
        '<div class="ov-pred-bar"><i style="width:72%"></i></div>' +
        '<div class="ov-pred-outcome-meta">18,400 pts · 34 voters</div>' +
      '</li>' +
      '<li class="ov-pred-outcome">' +
        '<div class="ov-pred-outcome-head"><span class="ov-pred-outcome-name">No chance</span><span class="ov-pred-outcome-pct">28%</span></div>' +
        '<div class="ov-pred-bar"><i style="width:28%"></i></div>' +
        '<div class="ov-pred-outcome-meta">7,150 pts · 12 voters</div>' +
      '</li>';
  }

  function tithe() {
    show('ovTithe');
    set('ovTitheTitle', 'Bone Tithe');
    set('ovTithePct', '68%');
    var bar = $('ovTitheBar'); if (bar) bar.style.width = '68%';
    set('ovTitheAmt', '3,400 / 5,000 bones');
    set('ovTitheSub', '11m left · !tithe <amount>');
    var top = $('ovTitheTop');
    if (top) top.innerHTML =
      '<li>SampleViewer · 900</li>' +
      '<li>boneHoarder · 640</li>' +
      '<li>graveDigger · 410</li>';
  }

  /* Faces are the mana-die letters, and the die markup matches
     overlay-mana-clash-chat.js exactly (`.ov-vsc-die.d-<F>`, `.is-kept`) so the
     editor previews the real dice, not a stand-in. */
  function vsc() {
    show('ovVsc');
    set('ovVscTimer', '0:12');
    function dice(faces, kept) {
      return faces.map(function (f, i) {
        return '<i class="ov-vsc-die d-' + f + (kept.indexOf(i) !== -1 ? ' is-kept' : '') + '">' + f + '</i>';
      }).join('');
    }
    var s = $('ovVscStreamerDice');
    if (s) s.innerHTML = dice(['R', 'R', 'R', 'G', 'U', 'W'], [0, 1, 2]);
    var c = $('ovVscChatDice');
    if (c) c.innerHTML = dice(['B', 'B', 'B', 'B', 'C', 'G'], [0, 1, 2, 3]);
    set('ovVscStreamerScore', '1,200');
    set('ovVscChatScore', '2,000');
    set('ovVscChatCount', '(214)');
    set('ovVscNote', 'Chat is ahead — type !clash to roll');
  }

  function wind() {
    show('ovWind');
    set('ovWindArrow', '→');
    set('ovWindStrength', '3.4');
    var bar = $('ovWindBar'); if (bar) bar.style.width = '34%';
  }

  function safari() {
    var panel = $('ovSafari');
    if (!panel) return;
    panel.hidden = false;
    panel.classList.remove('is-won');
    panel.setAttribute('data-rarity', 'epic');
    var art = $('ovSafariArt');
    if (art) art.src = '/games/dino-park/assets/portraits/Quetzalcoatlus.png';
    set('ovSafariName', 'Quetzalcoatlus');
    set('ovSafariRarity', 'Spectral · Epic');
    set('ovSafariTimer', '18s');
    var note = $('ovSafariNote');
    if (note) note.innerHTML = 'A wild dino appeared — type <b>!catch</b>';
  }

  /* A mid-tournament bracket: one finished round, the live semifinal outlined,
     and an empty final — the widest the panel ever gets, which is what you want
     to be dragging around. */
  function bracket() {
    show('ovBracket');
    set('ovBracketRound', 'Semifinals');
    function match(a, b, winner, live) {
      function side(name) {
        return '<div class="ov-br-player' + (winner && name === winner ? ' is-win' : '') + '">' + name + '</div>';
      }
      return '<div class="ov-br-match' + (live ? ' is-live' : '') + '">' + side(a) + side(b) + '</div>';
    }
    function col(title, matches, current) {
      return '<div class="ov-br-col' + (current ? ' is-current' : '') + '">' +
        '<div class="ov-br-col-title">' + title + '</div>' + matches + '</div>';
    }
    var body = $('ovBracketBody');
    if (body) body.innerHTML =
      col('Quarterfinals',
        match('SampleViewer', 'boneHoarder', 'SampleViewer') +
        match('graveDigger', 'duelistOne', 'duelistOne'), false) +
      col('Semifinals', match('SampleViewer', 'duelistOne', null, true), true) +
      col('Final', match('—', '—', null, false), false);
    var champ = $('ovBracketChamp'); if (champ) champ.hidden = true;
  }

  /* The resolved state, not the open one: it is the taller of the two, so a
     panel positioned against it never overflows once a pack resolves. */
  function mtgGuess() {
    show('ovMtgGuess');
    set('ovMtgGuessTimer', '');
    var body = $('ovMtgGuessBody');
    if (body) body.innerHTML =
      '<div class="ov-mtgguess-card">Sheoldred, the Apocalypse</div>' +
      '<ol class="ov-mtgguess-winners">' +
        '<li>SampleViewer<span class="ov-mtgguess-paid">+2</span></li>' +
        '<li>boneHoarder<span class="ov-mtgguess-paid">+2</span></li>' +
        '<li class="is-unpaid">graveDigger</li>' +
      '</ol>' +
      '<div class="ov-mtgguess-more">+4 more called it</div>';
    var note = $('ovMtgGuessNote');
    if (note) note.innerHTML = 'Log in at phantomace.tv to collect entries';
  }

  /* The open tally rather than the locked winner: it is the taller state and
     the one that is on screen for the whole prep phase. */
  function r6Draft() {
    show('ovR6Draft');
    set('ovR6DraftSide', 'Attack');
    var panel = $('ovR6Draft');
    if (panel) panel.setAttribute('data-side', 'attack');
    var body = $('ovR6DraftBody');
    if (body) body.innerHTML =
      '<ol class="ov-r6-tally">' +
        '<li class="is-lead"><span class="ov-r6-op">Thatcher</span><span class="ov-r6-votes">31</span><i class="ov-r6-bar" style="width:100%"></i></li>' +
        '<li><span class="ov-r6-op">Ash</span><span class="ov-r6-votes">24</span><i class="ov-r6-bar" style="width:77%"></i></li>' +
        '<li><span class="ov-r6-op">Thermite</span><span class="ov-r6-votes">12</span><i class="ov-r6-bar" style="width:39%"></i></li>' +
        '<li><span class="ov-r6-op">Sledge</span><span class="ov-r6-votes">6</span><i class="ov-r6-bar" style="width:19%"></i></li>' +
      '</ol>';
    var note = $('ovR6DraftNote');
    if (note) note.innerHTML = '73 votes — <b>!op &lt;operator&gt;</b>';
  }

  function fillAll() {
    alertCard(); scramble(); maze(); mtg(); raidBoss(); bingo(); manaClash();
    checkin(); hatch(); prediction(); tithe(); vsc(); wind(); safari(); bracket();
    mtgGuess(); r6Draft();
  }

  window.OverlaySamples = { PANELS: PANELS, fillAll: fillAll };
})();
