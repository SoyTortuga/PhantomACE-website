/* ══════════════════════════════════════════════
   PHAMILY TIME API
   Watch time tracking, levels, rewards, stats
   ══════════════════════════════════════════════ */

/* Keyed by TIER, not by role name. Keyed by role it had no entry for
   'moderator', so a moderator paying for Tier 1 silently got 1x instead of
   1.33x — the lookup fell through `|| 1` and nothing anywhere said so. */
const BOOST_RATES = [1, 1.33, 1.67, 2];
const MAX_LEVEL = 150;
const GRACE_DAYS = 7;

function inventoryKey(userId) { return `inv_${userId}`; }

/* EVERY WRITE IN THIS FILE IS A mutate(), NEVER get-then-put.
   The claim handlers, the heartbeat and grantItem all used to read a row,
   change it and write it back with nothing held in between. Two claims of
   the same key in parallel both read "not claimed" and both paid; a
   heartbeat landing in the middle of claim-all wrote back the claimedRewards
   list it had read before the claims, quietly un-claiming them so they could
   be claimed (and paid) again. mutate() runs the read and the write under
   one per-key lock, and every check that decides whether to write lives
   INSIDE its mutator so it sees the row as it is now, not as it was. */
async function grantItem(env, userId, item) {
  /* IDENTITY IS TYPE AND ID, NOT ID ALONE. Cosmetic ids are namespaced
     per type by the games that read them — Skull Clicker filters on
     `i.type === 'skull-skin'` and looks the id up in that type's own
     table — so 'void' legitimately names both the Dark Altar skin
     (level 65) and the Void click effect (level 85). Matching on id
     alone made the second of those a duplicate of the first: the claim
     was spent and nothing was granted.
     A card back or emote pack is ALSO the same item when its name matches:
     Memory Match knows them only by name, and older grants carried the
     reward key as their id, so a repeat of the same cosmetic under the new
     name-derived id must still dedupe against them. */
  const byName = NAME_KEYED_ITEM_TYPES.includes(item.type);
  const same = (i) => i && ((i.id === item.id && i.type === item.type)
    || (byName && i.type === item.type && !!item.name && i.name === item.name));
  await env.MARKETPLACE.mutate(inventoryKey(userId), (cur) => {
    const inv = cur && typeof cur === 'object' ? cur : { userId, items: [], equips: {} };
    if (!Array.isArray(inv.items)) inv.items = [];
    if (!inv.equips || typeof inv.equips !== 'object') inv.equips = {};
    if (!item.consumable && inv.items.find(same)) return undefined;
    const existing = item.consumable && inv.items.find(same);
    if (existing) { existing.quantity = (existing.quantity || 1) + (item.quantity || 1); }
    else { inv.items.push({ ...item, grantedAt: Date.now(), source: 'phamily-time' }); }
    return inv;
  });
}

/* pullGiveawayCode used to live here. Phamily Time no longer draws from the
   giveaway code pool at all — rewards add entries to the monthly ledger
   directly — so the pool now has exactly one consumer, the chat drops. */

