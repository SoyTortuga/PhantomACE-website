/* ══════════════════════════════════════════════
   MTGBBB SET DATA — Scryfall fetch, cache, pool filter, treatment table.

   Two halves, deliberately separated:

     PURE      derivePlayableSets(), deriveSetData(), treatmentLabel()
               take data and return data. No network, no KV. This is what
               server/scripts/test-mtgbbb-sets.js exercises against a
               captured fixture, so the filter that decides what is on a
               bingo card can be proved without touching a free API.

     I/O       listPlayableSets(), loadSetData() wrap those in one fetch
               and one cache read.

   NOTHING HERE MAY BE CALLED DURING A LIVE GAME. A set is fetched once,
   at room creation, and cached under mtgbbb_set_<CODE> forever — a set's
   contents never change. The box is being opened on camera; a slow or
   rate-limited third party must not be able to stall a pull.

   WHAT WAS VERIFIED AGAINST THE LIVE API (2026-09, fourteen real sets):

   * `booster: true` is TRUSTWORTHY FOR THE POOL and NOT for treatments.
     Across dft/tdm/fin/eoe/blb/dsk/tla/fdn/mh3/otj/lci/woe it selects
     exactly the base numbered rare/mythics — 80 names for a typical set,
     60 rare + 20 mythic — and correctly excludes starter-deck, bundle and
     Jumpstart exclusives that are not in any pack. But in most of those
     sets the Booster Fun variants that unquestionably DO come out of Play
     Boosters are flagged `booster: false` (Bloomburrow: 94 of them), while
     in tla and lci the same variants are flagged `true`. The flag tracks
     the base set, not the product. So the pool comes from `booster: true`
     and the treatment table comes from every print of a pooled NAME.

   * `frame_effects` is mostly NOT treatments. It carries mechanical frame
     markers — legendary, enchantment, devoid, lesson, spree — that sit on
     ordinary black-bordered cards. `promo_types` is the same: `ffi`
     through `ffxvi` tag all 94 Final Fantasy rares, `universesbeyond` tags
     every card in tla. Hardcoding those away would rot. Instead the
     baseline below is derived from the set's own plain printings, so any
     signal a plain card carries is by definition not a treatment. That
     kills all twenty-two of those values without naming one of them.
   ══════════════════════════════════════════════ */

import { SQUARES } from './mtgbbb-scoring.js';

/** A set must be able to fill a 5x5 grid or it cannot be played at all. */
export const MIN_POOL = SQUARES;

const API = 'https://api.scryfall.com';
const SET_CACHE_PREFIX = 'mtgbbb_set_';

/* NOT `mtgbbb_set_INDEX`. That would be a key sitting inside the
   `mtgbbb_set_` family with a different lifetime — the exact shape of the
   `item_code_queue`-inside-`item_code_` hack this namespace was designed to
   avoid. This is an exact key, registered as a singleton, and the registry
   resolves exact keys before any prefix. */
const SETS_CACHE_KEY = 'mtgbbb_sets_index';

/* Scryfall asks for both of these on every request and is within its
   rights to start refusing traffic that omits them. */
const HEADERS = {
  'User-Agent': 'PhantomACE-MTGBBB/1.0 (+https://phantomace.tv)',
  Accept: 'application/json',
};

/** Bumped when the derived shape changes, so old cache entries rebuild. */
export const DATA_VERSION = 1;

/* ── The set dropdown ────────────────────────────────────────────────── */

/* /sets carries no `booster` field, so "has boosters" has to come from
   set_type. These five are the types that ship in sealed product people
   crack on stream. Everything else — promo, token, memorabilia, commander,
   box, duel_deck, minigame, masterpiece, alchemy — is either not a pack or
   not paper. */
const PLAYABLE_SET_TYPES = new Set([
  'core', 'expansion', 'draft_innovation', 'masters', 'funny',
]);

/* Welcome decks and gift packs share a set_type with real products and are
   a dozen cards. The real guard is the pool count after the fetch; this
   only keeps obvious non-products out of a dropdown. */
