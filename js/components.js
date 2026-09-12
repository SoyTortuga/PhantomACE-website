document.addEventListener('DOMContentLoaded', () => {
  const headerEl = document.getElementById('site-header');
  const footerEl = document.getElementById('site-footer');

  if (headerEl) {
    headerEl.innerHTML = `
      <header class="site-header">
        <div class="header-inner">
          <a href="/" class="header-brand">
            <img src="/assets/images/phantomace-logo.png" alt="PhantomACE" width="36" height="36">
            <span class="header-brand-name">PhantomACE</span>
          </a>

          <nav class="site-nav" id="siteNav">
            <a href="/" data-page="home">Home</a>
            <a href="/about.html" data-page="about">About</a>
            <div class="nav-has-sub" data-page="events">
              <a href="/events.html" data-page="events">Events</a>
              <div class="nav-submenu">
                <a href="/events.html">Schedule</a>
                <a href="/giveaway.html">Giveaway</a>
                <a href="/redeem.html">Redeem Code</a>
              </div>
            </div>
            <a href="/media.html" data-page="media">Media</a>
            <a href="/games.html" data-page="games">Games</a>
            <div class="nav-has-sub" data-page="membership">
              <a href="/membership.html" data-page="membership">Phamily</a>
              <div class="nav-submenu">
                <a href="/membership.html#viewer">Viewer</a>
                <a href="/membership.html#follower">Follower</a>
                <a href="/membership.html#subscriber">Subscriber</a>
                <a href="/membership.html#vip">VIP</a>
                <a href="/membership.html#moderator">Moderator</a>
              </div>
            </div>
            <div class="nav-has-sub" data-page="community">
              <a href="/community.html" data-page="community">Community</a>
              <div class="nav-submenu">
                <a href="/community.html">Forums</a>
                <a href="/community-stats.html">Phamily Time</a>
                <a href="/community-leaderboards.html">Leaderboards</a>
              </div>
            </div>
          </nav>

          <div class="header-right">
            <div class="header-live-status" id="headerLiveStatus">
              <span class="status-dot"></span>
              <span>Offline</span>
            </div>
            <div class="notif-wrapper" id="notifBell">
              <button class="notif-bell-btn" onclick="toggleNotifPanel()" aria-label="Notifications" title="Notifications">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                <span class="notif-badge" id="notifBadge" style="display:none;"></span>
              </button>
              <div class="notif-panel" id="notifPanel"></div>
            </div>
            <button class="auth-login-btn" id="authLoginBtn" onclick="loginWithTwitch()">Log In</button>
            <div class="auth-user-info" id="authUserInfo">
              <button class="auth-user-trigger" id="authUserTrigger" aria-haspopup="true" aria-expanded="false">
                <img class="auth-user-avatar" id="authUserAvatar" src="" alt="" width="24" height="24">
                <img class="auth-user-badge" id="authUserBadge" src="" alt="" width="16" height="16" hidden>
                <span class="auth-user-name" id="authUserName"></span>
                <span class="auth-user-title" id="authUserTitle" hidden></span>
              </button>
              <div class="account-menu" id="accountMenu">
                <div class="account-menu-header" id="accountMenuName"></div>
                <a href="#" class="account-menu-item account-menu-item-disabled" aria-disabled="true">Profile <span class="account-menu-soon">Soon</span></a>
                <a href="/redeem.html" class="account-menu-item">Redeems</a>
                <a href="/inventory.html" class="account-menu-item">Inventory</a>
                <a href="#" class="account-menu-item account-menu-item-disabled" aria-disabled="true">Settings <span class="account-menu-soon">Soon</span></a>
                <button class="account-menu-item account-menu-item-danger" onclick="logout()">Logout</button>
              </div>
            </div>
            <button class="hamburger" id="hamburgerBtn" aria-label="Toggle navigation">
              <span></span>
              <span></span>
              <span></span>
            </button>
          </div>
        </div>
      </header>
      <div class="nav-backdrop" id="navBackdrop"></div>
    `;
  }

  if (footerEl) {
    const year = new Date().getFullYear();
    footerEl.innerHTML = `
      <footer class="site-footer">
        <img src="/assets/images/phantomace-logo.png" alt="" class="skull-watermark">
        <div class="footer-inner">
          <div>
            <div class="footer-brand">PhantomACE</div>
            <div class="footer-tagline">Digital Chaos & Drum Fills</div>
          </div>

          <div class="footer-social">
            <a href="https://twitch.tv/phantomace" target="_blank" rel="noopener">Twitch</a>
            <a href="https://discord.gg/PhantomAce" target="_blank" rel="noopener">Discord</a>
            <a href="https://x.com/PhantomACE" target="_blank" rel="noopener">Twitter/X</a>
            <a href="https://www.youtube.com/@PhantomACE" target="_blank" rel="noopener">YouTube</a>
            <a href="https://www.instagram.com/phantomace_/" target="_blank" rel="noopener">Instagram</a>
            <a href="https://www.tiktok.com/@phantomaceirl" target="_blank" rel="noopener">TikTok</a>
          </div>

          <nav class="footer-links">
            <a href="/">Home</a>
            <a href="/about.html">About</a>
            <a href="/events.html">Events</a>
            <a href="/giveaway.html">Giveaway</a>
            <a href="/redeem.html">Redeem Code</a>
            <a href="/media.html">Media</a>
            <a href="/games.html">Games</a>
            <a href="/membership.html">Phamily</a>
            <a href="/community.html">Community</a>
          </nav>

          <div class="footer-bottom">
            <span>&copy; ${year} PhantomACE. All rights reserved.</span>
          </div>
        </div>
      </footer>
    `;
  }

  /* auth.js's applyRole() runs on this same DOMContentLoaded event, but
     its listener is registered first (its <script> tag comes before this
     one on every page), so it fires before the header/footer above even
     exist — meaning it never finds #authLoginBtn/#authUserInfo to update.
     Call it again now that they're actually in the DOM. */
  if (typeof applyRole === 'function') {
    applyRole();
  }

  initAccountMenu();
});

function initAccountMenu() {
  const trigger = document.getElementById('authUserTrigger');
  const menu = document.getElementById('accountMenu');
  if (!trigger || !menu) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.toggle('open');
    trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });

  document.addEventListener('click', (e) => {
    if (menu.classList.contains('open') && !menu.contains(e.target) && e.target !== trigger) {
      menu.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')) {
      menu.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    }
  });
}
