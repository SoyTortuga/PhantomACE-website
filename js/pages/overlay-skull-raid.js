/* ══════════════════════════════════════════════
   SKULL CLICKER RAID BOSS — the overlay panel.

   A thin, tall column: the Undead Executioner, a vertical health bar that
   drains as the site clicks it down, its minions, and the top strikers. It
   finds its own boss (the server holds one at a time), so OBS never needs a
   code. Hidden unless a boss is live.

   The reaper is a real animation: the server sends counters (attack, skill,
   summon) and this plays the matching sprite once, then falls back to idle —
   so heals, guards and summons are visible, not just numbers moving. Frames
   are stepped in JS rather than CSS keyframes so one-shots and loops share
   one path and nothing has to be regenerated per animation.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS = 2000;
  var IDLE_POLL_MS = 8000;
  var FPS_MS = 110;                 // per sprite frame
  var ART = '/games/skull-clicker/assets/raid/';

  var BOSS = {                      // strip -> frame count (single-row, 100px)
    idle: 5, idle2: 8, attack: 18, skill: 12, summon: 8, death: 20,
  };
  var MINI = { 'minion-appear': 6, 'minion-idle': 4, 'minion-death': 6 };

  var panel = document.getElementById('ovRaid');
  if (!panel) return;
  if (new URLSearchParams(location.search).get('layout')) return;   // layout mode fills panels itself

  var artEl = document.getElementById('ovRaidArt');
  var nameEl = document.getElementById('ovRaidName');
  var timerEl = document.getElementById('ovRaidTimer');
  var pctEl = document.getElementById('ovRaidPct');
  var barEl = document.getElementById('ovRaidBar');
  var trackEl = barEl ? barEl.parentElement : null;
  var hpEl = document.getElementById('ovRaidHp');
  var minionsEl = document.getElementById('ovRaidMinions');
  var miniEl = document.getElementById('ovRaidMini');
  var miniBarEl = document.getElementById('ovRaidMiniBar');
  var topEl = document.getElementById('ovRaidTop');

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function fmt(n) {
    n = Math.floor(n || 0);
    if (n < 1000) return String(n);
    var u = ['', 'K', 'M', 'B', 'T', 'Qa'], t = Math.min(Math.floor(Math.log10(n) / 3), u.length - 1);
    var s = n / Math.pow(10, t * 3);
    return (s < 10 ? s.toFixed(1) : Math.round(s)) + u[t];
  }
  function mmss(ms) { var s = Math.max(0, Math.floor(ms / 1000)); var m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); }

  /* ── One little sprite animator, reused for the boss and the minion ── */
  function makeAnimator(el, size, counts) {
    var st = { name: null, frame: 0, frames: 1, loop: true, onEnd: null };
    function play(name, loop, onEnd) {
      if (!counts[name]) name = counts.idle ? 'idle' : Object.keys(counts)[0];
      st = { name: name, frame: 0, frames: counts[name], loop: loop, onEnd: onEnd || null };
      apply();
    }
    function apply() {
      el.style.backgroundImage = 'url(' + ART + st.name + '.png)';
      el.style.backgroundSize = (st.frames * size) + 'px ' + size + 'px';
      el.style.backgroundPositionX = '-' + (st.frame * size) + 'px';
    }
    function tick() {
      st.frame++;
      if (st.frame >= st.frames) {
        if (st.loop) { st.frame = 0; }
        else { st.frame = st.frames - 1; apply(); var cb = st.onEnd; st.onEnd = null; if (cb) cb(); return; }
      }
      apply();
    }
    return { play: play, tick: tick, current: function () { return st.name; }, busy: function () { return !st.loop; } };
  }

  var boss = makeAnimator(artEl, 100, BOSS);
  var minion = miniEl ? makeAnimator(miniEl, 50, MINI) : null;
  boss.play('idle', true);
  setInterval(function () { boss.tick(); if (minion && minionsShown) minion.tick(); }, FPS_MS);

  /* ── State ── */
  var seen = { attackCount: 0, skillCount: 0, summonCount: 0, minionDeaths: 0, status: null };
  var minionsShown = false;
  var timer = null;

  function bossIdle() { boss.play(Math.random() < 0.4 ? 'idle2' : 'idle', true); }

  function drive(s) {
    // Death outranks everything and stops the loop.
    if (s.status === 'defeated' && seen.status !== 'defeated') { boss.play('death', false, function () {}); return; }
    if (s.status !== 'active') return;
    // One-shots, highest-priority first; each returns to idle when done.
    if (s.summonCount > seen.summonCount) { if (minion) minion.play('minion-appear', false, function () { minion.play('minion-idle', true); }); boss.play('summon', false, bossIdle); return; }
    if (s.skillCount > seen.skillCount) { boss.play('skill', false, bossIdle); return; }
    if (s.attackCount > seen.attackCount) { boss.play('attack', false, bossIdle); return; }
    if (s.minionDeaths > seen.minionDeaths && minion) { minion.play('minion-death', false, function () {}); }
    if (!boss.busy() && boss.current() !== 'idle' && boss.current() !== 'idle2') bossIdle();
  }

  function render(s) {
    nameEl.textContent = s.name || 'Undead Executioner';
    var pct = s.maxHp > 0 ? Math.max(0, Math.min(100, (s.hp / s.maxHp) * 100)) : 0;
    barEl.style.height = pct + '%';
    pctEl.textContent = Math.ceil(pct) + '%';
    hpEl.textContent = fmt(s.hp) + ' / ' + fmt(s.maxHp);
    timerEl.textContent = s.endsAt ? mmss(s.endsAt - Date.now()) : '';

    var shielded = !!s.shielded;
    artEl.classList.toggle('shielded', shielded);
    if (trackEl) trackEl.classList.toggle('shielded', shielded);

    var m = s.minions || { hp: 0, maxHp: 0 };
    minionsShown = m.hp > 0;
    minionsEl.classList.toggle('empty', !minionsShown);
    if (minionsShown && miniBarEl) miniBarEl.style.width = Math.max(0, Math.min(100, (m.hp / (m.maxHp || 1)) * 100)) + '%';

    var top = Array.isArray(s.top) ? s.top.slice(0, 3) : [];
    topEl.innerHTML = top.length
      ? top.map(function (t) { return '<li>' + esc(t.name) + ' · ' + fmt(t.dmg) + '</li>'; }).join('')
      : '<li style="color:#6f6f6f">No strikes yet</li>';
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }

  function poll() {
    fetch('/api/skull-raid', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s || s.status !== 'active' && s.status !== 'defeated') {
          panel.hidden = true;
          seen = { attackCount: 0, skillCount: 0, summonCount: 0, minionDeaths: 0, status: null };
          schedule(IDLE_POLL_MS);
          return;
        }
        panel.hidden = false;
        drive(s);
        render(s);
        seen = { attackCount: s.attackCount, skillCount: s.skillCount, summonCount: s.summonCount, minionDeaths: s.minionDeaths, status: s.status };
        // A defeated boss lingers a moment so the death plays, then clears.
        schedule(s.status === 'defeated' ? IDLE_POLL_MS : POLL_MS);
      })
      .catch(function () { schedule(IDLE_POLL_MS); });
  }

  poll();
})();