function json(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* Month + day boundaries follow the shared season calendar (SEASON_TZ), so a
   viewer's watch minutes land in the same month (and same local day) as their
   giveaway entries. */
import { monthKey, prevMonthOf, daysLeftInMonth, daysInMonth as seasonDaysInMonth, dayOfMonth } from './season-time.js';
import { NAME_KEYED_ITEM_TYPES, nameKeyedItemId } from './phamily-rewards.js';
const prevMonthKey = prevMonthOf;

function isInGracePeriod(now) {
  return dayOfMonth(now) <= GRACE_DAYS;
}

function getBoostRate(session) {
  return BOOST_RATES[getSubTier(session)] || 1;
}

/* ── Live-status gate ──────────────────────────
   Watch time should only accrue while PhantomACE is actually live, not just
   whenever a logged-in user has a page open.

   The implementation moved to stream-info.js, shared with the channel-points
   check-in handler. It used to live here and write twitch_live_cache as
   {live, checkedAt}; the check-in handler needs a stream id from that same
   cached row, and two writers with different shapes on one key means
   whichever ran last decides what the other can see. One writer now. */
async function isChannelLive(env) {
  const { getStreamInfo } = await import('./stream-info.js');
  return (await getStreamInfo(env)).live;
}

/* Reads the session's own subTier. Deriving it from `role` was the bug:
   role is a display ladder on which moderator outranks every sub tier, so a
   subscribing moderator derived to 0 and lost the boost they pay for.

   The role fallback is for cookies issued before subTier existed; those are
   upgraded the next time /api/auth/recheck-roles runs, which this page calls
   on load. */
function getSubTier(session) {
  if (session && typeof session.subTier === 'number') return session.subTier;
  const role = session && session.role;
  if (role === 'sub_tier1') return 1;
  if (role === 'sub_tier2') return 2;
  if (role === 'sub_tier3' || role === 'broadcaster') return 3;
  return 0;
}

const PT_TTL = 5184000;
function userDataKey(userId, mk) { return `pt_${userId}_${mk}`; }

/* A reward key is `level_track_type_rarity`; the type never contains an
   underscore (skull-skin, room-piece, click-effect use hyphens), so a
   giveaway key is exactly the ones carrying the `_giveaway_` segment. Used to
   seed the auto-credit ratchet from rewards a row CLAIMED under the old
   claim-to-credit model, so those are never paid a second time. */
function isGiveawayKey(key) { return String(key).includes('_giveaway_'); }

function blankUserData(userId, mk) {
  return {
    userId,
    month: mk,
    hours: 0,
    level: 0,
    claimedRewards: [],
    claimedMilestones: [],
    /* Giveaway-entry reward KEYS already auto-credited this month — the
       ratchet behind "added automatically". See handleHeartbeat. */
    giveawayCredited: [],
    attendance: {},
    lastHeartbeat: 0,
  };
}

/* A stored row, or a blank one, with every list present — so a mutator can
   push without first checking the shape. */
function asUserData(cur, userId, mk) {
  const d = cur && typeof cur === 'object' ? cur : blankUserData(userId, mk);
  if (!Array.isArray(d.claimedRewards)) d.claimedRewards = [];
  if (!Array.isArray(d.claimedMilestones)) d.claimedMilestones = [];
  if (!d.attendance || typeof d.attendance !== 'object') d.attendance = {};
  return d;
}

async function getUserData(env, userId, mk) {
  return asUserData(await env.MARKETPLACE.get(userDataKey(userId, mk), 'json'), userId, mk);
}

/** Read-modify-write of one month's row under the per-key lock. */
async function mutateUserData(env, userId, mk, fn) {
  return env.MARKETPLACE.mutate(userDataKey(userId, mk),
    (cur) => fn(asUserData(cur, userId, mk)), { expirationTtl: PT_TTL });
}

function blankAllTime() {
  return {
    totalHours: 0,
    monthsActive: 0,
    totalRewardsClaimed: 0,
    bestLevel: 0,
    longestStreak: 0,
    activeMonths: [],
  };
}

async function getAllTimeStats(env, userId) {
  return await env.MARKETPLACE.get(`pt_alltime_${userId}`, 'json') || blankAllTime();
}

/* The all-time row is written by the heartbeat AND by every claim, so it
   takes the same lock: an unlocked increment raced by a heartbeat lost it. */
async function mutateAllTimeStats(env, userId, fn) {
  return env.MARKETPLACE.mutate(`pt_alltime_${userId}`, (cur) => {
    const s = cur && typeof cur === 'object' ? cur : blankAllTime();
    if (!Array.isArray(s.activeMonths)) s.activeMonths = [];
    fn(s);
    return s;
  });
}

/* ── GET — fetch user's current state ─────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const now = new Date();
  const mk = monthKey(now);

  /* THE ONE SEASON REGISTRY. The page used to carry a verbatim copy of the
     whole reward table; now it fetches it from here, so there is a single
     source of truth and nothing to keep in step. Built from the canonical
     rewardTablesFor(mk) in phamily-rewards.js — never recomputed. The current
     month drives the pass ladder, the previous one the grace view, exactly as
     the page's own mirror used to. byKey is a Map (and would serialise to {}),
     so only the arrays the page renders from are sent. Identical for every
     viewer and served before the login gate, so the logged-out demo view gets
     it too; cached briefly since it only changes at the month boundary. */
  if (action === 'tables') {
    const { rewardTablesFor } = await import('./phamily-rewards.js');
    const shape = (t) => ({ month: t.month, follower: t.follower, phamily: t.phamily, milestones: t.milestones });
    return json({
      current: shape(rewardTablesFor(mk)),
      prev: shape(rewardTablesFor(prevMonthKey(mk))),
    }, 200, { 'Cache-Control': 'public, max-age=300' });
  }

  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  if (action === 'status') {
    const data = await getUserData(env, session.user_id, mk);
    const allTime = await getAllTimeStats(env, session.user_id);
    const boostRate = getBoostRate(session);
    const subTier = getSubTier(session);

    let prevData = null;
    if (isInGracePeriod(now)) {
      const pmk = prevMonthKey(mk);
      prevData = await getUserData(env, session.user_id, pmk);
      if (prevData.hours === 0) prevData = null;
    }

    return json({
      month: mk,
      level: data.level,
      hours: Math.round(data.hours * 10) / 10,
      claimedRewards: data.claimedRewards,
      claimedMilestones: data.claimedMilestones,
      attendance: data.attendance,
      boostRate,
      subTier,
      daysLeft: daysLeftInMonth(now),
      graceActive: isInGracePeriod(now),
      prevMonth: prevData ? {
        month: prevData.month,
        level: prevData.level,
        unclaimedRewards: countUnclaimed(prevData),
        claimedRewards: prevData.claimedRewards,
        claimedMilestones: prevData.claimedMilestones,
      } : null,
      allTime: {
        totalHours: Math.round(allTime.totalHours * 10) / 10,
        monthsActive: allTime.monthsActive,
        totalRewardsClaimed: allTime.totalRewardsClaimed,
        bestLevel: allTime.bestLevel,
        longestStreak: allTime.longestStreak,
      },
      role: session.role,
    });
  }

  if (action === 'chart') {
    const data = await getUserData(env, session.user_id, mk);
    const daysInMonth = seasonDaysInMonth(now);
    const chartData = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dayStr = String(d);
      const hours = data.attendance[dayStr] || 0;
      chartData.push({ label: dayStr, hours: Math.round(hours * 10) / 10 });
    }
    return json(chartData);
  }

  return json({ error: 'Invalid action' }, 400);
}

