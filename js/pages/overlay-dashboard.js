/* ══════════════════════════════════════════════
   OVERLAY DASHBOARD
   Staff-gated (broadcaster + approved mods, decided by the server's answer to
   /api/bot/dashboard). Consolidates every overlay-facing control that used to
   live on Bot Control: the panic Clear/Reload, a live timestamped alert log,
   and the standing overlay panels (Mana Clash, Bingo, Skull Raid, Pham
   Check-In, Dino Hatch), the layout preset switcher and the OBS source URL.

   The panel controls all call the same /api endpoints they did on Bot Control;
   only the client moved. Every function guards its own elements, so nothing
   throws when a card is absent.
   ══════════════════════════════════════════════ */

function escapeBotHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function showBotStatus(message, isError) {
  const el = document.getElementById('odStatusMsg');
  if (!el) return;
  el.textContent = message;
  el.className = 'bot-status-msg ' + (isError ? 'error' : 'success');
  el.hidden = false;
}

/* Posts to /api/bot/trigger. The only action fired this way from here is the
   Pham Check-In "Show Now" nudge; kept generic so future overlay one-shots can
   reuse it. */
async function fireBotAction(payload, button) {
  const originalText = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = 'Sending...'; }

  try {
    const res = await fetch('/api/bot/trigger', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.success) {
      const messages = {
        'checkin-alert': 'Pham Check-In alert sent to the overlay.',
      };
      showBotStatus(messages[payload.action] || 'Done.', false);
    } else {
      showBotStatus(data.error || 'Action failed.', true);
    }
  } catch {
    showBotStatus('Network error — action may not have been sent.', true);
  }

  if (button) { button.disabled = false; button.textContent = originalText; }
}

/* Asks every open overlay to reload. The overlay polls the event feed once a
   second and reloads when the token changes, so this is as immediate as a
   right-click in OBS and can be done from a phone. Restores whatever label the
   button had, so the panic button and the small MC-card reload can share it. */
async function reloadOverlay(btn) {
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Reloading…'; }
  try {
    const res = await fetch('/api/overlay/events', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reload' }),
    });
    const d = await res.json();
    if (d.success) {
      showBotStatus('Every open overlay will reload within a second.', false);
    } else {
      showBotStatus(d.error || 'Could not ask the overlay to reload.', true);
    }
  } catch {
    showBotStatus('Network error asking the overlay to reload.', true);
  }
  if (btn) { btn.disabled = false; btn.textContent = original; }
}

/* ── Panic controls (Clear / Skip) ──────────────────────────────────────────
   Both ride the same /api/overlay/events control feed the Reload button uses.
   Clear wipes the alert queue + the off-queue panels off every open overlay;
   Skip dismisses the alert currently on screen. The overlay applies each once
   (see overlay.js). */
async function overlayControl(action, btn) {
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const res = await fetch('/api/overlay/events', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action }),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) {
      showBotStatus(action === 'clear'
        ? 'Overlay cleared — alerts and the check-in, hatch and prediction panels are off.'
        : 'Skipped the alert on screen.', false);
    } else {
      showBotStatus(d.error || 'Could not send that command.', true);
    }
  } catch {
    showBotStatus('Network error — the command may not have been sent.', true);
  }
  if (btn) { btn.disabled = false; btn.textContent = original; }
}

function initPanic() {
  const clear = document.getElementById('odClearBtn');
  const skip = document.getElementById('odSkipBtn');
  const reload = document.getElementById('odPanicReloadBtn');
  if (clear) clear.addEventListener('click', function () { overlayControl('clear', clear); });
  if (skip) skip.addEventListener('click', function () { overlayControl('skip', skip); });
  if (reload) reload.addEventListener('click', function () { reloadOverlay(reload); });
}

/* ── Live alert log ─────────────────────────────────────────────────────────
   Polls the broadcaster/mod-gated /api/activity feed and lists recent events.
   Runs ONLY while the tab is visible — no point hammering the rig while nobody
   is looking — and resumes on return. */
var OD_LOG_POLL_MS = 5000;
var odLogTimer = null;
var OD_LOG_CHIP = {
  sub: 'Sub', giftsub: 'Gift', raid: 'Raid', hype: 'Hype', redemption: 'Redeem', bot: 'Bot',
};

function odRelTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return new Date(ts).toLocaleString();
}

function renderAlertLog(events) {
  const box = document.getElementById('odAlertLog');
  if (!box) return;
  if (!events || !events.length) {
    box.innerHTML = '<li class="od-log-empty">Nothing yet — events show here as they happen.</li>';
    return;
  }
  box.innerHTML = events.slice(0, 20).map(function (e) {
    const chip = OD_LOG_CHIP[e.category] || (e.category || 'event');
    return '<li class="od-log-item">' +
      '<span class="od-log-chip">' + escapeBotHtml(chip) + '</span>' +
      '<span class="od-log-summary">' + escapeBotHtml(e.summary || e.type || 'event') + '</span>' +
      '<span class="od-log-time" title="' + escapeBotHtml(new Date(e.at).toLocaleString()) + '">' + escapeBotHtml(odRelTime(e.at)) + '</span>' +
      '</li>';
  }).join('');
}

function fetchAlertLog() {
  fetch('/api/activity', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) { if (data) renderAlertLog(data.events || []); })
    .catch(function () { /* transient — keep the last render, try next poll */ });
}

function startAlertLog() {
  if (odLogTimer) clearInterval(odLogTimer);
  odLogTimer = setInterval(fetchAlertLog, OD_LOG_POLL_MS);
}
function stopAlertLog() {
  if (odLogTimer) { clearInterval(odLogTimer); odLogTimer = null; }
}

function initAlertLog() {
  const box = document.getElementById('odAlertLog');
  if (!box) return;
  fetchAlertLog();
  startAlertLog();
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopAlertLog();
    else { fetchAlertLog(); startAlertLog(); }
  });
}

/* ── Pham Check-In reminder + hatch sounds + alert volume ─────────────────
   Show Now fires the nudge once (with sound); the timer repeats it silently
   while live. The timer's on/off and interval live server-side (KV, read by
   the rig tick), so the panel just reflects and edits that config. */
let checkinTimerEnabled = false;

function renderCheckinReminder(enabled, intervalMin) {
  checkinTimerEnabled = !!enabled;
  const state = document.getElementById('ovCheckinTimerState');
  const toggle = document.getElementById('ovCheckinToggleBtn');
  const interval = document.getElementById('ovCheckinInterval');
  if (state) {
    state.textContent = enabled ? 'Timer on · every ' + intervalMin + ' min' : 'Timer off';
    state.className = 'giveaway-status' + (enabled ? ' open' : '');
  }
  if (toggle) toggle.textContent = enabled ? 'Turn Off Timer' : 'Turn On Timer';
  if (interval && document.activeElement !== interval) interval.value = intervalMin;
}

