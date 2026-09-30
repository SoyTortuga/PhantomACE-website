(function () {
  /* mana-clash-wins shares the Mana Clash TAB with mana-clash — two boards,
     one tab — so it has no tab button of its own. */
  var BOARDS = ['skull-clicker', 'memory-match', 'commander-bingo',
                'mana-clash', 'mana-clash-wins', 'pham-shock'];

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

  /* Remove a row's banner backdrop (rows are reused across polls). */
  function clearRowBanner(row) {
    row.classList.remove('has-banner');
    var old = row.querySelectorAll('.lb-banner-bg, .lb-banner-scrim');
    for (var i = 0; i < old.length; i++) {
      if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
    }
  }

  /* Render a faint banner image + dark scrim behind the row. variant is a fixed
     word, so the src is not user-controlled. If the art is missing (it may land
     after this ships) the onerror handler strips it back to a normal row. */
  function applyRowBanner(row, variant) {
    clearRowBanner(row);
    if (!variant) return;
    var CV = window.CosmeticVariants;
    var src = CV ? CV.bannerPath(variant) : '/assets/banners/banner-' + variant + '.png';

    var img = document.createElement('img');
    img.className = 'lb-banner-bg';
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.addEventListener('error', function () { clearRowBanner(row); });

    var scrim = document.createElement('div');
    scrim.className = 'lb-banner-scrim';
    scrim.setAttribute('aria-hidden', 'true');

    row.insertBefore(scrim, row.firstChild);
    row.insertBefore(img, row.firstChild);
    row.classList.add('has-banner');

    img.src = src;
    /* A cached/instant 404 can error before the listener attaches. */
    if (img.complete && img.naturalWidth === 0) clearRowBanner(row);
  }

  function populateBoard(game, entries) {
    /* Scoped to the TABLE, not the panel. A panel holding two boards would
       otherwise have the first board fill both tables' rows. */
    var panel = document.getElementById('table-' + game) || document.getElementById('board-' + game);
    if (!panel) return;
    var rows = panel.querySelectorAll('.lb-row');
    var empty = panel.querySelector('.lb-empty');
    var CV = window.CosmeticVariants;

    for (var i = 0; i < rows.length; i++) {
      var entry = entries[i];
      var row = rows[i];
      var nameEl = row.querySelector('.lb-col-name');
      var scoreEl = row.querySelector('.lb-col-score');
      if (entry) {
        nameEl.innerHTML = '<span class="lb-name-text">' + esc(entry.name) + '</span>';
        nameEl.dataset.userId = entry.id || '';
        scoreEl.textContent = formatScore(game, entry.score);
        row.style.display = '';
        /* Name effect on the name text — managed, so only in-view names animate
           and the board never runs more than the cap at once. Banner behind the
           whole row. */
        if (CV) CV.applyNameFx(nameEl.querySelector('.lb-name-text'), entry.nameEffect || null, { managed: true });
        applyRowBanner(row, entry.banner || null);
      } else {
        nameEl.dataset.userId = '';
        var txt = nameEl.querySelector('.lb-name-text');
        if (CV && txt) CV.applyNameFx(txt, null);
        clearRowBanner(row);
        row.style.display = 'none';
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
