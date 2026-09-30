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
      fetchAlerts();
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

/* ── Live alert bar ───────────────────────────────────────────────────────
   Consumes the existing activity feed (/api/activity, broadcaster/mod-gated),
   the same one the Activity page reads. Newest first, timestamped. Polls only
   while the tab is visible and stops when hidden — this page sits open beside a
   running stream. */
var OD_ALERT_POLL_MS = 5000;
var odAlertTimer = null;

var OD_ALERT_CHIP = {
  sub: 'Sub', giftsub: 'Gift', raid: 'Raid',
  hype: 'Hype', redemption: 'Redeem', bot: 'Bot', drop: 'Drop', event: 'Event',
};

function odClockTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); }
  catch { return ''; }
}

function renderAlerts(events) {
  const list = document.getElementById('odAlertList');
  if (!list) return;
  if (!events || events.length === 0) {
    list.innerHTML = '<li class="od-alert-empty">Nothing yet — alerts show here as they fire.</li>';
    return;
  }
  list.innerHTML = events.map(function (e) {
    const chip = OD_ALERT_CHIP[e.category] || (e.category || 'event');
    return '<li class="od-alert-row">' +
      '<span class="od-alert-time" title="' + escapeBotHtml(new Date(e.at).toLocaleString()) + '">' +
        escapeBotHtml(odClockTime(e.at)) + '</span>' +
      '<span class="od-alert-chip cat-' + escapeBotHtml(e.category || 'event') + '">' + escapeBotHtml(chip) + '</span>' +
      '<span class="od-alert-summary">' + escapeBotHtml(e.summary || e.type || 'event') + '</span>' +
      '</li>';
  }).join('');
}

async function fetchAlerts() {
  const note = document.getElementById('odAlertNote');
  try {
    const res = await fetch('/api/activity?limit=40', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) { if (note) note.textContent = 'Feed unavailable'; return; }
    const data = await res.json();
    renderAlerts(data.events || []);
    if (note) note.textContent = 'Updated ' + odClockTime(Date.now());
  } catch {
    if (note) note.textContent = 'Offline — retrying';
  }
}

function startAlertPolling() {
  if (odAlertTimer) clearInterval(odAlertTimer);
  odAlertTimer = setInterval(fetchAlerts, OD_ALERT_POLL_MS);
}
function stopAlertPolling() {
  if (odAlertTimer) { clearInterval(odAlertTimer); odAlertTimer = null; }
}

function initStatusBar() {
  const clearBtn = document.getElementById('odClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', function () { reloadOverlay(clearBtn); });

  fetchAlerts();
  startAlertPolling();
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopAlertPolling();
    else { fetchAlerts(); startAlertPolling(); }
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
   Unlike Mana Clash, there is no room to pick: the overlay finds the live
   Commander Bingo game itself via bingo_current. So this card reports that
   one game and offers the same show/hide switch the host has. */

let ovBingoCode = null;

function ovBingoSay(text, showing) {
  const state = document.getElementById('ovBingoState');
  if (!state) return;
  state.textContent = text;
  state.className = 'giveaway-status' + (showing ? ' open' : '');
}

function ovBingoButtons(enabled) {
  ['ovBingoShowBtn', 'ovBingoOffBtn'].forEach(function (id) {
    const b = document.getElementById(id);
    if (b) b.disabled = !enabled;
  });
}

async function loadOvBingo() {
  let res;
  try {
    res = await fetch('/api/bingo/state?current=1', { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    ovBingoSay('Could not reach the server', false);
    return;
  }

  if (res.status === 404) {
    ovBingoCode = null;
    ovBingoSay('No game running', false);
    ovBingoButtons(false);
    return;
  }
  if (!res.ok) {
    ovBingoSay('Could not load the game (HTTP ' + res.status + ')', false);
    return;
  }

  let g;
  try { g = await res.json(); } catch { ovBingoSay('Could not read the game', false); return; }

  if (!g || !g.code || g.status !== 'active') {
    ovBingoCode = null;
    ovBingoSay('No game running', false);
    ovBingoButtons(false);
    return;
  }

  ovBingoCode = g.code;
  ovBingoButtons(true);
  const where = g.code + ' · ' + (g.calledCount || 0) + '/' + (g.total || 68) +
                ' · ' + (g.playerCount || 0) + (g.playerCount === 1 ? ' player' : ' players');
  if (g.showOnOverlay === false) ovBingoSay('Hidden — ' + where, false);
  else ovBingoSay('Showing ' + where, true);
}

async function setOvBingo(show, btn) {
  if (!ovBingoCode) { showBotStatus('There is no game to show.', true); return; }
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/bingo/overlay', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ovBingoCode, show: show }),
    });
    const d = await res.json().catch(function () { return {}; });
    if (res.ok && d.success) {
      showBotStatus(d.showOnOverlay ? 'Commander Bingo is on the overlay.' : 'Commander Bingo hidden from the overlay.', false);
    } else if (res.status === 404) {
      showBotStatus('The bingo overlay route returned 404. The server needs restarting after the last pull.', true);
    } else {
      showBotStatus(d.error || 'Could not change the overlay.', true);
    }
  } catch {
    showBotStatus('Network error changing the overlay.', true);
  }
  await loadOvBingo();
}

function initOvBingo() {
  const show = document.getElementById('ovBingoShowBtn');
  const off = document.getElementById('ovBingoOffBtn');
  const refresh = document.getElementById('ovBingoRefreshBtn');
  if (!show) return;

  show.addEventListener('click', function () { setOvBingo(true, show); });
  off.addEventListener('click', function () { setOvBingo(false, off); });
  refresh.addEventListener('click', function () { loadOvBingo(); });

  loadOvBingo();
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

function initOverlayDashboard(data) {
  initStatusBar();
  initOvMc();
  initOvBingo();
  initOvRaid();
  initOvPreset();
  initCheckinReminder();
  initTestAlerts();
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
