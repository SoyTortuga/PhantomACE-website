/* ══════════════════════════════════════════════
   COMMUNITY FORUM — client

   Two pages share this file and are told apart by which view element is
   present: community.html has #forumView (boards, one board's topics, or
   the moderation queue via ?view=reports); thread.html has #threadView
   (one topic, paged).

   Everything comes from /api/forum/*. The localStorage prototype that used
   to live here is gone, not kept as a fallback — a fallback that silently
   swallowed posts when the API was down would be worse than an error.

   Who you are comes from getSession() in auth.js — the same cookie the
   header reads — and is used only to know which posts are yours. What
   you may DO (staff controls, New Topic, the reply box) comes from the
   `viewer` block each API answer carries, because the cookie's role does
   not know about site moderators or subscriber-only boards. Nothing here
   decides what is ALLOWED; the server refuses on its own terms and the
   refusal is shown as written.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var TITLE_MAX = 120;
  var BODY_MAX = 8000;
  var REASON_MAX = 500;
  var SEARCH_MAX = 100;
  /* The identities the current page arrived with, so an edit that names
     somebody new can link them without a reload. */
  var currentAuthors = {};

  /* The reactions a post can carry: the room guestbook's twelve stamps, by
     id, drawn here as their glyphs. The server owns the allowlist; this is
     only how they look. */
  var REACTION_GLYPH = {
    skull: '💀', ghost: '👻', pumpkin: '🎃', bat: '🦇', candle: '🕯️', rose: '🥀',
    crown: '👑', star: '✦', flame: '🔥', paw: '🐾', heart: '🖤', clover: '🍀',
  };
  var REACTION_ORDER = ['skull', 'ghost', 'pumpkin', 'bat', 'candle', 'rose', 'crown', 'star', 'flame', 'paw', 'heart', 'clover'];

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
  function login() {
    if (typeof loginWithTwitch === 'function') loginWithTwitch();
    else location.href = '/api/auth/twitch?return_to=' + encodeURIComponent(location.pathname + location.search);
  }

  /** The author line every post and topic row carries: avatar, name linked
      to their profile, equipped badge, equipped title. `authors` is the map
      the API sends alongside the page. */
  function authorLine(authors, userId, cls) {
    var a = (authors && authors[userId]) || { displayName: 'Someone', login: '', avatar: '', title: null, badge: null, nameEffect: null };
    /* The equipped name-effect variant rides along in a data attribute the
       server filled; paintNameEffects() turns it into the glow after the
       markup is live. Absent → the element stays plain. */
    var fx = a.nameEffect ? ' data-name-fx="' + esc(a.nameEffect) + '"' : '';
    var inner =
      (a.avatar ? '<img class="forum-author-avatar" src="' + esc(a.avatar) + '" alt="">' : '<span class="forum-author-avatar forum-author-blank"></span>') +
      '<span class="forum-author-name"' + fx + '>' + esc(a.displayName) + '</span>' +
      (a.badge ? badgeArt(a.badge) : '') +
      (a.title ? '<span class="forum-author-title">' + esc(a.title.name) + '</span>' : '');
    return a.login
      ? '<a class="forum-author ' + (cls || '') + '" href="/user/' + encodeURIComponent(a.login) + '">' + inner + '</a>'
      : '<span class="forum-author ' + (cls || '') + '">' + inner + '</span>';
  }

  /* ── Name effects ─────────────────────────────────────────────────────
     The shared cosmetics module (js/cosmetic-variants.js) owns the glow and
     its in-view/count-capped animation manager. We only feed it the name
     elements. `managed: true` is required so a busy board never animates
     more than the cap at once and only visible names animate. Every call is
     guarded: if the module failed to load, these are silent no-ops and chat
     still works. */
  function paintNameEffects(root) {
    var CV = window.CosmeticVariants;
    if (!CV || !root) return;
    var names = root.querySelectorAll('.forum-author-name');
    for (var i = 0; i < names.length; i++) {
      CV.applyNameFx(names[i], names[i].getAttribute('data-name-fx') || null, { managed: true });
    }
  }
  /* Release the manager's hold on names about to be discarded, so a
     re-render never leaks dead nodes into the animation cap or observer. */
  function clearNameEffects(root) {
    var CV = window.CosmeticVariants;
    if (!CV || !root) return;
    var names = root.querySelectorAll('.forum-author-name');
    for (var i = 0; i < names.length; i++) CV.applyNameFx(names[i], null);
  }
  /* Replace a view's contents and (re)apply name effects in one step: the
     old names are unregistered before they vanish, the new ones painted. */
  function setViewHtml(view, html) {
    clearNameEffects(view);
    view.innerHTML = html;
    paintNameEffects(view);
  }

  function badgeArt(b) {
    return b.image
      ? '<img class="forum-author-badge" src="' + esc(b.image) + '" alt="" title="' + esc(b.name) + '">'
      : '<span class="forum-author-badge forum-author-badge-fallback" title="' + esc(b.name) + '">' + (b.founder ? '★' : '◆') + '</span>';
  }

  /* A body, escaped, with the @names the SERVER resolved turned into
     profile links — those and no others, so a name that resolved to
     nobody, or to somebody who opted out, stays plain text. Escaped
     first, then linked, so a name cannot carry markup. */
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
    clearNameEffects(view);
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

  /* The search box every forum view carries. It submits to /community with
     ?search=, so searching from a topic lands back on the boards page. */
  function searchBarHtml(current) {
    return '<form class="forum-search-form" role="search">' +
      '<input type="search" class="forum-input forum-search-input" name="q" placeholder="Search topics and posts" ' +
        'maxlength="' + SEARCH_MAX + '" value="' + esc(current || '') + '" aria-label="Search the forum">' +
      '<button class="pill-btn" type="submit">Search</button>' +
    '</form>';
  }

  /* A board lists newest activity first, so page 1 is the newest; a topic
     lists its posts oldest first, so page 1 is the earliest. The labels
     say which way each arrow goes for the list they sit under. */
  var BOARD_PAGES = { prev: 'Newer', next: 'Older' };
  var TOPIC_PAGES = { prev: 'Earlier', next: 'Later' };

  function pager(page, pages, hrefFor, labels) {
    if (pages <= 1) return '';
    var l = labels || BOARD_PAGES;
    var html = '<nav class="forum-pagination" aria-label="Pages">';
    html += page > 1 ? '<a href="' + esc(hrefFor(page - 1)) + '">&lsaquo; ' + l.prev + '</a>' : '<span class="forum-page-off">&lsaquo; ' + l.prev + '</span>';
    html += '<span class="forum-page-num">Page ' + page + ' of ' + pages + '</span>';
    html += page < pages ? '<a href="' + esc(hrefFor(page + 1)) + '">' + l.next + ' &rsaquo;</a>' : '<span class="forum-page-off">' + l.next + ' &rsaquo;</span>';
    return html + '</nav>';
  }

  /* Any request that failed, said plainly where the person is looking. */
  function showError(el, r) {
    el.textContent = (r && r.data && r.data.error) || 'Something went wrong. Try again.';
    el.hidden = false;
  }

  /** A one-line reason form, used for removals and reports. Which action
      it performs is on the form; wireReasonForms() sends it. */
  function reasonForm(act, id, placeholder, submitLabel) {
    return '<form class="forum-reason-form" data-reason-act="' + esc(act) + '" data-id="' + esc(id) + '" hidden>' +
      '<input type="text" class="forum-input" maxlength="' + REASON_MAX + '" placeholder="' + esc(placeholder) + '" required>' +
      '<div class="forum-error" hidden></div>' +
      '<div class="forum-form-actions">' +
        '<button class="btn-primary" type="submit">' + esc(submitLabel) + '</button>' +
        '<button class="pill-btn" type="button" data-act="cancel-reason">Cancel</button>' +
      '</div></form>';
  }

  /* ── The boards ──────────────────────────────────────────────────── */

  function renderHome(view) {
    crumbs([]);
    api('/api/forum/categories').then(function (r) {
      if (!r.ok) return failed(view, r.data.error || 'The forum is unavailable right now.');
      var authors = r.data.authors || {};
      var links = [];
      if (me()) links.push('<a href="/community?view=following">Topics you follow</a>');
      if (r.data.viewer && r.data.viewer.staff) links.push('<a href="/community?view=reports">Moderation queue</a>');
      var staffBar = links.length ? '<div class="forum-staff-bar">' + links.join('') + '</div>' : '';
      setViewHtml(view, searchBarHtml('') + staffBar + '<div class="forum-categories">' + r.data.categories.map(function (c) {
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
      }).join('') + '</div>');
    }).catch(function () { failed(view, 'The forum is unavailable right now.'); });
  }

  /* ── One board ───────────────────────────────────────────────────── */

  /* `viewer.canPost` is the server running the board's own rule (staff
     list, subTier) for this person; the page only draws what it says. */
  function composerHtml(category, viewer) {
    if (!me()) {
      return '<button class="btn-primary forum-new-btn" type="button" data-act="login">Log in to post</button>';
    }
    if (!viewer || !viewer.canPost) {
      if (category.subOnly && !category.staffOnly) return '<span class="forum-flag">Subscribers post here</span>';
      return '';
    }
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
      var unread = {}; (d.unread || []).forEach(function (id) { unread[id] = 1; });
      var followed = {}; (d.followed || []).forEach(function (id) { followed[id] = 1; });
      var hrefFor = function (p) { return '/community?c=' + encodeURIComponent(categoryId) + (p > 1 ? '&page=' + p : ''); };
      var html = searchBarHtml('') + '<div class="forum-thread-header"><h3>' + esc(d.category.name) + '</h3>' +
        '<div class="forum-thread-header-right"><span class="forum-thread-count">' + d.total + ' ' + (d.total === 1 ? 'topic' : 'topics') + '</span>' +
        composerHtml(d.category, d.viewer) + '</div></div>' + (d.viewer && d.viewer.canPost ? composerForm() : '');
      if (!d.threads.length) {
        html += '<div class="forum-empty card"><p>No topics here yet.' + (d.viewer && d.viewer.canPost ? ' Start one.' : '') + '</p></div>';
      } else {
        html += '<div class="forum-thread-list">' + d.threads.map(function (t) {
          var href = '/thread/' + esc(t.id);
          return '<div class="card forum-thread-row' + (t.pinned ? ' forum-thread-pinned' : '') + '" data-href="' + href + '">' +
            '<div class="forum-thread-title">' +
              (t.pinned ? '<span class="forum-flag">Pinned</span>' : '') +
              (t.locked ? '<span class="forum-flag forum-flag-locked">Locked</span>' : '') +
              (unread[t.id] ? '<span class="forum-flag forum-chip-new">New</span>' : '') +
              (followed[t.id] ? '<span class="forum-flag forum-flag-locked">Following</span>' : '') +
              '<a href="' + href + '">' + esc(t.title) + '</a></div>' +
            '<div class="forum-thread-meta">' +
              authorLine(authors, t.userId, 'forum-author-sm') +
              '<span class="forum-thread-time">' + timeAgo(t.lastPostAt) + '</span>' +
              '<span class="forum-thread-replies">' + t.replyCount + ' ' + (t.replyCount === 1 ? 'reply' : 'replies') + '</span>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';
      }
      setViewHtml(view, html + pager(d.page, d.pages, hrefFor));
      wireComposer(view, categoryId);
    }).catch(function () { failed(view, 'The forum is unavailable right now.'); });
  }

  function wireComposer(view, categoryId) {
    var form = view.querySelector('#newThreadForm');
    view.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'login') login();
    });
    if (!form) return;
    var title = form.querySelector('#newThreadTitle');
    var body = form.querySelector('#newThreadBody');
    var err = form.querySelector('#newThreadError');
    var submit = form.querySelector('button[type=submit]');

    view.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.getAttribute('data-act');
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

  /** The Follow / Following toggle that sits by a topic's title. */
  function followBtnHtml(following) {
    return '<button type="button" class="forum-follow-btn' + (following ? ' following' : '') +
      '" data-act="toggle-follow" aria-pressed="' + (following ? 'true' : 'false') + '">' +
      (following ? 'Following ✓' : '☆ Follow') + '</button>';
  }

  /** One reaction tally, a toggle: `on` when it is one of yours. */
  function reactionChip(emoji, count, mine) {
    return '<button type="button" class="forum-reaction' + (mine ? ' on' : '') + '" data-react="' + esc(emoji) + '" title="' + esc(emoji) + '">' +
      '<span class="forum-reaction-glyph">' + (REACTION_GLYPH[emoji] || '◆') + '</span>' +
      '<span class="forum-reaction-count">' + count + '</span></button>';
  }

  /** The reaction row under a post: the marks it already carries, a ＋ that
      opens the full picker, and the picker itself. `data` is this post's
      entry from the thread's reactions map (tallies + which are yours). */
  function reactionBarHtml(postId, data) {
    data = data || { tallies: {}, mine: [] };
    var mine = {}; (data.mine || []).forEach(function (e) { mine[e] = 1; });
    var tallies = data.tallies || {};
    var chips = REACTION_ORDER.filter(function (e) { return tallies[e]; }).map(function (e) {
      return reactionChip(e, tallies[e], !!mine[e]);
    }).join('');
    var picker = '<div class="forum-reaction-picker" hidden>' + REACTION_ORDER.map(function (e) {
      return '<button type="button" class="forum-reaction-opt' + (mine[e] ? ' on' : '') + '" data-react="' + e + '" title="' + e + '">' + REACTION_GLYPH[e] + '</button>';
    }).join('') + '</div>';
    var add = '<button type="button" class="forum-reaction-add" data-act="react-pick" aria-label="Add a reaction" title="Add a reaction">＋</button>';
    return '<div class="forum-reaction-bar" data-react-post="' + esc(postId) + '">' + chips + add + picker + '</div>';
  }

  function postHtml(p, authors, ctx, op) {
    var mine = !!ctx.myId && String(p.userId) === ctx.myId;
    var controls = [];
    if (p.deleted) {
      if (ctx.staff) controls.push('<button type="button" data-act="mod" data-mod="restore-post" data-id="' + esc(p.id) + '">Restore</button>');
      return '<div class="card forum-post forum-post-tombstone" id="post-' + esc(p.id) + '" data-post="' + esc(p.id) + '">' +
        '<div class="forum-post-header">' + authorLine(authors, p.userId) +
          '<span class="forum-post-time">' + timeAgo(p.createdAt) + '</span>' +
          (controls.length ? '<span class="forum-post-actions">' + controls.join('') + '</span>' : '') + '</div>' +
        '<div class="forum-post-body forum-post-removed">' +
          (p.deleted === 'moderator' ? 'Removed by a moderator.' : 'Removed by the author.') + '</div>' +
        '<div class="forum-error" hidden></div>' +
      '</div>';
    }
    if (ctx.myId && ctx.canReply) controls.push('<button type="button" data-act="quote">Quote</button>');
    if (mine && !ctx.locked) {
      controls.push('<button type="button" data-act="edit">Edit</button>');
      controls.push('<button type="button" data-act="delete">Delete</button>');
    }
    if (ctx.myId && !mine) controls.push('<button type="button" data-act="show-reason" data-form="report">Report</button>');
    if (ctx.staff && !mine) controls.push('<button type="button" data-act="show-reason" data-form="delete-post" class="forum-mod-btn">Remove</button>');
    return '<div class="card forum-post' + (op ? ' forum-post-op' : '') + '" id="post-' + esc(p.id) + '" data-post="' + esc(p.id) + '">' +
      '<div class="forum-post-header">' + authorLine(authors, p.userId) +
        '<span class="forum-post-time">' + timeAgo(p.createdAt) +
          ' <span class="forum-post-edited"' + (p.editedAt ? '' : ' hidden') + '>(edited)</span></span>' +
        (controls.length ? '<span class="forum-post-actions">' + controls.join('') + '</span>' : '') + '</div>' +
      '<div class="forum-post-body">' + linkMentions(p, authors) + '</div>' +
      reactionBarHtml(p.id, ctx.reactions[p.id]) +
      '<div class="forum-error" hidden></div>' +
      (ctx.myId && !mine ? reasonForm('report', p.id, 'Why should a moderator look at this?', 'Send report') : '') +
      (ctx.staff && !mine ? reasonForm('delete-post', p.id, 'Reason (the author will see it)', 'Remove post') : '') +
    '</div>';
  }

  function replyBoxHtml(t, viewer) {
    if (t.deleted) return '<div class="forum-readonly-note">This topic has been removed. Only staff can see it.</div>';
    if (t.locked) return '<div class="forum-readonly-note">This topic is locked.</div>';
    var sess = me();
    if (!sess) {
      return '<div class="forum-reply-prompt card"><p>Log in to reply to this topic.</p>' +
        '<button class="btn-primary" type="button" data-act="login">Log In</button></div>';
    }
    if (!viewer || !viewer.canReply) {
      return '<div class="forum-readonly-note">You cannot reply on this board.</div>';
    }
    return '<form id="replyForm" class="forum-reply-form">' +
      '<textarea id="replyBody" class="forum-textarea" placeholder="Write a reply" rows="4" maxlength="' + BODY_MAX + '" required></textarea>' +
      '<div class="forum-error" id="replyError" hidden></div>' +
      '<div class="forum-form-actions"><button class="btn-primary" type="submit">Reply</button></div>' +
    '</form>';
  }

  /** The strip of moderator controls under a topic's title. */
  function modBarHtml(t) {
    if (t.deleted) {
      return '<div class="forum-mod-bar">' +
        '<span class="forum-mod-label">Removed</span>' +
        '<button type="button" data-act="mod" data-mod="restore-thread" data-id="' + esc(t.id) + '">Restore topic</button>' +
        '<div class="forum-error" hidden></div>' +
      '</div>';
    }
    return '<div class="forum-mod-bar">' +
      '<span class="forum-mod-label">Moderate</span>' +
      '<button type="button" data-act="mod" data-mod="' + (t.pinned ? 'unpin' : 'pin') + '" data-id="' + esc(t.id) + '">' + (t.pinned ? 'Unpin' : 'Pin') + '</button>' +
      '<button type="button" data-act="mod" data-mod="' + (t.locked ? 'unlock' : 'lock') + '" data-id="' + esc(t.id) + '">' + (t.locked ? 'Unlock' : 'Lock') + '</button>' +
      '<button type="button" data-act="show-reason" data-form="delete-thread" class="forum-mod-btn">Remove topic</button>' +
      '<div class="forum-error" hidden></div>' +
      reasonForm('delete-thread', t.id, 'Reason for removing the whole topic', 'Remove topic') +
    '</div>';
  }

  function renderThread(view, id, page) {
    api('/api/forum/thread?id=' + encodeURIComponent(id) + '&page=' + page).then(function (r) {
      if (!r.ok) {
        crumbs([{ text: 'Not found' }]);
        document.title = 'Topic | PhantomACE';
        return failed(view, r.status === 404 ? 'That topic is not here. It may have been removed.' : (r.data.error || 'The forum is unavailable right now.'));
      }
      var d = r.data, t = d.thread, authors = d.authors || {};
      var viewer = d.viewer || {};
      currentAuthors = authors;
      var sess = me();
      var ctx = {
        myId: sess && sess.user_id != null ? String(sess.user_id) : null,
        staff: !!viewer.staff,
        locked: !!t.locked || !!t.deleted,
        canReply: !!viewer.canReply,
        reactions: d.reactions || {},
      };
      document.title = t.title + ' | PhantomACE';
      crumbs([{ text: t.categoryName, href: '/community?c=' + encodeURIComponent(t.categoryId) }, { text: t.title }]);
      var hrefFor = function (p) { return '/thread/' + encodeURIComponent(id) + (p > 1 ? '?page=' + p : ''); };

      var html = searchBarHtml('') + '<div class="forum-thread-view">';
      html += '<div class="forum-topic-head">' +
        (t.deleted ? '<span class="forum-flag forum-flag-locked">Removed</span>' : '') +
        (t.pinned ? '<span class="forum-flag">Pinned</span>' : '') +
        (t.locked ? '<span class="forum-flag forum-flag-locked">Locked</span>' : '') +
        '<h1 class="forum-post-title">' + esc(t.title) + '</h1>' +
        (ctx.myId && !t.deleted ? followBtnHtml(viewer.following) : '') +
        '</div>';
      if (ctx.staff) html += modBarHtml(t);
      html += d.posts.map(function (p, i) { return postHtml(p, authors, ctx, d.page === 1 && i === 0); }).join('');
      html += pager(d.page, d.pages, hrefFor, TOPIC_PAGES);
      html += replyBoxHtml(t, viewer);
      setViewHtml(view, html + '</div>');
      wireThread(view, id);

      if (location.hash && /^#post-[0-9]+$/.test(location.hash)) {
        var target = document.getElementById(location.hash.slice(1));
        if (target) target.scrollIntoView();
      }
    }).catch(function () { failed(view, 'The forum is unavailable right now.'); });
  }

  function wireThread(view, threadId) {
    view.addEventListener('click', function (e) {
      /* Reactions carry data-react rather than data-act: a tally or a
         picker option, both toggles on the post they sit in. */
      var react = e.target.closest('[data-react]');
      if (react) {
        if (!me()) return login();
        var bar = react.closest('.forum-reaction-bar');
        if (bar) return toggleReaction(bar, react.getAttribute('data-react'));
      }
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'login') return login();
      if (a === 'toggle-follow') return toggleFollow(act, threadId);
      if (a === 'react-pick') {
        var pbar = act.closest('.forum-reaction-bar');
        var picker = pbar && pbar.querySelector('.forum-reaction-picker');
        if (picker) picker.hidden = !picker.hidden;
        return;
      }
      var card = act.closest('[data-post]');
      if (a === 'quote' && card) return quotePost(view, card);
      if (a === 'edit' && card) return startEdit(card);
      if (a === 'delete' && card) return deletePost(card);
      if (a === 'cancel-edit' && card) return endEdit(card);
      if (a === 'mod') return moderate(act, act.getAttribute('data-mod'), act.getAttribute('data-id'), null);
      if (a === 'show-reason') return showReason(act);
      if (a === 'cancel-reason') { var f = act.closest('.forum-reason-form'); if (f) f.hidden = true; }
    });
    wireReasonForms(view);

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

  /* Reveal the reason form that belongs to the button: the nearest one
     of the named kind inside the same card or bar. */
  function showReason(btn) {
    var scope = btn.closest('[data-post], .forum-mod-bar, .forum-report');
    if (!scope) return;
    var form = scope.querySelector('.forum-reason-form[data-reason-act="' + btn.getAttribute('data-form') + '"]');
    if (!form) return;
    form.hidden = false;
    form.querySelector('input').focus();
  }

  /* Every reason form in the view submits the same way: its action and
     id are on it, and where the answer goes depends on which it was. */
  function wireReasonForms(view) {
    view.addEventListener('submit', function (e) {
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
      if (act === 'report') {
        api('/api/forum/post', { action: 'report', id: id, reason: reason }).then(function (r) {
          if (!r.ok) { submit.disabled = false; return showError(err, r); }
          form.outerHTML = '<div class="forum-reported">Reported. A moderator will take a look.</div>';
          var b = view.querySelector('[data-post="' + id + '"] [data-form="report"]');
          if (b) b.remove();
        }).catch(function () { submit.disabled = false; showError(err, null); });
        return;
      }
      moderate(submit, act, id, reason, err);
    });
  }

  /* One moderation action, then reload so the page reflects the server
     rather than a guess about it. A removed topic goes back to its board. */
  function moderate(btn, action, id, reason, errEl) {
    var err = errEl || (btn.closest('[data-post], .forum-mod-bar, .forum-report') || document).querySelector('.forum-error');
    if (err) err.hidden = true;
    btn.disabled = true;
    api('/api/forum/moderate', { action: action, id: id, reason: reason }).then(function (r) {
      if (!r.ok) { btn.disabled = false; if (err) showError(err, r); return; }
      if (action === 'delete-thread') {
        var crumb = document.querySelector('#forumBreadcrumb a[href^="/community?c="]');
        location.href = crumb ? crumb.getAttribute('href') : '/community';
        return;
      }
      location.reload();
    }).catch(function () { btn.disabled = false; if (err) showError(err, null); });
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

  function deletePost(card) {
    if (!window.confirm('Remove this post? It will show as removed by you.')) return;
    var err = card.querySelector('.forum-error');
    err.hidden = true;
    api('/api/forum/post', { action: 'delete', id: card.getAttribute('data-post') }).then(function (r) {
      if (!r.ok) return showError(err, r);
      location.reload();
    }).catch(function () { showError(err, null); });
  }

  /* Follow / unfollow a topic. The button shows the server's answer so a
     failed request leaves the label honest. */
  function toggleFollow(btn, threadId) {
    var following = btn.classList.contains('following');
    btn.disabled = true;
    api('/api/forum/follows', { id: threadId, action: following ? 'unfollow' : 'follow' }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) return;
      var nowF = !!r.data.following;
      btn.classList.toggle('following', nowF);
      btn.setAttribute('aria-pressed', nowF ? 'true' : 'false');
      btn.innerHTML = nowF ? 'Following ✓' : '☆ Follow';
    }).catch(function () { btn.disabled = false; });
  }

  /* Toggle one reaction on a post. The server returns the whole post's
     reaction state, which the bar is rebuilt from — so two people reacting
     at once never leave a stale count. */
  function toggleReaction(bar, emoji) {
    if (!REACTION_GLYPH[emoji]) return;
    var postId = bar.getAttribute('data-react-post');
    var existing = bar.querySelector('[data-react="' + emoji + '"]');
    var mine = !!(existing && existing.classList.contains('on'));
    api('/api/forum/reactions', { id: postId, emoji: emoji, action: mine ? 'remove' : 'add' }).then(function (r) {
      if (!r.ok) return;
      var wrap = document.createElement('div');
      wrap.innerHTML = reactionBarHtml(postId, r.data.reactions);
      bar.replaceWith(wrap.firstChild);
    }).catch(function () {});
  }

  /* Quote a post into the reply box: an attribution line and the body as a
     blockquote, in plain text — the reply is plain text, so the > marks are
     just how a quote reads. */
  function quotePost(view, card) {
    var form = view.querySelector('#replyForm');
    var textarea = form && form.querySelector('#replyBody');
    if (!textarea) return;
    var bodyEl = card.querySelector('.forum-post-body');
    var nameEl = card.querySelector('.forum-author-name');
    var name = nameEl ? nameEl.textContent.trim() : 'someone';
    var tmp = document.createElement('div');
    tmp.innerHTML = bodyEl.innerHTML.replace(/<br\s*\/?>/g, '\n');
    var text = tmp.textContent.replace(/\n{3,}/g, '\n\n').trim();
    var quoted = text.split('\n').map(function (l) { return '> ' + l; }).join('\n');
    var block = name + ' wrote:\n' + quoted + '\n\n';
    textarea.value = (textarea.value ? textarea.value.replace(/\s*$/, '') + '\n\n' : '') + block;
    textarea.focus();
    try { textarea.setSelectionRange(textarea.value.length, textarea.value.length); } catch (e) {}
    textarea.scrollIntoView({ block: 'center' });
  }

  /* ── Topics you follow ───────────────────────────────────────────── */

  function renderFollowing(view, page) {
    crumbs([{ text: 'Topics you follow' }]);
    if (!me()) return failed(view, 'Log in to follow topics.');
    api('/api/forum/follows?page=' + page).then(function (r) {
      if (!r.ok) return failed(view, (r.data && r.data.error) || 'Could not load the topics you follow.');
      var d = r.data, authors = d.authors || {};
      var hrefFor = function (p) { return '/community?view=following' + (p > 1 ? '&page=' + p : ''); };
      var html = searchBarHtml('') + '<div class="forum-thread-header"><h3>Topics you follow</h3>' +
        '<span class="forum-thread-count">' + d.total + ' ' + (d.total === 1 ? 'topic' : 'topics') + '</span></div>';
      if (!d.threads.length) {
        html += '<div class="forum-empty card"><p>You are not following anything yet. Open a topic and press Follow to hear when someone replies.</p></div>';
      } else {
        html += '<div class="forum-thread-list">' + d.threads.map(function (t) {
          var href = '/thread/' + esc(t.id);
          return '<div class="card forum-thread-row' + (t.pinned ? ' forum-thread-pinned' : '') + '" data-href="' + href + '">' +
            '<div class="forum-thread-title">' +
              (t.unread ? '<span class="forum-flag forum-chip-new">New</span>' : '') +
              (t.locked ? '<span class="forum-flag forum-flag-locked">Locked</span>' : '') +
              '<a href="' + href + '">' + esc(t.title) + '</a></div>' +
            '<div class="forum-thread-meta">' +
              authorLine(authors, t.userId, 'forum-author-sm') +
              '<span class="forum-thread-time">in ' + esc(t.categoryName) + ' · ' + timeAgo(t.lastPostAt) + '</span>' +
              '<span class="forum-thread-replies">' + t.replyCount + ' ' + (t.replyCount === 1 ? 'reply' : 'replies') + '</span>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';
      }
      setViewHtml(view, html + pager(d.page, d.pages, hrefFor));
    }).catch(function () { failed(view, 'Could not load the topics you follow.'); });
  }

  /* ── Search ──────────────────────────────────────────────────────── */

  function renderSearch(view, q, page) {
    crumbs([{ text: 'Search' }]);
    document.title = 'Search | PhantomACE';
    api('/api/forum/search?q=' + encodeURIComponent(q) + '&page=' + page).then(function (r) {
      if (!r.ok) {
        var html = searchBarHtml(q) + '<div class="forum-empty card"><p>' + esc((r.data && r.data.error) || 'That search did not work.') + '</p></div>';
        return setViewHtml(view, html);
      }
      var d = r.data, authors = d.authors || {};
      var hrefFor = function (p) { return '/community?search=' + encodeURIComponent(q) + (p > 1 ? '&page=' + p : ''); };
      var html = searchBarHtml(d.query) + '<div class="forum-thread-header"><h3>Results for “' + esc(d.query) + '”</h3>' +
        '<span class="forum-thread-count">' + d.total + ' ' + (d.total === 1 ? 'topic' : 'topics') + '</span></div>';
      if (!d.results.length) {
        html += '<div class="forum-empty card"><p>Nothing matched. Try fewer or different words.</p></div>';
      } else {
        html += '<div class="forum-thread-list">' + d.results.map(function (t) {
          var href = '/thread/' + esc(t.id);
          return '<div class="card forum-thread-row" data-href="' + href + '">' +
            '<div class="forum-thread-title"><a href="' + href + '">' + esc(t.title) + '</a>' +
              (t.matchedIn === 'post' ? '<span class="forum-flag forum-flag-locked">In a reply</span>' : '') + '</div>' +
            (t.snippet ? '<div class="forum-search-snippet">' + esc(t.snippet) + '</div>' : '') +
            '<div class="forum-thread-meta">' +
              authorLine(authors, t.userId, 'forum-author-sm') +
              '<span class="forum-thread-time">in ' + esc(t.categoryName) + ' · ' + timeAgo(t.lastPostAt) + '</span>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';
      }
      setViewHtml(view, html + pager(d.page, d.pages, hrefFor));
    }).catch(function () { failed(view, 'That search did not work.'); });
  }

  /* ── The moderation queue ────────────────────────────────────────── */

  var MOD_ACTION_LABEL = {
    pin: 'pinned', unpin: 'unpinned', lock: 'locked', unlock: 'unlocked',
    'delete-thread': 'removed topic', 'restore-thread': 'restored topic',
    'delete-post': 'removed post', 'restore-post': 'restored post', resolve: 'dismissed reports on',
  };
  function modLogTarget(l) {
    if (l.targetType === 'thread') return '<a href="/thread/' + esc(l.targetId) + '">topic #' + esc(l.targetId) + '</a>';
    if (l.targetType === 'post') return 'post #' + esc(l.targetId);
    return 'a report';
  }

  function renderQueue(view) {
    crumbs([{ text: 'Moderation queue' }]);
    api('/api/forum/moderate').then(function (r) {
      if (!r.ok) return failed(view, r.data.error || 'The queue is unavailable right now.');
      var authors = r.data.authors || {};
      var reports = r.data.reports || [];
      var removed = r.data.removedThreads || [];
      var removedPosts = r.data.removedPosts || [];
      var modLog = r.data.modLog || [];
      var removedHtml = removed.length
        ? '<div class="forum-thread-header"><h3>Removed topics</h3>' +
            '<span class="forum-thread-count">' + removed.length + ' most recent</span></div>' +
          '<div class="forum-thread-list">' + removed.map(function (t) {
            return '<div class="card forum-report">' +
              '<div class="forum-thread-title"><span class="forum-flag forum-flag-locked">Removed</span>' +
                '<a href="/thread/' + esc(t.id) + '">' + esc(t.title) + '</a></div>' +
              '<div class="forum-thread-meta">' +
                authorLine(authors, t.userId, 'forum-author-sm') +
                '<span class="forum-thread-time">in ' + esc(t.categoryName) + ', removed ' + timeAgo(t.deletedAt) + '</span>' +
              '</div>' +
              '<div class="forum-error" hidden></div>' +
              '<div class="forum-form-actions">' +
                '<button type="button" class="pill-btn" data-act="mod" data-mod="restore-thread" data-id="' + esc(t.id) + '">Restore topic</button>' +
              '</div>' +
            '</div>';
          }).join('') + '</div>'
        : '';
      var reportsHtml = !reports.length
        ? '<div class="forum-empty card"><p>Nothing reported. Quiet is good.</p></div>'
        : '<div class="forum-thread-header"><h3>Reports</h3>' +
        '<span class="forum-thread-count">' + reports.length + ' open</span></div>' +
        reports.map(function (rep) {
          var where = rep.threadId
            ? '<a href="/thread/' + esc(rep.threadId) + '#post-' + esc(rep.postId) + '">' + esc(rep.threadTitle || 'topic') + '</a>'
            : '<span>a profile comment</span>';
          return '<div class="card forum-report" data-report="' + esc(rep.id) + '">' +
            '<div class="forum-report-head">' +
              '<span class="forum-report-by">' + authorLine(authors, rep.reporterId, 'forum-author-sm') + ' reported</span>' +
              '<span class="forum-thread-time">' + timeAgo(rep.at) + '</span></div>' +
            '<div class="forum-report-reason">' + esc(rep.reason) + '</div>' +
            '<div class="forum-report-post">' +
              '<div class="forum-report-meta">' + authorLine(authors, rep.authorId, 'forum-author-sm') + ' in ' + where +
                (rep.postDeleted ? ' <span class="forum-flag forum-flag-locked">Already removed</span>' : '') + '</div>' +
              '<div class="forum-report-excerpt">' + esc(rep.excerpt || '') + '</div>' +
            '</div>' +
            '<div class="forum-error" hidden></div>' +
            '<div class="forum-form-actions">' +
              (rep.postDeleted ? '' : '<button type="button" class="pill-btn forum-mod-btn" data-act="show-reason" data-form="delete-post">Remove post</button>') +
              '<button type="button" class="pill-btn" data-act="mod" data-mod="resolve" data-id="' + esc(rep.postId) + '">Dismiss</button>' +
            '</div>' +
            (rep.postDeleted ? '' : reasonForm('delete-post', rep.postId, 'Reason (the author will see it)', 'Remove post')) +
          '</div>';
        }).join('');
      var removedPostsHtml = removedPosts.length
        ? '<div class="forum-thread-header"><h3>Removed posts</h3>' +
            '<span class="forum-thread-count">' + removedPosts.length + ' most recent</span></div>' +
          removedPosts.map(function (p) {
            var where = p.threadId
              ? '<a href="/thread/' + esc(p.threadId) + '#post-' + esc(p.id) + '">' + esc(p.threadTitle || 'a topic') + '</a>'
              : '<span>a profile comment</span>';
            return '<div class="card forum-report">' +
              '<div class="forum-report-meta">' + authorLine(authors, p.userId, 'forum-author-sm') + ' in ' + where +
                ' <span class="forum-thread-time">removed ' + timeAgo(p.deletedAt) + '</span></div>' +
              (p.reason ? '<div class="forum-report-reason">' + esc(p.reason) + '</div>' : '') +
              '<div class="forum-report-excerpt">' + esc(p.excerpt || '') + '</div>' +
              '<div class="forum-error" hidden></div>' +
              '<div class="forum-form-actions">' +
                '<button type="button" class="pill-btn" data-act="mod" data-mod="restore-post" data-id="' + esc(p.id) + '">Restore post</button>' +
              '</div>' +
            '</div>';
          }).join('')
        : '';
      var modLogHtml = modLog.length
        ? '<div class="forum-thread-header"><h3>Moderation log</h3>' +
            '<span class="forum-thread-count">last ' + modLog.length + '</span></div>' +
          '<div class="forum-modlog">' + modLog.map(function (l) {
            return '<div class="forum-modlog-entry">' +
              authorLine(authors, l.actorId, 'forum-author-sm') +
              ' <span class="forum-modlog-action">' + esc(MOD_ACTION_LABEL[l.action] || l.action) + '</span> ' +
              modLogTarget(l) +
              (l.detail ? ' <span class="forum-modlog-detail">“' + esc(l.detail) + '”</span>' : '') +
              ' <span class="forum-thread-time">' + timeAgo(l.at) + '</span>' +
            '</div>';
          }).join('') + '</div>'
        : '';
      setViewHtml(view, reportsHtml + removedHtml + removedPostsHtml + modLogHtml);
      view.addEventListener('click', function (e) {
        var act = e.target.closest('[data-act]');
        if (!act) return;
        var a = act.getAttribute('data-act');
        if (a === 'mod') return moderate(act, act.getAttribute('data-mod'), act.getAttribute('data-id'), null);
        if (a === 'show-reason') return showReason(act);
        if (a === 'cancel-reason') { var f = act.closest('.forum-reason-form'); if (f) f.hidden = true; }
      });
      wireReasonForms(view);
    }).catch(function () { failed(view, 'The queue is unavailable right now.'); });
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

  /* The search box on any forum view sends you to the boards page with the
     query. One handler for all of them, including the one on a topic. */
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('.forum-search-form');
    if (!form) return;
    e.preventDefault();
    var input = form.querySelector('[name=q]');
    var q = (input && input.value || '').trim();
    if (q.length < 2) { if (input) input.focus(); return; }
    location.href = '/community.html?search=' + encodeURIComponent(q);
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
    var searchQ = q.get('search');
    if (searchQ) return renderSearch(view, searchQ, page);
    if (q.get('view') === 'following') return renderFollowing(view, page);
    if (q.get('view') === 'reports') return renderQueue(view);
    var c = (q.get('c') || '').toLowerCase();
    if (c) renderBoard(view, c, page); else renderHome(view);
  });
})();
