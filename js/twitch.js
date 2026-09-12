const TWITCH_CHANNEL = 'phantomace';
const STATUS_POLL_INTERVAL = 60000;

let pollTimer = null;

async function fetchTwitchStatus() {
  try {
    const res = await fetch('/api/twitch-status');
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch {
    return { live: false };
  }
}

function updateLiveIndicators(status) {
  const headerStatus = document.getElementById('headerLiveStatus');
  if (headerStatus) {
    const dot = headerStatus.querySelector('.status-dot');
    if (status.live) {
      headerStatus.classList.add('is-live');
      if (dot) dot.classList.add('live');
      headerStatus.querySelector('span:last-child').textContent = 'LIVE';
    } else {
      headerStatus.classList.remove('is-live');
      if (dot) dot.classList.remove('live');
      headerStatus.querySelector('span:last-child').textContent = 'Offline';
    }
  }

  const heroStatus = document.getElementById('heroLiveStatus');
  if (heroStatus) {
    if (status.live) {
      heroStatus.classList.add('is-live');
      heroStatus.innerHTML = `
        <div class="hero-live-label">
          <span class="pulse-dot"></span>
          <span>LIVE</span>
        </div>
        <div class="hero-live-meta">
          ${status.game ? `<span>${status.game}</span>` : ''}
          ${status.viewers != null ? `<span>${status.viewers.toLocaleString()} viewers</span>` : ''}
        </div>
      `;
    } else {
      heroStatus.classList.remove('is-live');
      heroStatus.innerHTML = `
        <div class="hero-live-label">
          <span class="status-dot"></span>
          <span class="hero-offline">Currently offline</span>
        </div>
      `;
    }
  }

  const heroEmbed = document.getElementById('heroEmbed');
  if (heroEmbed) {
    const iframe = heroEmbed.querySelector('iframe');
    if (iframe) {
      const src = iframe.getAttribute('src');
      const hostname = window.location.hostname;
      if (src && src.includes('parent=localhost') && hostname !== 'localhost') {
        iframe.src = `https://player.twitch.tv/?channel=${TWITCH_CHANNEL}&parent=${hostname}&muted=true`;
      }
    }
  }
}

async function pollTwitchStatus() {
  const status = await fetchTwitchStatus();
  updateLiveIndicators(status);
  if (typeof handleTwitchStatusForNotifications === 'function') {
    handleTwitchStatusForNotifications(status);
  }
  sendPhamilyHeartbeatIfLive(status);
}

/* Phamily Time watch-time tracking runs from here — every page, not just
   community-stats.html — so it counts as long as the user has ANY page
   open while PhantomACE is live, not just one specific tab. The server
   re-checks live status itself before crediting any time (see
   isChannelLive() in functions/api/phamily-time.js) — this client-side
   check is just to skip a pointless request while offline, not a trust
   boundary. */
async function sendPhamilyHeartbeatIfLive(status) {
  if (!status || !status.live) return;
  if (typeof getSession !== 'function' || !getSession()) return;

  try {
    await fetch('/api/phamily-time', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'heartbeat' }),
    });
  } catch { /* silent — next poll cycle will retry */ }
}

function startTwitchPolling() {
  pollTwitchStatus();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollTwitchStatus, STATUS_POLL_INTERVAL);
  pollHypeTrain();
  setInterval(pollHypeTrain, 15000);
}

async function pollHypeTrain() {
  try {
    var res = await fetch('/api/hype-train?action=status');
    if (!res.ok) return;
    var data = await res.json();
    updateHypeTrainBanner(data);
  } catch (e) {}
}

document.addEventListener('DOMContentLoaded', startTwitchPolling);

function updateHypeTrainBanner(data) {
  var banner = document.getElementById('hypeTrainBanner');
  if (!data || !data.active) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'hypeTrainBanner';
    banner.className = 'hype-train-banner';
    var header = document.querySelector('.site-header');
    if (header && header.parentNode) {
      header.parentNode.insertBefore(banner, header.nextSibling);
    } else {
      document.body.prepend(banner);
    }
  }
  var pct = data.goal > 0 ? Math.min(100, Math.round((data.total / data.goal) * 100)) : 0;
  banner.innerHTML =
    '<div class="hype-train-inner">' +
      '<span class="hype-train-icon">🚂</span>' +
      '<span class="hype-train-text">HYPE TRAIN Level ' + (data.level || 1) + '</span>' +
      '<div class="hype-train-bar"><div class="hype-train-fill" style="width:' + pct + '%"></div></div>' +
      '<span class="hype-train-pct">' + pct + '%</span>' +
    '</div>';
}
