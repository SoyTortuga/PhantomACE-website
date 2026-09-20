/* ══════════════════════════════════════════════
   DINO PARK API
   Cross-device save sync for logged-in players.
   Guests keep localStorage-only saves (see games/dino-park/index.html);
   this endpoint exists purely so a logged-in player's park follows
   their Twitch account across devices.
   ══════════════════════════════════════════════ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function saveKey(userId) {
  return `dino_park_${userId}`;
}

/* MUST MATCH `SAVE_EPOCH` in games/dino-park/index.html.

   The client discards any save whose epoch differs, so this value is
   stamped onto states created here — otherwise a player who redeems an
   egg while having no save yet gets a state the client throws away on
   sight, and the egg silently disappears.

   Like ROSTER_BY_RARITY above, this is hand-synced because a Pages
   Function cannot import from the game's inline <script>. */
const SAVE_EPOCH = 2;

/* ══════════════════════════════════════════════
   SPECIES ROSTER (by rarity) & HATCH TIMES
   Intentionally duplicated from games/dino-park/index.html's
   ROSTER / HATCH_TIMES constants. A Cloudflare Pages Function can't
   import from the game's inline <script> — there is no shared module
   between them — so keep this list in sync by hand if the client
   roster ever changes (species added/removed/re-tiered, or hatch
   times rebalanced).
   ══════════════════════════════════════════════ */

const HATCH_TIMES = { common: 1800, uncommon: 3600, rare: 7200, epic: 14400, legendary: 28800 };

const ROSTER_BY_RARITY = {
  common: ['compy','proto','galli','coelo','dimetro','iguan','dimor','pachy','kentro','ovira','micro','archae','dodo','ornitho','guanl','hetero','plat','psitt','sinosaur','ptdac'],
  uncommon: ['raptor','dilopho','stego','para','baryo','cory','styra','rhamph','ichthy','megalo','utah','deino','cerato','trood','concav','stygi','anhan','tape','nycto','notho','archel','tbird','cbear','dwolf','glypto','entelo'],
  rare: ['trike','allo','anky','diplo','carno','plesio','pterano','brachio','smilo','therizo','amarg','cryo','deinoch','mamen','tylo','shoni','heli','megarach','wrhino','clion','gsloth','masto'],
  epic: ['trex','spino','apato','gigano','mosa','bronto','mammoth','elasmo','hatz','dunky','krono','andrew'],
  legendary: ['argent','megashark','quetz','liopl','anomal'],
};

