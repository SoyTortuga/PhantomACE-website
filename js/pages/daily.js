/* ══════════════════════════════════════════════
   Daily Challenges hub — /daily

   Two reads: /api/daily for the player's picture (progress, streak, each
   challenge's done flag) and /api/daily/rite for today's trivia, played
   inline. Answering the Rite re-reads /api/daily so its tile ticks off and
   the streak/meta update without a reload.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var els = {};
  function $(id) { return document.getElementById(id); }

  function cacheEls() {
    ['dyLoading', 'dyGuest', 'dySummary', 'dyDone', 'dyTotal', 'dyStreak',
     'dyMetaLine', 'dyMetaEntries', 'dyRite', 'dyRiteCat', 'dyRiteDone',
     'dyRiteQ', 'dyRiteOptions', 'dyRiteResult', 'dyRiteLocked', 'dyGrid']
      .forEach(function (id) { els[id] = $(id); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function show(el, on) { if (el) el.hidden = !on; }

  /* ── The hub picture ───────────────────────── */
  function renderSummary(state) {
    show(els.dySummary, true);
    els.dyDone.textContent = state.doneCount;
    els.dyTotal.textContent = state.total;
    els.dyStreak.textContent = state.streak || 0;
    els.dyMetaEntries.textContent = state.metaEntries;
    els.dySummary.classList.toggle('is-clear', !!state.clearedToday);
    if (state.clearedToday) {
      els.dyMetaLine.innerHTML = 'Cleared today &mdash; <strong>+' +
        esc(state.metaEntries) + '</strong> bonus giveaway entries banked. Back tomorrow.';
    } else {
      els.dyMetaLine.innerHTML = 'Clear all of today for <strong>' +
        esc(state.metaEntries) + '</strong> bonus giveaway entries.';
    }
  }

  function renderGrid(challenges, loggedIn) {
    var html = challenges.map(function (c) {
      var done = loggedIn && c.done;
      var cta = c.id === 'daily-rite'
        ? '<a class="pill-btn dy-tile-cta" href="#dyRite">' + (done ? 'See it' : 'Answer') + '</a>'
        : '<a class="pill-btn dy-tile-cta" href="' + esc(c.href) + '">' + (done ? 'Played' : 'Play') + '</a>';
      return '' +
        '<div class="dy-tile' + (done ? ' is-done' : '') + '">' +
          '<div class="dy-tile-head">' +
            '<span class="dy-tile-icon">' + esc(c.icon || '') + '</span>' +
            '<h3 class="dy-tile-title">' + esc(c.title) + '</h3>' +
            '<span class="dy-check" aria-hidden="true">' + (done ? '✓' : '') + '</span>' +
          '</div>' +
          '<p class="dy-tile-blurb">' + esc(c.blurb) + '</p>' +
          cta +
        '</div>';
    }).join('');
    els.dyGrid.innerHTML = html;
  }

  /* ── The Daily Rite ────────────────────────── */
  var riteState = null;   // last payload from /api/daily/rite

  function renderRite(r) {
    riteState = r;
    show(els.dyRite, true);
    els.dyRiteCat.textContent = r.category || '';
    els.dyRiteQ.textContent = r.question || '';
    show(els.dyRiteDone, !!r.answered);

    var answered = !!r.answered;
    var opts = (r.options || []).map(function (opt, i) {
      var cls = 'dy-opt';
      var mark = '';
      if (answered) {
        if (i === r.correctIndex) { cls += ' is-correct'; mark = '<span class="dy-opt-mark">✓</span>'; }
        else if (i === r.yourPick) { cls += ' is-wrong'; mark = '<span class="dy-opt-mark">✗</span>'; }
      }
      return '<button type="button" class="' + cls + '" data-pick="' + i + '"' +
        (answered || !r.loggedIn ? ' disabled' : '') + '>' + esc(opt) + mark + '</button>';
    }).join('');
    els.dyRiteOptions.innerHTML = opts;

    show(els.dyRiteLocked, !r.loggedIn);

    if (answered) {
      renderRiteResult(r);
    } else {
      show(els.dyRiteResult, false);
      if (r.loggedIn) {
        Array.prototype.forEach.call(
          els.dyRiteOptions.querySelectorAll('.dy-opt'),
          function (b) { b.addEventListener('click', onPick); }
        );
      }
    }
  }

  function renderRiteResult(r) {
    var verdict = r.wasCorrect ? 'Correct.' : 'Wrong this time.';
    var crowd = (r.pctCorrect == null)
      ? ''
      : '<span class="dy-rite-crowd">' + esc(r.pctCorrect) + '% of the crypt got it right.</span>';
    var entry = r.wasCorrect
      ? ' A right answer banked a bonus giveaway entry.'
      : '';
    els.dyRiteResult.innerHTML =
      '<span class="dy-rite-verdict">' + esc(verdict) + '</span>' +
      '<span>' + (r.wasCorrect ? 'Nicely done.' : 'The crypt keeps its secrets.') + esc(entry) + '</span><br>' +
      crowd;
    show(els.dyRiteResult, true);
  }

  function onPick(e) {
    var pick = Number(e.currentTarget.getAttribute('data-pick'));
    Array.prototype.forEach.call(
      els.dyRiteOptions.querySelectorAll('.dy-opt'),
      function (b) { b.disabled = true; }
    );
    fetch('/api/daily/rite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pick: pick })
    }).then(function (res) { return res.json().then(function (d) { return { ok: res.ok, status: res.status, d: d }; }); })
      .then(function (out) {
        var d = out.d || {};
        // Merge the POST result into the rite view and re-render answered.
        riteState = Object.assign({}, riteState, {
          answered: true, yourPick: (d.yourPick != null ? d.yourPick : pick),
          correctIndex: d.correctIndex, wasCorrect: d.wasCorrect, pctCorrect: d.pctCorrect
        });
        renderRite(riteState);
        loadHub();   // reflect the tick + any streak/meta change
      })
      .catch(function () {
        Array.prototype.forEach.call(
          els.dyRiteOptions.querySelectorAll('.dy-opt'),
          function (b) { b.disabled = false; }
        );
      });
  }

  /* ── Loads ─────────────────────────────────── */
  function loadHub() {
    return fetch('/api/daily', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (state) {
        show(els.dyLoading, false);
        show(els.dyGuest, !state.loggedIn);
        if (state.loggedIn) {
          renderSummary(state);
        } else {
          show(els.dySummary, false);
        }
        renderGrid(state.challenges || [], !!state.loggedIn);
      })
      .catch(function () { show(els.dyLoading, false); });
  }

  function loadRite() {
    return fetch('/api/daily/rite', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (r) { renderRite(r); })
      .catch(function () { /* leave the Rite card hidden on failure */ });
  }

  function init() {
    cacheEls();
    loadHub();
    loadRite();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
