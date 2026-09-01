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
}

function startTwitchPolling() {
  pollTwitchStatus();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollTwitchStatus, STATUS_POLL_INTERVAL);
}