function countUnclaimed(data) {
  const totalPossible = data.level;
  return Math.max(0, totalPossible - data.claimedRewards.length - data.claimedMilestones.length);
}

/* ── POST — heartbeat, claim, etc. ────────────── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const now = new Date();
  const mk = monthKey(now);

  if (body.action === 'heartbeat') {
    return await handleHeartbeat(env, session, mk, now);
  }

  if (body.action === 'claim-all') {
    return await handleClaimAll(env, session, mk);
  }

  if (body.action === 'claim-reward') {
    return await handleClaimReward(env, session, mk, body);
  }

  if (body.action === 'claim-milestone') {
    return await handleClaimMilestone(env, session, mk, body);
  }

  if (body.action === 'claim-prev') {
    if (!isInGracePeriod(now)) return json({ error: 'Grace period has ended' }, 400);
    const pmk = prevMonthKey(mk);
    if (body.type === 'reward') return await handleClaimReward(env, session, pmk, body);
    if (body.type === 'milestone') return await handleClaimMilestone(env, session, pmk, body);
    return json({ error: 'Invalid claim type' }, 400);
  }

  return json({ error: 'Invalid action' }, 400);
}

async function handleHeartbeat(env, session, mk, now) {
  const timestamp = now.getTime();
  const INTERVAL = 60000;
  const MAX_GAP = 120000;

  /* Asked BEFORE taking the row lock: it can reach out to Twitch, and the
     lock should never be held across a network call. */
  const live = await isChannelLive(env);

  /* The giveaway-entry rewards on this viewer's track(s), so the mutate below
     can credit every one whose level has been reached — the reward copy has
     always said "added automatically", and this is what makes that true.
     Everyone earns the follower track; subscribers also earn phamily. Built
     before the lock (it is an import + a memoised table read), never inside
     it. `toCredit` collects what this beat newly credited so the entries can
     be added after the row lock is released. */
  const { rewardTablesFor, rewardKeyFor } = await import('./phamily-rewards.js');
  const ptTables = rewardTablesFor(mk);
  const giveawayRewards = [];
  for (const track of (getSubTier(session) > 0 ? ['follower', 'phamily'] : ['follower'])) {
    const list = track === 'phamily' ? ptTables.phamily : ptTables.follower;
    for (const r of list) {
      if (r.type === 'giveaway') {
        giveawayRewards.push({ key: rewardKeyFor(r, track), level: r.level, rarity: r.rarity, name: r.name });
      }
    }
  }
  const toCredit = [];

  /* ── SAY WHAT THIS BEAT ACTUALLY DID ────────────────────────────────────
     The response used to carry only `live`, which is not the same question
     as "did my time count". Three of these cases credit nothing while the
     channel IS live, and from the outside they were indistinguishable from
     working:

       offline    — nothing to count
       first-beat — no previous beat to measure from, so the FIRST one after
                    opening a page always credits zero
       gap        — more than MAX_GAP since the last beat (tab backgrounded,
                    laptop asleep, connection dropped). Deliberately not
                    credited, because the viewer may not have been watching.

     A viewer staring at a page that says "live" while nothing accrues has no
     way to tell a working system from a broken one. Now the page can.

     All of it inside the row lock, so a beat landing mid-claim updates the
     row the claim just wrote instead of overwriting it with a copy read
     beforehand — which used to un-claim rewards so they could be paid twice. */
  let creditedSeconds = 0;
  let reason;
  const data = await mutateUserData(env, session.user_id, mk, (d) => {
    const gap = d.lastHeartbeat > 0 ? (timestamp - d.lastHeartbeat) : null;
    creditedSeconds = 0;
    toCredit.length = 0;
    if (!live) {
      reason = 'offline';
    } else if (gap === null) {
      reason = 'first-beat';
    } else if (gap >= MAX_GAP) {
      reason = 'gap';
    } else {
      const elapsed = Math.max(0, gap) / 3600000;
      const boosted = elapsed * getBoostRate(session);
      d.hours = Math.min(d.hours + boosted, MAX_LEVEL);
      d.level = Math.min(Math.floor(d.hours), MAX_LEVEL);

      const dayStr = String(dayOfMonth(now));
      d.attendance[dayStr] = (d.attendance[dayStr] || 0) + elapsed;

      creditedSeconds = Math.round(Math.max(0, gap) / 1000);
      reason = 'credited';
    }

    /* ── GIVEAWAY ENTRIES ARE ADDED AUTOMATICALLY ───────────────────────────
       Credited the moment the level is reached, not on a manual claim — this
       is what the "added automatically" copy promises. Driven off d.level (so
       it settles up regardless of why this beat ran: credited, first-beat,
       even offline), and idempotent: giveawayCredited is the per-month ratchet,
       one entry per reward KEY. Seeded on first touch from any giveaway rewards
       this row already CLAIMED under the old claim-to-credit model, so a user
       who claimed before this shipped is never paid twice. The entries
       themselves are added AFTER this write commits (below). */
    if (!Array.isArray(d.giveawayCredited)) {
      d.giveawayCredited = d.claimedRewards.filter(isGiveawayKey);
    }
    for (const g of giveawayRewards) {
      if (g.level <= d.level && !d.giveawayCredited.includes(g.key)) {
        d.giveawayCredited.push(g.key);
        toCredit.push(g);
      }
    }

    d.lastHeartbeat = Math.max(d.lastHeartbeat || 0, timestamp);
    /* The community Watch Time board prints this. Refreshed every beat (same
       write, same lock) so a Twitch rename shows up on the next heartbeat. */
    const name = typeof session.display_name === 'string' ? session.display_name.trim().slice(0, 50) : '';
    if (name) d.displayName = name;
    return d;
  });

  await mutateAllTimeStats(env, session.user_id, (allTime) => {
    if (!allTime.activeMonths.includes(mk)) {
      allTime.activeMonths.push(mk);
      allTime.monthsActive = allTime.activeMonths.length;
    }
    allTime.totalHours = Math.max(allTime.totalHours || 0, data.hours);
    allTime.bestLevel = Math.max(allTime.bestLevel || 0, data.level);
  });

  /* Add the entries now that the ratchet above is committed. If this half
     fails the viewer is short some entries and the row already says they were
     credited — recoverable, and the same tradeoff the check-in streak rewards
     make. Doing it the other way (pay first, record after) would re-pay on
     every heartbeat forever. The source stays `phamily:<name>` so the giveaway
     history labels these exactly as the manual claim used to. */
  if (toCredit.length) {
    const { addEntries } = await import('./giveaway-entries.js');
    for (const g of toCredit) {
      const entries = GIVEAWAY_ENTRIES_BY_RARITY[g.rarity] || GIVEAWAY_ENTRIES_BY_RARITY.common;
      await addEntries(env, session.user_id, session.display_name, entries, `phamily:${g.name || 'Giveaway Entries'}`);
    }
  }

  return json({
    hours: Math.round(data.hours * 10) / 10,
    level: data.level,
    attendance: data.attendance,
    live,
    /* What this beat did, for the accrual indicator. */
    reason,
    creditedSeconds,
    boostRate: getBoostRate(session),
    /* So the page can say when to expect the next one instead of leaving a
       viewer wondering whether anything is still happening. */
    nextBeatMs: INTERVAL,
  });
}

