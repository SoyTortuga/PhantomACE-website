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
    /* /user/<login> is the canonical form. ?u= still works, because links
       to it exist and a URL that once worked should keep working. */
    var m = location.pathname.match(/^\/user\/([A-Za-z0-9_]{1,30})\/?$/);
    if (m) return { param: 'u', value: m[1] };

    var q = new URLSearchParams(location.search);
    var u = (q.get('u') || '').trim();
    if (u) return { param: 'u', value: u };
    /* auth.js exposes getSession() as a plain global, not on a namespace.
       Both scripts are deferred and this one is listed after it, so it is
       defined by the time this runs — the typeof guard is for the case
       where auth.js failed to load at all. */
    try {
      var sess = (typeof getSession === 'function') ? getSession() : null;
      if (sess && sess.login) {
        /* Put the viewer on the canonical URL, so the address bar shows the
           page they can share rather than the one they happened to open. */
        if (location.pathname === '/profile' || location.pathname === '/profile.html') {
          history.replaceState(null, '', '/user/' + sess.login);
        }
        return { param: 'u', value: sess.login };
      }
      if (sess && sess.user_id) return { param: 'id', value: String(sess.user_id) };
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
      ? '<img src="' + esc(b.image) + '" alt="" class="prof-badge-art" data-glyph="' +
        (b.founder ? '★' : '◆') + '">'
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
    /* Current standing rather than a possession — see the tenure comment in
       the API. Someone who was VIP and is not any more keeps the badge in
       their inventory and loses this. */
    if (t.vip) bits.push('<span class="prof-vip">VIP</span>');
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
          /* A data attribute, NOT a role-* class. Those are the site's
             visibility gates — .role-moderator is display:none unless the
             VIEWER is a moderator — so styling this label with one made it
             stretch for moderators and vanish for everybody else. */
          '<span class="prof-role" data-role="' + esc(p.role) + '">' +
            esc(p.role.replace(/_/g, ' ')) + '</span>' +
        '</div>' +
      '</header>';

    /* The showcase is what they chose to put forward, so it leads. */
    var showcase = (p.showcase || []).length
      ? '<div class="prof-badges">' + p.showcase.map(badgeTile).join('') + '</div>'
      : '';

    /* The same stat block the game shows when you select a species in the
       collection: the portrait, the name, era and habitat, the badges, and
       the description. Every field was capped and escaped server-side and
       is escaped again here. */
    var dino = '';
    if (p.favoriteDino) {
      var d = p.favoriteDino;
      /* Both filters were whitelisted server-side to the characters CSS
         filter functions are built from — see sanitizeFavorite. */
      var art = d.portrait || d.src;
      var artFilter = d.portrait ? d.portraitFilter : d.filter;
      var style = artFilter ? ' style="filter:' + esc(artFilter) + '"' : '';

      var badges = '';
      if (d.rarity) badges += '<span class="prof-dino-badge r-' + esc(d.rarity) + '">' + esc(d.rarity) + '</span>';
      if (d.diet) badges += '<span class="prof-dino-badge">' + esc(d.diet) + '</span>';
      if (d.build) badges += '<span class="prof-dino-badge">' + esc(d.build) + '</span>';
      if (d.mutationLabel) {
        badges += '<span class="prof-dino-badge is-mut">' + esc(d.mutationLabel) + '</span>';
      }

      /* A nickname the player never changed is the species name, and
         printing it twice reads as a mistake. */
      var nick = d.nickname || d.species || d.specId;
      var sub = [];
      if (d.era) sub.push(esc(d.era));
      if (d.habitat) sub.push(esc(d.habitat));
      var speciesLine = (d.species && d.species !== nick) ? esc(d.species) : '';

      dino =
        '<div class="prof-dino">' +
          '<div class="prof-dino-portrait">' +
            '<img src="' + esc(art) + '" alt=""' + style + '>' +
          '</div>' +
          '<div class="prof-dino-info">' +
            '<div class="prof-dino-name">' + esc(nick) + '</div>' +
            (speciesLine ? '<div class="prof-dino-species">' + speciesLine + '</div>' : '') +
            (sub.length ? '<div class="prof-dino-sub">' + sub.join(' <span class="prof-dot">·</span> ') + '</div>' : '') +
            (badges ? '<div class="prof-dino-badges">' + badges + '</div>' : '') +
            (d.desc ? '<p class="prof-dino-desc">“' + esc(d.desc) + '”</p>' : '') +
          '</div>' +
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
      section('Standings', standings) +
      /* Filled by profile-comments.js once this page has said who the
         person is — the wall is the forum's, not the profile's. */
      section('Comments', '<div id="profComments"><div class="forum-empty card"><p>Loading comments…</p></div></div>');

    /* A badge can name artwork that is not there yet — the milestone ranks
       point at a file per level, and a level whose art has not landed would
       otherwise draw a broken image. Swapped for the glyph instead, so an
       absent file looks the way it did before rather than worse. */
    var arts = body.querySelectorAll('.prof-badge-art[data-glyph]');
    for (var a = 0; a < arts.length; a++) {
      arts[a].addEventListener('error', function () {
        var span = document.createElement('span');
        span.className = 'prof-badge-fallback';
        span.textContent = this.dataset.glyph || '◆';
        if (this.parentNode) this.parentNode.replaceChild(span, this);
      });
    }

    body.hidden = false;
    state.hidden = true;
    document.title = p.displayName + ' | PhantomACE';

    /* Anything that hangs off the profile but is not the profile — the
       comment wall — waits for this rather than re-resolving the login. */
    document.dispatchEvent(new CustomEvent('profile:rendered', { detail: p }));
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
