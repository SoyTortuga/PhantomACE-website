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

/* The season month ('YYYY-MM' in the broadcaster's timezone) drives the
   monthly cosmetic THEME below. Shared with the giveaway ledger, the watch
   handler and the seasonal reset, so a themed reward lands in the same month
   as the watch time that earned it.

   THE TABLES ARE A FUNCTION OF THE MONTH, NOT OF WHEN THE MODULE LOADED.
   They used to be built once at import with monthKey() read inside each
   define*(), which broke two ways:
     - a server started in October kept serving October's table into
       November, because nothing ever rebuilt it
     - a grace-period claim of LAST month's reward (claim-prev) looked its key
       up in THIS month's table, so a September key paid October content
   Every lookup now names the month it is asking about (rewardTablesFor(mk)),
   memoised per month. The client mirror in js/pages/phamily-time.js has the
   same per-month builder; test-phamily-rewards.js compares the two for every
   themed month plus an unthemed one. */
import { monthKey } from './season-time.js';
/* What a giveaway reward is WORTH comes from the ledger's own table —
   this file used to carry two copies of it, one per reward track. */
import { ENTRIES_BY_RARITY } from './giveaway-entries.js';

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
    room: '🛋️',
};

const MILESTONE_INTERVAL = 15;

/* ── SEASONAL THEMES ───────────────────────────────────────────────────
   A month-keyed cosmetic skin over the base table. A reward override touches
   cosmeticId / name / desc ONLY — never level, type, rarity or icon — so every
   reward KEY is identical to a base month and claim-state is unchanged. Slots
   are keyed `${level}_${type}_${rarity}`. Milestone themes replace the ten
   titles, stamp meta.theme on every banner / name-effect bonus (the cosmetics
   resolver yields <theme>-<tier>) and re-skin the bonus dice by level.
   Duplicated verbatim in js/pages/phamily-time.js; the drift guard compares
   both sides for every month named here. A new theme month goes in these
   three maps AND in SEASON_THEMES below. */
