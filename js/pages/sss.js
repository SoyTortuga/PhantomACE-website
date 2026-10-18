/* ══════════════════════════════════════════════
   Soup, Salad, or Sandwich — /soup-salad-sandwich

   One read of /api/daily/sss for today's five foods and the player's calls so
   far. Each food shows three buttons; tapping one POSTs the call, locks it,
   reveals the right answer + the crowd's %, and advances the summary. The
   daily ticks done on the hub once all five are called; a perfect five pays a
   bonus giveaway entry (the server decides both).
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var els = {};
  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var CATS = ['soup', 'salad', 'sandwich'];
  var state = null;     // last payload from GET
  var busy = false;

  function cacheEls() {
    ['sssLoading', 'sssGuest', 'sssSummary', 'sssDone', 'sssTotal', 'sssScore',
     'sssVerdict', 'sssList'].forEach(function (id) { els[id] = $(id); });
  }

  function choiceHtml(food, cat) {
    var cls = 'sss-choice';
    if (food.answered) {
      if (cat === food.correctCat) cls += ' is-correct';
      else if (cat === food.pick) cls += ' is-wrong';
    }
    return '<button type="button" class="' + cls + '" data-pos="' + food.pos +
      '" data-cat="' + cat + '"' + (food.answered || !state.loggedIn ? ' disabled' : '') + '>' +
      '<img class="sss-choice-icon" src="/assets/images/sss/' + cat + '.png" alt="" aria-hidden="true">' +
      '<span class="sss-choice-label">' + cat + '</span>' +
      '</button>';
  }

  function resultHtml(food) {
    if (!food.answered) return '';
    var verdict = food.correct ? 'Correct.' : 'Wrong.';
    var right = food.correct
      ? ''
      : ' It\'s a <strong>' + esc(food.correctCat) + '</strong>.';
    var crowd = (food.pctCorrect == null)
      ? ''
      : ' <span class="sss-result-crowd">' + esc(food.pctCorrect) + '% of the table agreed.</span>';
    return '<div class="sss-result"><span class="sss-result-verdict">' + esc(verdict) +
      '</span>' + right + crowd + '</div>';
  }

  function itemHtml(food) {
    return '' +
      '<div class="sss-item' + (food.answered ? ' is-answered' : '') + '" data-pos="' + food.pos + '">' +
        '<h3 class="sss-item-food">' + esc(food.food) + '</h3>' +
        '<div class="sss-choices">' + CATS.map(function (c) { return choiceHtml(food, c); }).join('') + '</div>' +
        resultHtml(food) +
      '</div>';
  }

  function renderSummary() {
    if (!state.loggedIn) { show(els.sssSummary, false); return; }
    show(els.sssSummary, true);
    els.sssDone.textContent = state.doneCount || 0;
    els.sssTotal.textContent = state.total || 5;
    els.sssScore.textContent = state.correct || 0;
    if (state.done) {
      els.sssVerdict.innerHTML = state.perfect
        ? 'A perfect plate. <strong>+1</strong> bonus giveaway entry banked. Back tomorrow.'
        : "That's the lot. Come back tomorrow for five more.";
    } else {
      els.sssVerdict.innerHTML = 'Call every food. A perfect five pays a bonus giveaway entry.';
    }
  }

  function renderList() {
    els.sssList.innerHTML = (state.foods || []).map(itemHtml).join('');
    if (state.loggedIn) {
      Array.prototype.forEach.call(
        els.sssList.querySelectorAll('.sss-choice:not(:disabled)'),
        function (b) { b.addEventListener('click', onPick); }
      );
    }
  }

  function renderAll() {
    show(els.sssLoading, false);
    show(els.sssGuest, !state.loggedIn);
    renderSummary();
    renderList();
  }

  function onPick(e) {
    if (busy) return;
    busy = true;
    var pos = Number(e.currentTarget.getAttribute('data-pos'));
    var pick = e.currentTarget.getAttribute('data-cat');
    // Lock the whole set's buttons during the round-trip.
    Array.prototype.forEach.call(els.sssList.querySelectorAll('.sss-choice'),
      function (b) { b.disabled = true; });

    fetch('/api/daily/sss', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pos: pos, pick: pick }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (out) {
        busy = false;
        var d = out.d || {};
        // Fold the answered food into local state and re-render from the server's truth.
        var food = (state.foods || []).find(function (f) { return f.pos === pos; });
        if (food && (out.ok || out.status === 409)) {
          food.answered = true;
          food.pick = d.pick != null ? d.pick : pick;
          food.correctCat = d.correctCat;
          food.correct = d.correct;
          food.pctCorrect = d.pctCorrect;
        }
        if (out.ok) {
          state.doneCount = d.doneCount;
          state.correct = d.correct_total;
          state.done = d.done;
          state.perfect = d.perfect;
        }
        renderAll();
      })
      .catch(function () {
        busy = false;
        // Re-enable so the player can retry the tap.
        load();
      });
  }

  function load() {
    return fetch('/api/daily/sss', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) { state = s; renderAll(); })
      .catch(function () { show(els.sssLoading, false); });
  }

  function init() { cacheEls(); load(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
