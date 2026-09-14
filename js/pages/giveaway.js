/* ══════════════════════════════════════════
   GIVEAWAY PAGE
   Live hype train code drops.

   The entry-code card UI that used to live here is gone. Phamily Time
   rewards no longer hand out giveaway codes — they add entries straight to
   the monthly ledger — so there are no cards to reveal, and the "Your Bonus
   Entries" panel they filled has been removed with them. Where a viewer's
   entries came from is shown by the history list in the entry tracker.
   ══════════════════════════════════════════ */

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
    '<span class="hype-drops-hint">Copy a code and claim it in the box above — 5 minutes each, one claim per account.</span>' +
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
  loadHypeTrainDrops();
  setInterval(loadHypeTrainDrops, 15000);
});