function rollSpeciesId(rarity) {
  const pool = ROSTER_BY_RARITY[rarity];
  if (!pool || !pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* Mirrors the client's getMaxIncubatorSlots(): 3 base slots + 3 per
   subscriber tier. subTier (0-3) is read from the player's last-synced
   state, since this server function has no live Twitch role check —
   only the game client (via applySubTierFromSession) resolves the
   Twitch subscription role and writes it into state.subTier on each
   sync. A brand-new record defaults subTier to 0, same as a new player. */
function getMaxIncubatorSlots(state) {
  return 3 + (state.subTier || 0) * 3;
}

/* Mirrors the client's default `let state = {...}` shape (see
   games/dino-park/index.html) for a player who has never synced. */
function defaultState() {
  return {
    saveEpoch: SAVE_EPOCH,
    coins: 100, level: 1, xp: 0, park: [], vault: [], eggs: [],
    discovered: [], discoveredMutations: [], cooldowns: {},
    lastTick: Date.now(), energy: 10, subTier: 0, debris: [],
    lastDebrisSpawn: 0, yardItems: [], lastOvergrowth: 0, parkDay: 1,
    lastStreamStart: 0, liveSecAccum: 0, lastDecayLiveSec: 0, usedCodes: [],
  };
}

/* ── grantEgg — server-authoritative egg grant for redemption codes ──
   Called by the cosmetics redemption system (functions/api/item-codes.js)
   after it resolves a code to a Dino Park reward. `rarity` must already
   be one of Dino Park's own tiers ('common'|'uncommon'|'rare'|'epic'|
   'legendary') — this function has no notion of a site-wide "mythic"
   tier, so any such translation must happen on the caller's side before
   calling here. Always produces a species AT the requested rarity
   (never weighted toward it). Returns {success:false, error} if the
   incubator is full so the caller can avoid marking the code consumed. */
/**
 * @param {object} [opts]
 * @param {boolean} [opts.guaranteedMutation] the hatch must produce a
 *   mutation. Mutations are rolled by the CLIENT at hatch time (~18% chance),
 *   so this cannot be decided here — it is recorded on the egg and honoured
 *   by hatchEgg() in games/dino-park/index.html. An older client simply
 *   ignores the flag and rolls normally, which is a silent downgrade rather
 *   than a break.
 */
export async function grantEgg(env, userId, rarity, opts = {}) {
  if (!userId) return { success: false, error: 'Missing user' };
  if (!HATCH_TIMES[rarity]) return { success: false, error: 'Invalid rarity' };

  const speciesId = rollSpeciesId(rarity);
  if (!speciesId) return { success: false, error: 'Invalid rarity' };

  /* ── WHY THIS IS UNDER A LOCK ───────────────────────────────────────
     This used to be a get, a push, and a put — three separate operations.
     Two redemptions arriving close together both read the same state, both
     appended their egg to that same snapshot, and both wrote it back: last
     writer won and the other egg vanished. It was not theoretical. A player
     redeeming twelve codes in one sitting received two eggs, because ten
     grants overwrote each other.

     mutate() takes an advisory lock on the key for the duration, so the
     read and the write are one atomic step and concurrent grants queue
     instead of colliding. The mutator returns undefined to opt out of
     writing, which is how the incubator-full case leaves the record
     untouched. */
  let outcome = null;

  await env.MARKETPLACE.mutate(saveKey(userId), (record) => {
    /* A pre-epoch record is treated as no record at all. Pushing the egg
       into a stale state would write a state the client discards on its
       next load, taking the egg with it. */
    const usable = (record && record.state && record.state.saveEpoch === SAVE_EPOCH)
      ? record.state
      : null;
    const state = usable || defaultState();
    if (!Array.isArray(state.eggs)) state.eggs = [];

    if (state.eggs.length >= getMaxIncubatorSlots(state)) {
      outcome = { full: true };
      return undefined;                    // no write; caller overflows to inventory
    }

    /* grantId identifies this specific grant so a client can tell an egg it
       has never seen from one it already has, and merge without duplicating.
       grantSeq is the optimistic-concurrency token: onRequestPost refuses any
       save carrying an older value. Together they are what stops the client's
       next full-state POST from destroying this egg. */
    const egg = {
      speciesId,
      hatchTime: HATCH_TIMES[rarity],
      elapsed: 0,
      grantId: crypto.randomUUID(),
    };
    if (opts.guaranteedMutation) egg.guaranteedMutation = true;

    state.eggs.push(egg);
    state.grantSeq = Number(state.grantSeq || 0) + 1;
    state.lastTick = Date.now();

    outcome = { egg };
    return { userId, state, savedAt: Date.now() };
  });

  if (!outcome) return { success: false, error: 'Grant failed' };
  if (outcome.full) return { success: false, error: 'Incubator full' };

  return {
    success: true,
    egg: {
      speciesId: outcome.egg.speciesId,
      hatchTime: outcome.egg.hatchTime,
      guaranteedMutation: !!outcome.egg.guaranteedMutation,
    },
  };
}

/* ── GET — fetch the player's cloud save ──────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);

  const url = new URL(request.url);
  const visit = url.searchParams.get('visit');
  if (visit) return await visitPark(env, session, visit);

  const record = await env.MARKETPLACE.get(saveKey(session.user_id), 'json');
  if (!record) return json({ hasSave: false, state: null });

  return json({
    hasSave: true,
    state: record.state,
    savedAt: record.savedAt || 0,
    /* Read from the consent row, never from the save, so the toggle always
       reflects what the listing will actually do. */
    visitable: !!(await env.MARKETPLACE.get(visitKey(session.user_id), 'json')),
  });
}

/**
 * Serve somebody else's park, or pick one at random.
 *
 * Requires a session of its own. Not because the projection is unsafe
 * without one — it is the same data either way — but because an endpoint
 * that hands out a random player on every anonymous request is an
 * enumeration tool, and the people listed here opted into being visited by
 * other players rather than by anyone with curl.
 */
