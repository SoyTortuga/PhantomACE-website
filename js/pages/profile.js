/* ══════════════════════════════════════════════
   PUBLIC PROFILE

   Reads /api/profile and renders somebody — not necessarily the viewer.

   EVERYTHING HERE IS SOMEONE ELSE'S TEXT. Display names, titles, dino
   nicknames and badge names all originate outside this page, so every one
   of them goes through esc() on the way in. The only markup is the markup
   written here.

   ABSENT IS NOT EMPTY. A section with nothing in it is left out rather than
   rendered as a heading over a blank space — a profile with no standings
   should look like a new player, not like a broken page.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var state = document.getElementById('profState');
  var body = document.getElementById('profBody');
  if (!state || !body) return;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /* Whose profile. Falls back to the signed-in viewer so /profile with no
     query is "mine" rather than an error. */
  function wanted() {
    var q = new URLSearchParams(location.search);
    var u = (q.get('u') || '').trim();
    if (u) return { param: 'u', value: u };
    try {
      var s = window.PhamAuth && window.PhamAuth.getSession && window.PhamAuth.getSession();
      if (s && s.login) return { param: 'u', value: s.login };
      if (s && s.user_id) return { param: 'id', value: String(s.user_id) };
    } catch (e) { /* not signed in */ }
    return null;
  }

  function rarityTag(r) {
    return '<span class="prof-rarity r-' + esc(r || 'common') + '">' + esc(r || 'common') + '</span>';
  }

  /* A badge, with its artwork where it has any. Twitch badges are 72px at
     most and render here at 48, so they are drawn pixelated rather than
     smoothed — the same treatment Dino Park's sprites get. */
  function badgeTile(b) {
    var art = b.image
      ? '<img src="' + esc(b.image) + '" alt="" class="prof-badge-art">'
      : '<span class="prof-badge-fallback">' + (b.founder ? '★' : '◆') + '</span>';
    return '<div class="prof-badge" title="' + esc(b.name) + '">' +
      art +
      '<span class="prof-badge-name">' + esc(b.name) + '</span>' +
      rarityTag(b.rarity) +
      '</div>';
  }

  function tenureLine(t) {
    if (!t) return '';
    var bits = [];
    if (t.founder) bits.push('<span class="prof-founder">Founder</span>');
    if (t.months > 0) {
      bits.push(esc(t.months) + (t.months === 1 ? ' month' : ' months'));
    }
    bits.push('Tier ' + esc(t.tier));
    return '<div class="prof-tenure">' + bits.join('<span class="prof-dot">·</span>') + '</div>';
  }

  function section(title, inner) {
    if (!inner) return '';
    return '<section class="prof-section">' +
      '<h2 class="prof-section-title">' + esc(title) + '</h2>' + inner + '</section>';
  }

  function render(p) {
    var equipped = p.equipped || {};
    var title = equipped.title ? equipped.title.name : '';

    var head =
      '<header class="prof-head">' +
        (p.avatar ? '<img class="prof-avatar" src="' + esc(p.avatar) + '" alt="">' : '<div class="prof-avatar"></div>') +
        '<div class="prof-ident">' +
          '<h1 class="prof-name">' + esc(p.displayName) + '</h1>' +
          (title ? '<p class="prof-title">' + esc(title) + '</p>' : '') +
          tenureLine(p.tenure) +
          '<span class="prof-role role-' + esc(p.role) + '">' + esc(p.role.replace(/_/g, ' ')) + '</span>' +
        '</div>' +
      '</header>';

    /* The showcase is what they chose to put forward, so it leads. */
    var showcase = (p.showcase || []).length
      ? '<div class="prof-badges">' + p.showcase.map(badgeTile).join('') + '</div>'
      : '';

    var dino = '';
    if (p.favoriteDino) {
      var d = p.favoriteDino;
      /* The filter was whitelisted server-side to the characters CSS filter
         functions are built from — see sanitizeFavorite in dino-park.js. */
      var style = d.filter ? ' style="filter:' + esc(d.filter) + '"' : '';
      dino =
        '<div class="prof-dino">' +
          '<img src="' + esc(d.src) + '" alt="" class="prof-dino-art"' + style + '>' +
          '<span class="prof-dino-name">' + esc(d.nickname || d.specId) + '</span>' +
        '</div>';
    }

    var pt = '';
    if (p.phamilyTime && p.phamilyTime.level > 0) {
      pt = '<div class="prof-stat">' +
        '<span class="prof-stat-n">' + esc(p.phamilyTime.level) + '</span>' +
        '<span class="prof-stat-l">Phamily Time level</span>' +
      '</div>';
    }

    var counts = '';
    var c = p.collection || {};
    var order = ['badge', 'title', 'banner', 'name-effect'];
    var parts = [];
    for (var i = 0; i < order.length; i++) {
      var n = c[order[i]];
      if (!n) continue;
      var label = order[i] === 'name-effect' ? 'name effect' : order[i];
      parts.push('<div class="prof-stat">' +
        '<span class="prof-stat-n">' + esc(n) + '</span>' +
        '<span class="prof-stat-l">' + esc(n === 1 ? label : label + 's') + '</span>' +
      '</div>');
    }
    counts = parts.join('');

    var stats = (pt || counts) ? '<div class="prof-stats">' + pt + counts + '</div>' : '';

    var standings = '';
    if ((p.standings || []).length) {
      standings = '<ul class="prof-standings">' + p.standings.map(function (s) {
        return '<li>' +
          '<span class="prof-rank">#' + esc(s.rank) + '</span>' +
          '<span class="prof-game">' + esc(s.game) + '</span>' +
          '<span class="prof-unit">' + esc(s.unit) + '</span>' +
          '<span class="prof-score">' + esc(s.score) + '</span>' +
        '</li>';
      }).join('') + '</ul>';
    }

    body.innerHTML =
      head +
      stats +
      section('Showcase', showcase) +
      section('Favourite dino', dino) +
      section('Standings', standings);

    body.hidden = false;
    state.hidden = true;
    document.title = p.displayName + ' | PhantomACE';
  }

  var who = wanted();
  if (!who) {
    state.innerHTML = 'No profile asked for. Sign in to see your own, or open ' +
      'someone’s from a leaderboard.';
    return;
  }

  fetch('/api/profile?' + who.param + '=' + encodeURIComponent(who.value), { cache: 'no-store' })
    .then(function (r) {
      if (r.status === 404) throw new Error('No profile for that name yet.');
      if (!r.ok) throw new Error('Could not load that profile.');
      return r.json();
    })
    .then(render)
    .catch(function (err) {
      /* A profile only exists once somebody has signed in at least once,
         which is worth saying rather than leaving as "not found". */
      state.textContent = err.message === 'No profile for that name yet.'
        ? 'Nobody here yet. A profile appears the first time someone signs in.'
        : err.message;
    });
})();
