/* ══════════════════════════════════════════════
   PHAMILY TIME API
   Watch time tracking, levels, rewards, stats
   ══════════════════════════════════════════════ */

const BOOST_RATES = { visitor: 1, follower: 1, sub_tier1: 1.33, sub_tier2: 1.67, sub_tier3: 2, broadcaster: 2 };
const MAX_LEVEL = 150;
const GRACE_DAYS = 7;

function inventoryKey(userId) { return `inv_${userId}`; }
async function getInventory(env, userId) {
  return await env.MARKETPLACE.get(inventoryKey(userId), 'json') || { userId, items: [], equips: {} };
}
async function saveInventory(env, userId, inv) {
  await env.MARKETPLACE.put(inventoryKey(userId), JSON.stringify(inv));
}
async function grantItem(env, userId, item) {
  const inv = await getInventory(env, userId);
  if (!item.consumable && inv.items.find(i => i.id === item.id)) return;
  const existing = item.consumable && inv.items.find(i => i.id === item.id);
  if (existing) { existing.quantity = (existing.quantity || 1) + (item.quantity || 1); }
  else { inv.items.push({ ...item, grantedAt: Date.now(), source: 'phamily-time' }); }
  await saveInventory(env, userId, inv);
}

/* pullGiveawayCode used to live here. Phamily Time no longer draws from the
   giveaway code pool at all — rewards add entries to the monthly ledger
   directly — so the pool now has exactly one consumer, the chat drops. */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function prevMonthKey(mk) {
  const [y, m] = mk.split('-').map(Number);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

function daysLeftInMonth(now) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.ceil((end - now) / 86400000);
}

function isInGracePeriod(now) {
  return now.getUTCDate() <= GRACE_DAYS;
}

