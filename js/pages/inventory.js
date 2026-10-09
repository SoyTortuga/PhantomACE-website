/* ══════════════════════════════════════════
   INVENTORY
   View and equip badges, titles, banners,
   name effects from inventory. Also home of
   the public Badge Showcase picker.
   ══════════════════════════════════════════ */

const PROFILE_SLOTS = [
  { slot: 'badge',       label: 'Badge',       type: 'badge',       icon: '\u{1F396}️' },
  { slot: 'title',       label: 'Title',       type: 'title',       icon: '\u{1F3F7}️' },
  { slot: 'banner',      label: 'Banner',      type: 'banner',      icon: '\u{1F5BC}️' },
  { slot: 'name-effect', label: 'Name Effect', type: 'name-effect', icon: '✨' },
];
const ALL_TAB = 'all';
const SLOT_BY_TYPE = Object.fromEntries(PROFILE_SLOTS.map(s => [s.type, s]));

/* Exclusive outranks mythic. It is not "rarer" in a drop-rate sense —
   there is no drop rate — it means you were there, which is the one thing
   nobody can obtain later. */
const RARITY_ORDER = { exclusive: 0, mythic: 1, legendary: 2, epic: 3, rare: 4, uncommon: 5, common: 6 };
const SHOWCASE_MAX = 5;

/* The cosmetic kinds a duplicate of can be gifted — matches
   functions/api/gift.js GIFTABLE_TYPES. Consumables (eggs, wildcards) and the
   room-slot capacity unlock are deliberately absent. */
const GIFTABLE_TYPES = new Set([
  'badge', 'title', 'banner', 'name-effect',
  'cardback', 'emote-pack',
  'skull-skin', 'click-effect', 'cosmetic',
  'dice',
  'room-piece', 'room-set',
]);

/* Months follow the shared season calendar (functions/api/season-time.js
   SEASON_TZ), so "this season" here is the same month Phamily Time and the
   giveaway are counting. */
const SEASON_TZ = 'America/Los_Angeles';
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const THEME_LABELS = { halloween: 'Halloween', harvest: 'Dead Harvest' };
const SOURCE_LABELS = {
  'phamily-time': 'Phamily Time',
  'item-code': 'a chat code drop',
  'twitch-import': 'your Twitch sub',
  'channel-points': 'channel points',
  'pham-checkin': 'stream check-ins',
  'hype-train': 'a hype train',
  'raid-redemption': 'a skull raid',
  'monthly-award': 'a monthly leaderboard finish',
  'giftsub': 'gifting subs',
  'bits': 'cheering bits',
};

let profileItems = [];
let profileEquips = {};
let showcaseSelection = [];
let activeSlot = PROFILE_SLOTS[0].slot;
let seasonOnly = false;
let sortMode = 'newest';
let collapsedGroups = new Set();
let equipError = '';
let equipBusy = false;
let listenersBound = false;

async function loadInventory() {
  const container = document.getElementById('inventoryCollection');
  if (!container) return;
  bindContainer(container);

  const session = getSession();
  if (!session) {
    container.innerHTML = `
      <div class="collection-login">
        <p>Log in with Twitch to view your inventory.</p>
        <button class="btn-primary" data-action="login">Log In with Twitch</button>
      </div>`;
    return;
  }

  raiseGiftNotices();

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
    clearNameFx(container);
    container.innerHTML = `
      <div class="collection-empty">
        <p>No cosmetics yet. Earn them through <a href="/phamily-time.html">Phamily Time</a>, or redeem a code dropped in chat on the <a href="/redeem.html">Redeem</a> page!</p>
      </div>`;
    return;
  }

  renderCollection(container);
}

/* One delegated listener instead of inline onclick strings, so an item id
   never has to survive being spliced into JavaScript source. */
