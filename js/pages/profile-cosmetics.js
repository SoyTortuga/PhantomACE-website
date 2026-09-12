/* ══════════════════════════════════════════
   PROFILE COSMETICS
   View and equip badges, titles, banners,
   name effects from inventory
   ══════════════════════════════════════════ */

const PROFILE_SLOTS = [
  { slot: 'badge',       label: 'Badge',       type: 'badge' },
  { slot: 'title',       label: 'Title',       type: 'title' },
  { slot: 'banner',      label: 'Banner',      type: 'banner' },
  { slot: 'name-effect', label: 'Name Effect', type: 'name-effect' },
];

const RARITY_ORDER = { mythic: 0, rare: 1, uncommon: 2, common: 3 };
const SHOWCASE_MAX = 5;

let profileItems = [];
let profileEquips = {};
let showcaseSelection = [];

async function loadProfileCosmetics() {
  const container = document.getElementById('profileCollection');
  if (!container) return;

  const session = getSession();
  if (!session) {
    container.innerHTML = `
      <div class="collection-login">
        <p>Log in with Twitch to view your collection.</p>
        <button class="btn-primary" onclick="loginWithTwitch()">Log In with Twitch</button>
      </div>`;
    container.closest('.collection-section').style.display = '';
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
        <p>No profile items yet. Earn them through <a href="/community-stats.html">Phamily Time</a> rewards!</p>
      </div>`;
    container.closest('.collection-section').style.display = '';
    return;
  }

  renderCollection(container);
  container.closest('.collection-section').style.display = '';
}

function renderCollection(container) {
  const session = getSession();
  const isSub = session && session.role && (session.role.startsWith('sub_') || session.role === 'broadcaster');
  const hasTwitchBadges = profileItems.some(i => i.source === 'twitch-import');

  let html = '';

  if (isSub && !hasTwitchBadges) {
    html += `
      <div class="import-badges-bar">
        <button class="btn-secondary import-badges-btn" id="importBadgesBtn" onclick="importTwitchBadges()">
          Import Twitch Sub Badges
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

  html += renderShowcaseSection();

  for (const slot of PROFILE_SLOTS) {
    const items = profileItems
      .filter(i => i.type === slot.type)
      .sort((a, b) => (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9));

    if (items.length === 0) continue;

    html += `<div class="collection-category">`;
    html += `<div class="section-header">${slot.label}s <span class="collection-count">${items.length}</span></div>`;
    html += `<div class="collection-grid">`;

    for (const item of items) {
      const isEquipped = profileEquips[slot.slot] === item.id;
      html += `
        <div class="collection-item ${isEquipped ? 'equipped' : ''} rarity-${item.rarity || 'common'}" data-id="${escAttr(item.id)}" data-slot="${slot.slot}">
          <div class="item-rarity-tag">${item.rarity || 'common'}</div>
          <div class="item-name">${escName(item.name)}</div>
          <div class="item-source">${item.source || 'Phamily Time'}</div>
          <button class="pill-btn item-equip-btn" onclick="toggleProfileEquip('${slot.slot}', '${escAttr(item.id)}', ${isEquipped})">
            ${isEquipped ? 'Unequip' : 'Equip'}
          </button>
        </div>`;
    }

    html += '</div></div>';
  }

  container.innerHTML = html;
}

function renderShowcaseSection() {
  const badges = profileItems
    .filter(i => i.type === 'badge')
    .sort((a, b) => (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9));

  if (badges.length === 0) return '';

  let html = '<div class="collection-category showcase-section">';
  html += `<div class="section-header">Badge Showcase <span class="collection-count">${showcaseSelection.length} / ${SHOWCASE_MAX}</span></div>`;
  html += `<p class="showcase-desc">Pick up to ${SHOWCASE_MAX} badges to show off in games and community areas — anyone who sees your name there sees these.</p>`;
  html += '<div class="collection-grid">';

  for (const item of badges) {
    const isSelected = showcaseSelection.includes(item.id);
    const atMax = showcaseSelection.length >= SHOWCASE_MAX && !isSelected;
    html += `
      <div class="collection-item showcase-item ${isSelected ? 'equipped' : ''} rarity-${item.rarity || 'common'}">
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

async function toggleShowcaseBadge(itemId) {
  const idx = showcaseSelection.indexOf(itemId);
  if (idx !== -1) {
    showcaseSelection.splice(idx, 1);
  } else if (showcaseSelection.length < SHOWCASE_MAX) {
    showcaseSelection.push(itemId);
  }

  const container = document.getElementById('profileCollection');
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

  const container = document.getElementById('profileCollection');
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
    if (!res.ok) throw new Error();
    const data = await res.json();

    if (data.imported > 0) {
      await loadProfileCosmetics();
    } else if (btn) {
      btn.textContent = 'No new badges found';
    }
  } catch {
    if (btn) {
      btn.textContent = 'Import failed — try again later';
      btn.disabled = false;
    }
  }
}

document.addEventListener('DOMContentLoaded', loadProfileCosmetics);
