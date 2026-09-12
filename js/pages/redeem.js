document.addEventListener('DOMContentLoaded', function () {
  var session = getSession();
  var loginEl = document.getElementById('redeemLogin');
  var formEl = document.getElementById('redeemForm');

  if (session && session.user_id) {
    loginEl.style.display = 'none';
    formEl.style.display = '';
  }

  var input = document.getElementById('codeInput');
  if (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitCode();
    });
  }
});

function submitCode() {
  var input = document.getElementById('codeInput');
  var btn = document.getElementById('redeemBtn');
  var resultEl = document.getElementById('redeemResult');
  var code = (input.value || '').trim().toUpperCase();

  if (!code) {
    showResult(resultEl, '<p class="redeem-error">Enter a code first.</p>');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Redeeming...';
  resultEl.style.display = 'none';

  fetch('/api/item-codes', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'redeem', code: code }),
  })
    .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
    .then(function (res) {
      btn.disabled = false;
      btn.textContent = 'Redeem';

      if (res.data.success) {
        var item = res.data.item;
        var rarity = item.rarity || 'common';
        showResult(resultEl,
          '<div class="redeem-success">' +
            '<p class="redeem-success-title">Item Claimed!</p>' +
            '<div class="redeemed-item-card rarity-border-' + rarity + '">' +
              '<div class="redeemed-item-name">' + escapeHtml(item.name) + '</div>' +
              '<div class="redeemed-item-meta">' +
                '<span class="rarity-' + rarity + '">' + rarity + '</span>' +
                ' &middot; ' + escapeHtml(item.type) +
              '</div>' +
            '</div>' +
          '</div>'
        );
        input.value = '';
        return;
      }

      if (res.status === 410) {
        showResult(resultEl, '<p class="redeem-expired">This code has expired.</p>');
      } else if (res.status === 409) {
        showResult(resultEl, '<p class="redeem-duplicate">You already redeemed this code.</p>');
      } else if (res.status === 404) {
        showResult(resultEl, '<p class="redeem-error">Invalid code. Check the code and try again.</p>');
      } else {
        showResult(resultEl, '<p class="redeem-error">' + escapeHtml(res.data.error || 'Something went wrong.') + '</p>');
      }
    })
    .catch(function () {
      btn.disabled = false;
      btn.textContent = 'Redeem';
      showResult(resultEl, '<p class="redeem-error">Network error. Try again.</p>');
    });
}

function showResult(el, html) {
  el.innerHTML = html;
  el.style.display = '';
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}