async function saveCheckinReminder(enabled) {
  const interval = document.getElementById('ovCheckinInterval');
  const intervalMin = Math.min(120, Math.max(1, parseInt(interval && interval.value, 10) || 15));
  try {
    const res = await fetch('/api/bot/trigger', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'checkin-reminder-config', enabled, intervalMin }),
    });
    const data = await res.json();
    if (data.success) {
      renderCheckinReminder(data.enabled, data.intervalMin);
      showBotStatus(data.enabled
        ? 'Check-In reminder on — every ' + data.intervalMin + ' min while live.'
        : 'Check-In reminder timer off.', false);
    } else {
      showBotStatus(data.error || 'Could not save the reminder settings.', true);
    }
  } catch {
    showBotStatus('Network error saving the reminder settings.', true);
  }
}

function saveAlertVolume(volume) {
  fetch('/api/bot/trigger', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'alert-volume', volume }),
  }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.success) showBotStatus('Alert volume set to ' + d.volume + '%.', false); })
    .catch(function () { showBotStatus('Network error saving the volume.', true); });
}

let hatchSoundOn = false;

function renderHatchSound(on) {
  hatchSoundOn = !!on;
  const state = document.getElementById('ovHatchSoundState');
  const toggle = document.getElementById('ovHatchSoundToggle');
  if (state) {
    state.textContent = on ? 'Sounds on' : 'Sounds off';
    state.className = 'giveaway-status' + (on ? ' open' : '');
  }
  if (toggle) toggle.textContent = on ? 'Mute Sounds' : 'Turn On Sounds';
}

async function saveHatchSound(on) {
  try {
    const res = await fetch('/api/bot/trigger', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'hatch-config', sound: on }),
    });
    const data = await res.json();
    if (data.success && data.config) {
      renderHatchSound(data.config.sound);
      showBotStatus(data.config.sound ? 'Dino hatch sounds on.' : 'Dino hatch sounds muted.', false);
    } else {
      showBotStatus(data.error || 'Could not change hatch sounds.', true);
    }
  } catch {
    showBotStatus('Network error changing hatch sounds.', true);
  }
}

function initCheckinReminder() {
  const showBtn = document.getElementById('ovCheckinBtn');
  const toggle = document.getElementById('ovCheckinToggleBtn');
  const save = document.getElementById('ovCheckinSaveBtn');
  if (showBtn) showBtn.addEventListener('click', function () { fireBotAction({ action: 'checkin-alert' }, showBtn); });
  if (toggle) toggle.addEventListener('click', function () { saveCheckinReminder(!checkinTimerEnabled); });
  if (save) save.addEventListener('click', function () { saveCheckinReminder(checkinTimerEnabled); });

  const hatchToggle = document.getElementById('ovHatchSoundToggle');
  if (hatchToggle) hatchToggle.addEventListener('click', function () { saveHatchSound(!hatchSoundOn); });

  const vol = document.getElementById('ovAlertVolume');
  const volVal = document.getElementById('ovAlertVolumeVal');
  if (vol) {
    /* Live label as it drags; save only on release, so one drag is one POST. */
    vol.addEventListener('input', function () { if (volVal) volVal.textContent = vol.value + '%'; });
    vol.addEventListener('change', function () { saveAlertVolume(parseInt(vol.value, 10)); });
  }

  fetch('/api/bot/trigger', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      if (d.checkinReminder) renderCheckinReminder(d.checkinReminder.enabled, d.checkinReminder.intervalMin);
      if (d.hatchConfig) renderHatchSound(d.hatchConfig.sound);
      if (typeof d.alertVolume === 'number' && vol) {
        vol.value = d.alertVolume;
        if (volVal) volVal.textContent = d.alertVolume + '%';
      }
    })
    .catch(function () { /* leave the defaults shown */ });
}

/* ── Mana Clash on the overlay ──────────────────────────────────── */

function renderOvMc(d) {
  const state = document.getElementById('ovMcState');
  const pick = document.getElementById('ovMcRoomPick');
  if (!state || !pick) return;

  const p = d.pointer || {};
  state.textContent = p.enabled && p.code ? 'Showing ' + p.code : 'Off';
  state.className = 'giveaway-status' + (p.enabled && p.code ? ' open' : '');

  /* The selection survives a refresh. A moderator who re-lists rooms
     mid-game and finds the dropdown reset to the top entry is one click
     from putting the wrong room on stream. */
  const keep = pick.value || (p.enabled ? p.code : '');
  const rooms = Array.isArray(d.rooms) ? d.rooms : [];

  pick.innerHTML = rooms.length
    ? rooms.map(function (r) {
        const bits = [r.code, r.status === 'playing' ? 'round ' + r.round : r.status];
        if (r.host) bits.push(r.host);
        bits.push(r.playerCount + (r.playerCount === 1 ? ' player' : ' players'));
        if (r.practice) bits.push('practice');
        return '<option value="' + escapeBotHtml(r.code) + '">' + escapeBotHtml(bits.join(' — ')) + '</option>';
      }).join('')
    : '<option value="">No rooms open — someone has to create one first</option>';

  if (keep && rooms.some(function (r) { return r.code === keep; })) pick.value = keep;
}

/* WHY THIS REPORTS INSTEAD OF RETURNING.
   A 404 because the service had not been restarted, a 403 because the account
   is not a moderator, and a channel with no rooms were all one symptom: a blank
   control saying nothing. The whole point of this card is to tell somebody what
   is available, so the one thing it must never do is go quiet. */
function ovMcSay(text) {
  const pick = document.getElementById('ovMcRoomPick');
  if (pick) pick.innerHTML = '<option value="">' + escapeBotHtml(text) + '</option>';
}

async function loadOvMc() {
  let res;
  try {
    res = await fetch('/api/overlay/mana-clash?rooms=1', { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    ovMcSay('Could not reach the server');
    return;
  }

  if (res.status === 404) {
    ovMcSay('Overlay route missing — restart the server');
    showBotStatus('The Mana Clash overlay route returned 404. The server needs restarting after the last pull.', true);
    return;
  }
  if (res.status === 403) {
    ovMcSay('You need moderator access');
    return;
  }
  if (!res.ok) {
    ovMcSay('Could not load rooms (HTTP ' + res.status + ')');
    return;
  }

  try {
    renderOvMc(await res.json());
  } catch {
    ovMcSay('Could not read the room list');
  }
}

async function setOvMc(body, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/overlay/mana-clash', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (d.success) {
      showBotStatus(d.enabled ? 'Overlay is showing ' + d.code + '.' : 'Overlay panel hidden.', false);
      await loadOvMc();
    } else {
      showBotStatus(d.error || 'Could not change the overlay.', true);
    }
  } catch {
    showBotStatus('Network error changing the overlay.', true);
  }
  if (btn) btn.disabled = false;
}

function initOvMc() {
  const show = document.getElementById('ovMcShowBtn');
  const off = document.getElementById('ovMcOffBtn');
  const refresh = document.getElementById('ovMcRefreshBtn');
  const pick = document.getElementById('ovMcRoomPick');
  if (!show) return;

  show.addEventListener('click', function () {
    const code = pick ? pick.value : '';
    if (!code) { showBotStatus('There is no room to show.', true); return; }
    setOvMc({ action: 'show', code: code }, show);
  });
  off.addEventListener('click', function () { setOvMc({ action: 'off' }, off); });
  refresh.addEventListener('click', function () { loadOvMc(); });

  const reload = document.getElementById('ovReloadBtn');
  if (reload) reload.addEventListener('click', function () { reloadOverlay(reload); });

  loadOvMc();
}

