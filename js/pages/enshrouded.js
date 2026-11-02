/* ══════════════════════════════════════════════
   Enshrouded — /enshrouded

   One read of /api/enshrouded. The server address is public; the PASSWORD is
   only in the response at all when the viewer is a subscriber, so there is no
   client-side gate to bypass — if it isn't in the payload, the page has
   nothing to show. It is kept masked until "Reveal" so it isn't sitting on
   screen while someone is streaming or screen-sharing.
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  var els = {};
  var state = null;
  var revealed = false;

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function cacheEls() {
    ['ensLoading', 'ensUnset', 'ensGuest', 'ensNotSub', 'ensBody', 'ensAdmin',
     'ensAddress', 'ensPassword', 'ensRevealPassword', 'ensCopyPassword', 'ensCopyAddress',
     'ensFactName', 'ensFactAddress', 'ensFactSlots', 'ensNotes',
     'ensInName', 'ensInAddress', 'ensInPassword', 'ensInSlots', 'ensInNotes',
     'ensSave', 'ensAdminStatus'].forEach(function (id) { els[id] = $(id); });
  }

  function copy(text, btn) {
    if (!text) return;
    var done = function () {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1500);
    };
    try {
      navigator.clipboard.writeText(text).then(done, function () { /* denied */ });
    } catch (e) { /* no clipboard API */ }
  }

  function maskedPassword(pw) {
    return pw ? '•'.repeat(Math.min(pw.length, 24)) : '—';
  }

  function renderPassword() {
    if (!els.ensPassword) return;
    var pw = state && state.password;
    if (!pw) { els.ensPassword.textContent = '—'; return; }
    els.ensPassword.textContent = revealed ? pw : maskedPassword(pw);
    if (els.ensRevealPassword) els.ensRevealPassword.textContent = revealed ? 'Hide' : 'Reveal';
  }

  function render() {
    show(els.ensLoading, false);
    var s = state || {};
    var srv = s.server || {};

    /* Not published yet — nothing to show anyone. */
    if (!s.configured) {
      show(els.ensUnset, true);
      show(els.ensGuest, false); show(els.ensNotSub, false); show(els.ensBody, false);
      renderAdmin(srv);
      return;
    }
    show(els.ensUnset, false);
    show(els.ensGuest, !s.loggedIn);
    show(els.ensNotSub, !!s.loggedIn && !s.eligible);
    show(els.ensBody, !!s.eligible);

    if (s.eligible) {
      if (els.ensAddress) els.ensAddress.textContent = srv.address || '—';
      if (els.ensFactName) els.ensFactName.textContent = srv.name || '—';
      if (els.ensFactAddress) els.ensFactAddress.textContent = srv.address || '—';
      if (els.ensFactSlots) els.ensFactSlots.textContent = srv.slots ? (srv.slots + ' players') : '—';
      if (els.ensNotes) {
        if (srv.notes) { els.ensNotes.innerHTML = esc(srv.notes); show(els.ensNotes, true); }
        else show(els.ensNotes, false);
      }
      revealed = false;
      renderPassword();
    }
    renderAdmin(srv);
  }

  /* The admin card is also role-gated server-side: a non-mod POST is refused,
     so showing it is a convenience, not the control. */
  function renderAdmin(srv) {
    var isStaff = state && (state.role === 'moderator' || state.role === 'broadcaster');
    show(els.ensAdmin, !!isStaff);
    if (!isStaff) return;
    if (els.ensInName && !els.ensInName.value) els.ensInName.value = srv.name || '';
    if (els.ensInAddress && !els.ensInAddress.value) els.ensInAddress.value = srv.address || '';
    if (els.ensInSlots && srv.slots) els.ensInSlots.value = srv.slots;
    if (els.ensInNotes && !els.ensInNotes.value) els.ensInNotes.value = srv.notes || '';
    /* The password field is deliberately left blank rather than prefilled. */
  }

  function save() {
    var btn = els.ensSave;
    if (btn) btn.disabled = true;
    if (els.ensAdminStatus) els.ensAdminStatus.textContent = 'Saving…';
    fetch('/api/enshrouded', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: els.ensInName ? els.ensInName.value : '',
        address: els.ensInAddress ? els.ensInAddress.value : '',
        password: els.ensInPassword ? els.ensInPassword.value : '',
        slots: els.ensInSlots ? els.ensInSlots.value : 16,
        notes: els.ensInNotes ? els.ensInNotes.value : '',
      }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (out) {
        if (btn) btn.disabled = false;
        if (els.ensAdminStatus) {
          els.ensAdminStatus.textContent = out.ok
            ? 'Saved. Remember to match it in enshrouded_server.json.'
            : ((out.d && out.d.error) || 'Could not save.');
        }
        if (out.ok) { if (els.ensInPassword) els.ensInPassword.value = ''; load(); }
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        if (els.ensAdminStatus) els.ensAdminStatus.textContent = 'Network error.';
      });
  }

  function load() {
    return fetch('/api/enshrouded', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) { state = s; render(); })
      .catch(function () { show(els.ensLoading, false); });
  }

  function init() {
    cacheEls();
    if (els.ensCopyAddress) els.ensCopyAddress.addEventListener('click', function () {
      copy(state && state.server && state.server.address, els.ensCopyAddress);
    });
    if (els.ensCopyPassword) els.ensCopyPassword.addEventListener('click', function () {
      copy(state && state.password, els.ensCopyPassword);
    });
    if (els.ensRevealPassword) els.ensRevealPassword.addEventListener('click', function () {
      revealed = !revealed; renderPassword();
    });
    if (els.ensSave) els.ensSave.addEventListener('click', save);
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
