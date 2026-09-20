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
        dropegg: 'Egg code dropped to chat.',
        announce: 'Announcement sent to chat.',
      };
      /* data.sent is false when Twitch accepted the request but refused to
         post — AutoMod, a link filter, follower-only mode. Saying "dropped to
         chat" then would be the same lie sendChatMessage used to tell. */
      if (data.sent === false) {
        showBotStatus('Code created, but Twitch did not post it to chat — check AutoMod and the link filter.', true);
      } else if (payload.action === 'drop' && data.codes && data.codes.length > 1) {
        /* Says how many actually went out, not how many were asked for. A
           pool that ran dry midway is the one thing worth knowing here, and
           reporting the request rather than the result would hide it. */
        var note = data.codes.length + ' codes dropped to chat.';
        if (data.short) note += ' Pool ran out ' + data.short + ' short.';
        showBotStatus(note, !!data.short);
      } else {
        showBotStatus(messages[payload.action] || 'Done.', false);
      }
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
let giveawayRarity = null;

/* ── THE REEL ───────────────────────────────────────────────────────────
   The wheel this replaced drew one segment per entrant and, at one point,
   sized them by entry count. Both were wrong for the draw that actually
   runs: pick-winner is a FLAT pick over this event's entrants, so every
   slice was the same size anyway, and a wheel of forty identical slivers
   is unreadable on a stream.

   A slot reel is the honest picture of a flat pick — names go past, one
   stops. The arithmetic is in js/giveaway-reel.js so it can be tested;
   what is left here is the DOM.

   The reel lands on the name the SERVER chose. It does not pick anything. */

/* A spun reel HOLDS. Once it lands on a name that name stays under the
   window until the draw is reset or the next one opens — the poll below
   would otherwise snap it back to the latest entrant a few seconds after
   the winner was announced, on a panel that is on screen. */
var reelHeld = false;

function reelRow(name, cls) {
  const row = document.createElement('div');
  row.className = 'giveaway-reel-row' + (cls ? ' ' + cls : '');
  row.textContent = name;
  return row;
}

function renderGiveawayReel(entrants) {
  const strip = document.getElementById('giveawayReelStrip');
  if (!strip || reelHeld) return;

  strip.style.transition = 'none';
  strip.style.transform = 'translateY(0)';
  strip.innerHTML = '';

  if (!entrants || entrants.length === 0) {
    strip.appendChild(reelRow('No entrants yet', 'empty'));
    return;
  }

  /* At rest the reel shows the most recent entrant, so a moderator can see
     redemptions arriving without spinning anything. */
  const latest = entrants[entrants.length - 1];
  strip.appendChild(reelRow(latest.username, 'idle'));
}

function spinGiveawayReelTo(entrants, winnerIndex) {
  const strip = document.getElementById('giveawayReelStrip');
  if (!strip || !window.PhamReel) return;

  const plan = window.PhamReel.strip(entrants, winnerIndex);
  if (!plan.names.length) return;

  strip.style.transition = 'none';
  strip.style.transform = 'translateY(0)';
  strip.innerHTML = '';
  plan.names.forEach(function (n, i) {
    strip.appendChild(reelRow(n, i === plan.landing ? 'winner' : ''));
  });

  reelHeld = true;
  /* Forced reflow: without it the browser coalesces the reset and the
     travel into one style change and the reel arrives with no animation. */
  void strip.offsetHeight;

  requestAnimationFrame(function () {
    strip.style.transition = 'transform 4s cubic-bezier(0.12, 0.8, 0.18, 1)';
    strip.style.transform = 'translateY(' + plan.offset + 'px)';
  });
}

function setGiveawayOpenUI(open, entrantCount, rarity) {
  giveawayIsOpen = open;
  if (rarity !== undefined) giveawayRarity = rarity;

  const statusEl = document.getElementById('giveawayStatus');
  const toggleBtn = document.getElementById('giveawayToggleBtn');
  const countEl = document.getElementById('giveawayEntrantCount');
  const raritySel = document.getElementById('giveawayRarity');

  if (statusEl) {
    statusEl.textContent = open
      ? (giveawayRarity ? giveawayRarity.toUpperCase() + ' entries open' : 'Entries Open')
      : 'Entries Closed';
    statusEl.className = 'giveaway-status' + (open ? ' open rarity-' + (giveawayRarity || 'common') : '');
  }
  if (toggleBtn) toggleBtn.textContent = open ? 'Close Entries' : 'Open Entries';
  /* Locked while a draw runs. Changing it mid-draw would change nothing on
     Twitch and everything about what the panel claims is happening. */
  if (raritySel) {
    raritySel.disabled = open;
    if (giveawayRarity) raritySel.value = giveawayRarity;
  }
  if (countEl) countEl.textContent = (entrantCount || 0) + (entrantCount === 1 ? ' entrant' : ' entrants');
}