/* ── Commander Bingo on the overlay ─────────────────────────────────
   A room picker. Several Commander Bingo games can run at once (the newest
   simply claimed the overlay on creation); this dropdown lets the broadcaster
   or a moderator choose WHICH one the stream shows. The overlay resolves its
   room from bingo_current, so choosing a room POSTs { code, makeCurrent } to
   repoint it (and turn that room's show flag on); "— none (hide) —" clears the
   pointer so the overlay shows nothing. Populated from ?list=1, re-fetched on
   a slow tick so newly created rooms appear. */

function ovBingoSay(text, showing) {
  const state = document.getElementById('ovBingoState');
  if (!state) return;
  state.textContent = text;
  state.className = 'giveaway-status' + (showing ? ' open' : '');
}

/* The room the overlay actually shows, as of the last list. A failed
   repoint snaps the picker back to this rather than leaving a room selected
   that is not on stream. */
let ovBingoLive = '';

function renderOvBingo(rooms, force) {
  const pick = document.getElementById('ovBingoRoomPick');
  if (!pick) return;
  const list = Array.isArray(rooms) ? rooms : [];
  const current = list.find(function (r) { return r.isCurrent; });
  ovBingoLive = current ? current.code : '';

  if (!list.length) {
    ovBingoSay('No active games — a host has to create one first', false);
  } else if (current && current.showOnOverlay === false) {
    ovBingoSay((current.hostName || current.code) + ' (' + current.code + ') is picked, but its host switched the overlay off', false);
  } else if (current) {
    const n = current.playerCount + (current.playerCount === 1 ? ' player' : ' players');
    ovBingoSay('Showing ' + (current.hostName || current.code) + ' · ' + n + ' (' + current.code + ')', true);
  } else {
    ovBingoSay(list.length + (list.length === 1 ? ' game' : ' games') + ' running — none on the overlay', false);
  }

  /* Rebuilding the options closes an open dropdown, so the background tick
     leaves a focused picker alone — a moderator mid-choice keeps their menu.
     Explicit loads (after a change, or Refresh) always rebuild. */
  if (!force && document.activeElement === pick) return;

  let html = '<option value="">— none (hide) —</option>';
  html += list.map(function (r) {
    const n = r.playerCount + (r.playerCount === 1 ? ' player' : ' players');
    const label = (r.hostName || r.code) + ' — ' + n + ' (' + r.code + ')';
    return '<option value="' + escapeBotHtml(r.code) + '">' + escapeBotHtml(label) + '</option>';
  }).join('');
  pick.innerHTML = html;

  /* Always the room really on the overlay — never a stale earlier pick. */
  pick.value = ovBingoLive;
}

function ovBingoSayErr(text) {
  const pick = document.getElementById('ovBingoRoomPick');
  if (pick) pick.innerHTML = '<option value="">' + escapeBotHtml(text) + '</option>';
  ovBingoSay(text, false);
}

async function loadOvBingo(force) {
  let res;
  try {
    res = await fetch('/api/bingo/state?list=1', { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    ovBingoSayErr('Could not reach the server');
    return;
  }
  if (res.status === 404) {
    ovBingoSayErr('Bingo list route missing — restart the server');
    showBotStatus('The bingo list route returned 404. The server needs restarting after the last pull.', true);
    return;
  }
  if (res.status === 403) { ovBingoSayErr('You need moderator access'); return; }
  if (!res.ok) { ovBingoSayErr('Could not load rooms (HTTP ' + res.status + ')'); return; }

  let d;
  try { d = await res.json(); } catch { ovBingoSayErr('Could not read the room list'); return; }
  renderOvBingo(d.rooms, force === true);
}

async function setOvBingo(code) {
  const pick = document.getElementById('ovBingoRoomPick');
  const body = code ? { code: code, makeCurrent: true } : { clear: true };
  let okay = false;
  try {
    const res = await fetch('/api/bingo/overlay', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) {
      okay = true;
      showBotStatus(code ? 'Commander Bingo ' + code + ' is on the overlay.' : 'Commander Bingo hidden from the overlay.', false);
    } else if (res.status === 404 && !d.error) {
      showBotStatus('The bingo overlay route returned 404. The server needs restarting after the last pull.', true);
    } else {
      showBotStatus(d.error || 'Could not change the overlay.', true);
    }
  } catch {
    showBotStatus('Network error changing the overlay.', true);
  }
  /* A refused pick must not stay selected as though it were live. */
  if (!okay && pick) pick.value = ovBingoLive;
  await loadOvBingo(true);
}

function initOvBingo() {
  const pick = document.getElementById('ovBingoRoomPick');
  const refresh = document.getElementById('ovBingoRefreshBtn');
  if (!pick) return;

  pick.addEventListener('change', function () { setOvBingo(pick.value); });
  if (refresh) refresh.addEventListener('click', function () { loadOvBingo(true); });

  loadOvBingo(true);
  /* Slow tick so rooms created after this page opened show up without a
     manual refresh. The dashboard is not the OBS overlay, so an idle poll
     here carries none of the marathon-safety cost. */
  setInterval(loadOvBingo, 15000);
}

/* ── Skull Clicker raid boss ─────────────────────────────────────────── */
function ovRaidSay(text, live) {
  const el = document.getElementById('ovRaidState');
  if (!el) return;
  el.textContent = text;
  el.className = 'giveaway-status' + (live ? ' open' : '');
}

async function loadOvRaid() {
  let res;
  try { res = await fetch('/api/skull-raid', { credentials: 'same-origin', cache: 'no-store' }); }
  catch { ovRaidSay('Could not reach the server', false); return; }
  if (res.status === 404) { ovRaidSay('Raid route missing — restart the server', false); return; }
  if (!res.ok) { ovRaidSay('Could not load (HTTP ' + res.status + ')', false); return; }
  let s; try { s = await res.json(); } catch { return; }
  if (s.status === 'active') {
    const pct = s.maxHp ? Math.ceil((s.hp / s.maxHp) * 100) : 0;
    ovRaidSay(s.name + ' — ' + pct + '% HP', true);
  } else if (s.status === 'defeated') { ovRaidSay('Defeated by ' + (s.defeatedBy || '—'), false); }
  else { ovRaidSay('No boss', false); }
}

async function ovRaidPost(body, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/skull-raid', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) { showBotStatus(body.action === 'start' ? 'Boss summoned.' : 'Boss ended.', false); }
    else if (res.status === 404) { showBotStatus('The raid route returned 404. The server needs restarting after the last pull.', true); }
    else { showBotStatus(d.error || 'Could not change the boss.', true); }
  } catch { showBotStatus('Network error.', true); }
  if (btn) btn.disabled = false;
  loadOvRaid();
}

function initOvRaid() {
  const start = document.getElementById('ovRaidStartBtn');
  if (!start) return;
  start.addEventListener('click', function () {
    const hp = parseInt(document.getElementById('ovRaidHp').value, 10) || 5000;
    const minutes = parseInt(document.getElementById('ovRaidMin').value, 10) || 15;
    ovRaidPost({ action: 'start', hp: hp, minutes: minutes }, start);
  });
  document.getElementById('ovRaidEndBtn').addEventListener('click', function (e) { ovRaidPost({ action: 'end' }, e.target); });
  document.getElementById('ovRaidRefreshBtn').addEventListener('click', function () { loadOvRaid(); });
  loadOvRaid();
}

/* ── Overlay preset switch ───────────────────────────────────────────── */
async function loadOvPreset() {
  const state = document.getElementById('ovPresetState');
  const pick = document.getElementById('ovPresetPick');
  if (!state || !pick) return;
  let res;
  try { res = await fetch('/api/overlay/layout', { credentials: 'same-origin', cache: 'no-store' }); }
  catch { pick.innerHTML = '<option value="">Could not reach the server</option>'; return; }
  if (!res.ok) { pick.innerHTML = '<option value="">Could not load (HTTP ' + res.status + ')</option>'; return; }
  let d; try { d = await res.json(); } catch { return; }
  const names = Array.isArray(d.presets) ? d.presets : [];
  const active = d.active || '';
  state.textContent = active ? 'Live: ' + active : 'No preset live';
  state.className = 'giveaway-status' + (active ? ' open' : '');
  const keep = pick.value;
  pick.innerHTML = names.length
    ? names.map(function (n) { return '<option value="' + escapeBotHtml(n) + '">' + escapeBotHtml(n) + (n === active ? ' (live)' : '') + '</option>'; }).join('')
    : '<option value="">No presets yet — make some in the Overlay Layout editor</option>';
  if (keep && names.indexOf(keep) !== -1) pick.value = keep;
  else if (active) pick.value = active;
}

function initOvPreset() {
  const live = document.getElementById('ovPresetLiveBtn');
  const refresh = document.getElementById('ovPresetRefreshBtn');
  if (!live) return;
  live.addEventListener('click', async function () {
    const name = document.getElementById('ovPresetPick').value;
    if (!name) { showBotStatus('No preset selected.', true); return; }
    live.disabled = true;
    try {
      const res = await fetch('/api/overlay/layout', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'activate', name: name }),
      });
      const d = await res.json().catch(function () { return {}; });
      if (res.ok && d.success) {
        showBotStatus('"' + name + '" is live. Reloading the overlay…', false);
        await reloadOverlay(null);           /* push it to air immediately */
        await loadOvPreset();
      } else { showBotStatus(d.error || 'Could not switch preset.', true); }
    } catch { showBotStatus('Network error switching preset.', true); }
    live.disabled = false;
  });
  refresh.addEventListener('click', function () { loadOvPreset(); });
  loadOvPreset();
}

