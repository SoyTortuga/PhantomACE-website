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
            <a href="/events.html" data-page="events">Events</a>
            <a href="/media.html" data-page="media">Media</a>
            <a href="/games.html" data-page="games">Games</a>
            <a href="/membership.html" data-page="membership">Membership</a>
            <a href="/community.html" data-page="community">Community</a>
            <a href="/api/auth/twitch" class="nav-auth-link" id="navAuthLink">Log In with Twitch</a>
          </nav>

          <div class="header-right">
            <div class="header-live-status" id="headerLiveStatus">
              <span class="status-dot"></span>
              <span>Offline</span>
            </div>
            <button class="auth-login-btn" id="authLoginBtn" onclick="window.location.href='/api/auth/twitch'">Log In</button>
            <div class="auth-user-info" id="authUserInfo">
              <span class="auth-user-name" id="authUserName"></span>
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
            <a href="/media.html">Media</a>
            <a href="/games.html">Games</a>
            <a href="/membership.html">Membership</a>
            <a href="/community.html">Community</a>
          </nav>

          <div class="footer-bottom">
            <span>&copy; ${year} PhantomACE. All rights reserved.</span>
          </div>
        </div>
      </footer>
    `;
  }
});