function showGiveawayWinner(winner) {
  const panel = document.getElementById('giveawayWinnerPanel');
  const nameEl = document.getElementById('giveawayWinnerName');
  const rarityEl = document.getElementById('giveawayWinnerRarity');
  if (nameEl) nameEl.textContent = winner.username;
  if (rarityEl) {
    const r = winner.rarity || giveawayRarity || '';
    rarityEl.textContent = r ? '\u2014 ' + r.toUpperCase() + ' draw' : '';
    rarityEl.className = 'giveaway-winner-rarity rarity-' + (r || 'common');
  }
  if (panel) panel.hidden = false;
}

async function loadGiveawayState() {
  try {
    const res = await fetch('/api/bot/giveaway', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    setGiveawayOpenUI(data.open, data.entrantCount, data.rarity);
    renderGiveawayReel(data.entrants);
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
      body: JSON.stringify({
        action: 'toggle',
        open: !giveawayIsOpen,
        rarity: (document.getElementById('giveawayRarity') || {}).value,
      }),
    });
    const data = await res.json();
    if (data.success) {
      setGiveawayOpenUI(data.open, undefined, data.rarity);
      showBotStatus(
        data.open
          ? String(data.rarity || '').toUpperCase() + ' entries are open \u2014 the other reward is switched off.'
          : 'Giveaway entries are closed.',
        false
      );
      /* Named rather than swallowed: a reward that would not switch off is
         still redeemable, and the moderator is the only one who can see it. */
      if (data.strays && data.strays.length) {
        showBotStatus('Could not switch off: ' + data.strays.join(', ') + '. Disable it in the Twitch dashboard.', true);
      }
      if (data.open) { reelHeld = false; renderGiveawayReel([]); }
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
      spinGiveawayReelTo(data.entrants, data.winnerIndex);
      setTimeout(function () {
        showGiveawayWinner(Object.assign({ rarity: data.rarity }, data.winner));
      }, 4100);
    } else {
      showBotStatus(data.error || 'Could not pick a winner.', true);
    }
  } catch {
    showBotStatus('Network error picking a winner.', true);
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Spin'; }
}

async function sendGiveawayCode() {
  const btn = document.getElementById('giveawaySendCodeBtn');
  const tier = document.getElementById('giveawayCodeTier').value;
  const manualCode = document.getElementById('giveawayCodeManual').value.trim();

  /* No longer a precondition: leaving both blank now means "the rarity of
     the draw that was actually won", which is the right default and the one
     that cannot be got wrong under pressure. */

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
      /* The card on their giveaway page IS the delivery. A failed whisper is
         worth saying, but it is not a failure of the prize any more. */
      showBotStatus(
        String(data.rarity || '').toUpperCase() + ' code locked to ' + (data.winner ? data.winner.username : 'the winner') +
        ' \u2014 waiting on their giveaway page for 7 days.' +
        (data.whispered ? ' Whisper sent too.' : ' The whisper did not send; the page has it.'),
        false
      );
      await refreshDashboard();
    } else {
      showBotStatus(data.error || 'Could not send the code.', true);
    }
  } catch {
    showBotStatus('Network error sending the code.', true);
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Give Code to Winner'; }
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
    reelHeld = false;
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

  /* WATCH THE ENTRIES ARRIVE.
     This state was read once at page load and then only after a reset, so a
     moderator who opened entries watched the count sit at zero for the whole
     minute chat was redeeming. Five seconds while a draw is open and nothing
     at all when it is closed: this panel sits open beside a running stream,
     so an idle poll would be a cost paid all day for a feature used for two
     minutes a night. */
  setInterval(function () {
    if (document.hidden || !giveawayIsOpen || reelHeld) return;
    loadGiveawayState();
  }, 5000);

  loadGiveawayState();
  initOvMc();
  initOvBingo();
  initOvRaid();
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
    /* Distinguished from every failure above: this one means the request
       worked and the answer really is "none". Rooms are created by players
       at /games/mana-clash and expire, so an empty list is normal. */
    : '<option value="">No rooms open — someone has to create one first</option>';

  if (keep && rooms.some(function (r) { return r.code === keep; })) pick.value = keep;
}

/* WHY THIS REPORTS INSTEAD OF RETURNING.
   The first version swallowed every failure and left the dropdown as it
   found it — empty. A 404 because the service had not been restarted, a
   403 because the account is not a moderator, and a channel with no rooms
   were all one symptom: a blank control saying nothing. The whole point of
   this card is to tell somebody what is available, so the one thing it
   must never do is go quiet. */
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
    /* The route exists in the repo but not in the running process — the
       one failure a deploy causes, and the one a blank dropdown hid. */
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

/* Asks every open overlay to reload. The overlay polls the event feed once
   a second and reloads when the token changes, so this is as immediate as a
   right-click in OBS and can be done from a phone. */
