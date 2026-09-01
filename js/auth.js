const AUTH_COOKIE = 'pham_session';

const ROLES = ['visitor', 'follower', 'sub_tier1', 'sub_tier2', 'sub_tier3', 'moderator', 'broadcaster'];

function getSession() {
  const match = document.cookie.match(new RegExp(`(?:^|; )${AUTH_COOKIE}=([^;]*)`));
  if (!match) return null;
  try {
    return JSON.parse(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

function getCurrentRole() {
  const session = getSession();
  if (!session || !session.role) return 'visitor';
  return ROLES.includes(session.role) ? session.role : 'visitor';
}

function hasMinimumRole(required) {
  const current = ROLES.indexOf(getCurrentRole());
  const needed = ROLES.indexOf(required);
  return current >= needed;
}

function applyRole() {
  const session = getSession();
  const role = getCurrentRole();

  document.body.dataset.role = role;

  const loginBtn = document.getElementById('authLoginBtn');
  const userInfo = document.getElementById('authUserInfo');
  const userName = document.getElementById('authUserName');
  const navAuthLink = document.getElementById('navAuthLink');

  if (session && session.display_name) {
    if (loginBtn) loginBtn.style.display = 'none';
    if (userInfo) userInfo.style.display = 'flex';
    if (userName) userName.textContent = session.display_name;
    if (navAuthLink) navAuthLink.textContent = session.display_name;
  } else {
    if (loginBtn) loginBtn.style.display = '';
    if (userInfo) userInfo.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', applyRole);
