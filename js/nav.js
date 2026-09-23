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
  function tierUnlocked(tier) {
    if (typeof hasMinimumRole !== 'function') return true;
    if (tier === 'subscriber') return hasMinimumRole('sub_tier1');
    if (tier === 'moderator')  return hasMinimumRole('moderator');
    if (tier === 'vip') {
      /* The real, hand-granted VIP flag carried in the signed session, or
         staff (who can see every tier). Not the sub tier — VIP is its own
         status. */
      var s = typeof getSession === 'function' ? getSession() : null;
      return !!(s && s.vip) || hasMinimumRole('moderator');
    }
    return true;
  }

  function gateTiers() {
    var titles = { subscriber: 'Unlocked for subscribers', vip: 'Invite only', moderator: 'Staff only' };
    document.querySelectorAll('.site-nav .nav-tier').forEach(function (el) {
      if (!tierUnlocked(el.dataset.tier)) {
        el.classList.add('locked');
        el.setAttribute('aria-disabled', 'true');
        el.removeAttribute('href');
        el.title = titles[el.dataset.tier] || '';
      }
    });
  }

  setActivePage();
  gateTiers();
  initMobileNav();
});
