/* ══════════════════════════════════════════════
   BOT CONTROL PANEL
   Broadcaster-only manual drop/announce triggers
   ══════════════════════════════════════════════ */

const RARITY_LABELS = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', mythic: 'Mythic' };

function formatBotActionTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

function renderBotActionFeed(log) {
  const feed = document.getElementById('botActionFeed');
  if (!feed) return;

  if (!log || log.length === 0) {
    feed.innerHTML = '<li class="bot-action-feed-empty">No bot actions yet.</li>';
    return;
  }

  feed.innerHTML = log.map(function (entry) {
    const failedNote = entry.sent === false ? ' (send failed)' : '';
    let tag = 'Announce';
    let body = escapeBotHtml(entry.message || '') + ' — by ' + escapeBotHtml(entry.actor || 'unknown') + failedNote;

    if (entry.type === 'drop') {
      tag = 'Drop';
      const label = RARITY_LABELS[entry.rarity] || entry.rarity;
      body = '<b>' + label + '</b> code dropped by ' + escapeBotHtml(entry.actor || 'unknown') + failedNote;
    } else if (entry.type === 'giveaway-winner') {
      tag = 'Winner';
      body = '<b>' + escapeBotHtml(entry.username || 'unknown') + '</b> picked as giveaway winner by ' + escapeBotHtml(entry.actor || 'unknown');
    } else if (entry.type === 'giveaway-code') {
      tag = 'Prize';
      body = 'Prize code whispered to <b>' + escapeBotHtml(entry.username || 'unknown') + '</b> by ' + escapeBotHtml(entry.actor || 'unknown') + failedNote;
    }

    return '<li class="bot-action-item">' +
      '<span class="bot-action-tag ' + entry.type + '">' + tag + '</span>' +
      '<span class="bot-action-item-time">' + formatBotActionTime(entry.at) + '</span>' +
      '<span class="bot-action-item-body">' + body + '</span>' +
      '</li>';
  }).join('');
}

function escapeBotHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showBotStatus(message, isError) {
  const el = document.getElementById('botStatusMsg');
  if (!el) return;
  el.textContent = message;
  el.className = 'bot-status-msg ' + (isError ? 'error' : 'success');
  el.hidden = false;
}

/* ── Dashboard ───────────────────────────────────────────────────────────
   One call backing the whole panel. /api/bot/dashboard existed for this and
   was wired to nothing — the page was making three separate calls and still
   showing none of the state the endpoint was built to surface. */

function renderPools(pools) {
  const grid = document.getElementById('botPoolGrid');
  if (!grid) return;

  if (!pools || pools.error) {
    grid.innerHTML = '<p class="bot-pool-error">Could not read pool levels' +
      (pools && pools.error ? ': ' + escapeBotHtml(pools.error) : '.') + '</p>';
    return;
  }

  grid.innerHTML = ['common', 'uncommon', 'rare', 'mythic'].map(function (tier) {
    const p = pools[tier];
    if (!p) return '';
    /* Three states, because "low" and "empty" need different reactions: low
       is a restock reminder, empty means pressing Drop does nothing at all. */
    let state = 'ok';
    if (p.available === 0) state = 'empty';
    else if (p.available <= p.low) state = 'low';

    const pct = p.target > 0 ? Math.min(100, Math.round((p.available / p.target) * 100)) : 0;
    const note = state === 'empty' ? 'Empty — drops will not post'
      : state === 'low' ? 'Running low' : '';

    return '<div class="bot-pool" data-tier="' + tier + '" data-state="' + state + '">' +
      '<span class="bot-pool-tier">' + RARITY_LABELS[tier] + '</span>' +
      '<span class="bot-pool-count">' + p.available + '<small> / ' + p.target + '</small></span>' +
      '<span class="bot-pool-bar"><i style="width:' + pct + '%"></i></span>' +
      (note ? '<span class="bot-pool-note">' + note + '</span>' : '') +
      '</div>';
  }).join('');
}

