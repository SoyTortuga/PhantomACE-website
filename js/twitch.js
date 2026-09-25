const TWITCH_CHANNEL = 'phantomace';
const STATUS_POLL_INTERVAL = 60000;

let pollTimer = null;

async function fetchTwitchStatus() {
  try {
    const res = await fetch('/api/twitch-status');
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch {
    /* UNREACHABLE IS NOT OFFLINE. This returned a bare { live: false }, so
       a dropped request — a phone changing cell, a backgrounded tab, wifi
       handing over — read exactly like the stream ending, and the next
       successful poll read like it starting again. On mobile data that
       produced a stream of "PhantomACE has gone offline" / "is now LIVE!"
       pairs all through one broadcast.

       `live: false` is kept so the indicators still fall back to a dark
       dot rather than freezing on stale state; `error` is what tells
       anything that ANNOUNCES a change to say nothing at all. */
    return { live: false, error: 'unreachable' };
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

}

/* Build the Twitch player embed from the ACTUAL host, once, on load. Twitch
   refuses to frame the player unless `parent` matches the serving host, so a
   hardcoded parent=localhost in the HTML gives production a refused frame on
   first paint. Setting src here (not after the status poll) means the FIRST
   load is correct on every host, and the embed no longer depends on
   /api/twitch-status resolving. */
function setupHeroEmbed() {
  const heroEmbed = document.getElementById('heroEmbed');
  if (!heroEmbed) return;
  const iframe = heroEmbed.querySelector('iframe');
  if (!iframe || iframe.src) return;
  const channel = iframe.getAttribute('data-channel') || TWITCH_CHANNEL;
  const hostname = window.location.hostname || 'localhost';
  iframe.src = `https://player.twitch.tv/?channel=${channel}&parent=${hostname}&muted=true`;
}

async function pollTwitchStatus() {
  const status = await fetchTwitchStatus();
  updateLiveIndicators(status);
  if (typeof handleTwitchStatusForNotifications === 'function') {
    handleTwitchStatusForNotifications(status);
  }
  sendPhamilyHeartbeatIfLive(status);
}

/* The outcome of the last heartbeat, published so any page can show whether
   watch time is actually accruing. It used to be thrown away: the response
   was awaited and discarded, so nothing could tell "counting" from "live but
   silently crediting nothing", which is the state this reports. */
window.phamilyHeartbeat = { reason: 'idle', at: 0 };

function publishHeartbeat(detail) {
  window.phamilyHeartbeat = Object.assign({ at: Date.now() }, detail);
  document.dispatchEvent(new CustomEvent('pham-heartbeat', { detail: window.phamilyHeartbeat }));
}

/* Phamily Time watch-time tracking runs from here — every page, not just
   phamily-time.html — so it counts as long as the user has ANY page open
   while PhantomACE is live, not just one specific tab. The server re-checks
   live status itself before crediting any time (see isChannelLive() in
   functions/api/phamily-time.js) — this client-side check is just to skip a
   pointless request while offline, not a trust boundary. */
async function sendPhamilyHeartbeatIfLive(status) {
  if (typeof getSession !== 'function' || !getSession()) {
    publishHeartbeat({ reason: 'logged-out', live: !!(status && status.live) });
    return;
  }
  if (!status || !status.live) {
    /* Reported rather than returned silently. "PhantomACE is offline" is the
       single most common reason time is not accruing, and a viewer deserves
       to be told that instead of watching a number not move. */
    publishHeartbeat({ reason: 'offline', live: false });
    return;
  }

  try {
    const res = await fetch('/api/phamily-time', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'heartbeat' }),
    });
    if (!res.ok) { publishHeartbeat({ reason: 'error', live: true, status: res.status }); return; }
    const data = await res.json();
    publishHeartbeat({
      reason: data.reason || 'unknown',
      live: !!data.live,
      creditedSeconds: data.creditedSeconds || 0,
      boostRate: data.boostRate || 1,
      hours: data.hours,
      level: data.level,
      nextBeatMs: data.nextBeatMs,
    });
  } catch {
    /* A network failure is NOT the same as "offline", and saying so matters:
       one means nothing is being missed, the other means time is being lost
       right now while the channel is live. */
    publishHeartbeat({ reason: 'unreachable', live: true });
  }
}

function startTwitchPolling() {
  setupHeroEmbed();
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
