(function () {
  var BOARDS = ['skull-clicker', 'memory-match', 'commander-bingo', 'mana-clash'];

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
        nameEl.innerHTML = esc(entry.name);
        scoreEl.textContent = formatScore(game, entry.score);
        rows[i].style.display = '';
      } else {
        rows[i].style.display = 'none';
      }
    }

    if (empty) {
      empty.style.display = entries.length === 0 ? '' : 'none';
    }
  }

  function loadLeaderboards() {
    fetch('/api/leaderboards?game=all', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        BOARDS.forEach(function (game) {
          populateBoard(game, data[game] || []);
        });
      })
      .catch(function () {});
  }

  document.addEventListener('DOMContentLoaded', loadLeaderboards);
})();