async function visitPark(env, session, target) {
  let userId = target;

  if (target === 'random') {
    const listed = await env.MARKETPLACE.list({ prefix: VISIT_KEY_PREFIX });
    /* Own park excluded: "visit a random park" landing on your own reads
       as the button being broken. */
    const others = (listed.keys || [])
      .map(k => k.name.slice(VISIT_KEY_PREFIX.length))
      .filter(id => String(id) !== String(session.user_id));
    if (!others.length) return json({ error: 'No parks are open to visitors yet.' }, 404);
    userId = others[Math.floor(Math.random() * others.length)];
  }

  if (!/^[0-9]{1,20}$/.test(String(userId))) return json({ error: 'Unknown park' }, 404);

  /* THE CONSENT CHECK, and it is deliberately before the read. Opting out
     has to take effect immediately; checking afterwards would mean a park
     stayed visitable for as long as anyone held its id. */
  const pass = await env.MARKETPLACE.get(visitKey(userId), 'json');
  if (!pass) return json({ error: 'That park is not open to visitors.' }, 403);

  const record = await env.MARKETPLACE.get(saveKey(userId), 'json');
  if (!record) return json({ error: 'That park is empty.' }, 404);

  return json({
    visiting: true,
    ownerName: String(pass.name || 'A keeper').slice(0, VISIT_NAME_MAX),
    park: projectPark(record.state),
  });
}

/* ── POST — persist the player's current state ── */

/* ══ THE FAVOURITE ══════════════════════════════════════════════════
   One dino, chosen by the player, rendered on their PUBLIC profile.

   The park save is stored wholesale and never read by the server, which is
   harmless while the document is private to one person. The favourite
   breaks that: it is the first part of this state that other people see, so
   it is the first part that cannot be taken on trust.

   `src` is the dangerous field. Left open it accepts any URL, which puts an
   arbitrary third-party image — a tracking pixel, or worse — on a public
   page under somebody else's name. It is restricted to this game's own
   asset tree or an inline image, because those are the only two things the
   game legitimately produces.

   `filter` is the subtle one. It lands in a style attribute, so anything
   that can close that attribute or smuggle a url() is an injection. Only
   the characters CSS filter functions are built from are allowed. */
const FAV_ID = /^[a-z0-9_-]{1,40}$/i;
const FAV_SRC_ASSET = /^\/games\/dino-park\/assets\/[a-z0-9/_. -]+\.(png|webp)$/i;
const FAV_SRC_INLINE = /^data:image\/(png|webp);base64,[a-z0-9+/=]+$/i;
const FAV_SRC_MAX = 24000;
const FAV_FILTER_OK = /^[a-z0-9()%.,\s-]{0,200}$/i;

export function sanitizeFavorite(fav) {
  if (!fav || typeof fav !== 'object') return null;

  const specId = String(fav.specId || '');
  if (!FAV_ID.test(specId)) return null;

  const src = String(fav.src || '');
  if (src.length > FAV_SRC_MAX) return null;
  if (!FAV_SRC_ASSET.test(src) && !FAV_SRC_INLINE.test(src)) return null;

  const mutation = fav.mutation ? String(fav.mutation) : '';
  const filter = String(fav.filter || '');
  /* Belt and braces on the filter: the charset alone would already exclude
     these, but they are the exact things that make it an injection and are
     worth refusing by name rather than by implication. */
  const filterSafe = FAV_FILTER_OK.test(filter) &&
    !/url\(|;|\}|<|expression/i.test(filter);

  /* The portrait is a second image on the same terms as the first: it is
     rendered on the same public page, so an unchecked one is the same hole
     twice. A portrait that fails validation is dropped rather than fatal —
     the stat block reads fine without it, and the icon still stands in. */
  const portrait = String(fav.portrait || '');
  const portraitOk = portrait.length <= FAV_SRC_MAX &&
    (FAV_SRC_ASSET.test(portrait) || FAV_SRC_INLINE.test(portrait));

  const pFilter = String(fav.portraitFilter || '');
  const pFilterSafe = FAV_FILTER_OK.test(pFilter) &&
    !/url\(|;|\}|<|expression/i.test(pFilter);

  /* The stat block is the game's own copy, not the player's, so it is
     capped rather than pattern-matched — a species name or an era is prose
     and refusing one for containing a hyphen would be worse than useless.
     Every one of these is escaped at render like the nickname. */
  const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  return {
    specId,
    mutation: FAV_ID.test(mutation) ? mutation : '',
    /* Player-authored, so it is length-capped here and escaped at render.
       Stored as written; nothing reconstructs markup from it. */
    nickname: String(fav.nickname || '').trim().slice(0, 24),
    src,
    filter: filterSafe ? filter : '',
    portrait: portraitOk ? portrait : '',
    portraitFilter: portraitOk && pFilterSafe ? pFilter : '',
    species: text(fav.species, 40),
    rarity: text(fav.rarity, 20),
    diet: text(fav.diet, 20),
    habitat: text(fav.habitat, 20),
    era: text(fav.era, 30),
    build: text(fav.build, 20),
    desc: text(fav.desc, 300),
    mutationLabel: text(fav.mutationLabel, 30),
    at: Date.now(),
  };
}

