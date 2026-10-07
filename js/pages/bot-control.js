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
      body = '<b>' + escapeBotHtml(entry.username || 'unknown') + '</b> picked as ' +
        (entry.month ? escapeBotHtml(entry.month) + ' monthly' : 'giveaway') + ' winner by ' + escapeBotHtml(entry.actor || 'unknown') +
        (entry.reroll ? ' (re-roll, replaced ' + escapeBotHtml(entry.previous || 'unknown') + (entry.forced ? ' after their code was sent — FORCED' : '') + ')' : '');
    } else if (entry.type === 'giveaway-code') {
      tag = 'Prize';
      body = 'Prize code whispered to <b>' + escapeBotHtml(entry.username || 'unknown') + '</b> by ' + escapeBotHtml(entry.actor || 'unknown') + failedNote;
    } else if (entry.type === 'prediction-create' || entry.type === 'prediction-resolve' || entry.type === 'prediction-cancel') {
      tag = 'Prediction';
      body = escapeBotHtml(entry.message || 'prediction updated') + ' — by ' + escapeBotHtml(entry.actor || 'unknown');
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

/* Twitch's revocation reasons, in words a broadcaster can act on. */
const REVOKE_REASONS = {
  authorization_revoked: 'the authorizing account removed the app or a permission',
  user_removed: 'the account no longer exists',
  notification_failures_exceeded: 'too many deliveries to the site failed',
  version_removed: 'Twitch retired this subscription version',
  moderator_removed: 'the bot lost moderator status',
};

function renderRevoked(revoked) {
  const box = document.getElementById('botRevoked');
  if (!box) return;
  const list = Array.isArray(revoked) ? revoked : [];
  box.innerHTML = list.map(function (r) {
    const why = REVOKE_REASONS[r.reason] || r.reason || 'unknown reason';
    const when = r.at ? new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    return '<div class="bot-status-msg error" role="alert" style="font-size:14px">' +
      '<b>' + escapeBotHtml(r.type) + '</b> revoked — re-run Create Subscriptions on the bot setup page. ' +
      '(' + escapeBotHtml(why) + (when ? ', ' + escapeBotHtml(when) : '') + ')' +
      '</div>';
  }).join('');
}

function renderWarnings(data) {
  const box = document.getElementById('botWarnings');
  if (!box) return;
  renderRevoked(data.subscriptions && data.subscriptions.revoked);
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

function renderSubs(subs) {
  var grid = document.getElementById('botSubsGrid');
  if (!grid) return;
  if (!subs) { grid.innerHTML = '<p class="bot-muted">Subscription status unavailable.</p>'; return; }
  var revokedRows = subs.revokedRows || {};
  var rows = [
    ['Subscriptions', subs.subs, revokedRows.subs],
    ['Gift subs', subs.giftSubs, revokedRows.giftSubs],
    ['Raids', subs.raids, revokedRows.raids],
    ['Channel-point redemptions', subs.redemptions, revokedRows.redemptions],
    ['Hype train', subs.hypeTrain, revokedRows.hypeTrain],
    ['Chat commands', subs.chat, revokedRows.chat],
    /* Scope-gated features — inert until the broadcaster grants the extra OAuth
       scope each needs, so surfacing their status answers "why isn't X firing". */
    ['Follows', subs.follow, revokedRows.follow],
    ['Cheers', subs.cheer, revokedRows.cheer],
    ['Predictions', subs.predictions, revokedRows.predictions],
    ['Ad breaks', subs.adBreak, revokedRows.adBreak],
    ['Bits / Power-ups', subs.bits, revokedRows.bits],
    ['Category changes', subs.category, revokedRows.category],
  ];
  grid.innerHTML = rows.map(function (r) {
    /* Registered is a snapshot taken when the subscriptions were created;
       a revocation Twitch sent since outranks it. */
    var ok = !!r[1] && !r[2];
    var note = r[2] ? 'revoked — re-run Create Subscriptions' : (r[1] ? 'active' : 'not registered');
    return '<div class="bot-sub-row ' + (ok ? 'ok' : 'missing') + '">' +
      '<span class="bot-sub-state">' + (ok ? '✅' : '❌') + '</span>' +
      '<span class="bot-sub-name">' + escapeBotHtml(r[0]) + '</span>' +
      '<span class="bot-sub-note">' + note + '</span>' +
      '</div>';
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
  if (!c || (!c.live && !c.count && !c.pending)) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const pendingNote = c.pending
    ? '<p class="bot-muted">' + c.pending + ' more waiting for Twitch to confirm the stream — they keep their place.</p>'
    : '';

  if (!c.count) {
    box.innerHTML = '<p class="bot-muted">' +
      (c.live ? 'Live — nobody has checked in yet this stream.' : 'No check-ins.') + '</p>' + pendingNote;
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
    '<ul class="bot-checkin-list">' + rows + '</ul>' + pendingNote;
}

async function refreshDashboard() {
  try {
    const res = await fetch('/api/bot/dashboard', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();

    renderWarnings(data);
    renderSubs(data.subscriptions);
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
        dropegg: 'Egg code dropped to chat.',
        announce: 'Announcement sent to chat.',
        'checkin-alert': 'Pham Check-In alert sent to the overlay.',
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
    } else {
      showBotStatus(data.error || 'Action failed.', true);
    }
  } catch {
    showBotStatus('Network error — action may not have been sent.', true);
  }

  if (button) { button.disabled = false; button.textContent = originalText; }
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
    var spinMs = window.PhamReel.SPIN_MS;
    strip.style.transition = 'transform ' + (spinMs / 1000) + 's cubic-bezier(0.12, 0.8, 0.18, 1)';
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
    /* The monthly-ledger draw is a separate event with one record PER MONTH:
       this month's winner, and last month's while it is still in its grace
       window (or still waiting on its code). */
    const grace = data.monthlyGrace || null;
    monthlyMonths.current = grace ? grace.current : (data.monthly && data.monthly.month) || null;
    monthlyMonths.prev = grace ? grace.month : null;
    renderMonthlyWinner('current', data.monthlyWinner);
    renderMonthlyWinner('prev', data.monthlyPrevWinner);
    renderMonthlyPrev(data.monthlyPrev, grace);
  } catch {
    /* leave panel as-is */
  }
}

/* ── Monthly ledger draw ──────────────────────
   A separate event from the Big Prize spin above: WEIGHTED by entry count,
   drawn over the whole month's ledger, one winner record per month. The grand
   reel plays on the OBS overlay; this panel just runs the draw and hands out
   the locked prize code, mirroring the Big Prize send-code flow. Every send
   names its month, so a code always goes to the winner of the month drawn. */
const monthlyMonths = { current: null, prev: null };
const MONTHLY_IDS = {
  current: {
    panel: 'monthlyWinnerPanel', name: 'monthlyWinnerName', meta: 'monthlyWinnerMeta', form: 'monthlyCodeForm',
    tier: 'monthlyCodeTier', manual: 'monthlyCodeManual', send: 'monthlySendCodeBtn', draw: 'monthlyDrawBtn',
  },
  prev: {
    panel: 'monthlyPrevWinnerPanel', name: 'monthlyPrevWinnerName', meta: 'monthlyPrevWinnerMeta', form: 'monthlyPrevCodeForm',
    tier: 'monthlyPrevCodeTier', manual: 'monthlyPrevCodeManual', send: 'monthlyPrevSendCodeBtn', draw: 'monthlyDrawPrevBtn',
  },
};

function renderMonthlyWinner(which, w) {
  const ids = MONTHLY_IDS[which];
  const panel = document.getElementById(ids.panel);
  if (!panel) return;
  if (!w) { panel.hidden = true; panel.dataset.winner = ''; return; }
  const nameEl = document.getElementById(ids.name);
  const metaEl = document.getElementById(ids.meta);
  const form = document.getElementById(ids.form);
  if (nameEl) nameEl.textContent = w.username || '';
  if (metaEl) {
    const bits = [];
    if (w.month) bits.push(w.month);
    if (w.entries != null) bits.push(w.entries + (w.entries === 1 ? ' entry' : ' entries'));
    if (w.totalEntries != null) bits.push('pool ' + w.totalEntries);
    if (w.rerolls) bits.push('re-rolled ' + w.rerolls + 'x');
    bits.push(w.sent ? 'code sent' : 'code not sent yet');
    metaEl.textContent = '— ' + bits.join(' • ');
    metaEl.className = 'giveaway-winner-rarity rarity-mythic';
  }
  /* Once the code is out the form goes away: the server refuses a second
     send anyway, and a visible button invites the attempt. */
  if (form) form.hidden = !!w.sent;
  panel.dataset.winner = w.username || '';
  panel.dataset.sent = w.sent ? '1' : '';
  panel.hidden = false;
}

/* "Draw Last Month" exists only during the grace window (days 1..7 of the
   new month, Pacific) and only when that month had entrants. The server is
   the authority — it refuses the draw outside the window — this mirrors it. */
function renderMonthlyPrev(p, grace) {
  const btn = document.getElementById('monthlyDrawPrevBtn');
  const note = document.getElementById('monthlyPrevNote');
  const open = !!(grace && grace.open);
  const has = open && p && p.totalPeople > 0 && p.totalEntries > 0;
  if (btn) {
    btn.hidden = !has;
    btn.disabled = !has;
    if (has) btn.textContent = 'Draw Last Month (' + p.month + ')';
  }
  if (note) {
    note.hidden = !has;
    if (has) note.textContent = 'Last month (' + p.month + '): ' + p.totalEntries +
      (p.totalEntries === 1 ? ' entry' : ' entries') + ' across ' + p.totalPeople +
      (p.totalPeople === 1 ? ' person' : ' people') + ' — drawable through day ' + grace.lastDay +
      ' (today is day ' + grace.day + ').';
  }
}

/* which = 'current' (primary button) or 'prev' (the grace-window button).
   Re-rolling an unsent winner asks first; a winner whose code already went
   out is refused by the server, and only the broadcaster can force past it. */
async function drawMonthlyWinnerAction(which, force) {
  const ids = MONTHLY_IDS[which];
  const month = which === 'prev' ? monthlyMonths.prev : null;
  if (which === 'prev' && !month) return;
  const panel = document.getElementById(ids.panel);
  const shown = panel && !panel.hidden ? panel.dataset.winner : '';
  if (!force && shown && !(panel.dataset.sent) &&
      !confirm('Re-roll ' + (month || monthlyMonths.current || 'this month') + '? ' + shown + ' has not been sent a code yet and will be replaced.')) {
    return;
  }

  const btn = document.getElementById(ids.draw);
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Drawing...'; }
  let retryForced = false;
  try {
    const res = await fetch('/api/bot/giveaway', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'draw-monthly', month: month || undefined, force: force === true || undefined }),
    });
    const data = await res.json();
    if (data.success) {
      await loadGiveawayState();
      showBotStatus(
        'Monthly winner drawn for ' + data.month + ': ' + data.winner.username + ' (' + data.winner.entries +
        ' entries, from ' + data.totalEntries + ' across ' + data.totalPeople +
        (data.totalPeople === 1 ? ' person' : ' people') + '). The reel is spinning on the overlay.',
        false
      );
    } else if (res.status === 409 && data.alreadySent && !force) {
      retryForced = confirm(data.error + '\n\nForce a re-draw anyway? This gives a SECOND prize and only the broadcaster can do it.');
      if (!retryForced) showBotStatus(data.error, true);
    } else {
      showBotStatus(data.error || 'Could not draw a monthly winner.', true);
      if (data.graceClosed) await loadGiveawayState();
    }
  } catch {
    showBotStatus('Network error drawing the monthly winner.', true);
  }
  if (btn) { btn.disabled = false; btn.textContent = label; }
  if (retryForced) await drawMonthlyWinnerAction(which, true);
}

async function sendMonthlyCode(which) {
  const ids = MONTHLY_IDS[which];
  const month = monthlyMonths[which];
  const btn = document.getElementById(ids.send);
  const tier = document.getElementById(ids.tier).value;
  const manualCode = document.getElementById(ids.manual).value.trim();
  if (!month) { showBotStatus('Reload the panel — the month for this winner is unknown.', true); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  try {
    const res = await fetch('/api/bot/giveaway', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send-monthly-code', month: month, rarity: tier || undefined, code: manualCode || undefined }),
    });
    const data = await res.json();
    if (data.success) {
      showBotStatus(
        String(data.rarity || '').toUpperCase() + ' code for ' + (data.month || month) + ' locked to ' +
        (data.winner ? data.winner.username : 'the winner') + ' — waiting on their giveaway page for 7 days.' +
        (data.whispered ? ' Whisper sent too.' : ' The whisper did not send; the page has it.'),
        false
      );
      await loadGiveawayState();
    } else {
      showBotStatus(data.error || 'Could not send the code.', true);
    }
  } catch {
    showBotStatus('Network error sending the code.', true);
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Give Code to Winner'; }
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
      }, window.PhamReel.SPIN_MS + 100);
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

  ['current', 'prev'].forEach(function (which) {
    const drawBtn = document.getElementById(MONTHLY_IDS[which].draw);
    const sendBtnM = document.getElementById(MONTHLY_IDS[which].send);
    if (drawBtn) drawBtn.addEventListener('click', function () { drawMonthlyWinnerAction(which); });
    if (sendBtnM) sendBtnM.addEventListener('click', function () { sendMonthlyCode(which); });
  });

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
  initPredictionPanel();
}

