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
    /* Point the menu at the canonical URL rather than /profile, so the link
       someone copies out of it is the one they can share. /profile still
       works and redirects itself, but only after the page has loaded. */
    const menuProfile = document.getElementById('accountMenuProfile');
    if (menuProfile && session.login) menuProfile.href = '/user/' + session.login;

    /* The Mod Toolbox link, for staff only. Cosmetic gate on the signed
       role — the toolbox page and every tool behind it re-check on the
       server, so a forged link reveals nothing it can act on. */
    const toolbox = document.getElementById('accountMenuToolbox');
    if (toolbox) toolbox.hidden = !(role === 'moderator' || role === 'broadcaster');

    renderRoleBadge(session.role);
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

/* ── Role indicator ────────────────────────────────────────────────
   Exists because there was no way for anyone to see what the site thought
   they were. A subscriber silently demoted to visitor noticed only because
   their Dino Park incubator slots dropped from 6 to 3 — the role itself was
   invisible, so the symptom showed up somewhere unrelated and confusing. */

const ROLE_LABELS = {
  broadcaster: 'Broadcaster',
  moderator:   'Moderator',
  sub_tier3:   'Tier 3 Subscriber',
  sub_tier2:   'Tier 2 Subscriber',
  sub_tier1:   'Tier 1 Subscriber',
  follower:    'Follower',
  visitor:     'Visitor',
};

function renderRoleBadge(role) {
  const badge = document.getElementById('accountRoleBadge');
  if (!badge) return;
  const key = ROLE_LABELS[role] ? role : 'visitor';
  badge.textContent = ROLE_LABELS[key];
  /* data-role, NOT a role-* class: roles.css owns that namespace for
     showing/hiding content by role, and a .role-sub_tier1 class here made
     the badge hide itself. */
  badge.setAttribute('data-role', key);
}

async function refreshMyRole() {
  const msg = document.getElementById('accountRoleMsg');
  const btn = document.getElementById('accountRoleRefresh');
  if (!msg) return;

  if (btn) btn.disabled = true;
  msg.className = 'account-role-msg';
  msg.textContent = 'Checking with Twitch…';

  try {
    const res = await fetch('/api/auth/recheck-roles', { credentials: 'same-origin' });
    const d = await res.json();

    if (!res.ok) {
      msg.className = 'account-role-msg err';
      msg.textContent = d.error || 'Could not check right now.';
      return;
    }

    renderRoleBadge(d.role);

    /* Re-apply the role to the document too, not just the badge. roles.css
       shows and hides content via body[data-role], so updating only the badge
       left the page still gated on the OLD role — the header would say
       Broadcaster while the broadcaster-only panel stayed hidden, which reads
       as "it says I have access and denies me anyway". */
    if (d.role) document.body.dataset.role = d.role;

    /* Reported honestly rather than as a success. The endpoint currently
       cannot verify anything — it holds an app token, which Twitch rejects
       for the subscription and follow lookups — so claiming "up to date"
       would be a lie, and a viewer chasing a missing perk deserves to know
       the check did not actually happen. */
    if (d.verified === false) {
      msg.className = 'account-role-msg warn';
      msg.textContent = 'Twitch check unavailable — showing your role as of last login. Log out and back in to refresh it.';
    } else {
      msg.className = 'account-role-msg ok';
      msg.textContent = 'Up to date.';
    }
  } catch (e) {
    msg.className = 'account-role-msg err';
    msg.textContent = 'Network error — try again.';
  } finally {
    if (btn) btn.disabled = false;
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