/* ── Stream overlay URL (broadcaster only) ──────────────────────────────── */

function initOverlayPanel(url) {
  const section = document.getElementById('overlaySection');
  const input = document.getElementById('botOverlayUrl');
  const copy = document.getElementById('botOverlayCopy');
  if (!section || !input || !url) return;

  section.hidden = false;
  input.value = url;

  if (copy) {
    copy.addEventListener('click', function () {
      input.select();
      const done = () => { copy.textContent = 'Copied!'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done).catch(function () {
          copy.textContent = 'Press Ctrl+C';
          setTimeout(() => { copy.textContent = 'Copy'; }, 2500);
        });
      } else {
        copy.textContent = 'Press Ctrl+C';
        setTimeout(() => { copy.textContent = 'Copy'; }, 2500);
      }
    });
  }
}

/* ── Test-alert suite ─────────────────────────────────────────────────────
   One button per one-shot overlay alert type. Each POSTs { action:'test-alert',
   type } to /api/bot/trigger, which pushes a representative sample through the
   ordinary overlay event path — so it renders and SELF-CLEARS like the real
   alert (nothing is left on the overlay). Standing panels are not here: the
   prediction entry fires its RESOLVED end-state, which auto-hides. */
var OD_TEST_ALERTS = [
  { type: 'sub', label: 'New Sub' },
  { type: 'giftsub', label: 'Gift Subs' },
  { type: 'raid', label: 'Raid' },
  { type: 'follow', label: 'Follow' },
  { type: 'cheer', label: 'Cheer' },
  { type: 'hype-level', label: 'Hype Level' },
  { type: 'drop', label: 'Code Drop' },
  { type: 'dino-hatch', label: 'Dino Hatch' },
  { type: 'giveaway-spin', label: 'Giveaway Reel' },
  { type: 'prediction', label: 'Prediction (result)' },
  { type: 'pham-checkin', label: 'Check-In Nudge' },
  { type: 'bingo-call', label: 'Bingo Call' },
  { type: 'bingo-win', label: 'Bingo Win' },
  { type: 'mtgbbb-pull', label: 'MTGBBB Pull' },
  { type: 'mtgbbb-bingo', label: 'MTGBBB Bingo' },
];

async function fireTestAlert(type, label, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/bot/trigger', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'test-alert', type: type }),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) {
      showBotStatus('Test "' + label + '" fired on the overlay — it will clear itself.', false);
    } else {
      showBotStatus(d.error || 'Could not fire that test alert.', true);
    }
  } catch {
    showBotStatus('Network error firing the test alert.', true);
  }
  if (btn) btn.disabled = false;
}

function initTestAlerts() {
  const box = document.getElementById('odTestAlertBtns');
  if (!box) return;
  box.innerHTML = '';
  OD_TEST_ALERTS.forEach(function (a) {
    const btn = document.createElement('button');
    btn.className = 'btn-secondary od-test-btn';
    btn.textContent = a.label;
    btn.addEventListener('click', function () { fireTestAlert(a.type, a.label, btn); });
    box.appendChild(btn);
  });
}

/* ── Alerts on/off ──────────────────────────────────────────────────────────
   A master switch per alert type. Enforced centrally in pushOverlayEvent, so a
   disabled type never reaches the overlay by any path. Default on. */
var OD_ALERT_LABELS = {
  sub: 'New Sub', giftsub: 'Gift Subs', raid: 'Raid', follow: 'Follow', cheer: 'Cheer',
  'hype-level': 'Hype Level', drop: 'Code/Item Drop', 'dino-hatch': 'Dino Hatch',
  'giveaway-spin': 'Giveaway Reel', prediction: 'Prediction', 'bingo-call': 'Bingo Call',
  'bingo-win': 'Bingo Win', 'mtgbbb-pull': 'MTGBBB Pull', 'mtgbbb-bingo': 'MTGBBB Bingo',
};

function renderAlertToggles(toggles) {
  const box = document.getElementById('odAlertToggles');
  if (!box || !toggles) return;
  box.innerHTML = '';
  Object.keys(toggles).forEach(function (type) {
    const label = document.createElement('label');
    label.className = 'od-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = toggles[type] !== false;
    cb.addEventListener('change', function () { setAlertToggle(type, cb.checked, cb); });
    const span = document.createElement('span');
    span.textContent = OD_ALERT_LABELS[type] || type;
    label.appendChild(cb);
    label.appendChild(span);
    box.appendChild(label);
  });
}

async function setAlertToggle(type, enabled, cb) {
  if (cb) cb.disabled = true;
  try {
    const res = await fetch('/api/bot/trigger', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'alert-toggle', type: type, enabled: enabled }),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) {
      showBotStatus((OD_ALERT_LABELS[type] || type) + ' alerts ' + (enabled ? 'on' : 'off') + '.', false);
    } else {
      if (cb) cb.checked = !enabled;              // revert on failure
      showBotStatus(d.error || 'Could not change the alert toggle.', true);
    }
  } catch {
    if (cb) cb.checked = !enabled;
    showBotStatus('Network error changing the alert toggle.', true);
  }
  if (cb) cb.disabled = false;
}

