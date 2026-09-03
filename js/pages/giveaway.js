/* ══════════════════════════════════════════
   GIVEAWAY ENTRY CODES
   Show entry code cards with copy-to-clipboard
   ══════════════════════════════════════════ */

let giveawayEntries = [];

async function loadGiveawayEntries() {
  const container = document.getElementById('bonusEntriesPanel');
  if (!container) return;

  const session = getSession();
  if (!session) {
    container.innerHTML = `
      <div class="entries-login">
        <p>Log in with Twitch to see your bonus entry codes.</p>
        <button class="btn-primary" onclick="loginWithTwitch()">Log In with Twitch</button>
      </div>`;
    container.closest('.bonus-entries-section').style.display = '';
    return;
  }

  try {
    const res = await fetch('/api/inventory?game=giveaway');
    if (!res.ok) throw new Error();
    const data = await res.json();
    giveawayEntries = (data.items || []).filter(i => i.type === 'entry-code' && i.meta && i.meta.code);
  } catch {
    giveawayEntries = [];
  }

  renderEntries(container);
  container.closest('.bonus-entries-section').style.display = '';
}

function renderEntries(container) {
  if (giveawayEntries.length === 0) {
    container.innerHTML = `
      <div class="entries-empty">
        <p>No bonus entry codes yet.</p>
        <p class="entries-hint">Earn them through <a href="/community-stats.html">Phamily Time</a> rewards!</p>
      </div>`;
    return;
  }

  const totalEntries = giveawayEntries.reduce((s, i) => s + (i.meta.entries || 0), 0);

  let html = `
    <div class="entries-header">
      <span class="entries-total">${totalEntries} bonus entries</span>
      <span class="entries-hint">Click a card to reveal your code, then paste it into the giveaway widget.</span>
    </div>
    <div class="entry-cards">`;

  for (let idx = 0; idx < giveawayEntries.length; idx++) {
    const item = giveawayEntries[idx];
    const rarity = item.rarity || 'common';
    const entries = item.meta.entries || 0;

    html += `
      <div class="entry-card rarity-${rarity}" onclick="showEntryCode(${idx})">
        <div class="entry-card-rarity">${rarity}</div>
        <div class="entry-card-value">&times;${entries}</div>
        <div class="entry-card-label">entries</div>
        <div class="entry-card-name">${esc(item.name || 'Giveaway Entries')}</div>
      </div>`;
  }

  html += '</div>';
  container.innerHTML = html;
}

function showEntryCode(idx) {
  const item = giveawayEntries[idx];
  if (!item || !item.meta || !item.meta.code) return;

  closeEntryPopover();

  const card = document.querySelectorAll('.entry-card')[idx];
  if (!card) return;

  const popover = document.createElement('div');
  popover.className = 'entry-popover';
  popover.id = 'entryPopover';
  popover.innerHTML = `
    <div class="entry-popover-header">
      <span class="entry-popover-rarity rarity-${item.rarity || 'common'}">${item.rarity || 'common'}</span>
      <span class="entry-popover-entries">&times;${item.meta.entries || 0} entries</span>
    </div>
    <div class="entry-popover-code" id="entryCodeText">${item.meta.code}</div>
    <button class="btn-primary entry-copy-btn" onclick="copyEntryCode(event)">Copy Code</button>
    <div class="entry-popover-hint">Paste this code into the giveaway widget above</div>
  `;

  card.style.position = 'relative';
  card.appendChild(popover);

  setTimeout(() => {
    document.addEventListener('click', outsideClickHandler);
  }, 10);
}

function copyEntryCode(e) {
  e.stopPropagation();
  const codeEl = document.getElementById('entryCodeText');
  if (!codeEl) return;

  navigator.clipboard.writeText(codeEl.textContent).then(() => {
    const btn = e.target;
    btn.textContent = 'Copied!';
    btn.style.background = 'var(--green)';
    setTimeout(() => {
      btn.textContent = 'Copy Code';
      btn.style.background = '';
    }, 2000);
  }).catch(() => {});
}

function closeEntryPopover() {
  const existing = document.getElementById('entryPopover');
  if (existing) existing.remove();
  document.removeEventListener('click', outsideClickHandler);
}

