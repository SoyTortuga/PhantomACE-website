/* ══════════════════════════════════════════════
   HOMEPAGE — Upcoming Events and Latest Media

   Both sections shipped as hardcoded placeholders: three cards reading
   "Coming Soon / Events Loading", "TBD / Community Game Night", "TBD /
   Phamathon", and a permanent "No items in this category yet." Nothing
   on the page ever replaced them, so the front door told every visitor
   the site was still loading, forever.

   The data was already there. /api/twitch-schedule reads the real Twitch
   schedule with an APP token — no broadcaster OAuth, so it works today —
   and /api/media returns the role-filtered gallery index.

   RENDERED INTO THE HOMEPAGE'S OWN CARDS rather than by importing the
   renderers from events.js and media.js. Those build the fuller cards
   those pages want (calendar links, lightbox wiring, remove buttons) and
   both files bootstrap themselves against elements that do not exist
   here. A preview is a different thing from a gallery.

   FAILING QUIETLY IS THE POINT. If either fetch fails the placeholder
   stays, which is a readable page. The one thing not to do is replace a
   section with an error — the schedule is empty for perfectly ordinary
   reasons, like the broadcaster not having set one.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var EVENTS_SHOWN = 3;
  var MEDIA_SHOWN = 4;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── Upcoming events ─────────────────────────────────────────────── */

  function eventCard(seg) {
    var start = new Date(seg.start_time);
    if (isNaN(start)) return '';

    var when = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      + ' · ' + start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    /* The category is the useful second line — "Just Chatting" or the game
       being played says more about whether to turn up than a repeat of the
       title would. */
    var desc = seg.category
      ? esc(seg.category)
      : 'On the PhantomACE channel.';

    return '<div class="card event-card">'
      + '<div class="event-card-date">' + esc(when.toUpperCase()) + '</div>'
      + '<div class="event-card-title">' + esc(seg.title || 'Untitled stream') + '</div>'
      + '<div class="event-card-desc">' + desc + '</div>'
      + '</div>';
  }

  async function loadEvents() {
    var host = document.getElementById('upcomingEvents');
    if (!host) return;
    try {
      var res = await fetch('/api/twitch-schedule');
      if (!res.ok) return;
      var data = await res.json();
      var segs = Array.isArray(data.segments) ? data.segments : [];

      /* Past segments can ride along in the payload; this is the UPCOMING
         list. Sorted because the API's order is its own business. */
      var now = Date.now();
      var upcoming = segs
        .filter(function (s) { return s && s.start_time && new Date(s.start_time).getTime() >= now; })
        .sort(function (a, b) { return new Date(a.start_time) - new Date(b.start_time); })
        .slice(0, EVENTS_SHOWN);

      if (!upcoming.length) {
        host.innerHTML = '<div class="card event-card">'
          + '<div class="event-card-date">No dates yet</div>'
          + '<div class="event-card-title">Nothing on the schedule</div>'
          + '<div class="event-card-desc">PhantomACE streams whenever the mood takes him. '
          + 'Follow on Twitch to get the ping.</div>'
          + '</div>';
        return;
      }

      var html = upcoming.map(eventCard).join('');
      if (html) host.innerHTML = html;
    } catch (e) {
      /* Placeholder stays. See the header. */
    }
  }

  /* ── Latest media ────────────────────────────────────────────────── */

  function mediaTile(item) {
    var inner;
    if (item.type === 'video') {
      inner = '<video src="' + esc(item.url) + '" preload="metadata" muted playsinline></video>';
    } else if (item.type === 'audio') {
      inner = '<div class="gallery-audio"><span class="gallery-audio-mark" aria-hidden="true">&#9834;</span>'
        + '<audio src="' + esc(item.url) + '" controls preload="none"></audio></div>';
    } else {
      inner = '<img src="' + esc(item.url) + '" alt="' + esc(item.title || '') + '" loading="lazy">';
    }

    /* Audio carries its own controls, so the tile must not also be a link
       to the gallery — the click would fight the play button. */
    if (item.type === 'audio') {
      return '<div class="home-media-tile">' + inner
        + '<span class="home-media-title">' + esc(item.title || '') + '</span></div>';
    }
    return '<a class="home-media-tile" href="/media.html">' + inner
      + '<span class="home-media-title">' + esc(item.title || '') + '</span></a>';
  }

  async function loadMedia() {
    var host = document.getElementById('latestMedia');
    if (!host) return;
    try {
      /* same-origin so the role filter applies — a subscriber-only clip
         should not appear here for a visitor. */
      var res = await fetch('/api/media', { credentials: 'same-origin' });
      if (!res.ok) return;
      var data = await res.json();
      var items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) return;        // the empty state already says this

      var latest = items
        .slice()
        .sort(function (a, b) { return (b.uploadedAt || 0) - (a.uploadedAt || 0); })
        .slice(0, MEDIA_SHOWN);

      host.innerHTML = latest.map(mediaTile).join('');
    } catch (e) {
      /* Empty state stays. */
    }
  }

  function init() {
    loadEvents();
    loadMedia();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
