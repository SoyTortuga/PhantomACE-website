/* ══════════════════════════════════════════
   INVENTORY
   View and equip badges, titles, banners,
   name effects from inventory. Also home of
   the public Badge Showcase picker.
   ══════════════════════════════════════════ */

const PROFILE_SLOTS = [
  { slot: 'badge',       label: 'Badge',       type: 'badge',       icon: '\u{1F396}\uFE0F' },
  { slot: 'title',       label: 'Title',       type: 'title',       icon: '\u{1F3F7}\uFE0F' },
  { slot: 'banner',      label: 'Banner',      type: 'banner',      icon: '\u{1F5BC}\uFE0F' },
  { slot: 'name-effect', label: 'Name Effect', type: 'name-effect', icon: '\u2728' },
];

/* Exclusive outranks mythic. It is not "rarer" in a drop-rate sense —
   there is no drop rate — it means you were there, which is the one thing
   nobody can obtain later. */
const RARITY_ORDER = { exclusive: 0, mythic: 1, rare: 2, uncommon: 3, common: 4 };
const SHOWCASE_MAX = 5;

let profileItems = [];
let profileEquips = {};
let showcaseSelection = [];
let activeSlot = PROFILE_SLOTS[0].slot;

async function loadInventory() {
  const container = document.getElementById('inventoryCollection');
  if (!container) return;

  const session = getSession();
  if (!session) {
    container.innerHTML = `
      <div class="collection-login">
        <p>Log in with Twitch to view your inventory.</p>
        <button class="btn-primary" onclick="loginWithTwitch()">Log In with Twitch</button>
      </div>`;
    return;
  }

  try {
    const res = await fetch('/api/inventory?game=profile');
    if (!res.ok) throw new Error();
    const data = await res.json();
    profileItems = data.items || [];
    profileEquips = data.equips || {};
    showcaseSelection = (profileEquips.badgeShowcase || []).slice();
  } catch {
    profileItems = [];
    profileEquips = {};
    showcaseSelection = [];
  }

  if (profileItems.length === 0) {
    container.innerHTML = `
      <div class="collection-empty">
        <p>No cosmetics yet. Earn them through <a href="/phamily-time.html">Phamily Time</a>, or redeem a code dropped in chat on the <a href="/redeem.html">Redeem</a> page!</p>
      </div>`;
    return;
  }

  renderCollection(container);
}

function renderCollection(container) {
  const session = getSession();
  /* subTier, not role. A subscribing MODERATOR has role 'moderator' — the
     role field is a display ladder where moderator outranks every sub tier —
     so testing role hid this button from the subscribers most likely to be
     in chat earning badges. */
  const isSub = session && (Number(session.subTier) > 0 || session.role === 'broadcaster');
  const hasTwitchBadges = profileItems.some(i => i.source === 'twitch-import');

  let html = '';

  /* Shown whenever they are a subscriber, not only before their first
     import. Badges accrue: a new one arrives every few months, and the
     button used to vanish the moment a single badge landed — which stranded
     everyone who imported while the grant was broken and received exactly
     one. There is nothing to protect against, since importing again only
     ever adds what is missing. */
  if (isSub) {
    html += `
      <div class="import-badges-bar">
        <button class="btn-secondary import-badges-btn" id="importBadgesBtn" onclick="importTwitchBadges()">
          ${hasTwitchBadges ? 'Check for New Sub Badges' : 'Import Twitch Sub Badges'}
        </button>
      </div>`;
  }

  html += '<div class="collection-equipped">';
  html += '<div class="section-header">Equipped</div>';
  html += '<div class="equipped-row">';
  for (const slot of PROFILE_SLOTS) {
    const equippedId = profileEquips[slot.slot];
    const item = equippedId ? profileItems.find(i => i.id === equippedId) : null;
    html += `
      <div class="equipped-slot">
        <div class="equipped-label">${slot.label}</div>
        <div class="equipped-item ${item ? 'rarity-' + (item.rarity || 'common') : 'empty'}">
          ${item ? escName(item.name) : 'None'}
        </div>
      </div>`;
  }
  html += '</div></div>';

  html += renderTabs();
  html += renderActiveTabGrid();
  html += renderShowcaseSection();
  html += renderFooterTip();

  container.innerHTML = html;
}