const FOLLOWER_THEMES = {
  '2026-10': {
    '10_cardback_common': { name:'Cobweb Card Back', desc:'A cobweb-laced card back for Memory Match' },
    '22_emote_uncommon':  { name:'Spooky Emote Pack', desc:'A spooky emote set for Memory Match' },
    '55_cardback_rare':   { name:'Bat Card Back', desc:'A bat-swarm card back for Memory Match' },
    '85_skull-skin_rare': { cosmeticId:'bonewhite', name:'Bonewhite Skull', desc:'The Bonewhite Skull theme for Skull Clicker' },
    '95_dice_rare':       { cosmeticId:'ash', name:'Ashen Dice', desc:'Ashen-grey dice for Mana Clash' },
  },
  '2026-11': {
    '10_cardback_common': { name:'Withered Wheat Card Back', desc:'A withered-wheat card back for Memory Match' },
    '22_emote_uncommon':  { name:'Barrow Emote Pack', desc:'A barrow-dug emote set for Memory Match' },
    '55_cardback_rare':   { name:'Carrion Crow Card Back', desc:'A carrion-crow card back for Memory Match' },
    '85_skull-skin_rare': { cosmeticId:'hollowmoon', name:'Hollow Moon Skull', desc:'The Hollow Moon Skull theme for Skull Clicker' },
    '95_dice_rare':       { cosmeticId:'withered', name:'Withered Wheat Dice', desc:'Withered-wheat dice for Mana Clash' },
  },
};
const PHAMILY_THEMES = {
  '2026-10': {
    '10_cardback_uncommon': { name:'Crypt Card Back', desc:'A crypt-carved card back for Memory Match' },
    '22_emote_uncommon':    { name:'Haunted Emote Pack', desc:'A haunted emote set for Memory Match' },
    '48_dice_rare':         { cosmeticId:'slate', name:'Graveslate Dice', desc:'Graveslate dice for Mana Clash' },
    '55_cardback_rare':     { name:'Ghost Card Back', desc:'A ghostly card back for Memory Match' },
    '65_skull-skin_rare':   { cosmeticId:'graveash', name:'Graveash Skull', desc:'The Graveash Skull theme for Skull Clicker' },
    '85_click-effect_rare': { cosmeticId:'wraith', name:'Wraith Wisp', desc:'The Wraith Wisp click effect for Skull Clicker' },
    '95_dice_rare':         { cosmeticId:'pitch', name:'Pitch Black Dice', desc:'Pitch-black dice for Mana Clash' },
    '115_skull-skin_mythic':{ cosmeticId:'reapermoon', name:'Reaper Moon Skull', desc:'The Reaper Moon Skull theme for Skull Clicker' },
    '130_dice_mythic':      { cosmeticId:'ember', name:'Ember Dice', desc:'Ember-lit dice for Mana Clash' },
  },
  '2026-11': {
    '10_cardback_uncommon': { name:'Bone Sickle Card Back', desc:'A bone-sickle card back for Memory Match' },
    '22_emote_uncommon':    { name:'Harvest Emote Pack', desc:'A harvest emote set for Memory Match' },
    '48_dice_rare':         { cosmeticId:'chaff', name:'Chaff & Husk Dice', desc:'Chaff-and-husk dice for Mana Clash' },
    '55_cardback_rare':     { name:'Hollow Moon Card Back', desc:'A hollow-moon card back for Memory Match' },
    '65_skull-skin_rare':   { cosmeticId:'chaff', name:'Chaff Field Skull', desc:'The Chaff Field Skull theme for Skull Clicker' },
    '85_click-effect_rare': { cosmeticId:'bonesickle', name:'Bone Sickle Slash', desc:'The Bone Sickle Slash click effect for Skull Clicker' },
    '95_dice_rare':         { cosmeticId:'crowfeather', name:'Crowfeather Dice', desc:'Crowfeather dice for Mana Clash' },
    '115_skull-skin_mythic':{ cosmeticId:'crowfeather', name:'Crowfeather Skull', desc:'The Crowfeather Skull theme for Skull Clicker' },
    '130_dice_mythic':      { cosmeticId:'hollow', name:'Hollow Moon Dice', desc:'Hollow-moon dice for Mana Clash' },
  },
};
const MILESTONE_THEMES = {
  '2026-10': {
    theme: 'halloween',
    titles: ['Trick-or-Treater','Candle Bearer','Grave Tender','Pumpkin Knight','Hex Weaver','Nightstalker','Crypt Keeper','Soul Reaper','Dread Warden','Harbinger of Hallows'],
    dice: { 60: { cosmeticId:'blood', name:'Bloodletter Dice' }, 135: { cosmeticId:'wraith', name:'Wraithsilk Dice' } },
  },
  '2026-11': {
    theme: 'harvest',
    titles: ['Gleaner','Crow Caller','Field Warden','Scarecrow Knight','Harvest Witch','Bone Thresher','Barrow Keeper','Sickle Saint','Hollow Lord','Lord of the Last Harvest'],
    dice: { 60: { cosmeticId:'scythe', name:'Bone Sickle Dice' }, 135: { cosmeticId:'scarecrow', name:'Scarecrow Dice' } },
  },
};

/* ── MY ROOM DRIP, BY MONTH ────────────────────────────────────────────
   Each month drips the next tenth of every set, rounded down, interleaved
   so the sets arrive mixed. Levels (and so reward KEYS) never change —
   only the piece ids advance. This used to be ONE hardcoded list that was
   edited in place on the 1st, so September's table "became" October's:
   a grace claim of a September piece paid October's, and the viewer's
   own October claim of that key then deduped to nothing.
   Each tenth is the next run of that set's pieces in catalog order.
   A month with no entry uses the latest entry at or before it. NOTE: no
   fourth tenth has been authored, so December onward keeps November's
   pieces until a '2026-12' entry is added here (and in the mirror).
   Duplicated in js/pages/phamily-time.js; the drift guard compares every
   month. See docs/ROOM-PLAN.md. */