/* ── Channel point predictions ──────────────────────────────────────────
   Mods run these; the endpoint drives them with the broadcaster token. The
   card shows one of three faces — a create form, the live prediction with its
   running totals, or an "authorization needed" note when the broadcaster has
   not granted the scope. It polls only while a prediction is live, so an idle
   panel open beside a stream is not hammering Twitch. */

var predictionActive = false;
var PRED_MAX_OUTCOMES = 10;

function showPredictionFace(face, message) {
  var faces = { inert: 'predictionInert', create: 'predictionCreate', live: 'predictionLive' };
  Object.keys(faces).forEach(function (k) {
    var el = document.getElementById(faces[k]);
    if (el) el.hidden = (k !== face);
  });
  if (face === 'inert') {
    var t = document.getElementById('predictionInertText');
    if (t) t.textContent = message || 'Predictions are not authorized yet.';
  }
}

function renderPredictionLive(p) {
  var titleEl = document.getElementById('predictionLiveTitle');
  var stateEl = document.getElementById('predictionState');
  var list = document.getElementById('predictionOutcomeList');
  var lockBtn = document.getElementById('predictionLockBtn');
  var cancelBtn = document.getElementById('predictionCancelBtn');
  var resolveHint = document.getElementById('predictionResolveHint');
  if (!list) return;

  if (titleEl) titleEl.textContent = p.title || '';
  var active = p.status === 'ACTIVE';
  var locked = p.status === 'LOCKED';
  if (stateEl) {
    stateEl.textContent = active ? 'Entries open' : (locked ? 'Locked' : (p.status || ''));
    stateEl.className = 'giveaway-status' + (active ? ' open' : '');
  }

  var totalPoints = (p.outcomes || []).reduce(function (s, o) { return s + (o.channelPoints || 0); }, 0);

  list.innerHTML = (p.outcomes || []).map(function (o) {
    var pct = totalPoints > 0 ? Math.round((o.channelPoints / totalPoints) * 100) : 0;
    /* While ACTIVE or LOCKED a winner can be picked. Twitch pays out on
       RESOLVED, so the button is here for both states. */
    var resolveBtn = (active || locked)
      ? '<button class="btn-secondary pred-resolve" data-outcome="' + escapeBotHtml(o.id) + '">Resolve — pick this</button>'
      : '';
    return '<li class="pred-outcome-row">' +
      '<div class="pred-outcome-top">' +
      '<span class="pred-outcome-name">' + escapeBotHtml(o.title) + '</span>' +
      '<span class="pred-outcome-nums">' + (o.channelPoints || 0).toLocaleString() + ' pts · ' +
      (o.users || 0) + (o.users === 1 ? ' voter' : ' voters') + ' · ' + pct + '%</span>' +
      '</div>' +
      '<span class="pred-outcome-bar"><i style="width:' + pct + '%"></i></span>' +
      resolveBtn +
      '</li>';
  }).join('');

  list.querySelectorAll('.pred-resolve').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!confirm('Resolve the prediction to this outcome? Winners are paid out and it cannot be undone.')) return;
      predictionAction({ action: 'resolve', id: p.id, winningOutcomeId: b.dataset.outcome }, b);
    });
  });

  if (lockBtn) {
    lockBtn.hidden = !active;
    lockBtn.onclick = function () { predictionAction({ action: 'lock', id: p.id }, lockBtn); };
  }
  if (cancelBtn) {
    cancelBtn.onclick = function () {
      if (!confirm('Cancel the prediction? All channel points are refunded.')) return;
      predictionAction({ action: 'cancel', id: p.id }, cancelBtn);
    };
  }
  if (resolveHint) resolveHint.hidden = false;
}

