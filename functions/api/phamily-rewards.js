/* ══════════════════════════════════════════════
   PHAMILY TIME REWARDS — the canonical table.

   THIS FILE EXISTS BECAUSE THE SERVER USED TO TAKE THE CLIENT'S WORD FOR IT.
   handleClaimReward read rewardType, rewardRarity and rewardName straight
   out of the request body and handed them to grantReward, which decides what
   is actually granted:

     - rarity picks the entry count, so a level-2 common giveaway reward
       claimed with rewardRarity:'mythic' paid 50 entries instead of 2
     - type picks the item mapper, so a giveaway reward could be turned into
       a badge, a banner or a dice pack
     - name is read for the words "guaranteed" and "mutant", so any reward
       named "Guaranteed Mutant Egg" produced exactly that

   The only things checked were that the key had not been claimed and that
   the level in the key had been reached. Every reward on the track was
   therefore claimable at mythic by anyone past level 2.

   Definitions are a VERBATIM PORT of the three functions in
   js/pages/phamily-time.js, and server/scripts/test-phamily-rewards.js
   evaluates that file's copies and asserts the two agree, so the pair cannot
   drift apart silently.
   ══════════════════════════════════════════════ */

const REWARD_ICONS = {
    giveaway: '🎫',
    egg: '🥚',
    cardback: '🃏',
    emote: '😈',
    bingo: '🎰',
    wildcard: '⭐',
    dice: '🎲',
    cosmetic: '💀',
    badge: '🛡️',
    title: '👑',
    banner: '🏳️',
    nameeffect: '✨',
};

const MILESTONE_INTERVAL = 15;

function defineFollowerRewards() {
  const r = [];
  const giveawayLevels = [
    [2,'common'],[5,'common'],[8,'common'],[12,'common'],[16,'common'],
    [20,'uncommon'],[25,'uncommon'],[30,'uncommon'],[35,'uncommon'],
    [40,'rare'],[50,'rare'],[60,'rare'],[70,'rare'],
    [80,'rare'],[90,'rare'],[100,'rare'],
    [110,'mythic'],[125,'mythic'],[140,'mythic'],
  ];
  const entries = { common:2, uncommon:5, rare:15, mythic:50 };
  for (const [lvl, rarity] of giveawayLevels) {
    r.push({ level:lvl, rarity, type:'giveaway', icon:REWARD_ICONS.giveaway,
      name:`Giveaway Entries`, desc:`+${entries[rarity]} entries into the monthly giveaway, added automatically` });
  }
  r.push({ level:10, rarity:'common', type:'cardback', icon:REWARD_ICONS.cardback,
    name:'Basic Card Back', desc:'A simple card back for Memory Match' });
  r.push({ level:22, rarity:'uncommon', type:'emote', icon:REWARD_ICONS.emote,
    name:'Emote Pack', desc:'Bonus emote set for Memory Match' });
  r.push({ level:55, rarity:'rare', type:'cardback', icon:REWARD_ICONS.cardback,
    name:'Rare Card Back', desc:'An exclusive card back for Memory Match' });
  r.push({ level:65, rarity:'rare', type:'bingo', icon:REWARD_ICONS.bingo,
    name:'Bonus Bingo Card', desc:'An extra bingo card for Commander Bingo' });
  r.push({ level:85, rarity:'rare', type:'skull-skin', icon:REWARD_ICONS.cosmetic,
    cosmeticId:'blood',
    name:'Skull Skin', desc:'The Blood Skull theme for Skull Clicker' });
  r.push({ level:95, rarity:'rare', type:'dice', icon:REWARD_ICONS.dice,
    name:'Bone Dice', desc:'Cosmetic bone-themed dice for Mana Clash' });
  return r.sort((a,b) => a.level - b.level);
}

