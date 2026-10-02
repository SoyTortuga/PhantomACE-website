/* ══════════════════════════════════════════════
   THE SEASONAL GRIMOIRE — the collection-log section on a profile

   profile.js renders the person and announces it with 'profile:rendered';
   this listens, asks /api/grimoire for that person's per-month set, and draws
   it into the section profile.js left behind — the same seam the Room and the
   comment wall use.

   A month switcher across the top, then that month's set as a grid: owned
   cosmetics drawn full, missing ones greyed to a silhouette so the shape of
   what is left to collect is visible. A finished month shows its earned
   set-completion badge.

   EVERYTHING HERE IS SERVER-DEFINED DATA RENDERED AS SOMEONE ELSE'S PAGE, so
   every string goes through esc() and every image src through safeSrc().
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

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

  /* A readable word for the slot a cosmetic fills. */
  var TYPE_LABELS = {
    cardback: 'Card Back', emote: 'Emote Pack', dice: 'Dice',
    'skull-skin': 'Skull Skin', 'click-effect': 'Click Effect',
    'room-piece': 'Room Piece', 'room-set': 'Room Set',
    badge: 'Badge', title: 'Title', banner: 'Banner', nameeffect: 'Name Effect',
  };
  function typeLabel(t) { return TYPE_LABELS[t] || String(t || ''); }

  /* The glyph that stands in for a cosmetic with no artwork, by type — the same
     plain-emoji vocabulary the pass uses, never an icon library. */
  var TYPE_GLYPHS = {
    cardback: '🃏', emote: '😈', dice: '🎲', 'skull-skin': '💀',
    'click-effect': '✨', 'room-piece': '🛋️', 'room-set': '🛋️',
    badge: '🛡️', title: '👑', banner: '🏳️', nameeffect: '✨',
  };
  function typeGlyph(t) { return TYPE_GLYPHS[t] || '◆'; }

  /* One cosmetic tile. Owned ones draw their art (or glyph) full; missing ones
     are greyed to a silhouette — the name still shows, because the set is a
     public catalogue and the point is to know what is left to chase. */
  function tile(entry, owned) {
    var r = safeRarity(entry.rarity);
    var img = owned ? safeSrc(entry.image) : '';
    var glyph = typeGlyph(entry.type);
    var art = img
      ? '<img class="grim-art" src="' + esc(img) + '" alt="" data-glyph="' + esc(glyph) + '">'
      : '<span class="grim-glyph">' + esc(glyph) + '</span>';
    return '<div class="grim-item r-' + r + (owned ? '' : ' grim-missing') + '" title="' + esc(entry.name) + '">' +
      '<div class="grim-item-art">' + art +
        (owned ? '' : '<span class="grim-lock" aria-hidden="true">🔒</span>') + '</div>' +
      '<div class="grim-item-name">' + esc(entry.name) + '</div>' +
      '<div class="grim-item-meta">' +
        '<span class="grim-rarity r-' + r + '">' + esc(r) + '</span>' +
        '<span class="grim-type">' + esc(typeLabel(entry.type)) + '</span>' +
      '</div>' +
    '</div>';
  }

  function progressBar(owned, total) {
    var pct = total > 0 ? Math.round((owned / total) * 100) : 0;
    return '<div class="grim-progress" role="img" aria-label="' + owned + ' of ' + total + ' collected">' +
      '<div class="grim-progress-fill' + (owned >= total && total > 0 ? ' is-complete' : '') +
        '" style="width:' + pct + '%"></div>' +
    '</div>';
  }

  /* One month's panel: the completion banner (when finished), the progress line,
     then the owned grid and the still-missing grid. */
  function panel(m, isOwner) {
    var html = '';

    if (m.complete) {
      var badge = m.badge || {};
      var bImg = safeSrc(badge.image);
      var bArt = bImg
        ? '<img class="grim-badge-art" src="' + esc(bImg) + '" alt="" data-glyph="📖">'
        : '<span class="grim-badge-glyph">📖</span>';
      html += '<div class="grim-complete">' +
        bArt +
        '<div class="grim-complete-text">' +
          '<div class="grim-complete-title">Set complete — badge earned</div>' +
          '<div class="grim-complete-sub"><span class="grim-rarity r-' + safeRarity(badge.rarity) + '">' +
            esc(safeRarity(badge.rarity)) + '</span> ' + esc(badge.name || 'Grimoire') + '</div>' +
        '</div>' +
      '</div>';
    }

    html += '<div class="grim-summary">' +
      '<span class="grim-count">' + esc(m.ownedCount) + ' / ' + esc(m.total) + ' collected</span>' +
      (m.complete ? '' : '<span class="grim-remain">' + esc(m.missingCount) + ' to go</span>') +
    '</div>';
    html += progressBar(m.ownedCount, m.total);

    var owned = (m.owned || []).map(function (e) { return tile(e, true); }).join('');
    var missing = (m.missing || []).map(function (e) { return tile(e, false); }).join('');

    if (owned) {
      html += '<h3 class="grim-group-title">Collected</h3>' +
        '<div class="grim-grid">' + owned + '</div>';
    }
    if (missing) {
      html += '<h3 class="grim-group-title">Still missing</h3>' +
        '<div class="grim-grid">' + missing + '</div>';
    }
    if (!owned && !missing) {
      html += '<p class="grim-state">No collectibles in this season yet.</p>';
    }
    return html;
  }

  /* Swap a broken image for its glyph, the way profile.js handles badge art —
     collectible artwork may not have landed yet. */
  function wireArtFallback(host) {
    var arts = host.querySelectorAll('[data-glyph]');
    for (var i = 0; i < arts.length; i++) {
      arts[i].addEventListener('error', function () {
        var span = document.createElement('span');
        span.className = this.classList.contains('grim-badge-art') ? 'grim-badge-glyph' : 'grim-glyph';
        span.textContent = this.dataset.glyph || '◆';
        if (this.parentNode) this.parentNode.replaceChild(span, this);
      });
      if (arts[i].complete && arts[i].naturalWidth === 0) {
        arts[i].dispatchEvent(new Event('error'));
      }
    }
  }

  function render(host, data) {
    var months = data.months || [];
    if (!months.length) {
      host.innerHTML = '<p class="grim-state">No seasons to collect yet. ' +
        'Earn cosmetics through <a href="/membership">Phamily Time</a> and they fill in here.</p>';
      return;
    }

    var selected = 0;

    var switcher = '<div class="grim-months" role="tablist">' +
      months.map(function (m, i) {
        return '<button type="button" class="grim-month-btn' + (i === 0 ? ' is-active' : '') + '" ' +
          'data-i="' + i + '" role="tab" aria-selected="' + (i === 0) + '">' +
          '<span class="grim-month-label">' + esc(m.label) + '</span>' +
          '<span class="grim-month-count' + (m.complete ? ' is-complete' : '') + '">' +
            (m.complete ? '✦ complete' : esc(m.ownedCount) + '/' + esc(m.total)) + '</span>' +
        '</button>';
      }).join('') +
    '</div>';

    host.innerHTML = switcher + '<div class="grim-panel" id="grimPanel"></div>';

    var panelHost = host.querySelector('#grimPanel');
    function draw() {
      panelHost.innerHTML = panel(months[selected], data.isOwner);
      wireArtFallback(panelHost);
    }

    var btns = host.querySelectorAll('.grim-month-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        selected = Number(this.dataset.i) || 0;
        for (var j = 0; j < btns.length; j++) {
          var on = btns[j] === this;
          btns[j].classList.toggle('is-active', on);
          btns[j].setAttribute('aria-selected', on);
        }
        draw();
      });
    }

    draw();
  }

  document.addEventListener('profile:rendered', function (e) {
    var host = document.getElementById('profGrimoire');
    if (!host) return;
    var p = e.detail || {};
    var q = p.login ? ('u=' + encodeURIComponent(p.login))
      : (p.userId ? ('id=' + encodeURIComponent(p.userId)) : null);
    if (!q) { host.innerHTML = ''; return; }

    fetch('/api/grimoire?' + q, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('grimoire'); return r.json(); })
      .then(function (data) { render(host, data); })
      .catch(function () {
        host.innerHTML = '<p class="grim-state">Could not load the grimoire.</p>';
      });
  });
})();