function applyPredictionState(data) {
  if (data && data.authorized === false) {
    predictionActive = false;
    showPredictionFace('inert', data.error);
    return;
  }
  var p = data && data.prediction;
  if (p && (p.status === 'ACTIVE' || p.status === 'LOCKED')) {
    predictionActive = true;
    showPredictionFace('live');
    renderPredictionLive(p);
  } else {
    predictionActive = false;
    showPredictionFace('create');
  }
}

async function loadPredictionStatus() {
  try {
    var res = await fetch('/api/bot/predictions', { credentials: 'same-origin', cache: 'no-store' });
    var data = await res.json().catch(function () { return {}; });
    /* A 400 carrying authorized:false is the inert state, not a failure — it
       is the broadcaster not having granted the scope yet. */
    if (!res.ok && !(data && data.authorized === false)) {
      showPredictionFace('create');
      return;
    }
    applyPredictionState(data);
  } catch {
    /* leave the last face on screen */
  }
}

async function predictionAction(payload, button) {
  var original = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '...'; }
  try {
    var res = await fetch('/api/bot/predictions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = await res.json().catch(function () { return {}; });
    if (data.success) {
      var msgs = {
        create: 'Prediction started — chat can vote now.',
        lock: 'Prediction locked — voting is closed.',
        resolve: 'Prediction resolved — winners paid out.',
        cancel: 'Prediction canceled — points refunded.',
      };
      showBotStatus(msgs[payload.action] || 'Done.', false);
      applyPredictionState(data);
      await refreshDashboard();
    } else if (data.authorized === false) {
      showPredictionFace('inert', data.error);
      showBotStatus(data.error || 'Predictions are not authorized yet.', true);
    } else {
      showBotStatus(data.error || 'Could not update the prediction.', true);
    }
  } catch {
    showBotStatus('Network error updating the prediction.', true);
  }
  if (button) { button.disabled = false; button.textContent = original; }
}