const GIVEAWAY_ENTRIES_BY_RARITY = { common: 2, uncommon: 5, rare: 15, mythic: 50 };

/* 'giveaway' is deliberately absent from this map — see grantReward below.
   It is the one reward type that is not an inventory item. */
const REWARD_ITEM_MAP = {
  egg: (rarity, name) => {
    const guaranteed = name.toLowerCase().includes('guaranteed');
    const mutant = name.toLowerCase().includes('mutant');
    return { game:'dino-park', type:'egg', consumable:true, quantity:1,
      meta: { rarity, guaranteed, mutant } };
  },
  /* Memory Match knows these by NAME, and the id used to be the reward key
     — the same every month — so a themed month's card back deduped against
     the base month's and was never granted. See nameKeyedItemId. */
  cardback: (rarity, name) =>
    ({ id: nameKeyedItemId('cardback', name), game:'memory-match', type:'cardback', consumable:false }),
  emote: (rarity, name) =>
    ({ id: nameKeyedItemId('emote-pack', name), game:'memory-match', type:'emote-pack', consumable:false }),
  bingo: (rarity, name) => {
    const isWildcard = name.toLowerCase().includes('wildcard');
    return { game:'commander-bingo', type: isWildcard ? 'wildcard' : 'bonus-card', consumable:true, quantity:1 };
  },
  wildcard: () => ({ game:'commander-bingo', type:'wildcard', consumable:true, quantity:1 }),
  /* SAME FAULT AS THE SKULL SKINS ABOVE, found the same way: advertised,
     claimed, and never seen. This granted type 'dice-pack' where Mana
     Clash now reads 'dice', and carried the reward key as its id where the
     game keys a set by its own id -- so even a corrected type would not
     have matched anything. Both halves are cosmeticId. */
  dice: (rarity, name, cosmeticId) =>
    ({ id: cosmeticId, game:'mana-clash', type:'dice', consumable:false }),
  /* THE MISMATCH THIS FIXES. These granted `type:'cosmetic'`, and Skull
     Clicker reads 'skull-skin' and 'click-effect' — so a claimed reward
     landed in the inventory as a type the game had no category for and
     never showed. It also carried the reward key as its id, where the game
     equips by the theme's own id, so even a corrected type would not have
     applied. Both halves are the id: grantReward passes cosmeticId through
     and the mapper makes it the item's id. */
  'skull-skin': (rarity, name, cosmeticId) =>
    ({ id: cosmeticId, game:'skull-clicker', type:'skull-skin', consumable:false }),
  'click-effect': (rarity, name, cosmeticId) =>
    ({ id: cosmeticId, game:'skull-clicker', type:'click-effect', consumable:false }),
  /* MY ROOM, at two grains. A `room-set` opens a whole category, a
     `room-piece` one piece of one, and the room validator accepts either
     — so the Phamily Time pass can drip pieces while an event hands over
     a set. cosmeticId carries the category or the piece id, exactly as it
     carries a skull theme above. The id is prefixed rather than bare so a
     set and a piece can never collide, and grantItem's dedupe means the
     same unlock arriving twice (both tracks, or a second month) is a
     no-op rather than a duplicate. */
  'room-set': (rarity, name, cosmeticId) =>
    ({ id: `room-set-${cosmeticId}`, game:'profile', type:'room-set', consumable:false,
       meta:{ category: cosmeticId } }),
  'room-piece': (rarity, name, cosmeticId) =>
    ({ id: `room-piece-${cosmeticId}`, game:'profile', type:'room-piece', consumable:false,
       meta:{ piece: cosmeticId } }),
  'room-slot': (rarity, name, cosmeticId) =>
    ({ id: `room-slot-${cosmeticId}`, game:'profile', type:'room-slot', consumable:false }),
  badge: () => ({ game:'profile', type:'badge', consumable:false }),
  title: () => ({ game:'profile', type:'title', consumable:false }),
  /* A seasonal milestone stamps meta.theme on its banner / name-effect bonus
     (e.g. 'halloween'); the cosmetics resolver reads it to pick the themed
     variant (halloween-<tier>). Threaded through grantReward from the table,
     never the request. Absent theme → a plain item, exactly as before. */
  banner: (rarity, name, cosmeticId, theme) =>
    ({ game:'profile', type:'banner', consumable:false, ...(theme ? { meta:{ theme } } : {}) }),
  nameeffect: (rarity, name, cosmeticId, theme) =>
    ({ game:'profile', type:'name-effect', consumable:false, ...(theme ? { meta:{ theme } } : {}) }),
};

