/* ══════════════════════════════════════════════
   MINECRAFT — the subscriber server page

   Four states, and the page shows exactly one: logged out, logged in but
   not a subscriber, subscriber without a whitelist entry, subscriber with
   one. Everything ships hidden and is revealed once /api/minecraft has
   answered, so nobody is told they are not a subscriber while the page is
   still finding out.

   NOTHING HERE DECIDES ELIGIBILITY. The route does, on the write. This
   file only draws what it is told — a copy of the rule would be a copy
   that drifts, and the version that matters is the one the server
   enforces.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

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

  function say(text, state) {
    var el = $('mcWhitelistStatus');
    if (!el) return;
    el.classList.remove('ok', 'err');
    if (state) el.classList.add(state);
    el.textContent = text || '';
  }

  function show(which) {
    ['mcLoading', 'mcGuest', 'mcNotSub', 'mcBody'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = id !== which;
    });
  }

  /* ── Dates ───────────────────────────────────────────────────────── */

  function dayStr(ts) {
    var d = new Date(ts);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function daysLeft(ts) {
    return Math.ceil((ts - Date.now()) / 86400000);
  }

  /* ── The whitelist panel ─────────────────────────────────────────── */

  var state = { you: null, twitchName: '', graceDays: 7 };

  function renderWhitelist() {
    var host = $('mcWhitelistBody');
    if (!host) return;

    if (!state.you) {
      host.innerHTML =
        '<p class="mc-lead">Put your <strong>Java Edition</strong> username in and you can hop on. Not your Twitch name &mdash; the one you log into Minecraft with.</p>' +
        '<form class="mc-form" id="mcForm">' +
          '<input type="text" id="mcName" maxlength="16" autocomplete="off" spellcheck="false" ' +
            'placeholder="Minecraft username" aria-label="Your Minecraft Java username" required>' +
          '<button class="btn-primary" type="submit">Add me</button>' +
        '</form>' +
        '<p class="mc-hint">We check it with Mojang before saving, so a typo is caught here rather than at the door.</p>';
      return;
    }

    var left = daysLeft(state.you.expiresAt);
    var warn = state.you.active && left <= 3;

    host.innerHTML =
      '<div class="mc-you' + (state.you.active ? '' : ' is-lapsed') + '">' +
        '<span class="mc-you-mark" aria-hidden="true">' + (state.you.active ? '✓' : '!') + '</span>' +
        '<span class="mc-you-text">' +
          (state.you.active
            ? 'You’re whitelisted as <strong>' + esc(state.you.name) + '</strong>'
            : 'Your spot lapsed &mdash; <strong>' + esc(state.you.name) + '</strong> is off the list') +
        '</span>' +
        '<button class="pill-btn" type="button" id="mcLeave">Remove me</button>' +
      '</div>' +
      (state.you.active
        ? '<p class="mc-hint">Hop on any time. If your sub lapses you keep your spot for ' +
            state.graceDays + ' days, then it comes off automatically' +
            (warn ? ' &mdash; <strong>' + (left <= 0 ? 'today' : left + ' day' + (left === 1 ? '' : 's') + ' left') + '</strong>' : '') +
            '.' +
            (state.twitchName ? ' Your Twitch name (' + esc(state.twitchName) + ') shows beside your Minecraft name in game.' : '') +
          '</p>'
        : '<p class="mc-hint">Your sub lapsed more than ' + state.graceDays + ' days ago. Resubscribe and log in again, then add yourself back &mdash; your builds are untouched.</p>');
  }

  /* ── Server facts ────────────────────────────────────────────────── */

  function renderJoin(join) {
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
    var addr = join.port && join.port !== 25565 ? join.host : join.host;
    set('mcAddress', addr);
    set('mcPackName', join.name || 'Cursed Walking');
    set('mcPackVersion', join.packVersion || '');
    set('mcStepVersion', join.packVersion || '');
    set('mcRamMin', String(join.ramMinGb || 4));
    set('mcRamRec', String(join.ramRecommendedGb || 6));
    set('mcFactPack', join.pack || '');
    set('mcFactMc', (join.loader ? join.loader + ' ' : '') + (join.minecraft || ''));
    set('mcFactLoader', join.loader || '');
    set('mcFactAddress', addr);
    var link = $('mcPackLink');
    if (link && join.curseforge) link.href = join.curseforge;
  }

  function renderStatus(server) {
    var live = $('mcLive');
    var text = $('mcLiveText');
    var players = $('mcFactPlayers');
    if (!live || !text) return;

    if (!server) {
      live.setAttribute('data-state', 'unknown');
      text.textContent = 'Status unavailable';
      if (players) players.textContent = '—';
      return;
    }
    if (!server.online) {
      live.setAttribute('data-state', 'off');
      /* The panel can distinguish these; a port ping cannot, and they are
         the states somebody is on this page to understand. */
      text.textContent = server.crashed ? 'Crashed — a mod has been told'
        : server.starting ? 'Starting up…'
        : 'Offline';
      if (players) players.textContent = '—';
      return;
    }
    live.setAttribute('data-state', 'on');
    text.textContent = 'Online ' + server.players + '/' + server.max;
    if (players) players.textContent = server.players + ' / ' + server.max;

    var motd = $('mcMotd');
    if (motd && server.motd) { motd.textContent = server.motd; motd.hidden = false; }
  }

  /* ── Actions ─────────────────────────────────────────────────────── */

  function wire() {
    var copy = $('mcCopy');
    if (copy) {
      copy.addEventListener('click', function () {
        var addr = ($('mcAddress') || {}).textContent || '';
        var done = function (ok) {
          copy.textContent = ok ? 'Copied' : 'Press Ctrl+C';
          setTimeout(function () { copy.textContent = 'Copy'; }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(addr).then(function () { done(true); }, function () { done(false); });
        } else {
          /* No clipboard API (or an insecure context): select it so the
             keyboard shortcut works rather than leaving a dead button. */
          try {
            var r = document.createRange();
            r.selectNodeContents($('mcAddress'));
            var sel = window.getSelection();
            sel.removeAllRanges(); sel.addRange(r);
            done(false);
          } catch (e) { done(false); }
        }
      });
    }

    /* Delegated: the panel is re-rendered after every change, so handlers
       bound to its children would be lost (and stacking them is how a
       Remove button ends up firing three times). */
    document.addEventListener('submit', function (e) {
      if (!e.target || e.target.id !== 'mcForm') return;
      e.preventDefault();
      var input = $('mcName');
      var name = (input && input.value || '').trim();
      if (!name) return;
      var btn = e.target.querySelector('button');
      if (btn) btn.disabled = true;
      say('Checking that name with Mojang…', '');

      api('/api/minecraft', { action: 'join', name: name }).then(function (r) {
        if (btn) btn.disabled = false;
        if (!r.ok) { say(r.data.error || 'Could not add you. Try again.', 'err'); return; }
        state.you = r.data.you;
        renderWhitelist();
        say('Added. You can join now.', 'ok');
      }).catch(function () {
        if (btn) btn.disabled = false;
        say('Network error — nothing was changed.', 'err');
      });
    });

    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('#mcLeave') : null;
      if (!btn) return;
      btn.disabled = true;
      say('Removing…', '');
      api('/api/minecraft', { action: 'leave' }).then(function (r) {
        if (!r.ok) { btn.disabled = false; say(r.data.error || 'Could not remove you.', 'err'); return; }
        state.you = null;
        renderWhitelist();
        say('Removed. The server picks it up on its next sync.', 'ok');
      }).catch(function () {
        btn.disabled = false;
        say('Network error — nothing was changed.', 'err');
      });
    });
  }

  /* ── Load ────────────────────────────────────────────────────────── */

  function load() {
    api('/api/minecraft').then(function (r) {
      if (!r.ok) {
        var el = $('mcLoading');
        if (el) el.textContent = r.data.error || 'Could not load the server details. Reload to try again.';
        return;
      }
      var d = r.data;
      renderJoin(d.join || {});
      renderStatus(d.server);

      if (!d.loggedIn) { show('mcGuest'); return; }
      if (!d.eligible) { show('mcNotSub'); return; }

      state.you = d.you;
      state.twitchName = d.twitchName || '';
      state.graceDays = d.graceDays || 7;
      renderWhitelist();
      show('mcBody');
    }).catch(function () {
      var el = $('mcLoading');
      if (el) el.textContent = 'Could not reach the server. Reload to try again.';
    });
  }

  function init() { wire(); load(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
