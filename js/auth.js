const AUTH_COOKIE = 'pham_session';

const ROLES = ['visitor', 'follower', 'sub_tier1', 'sub_tier2', 'sub_tier3', 'moderator', 'broadcaster'];

/* The cookie is `<base64url(json)>.<signature>`. The payload is deliberately
   readable — this file needs the display name, avatar and role to render the
   header without an extra round trip on every page load.

   Reading it here is NOT a security check and never was. The signature is
   verified server-side on every request, so editing the payload in a browser
   changes what YOUR header looks like and nothing else: the server will
   reject the altered cookie and treat the request as logged out. Do not add
   a signature check here — it would be checking a value the client controls
   against a secret the client must not have. */
function getSession() {
  const match = document.cookie.match(new RegExp(`(?:^|; )${AUTH_COOKIE}=([^;]*)`));
  if (!match) return null;
  try {
    const raw = decodeURIComponent(match[1]);
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;               // unsigned/legacy — server rejects it too

    const b64 = raw.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
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

function loginWithTwitch() {
  const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/api/auth/twitch?return_to=${returnTo}`;
}

function logout() {
  const returnTo = encodeURIComponent(window.location.pathname);
  window.location.href = `/api/auth/logout?return_to=${returnTo}`;
}

function applyRole() {
  const session = getSession();
  const role = getCurrentRole();

  document.body.dataset.role = role;

  const loginBtn = document.getElementById('authLoginBtn');
  const userInfo = document.getElementById('authUserInfo');
  const userName = document.getElementById('authUserName');
  const userAvatar = document.getElementById('authUserAvatar');
  const menuName = document.getElementById('accountMenuName');

  if (session && session.display_name) {
    if (loginBtn) loginBtn.style.display = 'none';
    if (userInfo) userInfo.style.display = 'flex';
    if (userName) userName.textContent = session.display_name;
    if (menuName) menuName.textContent = session.display_name;
    if (userAvatar && session.profile_image) {
      userAvatar.src = session.profile_image;
      userAvatar.alt = session.display_name;
    }

    loadProfileCosmetics();

    if (typeof checkUserNotifications === 'function') {
      checkUserNotifications(session);
    }
  } else {
    if (loginBtn) loginBtn.style.display = '';
    if (userInfo) userInfo.style.display = 'none';
  }
}

function loadProfileCosmetics() {
  fetch('/api/inventory?game=profile', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.equips) return;
      var badgeEl = document.getElementById('authUserBadge');
      var titleEl = document.getElementById('authUserTitle');

      if (data.equips.badge && badgeEl) {
        var badge = data.items.find(function (i) { return i.id === data.equips.badge; });
        if (badge && badge.meta && badge.meta.imageUrl) {
          badgeEl.src = badge.meta.imageUrl;
          badgeEl.alt = badge.name;
          badgeEl.title = badge.name;
          badgeEl.hidden = false;
        }
      }

      if (data.equips.title && titleEl) {
        var title = data.items.find(function (i) { return i.id === data.equips.title; });
        if (title) {
          titleEl.textContent = title.name;
          titleEl.hidden = false;
        }
      }
    })
    .catch(function () {});
}

document.addEventListener('DOMContentLoaded', applyRole);
