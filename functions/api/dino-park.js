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
export async function grantEgg(env, userId, rarity) {
  if (!userId) return { success: false, error: 'Missing user' };
  if (!HATCH_TIMES[rarity]) return { success: false, error: 'Invalid rarity' };

  const key = saveKey(userId);
  const record = await env.MARKETPLACE.get(key, 'json');

  /* A pre-epoch record is treated as no record at all. Pushing the egg
     into a stale state would write a state the client discards on its
     next load, taking the egg with it — the player redeems a code, sees
     the success toast, and receives nothing. */
  const existing = (record && record.state && record.state.saveEpoch === SAVE_EPOCH)
    ? record.state
    : null;
  const state = existing || defaultState();
  if (!Array.isArray(state.eggs)) state.eggs = [];

  const maxSlots = getMaxIncubatorSlots(state);
  if (state.eggs.length >= maxSlots) {
    return { success: false, error: 'Incubator full' };
  }

  const speciesId = rollSpeciesId(rarity);
  if (!speciesId) return { success: false, error: 'Invalid rarity' };

  const egg = { speciesId, hatchTime: HATCH_TIMES[rarity], elapsed: 0 };
  state.eggs.push(egg);
  state.lastTick = Date.now();

  const updated = { userId, state, savedAt: Date.now() };
  await env.MARKETPLACE.put(key, JSON.stringify(updated));

  return { success: true, egg: { speciesId: egg.speciesId, hatchTime: egg.hatchTime } };
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

  const record = { userId: session.user_id, state: body.state, savedAt: Date.now() };
  await env.MARKETPLACE.put(saveKey(session.user_id), JSON.stringify(record));

  return json({ success: true, savedAt: record.savedAt });
}