function definePhamilyRewards() {
  const r = [];
  const giveawayLevels = [
    [2,'uncommon'],[5,'uncommon'],[8,'uncommon'],[12,'uncommon'],[16,'uncommon'],
    [20,'rare'],[25,'rare'],[30,'rare'],[35,'rare'],
    [40,'rare'],[50,'rare'],[60,'rare'],[70,'mythic'],
    [80,'mythic'],[90,'mythic'],[100,'mythic'],
    [110,'mythic'],[125,'mythic'],[140,'mythic'],
  ];
  const entries = { common:2, uncommon:5, rare:15, mythic:50 };
  for (const [lvl, rarity] of giveawayLevels) {
    r.push({ level:lvl, rarity, type:'giveaway', icon:REWARD_ICONS.giveaway,
      name:`Giveaway Entries`, desc:`+${entries[rarity]} entries into the monthly giveaway, added automatically` });
  }
  r.push({ level:6, rarity:'common', type:'egg', icon:REWARD_ICONS.egg,
    name:'Common Egg', desc:'A Dino Park egg — hatch a random common dinosaur' });
  r.push({ level:18, rarity:'uncommon', type:'egg', icon:REWARD_ICONS.egg,
    name:'Uncommon Egg', desc:'A Dino Park egg — hatch a random uncommon dinosaur' });
  r.push({ level:10, rarity:'uncommon', type:'cardback', icon:REWARD_ICONS.cardback,
    name:'Phamily Card Back', desc:'An exclusive card back for Memory Match' });
  r.push({ level:22, rarity:'uncommon', type:'emote', icon:REWARD_ICONS.emote,
    name:'Premium Emote Pack', desc:'Exclusive emote set for Memory Match' });
  r.push({ level:28, rarity:'uncommon', type:'bingo', icon:REWARD_ICONS.bingo,
    name:'Bonus Bingo Card', desc:'An extra bingo card for Commander Bingo' });
  r.push({ level:36, rarity:'rare', type:'egg', icon:REWARD_ICONS.egg,
    name:'Guaranteed Rare Egg', desc:'A Dino Park egg — guaranteed rare dinosaur' });
  r.push({ level:42, rarity:'rare', type:'wildcard', icon:REWARD_ICONS.wildcard,
    name:'Wildcard Stamp', desc:'A wildcard stamp for Commander Bingo' });
  r.push({ level:48, rarity:'rare', type:'dice', icon:REWARD_ICONS.dice,
    name:'Chaos Dice Pack', desc:'Cosmetic chaos-themed dice for Mana Clash' });
  r.push({ level:55, rarity:'rare', type:'cardback', icon:REWARD_ICONS.cardback,
    name:'Legendary Card Back', desc:'A rare card back for Memory Match' });
  r.push({ level:65, rarity:'rare', type:'skull-skin', icon:REWARD_ICONS.cosmetic,
    cosmeticId:'void',
    name:'Dark Altar Skin', desc:'The Void Skull theme for Skull Clicker' });
  r.push({ level:85, rarity:'rare', type:'click-effect', icon:REWARD_ICONS.cosmetic,
    cosmeticId:'void',
    name:'Void Click Effect', desc:'The Void Click effect for Skull Clicker' });
  r.push({ level:95, rarity:'rare', type:'dice', icon:REWARD_ICONS.dice,
    name:'Phantom Dice Pack', desc:'Cosmetic phantom-themed dice for Mana Clash' });
  r.push({ level:105, rarity:'mythic', type:'egg', icon:REWARD_ICONS.egg,
    name:'Guaranteed Mutant Egg', desc:'A Dino Park egg — guaranteed mutant dinosaur' });
  r.push({ level:115, rarity:'mythic', type:'skull-skin', icon:REWARD_ICONS.cosmetic,
    cosmeticId:'eternal',
    name:'Eternal Darkness Skin', desc:'The Eternal Darkness theme for Skull Clicker' });
  r.push({ level:130, rarity:'mythic', type:'dice', icon:REWARD_ICONS.dice,
    name:'Reality Fracture Dice', desc:'Mythic animated dice for Mana Clash' });
  return r.sort((a,b) => a.level - b.level);
}