function bindContainer(container) {
  if (listenersBound) return;
  listenersBound = true;

  container.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !container.contains(el) || el.disabled) return;
    const a = el.dataset.action;
    if (a === 'login') loginWithTwitch();
    else if (a === 'import') importTwitchBadges();
    else if (a === 'tab') setActiveSlot(el.dataset.slot);
    else if (a === 'season') { seasonOnly = el.dataset.value === 'season'; rerender(); }
    else if (a === 'sort') { sortMode = el.dataset.value; rerender(); }
    else if (a === 'equip') toggleProfileEquip(el.dataset.slot, el.dataset.id, el.dataset.equipped === '1');
    else if (a === 'showcase') toggleShowcaseBadge(el.dataset.id);
    else if (a === 'save-showcase') saveShowcase();
    else if (a === 'gift') openGiftDialog(el.dataset.id, el.dataset.type);
  });

  /* toggle does not bubble; capture it so a collapsed group stays collapsed
     across re-renders. */
  container.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.matches || !d.matches('details.showcase-group')) return;
    if (d.open) collapsedGroups.delete(d.dataset.group);
    else collapsedGroups.add(d.dataset.group);
  }, true);

  container.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;

    /* Badge art that is not on disk yet. The grimoire set badge points
       into assets/badges/grimoire/, which does not exist, so the tile
       would draw a broken image where the slot emoji used to be. Put the
       emoji back — that is what a badge with no art already shows. */
    const swatch = img.closest('.item-icon-swatch');
    if (swatch) {
      img.remove();
      swatch.classList.remove('has-art');
      swatch.textContent = swatch.dataset.fallback || BADGE_SLOT.icon;
      return;
    }

    if (!img.closest('.item-banner-thumb, .equipped-banner-thumb')) return;
    const box = img.parentElement;
    img.remove();
    box.classList.add('no-art');
    box.textContent = SLOT_BY_TYPE.banner.icon;
  }, true);
}

function rerender() {
  const container = document.getElementById('inventoryCollection');
  if (container) renderCollection(container);
}

/* ── Month / season derivation ──────────────── */

function seasonKeyOf(ms) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: SEASON_TZ, year: 'numeric', month: '2-digit' }).formatToParts(new Date(ms));
    const y = parts.find(p => p.type === 'year');
    const m = parts.find(p => p.type === 'month');
    if (y && m) return `${y.value}-${m.value}`;
  } catch { /* fall through */ }
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const CURRENT_SEASON = seasonKeyOf(Date.now());

/* The month an item belongs to. A milestone id carries the month that
   EARNED it (ms_10_badge_2026-10), which beats grantedAt — a grace-period
   claim of October's reward lands on November 3rd. Otherwise the grant
   date, in the season calendar. Items from before grantedAt existed have
   no month and no chip, rather than a guessed one. */
function itemMonthKey(item) {
  const m = /(?:^|[_-])(\d{4})-(0[1-9]|1[0-2])$/.exec(String(item.id || ''));
  if (m) return `${m[1]}-${m[2]}`;
  const at = Number(item.grantedAt);
  if (Number.isFinite(at) && at > 0) return seasonKeyOf(at);
  return null;
}

function itemTheme(item) {
  const meta = item.meta || {};
  const t = meta.theme || item.theme || '';
  if (!t || typeof t !== 'string') return null;
  return THEME_LABELS[t] || (t.charAt(0).toUpperCase() + t.slice(1));
}

function monthLabel(mk) {
  if (!mk) return '';
  const [y, m] = mk.split('-');
  return `${MONTH_ABBR[Number(m) - 1] || m} ${y}`;
}

function monthChip(item) {
  const parts = [monthLabel(itemMonthKey(item)), itemTheme(item)].filter(Boolean);
  return parts.length ? parts.join(' · ') : '';
}

function isThisSeason(item) {
  return itemMonthKey(item) === CURRENT_SEASON;
}

/* ── Sorting ─────────────────────────────────── */

function slotOf(item) {
  return SLOT_BY_TYPE[item.type] || null;
}

function isEquippedItem(item) {
  const s = slotOf(item);
  return !!s && profileEquips[s.slot] === item.id;
}

function newestKey(item) {
  const mk = itemMonthKey(item) || '0000-00';
  return mk + String(Number(item.grantedAt) || 0).padStart(15, '0');
}

function compareItems(a, b) {
  const eq = (isEquippedItem(b) ? 1 : 0) - (isEquippedItem(a) ? 1 : 0);
  if (eq) return eq;
  const rar = (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9);
  const name = String(a.name || '').localeCompare(String(b.name || ''));
  if (sortMode === 'rarity') return rar || newestKey(b).localeCompare(newestKey(a)) || name;
  if (sortMode === 'name') return name || rar;
  return newestKey(b).localeCompare(newestKey(a)) || rar || name;
}