const FOLLOWER_ROOM_DRIPS = {
  '2026-09': [
    [4,'snacks-r1c1'], [9,'posters-r1c1'], [14,'consoles-r1c1'],
    [21,'keyboards-r1c1'], [26,'led-strips-r1c1'], [32,'monitors-r1c1'],
    [37,'smart-r1c1'], [43,'pc-towers-r1c1'], [48,'snacks-r1c2'],
    [54,'posters-r1c2'], [59,'consoles-r1c2'], [64,'keyboards-r1c2'],
    [69,'led-strips-r1c2'], [76,'monitors-r1c2'], [81,'smart-r1c2'],
    [87,'snacks-r1c3'], [92,'posters-r1c3'], [98,'consoles-r1c3'],
    [103,'led-strips-r1c3'], [109,'snacks-r1c4'], [114,'led-strips-r1c4'],
    [119,'snacks-r1c5'], [124,'led-strips-r1c5'], [131,'snacks-r1c6'],
    [136,'led-strips-r1c6'], [142,'snacks-r1c7'],
  ],
  '2026-10': [
    [4,'snacks-r1c8'], [9,'posters-r1c4'], [14,'consoles-r1c4'],
    [21,'keyboards-r1c3'], [26,'led-strips-r1c7'], [32,'monitors-r1c3'],
    [37,'smart-r1c3'], [43,'pc-towers-r1c2'], [48,'snacks-r1c9'],
    [54,'posters-r1c5'], [59,'consoles-r1c5'], [64,'keyboards-r1c4'],
    [69,'led-strips-r1c8'], [76,'monitors-r1c4'], [81,'smart-r1c4'],
    [87,'snacks-r1c10'], [92,'posters-r1c6'], [98,'consoles-r1c6'],
    [103,'led-strips-r1c9'], [109,'snacks-r1c11'], [114,'led-strips-r2c1'],
    [119,'snacks-r1c12'], [124,'led-strips-r2c2'], [131,'snacks-r1c13'],
    [136,'led-strips-r2c3'], [142,'snacks-r2c1'],
  ],
  '2026-11': [
    [4,'snacks-r2c2'], [9,'posters-r1c7'], [14,'consoles-r1c7'],
    [21,'keyboards-r1c5'], [26,'led-strips-r2c4'], [32,'monitors-r1c5'],
    [37,'smart-r1c5'], [43,'pc-towers-r1c3'], [48,'snacks-r2c3'],
    [54,'posters-r1c8'], [59,'consoles-r2c1'], [64,'keyboards-r1c6'],
    [69,'led-strips-r2c5'], [76,'monitors-r1c6'], [81,'smart-r1c6'],
    [87,'snacks-r2c4'], [92,'posters-r2c1'], [98,'consoles-r2c2'],
    [103,'led-strips-r2c6'], [109,'snacks-r2c5'], [114,'led-strips-r2c7'],
    [119,'snacks-r2c6'], [124,'led-strips-r2c8'], [131,'snacks-r2c7'],
    [136,'led-strips-r2c9'], [142,'snacks-r2c8'],
  ],
};
const PHAMILY_ROOM_DRIPS = {
  '2026-09': [
    [3,'snacks-r1c1'], [7,'posters-r1c1'], [13,'consoles-r1c1'],
    [17,'keyboards-r1c1'], [21,'led-strips-r1c1'], [27,'monitors-r1c1'],
    [32,'smart-r1c1'], [37,'pc-towers-r1c1'], [41,'snacks-r1c2'],
    [46,'posters-r1c2'], [51,'consoles-r1c2'], [54,'keyboards-r1c2'],
    [59,'led-strips-r1c2'], [64,'monitors-r1c2'], [69,'smart-r1c2'],
    [74,'snacks-r1c3'], [79,'posters-r1c3'], [84,'consoles-r1c3'],
    [89,'led-strips-r1c3'], [93,'snacks-r1c4'], [98,'led-strips-r1c4'],
    [103,'snacks-r1c5'], [108,'led-strips-r1c5'], [112,'snacks-r1c6'],
    [117,'led-strips-r1c6'], [122,'snacks-r1c7'],
  ],
  '2026-10': [
    [3,'snacks-r1c8'], [7,'posters-r1c4'], [13,'consoles-r1c4'],
    [17,'keyboards-r1c3'], [21,'led-strips-r1c7'], [27,'monitors-r1c3'],
    [32,'smart-r1c3'], [37,'pc-towers-r1c2'], [41,'snacks-r1c9'],
    [46,'posters-r1c5'], [51,'consoles-r1c5'], [54,'keyboards-r1c4'],
    [59,'led-strips-r1c8'], [64,'monitors-r1c4'], [69,'smart-r1c4'],
    [74,'snacks-r1c10'], [79,'posters-r1c6'], [84,'consoles-r1c6'],
    [89,'led-strips-r1c9'], [93,'snacks-r1c11'], [98,'led-strips-r2c1'],
    [103,'snacks-r1c12'], [108,'led-strips-r2c2'], [112,'snacks-r1c13'],
    [117,'led-strips-r2c3'], [122,'snacks-r2c1'],
  ],
  '2026-11': [
    [3,'snacks-r2c2'], [7,'posters-r1c7'], [13,'consoles-r1c7'],
    [17,'keyboards-r1c5'], [21,'led-strips-r2c4'], [27,'monitors-r1c5'],
    [32,'smart-r1c5'], [37,'pc-towers-r1c3'], [41,'snacks-r2c3'],
    [46,'posters-r1c8'], [51,'consoles-r2c1'], [54,'keyboards-r1c6'],
    [59,'led-strips-r2c5'], [64,'monitors-r1c6'], [69,'smart-r1c6'],
    [74,'snacks-r2c4'], [79,'posters-r2c1'], [84,'consoles-r2c2'],
    [89,'led-strips-r2c6'], [93,'snacks-r2c5'], [98,'led-strips-r2c7'],
    [103,'snacks-r2c6'], [108,'led-strips-r2c8'], [112,'snacks-r2c7'],
    [117,'led-strips-r2c9'], [122,'snacks-r2c8'],
  ],
};
function roomDripFor(drips, mk) {
  const months = Object.keys(drips).sort();
  let pick = months[0];
  for (const m of months) if (m <= String(mk)) pick = m;
  return drips[pick];
}