function defineMilestones() {
  const ms = [];
  const followerBundles = [
    ['Initiate','Badge + Title'],
    ['Acolyte','Badge + Title'],
    ['Watcher','Badge + Title'],
    ['Guardian','Badge + Title'],
    ['Sentinel','Badge + Title'],
    ['Phantom','Badge + Title'],
    ['Wraith','Badge + Title'],
    ['Revenant','Badge + Title'],
    ['Specter','Badge + Title'],
    ['Eternal','Badge + Title'],
  ];
  const phamilyBundles = [
    ['Initiate','Badge + Title + Common Egg', [
      { type:'egg', rarity:'common', name:'Common Egg' },
    ]],
    ['Acolyte','Badge + Title + Card Back + Common Egg', [
      { type:'cardback', rarity:'uncommon', name:'Card Back' },
      { type:'egg', rarity:'common', name:'Common Egg' },
    ]],
    ['Watcher','Badge + Title + Profile Banner', [
      { type:'banner', rarity:'rare', name:'Profile Banner' },
    ]],
    ['Guardian','Badge + Title + Uncommon Egg + Dice Pack', [
      { type:'egg', rarity:'uncommon', name:'Uncommon Egg' },
      { type:'dice', rarity:'rare', name:'Dice Pack' },
    ]],
    ['Sentinel','Badge + Title + Name Effect + Rare Giveaway Entries', [
      { type:'nameeffect', rarity:'rare', name:'Name Effect' },
      { type:'giveaway', rarity:'rare', name:'Rare Giveaway Entries' },
    ]],
    ['Phantom','Badge + Title + Profile Banner + Rare Egg', [
      { type:'banner', rarity:'rare', name:'Profile Banner' },
      { type:'egg', rarity:'rare', name:'Rare Egg' },
    ]],
    ['Wraith','Badge + Title + Name Effect + Bingo Wildcard Bundle', [
      { type:'nameeffect', rarity:'mythic', name:'Name Effect' },
      { type:'wildcard', rarity:'rare', name:'Bingo Wildcard Bundle' },
    ]],
    ['Revenant','Badge + Title + Profile Banner + Mutant Egg', [
      { type:'banner', rarity:'mythic', name:'Profile Banner' },
      { type:'egg', rarity:'mythic', name:'Guaranteed Mutant Egg' },
    ]],
    ['Specter','Badge + Title + Mythic Giveaway Entries + Dice Pack', [
      { type:'giveaway', rarity:'mythic', name:'Mythic Giveaway Entries' },
      { type:'dice', rarity:'mythic', name:'Dice Pack' },
    ]],
    ['Eternal','Badge + Title + Exclusive Banner + Exclusive Name Effect + Mythic Giveaway Entries', [
      { type:'banner', rarity:'mythic', name:'Exclusive Banner' },
      { type:'nameeffect', rarity:'mythic', name:'Exclusive Name Effect' },
      { type:'giveaway', rarity:'mythic', name:'Mythic Giveaway Entries' },
    ]],
  ];
  for (let i = 0; i < 10; i++) {
    ms.push({
      level: (i + 1) * MILESTONE_INTERVAL,
      title: followerBundles[i][0],
      followerDesc: followerBundles[i][1],
      phamilyDesc: phamilyBundles[i][1],
      bonusItems: phamilyBundles[i][2],
    });
  }
  return ms;
}

export const FOLLOWER_REWARDS = defineFollowerRewards();
export const PHAMILY_REWARDS = definePhamilyRewards();
export const MILESTONES = defineMilestones();
export { MILESTONE_INTERVAL };

/* The key the client sends and the server stores, built the same way on both
   sides: level_track_type_rarity. It is the identity of a reward, so the
   server can look up what was really earned instead of being told. */
export function rewardKeyFor(reward, track) {
  return `${reward.level}_${track}_${reward.type}_${reward.rarity}`;
}

/** Every claimable reward, keyed. Built once at module load. */
const BY_KEY = new Map();
for (const [track, list] of [['follower', FOLLOWER_REWARDS], ['phamily', PHAMILY_REWARDS]]) {
  for (const reward of list) {
    BY_KEY.set(rewardKeyFor(reward, track), { ...reward, track });
  }
}

/**
 * Look up a reward by its key.
 *
 * Returns null for anything not on the track — which is the point. A key the
 * table does not contain cannot be granted, however well-formed it looks.
 */
export function findReward(key) {
  return BY_KEY.get(String(key)) || null;
}

export function findMilestone(level) {
  const n = Math.floor(Number(level));
  return MILESTONES.find(m => m.level === n) || null;
}

/**
 * Which track a viewer is on. Subscribers get the phamily track; everyone
 * else the follower one.
 *
 * Derived from subTier rather than role, for the same reason everything else
 * here is: role is a display ladder on which moderator outranks every sub
 * tier, so a subscribing moderator derives to 0 and silently drops to the
 * lesser track.
 */
export function trackFor(subTier) {
  return (Number(subTier) || 0) > 0 ? 'phamily' : 'follower';
}

/** Rewards on `track` at or below `level`, in level order. */
export function earnedRewards(track, level) {
  const list = track === 'phamily' ? PHAMILY_REWARDS : FOLLOWER_REWARDS;
  const lvl = Math.floor(Number(level) || 0);
  return list.filter(r => r.level <= lvl);
}

/** Milestones at or below `level`. */
export function earnedMilestones(level) {
  const lvl = Math.floor(Number(level) || 0);
  return MILESTONES.filter(m => m.level <= lvl);
}
