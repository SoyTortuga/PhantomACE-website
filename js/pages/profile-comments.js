/* ══════════════════════════════════════════════
   PROFILE COMMENTS — the wall under a profile

   profile.js renders the person and then announces it with a
   'profile:rendered' event carrying the record; this listens, asks
   /api/forum/comments for their wall, and draws it into the section
   profile.js left for it. Two scripts rather than one because the
   profile is the cosmetics agent's and the forum is the chat-system
   agent's, and the seam between them should be one event, not a merge.

   A comment is a forum post. Editing and deleting your own, reporting
   somebody else's, and the moderator's Remove all go to the same routes
   the thread page uses, and the markup reuses the thread page's classes
   from community.css so a comment looks like a post everywhere.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var BODY_MAX = 8000;
  var REASON_MAX = 500;

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
  function looksLikeStaff(sess) {
    return !!sess && (sess.role === 'moderator' || sess.role === 'broadcaster');
  }
  function login() {
    if (typeof loginWithTwitch === 'function') loginWithTwitch();
    else location.href = '/api/auth/twitch?return_to=' + encodeURIComponent(location.pathname + location.search);
  }

  function api(path, body) {
    var opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' }
      : { cache: 'no-store' };
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }

  function showError(el, r) {
    el.textContent = (r && r.data && r.data.error) || 'Something went wrong. Try again.';
    el.hidden = false;
  }

  function authorLine(authors, userId) {
    var a = (authors && authors[userId]) || { displayName: 'Someone', login: '', avatar: '', title: null, badge: null };
    var inner =
      (a.avatar ? '<img class="forum-author-avatar" src="' + esc(a.avatar) + '" alt="">' : '<span class="forum-author-avatar forum-author-blank"></span>') +
      '<span class="forum-author-name">' + esc(a.displayName) + '</span>' +
      (a.badge ? (a.badge.image
        ? '<img class="forum-author-badge" src="' + esc(a.badge.image) + '" alt="" title="' + esc(a.badge.name) + '">'
        : '<span class="forum-author-badge forum-author-badge-fallback" title="' + esc(a.badge.name) + '">' + (a.badge.founder ? '★' : '◆') + '</span>') : '') +
      (a.title ? '<span class="forum-author-title">' + esc(a.title.name) + '</span>' : '');
    return a.login
      ? '<a class="forum-author" href="/user/' + encodeURIComponent(a.login) + '">' + inner + '</a>'
      : '<span class="forum-author">' + inner + '</span>';
  }

  /* The identities the wall arrived with, so an edit that names somebody
     new can link them without a reload. */
  var currentAuthors = {};

  /* A body, escaped, with the @names the SERVER resolved turned into
     profile links — those and no others. Escaped first, then linked. */
  function linkMentions(post, authors) {
    var html = esc(post.body).replace(/\n/g, '<br>');
    var ids = post.mentions || [];
    if (!ids.length) return html;
    var byLogin = {};
    ids.forEach(function (id) { var a = authors && authors[id]; if (a && a.login) byLogin[a.login.toLowerCase()] = a; });
    return html.replace(/(^|[^A-Za-z0-9_\/.])@([A-Za-z0-9_]{3,25})(?![A-Za-z0-9_])/g, function (m, pre, name) {
      var a = byLogin[name.toLowerCase()];
      if (!a) return m;
      return pre + '<a class="forum-mention" href="/user/' + encodeURIComponent(a.login) + '">@' + esc(name) + '</a>';
    });
  }

  function reasonForm(act, id, placeholder, submitLabel) {
    return '<form class="forum-reason-form" data-reason-act="' + esc(act) + '" data-id="' + esc(id) + '" hidden>' +
      '<input type="text" class="forum-input" maxlength="' + REASON_MAX + '" placeholder="' + esc(placeholder) + '" required>' +
      '<div class="forum-error" hidden></div>' +
      '<div class="forum-form-actions">' +
        '<button class="btn-primary" type="submit">' + esc(submitLabel) + '</button>' +
        '<button class="pill-btn" type="button" data-act="cancel-reason">Cancel</button>' +
      '</div></form>';
  }

  function commentHtml(c, authors, ctx) {
    var mine = !!ctx.myId && String(c.userId) === ctx.myId;
    var controls = [];
    if (mine) {
      controls.push('<button type="button" data-act="edit">Edit</button>');
      controls.push('<button type="button" data-act="delete">Delete</button>');
    }
    if (ctx.myId && !mine) controls.push('<button type="button" data-act="show-reason" data-form="report">Report</button>');
    if (ctx.staff && !mine) controls.push('<button type="button" data-act="show-reason" data-form="delete-post" class="forum-mod-btn">Remove</button>');
    return '<div class="card forum-post" id="post-' + esc(c.id) + '" data-post="' + esc(c.id) + '">' +
      '<div class="forum-post-header">' + authorLine(authors, c.userId) +
        '<span class="forum-post-time">' + timeAgo(c.createdAt) +
          ' <span class="forum-post-edited"' + (c.editedAt ? '' : ' hidden') + '>(edited)</span></span>' +
        (controls.length ? '<span class="forum-post-actions">' + controls.join('') + '</span>' : '') + '</div>' +
      '<div class="forum-post-body">' + linkMentions(c, authors) + '</div>' +
      '<div class="forum-error" hidden></div>' +
      (ctx.myId && !mine ? reasonForm('report', c.id, 'Why should a moderator look at this?', 'Send report') : '') +
      (ctx.staff && !mine ? reasonForm('delete-post', c.id, 'Reason (the author will see it)', 'Remove comment') : '') +
    '</div>';
  }

  function composerHtml(d, ctx) {
    if (!d.enabled) {
      return '<div class="forum-readonly-note">' +
        (ctx.isOwner ? 'Comments on your profile are off.' : esc(d.owner.displayName) + ' has turned comments off.') + '</div>';
    }
    if (!ctx.myId) {
      return '<div class="forum-reply-prompt card"><p>Log in to leave a comment.</p>' +
        '<button class="btn-primary" type="button" data-act="login">Log In</button></div>';
    }
    return '<form id="commentForm" class="forum-reply-form">' +
      '<textarea id="commentBody" class="forum-textarea" placeholder="Leave a comment' + (ctx.isOwner ? '' : ' for ' + esc(d.owner.displayName)) + '" rows="3" maxlength="' + BODY_MAX + '" required></textarea>' +
      '<div class="forum-error" id="commentError" hidden></div>' +
      '<div class="forum-form-actions"><button class="btn-primary" type="submit">Comment</button></div>' +
    '</form>';
  }

  /** The owner's switches, shown only to the owner. */
  function switchHtml(d) {
    return '<label class="prof-comments-switch">' +
      '<input type="checkbox" data-setting="commentsEnabled"' + (d.enabled ? ' checked' : '') + '> Allow comments on my profile</label>' +
      '<label class="prof-comments-switch">' +
      '<input type="checkbox" data-setting="mentionsEnabled"' + (d.mentionsEnabled !== false ? ' checked' : '') + '> Let people @mention me</label>' +
      '<div class="forum-error" id="settingsError" hidden></div>';
  }

  function render(host, userId, page) {
    api('/api/forum/comments?id=' + encodeURIComponent(userId) + '&page=' + page).then(function (r) {
      if (!r.ok) {
        host.innerHTML = '<div class="forum-empty card"><p>' + esc(r.data.error || 'Comments are unavailable right now.') + '</p></div>';
        return;
      }
      var d = r.data, authors = d.authors || {};
      currentAuthors = authors;
      var sess = me();
      var ctx = {
        myId: sess && sess.user_id != null ? String(sess.user_id) : null,
        staff: looksLikeStaff(sess),
        isOwner: !!(d.viewer && d.viewer.isOwner),
      };
      var html = '';
      if (ctx.isOwner) html += switchHtml(d);
      html += composerHtml(d, ctx);
      if (!d.comments.length) {
        html += '<div class="forum-empty card prof-comments-empty"><p>' + (d.enabled ? 'No comments yet.' : '') + '</p></div>';
      } else {
        html += d.comments.map(function (c) { return commentHtml(c, authors, ctx); }).join('');
        if (d.pages > 1) {
          html += '<nav class="forum-pagination" aria-label="Pages">' +
            (d.page > 1 ? '<a href="?cpage=' + (d.page - 1) + '">&lsaquo; Newer</a>' : '<span class="forum-page-off">&lsaquo; Newer</span>') +
            '<span class="forum-page-num">Page ' + d.page + ' of ' + d.pages + '</span>' +
            (d.page < d.pages ? '<a href="?cpage=' + (d.page + 1) + '">Older &rsaquo;</a>' : '<span class="forum-page-off">Older &rsaquo;</span>') +
          '</nav>';
        }
      }
      host.innerHTML = html;
      wire(host, userId, page);
    }).catch(function () {
      host.innerHTML = '<div class="forum-empty card"><p>Comments are unavailable right now.</p></div>';
    });
  }

  function wire(host, userId, page) {
    var switches = host.querySelectorAll('input[data-setting]');
    for (var s = 0; s < switches.length; s++) {
      switches[s].addEventListener('change', function () {
        var sw = this;
        var err = host.querySelector('#settingsError');
        err.hidden = true;
        sw.disabled = true;
        var patch = { action: 'settings' };
        patch[sw.getAttribute('data-setting')] = sw.checked;
        api('/api/forum/comments', patch).then(function (r) {
          if (!r.ok) { sw.checked = !sw.checked; sw.disabled = false; return showError(err, r); }
          render(host, userId, page);
        }).catch(function () { sw.checked = !sw.checked; sw.disabled = false; showError(err, null); });
      });
    }

    var form = host.querySelector('#commentForm');
    if (form) {
      var body = form.querySelector('#commentBody');
      var err = form.querySelector('#commentError');
      var submit = form.querySelector('button[type=submit]');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        err.hidden = true;
        submit.disabled = true;
        api('/api/forum/comments', { id: userId, body: body.value }).then(function (r) {
          if (!r.ok) { submit.disabled = false; return showError(err, r); }
          render(host, userId, 1);
        }).catch(function () { submit.disabled = false; showError(err, null); });
      });
    }

    host.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'login') return login();
      var card = act.closest('[data-post]');
      if (a === 'edit' && card) return startEdit(card);
      if (a === 'delete' && card) return deleteOwn(card, host, userId, page);
      if (a === 'cancel-edit' && card) return endEdit(card);
      if (a === 'show-reason' && card) {
        var f = card.querySelector('.forum-reason-form[data-reason-act="' + act.getAttribute('data-form') + '"]');
        if (f) { f.hidden = false; f.querySelector('input').focus(); }
      }
      if (a === 'cancel-reason') { var rf = act.closest('.forum-reason-form'); if (rf) rf.hidden = true; }
    });

    host.addEventListener('submit', function (e) {
      var form = e.target.closest('.forum-reason-form');
      if (!form) return;
      e.preventDefault();
      var act = form.getAttribute('data-reason-act');
      var id = form.getAttribute('data-id');
      var reason = form.querySelector('input').value;
      var err = form.querySelector('.forum-error');
      var submit = form.querySelector('button[type=submit]');
      err.hidden = true;
      submit.disabled = true;
      var req = act === 'report'
        ? api('/api/forum/post', { action: 'report', id: id, reason: reason })
        : api('/api/forum/moderate', { action: 'delete-post', id: id, reason: reason });
      req.then(function (r) {
        if (!r.ok) { submit.disabled = false; return showError(err, r); }
        if (act === 'report') {
          form.outerHTML = '<div class="forum-reported">Reported. A moderator will take a look.</div>';
          var b = host.querySelector('[data-post="' + id + '"] [data-form="report"]');
          if (b) b.remove();
          return;
        }
        render(host, userId, page);
      }).catch(function () { submit.disabled = false; showError(err, null); });
    });
  }

  function startEdit(card) {
    if (card.querySelector('textarea')) return;
    var bodyEl = card.querySelector('.forum-post-body');
    var tmp = document.createElement('div');
    tmp.innerHTML = bodyEl.innerHTML.replace(/<br\s*\/?>/g, '\n');
    var text = tmp.textContent;
    bodyEl.hidden = true;
    var editor = document.createElement('form');
    editor.className = 'forum-edit-form';
    editor.innerHTML =
      '<textarea class="forum-textarea" rows="4" maxlength="' + BODY_MAX + '" required></textarea>' +
      '<div class="forum-form-actions"><button class="btn-primary" type="submit">Save</button>' +
      '<button class="pill-btn" type="button" data-act="cancel-edit">Cancel</button></div>';
    editor.querySelector('textarea').value = text;
    bodyEl.insertAdjacentElement('afterend', editor);
    editor.querySelector('textarea').focus();
    editor.addEventListener('submit', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var err = card.querySelector('.forum-error');
      err.hidden = true;
      var submit = editor.querySelector('button[type=submit]');
      submit.disabled = true;
      api('/api/forum/post', { action: 'edit', id: card.getAttribute('data-post'), body: editor.querySelector('textarea').value })
        .then(function (r) {
          if (!r.ok) { submit.disabled = false; return showError(err, r); }
          Object.assign(currentAuthors, r.data.authors || {});
          bodyEl.innerHTML = linkMentions({ body: r.data.body, mentions: r.data.mentions || [] }, currentAuthors);
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

  function deleteOwn(card, host, userId, page) {
    if (!window.confirm('Remove this comment?')) return;
    var err = card.querySelector('.forum-error');
    err.hidden = true;
    api('/api/forum/post', { action: 'delete', id: card.getAttribute('data-post') }).then(function (r) {
      if (!r.ok) return showError(err, r);
      render(host, userId, page);
    }).catch(function () { showError(err, null); });
  }

  document.addEventListener('profile:rendered', function (e) {
    var host = document.getElementById('profComments');
    var p = e.detail;
    if (!host || !p || !p.userId) return;
    var page = Math.max(1, parseInt(new URLSearchParams(location.search).get('cpage') || '1', 10) || 1);
    render(host, String(p.userId), page);
  });
})();