/* ══ VISITING ═══════════════════════════════════════════════════════════
   Letting other people look at a park inverts the assumption this file is
   built on, stated above sanitizeFavorite: the save is stored wholesale
   and never read by the server, which is only harmless while exactly one
   person can see it. The client writes that document, so every field in it
   is attacker-controlled — nicknames included, and nicknames are rendered.

   So a visitor is never served the record. They are served a PROJECTION:
   a fixed list of fields, each one validated, everything else dropped by
   omission rather than by a denylist. A field added to the save later is
   private by default and stays that way until somebody adds it here on
   purpose.

   OPT-IN. A park is invisible until its owner turns visiting on, and the
   flag is stored as its own row rather than read out of the save — the
   listing has to be enumerable without loading and parsing every player's
   park document, and a row nobody else can write is a consent record.
   ══════════════════════════════════════════════════════════════════════ */

const VISIT_KEY_PREFIX = 'parkpub_';
const visitKey = (userId) => `${VISIT_KEY_PREFIX}${userId}`;

/* One row per consenting player. Kept deliberately tiny: enough to draw a
   list entry without opening anybody's save. */
const VISIT_NAME_MAX = 40;
/* A park holds at most MAX_ACTIVE_PARK dinos, but the save is client-
   written, so the cap is enforced here rather than assumed. */
const VISIT_PARK_MAX = 40;
/* MAX_YARD_ITEMS is 14 in the game; the cap here is deliberately looser so
   a legitimate park is never truncated, and exists only to bound what a
   doctored save can ask a visitor's browser to draw. */
const VISIT_YARD_MAX = 40;

/**
 * The public view of one dino. Whitelist, not cleanup.
 *
 * `nickname` is the field that matters. It is player-authored free text
 * that ends up inside innerHTML on someone else's screen, so it is capped
 * here and escaped at render — both, because either alone has been enough
 * to be wrong before.
 */
/**
 * A position percentage, clamped into the world.
 *
 * NOT COSMETIC. The park renderer derives stacking from the y coordinate —
 * `z-index: 3 + Math.round(it.y / 10)` — so an unclamped y out of a
 * client-written save is an arbitrary z-index, and an arbitrary z-index is
 * one decoration painted over the entire interface. Clamping here is what
 * stops a hostile park from covering its visitor's screen.
 */
function pct(v, fallback = 50) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
}

function projectDino(d) {
  if (!d || typeof d !== 'object') return null;
  const speciesId = String(d.speciesId || '');
  if (!FAV_ID.test(speciesId)) return null;

  const mutation = String(d.mutation || '');
  const num = (v, max) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
  };

  return {
    speciesId,
    mutation: FAV_ID.test(mutation) ? mutation : '',
    /* Stored as written, capped, never reassembled into markup. */
    nickname: String(d.nickname || '').trim().slice(0, 24),
    careCount: num(d.careCount, 1_000_000),
    xp: num(d.xp, 1_000_000_000),
    /* Where it is standing, so the park can be drawn rather than listed. */
    px: pct(d.px), py: pct(d.py),
    facing: Number(d.facing) === -1 ? -1 : 1,
  };
}

/**
 * A placed decoration.
 *
 * ONLY THE TYPE CROSSES THE WIRE, never a src. The visitor's own copy of
 * YARD_ITEM_TYPES resolves the image, so the set of things that can be
 * drawn is fixed by the game rather than chosen by whoever wrote the save.
 * A type the visitor does not recognise draws nothing. This is the same
 * reason debris is not projected at all: its records carry a client-authored
 * `src`, which is a URL somebody else's browser would fetch.
 */
function projectYardItem(it) {
  if (!it || typeof it !== 'object') return null;
  const type = String(it.type || '');
  if (!FAV_ID.test(type)) return null;
  return { type, x: pct(it.x), y: pct(it.y) };
}

