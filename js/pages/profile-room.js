/* ══════════════════════════════════════════════
   MY ROOM — the Room section on a profile

   profile.js renders the person and announces it with 'profile:rendered';
   this listens, asks /api/room for the room their profile shows, and
   draws it into the section profile.js left for it — the same seam the
   comment wall uses. Read-only: editing lives at /room/edit.

   Two stages: the top-down room, and the desk setup beneath it when it
   has anything on it. A member who has not built anything shows the
   empty default floor; if the viewer is that member, a "Build yours"
   button sits on it.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var catalogPromise = null;
  function catalog() {
    if (!catalogPromise) {
      catalogPromise = fetch('/assets/room/catalog.json', { cache: 'force-cache' })
        .then(function (r) { if (!r.ok) throw new Error('catalog'); return r.json(); });
    }
    return catalogPromise;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function render(host, userId) {
    Promise.all([
      catalog(),
      fetch('/api/room?id=' + encodeURIComponent(userId), { cache: 'no-store' })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); }),
    ]).then(function (res) {
      var cat = res[0], r = res[1];
      if (!r.ok) { host.innerHTML = '<p class="rm-state">' + esc(r.data.error || 'No room here.') + '</p>'; return; }
      var d = r.data;
      var isOwner = !!(d.viewer && d.viewer.isOwner);

      var html = '<div class="rm-head">' +
        '<h3 class="rm-name">' + esc(d.name) + '</h3>' +
        (isOwner ? '<a class="btn-primary rm-edit-btn" href="/room/edit">' + (d.empty ? 'Build yours' : 'Edit room') + '</a>' : '') +
        '</div>' +
        '<div class="rm-host" id="rmRoom"></div>';
      var setupProps = (d.room.setup && d.room.setup.props) || [];
      if (setupProps.length) html += '<div class="rm-subhead">Desk setup</div><div class="rm-host rm-host-setup" id="rmSetup"></div>';
      if (d.empty && !isOwner) html += '<p class="rm-state">Nothing built here yet.</p>';
      host.innerHTML = html;

      var roomHost = host.querySelector('#rmRoom');
      PhamRoom.mount(roomHost, PhamRoom.build(d.room, cat));
      var setupHost = host.querySelector('#rmSetup');
      if (setupHost) PhamRoom.mount(setupHost, PhamRoom.buildSetup(d.room, cat));

      var refit = function () {
        PhamRoom.fit(roomHost);
        if (setupHost) PhamRoom.fit(setupHost);
      };
      window.addEventListener('resize', refit);
      /* Fonts and the column settle after first paint; fit once more. */
      setTimeout(refit, 50);
    }).catch(function () {
      host.innerHTML = '<p class="rm-state">The room could not be loaded right now.</p>';
    });
  }

  document.addEventListener('profile:rendered', function (e) {
    var host = document.getElementById('profRoom');
    var p = e.detail;
    if (!host || !p || !p.userId) return;
    render(host, String(p.userId));
  });
})();
