document.addEventListener('DOMContentLoaded', () => {
  const currentPage = document.body.dataset.page || 'home';

  function setActivePage() {
    const links = document.querySelectorAll('.site-nav a');
    links.forEach(link => {
      if (link.dataset.page === currentPage) {
        link.classList.add('active');
      }
    });

    const subWrappers = document.querySelectorAll('.nav-has-sub');
    subWrappers.forEach(wrapper => {
      if (wrapper.dataset.page === currentPage) {
        wrapper.classList.add('active');
        return;
      }
      const subLinks = wrapper.querySelectorAll('.nav-submenu a');
      subLinks.forEach(sub => {
        if (sub.getAttribute('href') === '/' + currentPage + '.html') {
          wrapper.classList.add('active');
        }
      });
    });
  }

  function initMobileNav() {
    const hamburger = document.getElementById('hamburgerBtn');
    const backdrop = document.getElementById('navBackdrop');

    if (!hamburger) return;

    hamburger.addEventListener('click', () => {
      document.body.classList.toggle('nav-open');
    });

    if (backdrop) {
      backdrop.addEventListener('click', () => {
        document.body.classList.remove('nav-open');
      });
    }

    const navLinks = document.querySelectorAll('.site-nav a');
    navLinks.forEach(link => {
      link.addEventListener('click', () => {
        document.body.classList.remove('nav-open');
      });
    });
  }

  /* Lock the Phamily dropdown tiers a viewer hasn't earned. Viewer & Follower
     is always open; Subscriber/VIP unlock for subscribers and above, Moderator
     for staff. This reads the SIGNED role from the cookie (auth.js) — it is a
     UI affordance only, exactly like the Mod Toolbox link; the tier pages hold
     no privileged actions, so a locked link simply doesn't navigate. */
  function gateTiers() {
    if (typeof hasMinimumRole !== 'function') return;
    var reqs = { subscriber: 'sub_tier1', vip: 'sub_tier1', moderator: 'moderator' };
    document.querySelectorAll('.site-nav .nav-tier').forEach(function (el) {
      var need = reqs[el.dataset.tier];
      if (need && !hasMinimumRole(need)) {
        el.classList.add('locked');
        el.setAttribute('aria-disabled', 'true');
        el.removeAttribute('href');
        el.title = el.dataset.tier === 'moderator'
          ? 'Staff only' : 'Unlocked for subscribers';
      }
    });
  }

  setActivePage();
  gateTiers();
  initMobileNav();
});
