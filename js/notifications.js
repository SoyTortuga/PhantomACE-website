const PA_NOTIF_KEY = 'pa_notifications';
const PA_NOTIF_READ_KEY = 'pa_notif_last_read';
const PA_NOTIF_PERM_KEY = 'pa_notif_desktop_asked';
const MAX_NOTIFICATIONS = 50;

let notifPanelOpen = false;
let lastLiveState = null;
/* The broadcast we last saw running, so "gone offline" can be keyed to the
   stream that ended rather than to the moment we noticed. */
let lastLiveStartedAt = '';

/* ── The server's list ─────────────────────────────────────────────────
   Everything above this is the local list: live/offline events kept in
   localStorage. This is the second source — replies, mentions, comments
   on your profile, a moderator's removal — read from /api/forum/
   notifications once per page load when there is a session, and merged
   into the same panel. It is not polled; the next page you open shows
   what is new. */
let serverNotifs = [];
let serverAuthors = {};
let serverUnread = 0;

function hasSessionCookie() {
  return /(?:^|; )pham_session=/.test(document.cookie);
}

function loadServerNotifications() {
  if (!hasSessionCookie()) return;
  fetch('/api/forum/notifications', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      if (!d) return;
      serverNotifs = Array.isArray(d.notifications) ? d.notifications : [];
      serverAuthors = d.authors || {};
      serverUnread = Number(d.unread) || 0;
      updateBadge();
      if (notifPanelOpen) renderNotifPanel();
    })
    .catch(() => {});
}

/** One line per server notification, and where it points. */
function describeServerNotif(n) {
  const who = (serverAuthors[n.actorId] || {}).displayName || 'Someone';
  const where = n.threadTitle ? `“${n.threadTitle}”` : 'your profile';
  let text, href = null;
  switch (n.kind) {
    case 'reply':      text = `${who} replied to ${where}`; break;
    case 'mention':    text = `${who} mentioned you in ${where}`; break;
    case 'comment':    text = `${who} commented on your profile`; break;
    case 'moderation': text = 'A moderator removed your post' + (n.reason ? `: ${n.reason}` : ''); break;
    default:           text = 'Something happened on the forum';
  }
  if (n.postDeleted && n.kind !== 'moderation') text += ' (since removed)';
  else if (n.threadId && n.postId) href = `/thread/${n.threadId}#post-${n.postId}`;
  else if (n.kind === 'comment') {
    const me = (typeof getSession === 'function' ? getSession() : null) || {};
    if (me.login) href = `/user/${encodeURIComponent(me.login)}`;
  }
  return { text, href };
}

function getNotifications() {
  try {
    return JSON.parse(localStorage.getItem(PA_NOTIF_KEY) || '[]');
  } catch { return []; }
}

function saveNotifications(list) {
  try {
    localStorage.setItem(PA_NOTIF_KEY, JSON.stringify(list.slice(0, MAX_NOTIFICATIONS)));
  } catch {}
}

function getLastReadTime() {
  try {
    return parseInt(localStorage.getItem(PA_NOTIF_READ_KEY) || '0', 10);
  } catch { return 0; }
}

function markAllRead() {
  try {
    localStorage.setItem(PA_NOTIF_READ_KEY, String(Date.now()));
  } catch {}
  /* The server's unread are read once the panel has shown them. The
     highlight stays for this opening — the count is what clears. */
  if (serverUnread > 0) {
    serverUnread = 0;
    fetch('/api/forum/notifications', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read' }), cache: 'no-store',
    }).then(() => { serverNotifs.forEach(n => { n.read = true; }); }).catch(() => {});
  }
  updateBadge();
}

/**
 * Add one notification, unless an identical event is already listed.
 *
 * `key` names the EVENT, not the observation — 'live:<started_at>' is the
 * same string in every tab, on every poll, for one broadcast. Two things
 * made duplicates before, and one key closes both: every open tab watches
 * the status independently and writes to the same localStorage list, and a
 * status that flapped announced the same broadcast twice.
 *
 * Without a key nothing is deduped, which is right for everything else
 * here — two profile comments are two notifications.
 *
 * @returns {boolean} whether it was added
 */
function addNotification(notification) {
  const list = getNotifications();
  if (notification.key && list.some(n => n && n.key === notification.key)) return false;
  notification.id = 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  notification.time = Date.now();
  list.unshift(notification);
  saveNotifications(list);
  updateBadge();

  if (notifPanelOpen) renderNotifPanel();

  showDesktopNotification(notification);
  return true;
}

function getUnreadCount() {
  const lastRead = getLastReadTime();
  return getNotifications().filter(n => n.time > lastRead).length + serverUnread;
}

function updateBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  const count = getUnreadCount();
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function timeAgoNotif(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

function getNotifIcon(type) {
  switch (type) {
    case 'live': return '🔴';
    case 'offline': return '⚫';
    case 'follow_anniversary': return '💚';
    case 'sub_anniversary': return '❤️';
    case 'sub_expiring': return '⏰';
    case 'raid': return '⚔️';
    case 'system': return '🔔';
    case 'reply': return '💬';
    case 'mention': return '@';
    case 'comment': return '✍️';
    case 'moderation': return '🛡️';
    default: return '📢';
  }
}

function renderNotifPanel() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;

  const notifications = getNotifications();
  const lastRead = getLastReadTime();

  let html = `<div class="notif-header">
    <span class="notif-title">Notifications</span>
    <button class="notif-clear-btn" onclick="clearAllNotifications()" title="Clear all">Clear</button>
  </div>`;

  if (notifications.length === 0 && serverNotifs.length === 0) {
    html += `<div class="notif-empty">No notifications yet</div>`;
  } else {
    html += `<div class="notif-list">`;
    /* The forum's first: they are about you specifically, and they carry
       a place to go. Unread ones stay highlighted until the panel has
       been opened once with them in it. */
    serverNotifs.forEach(n => {
      const d = describeServerNotif(n);
      const unread = n.read ? '' : ' notif-unread';
      const inner = `<span class="notif-icon">${getNotifIcon(n.kind)}</span>
        <div class="notif-content">
          <div class="notif-message">${escNotifHtml(d.text)}</div>
          <div class="notif-time">${timeAgoNotif(Date.parse(n.at) || Date.now())}</div>
        </div>`;
      html += d.href
        ? `<a class="notif-item notif-link${unread}" href="${escNotifHtml(d.href)}">${inner}</a>`
        : `<div class="notif-item${unread}">${inner}</div>`;
    });
    notifications.forEach(n => {
      const unread = n.time > lastRead ? ' notif-unread' : '';
      html += `<div class="notif-item${unread}">
        <span class="notif-icon">${getNotifIcon(n.type)}</span>
        <div class="notif-content">
          <div class="notif-message">${escNotifHtml(n.message)}</div>
          <div class="notif-time">${timeAgoNotif(n.time)}</div>
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  panel.innerHTML = html;
}

function escNotifHtml(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function toggleNotifPanel() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;

  notifPanelOpen = !notifPanelOpen;

  if (notifPanelOpen) {
    renderNotifPanel();
    panel.classList.add('open');
    markAllRead();
  } else {
    panel.classList.remove('open');
  }
}

function clearAllNotifications() {
  saveNotifications([]);
  markAllRead();
  renderNotifPanel();
}

function closeNotifPanelOnClickOutside(e) {
  if (!notifPanelOpen) return;
  const bell = document.getElementById('notifBell');
  const panel = document.getElementById('notifPanel');
  if (bell && !bell.contains(e.target) && panel && !panel.contains(e.target)) {
    notifPanelOpen = false;
    panel.classList.remove('open');
  }
}

function showDesktopNotification(notification) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  try {
    new Notification('PhantomACE', {
      body: notification.message,
      icon: '/assets/images/phantomace-logo.png',
      tag: notification.type,
    });
  } catch {}
}

function requestDesktopPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') return;

  try {
    const asked = localStorage.getItem(PA_NOTIF_PERM_KEY);
    if (asked) return;
    localStorage.setItem(PA_NOTIF_PERM_KEY, '1');
  } catch {}

  Notification.requestPermission();
}

function handleTwitchStatusForNotifications(status) {
  /* A LOOKUP THAT FAILED IS NOT AN ANSWER. Both the endpoint and the fetch
     wrapper report trouble as { live: false, error }, which is fine for an
     indicator and wrong for an announcement: treating it as "offline"
     invents an event that did not happen, and the recovery invents a second
     one. Say nothing and wait for the next poll. */
  if (!status || status.error) return;

  const isLive = !!status.live;
  const startedAt = String(status.started_at || '');
  if (isLive && startedAt) lastLiveStartedAt = startedAt;

  if (lastLiveState === null) {
    lastLiveState = isLive;
    return;
  }

  if (isLive && !lastLiveState) {
    let msg = 'PhantomACE is now LIVE!';
    if (status.game) msg += ` Playing ${status.game}`;
    /* Keyed on the broadcast, so the same one is never announced twice —
       by another tab, or after a gap in coverage. No started_at means an
       older cached response, and no key rather than one every broadcast
       would share. */
    addNotification({ type: 'live', key: startedAt ? 'live:' + startedAt : null, message: msg });
  } else if (!isLive && lastLiveState) {
    addNotification({
      type: 'offline',
      key: lastLiveStartedAt ? 'offline:' + lastLiveStartedAt : null,
      message: 'PhantomACE has gone offline.',
    });
  }

  lastLiveState = isLive;
}

function checkUserNotifications(userData) {
  if (!userData) return;
  const now = Date.now();
  const oneDay = 86400000;
  const threeDays = oneDay * 3;

  if (userData.followedAt) {
    const followDate = new Date(userData.followedAt);
    const thisYearAnniv = new Date(followDate);
    thisYearAnniv.setFullYear(new Date().getFullYear());
    const diff = thisYearAnniv.getTime() - now;
    if (diff >= 0 && diff < oneDay) {
      const years = new Date().getFullYear() - followDate.getFullYear();
      addNotification({
        type: 'follow_anniversary',
        message: `Happy ${years}-year follow anniversary! Thanks for being part of the Phamily.`,
      });
    }
  }

  if (userData.subscribedAt) {
    const subDate = new Date(userData.subscribedAt);
    const thisYearAnniv = new Date(subDate);
    thisYearAnniv.setFullYear(new Date().getFullYear());
    const diff = thisYearAnniv.getTime() - now;
    if (diff >= 0 && diff < oneDay) {
      const years = new Date().getFullYear() - subDate.getFullYear();
      addNotification({
        type: 'sub_anniversary',
        message: `Happy ${years}-year sub anniversary! You're a legend.`,
      });
    }
  }

  if (userData.subExpiresAt) {
    const expiry = new Date(userData.subExpiresAt).getTime();
    const remaining = expiry - now;
    if (remaining > 0 && remaining < threeDays) {
      const daysLeft = Math.ceil(remaining / oneDay);
      addNotification({
        type: 'sub_expiring',
        message: `Your subscription expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Renew to keep your perks!`,
      });
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updateBadge();
  document.addEventListener('click', closeNotifPanelOnClickOutside);

  setTimeout(requestDesktopPermission, 5000);
});

/* The server's list, once per page load. Nothing else here waits for the
   DOM: the bell markup arrives from components.js, and updateBadge() is
   a no-op until it has. */
document.addEventListener('DOMContentLoaded', loadServerNotifications);
