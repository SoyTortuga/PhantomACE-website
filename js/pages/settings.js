/* ══════════════════════════════════════════════
   SETTINGS — the switches that were scattered

   NOTHING HERE IS NEW. Every switch on this page already existed and was
   reachable from exactly one place that had nothing to do with settings:
   the theme from a glyph in the header, profile comments and @mentions from
   a checkbox under your own profile wall, and whether other players may
   visit your park from inside the Dino Park collection screen. Somebody
   looking for "my privacy settings" had no reason to look in a game.

   So this page GATHERS them. It reads them all in one request from
   /api/settings and writes each one back through the route that owns and
   enforces it — never through a second copy of the rule:

     comments / mentions   POST /api/forum/comments { action: 'settings' }
     park visitors         POST /api/dino-park      { action: 'set-visitable' }
     role re-check         refreshMyRole() in js/auth.js, the same function
                           the account menu's button calls
     theme                 setTheme() in js/components.js, the same function
                           the header glyph calls

   CONSENT IS NEVER REPORTED OPTIMISTICALLY. A switch moves at once because
   a control that lags feels broken, but a refusal puts it straight back and
   says so. Showing "open to visitors" when the server never accepted it is
   the one failure on this page that actually matters.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var NOTIF_KEY = 'pa_notifications';
  var NOTIF_READ_KEY = 'pa_notif_last_read';
  var NOTIF_PERM_KEY = 'pa_notif_desktop_asked';

  function $(id) { return document.getElementById(id); }

  function api(path, body) {
    var opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' }
      : { cache: 'no-store' };
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { ok: r.ok, status: r.status, data: d || {} };
      });
    });
  }

  /** A per-card line. Overwritten on the next change so it never goes stale. */
  function say(card, text, state) {
    var el = card && card.querySelector('.set-status');
    if (!el) return;
    el.classList.remove('ok', 'err');
    if (state) el.classList.add(state);
    el.textContent = text || '';
  }

  /* ── Account ─────────────────────────────────────────────────────────── */

  function renderAccount(d) {
    var a = d.account || {};
    var name = $('setName');
    if (name) name.textContent = a.displayName || 'You';

    var img = $('setAvatar');
    /* HTTPS only. The avatar comes from our own session cookie rather than
       from a request, but an <img src> built from stored text is worth
       pinning to a scheme either way. */
    if (img && /^https:\/\//.test(a.avatar || '')) { img.src = a.avatar; img.hidden = false; }

    var since = $('setSince');
    if (since) {
      var t = a.firstSeen ? Date.parse(a.firstSeen) : 0;
      since.textContent = t
        ? 'Here since ' + new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
        : '';
    }

    var link = $('setProfileLink');
    if (link && a.login) link.href = '/user/' + encodeURIComponent(a.login);

    /* The badge and the message below it ARE the header's control, reused by
       class. renderRoleBadge writes to every copy, so this fills both. */
    if (typeof renderRoleBadge === 'function') renderRoleBadge(a.role);
  }

  /* ── Theme ───────────────────────────────────────────────────────────── */

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function paintTheme() {
    var now = currentTheme();
    var btns = document.querySelectorAll('[data-theme-set]');
    Array.prototype.forEach.call(btns, function (b) {
      var on = b.getAttribute('data-theme-set') === now;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function wireTheme() {
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-theme-set]') : null;
      if (!btn) return;
      /* The header's own function, so the attribute, the stored key and the
         glyph all move together. A second implementation here is how the
         toggle and this page would start disagreeing. */
      if (typeof setTheme === 'function') setTheme(btn.getAttribute('data-theme-set'));
      paintTheme();
    });

    /* THE HEADER GLYPH IS STILL THERE. Flip the theme from it while this
       page is open and the picker would go on lighting the theme you just
       left, which is worse than having no picker. Watching the attribute
       catches that writer and any other. */
    if (typeof MutationObserver === 'function') {
      new MutationObserver(paintTheme).observe(document.documentElement, {
        attributes: true, attributeFilter: ['data-theme'],
      });
    }

    paintTheme();
  }

  /* ── Privacy ─────────────────────────────────────────────────────────── */

  /* Which route owns each switch, and what it calls the field. The page
     never invents a write: this table is the whole of it. */
  var SWITCHES = {
    comments: { path: '/api/forum/comments', body: function (on) { return { action: 'settings', commentsEnabled: on }; } },
    mentions: { path: '/api/forum/comments', body: function (on) { return { action: 'settings', mentionsEnabled: on }; } },
    park:     { path: '/api/dino-park',      body: function (on) { return { action: 'set-visitable', visitable: on }; } }
  };

  function box(key) { return document.querySelector('[data-switch="' + key + '"]'); }

  function renderPrivacy(d) {
    var c = box('comments'); if (c) c.checked = !!d.commentsEnabled;
    var m = box('mentions'); if (m) m.checked = !!d.mentionsEnabled;
    var p = box('park');     if (p) p.checked = !!d.parkVisitable;

    /* THE SWITCHES LIVE ON THE PROFILE RECORD. Without one there is nothing
       to write and the route answers 404, so say why up front rather than
       letting a save fail with "there is no profile to change yet". */
    if (!d.hasProfile) {
      if (c) c.disabled = true;
      if (m) m.disabled = true;
      var note = $('setProfileNote');
      if (note) note.hidden = false;
    }

    /* A park with nothing in it is not a privacy choice yet. Turning it OFF
       stays available regardless: a consent row that exists must always be
       removable, whatever became of the save. */
    if (!d.hasPark && !d.parkVisitable) {
      if (p) p.disabled = true;
      var pnote = $('setParkNote');
      if (pnote) pnote.hidden = false;
    }
  }

  function wireSwitches() {
    document.addEventListener('change', function (e) {
      var sw = e.target;
      if (!sw || !sw.getAttribute) return;
      var key = sw.getAttribute('data-switch');
      var rule = key && SWITCHES[key];
      if (!rule) return;

      var card = sw.closest('.set-card');
      var want = !!sw.checked;
      sw.disabled = true;
      say(card, 'Saving…', '');

      api(rule.path, rule.body(want)).then(function (r) {
        sw.disabled = false;
        if (!r.ok) {
          sw.checked = !want;
          say(card, r.data.error || 'Could not save that. Try again.', 'err');
          return;
        }
        /* Believe the SERVER's answer rather than the click — each of these
           routes echoes the state it actually stored. */
        var d = r.data;
        if (key === 'comments' && typeof d.commentsEnabled === 'boolean') sw.checked = d.commentsEnabled;
        if (key === 'mentions' && typeof d.mentionsEnabled === 'boolean') sw.checked = d.mentionsEnabled;
        if (key === 'park' && typeof d.visitable === 'boolean') sw.checked = d.visitable;
        say(card, 'Saved.', 'ok');
      }).catch(function () {
        sw.disabled = false;
        sw.checked = !want;
        say(card, 'Network error — nothing was changed.', 'err');
      });
    });
  }

  /* ── Alerts ──────────────────────────────────────────────────────────── */

  /* The site asks for desktop notification permission ONCE, remembers that
     it asked, and never asks again. Dismiss that prompt and there was no way
     back. This is the way back. */
  function renderAlerts() {
    var state = $('setNotifState');
    var btn = $('setNotifEnable');
    var perm = ('Notification' in window) ? Notification.permission : 'unsupported';

    if (state) {
      state.textContent =
        perm === 'granted' ? 'On — your browser will pop an alert when the stream goes live.'
        : perm === 'denied' ? 'Blocked by your browser. Allow notifications for this site in your browser settings, then reload.'
        : perm === 'unsupported' ? 'This browser does not do desktop notifications.'
        : 'Off. The bell in the header still works either way.';
    }
    /* Only offer the button when asking can still do something: once the
       answer is granted or denied, only the browser can change it. */
    if (btn) btn.hidden = perm !== 'default';

    var count = $('setNotifCount');
    if (count) {
      var n = 0;
      try { n = (JSON.parse(localStorage.getItem(NOTIF_KEY) || '[]') || []).length; } catch (e) { n = 0; }
      count.textContent = n === 0 ? 'Nothing stored.'
        : n === 1 ? '1 notification kept in this browser.'
        : n + ' notifications kept in this browser.';
    }
  }

  function wireAlerts() {
    var btn = $('setNotifEnable');
    if (btn) {
      btn.addEventListener('click', function () {
        if (!('Notification' in window)) return;
        /* Clear the asked-already flag too, so the header stops suppressing
           its own prompt on this device. */
        try { localStorage.removeItem(NOTIF_PERM_KEY); } catch (e) { /* private mode */ }
        var done = function () { renderAlerts(); };
        try {
          /* Both shapes: older browsers take a callback, newer ones return a
             promise, and Safari did both for years. */
          var p = Notification.requestPermission(done);
          if (p && typeof p.then === 'function') p.then(done, done);
        } catch (e) { done(); }
      });
    }

    var clear = $('setNotifClear');
    if (clear) {
      clear.addEventListener('click', function () {
        try {
          localStorage.removeItem(NOTIF_KEY);
          localStorage.setItem(NOTIF_READ_KEY, String(Date.now()));
        } catch (e) { /* private mode */ }
        renderAlerts();
        say(clear.closest('.set-card'), 'Cleared on this device.', 'ok');
      });
    }
  }

  /* ── Load ────────────────────────────────────────────────────────────── */

  function show(which) {
    ['setLoading', 'setGuest', 'setBody'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = id !== which;
    });
  }

  function load() {
    api('/api/settings').then(function (r) {
      if (r.status === 401) { show('setGuest'); return; }
      if (!r.ok) {
        show('setLoading');
        var el = $('setLoading');
        if (el) el.textContent = r.data.error || 'Could not read your settings right now. Reload to try again.';
        return;
      }
      renderAccount(r.data);
      renderPrivacy(r.data);
      renderAlerts();
      show('setBody');
    }).catch(function () {
      show('setLoading');
      var el = $('setLoading');
      if (el) el.textContent = 'Could not reach the server. Reload to try again.';
    });
  }

  function init() {
    wireTheme();
    wireSwitches();
    wireAlerts();
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
