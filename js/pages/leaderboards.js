(function () {
  var BOARDS = ['skull-clicker', 'memory-match', 'commander-bingo', 'mana-clash', 'pham-shock'];

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function formatScore(game, score) {
    if (game === 'memory-match') return score + ' moves';
    if (game === 'commander-bingo') return score;
    return score.toLocaleString();
  }

  function populateBoard(game, entries) {
    var panel = document.getElementById('board-' + game);
    if (!panel) return;
    var rows = panel.querySelectorAll('.lb-row');
    var empty = panel.querySelector('.lb-empty');

    for (var i = 0; i < rows.length; i++) {
      var entry = entries[i];
      var nameEl = rows[i].querySelector('.lb-col-name');
      var scoreEl = rows[i].querySelector('.lb-col-score');
      if (entry) {
        nameEl.innerHTML = '<span class="lb-name-text">' + esc(entry.name) + '</span>';
        nameEl.dataset.userId = entry.id || '';
        scoreEl.textContent = formatScore(game, entry.score);
        rows[i].style.display = '';
      } else {
        nameEl.dataset.userId = '';
        rows[i].style.display = 'none';
      }
    }

    if (empty) {
      empty.style.display = entries.length === 0 ? '' : 'none';
    }
  }

  var RARITY_ICON = { mythic: '♦', rare: '◆', uncommon: '▲', common: '●' };

  /* Second pass, after scores render: fetch each visible player's chosen
     badge showcase (public data, no auth needed) and tag it onto their
     name. One batched request covers every board on the page. */
  function loadShowcaseBadges() {
    var nameEls = document.querySelectorAll('.lb-col-name[data-user-id]');
    var ids = [];
    nameEls.forEach(function (el) {
      var id = el.dataset.userId;
      if (id && !id.startsWith('guest_') && ids.indexOf(id) === -1) ids.push(id);
    });
    if (ids.length === 0) return;

    fetch('/api/inventory?action=showcase&userIds=' + encodeURIComponent(ids.join(',')), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (showcases) {
        nameEls.forEach(function (el) {
          var badges = showcases[el.dataset.userId];
          if (!badges || badges.length === 0) return;
          var badgeHtml = badges.map(function (b) {
            var icon = RARITY_ICON[b.rarity] || RARITY_ICON.common;
            return '<span class="lb-badge lb-badge-' + b.rarity + '" title="' + esc(b.name) + '">' + icon + '</span>';
          }).join('');
          el.insertAdjacentHTML('beforeend', '<span class="lb-badge-row">' + badgeHtml + '</span>');
        });
      })
      .catch(function () {});
  }

  function loadLeaderboards() {
    fetch('/api/leaderboards?game=all', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        BOARDS.forEach(function (game) {
          populateBoard(game, data[game] || []);
        });
        loadShowcaseBadges();
      })
      .catch(function () {});
  }

  document.addEventListener('DOMContentLoaded', loadLeaderboards);
})();

/* ══════════════════════════════════════════════
   COMMUNITY BOARDS — this month's entries, watch hours and check-in streaks

   Read-only, and shows names and positions only. The API deliberately does
   not return user ids: they are how every authorisation check on the site
   identifies a person, and a public page has no reason to publish a
   directory of them.
   ══════════════════════════════════════════════ */

function escCommunity(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : s;
  return d.innerHTML;
}

function renderCommunityBoard(title, rows, unit) {
  if (!rows || !rows.length) {
    return '<div class="community-board">' +
      '<h3>' + escCommunity(title) + '</h3>' +
      '<p class="community-board-empty">Nothing yet this month.</p>' +
      '</div>';
  }
  return '<div class="community-board">' +
    '<h3>' + escCommunity(title) + '</h3>' +
    '<ol class="community-board-list">' + rows.map(function (r) {
      return '<li class="community-board-row' + (r.rank <= 3 ? ' is-top' : '') + '">' +
        '<span class="community-board-rank">' + r.rank + '</span>' +
        '<span class="community-board-name">' + escCommunity(r.name) + '</span>' +
        '<span class="community-board-value">' + escCommunity(String(r.value)) +
        (unit ? ' <small>' + escCommunity(unit) + '</small>' : '') + '</span>' +
        '</li>';
    }).join('') + '</ol></div>';
}

async function loadCommunityBoards() {
  const box = document.getElementById('communityBoards');
  if (!box) return;
  try {
    const res = await fetch('/api/community-leaderboard');
    if (!res.ok) throw new Error('unavailable');
    const d = await res.json();
    box.innerHTML =
      renderCommunityBoard('Giveaway Entries', d.entries, 'entries') +
      renderCommunityBoard('Watch Time', d.hours, 'hrs') +
      renderCommunityBoard('Check-In Streaks', d.streaks, 'streams');
  } catch {
    /* Says it is unavailable rather than sitting on "Loading…" for ever —
       a spinner that never resolves reads as a broken page. */
    box.innerHTML = '<p class="community-boards-loading">Community boards are unavailable right now.</p>';
  }
}

document.addEventListener('DOMContentLoaded', loadCommunityBoards);