function defineFollowerRewards(mk) {
  const r = [];
  const giveawayLevels = [
    [2,'common'],[5,'common'],[8,'common'],[12,'common'],[16,'common'],
    [20,'uncommon'],[25,'uncommon'],[30,'uncommon'],[35,'uncommon'],
    [40,'rare'],[50,'rare'],[60,'rare'],[70,'rare'],
    [80,'rare'],[90,'rare'],[100,'rare'],
    [110,'mythic'],[125,'mythic'],[140,'mythic'],
  ];
  const entries = ENTRIES_BY_RARITY;
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
    cosmeticId:'bone',
    name:'Bone Dice', desc:'Cosmetic bone-themed dice for Mana Clash' });
  /* MY ROOM — one tenth of each set per month, from the month-keyed drip
     maps above (see roomDripFor). A piece is granted as a `room-piece`
     item naming one piece id; the room validator accepts either grain. */
  const ROOM_SETS = { snacks:'Snacks', posters:'Posters', consoles:'Consoles',
    keyboards:'Keyboards', 'led-strips':'LED Strips', monitors:'Monitors',
    smart:'Smart Devices', 'pc-towers':'PC Towers' };
  const ROOM_DRIP = roomDripFor(FOLLOWER_ROOM_DRIPS, mk);
  for (const [lvl, pieceId] of ROOM_DRIP) {
    const label = ROOM_SETS[pieceId.replace(/-r\d+c\d+$/, '')];
    r.push({ level:lvl, rarity: lvl < 50 ? 'common' : lvl < 100 ? 'uncommon' : 'rare',
      type:'room-piece', icon:REWARD_ICONS.room, cosmeticId:pieceId,
      name:`Room: ${label}`, desc:`A ${label} piece for My Room` });
  }
  const theme = FOLLOWER_THEMES[mk];
  if (theme) {
    for (const rw of r) {
      const o = theme[`${rw.level}_${rw.type}_${rw.rarity}`];
      if (!o) continue;
      if (o.cosmeticId !== undefined) rw.cosmeticId = o.cosmeticId;
      if (o.name) rw.name = o.name;
      if (o.desc) rw.desc = o.desc;
      if (o.meta) rw.meta = { ...(rw.meta || {}), ...o.meta };
    }
  }
  return r.sort((a,b) => a.level - b.level);
}

