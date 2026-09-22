/* ══════════════════════════════════════════════
   UNDEAD EXECUTIONER BADGES — earned by REDEEMING the raid boss

   Library, not a route — declared in server/router.js NON_ROUTE_MODULES.

   Not "how much damage you dealt" (that is awardRaidRewards, in
   skull-raid.js, paid on a KILL). This is "how many times you have paid to
   SUMMON the boss" — a loyalty ladder on the channel-point redemption
   itself, counted per account, forever.

   ONLY A REDEMPTION THAT ACTUALLY SUMMONED THE BOSS COUNTS. A redemption
   Twitch charged for but that got refunded (see settleRedemption in
   channel-points.js — a fight was already underway) gave the points back;
   counting it toward the ladder would mean the ladder can be advanced for
   free by redeeming into a live fight on purpose.
   ══════════════════════════════════════════════ */

/* Ascending by count. Each threshold is the Nth redemption that earns it —
   the 1st, 10th, 25th, 50th, 100th — not "every 10th" or "every 25th". */
export const RAID_REDEMPTION_TIERS = [
  { count: 1, id: 'undead-executioner-bronze', game: 'profile', name: 'Undead Executioner — Bronze',
    rarity: 'uncommon', image: '/assets/badges/undead-executioner-bronze.png' },
  { count: 10, id: 'undead-executioner-silver', game: 'profile', name: 'Undead Executioner — Silver',
    rarity: 'rare', image: '/assets/badges/undead-executioner-silver.png' },
  { count: 25, id: 'undead-executioner-gold', game: 'profile', name: 'Undead Executioner — Gold',
    rarity: 'rare', image: '/assets/badges/undead-executioner-gold.png' },
  { count: 50, id: 'undead-executioner-platinum', game: 'profile', name: 'Undead Executioner — Platinum',
    rarity: 'mythic', image: '/assets/badges/undead-executioner-platinum.png' },
  { count: 100, id: 'undead-executioner-phantom', game: 'profile', name: 'Undead Executioner — Phantom',
    rarity: 'mythic', image: '/assets/badges/undead-executioner-phantom.png' },
];

const countKey = (userId) => `raid_redeem_count_${userId}`;
const inventoryKey = (userId) => `inv_${userId}`;

/**
 * Grant every tier whose threshold is at or below `count` that this
 * account's inventory does not already hold. Idempotent by design — safe to
 * call every time a count changes, including from a backfill that reruns.
 *
 * IDENTITY IS id PLUS type, same reasoning as checkin-badges.js's
 * grantOpenBadges: dedupe on id alone would let a like-named item from a
 * different system block a grant here, or vice versa.
 *
 * @returns {Promise<Array>} the tier(s) actually granted, empty if none
 */
async function awardTiersUpTo(env, userId, count) {
  const due = RAID_REDEMPTION_TIERS.filter(t => t.count <= count);
  if (!due.length) return [];

  let granted = [];
  await env.MARKETPLACE.mutate(inventoryKey(userId), (current) => {
    const inv = current || { userId: String(userId), items: [], equips: {} };
    const items = Array.isArray(inv.items) ? inv.items : (inv.items = []);
    granted = [];
    for (const t of due) {
      if (items.some(i => i && i.id === t.id && i.type === 'badge')) continue;
      items.push({
        id: t.id, game: t.game, type: 'badge', name: t.name, rarity: t.rarity,
        consumable: false, quantity: 1, grantedAt: Date.now(), source: 'raid-redemption',
        meta: { image: t.image },
      });
      granted.push(t);
    }
    /* No write at all when nothing is new -- the common case on every
       redemption between milestones. */
    return granted.length ? inv : undefined;
  });
  return granted;
}

/**
 * Called once per redemption that actually summoned the boss. Bumps the
 * account's lifetime count by one and grants whatever tier that crossing
 * just earned (normally at most one, since counts increase one at a time).
 *
 * @returns {Promise<Array>} tier(s) granted by this specific redemption
 */
export async function recordRaidRedemption(env, userId) {
  let newCount = 0;
  await env.MARKETPLACE.mutate(countKey(userId), (current) => {
    newCount = (Number(current) || 0) + 1;
    return newCount;
  });
  return awardTiersUpTo(env, userId, newCount);
}

/**
 * For the one-time backfill (server/scripts/backfill-raid-badges.js):
 * reconcile an account's count against a HISTORICAL total read from
 * Twitch's own redemption records, and grant everything now due.
 *
 * NEVER LOWERS an existing count. The backfill can run before, after, or
 * interleaved with live redemptions, and possibly more than once — taking
 * the max of what is stored and what Twitch reports is what makes all three
 * safe rather than merely "usually fine".
 *
 * @returns {Promise<Array>} every tier now due (not just newly crossed —
 *   the backfill has no "one at a time" to report against, only a final
 *   count that may already be past several thresholds at once)
 */
export async function backfillRaidRedemptions(env, userId, historicalCount) {
  let finalCount = 0;
  await env.MARKETPLACE.mutate(countKey(userId), (current) => {
    finalCount = Math.max(Number(current) || 0, Number(historicalCount) || 0);
    return finalCount;
  });
  return awardTiersUpTo(env, userId, finalCount);
}

/** Current lifetime count, for display (e.g. a future "X/100 to Phantom"). */
export async function getRaidRedemptionCount(env, userId) {
  return Number(await env.MARKETPLACE.get(countKey(userId))) || 0;
}
