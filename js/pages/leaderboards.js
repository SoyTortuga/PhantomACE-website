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
