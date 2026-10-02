/* ══════════════════════════════════════════════
   ROOM CRAWL (community C3)

   Reads /api/rooms-browse and renders the gallery, the Room of the Week, the
   single-room view and the guestbook.

   EVERYTHING HERE IS SOMEONE ELSE'S TEXT — owner names, dino nicknames,
   guestbook notes, the broadcaster's feature note — so every value goes
   through esc() on the way into markup and every image through safeSrc(). The
   server already projects and caps these; this is the render-side half.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var galleryEl = document.getElementById('rcGallery');
  var featuredEl = document.getElementById('rcFeatured');
  var selfEl = document.getElementById('rcSelfPanel');
  var countEl = document.getElementById('rcCount');
  var roomViewEl = document.getElementById('rcRoomView');
  if (!galleryEl) return;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safeSrc(u) {
    if (typeof u !== 'string') return '';
    return (/^\/(?!\/)/.test(u) || /^https:\/\//i.test(u) ||
      /^data:image\/(png|webp);base64,[a-z0-9+/=]+$/i.test(u)) ? u : '';
  }
  var RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exclusive'];
  function safeRarity(r) { return RARITIES.indexOf(r) !== -1 ? r : 'common'; }
  /* CSS filter from stored data: the server caps it to the filter charset, and
     this refuses anything that could close the attribute or smuggle a url(). */
  function safeFilter(f) {
    if (typeof f !== 'string' || !f) return '';
    if (/url\(|;|\}|<|expression/i.test(f)) return '';
    return /^[a-z0-9()%.,\s-]{0,200}$/i.test(f) ? f : '';
  }

  /* Plain emoji, no icon library. The id is the server's allowlist; an id it
     does not know draws a neutral mark rather than nothing. */
  var STAMP_GLYPH = {
    skull: '💀', bat: '🦇', pumpkin: '🎃', ghost: '👻', candle: '🕯️', rose: '🥀',
    heart: '🖤', star: '✦', crown: '👑', paw: '🐾', flame: '🔥', clover: '🍀',
  };
  var STAMP_ORDER = ['skull', 'ghost', 'pumpkin', 'bat', 'candle', 'rose', 'crown', 'star', 'flame', 'paw', 'heart', 'clover'];

  function session() {
    try { return (typeof getSession === 'function') ? getSession() : null; } catch (e) { return null; }
  }
  function isBroadcaster() {
    var s = session();
    return !!(s && s.role === 'broadcaster');
  }

  function api(qs) {
    return fetch('/api/rooms-browse' + (qs || ''), { cache: 'no-store' }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }
  function post(body) {
    return fetch('/api/rooms-browse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }

  function avatarHtml(url, name, cls) {
    var src = safeSrc(url);
    if (src) return '<img class="' + cls + '" src="' + esc(src) + '" alt="">';
    var initial = (String(name || '?').trim()[0] || '?').toUpperCase();
    return '<span class="' + cls + ' rc-fallback">' + esc(initial) + '</span>';
  }

  function spriteHtml(fav, size) {
    if (!fav) return '';
    var src = safeSrc(fav.src);
    if (!src) return '';
    var filt = safeFilter(fav.filter);
    return '<img src="' + esc(src) + '" width="' + size + '" height="' + size +
      '" alt=""' + (filt ? ' style="filter:' + esc(filt) + '"' : '') + '>';
  }

  /* ── Gallery ──────────────────────────────────── */
  var lastData = null;

  function render(data) {
    lastData = data;
    renderFeatured(data.featured);
    renderSelf(data);
    renderCards(data.rooms || []);
    if (countEl) {
      var n = data.total || (data.rooms || []).length;
      countEl.textContent = n ? (n + (n === 1 ? ' park open' : ' parks open')) : '';
    }
  }

  function renderFeatured(f) {
    if (!f || !f.ownerId) { featuredEl.innerHTML = ''; return; }
    featuredEl.innerHTML =
      '<div class="rc-featured">' +
        '<div class="rc-featured-art">' + avatarHtml(f.avatar, f.ownerName, 'rc-card-avatar') + '</div>' +
        '<div class="rc-featured-body">' +
          '<div class="rc-featured-badge">★ Room of the Week</div>' +
          '<div class="rc-featured-name">' + esc(f.ownerName || 'A keeper') + '</div>' +
          (f.note ? '<p class="rc-featured-note">“' + esc(f.note) + '”</p>' : '') +
          '<button class="btn-primary" data-open="' + esc(f.ownerId) + '">Visit this park</button>' +
        '</div>' +
      '</div>';
  }

  function renderSelf(data) {
    var s = session();
    if (!s || !s.user_id) {
      selfEl.innerHTML =
        '<div class="rc-self"><div class="rc-self-text"><strong>Want your park on the crawl?</strong>' +
        '<p><a href="/games.html" style="color:var(--red)">Open Dino Park</a>, then flip your park to “open to visitors”.</p></div></div>';
      return;
    }
    var mine = (data.rooms || []).find(function (r) { return String(r.id) === String(s.user_id); });
    if (!mine) {
      selfEl.innerHTML =
        '<div class="rc-self"><div class="rc-self-text"><strong>Your park is private</strong>' +
        '<p>Open it to visitors in <a href="/games.html" style="color:var(--red)">Dino Park</a> to appear here and enter the haunted-room contest.</p></div></div>';
      return;
    }
    var entered = !!mine.haunted;
    selfEl.innerHTML =
      '<div class="rc-self">' +
        '<div class="rc-self-text"><strong>Your park is on the crawl</strong>' +
          '<p>' + (entered ? '<span class="rc-haunted-tag">🎃 Entered in the haunted-room contest</span>'
                           : 'Enter the October haunted-room contest to be judged on stream.') + '</p></div>' +
        '<button class="' + (entered ? 'btn-secondary' : 'btn-primary') + '" id="rcHauntedBtn">' +
          (entered ? 'Withdraw entry' : '🎃 Enter haunted contest') + '</button>' +
        '<button class="btn-secondary" data-open="' + esc(s.user_id) + '">View my room</button>' +
      '</div>';
    var hb = document.getElementById('rcHauntedBtn');
    if (hb) hb.addEventListener('click', function () { toggleHaunted(!entered); });
  }

  function toggleHaunted(enter) {
    post({ action: 'haunted', enter: enter }).then(function (res) {
      if (!res.ok) { alert((res.data && res.data.error) || 'Could not update your entry.'); return; }
      load();
    });
  }

  function cardScene(room) {
    var inner;
    if (room.favorite && safeSrc(room.favorite.src)) {
      inner = spriteHtml(room.favorite, 96);
    } else {
      inner = '<span class="rc-noart">A quiet park</span>';
    }
    var haunted = room.haunted ? '<span class="rc-card-haunted">🎃 Haunted</span>' : '';
    return '<div class="rc-card-scene">' + haunted + inner + '</div>';
  }

  function renderCards(rooms) {
    if (!rooms.length) {
      galleryEl.innerHTML = '<div class="rc-empty card"><p>No parks are open to visitors yet. Be the first — open yours in Dino Park.</p></div>';
      return;
    }
    galleryEl.innerHTML = rooms.map(function (room) {
      var sm = room.summary || {};
      return '<div class="rc-card" data-open="' + esc(room.id) + '">' +
          cardScene(room) +
          '<div class="rc-card-owner">' +
            avatarHtml(room.avatar, room.owner, 'rc-card-avatar') +
            '<span class="rc-card-name">' + esc(room.owner || 'A keeper') + '</span>' +
          '</div>' +
          '<div class="rc-card-stats"><b>' + (sm.parkCount || 0) + '</b> dinos · <b>' +
            (sm.species || 0) + '</b> species · Day <b>' + (sm.day || 1) + '</b></div>' +
        '</div>';
    }).join('');
  }

  /* ── Single-room view ─────────────────────────── */
  function openRoom(id) {
    if (!/^[0-9]{1,20}$/.test(String(id))) return;
    api('?id=' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) { alert((res.data && res.data.error) || 'That park is not open.'); return; }
      renderRoom(res.data);
    });
  }

  function favBadges(f) {
    var out = '';
    if (f.rarity) out += '<span class="rc-badge r-' + safeRarity(f.rarity) + '">' + esc(safeRarity(f.rarity)) + '</span>';
    if (f.diet) out += '<span class="rc-badge">' + esc(f.diet) + '</span>';
    if (f.build) out += '<span class="rc-badge">' + esc(f.build) + '</span>';
    if (f.mutationLabel) out += '<span class="rc-badge r-epic">✨ ' + esc(f.mutationLabel) + '</span>';
    return out;
  }

  function showcaseHtml(f) {
    if (!f) return '';
    var art = spriteHtml(f, 110);
    var speciesLine = [f.species, f.era, f.habitat].filter(Boolean).map(esc).join(' · ');
    return '<div class="rc-showcase">' +
      '<div class="rc-showcase-art">' + (art || '') + '</div>' +
      '<div>' +
        '<div class="rc-showcase-name">' + esc(f.nickname || f.species || 'A favourite') + '</div>' +
        (speciesLine ? '<div class="rc-showcase-species">' + speciesLine + '</div>' : '') +
        (favBadges(f) ? '<div class="rc-badges">' + favBadges(f) + '</div>' : '') +
        (f.desc ? '<p class="rc-showcase-desc">“' + esc(f.desc) + '”</p>' : '') +
      '</div></div>';
  }

  function guestbookForm(id, you) {
    if (!you || !you.canStamp) {
      return '<div class="rc-gb-login">Log in to leave a stamp in this guestbook.</div>';
    }
    var picker = STAMP_ORDER.map(function (sid) {
      return '<button type="button" class="rc-stamp" data-stamp="' + sid + '" title="' + sid + '">' +
        (STAMP_GLYPH[sid] || '◆') + '</button>';
    }).join('');
    return '<div class="rc-gb-form">' +
      '<div class="rc-stamp-picker">' + picker + '</div>' +
      '<input class="rc-gb-note" id="rcGbNote" maxlength="80" placeholder="Leave a short note (optional)">' +
      '<button class="btn-primary" id="rcGbSend" data-owner="' + esc(id) + '">Leave stamp</button>' +
    '</div>';
  }

  function guestbookList(stamps) {
    if (!stamps || !stamps.length) return '<div class="rc-gb-empty">No stamps yet — be the first to sign.</div>';
    var ordered = stamps.slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    return '<div class="rc-gb-list">' + ordered.map(function (s) {
      return '<div class="rc-gb-entry">' +
        '<span class="rc-gb-stamp">' + (STAMP_GLYPH[s.stamp] || '◆') + '</span>' +
        '<div class="rc-gb-body">' +
          '<div class="rc-gb-name">' + esc(s.name || 'A keeper') + '</div>' +
          (s.note ? '<div class="rc-gb-text">' + esc(s.note) + '</div>' : '') +
        '</div></div>';
    }).join('') + '</div>';
  }

  function renderRoom(data) {
    var room = data.room || {};
    var p = room.park || {};
    var you = data.you || {};
    var featureBtn = isBroadcaster()
      ? '<button class="btn-secondary" id="rcFeatureBtn" data-owner="' + esc(room.id) + '">★ Make Room of the Week</button>'
      : '';

    roomViewEl.innerHTML =
      '<div class="rc-dialog">' +
        '<div class="rc-dialog-head">' +
          avatarHtml(room.avatar, room.owner, 'rc-dialog-avatar') +
          '<div><h2 class="rc-dialog-title">' + esc(room.owner || 'A keeper') + '’s Park</h2>' +
            '<div class="rc-dialog-sub">Day ' + (p.parkDay || 1) + ' · ' +
              (Array.isArray(p.park) ? p.park.length : 0) + ' in the park · ' +
              (p.speciesDiscovered || 0) + ' species discovered' +
              (room.haunted ? ' · <span class="rc-haunted-tag">🎃 Haunted entry</span>' : '') + '</div></div>' +
          '<button class="rc-dialog-close" id="rcClose" aria-label="Close">×</button>' +
        '</div>' +
        showcaseHtml(room.favorite) +
        '<div class="rc-walk">' +
          '<a class="btn-primary" href="/games/dino-park/index.html?visit=' + esc(room.id) + '" target="_blank" rel="noopener">Walk through this park →</a>' +
          ' ' + featureBtn +
        '</div>' +
        '<div class="rc-gb-title">Guestbook</div>' +
        guestbookForm(room.id, you) +
        '<div id="rcGbList">' + guestbookList(data.guestbook) + '</div>' +
      '</div>';

    roomViewEl.hidden = false;
    document.body.style.overflow = 'hidden';
    wireRoom(room.id);
  }

  function closeRoom() {
    roomViewEl.hidden = true;
    roomViewEl.innerHTML = '';
    document.body.style.overflow = '';
    if (location.search) history.replaceState(null, '', '/room-crawl.html');
  }

  var selectedStamp = null;
  function wireRoom(id) {
    selectedStamp = null;
    var close = document.getElementById('rcClose');
    if (close) close.addEventListener('click', closeRoom);
    roomViewEl.addEventListener('click', function (e) { if (e.target === roomViewEl) closeRoom(); });

    roomViewEl.querySelectorAll('.rc-stamp').forEach(function (btn) {
      btn.addEventListener('click', function () {
        roomViewEl.querySelectorAll('.rc-stamp').forEach(function (b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        selectedStamp = btn.dataset.stamp;
      });
    });

    var send = document.getElementById('rcGbSend');
    if (send) send.addEventListener('click', function () {
      if (!selectedStamp) { alert('Pick a stamp first.'); return; }
      var note = (document.getElementById('rcGbNote') || {}).value || '';
      send.disabled = true;
      post({ action: 'guestbook', ownerId: id, stamp: selectedStamp, note: note }).then(function (res) {
        send.disabled = false;
        if (!res.ok) { alert((res.data && res.data.error) || 'Could not leave your stamp.'); return; }
        var list = document.getElementById('rcGbList');
        if (list) list.innerHTML = guestbookList(res.data.stamps);
        var noteEl = document.getElementById('rcGbNote');
        if (noteEl) noteEl.value = '';
      });
    });

    var feat = document.getElementById('rcFeatureBtn');
    if (feat) feat.addEventListener('click', function () {
      var note = prompt('A short note for the Room of the Week (optional):', '') || '';
      post({ action: 'room-of-week', ownerId: id, note: note }).then(function (res) {
        if (!res.ok) { alert((res.data && res.data.error) || 'Could not set Room of the Week.'); return; }
        closeRoom();
        load();
      });
    });
  }

  /* ── Wiring ───────────────────────────────────── */
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-open]');
    if (opener) { e.preventDefault(); openRoom(opener.dataset.open); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !roomViewEl.hidden) closeRoom();
  });

  function load() {
    return api('').then(function (res) {
      if (!res.ok) { galleryEl.innerHTML = '<div class="rc-empty card"><p>Could not load the crawl right now.</p></div>'; return; }
      render(res.data);
    }).catch(function () {
      galleryEl.innerHTML = '<div class="rc-empty card"><p>Could not reach the crawl right now.</p></div>';
    });
  }

  load().then(function () {
    var q = new URLSearchParams(location.search);
    var id = (q.get('id') || '').trim();
    var u = (q.get('u') || '').trim();
    if (id && /^[0-9]{1,20}$/.test(id)) openRoom(id);
    else if (u) api('?u=' + encodeURIComponent(u)).then(function (res) { if (res.ok) renderRoom(res.data); });
  });
})();
