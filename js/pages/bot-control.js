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

async function loadBotActionLog() {
  try {
    const res = await fetch('/api/bot/trigger', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    renderBotActionFeed(data.log || []);
  } catch {
    /* leave feed as-is */
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
      await loadBotActionLog();
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
      await loadBotActionLog();
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

  loadBotActionLog();
  loadItemQueue();
  initGiveawayPanel();
}

document.addEventListener('DOMContentLoaded', function () {
  const session = getSession();
  const denied = document.getElementById('botControlDenied');
  const deniedText = document.getElementById('botControlDeniedText');
  const loginBtn = document.getElementById('botControlLoginBtn');

  if (!session || session.role !== 'broadcaster') {
    if (denied) denied.hidden = false;
    if (!session) {
      if (deniedText) deniedText.textContent = 'Log in as the broadcaster to access this page.';
      if (loginBtn) loginBtn.hidden = false;
    } else if (deniedText) {
      deniedText.textContent = 'This page is for the broadcaster only.';
    }
    return;
  }

  initBotControlPanel();
});
