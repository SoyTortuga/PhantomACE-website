/* ══════════════════════════════════════════════
   ACTIVITY FEED PAGE
   Polls /api/activity (broadcaster/mod-gated) and renders each event with an
   expandable raw payload. Category is filtered server-side.
   ══════════════════════════════════════════════ */
(function () {
  'use strict';

  var POLL_MS = 5000;
  var currentCategory = 'all';
  var pollTimer = null;
  var lastEvents = [];

  function el(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  function relTime(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return new Date(ts).toLocaleString();
  }

  var CHIP = {
    sub: 'Sub', resub: 'Resub', giftsub: 'Gift', raid: 'Raid', follow: 'Follow',
    cheer: 'Cheer', hype: 'Hype', redemption: 'Redeem', bot: 'Bot',
  };

  /* Categories whose rows can be re-fired on the overlay (match
     overlayEventFromActivity in functions/api/activity.js). */
  var REPLAYABLE = { sub: 1, resub: 1, giftsub: 1, raid: 1, follow: 1, cheer: 1, hype: 1 };

  function isLoggedIn() {
    return /(?:^|;\s*)pham_session=/.test(document.cookie || '');
  }

  function showDenied() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    var panel = el('activityPanel');
    var denied = el('activityDenied');
    if (panel) panel.hidden = true;
    if (denied) denied.hidden = false;
    var loginBtn = el('activityLoginBtn');
    var text = el('activityDeniedText');
    if (isLoggedIn()) {
      if (loginBtn) loginBtn.hidden = true;
      if (text) text.textContent = 'This page is for the broadcaster and moderators only.';
    } else {
      if (loginBtn) loginBtn.hidden = false;
      if (text) text.textContent = 'Log in with the broadcaster or a moderator account to view the activity feed.';
    }
  }

  function showPanel() {
    var denied = el('activityDenied');
    var panel = el('activityPanel');
    if (denied) denied.hidden = true;
    if (panel) panel.hidden = false;
  }

  function render(events) {
    var feed = el('activityFeed');
    if (!feed) return;
    if (!events || events.length === 0) {
      feed.innerHTML = '<li class="act-empty">Nothing yet — events show up here as they happen.</li>';
      return;
    }
    feed.innerHTML = events.map(function (e) {
      var chip = CHIP[e.category] || (e.category || 'event');
      var payload = '';
      if (e.payload != null) {
        var pretty;
        try { pretty = JSON.stringify(e.payload, null, 2); } catch (err) { pretty = String(e.payload); }
        payload =
          '<button class="act-payload-toggle" type="button" data-id="' + escapeHtml(e.id) + '">▸ View payload</button>' +
          '<pre class="act-payload" id="pl-' + escapeHtml(e.id) + '" hidden>' + escapeHtml(pretty) + '</pre>';
      }
      var replay = REPLAYABLE[e.category]
        ? '<button class="act-replay" type="button" data-id="' + escapeHtml(e.id) + '" title="Re-fire this alert on the overlay">↺ Replay</button>'
        : '';
      return '<li class="act-item">' +
        '<div class="act-item-head">' +
          '<span class="act-chip">' + escapeHtml(chip) + '</span>' +
          '<span class="act-summary">' + escapeHtml(e.summary || e.type || 'event') + '</span>' +
          replay +
          '<span class="act-time" title="' + escapeHtml(new Date(e.at).toLocaleString()) + '">' + escapeHtml(relTime(e.at)) + '</span>' +
        '</div>' +
        payload +
      '</li>';
    }).join('');
  }

  function fetchFeed() {
    var q = currentCategory && currentCategory !== 'all' ? ('?category=' + encodeURIComponent(currentCategory)) : '';
    fetch('/api/activity' + q, { credentials: 'same-origin' })
      .then(function (res) {
        if (res.status === 403 || res.status === 401) { showDenied(); return null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        showPanel();
        lastEvents = data.events || [];
        render(lastEvents);
      })
      .catch(function () { /* transient — keep the last render, try again next poll */ });
  }

  function replayAlert(btn) {
    var id = btn.getAttribute('data-id');
    if (!id || btn.disabled) return;
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    fetch('/api/activity', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'replay', id: id }),
    })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, d: d }; }); })
      .then(function (r) {
        btn.textContent = r.ok && r.d.success ? '✓ Sent' : '✗ Failed';
        setTimeout(function () { btn.textContent = original; btn.disabled = false; }, 2000);
      })
      .catch(function () {
        btn.textContent = '✗ Failed';
        setTimeout(function () { btn.textContent = original; btn.disabled = false; }, 2000);
      });
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchFeed, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function wire() {
    var filters = el('activityFilters');
    if (filters) {
      filters.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.act-filter');
        if (!btn) return;
        currentCategory = btn.getAttribute('data-cat') || 'all';
        var all = filters.querySelectorAll('.act-filter');
        for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
        btn.classList.add('active');
        fetchFeed();
      });
    }

    var feed = el('activityFeed');
    if (feed) {
      feed.addEventListener('click', function (ev) {
        var replayBtn = ev.target.closest('.act-replay');
        if (replayBtn) { replayAlert(replayBtn); return; }
        var t = ev.target.closest('.act-payload-toggle');
        if (!t) return;
        var pre = document.getElementById('pl-' + t.getAttribute('data-id'));
        if (!pre) return;
        pre.hidden = !pre.hidden;
        t.textContent = (pre.hidden ? '▸' : '▾') + ' View payload';
      });
    }

    var live = el('activityLive');
    if (live) {
      live.addEventListener('change', function () {
        if (live.checked) { fetchFeed(); startPolling(); }
        else stopPolling();
      });
    }
  }

  function init() {
    wire();
    showPanel();      // show the panel + "Loading…" immediately; 403 flips to denied
    fetchFeed();
    startPolling();
    /* Pause polling while the tab is hidden — no point hammering the rig when
       nobody is looking, and it resumes on return. */
    document.addEventListener('visibilitychange', function () {
      var live = el('activityLive');
      if (document.hidden) stopPolling();
      else if (!live || live.checked) { fetchFeed(); startPolling(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