function renderWarnings(data) {
  const box = document.getElementById('botWarnings');
  if (!box) return;
  const warnings = [];

  /* Hype train drops cannot fire without this subscription and the failure
     is completely silent — no error, no log line, nothing in chat. A
     standing banner beats finding out during a hype train. */
  if (data.hypeTrain && !data.hypeTrain.subscribed) {
    warnings.push('No hype train EventSub subscription is registered, so hype train drops will not fire. Re-run Step 4 on the bot setup page.');
  }

  const pools = data.pools;
  if (pools && !pools.error) {
    const empty = ['common', 'uncommon', 'rare', 'mythic']
      .filter(function (t) { return pools[t] && pools[t].available === 0; })
      .map(function (t) { return RARITY_LABELS[t]; });
    if (empty.length) {
      warnings.push('Out of codes: ' + empty.join(', ') + '. Dropping these tiers will post nothing to chat.');
    }
  }

  box.innerHTML = warnings.map(function (w) {
    return '<div class="bot-warning">' + escapeBotHtml(w) + '</div>';
  }).join('');
}

function renderLiveDrops(drops) {
  const section = document.getElementById('liveDropSection');
  const box = document.getElementById('botLiveDrops');
  if (!section || !box) return;

  if (!drops || drops.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  box.innerHTML = drops.map(function (d) {
    const secs = Math.max(0, Math.round((d.expiresAt - Date.now()) / 1000));
    const mins = Math.floor(secs / 60);
    const left = mins > 0 ? mins + 'm ' + (secs % 60) + 's' : secs + 's';

    const codes = (d.codes || []).map(function (c) {
      /* A live code with no record expired out of the drop-code table while
         the drop itself is still open. Showing a plain 0 would read as
         "nobody claimed it" when the truth is "it can't be claimed". */
      if (!c.registered) {
        return '<li class="bot-drop-code unregistered"><code>' + escapeBotHtml(c.code) +
          '</code><span>expired from the code table</span></li>';
      }
      return '<li class="bot-drop-code"><code>' + escapeBotHtml(c.code) + '</code>' +
        '<span>' + c.claims + (c.claims === 1 ? ' claim' : ' claims') + '</span></li>';
    }).join('');

    return '<div class="bot-drop-live">' +
      '<div class="bot-drop-live-head">' +
      '<span class="bot-item-rarity ' + d.rarity + '">' + (RARITY_LABELS[d.rarity] || d.rarity) + '</span>' +
      (d.level ? '<span class="bot-drop-level">Level ' + escapeBotHtml(String(d.level)) + '</span>' : '') +
      '<span class="bot-drop-timer">' + left + ' left</span>' +
      '</div>' +
      '<ul class="bot-drop-codes">' + codes + '</ul>' +
      '</div>';
  }).join('');
}

function renderGiveawayStats(g) {
  const box = document.getElementById('botGiveawayStats');
  if (!box || !g) return;

  const ends = g.endsAt ? new Date(g.endsAt) : null;
  const daysLeft = ends ? Math.max(0, Math.ceil((ends - Date.now()) / 86400000)) : null;

  box.innerHTML =
    '<div class="bot-stat"><span class="bot-stat-num">' + (g.totalEntries || 0) + '</span><span class="bot-stat-label">total entries</span></div>' +
    '<div class="bot-stat"><span class="bot-stat-num">' + (g.participants || 0) + '</span><span class="bot-stat-label">participants</span></div>' +
    '<div class="bot-stat"><span class="bot-stat-num">' + (daysLeft === null ? '—' : daysLeft) + '</span><span class="bot-stat-label">days left</span></div>' +
    '<div class="bot-stat"><span class="bot-stat-num">' + escapeBotHtml(g.month || '—') + '</span><span class="bot-stat-label">month</span></div>';
}

function renderCheckins(c) {
  const section = document.getElementById('checkinSection');
  const box = document.getElementById('botCheckins');
  if (!section || !box) return;

  /* Hidden entirely when offline with nobody checked in — an empty panel on
     a channel that is not live says nothing worth the space. */
  if (!c || (!c.live && !c.count)) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  if (!c.count) {
    box.innerHTML = '<p class="bot-muted">' +
      (c.live ? 'Live — nobody has checked in yet this stream.' : 'No check-ins.') + '</p>';
    return;
  }

  const rows = c.recent.map(function (p) {
    const when = p.minutesIn === null || p.minutesIn === undefined
      ? new Date(p.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : (p.minutesIn === 0 ? 'at the start' : '+' + p.minutesIn + 'm in');
    return '<li class="bot-checkin-row">' +
      '<span class="bot-checkin-name">' + escapeBotHtml(p.displayName || p.userId) + '</span>' +
      '<span class="bot-checkin-when">' + escapeBotHtml(when) + '</span>' +
      '</li>';
  }).join('');

  box.innerHTML =
    '<div class="bot-checkin-count">' + c.count + (c.count === 1 ? ' check-in' : ' check-ins') +
    (c.recent.length < c.count ? ' (showing ' + c.recent.length + ')' : '') + '</div>' +
    '<ul class="bot-checkin-list">' + rows + '</ul>';
}

async function refreshDashboard() {
  try {
    const res = await fetch('/api/bot/dashboard', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();

    renderWarnings(data);
    renderPools(data.pools);
    renderCheckins(data.checkins);
    renderLiveDrops(data.activeDrops);
    renderGiveawayStats(data.giveaway);
    renderBotActionFeed(data.recentActions || []);
    return data;
  } catch {
    return null;    /* leave the last good render on screen */
  }
}

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
        drop: 'Code dropped to chat.',
        dropitem: 'Item code dropped to chat.',
        announce: 'Announcement sent to chat.',
      };
      showBotStatus(messages[payload.action] || 'Done.', false);
      await refreshDashboard();
      if (payload.action === 'dropitem') await loadItemQueue();
    } else {
      showBotStatus(data.error || 'Action failed.', true);
    }
  } catch {
    showBotStatus('Network error — action may not have been sent.', true);
  }

  if (button) { button.disabled = false; button.textContent = originalText; }
}