/**
 * The public view of a park.
 *
 * Roster only. Coins, eggs, the vault, cooldowns, energy, yard layout and
 * dig timers are all absent — not stripped, simply never named. Visiting
 * is for looking at someone's dinosaurs, and every extra field would be
 * another thing to get right for no added reason to visit.
 */
function projectPark(state) {
  const s = (state && typeof state === 'object') ? state : {};
  const park = Array.isArray(s.park) ? s.park : [];
  const yard = Array.isArray(s.yardItems) ? s.yardItems : [];
  return {
    park: park.slice(0, VISIT_PARK_MAX).map(projectDino).filter(Boolean),
    /* The decorations ARE the point of visiting — a park you can look at
       rather than a list you can read. Capped well above the in-game limit
       so a legitimate park always arrives whole while a doctored save still
       cannot ask the visitor to draw ten thousand sprites. */
    yardItems: yard.slice(0, VISIT_YARD_MAX).map(projectYardItem).filter(Boolean),
    /* The BACKGROUND ID, never a URL. Backgrounds are unlockable
       cosmetics and each one carries its own walkability mask, so a
       visitor must draw the owner's scenery or the dinos appear on the
       wrong terrain — an aquatic one standing on grass. The viewer
       resolves the art from its own table and falls back when it does not
       recognise the id, which is also what keeps a save file from naming
       an image somebody else's browser will fetch. */
    background: FAV_ID.test(String(s.background || '')) ? String(s.background) : '',
    parkDay: Math.max(1, Math.min(100000, Math.floor(Number(s.parkDay) || 1))),
    speciesDiscovered: Array.isArray(s.discovered) ? s.discovered.length : 0,
    /* Already sanitised on write by sanitizeFavorite, and re-run here
       because this is a different reader and the stored value predates
       that function for some saves. */
    favorite: sanitizeFavorite(s.favorite),
  };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  /* ── Opt in or out of being visited ──
     Its own action rather than a field on the save, because consent must
     not ride along inside a document the client rewrites wholesale every
     few seconds — a stale save would silently re-open a park somebody had
     just closed. The name is taken from the SESSION, never from the
     request, so nobody can list themselves under another person's name. */
  if (body.action === 'set-visitable') {
    if (body.visitable) {
      await env.MARKETPLACE.put(visitKey(session.user_id), JSON.stringify({
        name: String(session.display_name || 'A keeper').slice(0, VISIT_NAME_MAX),
        since: Date.now(),
      }));
    } else {
      await env.MARKETPLACE.delete(visitKey(session.user_id));
    }
    return json({ success: true, visitable: !!body.visitable });
  }

  if (!body || typeof body.state !== 'object' || body.state === null) {
    return json({ error: 'Missing state' }, 400);
  }

  /* ── The save is a wholesale replace, so it must be refused when the
        client has not seen the latest grant. ────────────────────────────

     The client POSTs its ENTIRE state every 20 seconds. grantEgg writes
     directly to the same record. So a player who had the game open while
     redeeming a code used to lose the egg: the next save overwrote it with
     state captured before the grant, and they saw a success toast and no
     egg. Nothing detected it, because a blind PUT cannot.

     grantSeq lives inside the state document, so the client round-trips it
     for free. If the stored value is ahead, this save predates a grant —
     reject it and hand back the current state so the client can merge the
     egg in and retry. Rejecting costs at most the few seconds of progress
     in that one request; accepting costs the reward. */
  const existing = await env.MARKETPLACE.get(saveKey(session.user_id), 'json');
  const storedSeq = Number((existing && existing.state && existing.state.grantSeq) || 0);
  const incomingSeq = Number(body.state.grantSeq || 0);

  if (storedSeq > incomingSeq) {
    return json({
      error: 'stale',
      reason: 'A reward was granted since this save was taken.',
      grantSeq: storedSeq,
      state: existing.state,
    }, 409);
  }

  /* Sanitised rather than trusted, because this one field leaves the
     player's own park and appears on a page other people read. Everything
     else in this document is private and stays opaque. */
  if ('favorite' in body.state) {
    body.state.favorite = sanitizeFavorite(body.state.favorite);
  }

  const record = { userId: session.user_id, state: body.state, savedAt: Date.now() };
  await env.MARKETPLACE.put(saveKey(session.user_id), JSON.stringify(record));

  return json({ success: true, savedAt: record.savedAt });
}
