const PA_NOTIF_KEY = 'pa_notifications';
const PA_NOTIF_READ_KEY = 'pa_notif_last_read';
const PA_NOTIF_PERM_KEY = 'pa_notif_desktop_asked';
const MAX_NOTIFICATIONS = 50;

let notifPanelOpen = false;
let lastLiveState = null;

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
  updateBadge();
}

function addNotification(notification) {
  const list = getNotifications();
  notification.id = 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  notification.time = Date.now();
  list.unshift(notification);
  saveNotifications(list);
  updateBadge();

  if (notifPanelOpen) renderNotifPanel();

  showDesktopNotification(notification);
}

function getUnreadCount() {
  const lastRead = getLastReadTime();
  return getNotifications().filter(n => n.time > lastRead).length;
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

  if (notifications.length === 0) {
    html += `<div class="notif-empty">No notifications yet</div>`;
  } else {
    html += `<div class="notif-list">`;
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
  const isLive = !!status.live;

  if (lastLiveState === null) {
    lastLiveState = isLive;
    return;
  }

  if (isLive && !lastLiveState) {
    let msg = 'PhantomACE is now LIVE!';
    if (status.game) msg += ` Playing ${status.game}`;
    addNotification({ type: 'live', message: msg });
  } else if (!isLive && lastLiveState) {
    addNotification({ type: 'offline', message: 'PhantomACE has gone offline.' });
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