/**
 * Grant one reward of any type.
 *
 * ONE function because the reward branch and the milestone-bonus branch used
 * to carry byte-identical copies of the code-pulling logic, which is exactly
 * the shape of bug this project keeps finding: two copies, one gets fixed.
 *
 * GIVEAWAY REWARDS GO STRAIGHT INTO THE MONTHLY LEDGER.
 *
 * They used to pull a real code out of the shared giveaway pool and park it
 * in the claimer's inventory. Nothing ever registered that code as
 * redeemable — only chat drops call registerDropCode — so the giveaway page
 * invited people to "claim it in the box above" and the box always answered
 * "invalid code", while every claim quietly drained the pool the chat drops
 * depend on. Real codes spent, nothing delivered.
 *
 * A code is a shared secret for reaching somebody you cannot identify, in
 * chat. Here the claimer is logged in and the reward is already tied to
 * their own level, so there is nobody to prove anything to and no reason for
 * the code to exist.
 */
async function grantReward(env, session, { id, type, rarity, name, cosmeticId, theme }) {
  if (!type) return;

  if (type === 'giveaway') {
    const entries = GIVEAWAY_ENTRIES_BY_RARITY[rarity] || GIVEAWAY_ENTRIES_BY_RARITY.common;
    const { addEntries } = await import('./giveaway-entries.js');
    await addEntries(env, session.user_id, session.display_name, entries, `phamily:${name || 'reward'}`);
    return;
  }

  const mapper = REWARD_ITEM_MAP[type];
  if (!mapper) return;
  await grantItem(env, session.user_id, { id, name, rarity, ...mapper(rarity, name, cosmeticId, theme) });
}