function initAlertToggles() {
  const box = document.getElementById('odAlertToggles');
  if (!box) return;
  fetch('/api/bot/trigger', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.alertToggles) renderAlertToggles(d.alertToggles); })
    .catch(function () { /* leave empty */ });
}

/* ── Alert Sounds ────────────────────────────────────────────────────────────
   One row per celebratory alert type. Upload a sting (via the shared media
   upload endpoint, which now accepts audio), set a volume, Test it, or Clear it
   back to the overlay's default. The config lives at /api/alert-sounds and the
   overlay reads it on its poll. */
var OD_SOUND_TYPES = [
  { type: 'sub', label: 'New Sub' },
  { type: 'resub', label: 'Resub' },
  { type: 'giftsub', label: 'Gift Subs' },
  { type: 'raid', label: 'Raid' },
  { type: 'follow', label: 'Follow' },
  { type: 'cheer', label: 'Cheer' },
];
var OD_SOUND_DEFAULT = '/assets/audio/alert.mp3';
/* One reused element for previews — never new Audio() per press. */
var odTestAudio = null;
/* { type: { url, volume } } — mirrors the stored config so a volume drag can
   re-save with the current url, and Test knows what to play. */
var odSoundState = {};

function odSoundStatus(type, text) {
  const row = document.querySelector('.od-sound-row[data-type="' + type + '"]');
  if (!row) return;
  const state = row.querySelector('.od-sound-state');
  if (state) state.textContent = text;
}

function renderAlertSounds() {
  const box = document.getElementById('odAlertSounds');
  if (!box) return;
  box.innerHTML = '';
  OD_SOUND_TYPES.forEach(function (a) {
    const cfg = odSoundState[a.type];
    const vol = cfg && typeof cfg.volume === 'number' ? Math.round(cfg.volume * 100) : 100;

    const row = document.createElement('div');
    row.className = 'od-sound-row';
    row.dataset.type = a.type;

    const name = document.createElement('span');
    name.className = 'od-sound-name';
    name.textContent = a.label;

    const state = document.createElement('span');
    state.className = 'od-sound-state';
    state.textContent = cfg && cfg.url ? 'Custom sound' : 'Default';

    const vwrap = document.createElement('span');
    vwrap.className = 'od-sound-volwrap';
    const slider = document.createElement('input');
    slider.type = 'range'; slider.className = 'od-sound-vol';
    slider.min = '0'; slider.max = '100'; slider.step = '5'; slider.value = String(vol);
    const vval = document.createElement('span');
    vval.className = 'od-sound-volval';
    vval.textContent = vol + '%';
    slider.addEventListener('input', function () { vval.textContent = slider.value + '%'; });
    slider.addEventListener('change', function () { onSoundVolume(a.type, parseInt(slider.value, 10)); });
    vwrap.appendChild(slider);
    vwrap.appendChild(vval);

    const upload = document.createElement('button');
    upload.className = 'btn-secondary od-sound-upload'; upload.type = 'button';
    upload.textContent = cfg && cfg.url ? 'Replace' : 'Upload';

    const test = document.createElement('button');
    test.className = 'btn-secondary od-sound-test'; test.type = 'button'; test.textContent = 'Test';

    const clear = document.createElement('button');
    clear.className = 'btn-secondary od-sound-clear'; clear.type = 'button'; clear.textContent = 'Clear';
    clear.disabled = !(cfg && cfg.url);

    const file = document.createElement('input');
    file.type = 'file'; file.className = 'od-sound-file'; file.accept = 'audio/mpeg,audio/ogg,audio/wav,audio/mp4,.mp3,.ogg,.wav,.m4a'; file.hidden = true;

    upload.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      if (file.files && file.files[0]) uploadSound(a.type, file.files[0], upload, slider);
      file.value = '';
    });
    test.addEventListener('click', function () { testSound(a.type, parseInt(slider.value, 10)); });
    clear.addEventListener('click', function () { clearSound(a.type, clear); });

    row.appendChild(name);
    row.appendChild(state);
    row.appendChild(vwrap);
    row.appendChild(upload);
    row.appendChild(test);
    row.appendChild(clear);
    row.appendChild(file);
    box.appendChild(row);
  });
}