function startPrediction(button) {
  var titleEl = document.getElementById('predictionTitle');
  var windowEl = document.getElementById('predictionWindow');
  var inputs = document.querySelectorAll('#predictionOutcomes .pred-outcome-input');
  var title = titleEl ? titleEl.value.trim() : '';
  if (!title) { showBotStatus('Give the prediction a title first.', true); return; }

  var outcomes = [];
  inputs.forEach(function (i) { var v = i.value.trim(); if (v) outcomes.push(v); });
  if (outcomes.length < 2) { showBotStatus('Add at least two outcomes.', true); return; }

  var window = parseInt(windowEl && windowEl.value, 10) || 120;
  predictionAction({ action: 'create', title: title, outcomes: outcomes, window: window }, button);
}

function initPredictionPanel() {
  var section = document.getElementById('predictionSection');
  if (!section) return;

  var addBtn = document.getElementById('predictionAddOutcome');
  var outcomes = document.getElementById('predictionOutcomes');
  if (addBtn && outcomes) {
    addBtn.addEventListener('click', function () {
      var count = outcomes.querySelectorAll('.pred-outcome-input').length;
      if (count >= PRED_MAX_OUTCOMES) { showBotStatus('A prediction allows at most 10 outcomes.', true); return; }
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'pred-outcome-input';
      input.maxLength = 25;
      input.placeholder = 'Outcome ' + (count + 1);
      outcomes.appendChild(input);
      if (count + 1 >= PRED_MAX_OUTCOMES) addBtn.disabled = true;
    });
  }

  var startBtn = document.getElementById('predictionStartBtn');
  if (startBtn) startBtn.addEventListener('click', function () { startPrediction(startBtn); });

  /* Poll only while a prediction is live and the tab is visible — an idle card
     showing the create form does not need to talk to Twitch every few
     seconds. */
  setInterval(function () {
    if (document.hidden || !predictionActive) return;
    loadPredictionStatus();
  }, 5000);

  loadPredictionStatus();
}


