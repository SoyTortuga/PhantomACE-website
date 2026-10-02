/* ══════════════════════════════════════════════
   MEMBER DIRECTORY

   Reads /api/members and draws the roll of everyone who has signed in. Every
   name, title and badge here came from the server as someone else's text, so
   all of it goes through esc() on the way into the page. Each card links to
   that person's public profile at /user/<login>.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var grid = document.getElementById('memGrid');
  var countEl = document.getElementById('memCount');
  var searchEl = document.getElementById('memSearch');
  var pager = document.getElementById('memPager');
  var prevBtn = document.getElementById('memPrev');
  var nextBtn = document.getElementById('memNext');
  var pageAt = document.getElementById('memPageAt');
  var sortBtns = document.querySelectorAll('.mem-sort-btn');
  if (!grid) return;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exclusive'];
  function safeRarity(r) { return RARITIES.indexOf(r) !== -1 ? r : 'common'; }

  function safeSrc(u) {
    if (typeof u !== 'string') return '';
    return (/^\/(?!\/)/.test(u) || /^https:\/\//i.test(u)) ? u : '';
  }

  /* A login is a short [A-Za-z0-9_] token, so it is safe in the path, but it
     is still escaped when it lands in an href attribute. */
  function profileHref(login) {
    return '/user/' + encodeURIComponent(String(login || ''));
  }

  function joinedLabel(firstSeen) {
    if (!firstSeen) return '';
    var t = (typeof firstSeen === 'number') ? firstSeen : Date.parse(firstSeen);
    if (!isFinite(t) || !t) return '';
    try {
      return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
    } catch (e) { return ''; }
  }

  function badgeTag(b) {
    if (!b) return '';
    var rarity = safeRarity(b.rarity);
    var img = safeSrc(b.image);
    var glyph = img
      ? '<img class="mem-badge-art" src="' + esc(img) + '" alt="">'
      : '<span class="mem-badge-glyph">◆</span>';
    return '<span class="mem-badge mem-badge-' + rarity + '" title="' + esc(b.name) + '">' +
      glyph + '</span>';
  }

  function card(m) {
    var avatar = safeSrc(m.avatar)
      ? '<img class="mem-avatar" src="' + esc(safeSrc(m.avatar)) + '" alt="" loading="lazy">'
      : '<span class="mem-avatar mem-avatar-blank" aria-hidden="true"></span>';

    var title = (m.title && m.title.name)
      ? '<p class="mem-title r-' + safeRarity(m.title.rarity) + '">' + esc(m.title.name) + '</p>'
      : '';

    var role = m.role
      ? '<span class="mem-role" data-role="' + esc(m.role) + '">' +
          esc(String(m.role).replace(/_/g, ' ')) + '</span>'
      : '';

    var joined = joinedLabel(m.firstSeen);
    var joinedHtml = joined ? '<span class="mem-joined">Since ' + esc(joined) + '</span>' : '';

    var meta = (role || joinedHtml)
      ? '<div class="mem-meta">' + role + joinedHtml + '</div>'
      : '';

    return '<a class="mem-card" href="' + profileHref(m.login) + '">' +
        '<div class="mem-card-top">' +
          avatar +
          badgeTag(m.badge) +
        '</div>' +
        '<h2 class="mem-name">' + esc(m.displayName) + '</h2>' +
        title +
        meta +
      '</a>';
  }

  var state = { page: 1, q: '', sort: 'joined', loading: false };

  function render(data) {
    var members = (data && data.members) || [];
    if (!members.length) {
      grid.innerHTML = state.q
        ? '<p class="mem-state">Nobody here by that name. Try fewer letters.</p>'
        : '<p class="mem-state">The crypt is empty. A name appears the first time someone signs in.</p>';
      countEl.textContent = '';
      pager.hidden = true;
      return;
    }

    grid.innerHTML = members.map(card).join('');

    var total = data.total || members.length;
    countEl.textContent = total === 1 ? '1 member' : total.toLocaleString() + ' members';

    var pages = data.pages || 1;
    if (pages > 1) {
      pager.hidden = false;
      prevBtn.disabled = data.page <= 1;
      nextBtn.disabled = data.page >= pages;
      pageAt.textContent = 'Page ' + data.page + ' of ' + pages;
    } else {
      pager.hidden = true;
    }
  }

  function load() {
    if (state.loading) return;
    state.loading = true;
    var params = 'page=' + state.page + '&sort=' + encodeURIComponent(state.sort);
    if (state.q) params += '&q=' + encodeURIComponent(state.q);

    fetch('/api/members?' + params, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('Could not load members.');
        return r.json();
      })
      .then(function (data) {
        state.page = data.page || state.page;
        render(data);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(function (err) {
        grid.innerHTML = '<p class="mem-state">' + esc(err.message) + '</p>';
        countEl.textContent = '';
        pager.hidden = true;
      })
      .finally(function () { state.loading = false; });
  }

  var debounce;
  if (searchEl) {
    searchEl.addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        var q = searchEl.value.trim();
        /* The API ignores a one-character term; mirror that here so a single
           keystroke does not blank the list, and treat <2 as "no filter". */
        state.q = q.length >= 2 ? q : '';
        state.page = 1;
        load();
      }, 250);
    });
  }

  sortBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.classList.contains('active')) return;
      sortBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.sort = btn.dataset.sort === 'name' ? 'name' : 'joined';
      state.page = 1;
      load();
    });
  });

  if (prevBtn) prevBtn.addEventListener('click', function () {
    if (state.page > 1) { state.page--; load(); }
  });
  if (nextBtn) nextBtn.addEventListener('click', function () {
    state.page++; load();
  });

  load();
})();