function outsideClickHandler(e) {
  const popover = document.getElementById('entryPopover');
  if (popover && !popover.contains(e.target)) {
    closeEntryPopover();
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ══════════════════════════════════════════
   HYPE TRAIN CODE DROPS
   Live codes that expire after 5 minutes
   ══════════════════════════════════════════ */

let dropPollTimer = null;

function loadHypeTrainDrops() {
  fetch('/api/hype-train?action=drops')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      renderDrops(data && data.drops ? data.drops : []);
    })
    .catch(function () { renderDrops([]); });
}

function renderDrops(drops) {
  var section = document.getElementById('hypeDropsSection');
  var container = document.getElementById('hypeDropsPanel');
  if (!section || !container) return;

  var now = Date.now();
  var active = drops.filter(function (d) { return d.expiresAt > now; });

  if (active.length === 0) {
    section.style.display = 'none';
    if (dropPollTimer) { clearInterval(dropPollTimer); dropPollTimer = null; }
    return;
  }

  section.style.display = '';

  var html = '<div class="hype-drops-header">' +
    '<span class="hype-drops-icon">🚂</span>' +
    '<span class="hype-drops-title">Hype Train Code Drops</span>' +
    '<span class="hype-drops-hint">Grab a code and paste it into the giveaway widget above — they expire!</span>' +
    '</div><div class="hype-drops-grid">';

  for (var i = 0; i < active.length; i++) {
    var drop = active[i];
    var secsLeft = Math.max(0, Math.ceil((drop.expiresAt - now) / 1000));
    var mins = Math.floor(secsLeft / 60);
    var secs = secsLeft % 60;
    var timeStr = mins + ':' + (secs < 10 ? '0' : '') + secs;

    html += '<div class="hype-drop-group rarity-' + drop.rarity + '">' +
      '<div class="hype-drop-level">Level ' + drop.level + '</div>' +
      '<div class="hype-drop-meta">' +
        '<span class="hype-drop-rarity">' + drop.rarity + '</span>' +
        '<span class="hype-drop-entries">&times;' + drop.entries + ' entries each</span>' +
      '</div>' +
      '<div class="hype-drop-timer" data-expires="' + drop.expiresAt + '">' + timeStr + '</div>' +
      '<div class="hype-drop-codes">';

    for (var j = 0; j < drop.codes.length; j++) {
      html += '<div class="hype-drop-code-row">' +
        '<span class="hype-drop-code">' + esc(drop.codes[j]) + '</span>' +
        '<button class="hype-drop-copy" onclick="copyDropCode(this, \'' + esc(drop.codes[j]) + '\')">Copy</button>' +
        '</div>';
    }

    html += '</div></div>';
  }

  html += '</div>';
  container.innerHTML = html;

  if (!dropPollTimer) {
    dropPollTimer = setInterval(tickDropTimers, 1000);
  }
}

function tickDropTimers() {
  var timers = document.querySelectorAll('.hype-drop-timer[data-expires]');
  var now = Date.now();
  var anyActive = false;

  for (var i = 0; i < timers.length; i++) {
    var expires = parseInt(timers[i].getAttribute('data-expires'), 10);
    var secsLeft = Math.max(0, Math.ceil((expires - now) / 1000));

    if (secsLeft <= 0) {
      var group = timers[i].closest('.hype-drop-group');
      if (group) group.classList.add('hype-drop-expired');
      timers[i].textContent = 'EXPIRED';
    } else {
      anyActive = true;
      var mins = Math.floor(secsLeft / 60);
      var secs = secsLeft % 60;
      timers[i].textContent = mins + ':' + (secs < 10 ? '0' : '') + secs;
    }
  }

  if (!anyActive) {
    setTimeout(function () {
      var section = document.getElementById('hypeDropsSection');
      if (section) section.style.display = 'none';
    }, 3000);
    if (dropPollTimer) { clearInterval(dropPollTimer); dropPollTimer = null; }
  }
}

function copyDropCode(btn, code) {
  navigator.clipboard.writeText(code).then(function () {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function () {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  }).catch(function () {});
}

document.addEventListener('DOMContentLoaded', function () {
  loadGiveawayEntries();
  loadHypeTrainDrops();
  setInterval(loadHypeTrainDrops, 15000);
});