function definePhamilyRewards(mk) {
  const r = [];
  const giveawayLevels = [
    [2,'uncommon'],[5,'uncommon'],[8,'uncommon'],[12,'uncommon'],[16,'uncommon'],
    [20,'rare'],[25,'rare'],[30,'rare'],[35,'rare'],
    [40,'rare'],[50,'rare'],[60,'rare'],[70,'mythic'],
    [80,'mythic'],[90,'mythic'],[100,'mythic'],
    [110,'mythic'],[125,'mythic'],[140,'mythic'],
  ];
  const entries = ENTRIES_BY_RARITY;
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
    cosmeticId:'phyrexian',
    name:'Phyrexian Dice', desc:'Phyrexian mana symbols for Mana Clash' });
  r.push({ level:55, rarity:'rare', type:'cardback', icon:REWARD_ICONS.cardback,
    name:'Legendary Card Back', desc:'A rare card back for Memory Match' });
  r.push({ level:65, rarity:'rare', type:'skull-skin', icon:REWARD_ICONS.cosmetic,
    cosmeticId:'void',
    name:'Dark Altar Skin', desc:'The Void Skull theme for Skull Clicker' });
  r.push({ level:85, rarity:'rare', type:'click-effect', icon:REWARD_ICONS.cosmetic,
    cosmeticId:'void',
    name:'Void Click Effect', desc:'The Void Click effect for Skull Clicker' });
  r.push({ level:95, rarity:'rare', type:'dice', icon:REWARD_ICONS.dice,
    cosmeticId:'phantom',
    name:'Phantom Dice Pack', desc:'Cosmetic phantom-themed dice for Mana Clash' });
  r.push({ level:105, rarity:'mythic', type:'egg', icon:REWARD_ICONS.egg,
    name:'Guaranteed Mutant Egg', desc:'A Dino Park egg — guaranteed mutant dinosaur' });
  r.push({ level:115, rarity:'mythic', type:'skull-skin', icon:REWARD_ICONS.cosmetic,
    cosmeticId:'eternal',
    name:'Eternal Darkness Skin', desc:'The Eternal Darkness theme for Skull Clicker' });
  r.push({ level:130, rarity:'mythic', type:'dice', icon:REWARD_ICONS.dice,
    cosmeticId:'fracture',
    name:'Reality Fracture Dice', desc:'Mythic animated dice for Mana Clash' });
  /* MY ROOM — one tenth of each set per month, from the month-keyed drip
     maps above (see roomDripFor). A piece is granted as a `room-piece`
     item naming one piece id; the room validator accepts either grain. */
  const ROOM_SETS = { snacks:'Snacks', posters:'Posters', consoles:'Consoles',
    keyboards:'Keyboards', 'led-strips':'LED Strips', monitors:'Monitors',
    smart:'Smart Devices', 'pc-towers':'PC Towers' };
  const ROOM_DRIP = roomDripFor(PHAMILY_ROOM_DRIPS, mk);
  for (const [lvl, pieceId] of ROOM_DRIP) {
    const label = ROOM_SETS[pieceId.replace(/-r\d+c\d+$/, '')];
    r.push({ level:lvl, rarity: lvl < 50 ? 'common' : lvl < 100 ? 'uncommon' : 'rare',
      type:'room-piece', icon:REWARD_ICONS.room, cosmeticId:pieceId,
      name:`Room: ${label}`, desc:`A ${label} piece for My Room` });
  }
  const theme = PHAMILY_THEMES[mk];
  if (theme) {
    for (const rw of r) {
      const o = theme[`${rw.level}_${rw.type}_${rw.rarity}`];
      if (!o) continue;
      if (o.cosmeticId !== undefined) rw.cosmeticId = o.cosmeticId;
      if (o.name) rw.name = o.name;
      if (o.desc) rw.desc = o.desc;
      if (o.meta) rw.meta = { ...(rw.meta || {}), ...o.meta };
    }
  }
  return r.sort((a,b) => a.level - b.level);
}

