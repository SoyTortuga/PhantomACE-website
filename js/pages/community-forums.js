/* ══════════════════════════════════════════════
   COMMUNITY FORUM — client

   Two pages share this file and are told apart by which view element is
   present: community.html has #forumView (boards, then one board's
   topics); thread.html has #threadView (one topic, paged).

   Everything comes from /api/forum/*. The localStorage prototype that used
   to live here is gone, not kept as a fallback — a fallback that silently
   swallowed posts when the API was down would be worse than an error.

   Read-only for now: posting, replying and moderation arrive with the
   next steps of docs/FORUM-PLAN.md, and the page says so rather than
   showing a form that goes nowhere.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function timeAgo(iso) {
    var t = Date.parse(iso || '');
    if (!t) return '';
    var mins = Math.floor((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    if (days < 30) return days + 'd ago';
    return new Date(t).toLocaleDateString();
  }

  /** The author line every post and topic row carries: avatar, name linked
      to their profile, equipped title, equipped badge. `authors` is the map
      the API sends alongside the page. */
  function authorLine(authors, userId, cls) {
    var a = (authors && authors[userId]) || { displayName: 'Someone', login: '', avatar: '', title: null, badge: null };
    var name = esc(a.displayName);
    var inner =
      (a.avatar ? '<img class="forum-author-avatar" src="' + esc(a.avatar) + '" alt="">' : '<span class="forum-author-avatar forum-author-blank"></span>') +
      '<span class="forum-author-name">' + name + '</span>' +
      (a.badge ? badgeArt(a.badge) : '') +
      (a.title ? '<span class="forum-author-title">' + esc(a.title.name) + '</span>' : '');
    return a.login
      ? '<a class="forum-author ' + (cls || '') + '" href="/user/' + encodeURIComponent(a.login) + '">' + inner + '</a>'
      : '<span class="forum-author ' + (cls || '') + '">' + inner + '</span>';
  }

  function badgeArt(b) {
    return b.image
      ? '<img class="forum-author-badge" src="' + esc(b.image) + '" alt="" title="' + esc(b.name) + '">'
      : '<span class="forum-author-badge forum-author-badge-fallback" title="' + esc(b.name) + '">' + (b.founder ? '★' : '◆') + '</span>';
  }

  function crumbs(parts) {
    var el = document.getElementById('forumBreadcrumb');
    if (!el) return;
    var html = '<a href="/community">Forums</a>';
    parts.forEach(function (p, i) {
      html += ' <span class="bc-sep">/</span> ';
      html += (i === parts.length - 1 || !p.href)
        ? '<span class="bc-current">' + esc(p.text) + '</span>'
        : '<a href="' + esc(p.href) + '">' + esc(p.text) + '</a>';
    });
    el.innerHTML = html;
  }

  function failed(view, what) {
    view.innerHTML = '<div class="forum-empty card"><p>' + esc(what) + '</p></div>';
  }

  function api(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }

  function pager(page, pages, hrefFor) {
    if (pages <= 1) return '';
    var html = '<nav class="forum-pagination" aria-label="Pages">';
    html += page > 1 ? '<a href="' + esc(hrefFor(page - 1)) + '">&lsaquo; Newer</a>' : '<span class="forum-page-off">&lsaquo; Newer</span>';
    html += '<span class="forum-page-num">Page ' + page + ' of ' + pages + '</span>';
    html += page < pages ? '<a href="' + esc(hrefFor(page + 1)) + '">Older &rsaquo;</a>' : '<span class="forum-page-off">Older &rsaquo;</span>';
    return html + '</nav>';
  }

  var readOnlyNote =
    '<div class="forum-readonly-note">Reading is open to everyone. Posting arrives with the next update.</div>';

  /* ── The boards ──────────────────────────────────────────────────── */

  function renderHome(view) {
    crumbs([]);
    api('/api/forum/categories').then(function (r) {
      if (!r.ok) return failed(view, r.data.error || 'The forum is unavailable right now.');
      var authors = r.data.authors || {};
      view.innerHTML = '<div class="forum-categories">' + r.data.categories.map(function (c) {
        var newest = c.newest
          ? '<div class="forum-category-newest">' +
              '<a href="/thread/' + esc(c.newest.id) + '">' + esc(c.newest.title) + '</a>' +
              '<span class="forum-category-newest-meta">' + authorLine(authors, c.newest.userId, 'forum-author-sm') +
              '<span class="forum-thread-time">' + timeAgo(c.newest.at) + '</span></span>' +
            '</div>'
          : '<div class="forum-category-newest forum-category-quiet">No topics yet</div>';
        var flags = (c.staffOnly ? '<span class="forum-flag">Staff posts</span>' : '') +
                    (c.subOnly ? '<span class="forum-flag">Subscribers</span>' : '');
        /* A div, not an <a>: the author line inside is a link of its own,
           and an anchor inside an anchor is closed by the parser at the
           inner one — the card ends early and the rest spills out below
           it. data-href makes the remainder of the card clickable. */
        var href = '/community?c=' + encodeURIComponent(c.id);
        return '<div class="card forum-category" data-href="' + esc(href) + '">' +
          '<div class="forum-category-info">' +
            '<div class="forum-category-name"><a href="' + esc(href) + '">' + esc(c.name) + '</a>' + flags + '</div>' +
            '<div class="forum-category-desc">' + esc(c.description) + '</div>' +
            newest +
          '</div>' +
          '<div class="forum-category-stats">' +
            '<div class="forum-stat"><span class="forum-stat-val">' + c.threadCount + '</span><span class="forum-stat-label">Topics</span></div>' +
            '<div class="forum-stat"><span class="forum-stat-val">' + c.postCount + '</span><span class="forum-stat-label">Posts</span></div>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>' + readOnlyNote;
    }).catch(function () { failed(view, 'The forum is unavailable right now.'); });
  }

  /* ── One board ───────────────────────────────────────────────────── */

  function renderBoard(view, categoryId, page) {
    api('/api/forum/threads?category=' + encodeURIComponent(categoryId) + '&page=' + page).then(function (r) {
      if (!r.ok) {
        crumbs([{ text: 'Not found' }]);
        return failed(view, r.status === 404 ? 'There is no board by that name.' : (r.data.error || 'The forum is unavailable right now.'));
      }
      var d = r.data, authors = d.authors || {};
      crumbs([{ text: d.category.name }]);
      var hrefFor = function (p) { return '/community?c=' + encodeURIComponent(categoryId) + (p > 1 ? '&page=' + p : ''); };
      var html = '<div class="forum-thread-header"><h3>' + esc(d.category.name) + '</h3>' +
        '<span class="forum-thread-count">' + d.total + ' ' + (d.total === 1 ? 'topic' : 'topics') + '</span></div>';
      if (!d.threads.length) {
        html += '<div class="forum-empty card"><p>No topics here yet.</p></div>';
      } else {
        html += '<div class="forum-thread-list">' + d.threads.map(function (t) {
          var href = '/thread/' + esc(t.id);
          return '<div class="card forum-thread-row' + (t.pinned ? ' forum-thread-pinned' : '') + '" data-href="' + href + '">' +
            '<div class="forum-thread-title">' +
              (t.pinned ? '<span class="forum-flag">Pinned</span>' : '') +
              (t.locked ? '<span class="forum-flag forum-flag-locked">Locked</span>' : '') +
              '<a href="' + href + '">' + esc(t.title) + '</a></div>' +
            '<div class="forum-thread-meta">' +
              authorLine(authors, t.userId, 'forum-author-sm') +
              '<span class="forum-thread-time">' + timeAgo(t.lastPostAt) + '</span>' +
              '<span class="forum-thread-replies">' + t.replyCount + ' ' + (t.replyCount === 1 ? 'reply' : 'replies') + '</span>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';
      }
      view.innerHTML = html + pager(d.page, d.pages, hrefFor) + readOnlyNote;
    }).catch(function () { failed(view, 'The forum is unavailable right now.'); });
  }

  /* ── One topic ───────────────────────────────────────────────────── */

  function renderThread(view, id, page) {
    api('/api/forum/thread?id=' + encodeURIComponent(id) + '&page=' + page).then(function (r) {
      if (!r.ok) {
        crumbs([{ text: 'Not found' }]);
        document.title = 'Topic | PhantomACE';
        return failed(view, r.status === 404 ? 'That topic is not here. It may have been removed.' : (r.data.error || 'The forum is unavailable right now.'));
      }
      var d = r.data, t = d.thread, authors = d.authors || {};
      document.title = t.title + ' | PhantomACE';
      crumbs([{ text: t.categoryName, href: '/community?c=' + encodeURIComponent(t.categoryId) }, { text: t.title }]);
      var hrefFor = function (p) { return '/thread/' + encodeURIComponent(id) + (p > 1 ? '?page=' + p : ''); };

      var html = '<div class="forum-thread-view">';
      html += '<div class="forum-topic-head">' +
        (t.pinned ? '<span class="forum-flag">Pinned</span>' : '') +
        (t.locked ? '<span class="forum-flag forum-flag-locked">Locked</span>' : '') +
        '<h2 class="forum-post-title">' + esc(t.title) + '</h2></div>';

      html += d.posts.map(function (p, i) {
        var op = d.page === 1 && i === 0;
        if (p.deleted) {
          return '<div class="card forum-post forum-post-tombstone">' +
            '<div class="forum-post-header">' + authorLine(authors, p.userId) +
              '<span class="forum-post-time">' + timeAgo(p.createdAt) + '</span></div>' +
            '<div class="forum-post-body forum-post-removed">' +
              (p.deleted === 'moderator' ? 'Removed by a moderator.' : 'Removed by the author.') + '</div>' +
          '</div>';
        }
        return '<div class="card forum-post' + (op ? ' forum-post-op' : '') + '">' +
          '<div class="forum-post-header">' + authorLine(authors, p.userId) +
            '<span class="forum-post-time">' + timeAgo(p.createdAt) +
              (p.editedAt ? ' <span class="forum-post-edited">(edited)</span>' : '') + '</span></div>' +
          '<div class="forum-post-body">' + esc(p.body).replace(/\n/g, '<br>') + '</div>' +
        '</div>';
      }).join('');

      html += pager(d.page, d.pages, hrefFor);
      html += t.locked
        ? '<div class="forum-readonly-note">This topic is locked.</div>'
        : readOnlyNote;
      view.innerHTML = html + '</div>';
    }).catch(function () { failed(view, 'The forum is unavailable right now.'); });
  }

  /* ── Which page am I ─────────────────────────────────────────────── */

  /* A card with data-href goes where its title link goes when the click
     lands anywhere else on it. A click on a real link inside — the title,
     an author — is that link's own business. */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.target.closest('a, button, input, textarea')) return;
    var card = e.target.closest('[data-href]');
    if (card) location.href = card.getAttribute('data-href');
  });

  document.addEventListener('DOMContentLoaded', function () {
    var q = new URLSearchParams(location.search);
    var page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);

    var threadView = document.getElementById('threadView');
    if (threadView) {
      var m = location.pathname.match(/^\/thread\/([1-9][0-9]{0,17})\/?$/);
      var id = m ? m[1] : q.get('id');
      if (!id) { crumbs([{ text: 'Not found' }]); return failed(threadView, 'No topic was asked for.'); }
      return renderThread(threadView, id, page);
    }

    var view = document.getElementById('forumView');
    if (!view) return;
    var c = (q.get('c') || '').toLowerCase();
    if (c) renderBoard(view, c, page); else renderHome(view);
  });
})();