function visibleItems(type) {
  return profileItems
    .filter(i => (type ? i.type === type : !!slotOf(i)))
    .filter(i => !seasonOnly || isThisSeason(i));
}

/* ── Rendering ───────────────────────────────── */

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
        <button class="btn-secondary import-badges-btn" id="importBadgesBtn" data-action="import">
          ${hasTwitchBadges ? 'Check for New Sub Badges' : 'Import Twitch Sub Badges'}
        </button>
      </div>`;
  }

  html += renderEquippedRow();
  html += renderEquipError();
  html += renderTabs();
  html += renderToolbar();
  html += renderActiveTabGrid();
  html += renderShowcaseSection();
  html += renderGiftSection();
  html += renderFooterTip();

  clearNameFx(container);
  container.innerHTML = html;
  applyNameFxPreviews(container);
}

function renderEquippedRow() {
  let html = '<div class="collection-equipped">';
  html += '<div class="section-header">Equipped</div>';
  html += '<div class="equipped-row">';
  for (const slot of PROFILE_SLOTS) {
    const equippedId = profileEquips[slot.slot];
    const item = equippedId ? profileItems.find(i => i.id === equippedId && i.type === slot.type) : null;
    let face = '';
    if (item && slot.type === 'banner') {
      const src = bannerSrc(item);
      if (src) face = `<div class="equipped-banner-thumb"><img src="${escAttr(src)}" alt="" loading="lazy"></div>`;
    }
    const fx = item && slot.type === 'name-effect' ? ` data-fx="${escAttr(fxVariant(item) || '')}"` : '';
    html += `
      <div class="equipped-slot">
        <div class="equipped-label">${slot.label}</div>
        ${face}
        <div class="equipped-item ${item ? 'rarity-' + escAttr(item.rarity || 'common') : 'empty'}"${fx}>${item ? escName(item.name) : 'None'}</div>
        ${item && monthChip(item) ? `<div class="item-month-chip">${escName(monthChip(item))}</div>` : ''}
      </div>`;
  }
  html += '</div></div>';
  return html;
}

function renderTabs() {
  const tabs = [{ slot: ALL_TAB, label: 'All', icon: '', type: null }, ...PROFILE_SLOTS];
  let html = '<div class="inv-tabs" role="tablist">';
  for (const t of tabs) {
    const count = visibleItems(t.type).length;
    const isActive = activeSlot === t.slot;
    html += `
      <button class="pill-btn inv-tab ${isActive ? 'active' : ''}" role="tab" aria-selected="${isActive}" data-action="tab" data-slot="${t.slot}">
        ${t.icon ? t.icon + ' ' : ''}${t.label} <span class="inv-tab-count">${count}</span>
      </button>`;
  }
  html += '</div>';
  return html;
}

function renderToolbar() {
  const seasonCount = profileItems.filter(i => slotOf(i) && isThisSeason(i)).length;
  const sorts = [['newest', 'Newest'], ['rarity', 'Rarity'], ['name', 'Name']];
  let html = '<div class="inv-toolbar">';
  html += '<div class="inv-toolbar-group" role="group" aria-label="When earned">';
  html += `<span class="inv-toolbar-label">Show</span>`;
  html += `<button class="pill-btn inv-filter ${seasonOnly ? '' : 'active'}" data-action="season" data-value="all" aria-pressed="${!seasonOnly}">Everything</button>`;
  html += `<button class="pill-btn inv-filter ${seasonOnly ? 'active' : ''}" data-action="season" data-value="season" aria-pressed="${seasonOnly}">This Season · ${escName(monthLabel(CURRENT_SEASON))} <span class="inv-tab-count">${seasonCount}</span></button>`;
  html += '</div>';
  html += '<div class="inv-toolbar-group" role="group" aria-label="Sort">';
  html += `<span class="inv-toolbar-label">Sort</span>`;
  for (const [value, label] of sorts) {
    html += `<button class="pill-btn inv-filter ${sortMode === value ? 'active' : ''}" data-action="sort" data-value="${value}" aria-pressed="${sortMode === value}">${label}</button>`;
  }
  html += '</div></div>';
  return html;
}

function setActiveSlot(slot) {
  if (slot !== ALL_TAB && !PROFILE_SLOTS.some(s => s.slot === slot)) return;
  activeSlot = slot;
  rerender();
}

function renderActiveTabGrid() {
  const slot = PROFILE_SLOTS.find(s => s.slot === activeSlot) || null;
  const items = visibleItems(slot ? slot.type : null).sort(compareItems);
  const noun = slot ? slot.label.toLowerCase() + 's' : 'cosmetics';

  let html = '<div class="collection-category">';

  if (items.length === 0) {
    const hidden = seasonOnly && visibleItems(slot ? slot.type : null).length === 0
      && profileItems.some(i => (slot ? i.type === slot.type : !!slotOf(i)));
    html += `
      <div class="inv-tab-empty">
        <p>${hidden
          ? `No ${noun} from ${escName(monthLabel(CURRENT_SEASON))} yet — switch to <strong>Everything</strong> to see older ones, or earn this month's through <a href="/phamily-time.html">Phamily Time</a>.`
          : `No ${noun} yet. Earn one through <a href="/phamily-time.html">Phamily Time</a>, a channel point redemption, or a code drop on the <a href="/redeem.html">Redeem</a> page.`}</p>
      </div>`;
    html += '</div>';
    return html;
  }

  html += '<div class="collection-grid">';
  for (const item of items) html += renderItemCard(item, slotOf(item));
  html += '</div></div>';
  return html;
}

function renderItemCard(item, slot) {
  const isEquipped = profileEquips[slot.slot] === item.id;
  const rarity = escAttr(item.rarity || 'common');
  const chip = monthChip(item);
  const fx = slot.type === 'name-effect' ? ` data-fx="${escAttr(fxVariant(item) || '')}"` : '';
  return `
      <div class="collection-item ${isEquipped ? 'equipped' : ''} rarity-${rarity} type-${escAttr(slot.type)}" data-id="${escAttr(item.id)}" data-slot="${slot.slot}">
        ${isEquipped ? '<div class="wearing-pill">Wearing</div>' : ''}
        ${itemFace(item, slot)}
        <div class="item-meta-row">
          <span class="item-rarity-tag">${escName(item.rarity || 'common')}</span>
          ${activeSlot === ALL_TAB ? `<span class="item-type-tag">${escName(slot.label)}</span>` : ''}
        </div>
        <div class="item-name"${fx}>${escName(item.name)}</div>
        ${chip ? `<div class="item-month-chip">${escName(chip)}</div>` : ''}
        <div class="item-desc">${escName(itemDescription(item, slot))}</div>
        <button class="pill-btn item-equip-btn" data-action="equip" data-slot="${slot.slot}" data-id="${escAttr(item.id)}" data-equipped="${isEquipped ? '1' : '0'}">
          ${isEquipped ? 'Unequip' : 'Equip'}
        </button>
      </div>`;
}

/* Artwork for an item, or null if it has none.
   Two sources, because badges arrive two ways: imported Twitch badges bring
   Twitch's own URLs, site-granted ones carry a local path. */
function itemArtwork(item) {
  const meta = item.meta || {};
  return meta.image || meta.imageUrl4x || meta.imageUrl2x || meta.imageUrl1x || null;
}

const BADGE_SLOT = PROFILE_SLOTS.find(s => s.slot === 'badge') || PROFILE_SLOTS[0];

function cv() {
  return (typeof window !== 'undefined' && window.CosmeticVariants) || null;
}

function fxVariant(item) {
  const api = cv();
  return api ? api.nameEffectVariant(item) : null;
}

/* The same banner the profile page draws for this item — themed months get
   their own art, so September's and October's banners finally look like
   two different things. */
function bannerSrc(item) {
  const own = itemArtwork(item);
  if (own) return own;
  const api = cv();
  return api ? api.bannerPath(api.bannerVariant(item)) : null;
}

/* The tile face. Banners show the banner, badges their art, name effects
   are previewed on the item's own name below — the emoji is only for things
   with nothing better to show. */
function itemFace(item, slot) {
  const s = slot || BADGE_SLOT;
  if (s.type === 'banner') {
    const src = bannerSrc(item);
    if (src) return `<div class="item-banner-thumb"><img src="${escAttr(src)}" alt="" loading="lazy"></div>`;
  }
  if (s.type === 'name-effect') return '';
  const art = itemArtwork(item);
  if (!art) return `<div class="item-icon-swatch">${s.icon}</div>`;
  /* The slot emoji rides along so the error handler can put back THIS
     item’s icon rather than guessing at the badge one. */
  return `<div class="item-icon-swatch has-art" data-fallback="${escAttr(s.icon)}"><img src="${escAttr(art)}" alt="" loading="lazy"></div>`;
}

/* Name effects animate through the shared applier; managed mode caps how
   many run at once and only animates what is on screen. Every previous
   element is cleared before a re-render so the cap's bookkeeping never
   holds detached nodes. */
function clearNameFx(container) {
  const api = cv();
  if (!api) return;
  container.querySelectorAll('[data-fx]').forEach(el => api.applyNameFx(el, null));
}

function applyNameFxPreviews(container) {
  const api = cv();
  if (!api) return;
  container.querySelectorAll('[data-fx]').forEach(el => {
    const v = el.dataset.fx;
    if (v) api.applyNameFx(el, v, { managed: true });
  });
}

function itemDescription(item, slot) {
  if (item.description) return item.description;
  const rarity = item.rarity || 'common';
  const rarityLabel = rarity.charAt(0).toUpperCase() + rarity.slice(1);
  const via = SOURCE_LABELS[item.source] || item.source || 'Phamily Time';
  return `${rarityLabel} ${slot.label.toLowerCase()} — earned via ${via}`;
}

/* ── Badge Showcase ──────────────────────────── */

/* Groups, newest month first, then imported sub badges together, then
   anything undated. A flat grid of every badge ever earned
   stopped being pickable around the third month. */
function showcaseGroups(badges) {
  const groups = new Map();
  for (const b of badges) {
    const mk = b.source === 'twitch-import' ? null : itemMonthKey(b);
    const key = b.source === 'twitch-import' ? 'twitch' : (mk || 'undated');
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        order: key === 'twitch' ? '0000-01' : (mk || '0000-00'),
        theme: null,
        items: [],
      });
    }
    const g = groups.get(key);
    if (!g.theme) g.theme = itemTheme(b);
    g.items.push(b);
  }
  for (const g of groups.values()) {
    if (g.key === 'twitch') g.label = 'Twitch Sub Badges';
    else if (g.key === 'undated') g.label = 'Earlier';
    else {
      g.label = [monthLabel(g.key), g.theme, g.key === CURRENT_SEASON ? 'this season' : null]
        .filter(Boolean).join(' · ');
    }
  }
  return [...groups.values()].sort((a, b) => b.order.localeCompare(a.order));
}

function renderShowcaseSection() {
  const badges = profileItems
    .filter(i => i.type === 'badge')
    .sort((a, b) => (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9)
      || String(a.name || '').localeCompare(String(b.name || '')));

  if (badges.length === 0) return '';

  let html = '<div class="collection-category showcase-section">';
  html += `<div class="section-header">Badge Showcase <span class="collection-count">${showcaseSelection.length} / ${SHOWCASE_MAX}</span></div>`;
  html += `<p class="showcase-desc">Pick up to ${SHOWCASE_MAX} badges to show off wherever member interaction happens — leaderboards, game lobbies, and beyond. Anyone who sees your name there sees these.</p>`;

  html += '<div class="showcase-picked">';
  for (let n = 0; n < SHOWCASE_MAX; n++) {
    const id = showcaseSelection[n];
    const b = id ? badges.find(i => i.id === id) : null;
    if (b) {
      html += `
        <button class="showcase-slot filled rarity-${escAttr(b.rarity || 'common')}" data-action="showcase" data-id="${escAttr(b.id)}" title="Remove ${escAttr(b.name)}">
          ${itemFace(b, BADGE_SLOT)}
          <span class="showcase-slot-name">${escName(b.name)}</span>
          <span class="showcase-slot-remove" aria-hidden="true">Remove</span>
        </button>`;
    } else {
      html += '<div class="showcase-slot empty">Empty</div>';
    }
  }
  html += '</div>';

  const atMax = showcaseSelection.length >= SHOWCASE_MAX;
  for (const g of showcaseGroups(badges)) {
    const picked = g.items.filter(i => showcaseSelection.includes(i.id)).length;
    html += `<details class="showcase-group" data-group="${escAttr(g.key)}" ${collapsedGroups.has(g.key) ? '' : 'open'}>`;
    html += `<summary class="showcase-group-title">${escName(g.label)} <span class="collection-count">${g.items.length}${picked ? ` · ${picked} showing` : ''}</span></summary>`;
    html += '<div class="collection-grid showcase-grid">';
    for (const item of g.items) {
      const isSelected = showcaseSelection.includes(item.id);
      html += `
        <div class="collection-item showcase-item ${isSelected ? 'equipped' : ''} rarity-${escAttr(item.rarity || 'common')}">
          ${isSelected ? '<div class="wearing-pill">Showing</div>' : ''}
          ${itemFace(item, BADGE_SLOT)}
          <span class="item-rarity-tag">${escName(item.rarity || 'common')}</span>
          <div class="item-name">${escName(item.name)}</div>
          <button class="pill-btn item-equip-btn" ${atMax && !isSelected ? 'disabled' : ''} data-action="showcase" data-id="${escAttr(item.id)}">
            ${isSelected ? 'Remove' : 'Add to Showcase'}
          </button>
        </div>`;
    }
    html += '</div></details>';
  }

  html += `<button class="btn-primary showcase-save-btn" id="showcaseSaveBtn" data-action="save-showcase">Save Showcase</button>`;
  html += '</div>';
  return html;
}

/* ── Gifting a duplicate ─────────────────────────
   You can only ever gift a cosmetic you hold two or more of; the copy you
   keep is never at risk. functions/api/gift.js enforces the same rule
   server-side — this section only surfaces what is eligible. */

function giftableDuplicates() {
  const counts = new Map();   // id|type -> { item, count }
  for (const it of profileItems) {
    if (!it || it.consumable || !GIFTABLE_TYPES.has(it.type)) continue;
    const key = it.id + '|' + it.type;
    const cur = counts.get(key);
    if (cur) cur.count++;
    else counts.set(key, { item: it, count: 1 });
  }
  return [...counts.values()]
    .filter(g => g.count >= 2)
    .sort((a, b) => (RARITY_ORDER[a.item.rarity] ?? 9) - (RARITY_ORDER[b.item.rarity] ?? 9)
      || String(a.item.name || '').localeCompare(String(b.item.name || '')));
}

function renderGiftSection() {
  const dupes = giftableDuplicates();
  if (dupes.length === 0) return '';

  let html = '<div class="collection-category gift-section">';
  html += `<div class="section-header">Gift a Duplicate <span class="collection-count">${dupes.length} eligible</span></div>`;
  html += `<p class="gift-desc">Hold two or more of the same cosmetic? Pass a spare to another member of the Phamily — the copy you keep stays yours. Pick a duplicate, choose who gets it, done.</p>`;
  html += '<div class="collection-grid gift-grid">';
  for (const g of dupes) {
    const slot = slotOf(g.item) || BADGE_SLOT;
    const rarity = escAttr(g.item.rarity || 'common');
    html += `
      <div class="collection-item gift-item rarity-${rarity} type-${escAttr(g.item.type)}">
        <div class="gift-count-pill">${g.count} owned</div>
        ${itemFace(g.item, slot)}
        <span class="item-rarity-tag">${escName(g.item.rarity || 'common')}</span>
        <div class="item-name">${escName(g.item.name)}</div>
        <button class="pill-btn item-equip-btn" data-action="gift" data-id="${escAttr(g.item.id)}" data-type="${escAttr(g.item.type)}">Gift a spare</button>
      </div>`;
  }
  html += '</div></div>';
  return html;
}

/* The dialog lives on <body>, not inside the collection container, so a
   re-render of the grid never tears it out from under an open gift. */
let giftDialog = null;
let giftState = null;   // { id, type, name, recipient: {login, displayName} | null }
let giftSearchSeq = 0;
let giftSearchTimer = null;

function ensureGiftDialog() {
  if (giftDialog) return giftDialog;
  const d = document.createElement('dialog');
  d.className = 'gift-dialog';
  document.body.appendChild(d);
  giftDialog = d;

  d.addEventListener('click', (e) => {
    const el = e.target.closest('[data-g]');
    if (el) {
      const a = el.dataset.g;
      if (a === 'close') closeGiftDialog();
      else if (a === 'pick') pickGiftRecipient(el.dataset.login, el.dataset.name);
      else if (a === 'clear-recipient') { giftState.recipient = null; renderGiftDialog(); }
      else if (a === 'confirm') submitGift();
      return;
    }
    /* Click on the backdrop (the dialog element itself) closes it. */
    if (e.target === d) closeGiftDialog();
  });

  d.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'giftRecipientInput') runGiftSearch(e.target.value);
  });
  d.addEventListener('cancel', () => { giftState = null; });
  return d;
}

function openGiftDialog(id, type) {
  const g = giftableDuplicates().find(x => x.item.id === id && x.item.type === type);
  if (!g) return;
  giftState = { id, type, name: g.item.name, rarity: g.item.rarity || 'common', recipient: null, status: '', busy: false, done: null };
  ensureGiftDialog();
  renderGiftDialog();
  if (!giftDialog.open) giftDialog.showModal();
  const input = document.getElementById('giftRecipientInput');
  if (input) input.focus();
}

function closeGiftDialog() {
  giftSearchSeq++;
  if (giftDialog && giftDialog.open) giftDialog.close();
  giftState = null;
}

function renderGiftDialog() {
  if (!giftDialog || !giftState) return;
  const s = giftState;

  if (s.done) {
    giftDialog.innerHTML = `
      <div class="gift-dialog-inner">
        <div class="gift-dialog-head"><h2 class="gift-dialog-title">Gift sent</h2></div>
        <p class="gift-dialog-done">You gifted <strong class="rarity-${escAttr(s.done.rarity)}">${escName(s.done.name)}</strong> to <strong>${escName(s.done.to)}</strong>. They'll see it in their inventory.</p>
        <div class="gift-dialog-actions"><button class="btn-primary" data-g="close">Done</button></div>
      </div>`;
    return;
  }

  let picks = '';
  if (s.recipient) {
    picks = `
      <div class="gift-recipient-chosen">
        <span>Gifting to <strong>${escName(s.recipient.displayName)}</strong></span>
        <button class="gift-recipient-change" data-g="clear-recipient">Change</button>
      </div>`;
  } else {
    picks = `
      <label class="gift-field-label" for="giftRecipientInput">Send to</label>
      <input id="giftRecipientInput" class="gift-recipient-input" type="text" autocomplete="off" spellcheck="false" placeholder="Twitch name…" maxlength="30">
      <ul id="giftResults" class="gift-results" hidden></ul>`;
  }

  giftDialog.innerHTML = `
    <div class="gift-dialog-inner">
      <div class="gift-dialog-head">
        <h2 class="gift-dialog-title">Gift a duplicate</h2>
        <button class="gift-dialog-x" data-g="close" aria-label="Close">✕</button>
      </div>
      <p class="gift-dialog-item">Giving away one <strong class="rarity-${escAttr(s.rarity)}">${escName(s.name)}</strong>. Your other copy stays with you.</p>
      ${picks}
      ${s.status ? `<p class="gift-dialog-status">${escName(s.status)}</p>` : ''}
      <div class="gift-dialog-actions">
        <button class="pill-btn" data-g="close">Cancel</button>
        <button class="btn-primary" data-g="confirm" ${s.recipient && !s.busy ? '' : 'disabled'}>${s.busy ? 'Sending…' : 'Send gift'}</button>
      </div>
    </div>`;
}

function runGiftSearch(term) {
  const t = String(term || '').trim();
  clearTimeout(giftSearchTimer);
  const list = document.getElementById('giftResults');
  if (t.length < 2) { giftSearchSeq++; if (list) { list.hidden = true; list.innerHTML = ''; } return; }
  giftSearchTimer = setTimeout(() => {
    const mine = ++giftSearchSeq;
    fetch('/api/profile?q=' + encodeURIComponent(t), { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { results: [] }))
      .then(d => {
        if (mine !== giftSearchSeq) return;
        const el = document.getElementById('giftResults');
        if (!el) return;
        const rows = (d.results || []).filter(r => r.login);
        if (!rows.length) {
          el.innerHTML = '<li class="gift-result-none">Nobody by that name</li>';
          el.hidden = false;
          return;
        }
        el.innerHTML = rows.map(r =>
          `<li><button type="button" class="gift-result" data-g="pick" data-login="${escAttr(r.login)}" data-name="${escAttr(r.displayName || r.login)}">`
          + (r.avatar ? `<img src="${escAttr(r.avatar)}" alt="">` : '<span class="gift-result-blank"></span>')
          + `<span>${escName(r.displayName || r.login)}</span></button></li>`
        ).join('');
        el.hidden = false;
      })
      .catch(() => {});
  }, 220);
}

function pickGiftRecipient(login, name) {
  if (!giftState) return;
  giftState.recipient = { login, displayName: name || login };
  giftState.status = '';
  renderGiftDialog();
}

async function submitGift() {
  if (!giftState || giftState.busy || !giftState.recipient) return;
  giftState.busy = true;
  giftState.status = '';
  renderGiftDialog();

  try {
    const res = await fetch('/api/gift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'gift', itemId: giftState.id, type: giftState.type, toLogin: giftState.recipient.login }),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || !data.success) {
      throw new Error((data && data.error) || ('Server returned ' + res.status));
    }
    /* Drop one local copy so the grid updates without a reload; if that was
       the second-to-last, the duplicate leaves the Gift section entirely. */
    const idx = profileItems.findIndex(i => i && i.id === giftState.id && i.type === giftState.type && !i.consumable);
    if (idx !== -1) profileItems.splice(idx, 1);
    giftState.done = { name: data.item.name, rarity: data.item.rarity || 'common', to: (data.to && data.to.displayName) || giftState.recipient.displayName };
    renderGiftDialog();
    rerender();
  } catch (err) {
    giftState.busy = false;
    giftState.status = (err && err.message) || 'Could not send that gift — try again.';
    renderGiftDialog();
  }
}

/* Raise the "someone gifted you X" bell on page load. The server hands the
   notices over once (read-and-clear); addNotification keys each one so a
   second tab reading nothing, or a re-render, never double-announces. */
function raiseGiftNotices() {
  if (typeof window.addNotification !== 'function') return;
  fetch('/api/gift', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      if (!d || !Array.isArray(d.gifts)) return;
      for (const g of d.gifts) {
        if (!g || !g.item) continue;
        window.addNotification({
          type: 'system',
          key: 'gift:' + g.id,
          message: `${g.fromName || 'Someone'} gifted you ${g.item.name}!`,
        });
      }
    })
    .catch(() => {});
}

function renderFooterTip() {
  return `
    <div class="inv-footer-tip">
      <p>Earn more cosmetics by climbing the <a href="/phamily-time.html">Phamily Time</a> leaderboard, catching a channel point drop, or redeeming a code the moment it's dropped in chat on the <a href="/redeem.html">Redeem</a> page. Once they're yours, they're yours to keep.</p>
    </div>`;
}

function toggleShowcaseBadge(itemId) {
  const idx = showcaseSelection.indexOf(itemId);
  if (idx !== -1) {
    showcaseSelection.splice(idx, 1);
  } else if (showcaseSelection.length < SHOWCASE_MAX) {
    showcaseSelection.push(itemId);
  }
  rerender();
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
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (data && Array.isArray(data.badgeShowcase)) showcaseSelection = data.badgeShowcase.slice();
    profileEquips.badgeShowcase = showcaseSelection.slice();
    if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save Showcase'; btn.disabled = false; }, 1500); }
  } catch {
    if (btn) { btn.textContent = 'Save failed — try again'; btn.disabled = false; }
  }
}

async function toggleProfileEquip(slot, itemId, isEquipped) {
  if (equipBusy) return;
  if (!PROFILE_SLOTS.some(s => s.slot === slot)) return;
  equipBusy = true;
  const newId = isEquipped ? 'none' : itemId;
  const previous = profileEquips[slot];

  if (isEquipped) delete profileEquips[slot];
  else profileEquips[slot] = itemId;
  equipError = '';
  rerender();

  try {
    const res = await fetch('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'equip', game: 'profile', slot, itemId: newId }),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || !data.success) {
      throw new Error((data && data.error) || ('Server returned ' + res.status));
    }
    if (data.equips && typeof data.equips === 'object') {
      const keepShowcase = profileEquips.badgeShowcase;
      profileEquips = { ...data.equips };
      if (keepShowcase && !profileEquips.badgeShowcase) profileEquips.badgeShowcase = keepShowcase;
    }
  } catch (err) {
    if (previous === undefined) delete profileEquips[slot];
    else profileEquips[slot] = previous;
    const verb = isEquipped ? 'unequip' : 'equip';
    equipError = `Couldn't ${verb} that — ${(err && err.message) || 'try again'}.`;
  } finally {
    equipBusy = false;
    rerender();
  }
}

function renderEquipError() {
  if (!equipError) return '';
  return `<p class="inv-equip-error" role="alert">${escName(equipError)}</p>`;
}

function escName(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