/* ── Item Code Queue ─────────────────────────── */

function renderItemQueue(data) {
  const list = document.getElementById('botItemQueue');
  if (!list) return;

  const pending = (data && data.pending) || [];
  const active = (data && data.active) || [];

  if (pending.length === 0 && active.length === 0) {
    list.innerHTML = '<li class="bot-item-queue-empty">No item codes queued. Ask the cosmetics/item system to create one.</li>';
    return;
  }

  const rows = [];

  active.forEach(function (entry) {
    rows.push(
      '<li class="bot-item-row">' +
      '<span class="bot-item-rarity ' + entry.item.rarity + '">' + entry.item.rarity + '</span>' +
      '<span class="bot-item-name">' + escapeBotHtml(entry.item.name) + '</span>' +
      '<span class="bot-item-active-tag">Active in chat</span>' +
      '</li>'
    );
  });

  pending.forEach(function (entry) {
    rows.push(
      '<li class="bot-item-row">' +
      '<span class="bot-item-rarity ' + entry.item.rarity + '">' + entry.item.rarity + '</span>' +
      '<span class="bot-item-name">' + escapeBotHtml(entry.item.name) + '</span>' +
      '<button class="btn-secondary bot-item-drop-btn" data-code="' + escapeBotHtml(entry.code) + '">Drop</button>' +
      '</li>'
    );
  });

  list.innerHTML = rows.join('');

  list.querySelectorAll('.bot-item-drop-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      fireBotAction({ action: 'dropitem', code: btn.dataset.code }, btn);
    });
  });
}