async function reloadOverlay(btn) {
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
      /* Named as "within a second" rather than "done": the reload happens
         on the overlay's next poll, not in this response. */
      showBotStatus('Every open overlay will reload within a second.', false);
    } else {
      showBotStatus(d.error || 'Could not ask the overlay to reload.', true);
    }
  } catch {
    showBotStatus('Network error asking the overlay to reload.', true);
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Reload OBS Overlay'; }
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
   one game and offers the same show/hide switch the host has, for whoever
   is producing the stream. The current room code is read from the state,
   never typed. */

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
    /* The ordinary "nobody is hosting one right now" case. */
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

function initBotControlPanel() {
  document.querySelectorAll('.bot-drop-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var countEl = document.getElementById('botDropCount');
      var count = countEl ? Math.max(1, Math.min(10, parseInt(countEl.value, 10) || 1)) : 1;
      fireBotAction({ action: 'drop', rarity: btn.dataset.rarity, count: count }, btn);
    });
  });

  document.querySelectorAll('.bot-egg-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const mut = document.getElementById('botEggMutation');
      fireBotAction({ action: 'dropegg', rarity: btn.dataset.rarity, mutation: !!(mut && mut.checked) }, btn);
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
  initRotationPanel();

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

/* ── Rotating announcements ─────────────────────────────────────────────── */

function renderRotation(d) {
  const state = document.getElementById('botRotationState');
  const toggle = document.getElementById('botRotationToggle');
  const interval = document.getElementById('botRotationInterval');
  const next = document.getElementById('botRotationNext');
  const list = document.getElementById('botAnnounceList');
  if (!state || !list) return;

  state.textContent = d.enabled ? 'On' : 'Off';
  state.className = 'bot-rotation-state' + (d.enabled ? ' on' : '');
  if (toggle) toggle.textContent = d.enabled ? 'Turn Off' : 'Turn On';
  if (interval && document.activeElement !== interval) interval.value = d.intervalMinutes;

  if (next) {
    /* Says why nothing is coming, not just when. "Next in 12m" on a rotation
       with every message disabled would be a confident lie. */
    if (!d.enabled) next.textContent = '';
    else if (!d.activeCount) next.textContent = 'nothing active to post';
    else if (d.nextDueAt) {
      const mins = Math.max(0, Math.round((d.nextDueAt - Date.now()) / 60000));
      next.textContent = mins <= 0 ? 'due now (posts when live)' : 'next in ~' + mins + 'm';
    } else next.textContent = '';
  }

  if (!d.items || !d.items.length) {
    list.innerHTML = '<li class="bot-muted">No announcements yet.</li>';
    return;
  }

  list.innerHTML = d.items.map(function (it) {
    const off = it.enabled === false;
    return '<li class="bot-announce-item' + (off ? ' is-off' : '') + '">' +
      '<span class="bot-announce-text">' + escapeBotHtml(it.text) + '</span>' +
      '<span class="bot-announce-by">' + escapeBotHtml(it.addedBy || '') + '</span>' +
      '<button class="btn-secondary bot-ann-now"    data-id="' + escapeBotHtml(it.id) + '">Post now</button>' +
      '<button class="btn-secondary bot-ann-toggle" data-id="' + escapeBotHtml(it.id) + '">' + (off ? 'Enable' : 'Disable') + '</button>' +
      '<button class="btn-secondary bot-ann-remove" data-id="' + escapeBotHtml(it.id) + '">Remove</button>' +
      '</li>';
  }).join('');

  list.querySelectorAll('.bot-ann-now').forEach(function (b) {
    b.addEventListener('click', function () { rotationAction({ action: 'post-now', id: b.dataset.id }, b); });
  });
  list.querySelectorAll('.bot-ann-toggle').forEach(function (b) {
    b.addEventListener('click', function () { rotationAction({ action: 'toggle-item', id: b.dataset.id }, b); });
  });
  list.querySelectorAll('.bot-ann-remove').forEach(function (b) {
    b.addEventListener('click', function () {
      if (confirm('Remove this announcement?')) rotationAction({ action: 'remove', id: b.dataset.id }, b);
    });
  });
}

async function loadRotation() {
  try {
    const res = await fetch('/api/bot/announcements', { credentials: 'same-origin' });
    if (!res.ok) return;
    renderRotation(await res.json());
  } catch { /* leave the last render */ }
}

async function rotationAction(payload, button) {
  const original = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '...'; }
  try {
    const res = await fetch('/api/bot/announcements', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.success) {
      if (payload.action === 'post-now') {
        showBotStatus(data.sent === false
          ? 'Posted, but Twitch did not show it — check AutoMod and the link filter.'
          : 'Announcement sent to chat.', data.sent === false);
        await refreshDashboard();
      } else {
        renderRotation(data);
      }
      const box = document.getElementById('botRotationText');
      if (payload.action === 'add' && box) box.value = '';
    } else {
      showBotStatus(data.error || 'Could not update the rotation.', true);
    }
  } catch {
    showBotStatus('Network error updating the rotation.', true);
  }
  if (button) { button.disabled = false; button.textContent = original; }
  if (payload.action !== 'post-now') await loadRotation();
}

