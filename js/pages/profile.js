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

  /* Quotes too: half of what goes through here lands inside an attribute
     (title, src, data-role, class), and innerHTML alone leaves " intact. */
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exclusive'];
  function safeRarity(r) {
    return RARITIES.indexOf(r) !== -1 ? r : 'common';
  }
  function safeVariant(v) {
    return (typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v)) ? v : null;
  }
  /* Image sources from stored data: site-relative paths, https, or the inline
     png/webp portraits Dino Park's favourite-dino sanitizer already allows. */
  function safeSrc(u) {
    if (typeof u !== 'string') return '';
    return (/^\/(?!\/)/.test(u) || /^https:\/\//i.test(u) ||
      /^data:image\/(png|webp);base64,[a-z0-9+/=]+$/i.test(u)) ? u : '';
  }

  /* A link href is validated server-side; this is the matching client guard so
     a malformed stored value can never put a non-http(s) href on the page. */
  function safeHttpUrl(u) {
    if (typeof u !== 'string') return '';
    try {
      var url = new URL(u);
      return (url.protocol === 'http:' || url.protocol === 'https:') ? u : '';
    } catch (e) { return ''; }
  }

  var BIO_MAX = 300;
  var LINKS_MAX = 5;

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
    var safe = safeRarity(r);
    return '<span class="prof-rarity r-' + safe + '">' + safe + '</span>';
  }

  /* A badge, with its artwork where it has any. Twitch badges are 72px at
     most and render here at 48, so they are drawn pixelated rather than
     smoothed — the same treatment Dino Park's sprites get. */
  function badgeTile(b) {
    var img = safeSrc(b.image);
    var art = img
      ? '<img src="' + esc(img) + '" alt="" class="prof-badge-art" data-glyph="' +
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

  /* ── About: the owner's bio and links ─────────────────────────────────
     Everything here is the profile owner's own text, escaped like the rest of
     the page. The links were validated to http(s) server-side and are checked
     again here. */
  function linksList(links) {
    var safe = (links || []).map(function (l) {
      return { label: (l && l.label) || '', url: safeHttpUrl(l && l.url) };
    }).filter(function (l) { return l.url; });
    if (!safe.length) return '';
    return '<ul class="prof-links">' + safe.map(function (l) {
      return '<li><a class="prof-link" href="' + esc(l.url) + '" ' +
        'target="_blank" rel="noopener noreferrer nofollow ugc">' +
        esc(l.label || l.url) + '</a></li>';
    }).join('') + '</ul>';
  }

  function aboutDisplay(p) {
    var bio = (typeof p.bio === 'string' ? p.bio : '').trim();
    var bioHtml = bio ? '<p class="prof-bio">' + esc(bio).replace(/\n/g, '<br>') + '</p>' : '';
    return bioHtml + linksList(p.links);
  }

  var ABOUT_EMPTY = '<p class="prof-about-empty">Say who you are — a short bio and ' +
    'a few links. Everyone who opens your profile sees them.</p>';

  function linkInputRow(l) {
    l = l || {};
    return '<div class="prof-link-row">' +
      '<input type="text" class="prof-link-label" maxlength="40" placeholder="Label (e.g. Twitch)" value="' + esc(l.label || '') + '">' +
      '<input type="url" class="prof-link-url" maxlength="200" placeholder="https://…" value="' + esc(safeHttpUrl(l.url) || '') + '">' +
      '<button type="button" class="prof-link-remove" aria-label="Remove link">×</button>' +
    '</div>';
  }

  function aboutForm(p) {
    var bio = (typeof p.bio === 'string' ? p.bio : '');
    var links = Array.isArray(p.links) ? p.links : [];
    var count = Math.min(Math.max(links.length, 1), LINKS_MAX);
    var rows = '';
    for (var i = 0; i < count; i++) rows += linkInputRow(links[i]);
    return '<form class="prof-about-form" id="profAboutForm" hidden>' +
      '<label class="prof-field">' +
        '<span class="prof-field-label">Bio</span>' +
        '<textarea class="prof-bio-input" id="profBioInput" maxlength="' + BIO_MAX + '" rows="3" ' +
          'placeholder="A line or two about you.">' + esc(bio) + '</textarea>' +
        '<span class="prof-field-hint"><span id="profBioCount">' + bio.length + '</span>/' + BIO_MAX + '</span>' +
      '</label>' +
      '<span class="prof-field-label">Links <span class="prof-field-hint">up to ' + LINKS_MAX + '</span></span>' +
      '<div class="prof-links-edit" id="profLinksEdit">' + rows + '</div>' +
      '<button type="button" class="prof-link-add" id="profLinkAdd">Add link</button>' +
      '<p class="prof-about-error" id="profAboutError" hidden></p>' +
      '<div class="prof-about-actions">' +
        '<button type="submit" class="prof-about-save">Save</button>' +
        '<button type="button" class="prof-about-cancel" id="profAboutCancel">Cancel</button>' +
      '</div>' +
    '</form>';
  }

  function aboutSection(p, isOwner) {
    var display = aboutDisplay(p);
    if (!display && !isOwner) return '';
    return '<section class="prof-section prof-about">' +
      '<h2 class="prof-section-title">About</h2>' +
      '<div class="prof-about-view" id="profAboutView">' + (display || ABOUT_EMPTY) + '</div>' +
      (isOwner
        ? '<button type="button" class="prof-about-edit" id="profAboutEdit">' +
            (display ? 'Edit bio &amp; links' : 'Add a bio &amp; links') + '</button>' +
          aboutForm(p)
        : '') +
    '</section>';
  }

  function wireAbout(p) {
    var section = body.querySelector('.prof-about');
    if (!section) return;
    var form = section.querySelector('#profAboutForm');
    if (!form) return;                                  // viewer, not owner
    var view = section.querySelector('#profAboutView');
    var editBtn = section.querySelector('#profAboutEdit');
    var linksEdit = section.querySelector('#profLinksEdit');
    var addBtn = section.querySelector('#profLinkAdd');
    var errEl = section.querySelector('#profAboutError');
    var bioInput = section.querySelector('#profBioInput');
    var bioCount = section.querySelector('#profBioCount');

    function open() { form.hidden = false; view.hidden = true; if (editBtn) editBtn.hidden = true; }
    function close() { form.hidden = true; view.hidden = false; if (editBtn) editBtn.hidden = false; }

    if (editBtn) editBtn.addEventListener('click', open);
    var cancel = section.querySelector('#profAboutCancel');
    if (cancel) cancel.addEventListener('click', close);

    if (bioInput && bioCount) {
      bioInput.addEventListener('input', function () { bioCount.textContent = String(bioInput.value.length); });
    }

    function syncAdd() {
      if (addBtn) addBtn.disabled = linksEdit.querySelectorAll('.prof-link-row').length >= LINKS_MAX;
    }
    if (addBtn) addBtn.addEventListener('click', function () {
      if (linksEdit.querySelectorAll('.prof-link-row').length >= LINKS_MAX) return;
      linksEdit.insertAdjacentHTML('beforeend', linkInputRow(null));
      syncAdd();
    });
    linksEdit.addEventListener('click', function (e) {
      var rm = e.target.closest('.prof-link-remove');
      if (!rm) return;
      var row = rm.closest('.prof-link-row');
      if (row) row.remove();
      syncAdd();
    });
    syncAdd();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var bio = bioInput ? bioInput.value : '';
      var links = [];
      var rows = linksEdit.querySelectorAll('.prof-link-row');
      for (var i = 0; i < rows.length; i++) {
        var urlv = rows[i].querySelector('.prof-link-url').value.trim();
        if (!urlv) continue;
        links.push({ label: rows[i].querySelector('.prof-link-label').value.trim(), url: urlv });
      }
      var saveBtn = form.querySelector('.prof-about-save');
      if (saveBtn) saveBtn.disabled = true;
      if (errEl) errEl.hidden = true;

      fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'set-social', bio: bio, links: links }),
      }).then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, d: d }; });
      }).then(function (res) {
        if (!res.ok) throw new Error((res.d && res.d.error) || 'Could not save.');
        p.bio = res.d.bio;
        p.links = res.d.links;
        var display = aboutDisplay(p);
        view.innerHTML = display || ABOUT_EMPTY;
        if (editBtn) editBtn.innerHTML = display ? 'Edit bio &amp; links' : 'Add a bio &amp; links';
        close();
      }).catch(function (err) {
        if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
      }).finally(function () {
        if (saveBtn) saveBtn.disabled = false;
      });
    });
  }

  function render(p) {
    var equipped = p.equipped || {};
    var title = equipped.title ? equipped.title.name : '';

    /* Is the viewer looking at their own profile? Only then is the About
       section editable. Compared on the stable user id, never the login. */
    var isOwner = false;
    try {
      var sess = (typeof getSession === 'function') ? getSession() : null;
      isOwner = !!(sess && sess.user_id && String(sess.user_id) === String(p.userId));
    } catch (e) { isOwner = false; }

    /* Variant mapping is shared — js/cosmetic-variants.js, loaded before this
       script — so nav / profile / leaderboards / chat agree. The profile API's
       public item carries rarity + name (and a flattened effect), which the
       shared mapping resolves the same as a raw inventory item. The name effect
       itself is applied post-render (see below) via the shared applier. */
    var CV = window.CosmeticVariants;
    var nameFx = (CV && equipped['name-effect']) ? safeVariant(CV.nameEffectVariant(equipped['name-effect'])) : null;

    /* The equipped banner is a tiered image behind the whole identity card,
       under a dark red/black scrim that keeps the name legible in either
       theme. variant is a fixed word, so the src is not user-controlled. If no
       banner is equipped the strip is simply absent; if the file is missing
       the onerror handler below strips it back to the plain card. */
    var bannerVar = (CV && equipped.banner) ? safeVariant(CV.bannerVariant(equipped.banner)) : null;
    var headCls = 'prof-head' + (bannerVar ? ' has-banner' : '');
    var bannerHtml = bannerVar
      ? '<img class="prof-banner-img" alt="" src="/assets/banners/banner-' + bannerVar + '.png">' +
        '<div class="prof-banner-scrim" aria-hidden="true"></div>'
      : '';

    var head =
      '<header class="' + headCls + '">' +
        bannerHtml +
        (safeSrc(p.avatar) ? '<img class="prof-avatar" src="' + esc(safeSrc(p.avatar)) + '" alt="">' : '<div class="prof-avatar"></div>') +
        '<div class="prof-ident">' +
          '<h1 class="prof-name">' + esc(p.displayName) + '</h1>' +
          (title ? '<p class="prof-title">' + esc(title) + '</p>' : '') +
          tenureLine(p.tenure) +
          /* A data attribute, NOT a role-* class. Those are the site's
             visibility gates — .role-moderator is display:none unless the
             VIEWER is a moderator — so styling this label with one made it
             stretch for moderators and vanish for everybody else. */
          '<span class="prof-role" data-role="' + esc(p.role) + '">' +
            esc(String(p.role || '').replace(/_/g, ' ')) + '</span>' +
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
      var art = safeSrc(d.portrait || d.src);
      var artFilter = d.portrait ? d.portraitFilter : d.filter;
      var style = artFilter ? ' style="filter:' + esc(artFilter) + '"' : '';

      var badges = '';
      if (d.rarity) badges += '<span class="prof-dino-badge r-' + safeRarity(d.rarity) + '">' + safeRarity(d.rarity) + '</span>';
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
      aboutSection(p, isOwner) +
      section('Showcase', showcase) +
      section('Favourite dino', dino) +
      section('Standings', standings) +
      /* The Seasonal Grimoire: filled by profile-grimoire.js on the same
         'profile:rendered' seam the Room and comment wall use. */
      section('Seasonal Grimoire', '<div id="profGrimoire"><p class="grim-state">Loading grimoire…</p></div>') +
      /* Filled by profile-room.js on the same event as the comments. */
      section('Room', '<div id="profRoom"><p class="rm-state">Loading room…</p></div>') +
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

    /* The banner art may not have landed yet. If the image 404s, drop the
       strip and its scrim and revert the card to its plain state rather than
       leave a broken image behind the name. The complete/naturalWidth check
       covers a cached or instant 404 that already errored before this
       listener could attach. */
    /* Apply the owner's name effect to the heading via the shared applier. One
       name on the page, so it animates unmanaged (no in-view cap). */
    var nameH1 = body.querySelector('.prof-name');
    if (nameH1 && CV) CV.applyNameFx(nameH1, nameFx);

    var bannerImg = body.querySelector('.prof-banner-img');
    if (bannerImg) {
      var dropBanner = function () {
        var head = bannerImg.closest('.prof-head');
        if (head) {
          head.classList.remove('has-banner');
          var scrim = head.querySelector('.prof-banner-scrim');
          if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
        }
        if (bannerImg.parentNode) bannerImg.parentNode.removeChild(bannerImg);
      };
      bannerImg.addEventListener('error', dropBanner);
      if (bannerImg.complete && bannerImg.naturalWidth === 0) dropBanner();
    }

    /* Owner-only: wire the bio/links editor. A no-op for a viewer. */
    wireAbout(p);

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
