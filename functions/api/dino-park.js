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

  const record = await env.MARKETPLACE.get(saveKey(session.user_id), 'json');
  if (!record) return json({ hasSave: false, state: null });

  return json({ hasSave: true, state: record.state, savedAt: record.savedAt || 0 });
}

/* ── POST — persist the player's current state ── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

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

  const record = { userId: session.user_id, state: body.state, savedAt: Date.now() };
  await env.MARKETPLACE.put(saveKey(session.user_id), JSON.stringify(record));

  return json({ success: true, savedAt: record.savedAt });
}