async function postAlertSound(payload) {
  const res = await fetch('/api/alert-sounds', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const d = await res.json().catch(function () { return {}; });
  return { ok: res.ok, status: res.status, data: d };
}

async function uploadSound(type, fileObj, btn, slider) {
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  odSoundStatus(type, 'Uploading…');
  try {
    const fd = new FormData();
    fd.set('title', 'Alert sound: ' + type);
    fd.set('category', 'audio');
    fd.set('file', fileObj);
    const up = await fetch('/api/media/upload', { method: 'POST', credentials: 'same-origin', body: fd });
    const upData = await up.json().catch(function () { return {}; });
    if (!up.ok || !upData.item || !upData.item.url) {
      showBotStatus(upData.error || 'Could not upload that sound.', true);
      odSoundStatus(type, odSoundState[type] && odSoundState[type].url ? 'Custom sound' : 'Default');
      if (btn) { btn.disabled = false; btn.textContent = original; }
      return;
    }
    const volume = Math.max(0, Math.min(1, (parseInt(slider && slider.value, 10) || 100) / 100));
    const saved = await postAlertSound({ type: type, url: upData.item.url, volume: volume });
    if (saved.ok && saved.data.success) {
      odSoundState = saved.data.sounds || odSoundState;
      showBotStatus('Alert sound set for ' + type + '.', false);
      renderAlertSounds();
    } else {
      showBotStatus(saved.data.error || 'Could not save that sound.', true);
      odSoundStatus(type, odSoundState[type] && odSoundState[type].url ? 'Custom sound' : 'Default');
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  } catch {
    showBotStatus('Network error uploading the sound.', true);
    odSoundStatus(type, odSoundState[type] && odSoundState[type].url ? 'Custom sound' : 'Default');
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

async function onSoundVolume(type, pct) {
  const cfg = odSoundState[type];
  const volume = Math.max(0, Math.min(1, (pct || 0) / 100));
  /* With no uploaded sound there is nothing to attach a volume to; the value is
     kept on screen and used when a sound is uploaded. */
  if (!cfg || !cfg.url) return;
  const saved = await postAlertSound({ type: type, url: cfg.url, volume: volume });
  if (saved.ok && saved.data.success) {
    odSoundState = saved.data.sounds || odSoundState;
    showBotStatus('Volume set for ' + type + ' (' + pct + '%).', false);
  } else {
    showBotStatus(saved.data.error || 'Could not save the volume.', true);
  }
}

function testSound(type, pct) {
  const cfg = odSoundState[type];
  const src = cfg && cfg.url ? cfg.url : OD_SOUND_DEFAULT;
  try {
    if (!odTestAudio) odTestAudio = new Audio();
    if (odTestAudio.src.indexOf(src) === -1) odTestAudio.src = src;
    odTestAudio.volume = Math.max(0, Math.min(1, (pct || 0) / 100));
    odTestAudio.currentTime = 0;
    odTestAudio.play().catch(function () { showBotStatus('Could not play the sound (none uploaded yet, or the file is missing).', true); });
  } catch { /* no audio element */ }
}

async function clearSound(type, btn) {
  if (btn) btn.disabled = true;
  const saved = await postAlertSound({ type: type, clear: true });
  if (saved.ok && saved.data.success) {
    odSoundState = saved.data.sounds || {};
    showBotStatus('Alert sound for ' + type + ' reset to default.', false);
    renderAlertSounds();
  } else {
    showBotStatus(saved.data.error || 'Could not clear that sound.', true);
    if (btn) btn.disabled = false;
  }
}

function initAlertSounds() {
  const box = document.getElementById('odAlertSounds');
  if (!box) return;
  fetch('/api/alert-sounds', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { odSoundState = (d && d.sounds) ? d.sounds : {}; renderAlertSounds(); })
    .catch(function () { odSoundState = {}; renderAlertSounds(); });
}

/* ── Giveaway: replay last reveal ──────────────────────────────────────────
   The draws live on Bot Control; this only re-pushes the last stored reel.
   Each button is greyed until the server reports a stored reveal for it. */
async function loadReplayState() {
  const big = document.getElementById('odReplayBigBtn');
  const monthly = document.getElementById('odReplayMonthlyBtn');
  const state = document.getElementById('odReplayState');
  let d;
  try {
    const res = await fetch('/api/bot/giveaway', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) { if (state) state.textContent = 'Could not load giveaway state (HTTP ' + res.status + ').'; return; }
    d = await res.json();
  } catch {
    if (state) state.textContent = 'Could not reach the server.';
    return;
  }
  const r = d.replay || {};
  if (big) big.disabled = !r.big;
  if (monthly) monthly.disabled = !r.monthly;
  if (state) {
    const bits = [];
    bits.push(r.big ? 'Big Prize: ' + (r.big.who || 'winner') + (r.big.rarity ? ' (' + r.big.rarity + ')' : '') : 'Big Prize: nothing to replay yet');
    bits.push(r.monthly ? 'Monthly: ' + (r.monthly.who || 'winner') : 'Monthly: nothing to replay yet');
    state.textContent = bits.join(' · ');
  }
}

async function fireReplay(which, btn) {
  if (btn) btn.disabled = true;
  const original = btn ? btn.textContent : '';
  if (btn) btn.textContent = 'Replaying…';
  try {
    const res = await fetch('/api/bot/giveaway', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'replay', which: which }),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) {
      showBotStatus('Replaying the ' + (which === 'monthly' ? 'Monthly' : 'Big Prize') + ' reveal for ' + (d.who || 'the winner') + ' on the overlay.', false);
    } else {
      showBotStatus(d.error || 'Could not replay that reveal.', true);
    }
  } catch {
    showBotStatus('Network error replaying the reveal.', true);
  }
  if (btn) { btn.textContent = original; }
  loadReplayState();
}

function initGiveawayReplay() {
  const big = document.getElementById('odReplayBigBtn');
  const monthly = document.getElementById('odReplayMonthlyBtn');
  const refresh = document.getElementById('odReplayRefreshBtn');
  if (!big && !monthly) return;
  if (big) big.addEventListener('click', function () { fireReplay('big', big); });
  if (monthly) monthly.addEventListener('click', function () { fireReplay('monthly', monthly); });
  if (refresh) refresh.addEventListener('click', function () { loadReplayState(); });
  loadReplayState();
}

/* ── Games on Overlay ──────────────────────────────────────────────────────
   Manual start/stop for the three chat games whose overlay panels are
   otherwise only chat/host-driven. All reuse existing staff-gated routes; the
   overlay panels appear while running and hide (to display:none) when the game
   ends. Status is loaded on demand (init + after an action + Refresh), not
   polled — the scramble's GET advances its own clock, so a fast poll would
   nudge rounds along. */
function odGameState(id, text, on) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'giveaway-status' + (on ? ' open' : '');
}

/* Chat Maze — /api/bot/maze { start | stop }. */
async function loadOdMaze() {
  try {
    const res = await fetch('/api/bot/maze', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 404) { odGameState('odMazeState', 'Route missing — restart the server', false); return; }
    if (!res.ok) { odGameState('odMazeState', 'Could not load (HTTP ' + res.status + ')', false); return; }
    const d = await res.json();
    const running = d.status === 'active';
    odGameState('odMazeState', running ? 'Running — maze ' + d.level + ' (' + d.size + '×' + d.size + ')' : 'Idle', running);
    const start = document.getElementById('odMazeStartBtn');
    const stop = document.getElementById('odMazeStopBtn');
    if (start) start.disabled = running;
    if (stop) stop.disabled = !running;
  } catch { odGameState('odMazeState', 'Could not reach the server', false); }
}
async function odMazePost(action, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/bot/maze', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action }),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) {
      showBotStatus(action === 'start' ? 'Chat Maze started — its panel is on the overlay.' : 'Chat Maze stopped — its panel hides.', false);
    } else if (res.status === 403) {
      showBotStatus(d.error || 'Staff only.', true);
    } else if (res.status === 404) {
      showBotStatus('The maze route returned 404. The server needs restarting after the last pull.', true);
    } else {
      showBotStatus(d.error || 'Could not change the maze.', true);
    }
  } catch { showBotStatus('Network error changing the maze.', true); }
  loadOdMaze();
}

/* Chat Scramble — /api/chat-game { start | skip | stop }. The heartbeat only
   ADVANCES a running game; starting it is this POST. Start runs continuous
   rounds until Stop returns it to idle (which hides the panel). */
async function loadOdScramble() {
  try {
    const res = await fetch('/api/chat-game', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) { odGameState('odScrambleState', 'Could not load (HTTP ' + res.status + ')', false); return; }
    const d = await res.json();
    const live = d.status === 'running' || d.status === 'reveal';
    const label = d.status === 'running' ? 'Running — round ' + d.round
      : d.status === 'reveal' ? 'Revealing — round ' + d.round
      : 'Idle';
    odGameState('odScrambleState', label, live);
    const skip = document.getElementById('odScrambleSkipBtn');
    const stop = document.getElementById('odScrambleStopBtn');
    if (skip) skip.disabled = !live;
    if (stop) stop.disabled = !live;
  } catch { odGameState('odScrambleState', 'Could not reach the server', false); }
}
async function odScramblePost(action, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/chat-game', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action }),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) {
      showBotStatus(action === 'start' ? 'Chat Scramble started — first word is on the overlay.'
        : action === 'skip' ? 'Skipped to the next word.'
        : 'Chat Scramble stopped — panel returns to idle.', false);
    } else if (res.status === 403) {
      showBotStatus(d.error || 'Staff only.', true);
    } else {
      showBotStatus(d.error || 'Could not change the scramble.', true);
    }
  } catch { showBotStatus('Network error changing the scramble.', true); }
  loadOdScramble();
}

/* MTGBBB — hosted game. Show the live game and offer End; create/run is the
   Host UI. /api/mtgbbb/state?current=1 (404 = nothing live), /api/mtgbbb/end. */