/**
 * Claim one reward.
 *
 * WHAT IS GRANTED COMES FROM THE TABLE, NOT THE REQUEST. This used to read
 * rewardType, rewardRarity and rewardName out of the body and hand them to
 * grantReward, which uses all three to decide what a claim is worth — rarity
 * picks the entry count, type picks the item mapper, and the name is read
 * for the words "guaranteed" and "mutant". Only the key and the level were
 * checked, so every reward on the track was claimable at mythic by anyone
 * past level 2.
 */
async function handleClaimReward(env, session, mk, body) {
  const rewardKey = String(body.rewardKey || '');
  if (!rewardKey) return json({ error: 'Missing reward key' }, 400);

  /* Looked up in the table of the month that EARNED it, which is `mk` — the
     current month for claim-reward, the previous one for claim-prev. This
     used to read the current month's table regardless, so during October's
     grace week a September key paid October's content. */
  const { findReward } = await import('./phamily-rewards.js');
  const reward = findReward(rewardKey, mk);
  if (!reward) return json({ error: 'No such reward' }, 400);

  /* Giveaway-entry rewards are credited automatically the moment the level is
     reached (see handleHeartbeat) — the reward copy says "added automatically".
     A manual claim must therefore NOT grant a second time: it records nothing
     and grants nothing, so a viewer who reached the level AND clicks claim (or
     whose claim-all once swept it up) is never double-credited. This also
     covers claim-prev, which routes through here. */
  if (reward.type === 'giveaway') {
    return json({ success: true, rewardKey, autoCredited: true });
  }

  /* The follower track is open to everyone. The phamily track is the
     subscriber bonus ON TOP of it — a subscriber earns BOTH tracks at a
     given level, not one instead of the other. This used to route through
     trackFor(), which picks a single track per viewer and rejected anyone
     claiming the "other" one — so a subscriber could not claim their own
     follower-track rewards at all. Only the phamily track itself is gated. */
  if (reward.track === 'phamily' && getSubTier(session) <= 0) {
    return json({ error: 'Phamily track rewards require an active subscription' }, 403);
  }

  /* The check and the record are ONE locked step. Checked outside the lock,
     two parallel claims of the same key both saw "not claimed" and both
     paid. Exactly one caller can move a key into claimedRewards; everyone
     else is told it is already claimed and grants nothing. */
  let refusal = null;
  await mutateUserData(env, session.user_id, mk, (data) => {
    if (data.claimedRewards.includes(rewardKey)) { refusal = 'Already claimed'; return undefined; }
    if (reward.level > data.level) { refusal = 'Level not reached'; return undefined; }
    data.claimedRewards.push(rewardKey);
    return data;
  });
  if (refusal) return json({ error: refusal }, 400);

  await grantReward(env, session, {
    id: rewardKey,
    type: reward.type,
    rarity: reward.rarity,
    name: reward.name,
    /* THE OTHER HALF OF THE SKULL-SKIN FIX, which for a long time was only
       done on the mapper's side. Every mapper that identifies WHICH
       cosmetic was granted — a skull theme, a click effect, a room set, a
       room piece — reads this. Leaving it out does not fail: the mapper
       builds an item with `undefined` in its id and its meta, grantItem
       stores it, and it never matches anything. Both call sites in this
       file must pass it, which test-phamily-rewards.js now asserts. */
    cosmeticId: reward.cosmeticId,
  });

  await mutateAllTimeStats(env, session.user_id, (allTime) => {
    allTime.totalRewardsClaimed = (allTime.totalRewardsClaimed || 0) + 1;
  });

  return json({ success: true, rewardKey, granted: { type: reward.type, rarity: reward.rarity, name: reward.name } });
}

