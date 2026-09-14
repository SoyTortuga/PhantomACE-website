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

/* Clock offset against the server. A viewer whose machine runs a few minutes
   fast would otherwise see every drop as already expired, or hold one that
   has quietly run out. The countdown is the one thing on this page that must
   not be wrong. */
var dropClockOffset = 0;

function loadHypeTrainDrops() {
  fetch('/api/live-drops')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (data && typeof data.serverNow === 'number') {
        dropClockOffset = data.serverNow - Date.now();
      }
      renderDrops(data && data.drops ? data.drops : []);
    })
    .catch(function () { renderDrops([]); });
}

function dropNow() { return Date.now() + dropClockOffset; }

function renderDrops(drops) {
  var section = document.getElementById('hypeDropsSection');
  var container = document.getElementById('hypeDropsPanel');
  if (!section || !container) return;

  var now = dropNow();
  var active = drops.filter(function (d) { return d.expiresAt > now; });

  if (active.length === 0) {
    section.style.display = 'none';
    if (dropPollTimer) { clearInterval(dropPollTimer); dropPollTimer = null; }
    return;
  }

  section.style.display = '';

  var html = '<div class="hype-drops-header">' +
    '<span class="hype-drops-icon">&#127873;</span>' +
    '<span class="hype-drops-title">Live Code Drops</span>' +
    '<span class="hype-drops-hint">5 minutes each, one claim per account.</span>' +
    '</div><div class="hype-drops-grid">';

  for (var i = 0; i < active.length; i++) {
    var drop = active[i];
    var secsLeft = Math.max(0, Math.ceil((drop.expiresAt - now) / 1000));
    var mins = Math.floor(secsLeft / 60);
    var secs = secsLeft % 60;
    var timeStr = mins + ':' + (secs < 10 ? '0' : '') + secs;

    /* Where a code is claimed depends on what it IS. Entry codes go in the
       box on this page; item and egg codes are redeemed at /redeem. Saying so
       on the card is not decoration — pasted into the wrong box, the honest
       answer is "invalid code", which reads as a broken drop. */
    var isItem = drop.kind === 'item';
    var reward = isItem
      ? esc(drop.itemName || 'Item')
      : '&times;' + (drop.entries || 0) + ' entries';
    var whereText = isItem ? 'Redeem at /redeem' : 'Claim in the box above';

    var origin = drop.source === 'hype-train'
      ? 'Hype Train' + (drop.level ? ' &bull; Level ' + esc(String(drop.level)) : '')
      : 'Chat drop';

    html += '<div class="hype-drop-group rarity-' + esc(drop.rarity || 'common') + '">' +
      '<div class="hype-drop-level">' + origin + '</div>' +
      '<div class="hype-drop-meta">' +
        '<span class="hype-drop-rarity">' + esc(drop.rarity || '') + '</span>' +
        '<span class="hype-drop-entries">' + reward + '</span>' +
      '</div>' +
      '<div class="hype-drop-timer" data-expires="' + drop.expiresAt + '">' + timeStr + '</div>' +
      '<div class="hype-drop-codes">' +
        '<div class="hype-drop-code-row">' +
          '<span class="hype-drop-code">' + esc(drop.code) + '</span>' +
          '<button class="hype-drop-copy" data-code="' + esc(drop.code) + '">Copy</button>' +
        '</div>' +
      '</div>' +
      '<div class="hype-drop-where">' + whereText + '</div>' +
      '</div>';
  }

  html += '</div>';
  container.innerHTML = html;

  /* Listeners rather than an inline onclick carrying the code — nothing to
     escape wrong. */
  var buttons = container.querySelectorAll('.hype-drop-copy');
  for (var b = 0; b < buttons.length; b++) {
    (function (btn) {
      btn.addEventListener('click', function () { copyDropCode(btn, btn.dataset.code); });
    })(buttons[b]);
  }

  if (!dropPollTimer) {
    dropPollTimer = setInterval(tickDropTimers, 1000);
  }
}

function tickDropTimers() {
  var timers = document.querySelectorAll('.hype-drop-timer[data-expires]');
  var now = dropNow();   /* server-corrected, same as renderDrops */
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
