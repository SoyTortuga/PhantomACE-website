document.addEventListener('DOMContentLoaded', () => {
  const currentPage = document.body.dataset.page || 'home';

  function setActivePage() {
    const links = document.querySelectorAll('.site-nav a');
    links.forEach(link => {
      if (link.dataset.page === currentPage) {
        link.classList.add('active');
      }
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