let odMtgCode = null;
async function loadOdMtg() {
  const end = document.getElementById('odMtgEndBtn');
  try {
    const res = await fetch('/api/mtgbbb/state?current=1', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 404) { odMtgCode = null; odGameState('odMtgState', 'No game running', false); if (end) end.disabled = true; return; }
    if (!res.ok) { odGameState('odMtgState', 'Could not load (HTTP ' + res.status + ')', false); return; }
    const d = await res.json();
    odMtgCode = d.code || null;
    const running = d.status === 'active';
    odGameState('odMtgState',
      (running ? 'Running' : 'Ended') + ' — ' + d.code + ' · ' + (d.setName || d.setCode || 'set') +
      ' · ' + (d.packsOpened || 0) + '/' + (d.packCount || 0) + ' packs · ' +
      (d.playerCount || 0) + (d.playerCount === 1 ? ' player' : ' players'), running);
    if (end) end.disabled = !running;
  } catch { odGameState('odMtgState', 'Could not reach the server', false); }
}
async function odMtgEnd(btn) {
  if (!odMtgCode) { showBotStatus('No MTGBBB game to end.', true); return; }
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/mtgbbb/end', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: odMtgCode }),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) {
      showBotStatus('MTGBBB game ended — its overlay panel hides.', false);
    } else if (res.status === 403) {
      showBotStatus(d.error || 'Staff only.', true);
    } else {
      showBotStatus(d.error || 'Could not end the game.', true);
    }
  } catch { showBotStatus('Network error ending the game.', true); }
  loadOdMtg();
}

function initGamesOnOverlay() {
  const mStart = document.getElementById('odMazeStartBtn');
  if (mStart) mStart.addEventListener('click', function () { odMazePost('start', mStart); });
  const mStop = document.getElementById('odMazeStopBtn');
  if (mStop) mStop.addEventListener('click', function () { odMazePost('stop', mStop); });
  const mRefresh = document.getElementById('odMazeRefreshBtn');
  if (mRefresh) mRefresh.addEventListener('click', function () { loadOdMaze(); });

  const sStart = document.getElementById('odScrambleStartBtn');
  if (sStart) sStart.addEventListener('click', function () { odScramblePost('start', sStart); });
  const sSkip = document.getElementById('odScrambleSkipBtn');
  if (sSkip) sSkip.addEventListener('click', function () { odScramblePost('skip', sSkip); });
  const sStop = document.getElementById('odScrambleStopBtn');
  if (sStop) sStop.addEventListener('click', function () { odScramblePost('stop', sStop); });
  const sRefresh = document.getElementById('odScrambleRefreshBtn');
  if (sRefresh) sRefresh.addEventListener('click', function () { loadOdScramble(); });

  const gEnd = document.getElementById('odMtgEndBtn');
  if (gEnd) gEnd.addEventListener('click', function () { odMtgEnd(gEnd); });
  const gRefresh = document.getElementById('odMtgRefreshBtn');
  if (gRefresh) gRefresh.addEventListener('click', function () { loadOdMtg(); });

  loadOdMaze();
  loadOdScramble();
  loadOdMtg();
}

/* ── Customizable Wheel ────────────────────────────────────────────────────
   Edit segments (label + weight + on-palette colour), Save, and Spin. The spin
   is a one-shot overlay reveal (rides the alert queue, self-clears). Colours are
   LOCKED to a curated palette the server returns — no free colour picker, to
   keep the gothic identity. */
var OD_WHEEL_MIN = 2, OD_WHEEL_MAX = 12;
var odWheelPalette = { oxblood: '#6b0f0f', charcoal: '#1a1a1a', crimson: '#b31217', bone: '#4a4133', gold: '#8a6d1a' };

function odWheelRowEl(seg) {
  const names = Object.keys(odWheelPalette);
  const color = seg && seg.color && odWheelPalette[seg.color] ? seg.color : names[0];

  const row = document.createElement('div');
  row.className = 'od-wheel-row';

  const label = document.createElement('input');
  label.type = 'text'; label.className = 'bot-mod-input od-wheel-label';
  label.maxLength = 24; label.placeholder = 'Label';
  label.value = seg && seg.label ? seg.label : '';

  const weight = document.createElement('input');
  weight.type = 'number'; weight.className = 'lb-award-tier od-wheel-weight';
  weight.min = '1'; weight.max = '1000'; weight.step = '1'; weight.title = 'Weight (heavier = better odds)';
  weight.value = seg && Number(seg.weight) > 0 ? seg.weight : 1;

  const swatch = document.createElement('span');
  swatch.className = 'od-wheel-swatch';
  swatch.style.background = odWheelPalette[color];

  const select = document.createElement('select');
  select.className = 'giveaway-rarity-select od-wheel-color';
  names.forEach(function (n) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    if (n === color) o.selected = true;
    select.appendChild(o);
  });
  select.addEventListener('change', function () { swatch.style.background = odWheelPalette[select.value] || '#6b0f0f'; });

  const remove = document.createElement('button');
  remove.className = 'btn-secondary od-wheel-remove'; remove.type = 'button'; remove.textContent = 'Remove';
  remove.addEventListener('click', function () { row.remove(); odWheelSyncButtons(); });

  row.appendChild(label);
  row.appendChild(weight);
  row.appendChild(swatch);
  row.appendChild(select);
  row.appendChild(remove);
  return row;
}

function odWheelSyncButtons() {
  const rows = document.querySelectorAll('#odWheelRows .od-wheel-row');
  const add = document.getElementById('odWheelAddBtn');
  if (add) add.disabled = rows.length >= OD_WHEEL_MAX;
  rows.forEach(function (r) {
    const rm = r.querySelector('.od-wheel-remove');
    if (rm) rm.disabled = rows.length <= OD_WHEEL_MIN;
  });
}

function renderWheelRows(segments) {
  const box = document.getElementById('odWheelRows');
  if (!box) return;
  box.innerHTML = '';
  const segs = (segments && segments.length) ? segments : [{ label: '', weight: 1 }, { label: '', weight: 1 }];
  segs.slice(0, OD_WHEEL_MAX).forEach(function (s) { box.appendChild(odWheelRowEl(s)); });
  odWheelSyncButtons();
}

function collectWheelSegments() {
  return [].map.call(document.querySelectorAll('#odWheelRows .od-wheel-row'), function (r) {
    return {
      label: (r.querySelector('.od-wheel-label') || {}).value || '',
      weight: Number((r.querySelector('.od-wheel-weight') || {}).value) || 1,
      color: (r.querySelector('.od-wheel-color') || {}).value || 'oxblood',
    };
  });
}

async function loadWheel() {
  const state = document.getElementById('odWheelState');
  try {
    const res = await fetch('/api/wheel', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 403) { if (state) state.textContent = 'Staff only.'; return; }
    if (!res.ok) { if (state) state.textContent = 'Could not load (HTTP ' + res.status + ')'; return; }
    const d = await res.json();
    if (d.palette) odWheelPalette = d.palette;
    renderWheelRows(d.config && d.config.segments);
    if (state) {
      state.textContent = d.lastWinner && d.lastWinner.label ? 'Last winner: ' + d.lastWinner.label : 'Ready';
      state.className = 'giveaway-status' + (d.lastWinner && d.lastWinner.label ? ' open' : '');
    }
  } catch { if (state) state.textContent = 'Could not reach the server.'; }
}