/**
 * Claim everything currently unlocked and unclaimed, in one request.
 *
 * ONE PASS, SERVER-SIDE. The alternative — the page firing one request per
 * reward — would be forty round trips for a full track, each able to fail on
 * its own, leaving the viewer to work out which half went through. It would
 * also mean forty writes to the same row.
 *
 * Nothing new is granted here: it walks the same two handlers, so every
 * check they make still applies and there is no second path to keep in step
 * with the first.
 *
 * A failure partway is reported rather than rolled back. The rewards already
 * granted are genuinely granted — the claim was recorded before the item was
 * handed over — and un-granting them would be a bigger lie than saying
 * plainly that three of five landed.
 *
 * CANNOT DOUBLE-PAY. The list below is only a plan, read without a lock; the
 * decision for each reward is made again inside its own handler's locked
 * mutate. A second claim-all (a double click, a second tab) racing this one
 * finds each key already claimed and grants nothing for it — and that is
 * not a failure, so it is skipped rather than reported.
 */
async function handleClaimAll(env, session, mk) {
  const { earnedRewards, earnedMilestones, rewardKeyFor } =
    await import('./phamily-rewards.js');

  const data = await getUserData(env, session.user_id, mk);
  /* Everyone earns the follower track; subscribers earn the phamily track
     on top of it, not instead of it — see handleClaimReward. */
  const tracks = getSubTier(session) > 0 ? ['follower', 'phamily'] : ['follower'];

  /* Giveaway rewards are excluded from the plan: they are credited
     automatically on the heartbeat, so claim-all has nothing to do for them
     (and handleClaimReward would no-op them anyway). Everything else on the
     track is still a manual claim. */
  const rewards = tracks
    .flatMap(track => earnedRewards(track, data.level, mk)
      .filter(r => r.type !== 'giveaway')
      .map(r => rewardKeyFor(r, track)))
    .filter(key => !data.claimedRewards.includes(key));

  const milestones = earnedMilestones(data.level, mk)
    .map(m => m.level)
    .filter(level => !data.claimedMilestones.includes(level));

  if (rewards.length === 0 && milestones.length === 0) {
    return json({ success: true, claimed: 0, rewards: [], milestones: [], nothingToClaim: true });
  }

  /* Sequential, not parallel. Each claim reads and writes the same row, and
     firing them at once would have every one of them read the same
     pre-claim state and the last write win — the exact lost update mutate()
     exists to prevent, except here it is the caller creating it. */
  const claimedRewards = [];
  const claimedMilestones = [];
  const failed = [];

  for (const rewardKey of rewards) {
    const res = await handleClaimReward(env, session, mk, { rewardKey });
    if (res.status === 200) { claimedRewards.push(rewardKey); continue; }
    const error = (await res.clone().json()).error;
    if (error !== 'Already claimed') failed.push({ rewardKey, error });
  }

  for (const milestoneLevel of milestones) {
    const res = await handleClaimMilestone(env, session, mk, { milestoneLevel });
    if (res.status === 200) { claimedMilestones.push(milestoneLevel); continue; }
    const error = (await res.clone().json()).error;
    if (error !== 'Already claimed') failed.push({ milestoneLevel, error });
  }

  return json({
    success: true,
    claimed: claimedRewards.length + claimedMilestones.length,
    rewards: claimedRewards,
    milestones: claimedMilestones,
    failed,
  });
}

