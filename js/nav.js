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

  setActivePage();
  initMobileNav();
});