async function saveWheel(btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/wheel', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', segments: collectWheelSegments() }),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) showBotStatus('Wheel saved (' + d.config.segments.length + ' segments).', false);
    else if (res.status === 403) showBotStatus(d.error || 'Staff only.', true);
    else showBotStatus(d.error || 'Could not save the wheel.', true);
  } catch { showBotStatus('Network error saving the wheel.', true); }
  if (btn) btn.disabled = false;
}

async function spinWheel(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Spinning…'; }
  try {
    /* Save the current edits first, so a spin always reflects what is on screen.
       If that save is REFUSED (empty labels, too few segments, staff gate), do
       NOT spin — a spin on a rejected config would land on stale/invalid data on
       stream while the panel showed an error. */
    const saveRes = await fetch('/api/wheel', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', segments: collectWheelSegments() }),
    });
    const saveData = await saveRes.json().catch(function () { return {}; });
    if (!(saveRes.ok && saveData.success)) {
      showBotStatus(saveData.error || 'Could not save the wheel, so it was not spun.', true);
      if (btn) { btn.disabled = false; btn.textContent = 'Spin the Wheel'; }
      return;
    }
    const res = await fetch('/api/wheel', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'spin' }),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) {
      showBotStatus('Spinning the wheel on the overlay — landing on "' + d.winner.label + '".', false);
      const state = document.getElementById('odWheelState');
      if (state) { state.textContent = 'Last winner: ' + d.winner.label; state.className = 'giveaway-status open'; }
    } else if (res.status === 403) {
      showBotStatus(d.error || 'Staff only.', true);
    } else {
      showBotStatus(d.error || 'Could not spin the wheel.', true);
    }
  } catch { showBotStatus('Network error spinning the wheel.', true); }
  if (btn) { btn.disabled = false; btn.textContent = 'Spin the Wheel'; }
}

function initWheel() {
  const rows = document.getElementById('odWheelRows');
  if (!rows) return;
  const add = document.getElementById('odWheelAddBtn');
  if (add) add.addEventListener('click', function () {
    if (document.querySelectorAll('#odWheelRows .od-wheel-row').length >= OD_WHEEL_MAX) return;
    rows.appendChild(odWheelRowEl({ label: '', weight: 1 }));
    odWheelSyncButtons();
  });
  const save = document.getElementById('odWheelSaveBtn');
  if (save) save.addEventListener('click', function () { saveWheel(save); });
  const spin = document.getElementById('odWheelSpinBtn');
  if (spin) spin.addEventListener('click', function () { spinWheel(spin); });
  loadWheel();
}

/* ── Access ────────────────────────────────────────────────────────────────
   Same gate as Bot Control: the client does not decide. It asks
   /api/bot/dashboard and renders whatever the server is prepared to answer for
   this account (broadcaster or approved moderator). */

function showOdDenied(message, offerLogin) {
  const denied = document.getElementById('odDenied');
  const deniedText = document.getElementById('odDeniedText');
  const loginBtn = document.getElementById('odLoginBtn');
  if (denied) denied.hidden = false;
  if (deniedText) deniedText.textContent = message;
  if (loginBtn) loginBtn.hidden = !offerLogin;
}

/* Stream Night Modes — POST-only start/stop for the three chat-vs-stream
   sessions. No live-state readout: two of the three GETs are overlay-key gated,
   and the overlay panels already show "is it live" on stream. */
async function nightPost(url, body, btn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && (d.success || d.ok || res.status === 200)) {
      showBotStatus(okMsg, false);
    } else if (res.status === 403) {
      showBotStatus(d.error || 'Staff only.', true);
    } else if (res.status === 404) {
      showBotStatus('Route 404 — the server needs restarting after the last pull.', true);
    } else {
      showBotStatus(d.error || 'Could not change that mode.', true);
    }
  } catch { showBotStatus('Network error.', true); }
  if (btn) btn.disabled = false;
}

function initStreamNight() {
  const on = function (id, fn) { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };

  on('odTitheStartBtn', function (e) {
    const goal = parseInt((document.getElementById('odTitheGoal') || {}).value, 10);
    if (!goal || goal < 1) { showBotStatus('Enter a Bone Tithe goal first.', true); return; }
    const mins = parseInt((document.getElementById('odTitheMins') || {}).value, 10);
    const body = { action: 'start', goal: goal };
    if (mins && mins > 0) body.minutes = mins;
    nightPost('/api/bone-tithe', body, e.currentTarget, 'Bone Tithe started — the goal panel is on the overlay.');
  });
  on('odTitheStopBtn', function (e) { nightPost('/api/bone-tithe', { action: 'stop' }, e.currentTarget, 'Bone Tithe stopped.'); });

  on('odClashStartBtn', function (e) { nightPost('/api/mana-clash-chat', { action: 'start' }, e.currentTarget, 'Streamer vs Chat started — chat plays with !clash.'); });
  on('odClashStopBtn', function (e) { nightPost('/api/mana-clash-chat', { action: 'end' }, e.currentTarget, 'Streamer vs Chat ended.'); });

  on('odWindStartBtn', function (e) { nightPost('/api/pham-wind-night', { action: 'start' }, e.currentTarget, 'Wind Night started — chat steers with !wind left / !wind right.'); });
  on('odWindStopBtn', function (e) { nightPost('/api/pham-wind-night', { action: 'end' }, e.currentTarget, 'Wind Night ended.'); });

  on('odSafariStartBtn', function (e) {
    const rule = (document.getElementById('odSafariRule') || {}).value === 'first' ? 'first' : 'raffle';
    nightPost('/api/dino-safari', { action: 'start', rule: rule },
      e.currentTarget, 'Dino Safari started (' + (rule === 'first' ? 'first catch' : 'raffle') + ') — chat catches wild dinos with !catch.');
  });
  on('odSafariStopBtn', function (e) { nightPost('/api/dino-safari', { action: 'stop' }, e.currentTarget, 'Dino Safari ended.'); });
}

function initOverlayDashboard(data) {
  initPanic();
  initStreamNight();
  initAlertLog();
  initOvMc();
  initOvBingo();
  initOvRaid();
  initOvPreset();
  initCheckinReminder();
  initGamesOnOverlay();
  initTestAlerts();
  initAlertToggles();
  initAlertSounds();
  initWheel();
  initGiveawayReplay();
  if (data.isBroadcaster) initOverlayPanel(data.overlayUrl);
}

document.addEventListener('DOMContentLoaded', async function () {
  let res;
  try {
    res = await fetch('/api/bot/dashboard', { credentials: 'same-origin' });
  } catch {
    showOdDenied('Could not reach the server. Reload to try again.', false);
    return;
  }

  if (!res.ok) {
    const session = typeof getSession === 'function' ? getSession() : null;
    if (!session) {
      showOdDenied('Log in with Twitch to access this page.', true);
    } else {
      let msg = 'This page is for the broadcaster and approved moderators.';
      try { const body = await res.json(); if (body && body.error) msg = body.error; } catch {}
      showOdDenied(msg, false);
    }
    return;
  }

  const data = await res.json();

  const panel = document.getElementById('odPanel');
  if (panel) panel.hidden = false;

  initOverlayDashboard(data);
});