async function handleClaimMilestone(env, session, mk, body) {
  const milestoneLevel = Math.floor(Number(body.milestoneLevel));
  if (!milestoneLevel) return json({ error: 'Missing milestone level' }, 400);

  /* The claim's own month, like findReward: the title, the bonus items and
     their theme all come from the table of the month that earned it, so a
     September milestone claimed in October's grace week is September's. */
  const { findMilestone, themeKeyFor } = await import('./phamily-rewards.js');
  const milestone = findMilestone(milestoneLevel, mk);
  if (!milestone) return json({ error: 'No such milestone' }, 400);

  /* Checked and recorded in one locked step — see handleClaimReward. */
  let refusal = null;
  await mutateUserData(env, session.user_id, mk, (data) => {
    if (data.claimedMilestones.includes(milestoneLevel)) { refusal = 'Already claimed'; return undefined; }
    if (milestoneLevel > data.level) { refusal = 'Level not reached'; return undefined; }
    data.claimedMilestones.push(milestoneLevel);
    return data;
  });
  if (refusal) return json({ error: refusal }, 400);

  const milestoneTitle = milestone.title;
  /* Subscriber status from subTier, not from the role string. role is a
     display ladder on which moderator outranks every sub tier, so a
     subscribing moderator read as not-a-sub here and silently lost every
     milestone bonus they had paid for. */
  const isSub = getSubTier(session) > 0;

  /* The artwork, by milestone level. Every badge granted here used to carry
     no image at all, so ten ranks across a hundred and fifty levels all
     rendered as the same grey diamond wherever a badge is drawn.

     Pointed at a file rather than gated on one existing: a missing image
     falls back to the rarity glyph at render, so the art can land later
     without this needing to know whether it has. */
  /* Seasonal badge art. When the month this claim lands in carries a cosmetic
     theme (e.g. '2026-10' -> 'halloween', the same month selection the reward
     tables skin by), point at the themed PNG; base months keep the plain path
     exactly as before. Gated on mk, not "now", so a Halloween badge claimed in
     the following month's grace period still gets its themed art. The
     missing-art glyph fallback at render stays intact, so this is safe even
     before every themed PNG has landed. */
  const badgeTheme = themeKeyFor(mk);
  const badgeImage = badgeTheme
    ? `/assets/badges/milestones/ms-${badgeTheme}-${milestoneLevel}.png`
    : `/assets/badges/milestones/ms-${milestoneLevel}.png`;
  await grantItem(env, session.user_id, {
    id: `ms_${milestoneLevel}_badge_${mk}`,
    game: 'profile', type: 'badge', consumable: false,
    name: milestoneTitle + ' Badge', rarity: milestoneLevel >= 120 ? 'mythic' : milestoneLevel >= 60 ? 'rare' : 'uncommon',
    meta: {
      image: badgeImage,
      milestoneLevel,
      rank: milestoneTitle,
    },
  });
  await grantItem(env, session.user_id, {
    id: `ms_${milestoneLevel}_title_${mk}`,
    game: 'profile', type: 'title', consumable: false,
    name: milestoneTitle, rarity: milestoneLevel >= 120 ? 'mythic' : milestoneLevel >= 60 ? 'rare' : 'uncommon',
  });

  /* From the table, not the body. These were whatever the client sent. */
  if (isSub && milestone.bonusItems) {
    for (const bonus of milestone.bonusItems) {
      await grantReward(env, session, {
        id: `ms_${milestoneLevel}_${bonus.type}_${mk}`,
        type: bonus.type,
        rarity: bonus.rarity || 'common',
        name: bonus.name || bonus.type,
        /* THE SAME OMISSION THE SKULL SKINS HAD. Without this a bonus
           whose mapper reads cosmeticId — a room set, a skull theme —
           is granted with `undefined` in its id and its meta, so it
           lands in the inventory as an item nothing can match. */
        cosmeticId: bonus.cosmeticId,
        /* A seasonal milestone carries meta.theme on its banner / name-effect
           bonus; thread it through so the granted item resolves to the themed
           variant (halloween-<tier>) rather than the plain tier. */
        theme: bonus.meta && bonus.meta.theme,
      });
    }
  }

  await mutateAllTimeStats(env, session.user_id, (allTime) => {
    allTime.totalRewardsClaimed = (allTime.totalRewardsClaimed || 0) + 1;
  });

  return json({ success: true, milestoneLevel });
}