async function loadItemQueue() {
  try {
    const res = await fetch('/api/item-codes?action=queue', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    renderItemQueue(data);
  } catch {
    /* leave the list as-is */
  }
}

/* ── Big Prize Giveaway ─────────────────────── */

let giveawayIsOpen = false;

function renderGiveawayWheel(entrants) {
  const wheel = document.getElementById('giveawayWheel');
  if (!wheel) return;
  wheel.style.transition = 'none';
  wheel.style.transform = 'rotate(0deg)';
  wheel.innerHTML = '';

  if (!entrants || entrants.length === 0) {
    wheel.style.background = 'var(--gray-lo)';
    const empty = document.createElement('div');
    empty.className = 'giveaway-wheel-empty';
    empty.textContent = 'No entrants yet';
    wheel.appendChild(empty);
    return;
  }

  const n = entrants.length;
  const segDeg = 360 / n;
  const colors = ['#1a0000', '#000000'];
  const stops = entrants.map(function (e, i) {
    return colors[i % 2] + ' ' + (i * segDeg) + 'deg ' + ((i + 1) * segDeg) + 'deg';
  }).join(', ');
  wheel.style.background = 'conic-gradient(' + stops + ')';

  if (segDeg >= 12) {
    entrants.forEach(function (e, i) {
      const angle = i * segDeg + segDeg / 2;
      const label = document.createElement('div');
      label.className = 'giveaway-wheel-label';
      label.textContent = e.username;
      label.style.transform = 'rotate(' + angle + 'deg) translate(90px) rotate(' + (-angle) + 'deg)';
      wheel.appendChild(label);
    });
  }
}

function spinGiveawayWheelTo(entrants, winnerIndex) {
  const wheel = document.getElementById('giveawayWheel');
  if (!wheel) return;
  const segDeg = 360 / entrants.length;
  const target = 360 * 6 - (winnerIndex * segDeg + segDeg / 2);
  wheel.style.transition = 'transform 4s cubic-bezier(0.15, 0.85, 0.25, 1)';
  requestAnimationFrame(function () {
    wheel.style.transform = 'rotate(' + target + 'deg)';
  });
}

function setGiveawayOpenUI(open, entrantCount) {
  giveawayIsOpen = open;
  const statusEl = document.getElementById('giveawayStatus');
  const toggleBtn = document.getElementById('giveawayToggleBtn');
  const countEl = document.getElementById('giveawayEntrantCount');
  if (statusEl) {
    statusEl.textContent = open ? 'Entries Open' : 'Entries Closed';
    statusEl.className = 'giveaway-status' + (open ? ' open' : '');
  }
  if (toggleBtn) toggleBtn.textContent = open ? 'Close Entries' : 'Open Entries';
  if (countEl) countEl.textContent = (entrantCount || 0) + (entrantCount === 1 ? ' entrant' : ' entrants');
}

function showGiveawayWinner(winner) {
  const panel = document.getElementById('giveawayWinnerPanel');
  const nameEl = document.getElementById('giveawayWinnerName');
  if (nameEl) nameEl.textContent = winner.username;
  if (panel) panel.hidden = false;
}

async function loadGiveawayState() {
  try {
    const res = await fetch('/api/bot/giveaway', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    setGiveawayOpenUI(data.open, data.entrantCount);
    renderGiveawayWheel(data.entrants);
    if (data.winner) showGiveawayWinner(data.winner);
  } catch {
    /* leave panel as-is */
  }
}

async function toggleGiveawayEntries() {
  const btn = document.getElementById('giveawayToggleBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/bot/giveaway', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle', open: !giveawayIsOpen }),
    });
    const data = await res.json();
    if (data.success) {
      setGiveawayOpenUI(data.open, undefined);
      showBotStatus(data.open ? 'Giveaway entries are open.' : 'Giveaway entries are closed.', false);
    } else {
      showBotStatus(data.error || 'Could not toggle entries.', true);
    }
  } catch {
    showBotStatus('Network error toggling entries.', true);
  }
  if (btn) btn.disabled = false;
}

async function spinGiveawayWheel() {
  const btn = document.getElementById('giveawaySpinBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Spinning...'; }
  document.getElementById('giveawayWinnerPanel').hidden = true;

  try {
    const res = await fetch('/api/bot/giveaway', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pick-winner' }),
    });
    const data = await res.json();
    if (data.success) {
      renderGiveawayWheel(data.entrants);
      requestAnimationFrame(function () {
        spinGiveawayWheelTo(data.entrants, data.winnerIndex);
      });
      setTimeout(function () { showGiveawayWinner(data.winner); }, 4100);
    } else {
      showBotStatus(data.error || 'Could not pick a winner.', true);
    }
  } catch {
    showBotStatus('Network error picking a winner.', true);
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Spin the Wheel'; }
}