function getBoostRate(role) {
  return BOOST_RATES[role] || 1;
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

function getSubTier(role) {
  if (role === 'sub_tier1') return 1;
  if (role === 'sub_tier2') return 2;
  if (role === 'sub_tier3' || role === 'broadcaster') return 3;
  return 0;
}

async function getUserData(env, userId, mk) {
  const key = `pt_${userId}_${mk}`;
  return await env.MARKETPLACE.get(key, 'json') || {
    userId,
    month: mk,
    hours: 0,
    level: 0,
    claimedRewards: [],
    claimedMilestones: [],
    attendance: {},
    lastHeartbeat: 0,
  };
}

async function saveUserData(env, userId, mk, data) {
  const key = `pt_${userId}_${mk}`;
  await env.MARKETPLACE.put(key, JSON.stringify(data), { expirationTtl: 5184000 });
}

async function getAllTimeStats(env, userId) {
  const key = `pt_alltime_${userId}`;
  return await env.MARKETPLACE.get(key, 'json') || {
    totalHours: 0,
    monthsActive: 0,
    totalRewardsClaimed: 0,
    bestLevel: 0,
    longestStreak: 0,
    activeMonths: [],
  };
}

async function saveAllTimeStats(env, userId, stats) {
  const key = `pt_alltime_${userId}`;
  await env.MARKETPLACE.put(key, JSON.stringify(stats));
}

/* ── GET — fetch user's current state ─────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const now = new Date();
  const mk = monthKey(now);

  if (action === 'status') {
    const data = await getUserData(env, session.user_id, mk);
    const allTime = await getAllTimeStats(env, session.user_id);
    const boostRate = getBoostRate(session.role);
    const subTier = getSubTier(session.role);

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
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
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
  const data = await getUserData(env, session.user_id, mk);
  const timestamp = now.getTime();
  const INTERVAL = 60000;
  const MAX_GAP = 120000;

  const live = await isChannelLive(env);

  if (live && data.lastHeartbeat > 0 && (timestamp - data.lastHeartbeat) < MAX_GAP) {
    const elapsed = Math.min(timestamp - data.lastHeartbeat, MAX_GAP) / 3600000;
    const boosted = elapsed * getBoostRate(session.role);
    data.hours = Math.min(data.hours + boosted, MAX_LEVEL);
    data.level = Math.min(Math.floor(data.hours), MAX_LEVEL);

    const dayStr = String(now.getUTCDate());
    data.attendance[dayStr] = (data.attendance[dayStr] || 0) + elapsed;
  }

  data.lastHeartbeat = timestamp;
  await saveUserData(env, session.user_id, mk, data);

  const allTime = await getAllTimeStats(env, session.user_id);
  if (!allTime.activeMonths.includes(mk)) {
    allTime.activeMonths.push(mk);
    allTime.monthsActive = allTime.activeMonths.length;
  }
  allTime.totalHours = Math.max(allTime.totalHours, data.hours);
  allTime.bestLevel = Math.max(allTime.bestLevel, data.level);
  await saveAllTimeStats(env, session.user_id, allTime);

  return json({
    hours: Math.round(data.hours * 10) / 10,
    level: data.level,
    attendance: data.attendance,
    live,
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
  cardback: (rarity, name) => ({ game:'memory-match', type:'cardback', consumable:false }),
  emote: (rarity, name) => ({ game:'memory-match', type:'emote-pack', consumable:false }),
  bingo: (rarity, name) => {
    const isWildcard = name.toLowerCase().includes('wildcard');
    return { game:'commander-bingo', type: isWildcard ? 'wildcard' : 'bonus-card', consumable:true, quantity:1 };
  },
  wildcard: () => ({ game:'commander-bingo', type:'wildcard', consumable:true, quantity:1 }),
  dice: (rarity, name) => ({ game:'mana-clash', type:'dice-pack', consumable:false }),
  cosmetic: (rarity, name) => ({ game:'skull-clicker', type:'cosmetic', consumable:false }),
  badge: () => ({ game:'profile', type:'badge', consumable:false }),
  title: () => ({ game:'profile', type:'title', consumable:false }),
  banner: () => ({ game:'profile', type:'banner', consumable:false }),
  nameeffect: () => ({ game:'profile', type:'name-effect', consumable:false }),
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
async function grantReward(env, session, { id, type, rarity, name }) {
  if (!type) return;

  if (type === 'giveaway') {
    const entries = GIVEAWAY_ENTRIES_BY_RARITY[rarity] || GIVEAWAY_ENTRIES_BY_RARITY.common;
    const { addEntries } = await import('./giveaway-entries.js');
    await addEntries(env, session.user_id, session.display_name, entries, `phamily:${name || 'reward'}`);
    return;
  }

  const mapper = REWARD_ITEM_MAP[type];
  if (!mapper) return;
  await grantItem(env, session.user_id, { id, name, rarity, ...mapper(rarity, name) });
}

async function handleClaimReward(env, session, mk, body) {
  const rewardKey = body.rewardKey;
  if (!rewardKey) return json({ error: 'Missing reward key' }, 400);

  const data = await getUserData(env, session.user_id, mk);

  if (data.claimedRewards.includes(rewardKey)) {
    return json({ error: 'Already claimed' }, 400);
  }

  const level = parseInt(rewardKey.split('_')[0], 10);
  if (isNaN(level) || level > data.level) {
    return json({ error: 'Level not reached' }, 400);
  }

  data.claimedRewards.push(rewardKey);
  await saveUserData(env, session.user_id, mk, data);

  await grantReward(env, session, {
    id: rewardKey,
    type: body.rewardType,
    rarity: body.rewardRarity || 'common',
    name: body.rewardName || rewardKey,
  });

  const allTime = await getAllTimeStats(env, session.user_id);
  allTime.totalRewardsClaimed++;
  await saveAllTimeStats(env, session.user_id, allTime);

  return json({ success: true, rewardKey });
}

async function handleClaimMilestone(env, session, mk, body) {
  const milestoneLevel = body.milestoneLevel;
  if (!milestoneLevel) return json({ error: 'Missing milestone level' }, 400);

  const data = await getUserData(env, session.user_id, mk);

  if (data.claimedMilestones.includes(milestoneLevel)) {
    return json({ error: 'Already claimed' }, 400);
  }

  if (milestoneLevel > data.level) {
    return json({ error: 'Level not reached' }, 400);
  }

  data.claimedMilestones.push(milestoneLevel);
  await saveUserData(env, session.user_id, mk, data);

  const milestoneTitle = body.milestoneTitle || 'Milestone ' + milestoneLevel;
  const isSub = session.role && session.role.startsWith('sub_');

  await grantItem(env, session.user_id, {
    id: `ms_${milestoneLevel}_badge_${mk}`,
    game: 'profile', type: 'badge', consumable: false,
    name: milestoneTitle + ' Badge', rarity: milestoneLevel >= 120 ? 'mythic' : milestoneLevel >= 60 ? 'rare' : 'uncommon',
  });
  await grantItem(env, session.user_id, {
    id: `ms_${milestoneLevel}_title_${mk}`,
    game: 'profile', type: 'title', consumable: false,
    name: milestoneTitle, rarity: milestoneLevel >= 120 ? 'mythic' : milestoneLevel >= 60 ? 'rare' : 'uncommon',
  });

  if (isSub && body.bonusItems) {
    for (const bonus of body.bonusItems) {
      await grantReward(env, session, {
        id: `ms_${milestoneLevel}_${bonus.type}_${mk}`,
        type: bonus.type,
        rarity: bonus.rarity || 'common',
        name: bonus.name || bonus.type,
      });
    }
  }

  const allTime = await getAllTimeStats(env, session.user_id);
  allTime.totalRewardsClaimed++;
  await saveAllTimeStats(env, session.user_id, allTime);

  return json({ success: true, milestoneLevel });
}