function renderTabs() {
  let html = '<div class="inv-tabs">';
  for (const slot of PROFILE_SLOTS) {
    const count = profileItems.filter(i => i.type === slot.type).length;
    const isActive = activeSlot === slot.slot;
    html += `
      <button class="pill-btn inv-tab ${isActive ? 'active' : ''}" onclick="setActiveSlot('${slot.slot}')">
        ${slot.icon} ${slot.label} <span class="inv-tab-count">${count}</span>
      </button>`;
  }
  html += '</div>';
  return html;
}

function setActiveSlot(slot) {
  activeSlot = slot;
  const container = document.getElementById('inventoryCollection');
  if (container) renderCollection(container);
}

function renderActiveTabGrid() {
  const slot = PROFILE_SLOTS.find(s => s.slot === activeSlot) || PROFILE_SLOTS[0];
  const items = profileItems
    .filter(i => i.type === slot.type)
    .sort((a, b) => (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9));

  let html = '<div class="collection-category">';

  if (items.length === 0) {
    html += `
      <div class="inv-tab-empty">
        <p>No ${slot.label.toLowerCase()}s yet. Earn one through <a href="/phamily-time.html">Phamily Time</a>, a channel point redemption, or a code drop on the <a href="/redeem.html">Redeem</a> page.</p>
      </div>`;
    html += '</div>';
    return html;
  }

  html += '<div class="collection-grid">';
  for (const item of items) {
    const isEquipped = profileEquips[slot.slot] === item.id;
    html += `
      <div class="collection-item ${isEquipped ? 'equipped' : ''} rarity-${item.rarity || 'common'}" data-id="${escAttr(item.id)}" data-slot="${slot.slot}">
        ${isEquipped ? '<div class="wearing-pill">Wearing</div>' : ''}
        ${itemSwatch(item, slot)}
        <div class="item-rarity-tag">${item.rarity || 'common'}</div>
        <div class="item-name">${escName(item.name)}</div>
        <div class="item-desc">${escName(itemDescription(item, slot))}</div>
        <button class="pill-btn item-equip-btn" onclick="toggleProfileEquip('${slot.slot}', '${escAttr(item.id)}', ${isEquipped})">
          ${isEquipped ? 'Unequip' : 'Equip'}
        </button>
      </div>`;
  }
  html += '</div></div>';
  return html;
}

/* Artwork for an item, or null if it has none.
   Two sources, because badges arrive two ways: imported Twitch badges bring
   Twitch's own URLs, site-granted ones carry a local path. Both already had
   somewhere to live in `meta` and neither was ever displayed — the tile drew
   the SLOT's emoji, which is identical for every item in the slot, so a
   badge with real art looked exactly like one without. */
function itemArtwork(item) {
  const meta = item.meta || {};
  return meta.image || meta.imageUrl4x || meta.imageUrl2x || meta.imageUrl1x || null;
}

const BADGE_SLOT = PROFILE_SLOTS.find(s => s.slot === 'badge') || PROFILE_SLOTS[0];

/* The tile face: the item's own art at 48px when it has any, otherwise the
   slot emoji exactly as before. */
function itemSwatch(item, slot) {
  const art = itemArtwork(item);
  if (!art) return `<div class="item-icon-swatch">${(slot || BADGE_SLOT).icon}</div>`;
  return `<div class="item-icon-swatch has-art">` +
         `<img src="${escAttr(art)}" alt="" loading="lazy">` +
         `</div>`;
}

function itemDescription(item, slot) {
  if (item.description) return item.description;
  const rarity = item.rarity || 'common';
  const rarityLabel = rarity.charAt(0).toUpperCase() + rarity.slice(1);
  return `${rarityLabel} ${slot.label.toLowerCase()} \u2014 earned via ${item.source || 'Phamily Time'}`;
}

