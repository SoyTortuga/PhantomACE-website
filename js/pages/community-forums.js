/* ══════════════════════════════════════════════
   COMMUNITY FORUM — client

   Two pages share this file and are told apart by which view element is
   present: community.html has #forumView (boards, then one board's
   topics); thread.html has #threadView (one topic, paged).

   Everything comes from /api/forum/*. The localStorage prototype that used
   to live here is gone, not kept as a fallback — a fallback that silently
   swallowed posts when the API was down would be worse than an error.

   Who you are comes from getSession() in auth.js — the same cookie the
   header reads. It decides what to DRAW: a composer, a reply box, edit
   and delete on your own posts. It decides nothing about what is
   ALLOWED; the server refuses on its own terms and the refusal is shown
   as written. Moderation (pin, lock, delete-any) is step 4.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var TITLE_MAX = 120;
  var BODY_MAX = 8000;

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

  function me() {
    try { return typeof getSession === 'function' ? getSession() : null; } catch (e) { return null; }
  }
  /* Display only. The server decides with the moderator list. */
  function looksLikeStaff(sess) {
    return !!sess && (sess.role === 'moderator' || sess.role === 'broadcaster');
  }
  function login() {
    if (typeof loginWithTwitch === 'function') loginWithTwitch();
    else location.href = '/api/auth/twitch?return_to=' + encodeURIComponent(location.pathname + location.search);
  }

  /** The author line every post and topic row carries: avatar, name linked
      to their profile, equipped badge, equipped title. `authors` is the map
      the API sends alongside the page. */
  function authorLine(authors, userId, cls) {
    var a = (authors && authors[userId]) || { displayName: 'Someone', login: '', avatar: '', title: null, badge: null };
    var inner =
      (a.avatar ? '<img class="forum-author-avatar" src="' + esc(a.avatar) + '" alt="">' : '<span class="forum-author-avatar forum-author-blank"></span>') +
      '<span class="forum-author-name">' + esc(a.displayName) + '</span>' +
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

  function api(path, body) {
    var opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' }
      : { cache: 'no-store' };
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
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

  /* Any request that failed, said plainly where the person is looking. */
  function showError(el, r) {
    el.textContent = (r && r.data && r.data.error) || 'Something went wrong. Try again.';
    el.hidden = false;
  }

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
      }).join('') + '</div>';
    }).catch(function () { failed(view, 'The forum is unavailable right now.'); });
  }

  /* ── One board ───────────────────────────────────────────────────── */

  function composerHtml(category) {
    var sess = me();
    if (!sess) {
      return '<button class="btn-primary forum-new-btn" type="button" data-act="login">Log in to post</button>';
    }
    if (category.staffOnly && !looksLikeStaff(sess)) return '';
    return '<button class="btn-primary forum-new-btn" type="button" data-act="new-topic">New Topic</button>';
  }

  function composerForm() {
    return '<form id="newThreadForm" class="forum-new-form" hidden>' +
      '<input type="text" id="newThreadTitle" class="forum-input" placeholder="Topic title" maxlength="' + TITLE_MAX + '" required>' +
      '<textarea id="newThreadBody" class="forum-textarea" placeholder="What is on your mind?" rows="5" maxlength="' + BODY_MAX + '" required></textarea>' +
      '<div class="forum-error" id="newThreadError" hidden></div>' +
      '<div class="forum-form-actions">' +
        '<button class="btn-primary" type="submit">Post topic</button>' +
        '<button class="pill-btn" type="button" data-act="cancel-topic">Cancel</button>' +
      '</div>' +
    '</form>';
  }

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
        '<div class="forum-thread-header-right"><span class="forum-thread-count">' + d.total + ' ' + (d.total === 1 ? 'topic' : 'topics') + '</span>' +
        composerHtml(d.category) + '</div></div>' + composerForm();
      if (!d.threads.length) {
        html += '<div class="forum-empty card"><p>No topics here yet.' + (me() ? ' Start one.' : '') + '</p></div>';
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
      view.innerHTML = html + pager(d.page, d.pages, hrefFor);
      wireComposer(view, categoryId);
    }).catch(function () { failed(view, 'The forum is unavailable right now.'); });
  }

  function wireComposer(view, categoryId) {
    var form = view.querySelector('#newThreadForm');
    if (!form) return;
    var title = form.querySelector('#newThreadTitle');
    var body = form.querySelector('#newThreadBody');
    var err = form.querySelector('#newThreadError');
    var submit = form.querySelector('button[type=submit]');

    view.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'login') login();
      if (a === 'new-topic') { form.hidden = false; title.focus(); act.hidden = true; }
      if (a === 'cancel-topic') {
        form.hidden = true; title.value = ''; body.value = ''; err.hidden = true;
        var btn = view.querySelector('[data-act=new-topic]'); if (btn) btn.hidden = false;
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.hidden = true;
      submit.disabled = true;
      api('/api/forum/threads', { category: categoryId, title: title.value, body: body.value }).then(function (r) {
        if (!r.ok) { submit.disabled = false; return showError(err, r); }
        location.href = '/thread/' + encodeURIComponent(r.data.id);
      }).catch(function () { submit.disabled = false; showError(err, null); });
    });
  }

  /* ── One topic ───────────────────────────────────────────────────── */

  function postHtml(p, authors, mine, op) {
    if (p.deleted) {
      return '<div class="card forum-post forum-post-tombstone" id="post-' + esc(p.id) + '">' +
        '<div class="forum-post-header">' + authorLine(authors, p.userId) +
          '<span class="forum-post-time">' + timeAgo(p.createdAt) + '</span></div>' +
        '<div class="forum-post-body forum-post-removed">' +
          (p.deleted === 'moderator' ? 'Removed by a moderator.' : 'Removed by the author.') + '</div>' +
      '</div>';
    }
    var actions = mine
      ? '<span class="forum-post-actions">' +
          '<button type="button" data-act="edit" data-id="' + esc(p.id) + '">Edit</button>' +
          '<button type="button" data-act="delete" data-id="' + esc(p.id) + '">Delete</button>' +
        '</span>'
      : '';
    return '<div class="card forum-post' + (op ? ' forum-post-op' : '') + '" id="post-' + esc(p.id) + '" data-post="' + esc(p.id) + '">' +
      '<div class="forum-post-header">' + authorLine(authors, p.userId) +
        '<span class="forum-post-time">' + timeAgo(p.createdAt) +
          ' <span class="forum-post-edited"' + (p.editedAt ? '' : ' hidden') + '>(edited)</span></span>' +
        actions + '</div>' +
      '<div class="forum-post-body">' + esc(p.body).replace(/\n/g, '<br>') + '</div>' +
      '<div class="forum-error" hidden></div>' +
    '</div>';
  }

  function replyBoxHtml(t) {
    if (t.locked) return '<div class="forum-readonly-note">This topic is locked.</div>';
    var sess = me();
    if (!sess) {
      return '<div class="forum-reply-prompt card"><p>Log in to reply to this topic.</p>' +
        '<button class="btn-primary" type="button" data-act="login">Log In</button></div>';
    }
    return '<form id="replyForm" class="forum-reply-form">' +
      '<textarea id="replyBody" class="forum-textarea" placeholder="Write a reply" rows="4" maxlength="' + BODY_MAX + '" required></textarea>' +
      '<div class="forum-error" id="replyError" hidden></div>' +
      '<div class="forum-form-actions"><button class="btn-primary" type="submit">Reply</button></div>' +
    '</form>';
  }

  function renderThread(view, id, page) {
    api('/api/forum/thread?id=' + encodeURIComponent(id) + '&page=' + page).then(function (r) {
      if (!r.ok) {
        crumbs([{ text: 'Not found' }]);
        document.title = 'Topic | PhantomACE';
        return failed(view, r.status === 404 ? 'That topic is not here. It may have been removed.' : (r.data.error || 'The forum is unavailable right now.'));
      }
      var d = r.data, t = d.thread, authors = d.authors || {};
      var sess = me();
      var myId = sess && sess.user_id != null ? String(sess.user_id) : null;
      document.title = t.title + ' | PhantomACE';
      crumbs([{ text: t.categoryName, href: '/community?c=' + encodeURIComponent(t.categoryId) }, { text: t.title }]);
      var hrefFor = function (p) { return '/thread/' + encodeURIComponent(id) + (p > 1 ? '?page=' + p : ''); };

      var html = '<div class="forum-thread-view">';
      html += '<div class="forum-topic-head">' +
        (t.pinned ? '<span class="forum-flag">Pinned</span>' : '') +
        (t.locked ? '<span class="forum-flag forum-flag-locked">Locked</span>' : '') +
        '<h2 class="forum-post-title">' + esc(t.title) + '</h2></div>';
      html += d.posts.map(function (p, i) {
        var mine = !!myId && String(p.userId) === myId && !t.locked;
        return postHtml(p, authors, mine, d.page === 1 && i === 0);
      }).join('');
      html += pager(d.page, d.pages, hrefFor);
      html += replyBoxHtml(t);
      view.innerHTML = html + '</div>';
      wireThread(view, id);

      if (location.hash && /^#post-[0-9]+$/.test(location.hash)) {
        var target = document.getElementById(location.hash.slice(1));
        if (target) target.scrollIntoView();
      }
    }).catch(function () { failed(view, 'The forum is unavailable right now.'); });
  }

  function wireThread(view, threadId) {
    view.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'login') return login();
      var card = act.closest('[data-post]');
      if (a === 'edit' && card) return startEdit(card);
      if (a === 'delete' && card) return deletePost(card);
      if (a === 'cancel-edit' && card) return endEdit(card);
    });

    var form = view.querySelector('#replyForm');
    if (form) {
      var body = form.querySelector('#replyBody');
      var err = form.querySelector('#replyError');
      var submit = form.querySelector('button[type=submit]');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        err.hidden = true;
        submit.disabled = true;
        api('/api/forum/thread', { id: threadId, body: body.value }).then(function (r) {
          if (!r.ok) { submit.disabled = false; return showError(err, r); }
          /* Land on the reply, wherever it paged to. A same-page hash
             change does not reload, so force it. */
          var url = '/thread/' + encodeURIComponent(threadId) + (r.data.page > 1 ? '?page=' + r.data.page : '') + '#post-' + r.data.postId;
          location.href = url;
          if (location.pathname + location.search === url.split('#')[0]) location.reload();
        }).catch(function () { submit.disabled = false; showError(err, null); });
      });
    }
  }

  /* Editing happens in place: the body becomes a textarea, Save posts it,
     the rendered body comes back with the "(edited)" mark. */
  function startEdit(card) {
    if (card.querySelector('textarea')) return;
    var bodyEl = card.querySelector('.forum-post-body');
    var current = bodyEl.innerHTML.replace(/<br\s*\/?>/g, '\n');
    var tmp = document.createElement('div'); tmp.innerHTML = current;
    var text = tmp.textContent;
    bodyEl.hidden = true;
    var editor = document.createElement('form');
    editor.className = 'forum-edit-form';
    editor.innerHTML =
      '<textarea class="forum-textarea" rows="5" maxlength="' + BODY_MAX + '" required></textarea>' +
      '<div class="forum-form-actions"><button class="btn-primary" type="submit">Save</button>' +
      '<button class="pill-btn" type="button" data-act="cancel-edit">Cancel</button></div>';
    editor.querySelector('textarea').value = text;
    bodyEl.insertAdjacentElement('afterend', editor);
    editor.querySelector('textarea').focus();
    editor.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = card.querySelector('.forum-error');
      err.hidden = true;
      var submit = editor.querySelector('button[type=submit]');
      submit.disabled = true;
      api('/api/forum/post', { action: 'edit', id: card.getAttribute('data-post'), body: editor.querySelector('textarea').value })
        .then(function (r) {
          if (!r.ok) { submit.disabled = false; return showError(err, r); }
          bodyEl.innerHTML = esc(r.data.body).replace(/\n/g, '<br>');
          card.querySelector('.forum-post-edited').hidden = false;
          endEdit(card);
        }).catch(function () { submit.disabled = false; showError(err, null); });
    });
  }

  function endEdit(card) {
    var editor = card.querySelector('.forum-edit-form');
    if (editor) editor.remove();
    card.querySelector('.forum-post-body').hidden = false;
    card.querySelector('.forum-error').hidden = true;
  }

  function deletePost(card) {
    if (!window.confirm('Remove this post? It will show as removed by you.')) return;
    var err = card.querySelector('.forum-error');
    err.hidden = true;
    api('/api/forum/post', { action: 'delete', id: card.getAttribute('data-post') }).then(function (r) {
      if (!r.ok) return showError(err, r);
      location.reload();
    }).catch(function () { showError(err, null); });
  }

  /* ── Which page am I ─────────────────────────────────────────────── */

  /* A card with data-href goes where its title link goes when the click
     lands anywhere else on it. A click on a real link or control inside
     is that element's own business. */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.target.closest('a, button, input, textarea, form')) return;
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
