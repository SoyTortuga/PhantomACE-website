/* ══════════════════════════════════════════════
   MEMBER SEARCH

   Lives in the header, so it is on every page: looking somebody up is
   something you do FROM anywhere, not something you do once you are
   already standing on a profile.

   THREE THINGS IT HAS TO GET RIGHT, all consequences of the endpoint being
   a scan rather than an index:

     It is debounced, because every keystroke would otherwise start another
     scan. It takes two characters minimum, because one matches most of the
     channel. And every request carries a sequence number so only the
     newest may write — without that, a slow reply for "sa" can land after
     a fast one for "samii" and replace the right answers with stale ones.

   The header is injected by components.js, so this waits for the input to
   exist rather than assuming it does.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var MIN_CHARS = 2;
  var DEBOUNCE_MS = 220;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function wire(input, list) {
    var timer = null;
    var seq = 0;

    function close() { list.hidden = true; list.innerHTML = ''; }

    function run(term) {
      var mine = ++seq;
      fetch('/api/profile?q=' + encodeURIComponent(term), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : { results: [] }; })
        .then(function (d) {
          if (mine !== seq) return;           // a newer search has overtaken this one
          var rows = d.results || [];
          if (!rows.length) {
            list.innerHTML = '<li class="member-result-none">Nobody by that name</li>';
            list.hidden = false;
            return;
          }
          list.innerHTML = rows.map(function (r) {
            return '<li><a href="/user/' + encodeURIComponent(r.login) + '">' +
              (r.avatar
                ? '<img src="' + esc(r.avatar) + '" alt="">'
                : '<span class="member-result-blank"></span>') +
              '<span>' + esc(r.displayName) + '</span></a></li>';
          }).join('');
          list.hidden = false;
        })
        .catch(function () { if (mine === seq) close(); });
    }

    input.addEventListener('input', function () {
      var term = input.value.trim();
      clearTimeout(timer);
      if (term.length < MIN_CHARS) { seq++; close(); return; }
      timer = setTimeout(function () { run(term); }, DEBOUNCE_MS);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; seq++; close(); input.blur(); }
    });

    /* Re-open on focus if there is still something to show, so tabbing back
       does not silently lose results that are still on screen. */
    input.addEventListener('focus', function () {
      if (list.innerHTML && input.value.trim().length >= MIN_CHARS) list.hidden = false;
    });

    document.addEventListener('click', function (e) {
      if (!list.hidden && !input.contains(e.target) && !list.contains(e.target)) close();
    });
  }

  /* components.js writes the header into #site-header, and the order the
     two run in is not guaranteed. Rather than depend on it, watch for the
     input and wire it the moment it appears. */
  function attach() {
    var input = document.getElementById('memberSearchInput');
    var list = document.getElementById('memberResults');
    if (!input || !list || input.dataset.wired) return false;
    input.dataset.wired = '1';
    wire(input, list);
    return true;
  }

  if (!attach()) {
    var obs = new MutationObserver(function () {
      if (attach()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    /* A page without a header is not a fault — the overlay has none — so
       the watcher gives up rather than running for the life of the page. */
    setTimeout(function () { obs.disconnect(); }, 10000);
  }
})();