async function sendGiveawayCode() {
  const btn = document.getElementById('giveawaySendCodeBtn');
  const tier = document.getElementById('giveawayCodeTier').value;
  const manualCode = document.getElementById('giveawayCodeManual').value.trim();

  if (!tier && !manualCode) {
    showBotStatus('Pick a tier or paste a code first.', true);
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  try {
    const res = await fetch('/api/bot/giveaway', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send-code', rarity: tier || undefined, code: manualCode || undefined }),
    });
    const data = await res.json();
    if (data.success) {
      showBotStatus(data.sent ? 'Code whispered to the winner.' : 'Code saved but the whisper failed to send.', !data.sent);
      await refreshDashboard();
    } else {
      showBotStatus(data.error || 'Could not send the code.', true);
    }
  } catch {
    showBotStatus('Network error sending the code.', true);
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Whisper Code to Winner'; }
}

async function resetGiveaway() {
  const btn = document.getElementById('giveawayResetBtn');
  if (btn) btn.disabled = true;
  try {
    await fetch('/api/bot/giveaway', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    });
    document.getElementById('giveawayWinnerPanel').hidden = true;
    document.getElementById('giveawayCodeManual').value = '';
    document.getElementById('giveawayCodeTier').value = '';
    await loadGiveawayState();
    showBotStatus('Giveaway reset — entrants cleared.', false);
  } catch {
    showBotStatus('Network error resetting the giveaway.', true);
  }
  if (btn) btn.disabled = false;
}

function initGiveawayPanel() {
  const toggleBtn = document.getElementById('giveawayToggleBtn');
  const spinBtn = document.getElementById('giveawaySpinBtn');
  const sendBtn = document.getElementById('giveawaySendCodeBtn');
  const resetBtn = document.getElementById('giveawayResetBtn');

  if (toggleBtn) toggleBtn.addEventListener('click', toggleGiveawayEntries);
  if (spinBtn) spinBtn.addEventListener('click', spinGiveawayWheel);
  if (sendBtn) sendBtn.addEventListener('click', sendGiveawayCode);
  if (resetBtn) resetBtn.addEventListener('click', resetGiveaway);

  loadGiveawayState();
}

function initBotControlPanel() {
  document.querySelectorAll('.bot-drop-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      fireBotAction({ action: 'drop', rarity: btn.dataset.rarity }, btn);
    });
  });

  const announceInput = document.getElementById('botAnnounceText');
  const announceCount = document.getElementById('botAnnounceCount');
  const announceBtn = document.getElementById('botAnnounceBtn');

  if (announceInput && announceCount) {
    announceInput.addEventListener('input', function () {
      announceCount.textContent = announceInput.value.length + ' / 450';
    });
  }

  if (announceBtn && announceInput) {
    announceBtn.addEventListener('click', function () {
      const message = announceInput.value.trim();
      if (!message) {
        showBotStatus('Type a message before sending.', true);
        return;
      }
      fireBotAction({ action: 'announce', message: message }, announceBtn);
    });
  }

  refreshDashboard();
  loadItemQueue();
  initGiveawayPanel();

  /* Modest poll. Pools drift slowly, but a drop's claim count is the number
     you actually watch while it is live, and its window is only 5 minutes.
     Paused while the tab is hidden — this panel sits open on a machine that
     is also running a stream. */
  setInterval(function () {
    if (!document.hidden) refreshDashboard();
  }, 20000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshDashboard();
  });
}

/* ── Moderator allowlist (broadcaster only) ─────────────────────────────── */

function renderModerators(entries, canEdit) {
  const list = document.getElementById('botModList');
  if (!list) return;

  if (!entries || entries.length === 0) {
    list.innerHTML = '<li class="bot-muted">Nobody yet — only you can use this panel.</li>';
    return;
  }

  list.innerHTML = entries.map(function (m) {
    const name = m.displayName || '(no name)';
    const added = m.addedAt ? new Date(m.addedAt).toLocaleDateString() : '';
    return '<li class="bot-mod-row">' +
      '<span class="bot-mod-name">' + escapeBotHtml(name) + '</span>' +
      '<span class="bot-mod-id">' + escapeBotHtml(String(m.userId)) + '</span>' +
      (added ? '<span class="bot-mod-added">added ' + escapeBotHtml(added) + '</span>' : '') +
      (canEdit ? '<button class="btn-secondary bot-mod-remove" data-user-id="' +
        escapeBotHtml(String(m.userId)) + '">Remove</button>' : '') +
      '</li>';
  }).join('');

  list.querySelectorAll('.bot-mod-remove').forEach(function (btn) {
    btn.addEventListener('click', function () {
      changeModerator('remove', btn.dataset.userId, '', btn);
    });
  });
}