/* ── Mythic needs a second click ─────────────────────────────────────────
   The top tier sits one button-width from Rare, and a mythic code is the
   prize the whole month builds toward — a slip should cost a click, not a
   code. Built into the page rather than window.confirm(), which some
   embedded browsers (OBS docks among them) silently answer false. The
   count is read when the confirm opens and shown in it, so what is
   confirmed is exactly what fires; the strip times out on its own. */
var mythicConfirmTimer = null;

function closeMythicConfirm() {
  var box = document.getElementById('botMythicConfirm');
  if (box) box.hidden = true;
  if (mythicConfirmTimer) { clearTimeout(mythicConfirmTimer); mythicConfirmTimer = null; }
}

function openMythicConfirm(count, sourceBtn) {
  var box = document.getElementById('botMythicConfirm');
  var text = document.getElementById('botMythicConfirmText');
  var go = document.getElementById('botMythicConfirmGo');
  if (!box || !text || !go) {
    fireBotAction({ action: 'drop', rarity: 'mythic', count: count }, sourceBtn);
    return;
  }
  text.textContent = 'Drop ' + count + ' Mythic code' + (count === 1 ? '' : 's') +
    ' to chat? Mythic is the top prize tier.';
  go.dataset.count = String(count);
  box.hidden = false;
  go.focus();
  if (mythicConfirmTimer) clearTimeout(mythicConfirmTimer);
  mythicConfirmTimer = setTimeout(closeMythicConfirm, 15000);
}

function readDropCount() {
  var countEl = document.getElementById('botDropCount');
  return countEl ? Math.max(1, Math.min(10, parseInt(countEl.value, 10) || 1)) : 1;
}

function initBotControlPanel() {
  document.querySelectorAll('.bot-drop-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var count = readDropCount();
      if (btn.dataset.rarity === 'mythic') {
        openMythicConfirm(count, btn);
        return;
      }
      closeMythicConfirm();
      fireBotAction({ action: 'drop', rarity: btn.dataset.rarity, count: count }, btn);
    });
  });

  var mythicGo = document.getElementById('botMythicConfirmGo');
  var mythicCancel = document.getElementById('botMythicConfirmCancel');
  if (mythicGo) {
    mythicGo.addEventListener('click', function () {
      var count = Math.max(1, Math.min(10, parseInt(mythicGo.dataset.count, 10) || 1));
      closeMythicConfirm();
      fireBotAction({ action: 'drop', rarity: 'mythic', count: count },
        document.querySelector('.bot-drop-btn[data-rarity="mythic"]'));
    });
  }
  if (mythicCancel) mythicCancel.addEventListener('click', closeMythicConfirm);

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
  }
});