function defineMilestones(mk) {
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
      { type:'dice', rarity:'rare', name:'Crimson Dice', cosmeticId:'crimson' },
    ]],
    ['Sentinel','Badge + Title + Name Effect + Rare Giveaway Entries + a second Room', [
      { type:'nameeffect', rarity:'rare', name:'Name Effect' },
      { type:'giveaway', rarity:'rare', name:'Rare Giveaway Entries' },
      { type:'room-slot', rarity:'rare', name:'Second Room', cosmeticId:'2' },
    ]],
    ['Phantom','Badge + Title + Profile Banner + Rare Egg + the Studio Lights room set', [
      { type:'banner', rarity:'rare', name:'Profile Banner' },
      { type:'egg', rarity:'rare', name:'Rare Egg' },
      { type:'room-set', rarity:'rare', name:'Studio Lights Set', cosmeticId:'studio-lights' },
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
      { type:'dice', rarity:'mythic', name:'Obsidian Dice', cosmeticId:'obsidian' },
    ]],
    ['Eternal','Badge + Title + Exclusive Banner + Exclusive Name Effect + Mythic Giveaway Entries + a third Room', [
      { type:'banner', rarity:'mythic', name:'Exclusive Banner' },
      { type:'nameeffect', rarity:'mythic', name:'Exclusive Name Effect' },
      { type:'giveaway', rarity:'mythic', name:'Mythic Giveaway Entries' },
      { type:'room-slot', rarity:'mythic', name:'Third Room', cosmeticId:'3' },
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
  const mt = MILESTONE_THEMES[mk];
  if (mt) {
    for (let i = 0; i < ms.length; i++) {
      ms[i].title = mt.titles[i];
      for (const b of (ms[i].bonusItems || [])) {
        if (b.type === 'banner' || b.type === 'nameeffect') {
          b.meta = { ...(b.meta || {}), theme:mt.theme };
        } else if (b.type === 'dice' && mt.dice[ms[i].level]) {
          b.cosmeticId = mt.dice[ms[i].level].cosmeticId;
          b.name = mt.dice[ms[i].level].name;
        }
      }
    }
  }
  return ms;
}

export { MILESTONE_INTERVAL };

/* The seasonal cosmetic theme active for a season month ('YYYY-MM'), or null.
   Names the theme in ONE place so the grant path (e.g. the themed
   milestone-badge art) can branch on it without re-deriving a table. A new
   theme month must be added both here and to the three theme maps above. */
const SEASON_THEMES = { '2026-10': 'halloween', '2026-11': 'harvest' };
export function themeKeyFor(mk = monthKey()) {
  return SEASON_THEMES[String(mk)] || null;
}

/** Every month any theme map names — what the drift guard must cover. */
export const THEMED_MONTHS = [...new Set([
  ...Object.keys(SEASON_THEMES), ...Object.keys(FOLLOWER_THEMES),
  ...Object.keys(PHAMILY_THEMES), ...Object.keys(MILESTONE_THEMES),
])].sort();

/** Every month the room drip maps name — the drift guard covers these too. */
export const ROOM_DRIP_MONTHS = [...new Set([
  ...Object.keys(FOLLOWER_ROOM_DRIPS), ...Object.keys(PHAMILY_ROOM_DRIPS),
])].sort();

/* The key the client sends and the server stores, built the same way on both
   sides: level_track_type_rarity. It is the identity of a reward, so the
   server can look up what was really earned instead of being told. */
export function rewardKeyFor(reward, track) {
  return `${reward.level}_${track}_${reward.type}_${reward.rarity}`;
}

/* ── ONE MONTH'S TABLES, MEMOISED ─────────────────────────────────────
   Built on first use for a month and kept. Bounded so a stray month string
   cannot grow the cache without limit; a rebuild is cheap and deterministic. */
const TABLES = new Map();
const TABLES_MAX = 36;

export function rewardTablesFor(mk = monthKey()) {
  const month = String(mk);
  let t = TABLES.get(month);
  if (t) return t;
  const follower = defineFollowerRewards(month);
  const phamily = definePhamilyRewards(month);
  const milestones = defineMilestones(month);
  const byKey = new Map();
  for (const [track, list] of [['follower', follower], ['phamily', phamily]]) {
    for (const reward of list) byKey.set(rewardKeyFor(reward, track), { ...reward, track });
  }
  t = { month, follower, phamily, milestones, byKey };
  if (TABLES.size >= TABLES_MAX) TABLES.clear();
  TABLES.set(month, t);
  return t;
}

/* ── THE CURRENT MONTH'S TABLES, AS LIVE ARRAYS ───────────────────────
   FOLLOWER_REWARDS / PHAMILY_REWARDS / MILESTONES are still imported by the
   scripts and tests. They used to be snapshots taken at import, which is the
   stale-month bug in miniature, so each is now a read-only view that resolves
   to the current month's table on every access. Anything that needs a
   SPECIFIC month calls rewardTablesFor(mk) instead. */
function currentMonthView(pick) {
  const live = () => pick(rewardTablesFor(monthKey()));
  const refuse = () => false;
  return new Proxy([], {
    /* Methods are NOT bound to the real table: they run with the view as
       `this`, so map/filter/find read through it while push/splice hit the
       refusing traps below instead of editing the memoised month. */
    get: (_t, prop, receiver) => Reflect.get(live(), prop, receiver),
    has: (_t, prop) => Reflect.has(live(), prop),
    ownKeys: () => Reflect.ownKeys(live()),
    getOwnPropertyDescriptor: (_t, prop) => Reflect.getOwnPropertyDescriptor(live(), prop),
    set: refuse,
    defineProperty: refuse,
    deleteProperty: refuse,
  });
}
export const FOLLOWER_REWARDS = currentMonthView(t => t.follower);
export const PHAMILY_REWARDS = currentMonthView(t => t.phamily);
export const MILESTONES = currentMonthView(t => t.milestones);

/**
 * Look up a reward by its key, in the table of the month it was earned in.
 *
 * Returns null for anything not on the track — which is the point. A key the
 * table does not contain cannot be granted, however well-formed it looks.
 *
 * `mk` is the month whose watch time earned the reward: the current month for
 * an ordinary claim, the PREVIOUS month for a grace-period claim. Keys are
 * identical across months; what they pay is not.
 */
export function findReward(key, mk = monthKey()) {
  return rewardTablesFor(mk).byKey.get(String(key)) || null;
}

export function findMilestone(level, mk = monthKey()) {
  const n = Math.floor(Number(level));
  return rewardTablesFor(mk).milestones.find(m => m.level === n) || null;
}

/* ── ITEM IDS FOR COSMETICS THE GAME KNOWS BY NAME ────────────────────
   Memory Match resolves a card back or emote pack by its NAME (see
   getCosmeticId in games/memory-match/index.html), and these used to be
   granted with the reward KEY as their id. The key is identical every month,
   so October's Cobweb Card Back carried the same id as September's Basic
   Card Back and grantItem deduped it into nothing. The id is now the item
   type plus a slug of the name: distinct cosmetics differ, and the same
   cosmetic repeated in a later month dedupes. */
export const NAME_KEYED_ITEM_TYPES = ['cardback', 'emote-pack'];

export function nameKeyedItemId(type, name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${type}-${slug || 'unnamed'}`;
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

/** Rewards on `track` at or below `level`, in level order, for month `mk`. */
export function earnedRewards(track, level, mk = monthKey()) {
  const t = rewardTablesFor(mk);
  const list = track === 'phamily' ? t.phamily : t.follower;
  const lvl = Math.floor(Number(level) || 0);
  return list.filter(r => r.level <= lvl);
}

/** Milestones at or below `level`, for month `mk`. */
export function earnedMilestones(level, mk = monthKey()) {
  const lvl = Math.floor(Number(level) || 0);
  return rewardTablesFor(mk).milestones.filter(m => m.level <= lvl);
}
