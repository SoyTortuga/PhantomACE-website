/* A game opened straight from a shared link or bookmark loads top-level with
   no site chrome — a dead end. The normal path launches the game inside the
   /games.html iframe, which already has the full nav, so this runs ONLY when
   the game is the top document. It injects a slim bar with the primary site
   links (mirrors the header built by js/components.js) so there is always a
   way back into the site. Self-contained — no dependency on the site's nav
   CSS or scripts — and styled from the shared tokens in variables.css so it
   keeps the gothic palette and both themes. */
(function () {
  if (window.top !== window.self) return; // embedded in the launcher — nav is already there

  function build() {
    if (document.getElementById('gameTopNav')) return;

    var style = document.createElement('style');
    style.textContent =
      '#gameTopNav{position:fixed;top:0;left:0;right:0;z-index:2147483646;' +
      'display:flex;align-items:center;gap:4px;flex-wrap:wrap;' +
      'height:44px;padding:0 14px;box-sizing:border-box;' +
      'background:var(--black,#0a0a0a);border-bottom:1px solid var(--border-mid,#333);' +
      'font-family:var(--font-ui,system-ui,sans-serif);font-size:14px;overflow:hidden}' +
      '#gameTopNav a{color:var(--text-sec,#c9c9c9);text-decoration:none;' +
      'padding:6px 10px;border-radius:5px;white-space:nowrap;line-height:1}' +
      '#gameTopNav a:hover,#gameTopNav a:focus-visible{color:var(--white,#fff);' +
      'background:var(--gray-900,rgba(255,255,255,0.06))}' +
      '#gameTopNav .gtn-brand{color:var(--red,#ff0000);font-family:var(--font-display,var(--font-ui,system-ui));' +
      'font-size:16px;letter-spacing:.02em;margin-right:6px}' +
      '#gameTopNav .gtn-brand:hover,#gameTopNav .gtn-brand:focus-visible{color:var(--red,#ff0000);filter:brightness(1.25)}' +
      'body{padding-top:44px!important;box-sizing:border-box}';
    document.head.appendChild(style);

    var nav = document.createElement('nav');
    nav.id = 'gameTopNav';
    nav.setAttribute('aria-label', 'PhantomACE site navigation');
    var links = [
      ['/', '⟵ PhantomACE', 'gtn-brand'],
      ['/games.html', 'Games', ''],
      ['/events.html', 'Events', ''],
      ['/community.html', 'Community', ''],
      ['/membership/viewer', 'Phamily', ''],
      ['/media.html', 'Media', ''],
      ['/about.html', 'About', '']
    ];
    for (var i = 0; i < links.length; i++) {
      var a = document.createElement('a');
      a.href = links[i][0];
      a.textContent = links[i][1];
      if (links[i][2]) a.className = links[i][2];
      nav.appendChild(a);
    }
    document.body.insertBefore(nav, document.body.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
