/* ══════════════════════════════════════════════
   USER DIRECTORY — view everyone, elevate to moderator.

   Reads /api/admin/users (the profile roster joined with the mod list) and
   writes through /api/admin/moderators (add by name, remove by id) — the
   one route that owns the mod list. Only the broadcaster sees the action
   buttons; a moderator sees the roster read-only. The server enforces both
   regardless of what this page shows.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var USERS_API = '/api/admin/users';
  var MODS_API = '/api/admin/moderators';

  var all = [];
  var canEdit = false;

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function load() {
    var res, data;
    try { res = await fetch(USERS_API, { cache: 'no-store' }); data = await res.json(); }
    catch (e) { $('notice').textContent = 'Could not reach the server.'; return; }

    if (!res.ok) {
      $('notice').textContent = data.error || 'Staff only.';
      return;
    }
    all = data.users || [];
    canEdit = !!data.canEdit;
    $('notice').style.display = 'none';
    $('panel').style.display = '';
    $('count').textContent = data.count + ' users · ' + data.modCount + ' mods';
    if (!canEdit) {
      /* A moderator viewing: hide the add controls the server would refuse. */
      $('addName').style.display = 'none';
      $('addBtn').style.display = 'none';
    }
    render();
  }

  function render() {
    var q = $('search').value.trim().toLowerCase();
    var rows = all.filter(function (u) {
      return !q || (u.displayName + ' ' + u.login).toLowerCase().indexOf(q) !== -1;
    });
    $('list').innerHTML = rows.map(rowHtml).join('') ||
      '<div class="row"><span class="who">No users match.</span></div>';
    if (canEdit) wireRowButtons();
  }

  function rowHtml(u) {
    var tag = u.isBroadcaster ? '<span class="tag bc">Broadcaster</span>'
      : u.isMod ? '<span class="tag mod">Moderator</span>' : '';
    var action;
    if (u.isBroadcaster) {
      action = '<span class="locked">—</span>';
    } else if (!canEdit) {
      action = '';
    } else if (u.isMod) {
      action = '<button class="demote" data-act="remove" data-id="' + esc(u.userId) +
               '" data-name="' + esc(u.displayName) + '">Remove mod</button>';
    } else {
      action = '<button class="elevate" data-act="add" data-login="' + esc(u.login || u.userId) +
               '" data-name="' + esc(u.displayName) + '">Make mod</button>';
    }
    var avatar = u.avatar
      ? '<img src="' + esc(u.avatar) + '" alt="">'
      : '<img alt="">';
    return '<div class="row' + (u.isMod ? ' is-mod' : '') + '">' +
      avatar +
      '<div class="who"><div class="name">' + esc(u.displayName) + ' ' + tag +
      '</div><div class="login">@' + esc(u.login || u.userId) + '</div></div>' +
      action + '</div>';
  }

  function wireRowButtons() {
    $('list').querySelectorAll('button[data-act]').forEach(function (btn) {
      btn.onclick = function () {
        if (btn.dataset.act === 'add') elevate(btn.dataset.login, btn.dataset.name);
        else demote(btn.dataset.id, btn.dataset.name);
      };
    });
  }

  async function change(body, okMsg) {
    $('status').textContent = 'Working…';
    try {
      var res = await fetch(MODS_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify(body),
      });
      var data = await res.json();
      if (!res.ok) { $('status').textContent = data.error || 'Failed.'; return; }
      $('status').textContent = okMsg;
      await load();                 /* re-read so the row reflects the truth */
    } catch (e) { $('status').textContent = 'Failed: ' + e.message; }
  }

  function elevate(login, name) {
    change({ action: 'add', name: login }, name + ' is now a moderator.');
  }
  function demote(id, name) {
    if (!confirm('Remove moderator from ' + name + '?')) return;
    change({ action: 'remove', userId: id }, name + ' is no longer a moderator.');
  }

  $('search').addEventListener('input', render);
  $('addBtn').addEventListener('click', function () {
    var name = $('addName').value.trim();
    if (!name) { $('status').textContent = 'Enter a Twitch username.'; return; }
    change({ action: 'add', name: name }, 'Added ' + name + ' as a moderator.');
    $('addName').value = '';
  });

  load();
})();