function initRotationPanel() {
  const toggle = document.getElementById('botRotationToggle');
  const save = document.getElementById('botRotationSave');
  const add = document.getElementById('botRotationAdd');
  const text = document.getElementById('botRotationText');
  const interval = document.getElementById('botRotationInterval');

  if (toggle) toggle.addEventListener('click', function () { rotationAction({ action: 'toggle' }, toggle); });
  if (save && interval) {
    save.addEventListener('click', function () {
      rotationAction({ action: 'set-interval', intervalMinutes: parseInt(interval.value, 10) }, save);
    });
  }
  if (add && text) {
    add.addEventListener('click', function () {
      const v = text.value.trim();
      if (!v) { showBotStatus('Type a message before adding.', true); return; }
      rotationAction({ action: 'add', text: v }, add);
    });
  }

  loadRotation();
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
      /* Falls back to leaving it selected rather than claiming success —
         clipboard access is blocked in plenty of contexts, and "Copied!" on
         an empty clipboard is worse than no feedback. */
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

/* ── Moderator allowlist (broadcaster only) ─────────────────────────────── */

function renderModerators(entries, canEdit) {
  const list = document.getElementById('botModList');
  if (!list) return;

  if (!entries || entries.length === 0) {
    list.innerHTML = '<li class="bot-muted">Nobody yet — only you can use this panel.</li>';
    return;
  }

  list.innerHTML = entries.map(function (m) {
    /* The login as well as the display name, when they differ. Twitch
       display names are only a capitalisation of the login for most
       people, so showing both always would be noise — but for anyone with
       a localised or restyled name, the login is the half you recognise. */
    const name = m.displayName || m.login || '(no name)';
    const alias = (m.login && m.displayName && m.login.toLowerCase() !== m.displayName.toLowerCase())
      ? ' @' + m.login
      : '';
    const added = m.addedAt ? new Date(m.addedAt).toLocaleDateString() : '';
    return '<li class="bot-mod-row">' +
      '<span class="bot-mod-name">' + escapeBotHtml(name + alias) + '</span>' +
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

/* `nameOrId` is a username for an add and an id for a remove. The server
   resolves a name through Helix and stores what it resolved to, so nobody
   has to go and find a numeric id — which is what the old panel demanded,
   with a link to a third-party converter in its own hint. */
async function changeModerator(action, userId, displayName, button) {
  if (action === 'remove' && !confirm('Remove this moderator? They lose panel access immediately.')) return;

  const original = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '...'; }

  try {
    const res = await fetch('/api/admin/moderators', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      /* `name` for an add, `userId` for a remove. The server accepts a
         name or an id on either field, but sending the right one keeps the
         request readable in a log. */
      body: JSON.stringify(action === 'add'
        ? { action: 'add', name: userId }
        : { action: 'remove', userId: userId }),
    });
    const data = await res.json();

    if (data.success) {
      renderModerators(data.moderators, true);
      /* `changed: false` means the server accepted the request and did
         nothing — already on the list, or not on it. Saying "Added" there
         would be a lie about what happened. */
      /* NAMES WHO. "Moderator added" is no use for spotting that a typo
         resolved to a real but different account; "Added SoyTortuga" is. */
      const who = data.account
        ? data.account.displayName + ' (' + data.account.userId + ')'
        : 'them';
      showBotStatus(
        data.changed
          ? (action === 'add' ? 'Added ' + who + '.' : 'Moderator removed.')
          : 'No change — ' + (data.note || 'already in that state') + '.',
        false
      );
      if (action === 'add') {
        const nameInput = document.getElementById('botModName');
        if (nameInput) nameInput.value = '';
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
  const nameInput = document.getElementById('botModName');

  function add() {
    if (!nameInput) return;
    const name = nameInput.value.trim().replace(/^@/, '');
    if (!name) { showBotStatus('Enter a Twitch username first.', true); return; }
    /* No format check here beyond empty. The server asks Twitch, and
       Twitch's answer is the only one that matters — a guess in the page
       would just be a second, worse rule to keep in step. */
    changeModerator('add', name, '', addBtn);
  }

  if (addBtn) addBtn.addEventListener('click', add);
  /* Typing a name and pressing return is the whole interaction. */
  if (nameInput) nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
  });

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
  if (data.isBroadcaster) {
    initModeratorPanel();
    initOverlayPanel(data.overlayUrl);
  }
});