async function loadModerators() {
  try {
    const res = await fetch('/api/admin/moderators', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    renderModerators(data.moderators, data.canEdit);
  } catch {
    /* leave the list as-is */
  }
}

async function changeModerator(action, userId, displayName, button) {
  if (action === 'remove' && !confirm('Remove this moderator? They lose panel access immediately.')) return;

  const original = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '...'; }

  try {
    const res = await fetch('/api/admin/moderators', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, userId: userId, displayName: displayName }),
    });
    const data = await res.json();

    if (data.success) {
      renderModerators(data.moderators, true);
      /* `changed: false` means the server accepted the request and did
         nothing — already on the list, or not on it. Saying "Added" there
         would be a lie about what happened. */
      showBotStatus(
        data.changed
          ? (action === 'add' ? 'Moderator added.' : 'Moderator removed.')
          : 'No change — ' + (data.note || 'already in that state') + '.',
        false
      );
      if (action === 'add') {
        document.getElementById('botModUserId').value = '';
        document.getElementById('botModName').value = '';
      }
    } else {
      showBotStatus(data.error || 'Could not update the moderator list.', true);
    }
  } catch {
    showBotStatus('Network error updating the moderator list.', true);
  }

  if (button) { button.disabled = false; button.textContent = original; }
}

function initModeratorPanel() {
  const section = document.getElementById('modSection');
  if (section) section.hidden = false;

  const addBtn = document.getElementById('botModAddBtn');
  const idInput = document.getElementById('botModUserId');
  const nameInput = document.getElementById('botModName');

  if (addBtn && idInput) {
    addBtn.addEventListener('click', function () {
      const userId = idInput.value.trim();
      if (!/^\d+$/.test(userId)) {
        showBotStatus('That needs to be a numeric Twitch user ID, not a username.', true);
        return;
      }
      changeModerator('add', userId, nameInput ? nameInput.value.trim() : '', addBtn);
    });
  }

  loadModerators();
}

/* ── Access ──────────────────────────────────────────────────────────────
   The page used to gate on `session.role !== 'broadcaster'`, which locked
   moderators out of a panel the server was already willing to serve them —
   the entire allowlist feature was unreachable from the UI.

   So the client no longer decides. It asks /api/bot/dashboard and renders
   whatever the server is prepared to answer. The cookie's role field still
   cannot be forged, but it is a snapshot from login: gating on it means
   somebody removed from the list keeps their panel until their session
   expires. Asking every load, and every poll, is what makes removal
   immediate — which is the promise the card itself makes.  */

function showBotDenied(message, offerLogin) {
  const denied = document.getElementById('botControlDenied');
  const deniedText = document.getElementById('botControlDeniedText');
  const loginBtn = document.getElementById('botControlLoginBtn');
  if (denied) denied.hidden = false;
  if (deniedText) deniedText.textContent = message;
  if (loginBtn) loginBtn.hidden = !offerLogin;
}

document.addEventListener('DOMContentLoaded', async function () {
  let res;
  try {
    res = await fetch('/api/bot/dashboard', { credentials: 'same-origin' });
  } catch {
    showBotDenied('Could not reach the server. Reload to try again.', false);
    return;
  }

  if (!res.ok) {
    /* getSession() is used only to choose the wording — never to decide
       access. The server already decided. */
    const session = typeof getSession === 'function' ? getSession() : null;
    if (!session) {
      showBotDenied('Log in with Twitch to access this page.', true);
    } else {
      let msg = 'This page is for the broadcaster and approved moderators.';
      try { const body = await res.json(); if (body && body.error) msg = body.error; } catch {}
      showBotDenied(msg, false);
    }
    return;
  }

  const data = await res.json();

  const panel = document.getElementById('botControlPanel');
  if (panel) panel.hidden = false;

  initBotControlPanel();
  if (data.isBroadcaster) initModeratorPanel();
});