const MIN_CARD_COUNT = 50;

/* A prerelease is about a week ahead of the official date, and a set is
   worth listing once boxes are in hand. Beyond that the card data is
   spoiler-season guesswork and the pool would be wrong. */
const FUTURE_GRACE_DAYS = 30;

/**
 * The dropdown: real paper sets with boosters, newest first.
 * @param {object[]} sets raw Scryfall /sets data
 * @param {number} [now] epoch ms, injectable so the test is not time-bound
 */
export function derivePlayableSets(sets, now = Date.now()) {
  const horizon = now + FUTURE_GRACE_DAYS * 86400000;

  return (sets || [])
    .filter(s => s && PLAYABLE_SET_TYPES.has(s.set_type))
    .filter(s => !s.digital)
    /* A parent_set_code means this is a sub-set of another — Timeshifts,
       Jumpstart exclusives, foreign black border. They are not a box. */
    .filter(s => !s.parent_set_code)
    .filter(s => (s.card_count || 0) >= MIN_CARD_COUNT)
    .filter(s => {
      const t = Date.parse(s.released_at || '');
      return Number.isFinite(t) && t <= horizon;
    })
    .map(s => ({
      code: String(s.code || '').toLowerCase(),
      name: s.name || '',
      releasedAt: s.released_at || '',
      setType: s.set_type || '',
      cardCount: s.card_count || 0,
      icon: s.icon_svg_uri || '',
      label: `${String(s.code || '').toUpperCase()} — ${s.name || ''}`,
    }))
    .sort((a, b) =>
      (a.releasedAt < b.releasedAt ? 1 : a.releasedAt > b.releasedAt ? -1 : 0) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/* ── Treatments ──────────────────────────────────────────────────────── */

/* Prints that came from something other than a booster. Excluded before
   any treatment is read off them, so a buy-a-box promo's foil stamp never
   becomes a chip the moderator can tick.

   `serialized` is here because the plan says so and the plan is right:
   serialized cards are not in Play Boosters, and offering the chip would
   invite a mistick worth a point nobody could earn. */
const NON_BOOSTER_PROMO_TYPES = new Set([
  'bundle', 'buyabox', 'boxtopper', 'starterdeck', 'startercollection',
  'beginnerbox', 'planeswalkerdeck', 'prerelease', 'promopack', 'setpromo',
  'release', 'gameday', 'judgegift', 'wizardsplaynetwork', 'convention',
  'openhouse', 'fnm', 'themepack', 'intropack', 'giftbox', 'draftweekend',
  'arenaleague', 'playerrewards', 'instore', 'datestamped', 'stamped',
  'schoolsout', 'serialized',
]);

/* An umbrella marker, not a treatment. Every borderless, showcase and
   extended-art print carries it, so scoring it would pay a second point
   for the treatment already being scored. */
const UMBRELLA_PROMO_TYPES = new Set(['boosterfun']);

/* Signals that are mechanical no matter what the set's own baseline says.
   The baseline handles these in every real set; this exists for the set
   where every rare is a variant and there are no plain printings to learn
   from. Belt and braces on the one thing a bad answer costs points for. */
const ALWAYS_MECHANICAL = new Set([
  'legendary', 'miracle', 'enchantment', 'nyxtouched', 'draft', 'devoid',
  'tombstone', 'colorshifted', 'sunmoondfc', 'compasslanddfc', 'originpwdfc',
  'mooneldrazidfc', 'waxingandwaningmoondfc', 'companion', 'snow',
  'convertdfc', 'fandfc', 'upsidedowndfc', 'lesson', 'spree', 'vehicle',
  'universesbeyond', 'rebalanced', 'alchemy', 'thick',
]);

/* Curated, NOT from Scryfall — Scryfall does not model which product a
   printing came out of, and there is no field that says "Collector
   Booster". These are the exotic foil processes that have never been in a
   Play Booster. The flag only decides whether the chip starts ticked in
   the moderator's list, which is adjustable and then frozen into the room,
   so a wrong guess here costs a click and never costs a point. */
const COLLECTOR_ONLY = new Set([
  'raisedfoil', 'oilslick', 'gilded', 'textured', 'halofoil', 'galaxyfoil',
  'surgefoil', 'neonink', 'confettifoil', 'doublerainbow', 'invisibleink',
  'stepandcompleat', 'manafoil', 'rainbowfoil', 'firstplacefoil',
  'singularityfoil', 'chocobotrackfoil', 'ripplefoil', 'fracturefoil',
  'embossed', 'dossier', 'poster', 'concept',
]);

const LABELS = {
  foil: 'Foil',
  etched: 'Etched Foil',
  glossy: 'Glossy Foil',
  borderless: 'Borderless',
  fullart: 'Full Art',
  textless: 'Textless',
  retro: 'Retro Frame',
  showcase: 'Showcase',
  extendedart: 'Extended Art',
  inverted: 'Inverted Frame',
  shatteredglass: 'Shattered Glass',
  japanshowcase: 'Japanese Showcase',
  doubleexposure: 'Double Exposure',
  concept: 'Concept Art',
  portrait: 'Portrait Frame',
  headliner: 'Headliner',
  halofoil: 'Halo Foil',
  surgefoil: 'Surge Foil',
  galaxyfoil: 'Galaxy Foil',
  fracturefoil: 'Fracture Foil',
  raisedfoil: 'Raised Foil',
  neonink: 'Neon Ink',
  textured: 'Textured Foil',
  manafoil: 'Mana Foil',
  rainbowfoil: 'Rainbow Foil',
  doublerainbow: 'Double Rainbow Foil',
  firstplacefoil: 'First Place Foil',
  singularityfoil: 'Singularity Foil',
  chocobotrackfoil: 'Chocobo Track Foil',
  ripplefoil: 'Ripple Foil',
  oilslick: 'Oil Slick Raised Foil',
  gilded: 'Gilded Frame',
  confettifoil: 'Confetti Foil',
  stepandcompleat: 'Step-and-Compleat Foil',
  invisibleink: 'Invisible Ink',
  embossed: 'Embossed',
  dossier: 'Dossier',
  schematic: 'Schematic',
  poster: 'Poster Frame',
};

/* Scryfall's enums are lowercase run-ons. A new one appearing mid-season
   must show up as something a moderator can read at speed on camera, not
   as `surgefoil` and not as nothing at all. */
const WORDS = [
  'showcase', 'borderless', 'extended', 'etched', 'glossy', 'textless',
  'shattered', 'glass', 'exposure', 'double', 'rainbow', 'raised', 'ripple',
  'confetti', 'invisible', 'singularity', 'chocobo', 'fracture', 'schematic',
  'compleat', 'embossed', 'headliner', 'portrait', 'concept', 'textured',
  'gilded', 'galaxy', 'surge', 'japan', 'first', 'place', 'track', 'neon',
  'halo', 'mana', 'full', 'slick', 'retro', 'oil', 'ink', 'art', 'foil',
  'frame', 'step', 'and', 'poster',
];

/** A readable label for any treatment id, known or not. */
export function treatmentLabel(id) {
  if (LABELS[id]) return LABELS[id];

  const raw = String(id || '');
  const parts = [];
  let i = 0;
  while (i < raw.length) {
    const word = WORDS.find(w => raw.startsWith(w, i));
    if (word) { parts.push(word); i += word.length; continue; }
    /* Unrecognised run of characters: take it up to the next word that
       does match, so `zanyfoil` degrades to "Zany Foil" rather than to a
       single unreadable blob. */
    let j = i + 1;
    while (j < raw.length && !WORDS.some(w => raw.startsWith(w, j))) j++;
    parts.push(raw.slice(i, j));
    i = j;
  }

  return parts
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ') || raw;
}

/** Scryfall hides images inside card_faces on double-faced cards. */
function imagesOf(card) {
  const src = card.image_uris ||
    (Array.isArray(card.card_faces) && card.card_faces[0] &&
      card.card_faces[0].image_uris) || null;
  return {
    image: (src && src.small) || '',
    art: (src && src.normal) || '',
  };
}

function isPaper(card) {
  const games = card.games;
  return !Array.isArray(games) || games.includes('paper');
}

/** Sold separately from any pack, so nothing on it is a booster treatment. */
function fromBooster(card) {
  if (card.promo) return false;
  if (!isPaper(card)) return false;
  return !(card.promo_types || []).some(p => NON_BOOSTER_PROMO_TYPES.has(p));
}

/**
 * A plain printing: the card as the set prints it by default.
 *
 * Whatever these carry is the set's own baseline and is not a treatment.
 * This is what makes `legendary`, `enchantment`, `universesbeyond` and the
 * sixteen `ffN` tags disappear without a hardcoded list of them.
 */
function isPlain(card) {
  return card.border_color === 'black' &&
    !card.full_art &&
    !card.textless &&
    !(card.promo_types || []).includes('boosterfun');
}

function signalsOf(card) {
  const out = [];
  if (card.border_color === 'borderless') out.push('borderless');
  if (card.full_art) out.push('fullart');
  if (card.textless) out.push('textless');
  if (card.frame === '1997') out.push('retro');
  for (const f of card.frame_effects || []) out.push(f);
  for (const p of card.promo_types || []) {
    if (!UMBRELLA_PROMO_TYPES.has(p)) out.push(p);
  }
  for (const f of card.finishes || []) {
    if (f !== 'nonfoil') out.push(f);
  }
  return out;
}

/**
 * Everything a room needs to know about a set, from its raw print list.
 *
 * @param {object[]} prints  every rare/mythic print, unique=prints
 * @param {object} setInfo   the Scryfall set object
 */
export function deriveSetData(prints, setInfo = {}) {
  const all = (prints || []).filter(c => c && (c.rarity === 'rare' || c.rarity === 'mythic'));

  /* THE POOL. `booster: true` and nothing else — see the header. Collapsed
     by name, because a square is a name and the variant printings of one
     card are the same square. Lowest collector number wins the image, which
     is the base printing rather than whichever variant sorted first. */
  const byName = new Map();
  for (const c of all) {
    if (!c.booster) continue;
    const prev = byName.get(c.name);
    const n = parseInt(c.collector_number, 10);
    const num = Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
    if (prev && prev.num <= num) continue;
    byName.set(c.name, { card: c, num });
  }

  const cards = [...byName.entries()]
    .map(([name, { card }]) => ({
      name,
      rarity: card.rarity,
      url: card.scryfall_uri || '',
      ...imagesOf(card),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  /* THE TREATMENTS. Every print of a pooled name, not just the ones
     Scryfall flagged as in-booster, because that flag tracks the base set
     and would drop the entire Booster Fun table in most sets. */
  const relevant = all.filter(c => byName.has(c.name) && fromBooster(c));

  const baseline = new Set(ALWAYS_MECHANICAL);
  for (const c of relevant) {
    if (!isPlain(c)) continue;
    for (const f of c.frame_effects || []) baseline.add(f);
    for (const p of c.promo_types || []) baseline.add(p);
  }

  const counts = new Map();
  for (const c of relevant) {
    for (const s of new Set(signalsOf(c))) {
      if (baseline.has(s)) continue;
      counts.set(s, (counts.get(s) || 0) + 1);
    }
  }

  const treatments = [...counts.entries()]
    .map(([id, prints_]) => ({
      id,
      label: treatmentLabel(id),
      prints: prints_,
      collectorOnly: COLLECTOR_ONLY.has(id),
    }))
    /* Play-Booster treatments first, then by how many printings carry them:
       the chips a moderator reaches for most sit nearest the front. */
    .sort((a, b) =>
      (a.collectorOnly === b.collectorOnly ? 0 : a.collectorOnly ? 1 : -1) ||
      (b.prints - a.prints) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let rare = 0, mythic = 0;
  for (const c of cards) { if (c.rarity === 'mythic') mythic++; else rare++; }

  return {
    version: DATA_VERSION,
    code: String(setInfo.code || '').toLowerCase(),
    name: setInfo.name || '',
    releasedAt: setInfo.released_at || '',
    setType: setInfo.set_type || '',
    icon: setInfo.icon_svg_uri || '',
    cards,
    treatments,
    counts: { rare, mythic, total: cards.length, prints: all.length },
    playable: cards.length >= MIN_POOL,
  };
}

/** The refusal text, in one place so the route and create.js agree. */
export function unplayableReason(data) {
  const n = data && data.counts ? data.counts.total : 0;
  if (!n) {
    return 'Scryfall has no booster-pool rares or mythics for this set yet. ' +
      'Unreleased sets often have no pack data until release day — pick another set.';
  }
  return `This set has only ${n} rare/mythic cards in its booster pool and ` +
    `MTGBBB needs ${MIN_POOL} to fill a card. Pick a different set.`;
}

/* ── Scryfall ────────────────────────────────────────────────────────── */

async function scryfall(url) {
  const res = await fetch(url, { headers: HEADERS });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body || body.object === 'error') {
    const detail = (body && body.details) || `HTTP ${res.status}`;
    const err = new Error(`Scryfall: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Follow next_page to the end. A large set is three pages of 175. */
async function searchAll(query) {
  const params = new URLSearchParams({
    q: query, unique: 'prints', order: 'set', format: 'json',
  });
  let url = `${API}/cards/search?${params}`;
  const out = [];
  /* A guard, not a limit: the biggest set here is two pages, and a
     next_page that never terminates must not become an infinite loop
     inside a request the moderator is waiting on. */
  for (let page = 0; url && page < 25; page++) {
    const body = await scryfall(url);
    out.push(...(body.data || []));
    url = body.has_more ? body.next_page : null;
  }
  return out;
}

/* ── Cache ───────────────────────────────────────────────────────────── */

/* The set list changes a few times a year. A day is short enough that a
   new set appears the day it is announced and long enough that the
   dropdown is one KV read on every load but the first. */
const SETS_TTL = 86400;

/** The dropdown. Cached; hits Scryfall at most once a day. */
export async function listPlayableSets(env, { refresh = false } = {}) {
  if (!refresh) {
    const cached = await env.MARKETPLACE.get(SETS_CACHE_KEY, 'json');
    if (cached && Array.isArray(cached.sets)) return cached.sets;
  }

  const body = await scryfall(`${API}/sets`);
  const sets = derivePlayableSets(body.data || []);

  await env.MARKETPLACE.put(
    SETS_CACHE_KEY,
    JSON.stringify({ sets, fetchedAt: Date.now() }),
    { expirationTtl: SETS_TTL },
  );
  return sets;
}

export function setCacheKey(code) {
  return SET_CACHE_PREFIX + String(code || '').toUpperCase();
}

/**
 * A set's pool and treatment table, fetched once and then cached forever.
 *
 * AN UNPLAYABLE SET IS NOT CACHED. A pool below 25 on a modern set means
 * Scryfall has not published that set's pack data yet, not that the set is
 * small — and caching "forever" would freeze that gap in place for a set
 * that will be perfectly playable next week. Nothing but a moderator at
 * room creation can reach this, so the cost of refetching is one request.
 */
export async function loadSetData(env, code) {
  const key = setCacheKey(code);

  const cached = await env.MARKETPLACE.get(key, 'json');
  if (cached && cached.version === DATA_VERSION) return cached;

  const lower = String(code || '').toLowerCase();
  const setInfo = await scryfall(`${API}/sets/${encodeURIComponent(lower)}`);
  const prints = await searchAll(`e:${lower} (r:rare or r:mythic)`);
  const data = deriveSetData(prints, setInfo);
  data.fetchedAt = Date.now();

  if (data.playable) await env.MARKETPLACE.put(key, JSON.stringify(data));
  return data;
}
