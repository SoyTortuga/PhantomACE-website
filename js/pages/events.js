document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('scheduleGrid');
  if (!grid) return;

  fetchSchedule();
});

async function fetchSchedule() {
  const grid = document.getElementById('scheduleGrid');

  try {
    const res = await fetch('/api/twitch-schedule');
    if (!res.ok) throw new Error('Failed to fetch schedule');

    const data = await res.json();

    if (!data.segments || data.segments.length === 0) {
      grid.innerHTML = renderEmpty();
      return;
    }

    grid.innerHTML = data.segments.map(renderEventCard).join('');
  } catch {
    grid.innerHTML = renderFallback();
  }
}

function renderEventCard(segment) {
  const start = new Date(segment.start_time);
  const end = segment.end_time ? new Date(segment.end_time) : null;

  const month = start.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  const day = start.getDate();
  const weekday = start.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const time = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const endTime = end ? end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';

  const categoryHtml = segment.category
    ? `<span class="event-info-category">${escapeHtml(segment.category)}</span>`
    : '';

  const recurringHtml = segment.is_recurring
    ? '<span class="event-recurring-badge">Recurring</span>'
    : '';

  const calUrl = buildCalendarUrl(segment.title, start, end);

  return `
    <div class="card event-full-card">
      <div class="event-date-block">
        <div class="event-date-month">${month}</div>
        <div class="event-date-day">${day}</div>
        <div class="event-date-weekday">${weekday}</div>
      </div>
      <div class="event-info">
        <div class="event-info-title">${escapeHtml(segment.title)}</div>
        <div class="event-info-meta">
          <span class="event-info-time">${time}${endTime ? ' – ' + endTime : ''}</span>
          ${categoryHtml}
          ${recurringHtml}
        </div>
      </div>
      <div class="event-actions">
        <a href="${calUrl}" target="_blank" rel="noopener" class="pill-btn" title="Add to Google Calendar">Add to Cal</a>
      </div>
    </div>
  `;
}

function renderEmpty() {
  return `
    <div class="events-empty card">
      <div class="events-empty-icon">&#128197;</div>
      <h3>No Upcoming Events</h3>
      <p>No scheduled streams right now. Follow on Twitch to get notified when PhantomACE goes live.</p>
      <a href="https://twitch.tv/phantomace" target="_blank" rel="noopener" class="btn-primary">Follow on Twitch</a>
    </div>
  `;
}

function renderFallback() {
  return `
    <div class="card event-full-card">
      <div class="event-date-block">
        <div class="event-date-month">TBD</div>
        <div class="event-date-day">?</div>
      </div>
      <div class="event-info">
        <div class="event-info-title">Schedule Unavailable</div>
        <div class="event-info-meta">
          <span class="event-info-time">Check Twitch for the latest schedule</span>
        </div>
      </div>
      <div class="event-actions">
        <a href="https://twitch.tv/phantomace/schedule" target="_blank" rel="noopener" class="pill-btn">View on Twitch</a>
      </div>
    </div>
  `;
}

function buildCalendarUrl(title, start, end) {
  const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const startStr = fmt(start);
  const endStr = end ? fmt(end) : fmt(new Date(start.getTime() + 3600000));
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${startStr}/${endStr}`,
    details: 'PhantomACE stream on Twitch\nhttps://twitch.tv/phantomace',
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