function renderShowcaseSection() {
  const badges = profileItems
    .filter(i => i.type === 'badge')
    .sort((a, b) => (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9));

  if (badges.length === 0) return '';

  let html = '<div class="collection-category showcase-section">';
  html += `<div class="section-header">Badge Showcase <span class="collection-count">${showcaseSelection.length} / ${SHOWCASE_MAX}</span></div>`;
  html += `<p class="showcase-desc">Pick up to ${SHOWCASE_MAX} badges to show off wherever member interaction happens — leaderboards, game lobbies, and beyond. Anyone who sees your name there sees these.</p>`;
  html += '<div class="collection-grid">';

  for (const item of badges) {
    const isSelected = showcaseSelection.includes(item.id);
    const atMax = showcaseSelection.length >= SHOWCASE_MAX && !isSelected;
    html += `
      <div class="collection-item showcase-item ${isSelected ? 'equipped' : ''} rarity-${item.rarity || 'common'}">
        ${isSelected ? '<div class="wearing-pill">Showing</div>' : ''}
        ${itemSwatch(item, BADGE_SLOT)}
        <div class="item-rarity-tag">${item.rarity || 'common'}</div>
        <div class="item-name">${escName(item.name)}</div>
        <button class="pill-btn item-equip-btn" ${atMax ? 'disabled' : ''} onclick="toggleShowcaseBadge('${escAttr(item.id)}')">
          ${isSelected ? 'Remove' : 'Add to Showcase'}
        </button>
      </div>`;
  }

  html += '</div>';
  html += `<button class="btn-primary showcase-save-btn" id="showcaseSaveBtn" onclick="saveShowcase()">Save Showcase</button>`;
  html += '</div>';
  return html;
}

function renderFooterTip() {
  return `
    <div class="inv-footer-tip">
      <p>Earn more cosmetics by climbing the <a href="/phamily-time.html">Phamily Time</a> leaderboard, catching a channel point drop, or redeeming a code the moment it's dropped in chat on the <a href="/redeem.html">Redeem</a> page. Once they're yours, they're yours to keep.</p>
    </div>`;
}

async function toggleShowcaseBadge(itemId) {
  const idx = showcaseSelection.indexOf(itemId);
  if (idx !== -1) {
    showcaseSelection.splice(idx, 1);
  } else if (showcaseSelection.length < SHOWCASE_MAX) {
    showcaseSelection.push(itemId);
  }

  const container = document.getElementById('inventoryCollection');
  renderCollection(container);
}

async function saveShowcase() {
  const btn = document.getElementById('showcaseSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  try {
    const res = await fetch('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set-showcase', badgeIds: showcaseSelection }),
    });
    if (!res.ok) throw new Error();
    if (!profileEquips.badgeShowcase) profileEquips.badgeShowcase = [];
    profileEquips.badgeShowcase = showcaseSelection.slice();
    if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save Showcase'; btn.disabled = false; }, 1500); }
  } catch {
    if (btn) { btn.textContent = 'Save failed — try again'; btn.disabled = false; }
  }
}

async function toggleProfileEquip(slot, itemId, isEquipped) {
  const newId = isEquipped ? 'none' : itemId;

  if (isEquipped) {
    delete profileEquips[slot];
  } else {
    profileEquips[slot] = itemId;
  }

  const container = document.getElementById('inventoryCollection');
  renderCollection(container);

  try {
    await fetch('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'equip', game: 'profile', slot, itemId: newId }),
    });
  } catch {}
}

function escName(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escAttr(s) {
  return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

async function importTwitchBadges() {
  const btn = document.getElementById('importBadgesBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Importing...';
  }

  try {
    const res = await fetch('/api/import-badges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      /* The server says why: not a subscriber, no badge set on the
         channel, Twitch unreachable. Discarding it left one message for
         every cause, naming none of them and suggesting no fix. */
      let reason = '';
      try { reason = (await res.json()).error || ''; } catch (e) { /* not JSON */ }
      throw new Error(reason || ('Twitch returned ' + res.status));
    }
    const data = await res.json();

    if (data.imported > 0) {
      await loadInventory();
    } else if (btn) {
      /* "No new badges" is true and useless on its own: it reads the same
         whether someone holds everything they have earned or their
         subscription length was never recorded. Say which. */
      if (!data.durationKnown) {
        btn.textContent = 'Say something in chat first, then try again';
        btn.title = 'Your subscription length is read from the badge you wear '
          + 'in chat — Twitch offers it nowhere else. Until you post a message '
          + 'there is nothing to go on.';
      } else if (data.eligible > 0 && data.eligible === data.totalBadges) {
        btn.textContent = `Up to date — all ${data.totalBadges} badges imported`;
        btn.title = `${data.months} months at Tier ${data.tier}.`;
      } else {
        btn.textContent = 'No new badges yet';
        btn.title = `You are recorded at ${data.months} months, Tier ${data.tier}.`;
      }
      btn.disabled = false;
    }
  } catch (err) {
    if (btn) {
      btn.textContent = (err && err.message) || 'Import failed — try again later';
      btn.title = (err && err.message) || '';
      btn.disabled = false;
    }
  }
}

document.addEventListener('DOMContentLoaded', loadInventory);
