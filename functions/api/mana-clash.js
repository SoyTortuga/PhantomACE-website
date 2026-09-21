/* ══════════════════════════════════════════════
   MANA CLASH — Farkle with mana dice

   Rules: docs/MANA-CLASH-RULES.md. Scoring: mana-clash-scoring.js, which is
   the authority — the client scores a hand too so dice light up as they
   land, but every selection is re-scored here.

   ROOM WRITES ALL GO THROUGH mutate(). Rounds are simultaneous, so two
   players acting inside the same tick is the ordinary case, and a
   get-modify-put would lose one of them. That would surface as a die that
   visibly rolled and then wasn't there.

   TIME IS RESOLVED LAZILY, on whatever request arrives next. There is no
   scheduler: an idle clock that expires and an intermission that ends are
   both just "this deadline has passed," applied at the top of every read and
   every write. A room with nobody polling it has no state worth advancing.
   ══════════════════════════════════════════════ */

import {
  rollDice, scoreSelection, scorableMask, hasAnyScore, isHotDice, bestSelection, DICE_COUNT, FACE_VALUE,
} from './mana-clash-scoring.js';

const ROOM_TTL = 7200;

/* ── Room chat ────────────────────────────────────────────────────────
   Kept IN THE ROOM DOCUMENT rather than beside it. The page already polls
   the room every couple of seconds and every message is a room write
   anyway, so a separate key would double both without buying anything.

   It costs the room document some size, which is why the history is short:
   sixty lines is more than fits on screen and the document is rewritten on
   every turn.

   NEVER LEAVES THE ROOM. viewFor attaches it only for a player who is in
   the room, which is the same gate `you` uses -- and the overlay calls
   viewFor with a null viewer, so a spectator view cannot carry chat even
   by accident. That is asserted in the overlay suite, not just intended:
   unmoderated text reaching a live stream is the one failure here that
   cannot be taken back. */
const CHAT_KEEP = 60;
const CHAT_MAX_LEN = 200;
/* A turn resolves in under a second and people type reactions to it, so
   the floor is low. The burst window is what actually stops flooding. */
const CHAT_MIN_GAP_MS = 900;
const CHAT_BURST = 6;
const CHAT_BURST_MS = 10000;

/** Trimmed, flattened and capped. Never trusted as markup -- the page
 *  renders it as text, and this only decides what is worth storing. */
function cleanChat(raw) {
  const text = String(raw == null ? '' : raw)
    /* Control characters, including the newlines someone pastes in to make
       one message take up the whole panel. */
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    /* Zero-width and bidi overrides: invisible in the input, and enough to
       scramble every line after them. */
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { error: 'Say something first.' };
  if (text.length > CHAT_MAX_LEN) {
    return { error: `Messages are at most ${CHAT_MAX_LEN} characters.` };
  }
  return { text };
}

/** Whether this player may speak now, and the record of them doing so. */
function chatAllowed(player, now) {
  const recent = (Array.isArray(player.chatAt) ? player.chatAt : [])
    .filter(t => now - t < CHAT_BURST_MS);
  if (recent.length && now - recent[recent.length - 1] < CHAT_MIN_GAP_MS) {
    return { error: 'Slow down a moment.' };
  }
  if (recent.length >= CHAT_BURST) {
    return { error: 'Too many messages — wait a few seconds.' };
  }
  return { recent };
}
const MAX_PLAYERS = 100;
const INTERMISSION_MS = 10000;
const COOP_INTERMISSION_MS = 5000;   // co-op has no standings race to read — keep the pace up
const COOP_BOON_VOTE_MS = 20000;     // an AFK vote resolves with whatever votes exist, not never
const GOALS = [5000, 10000, 20000];
const IDLE_CHOICES = [10000, 30000, 60000];

/* Only 10,000-point games reach the boards. A 5,000 game is much quicker and
   a 20,000 game much longer; mixing them would make both boards meaningless. */
const RANKED_GOAL = 10000;

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* Login required. Mana Clash used to accept a localStorage guest id, which
   made "most wins" unownable — a guest id is free to mint, so a board built
   on it ranks whoever cared to refresh. Prizes ride on these boards. */
function getPlayer(request) {
  const session = getSession(request);
  if (!session || !session.user_id) return null;
  return {
    userId: String(session.user_id),
    displayName: session.display_name || 'Player',
    profileImage: session.profile_image || null,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/* ══ Turn state ═══════════════════════════════════════════════════════════
   One player's turn within one round. `pending` is at risk until banked —
   that tension is the whole game. */

function freshTurn(room, now) {
  return {
    pending: 0,
    dice: [],               // on the table, not yet resolved
    kept: [],               // set aside this turn, for display
    remaining: DICE_COUNT,  // how many will be rolled next
    awaitingSelection: false,
    done: null,             // 'banked' | 'burned' | 'timeout' | 'out'
    /* What this round actually added to the total, filled in when the turn
       resolves. Stated rather than left for the page to infer from `pending`
       — pending happens not to be cleared on a bank, and a display that
       depends on a field not being reset is one refactor from lying. */
    gained: null,
    event: null,            // 'clash' | 'burn', for the page to animate
    deadline: now + room.idleMs,
  };
}

function sittingOut() {
  return {
    pending: 0, dice: [], kept: [], remaining: 0,
    awaitingSelection: false, done: 'out', gained: null, event: null, deadline: null,
  };
}

/** Any action by the player resets their idle clock. */
function touch(room, turn, now) {
  turn.deadline = now + room.idleMs;
}

/**
 * Who ROLLS this round.
 *
 * Not everyone, on a final round. Reaching the goal ends your game: the
 * final round belongs to the people trying to beat you, and you watch.
 */
function playersInRound(room) {
  const all = Object.keys(room.players);
  if (room.tiedPlayers) return all.filter(id => room.tiedPlayers.includes(id));
  const resting = room.restingIds || [];
  return all.filter(id => !resting.includes(id));
}

/**
 * Who can WIN. A different list, and conflating the two was a real bug.
 *
 * The player who crossed the goal sits the final round out but is very much
 * still in the running — everyone else is playing to beat them. One
 * eligibility list served both purposes, so the leader was excluded from the
 * comparison that decides their own victory, and whoever came closest among
 * the chasers won with a lower score.
 */
function contenders(room) {
  const all = Object.keys(room.players);
  if (room.tiedPlayers) return all.filter(id => room.tiedPlayers.includes(id));
  return all;
}

/* ══ Co-op gauntlet ═══════════════════════════════════════════════════════
   A cooperative mode: everyone is one team against a SERIES of enemies. Each
   encounter, the team's banked points are damage; deplete the enemy's health
   within its round budget to advance to a tougher one — a boss every fifth,
   then a final boss, then endless Nightmare waves. A round the team can't
   finish ends the run. "How far you got" (enemies cleared) is the score. No
   winner, no leaderboard — you win or lose together. A bust deals no damage
   that turn, so pushing your luck is a decision the whole team shares. */
const COOP_BASE_HP = 1500;
const COOP_GROWTH = 1.25;
const COOP_FINAL_WAVE = 20;

/* ── Combat tuning (first pass — all adjustable) ──
   Team HP is a shared pool: the enemy attacks it each round, and running it
   to zero ends the run just like running out of the round budget does. The
   colour of the DICE the team banks drives the roll-reactive effects, each
   triggered per three-of-a-kind ("trio") banked that round:
     1 Colourless → piercing straight damage (ignores shield & minions)
     2 White      → heal the team
     3 Blue       → +1 round to the budget
     4 Black      → +1 Poison stack on the enemy (damage each round)
     5 Red        → +1 Burn stack on the minions (damage each round)
     6 Green      → team damage buff for a few rounds */
const COOP_TEAM_HP_BASE = 100;
const COOP_TEAM_HP_PER_PLAYER = 50;
const COOP_DMG_BUFF_MULT = 1.5;      // Green
const COOP_GREEN_ROUNDS = 2;         // buff rounds per Green trio
const COOP_WHITE_HEAL = 25;          // team HP per White trio
const COOP_ENRAGE_MULT = 1.75;       // attack up when cornered
const COOP_MINION_ATK = 3;           // added enemy attack per living minion
const COOP_POISON_PCT = 0.02;        // enemy maxHp lost per Poison stack per round
const COOP_BURN_PCT = 0.04;          // minion maxHp lost per Burn stack per round
const COOP_COLORLESS_PCT = 0.05;     // piercing damage per Colourless trio (of enemy maxHp)
const COOP_WEAK_BONUS_PCT = 0.06;    // bonus damage per trio of the enemy's weak colour
const COOP_HEAL_PCT = 0.03;          // enemy self-heal when under-pressured
const COOP_MINION_SOAK = 0.4;        // share of team damage minions absorb
const COOP_SUMMON_THRESHOLDS = [0.66, 0.33];
const COOP_OVERKILL_CARRY = 0.5;     // share of overkill that spills to the next enemy
const COOP_SECOND_WIND_HP_PCT = 0.4; // team HP restored when a wipe is cheated
const COOP_SECOND_WIND_ROUNDS = 3;   // rounds granted when a timeout is cheated

/* Between-wave boons — the team picks one of three after every clear, building
   a run. Effects accumulate on room.coop.boons; some apply immediately. */
const COOP_BOONS = [
  { id: 'vigor',   name: 'Vigor',        desc: '+30 max Team HP (and heal it)' },
  { id: 'venom',   name: 'Venomcraft',   desc: 'Poison ticks 50% harder' },
  { id: 'zeal',    name: 'Zealotry',     desc: '+12% team damage' },
  { id: 'medic',   name: 'Field Medic',  desc: 'White healing +50%' },
  { id: 'slayer',  name: 'Giant Slayer', desc: '+1 round on every enemy' },
  { id: 'purify',  name: 'Purifier',     desc: 'Enemy minions soak 15% less' },
  { id: 'wind',    name: 'Second Wind',  desc: 'Cheat a wipe or a timeout (stacks — one save each)' },
  { id: 'bulwark', name: 'Bulwark',      desc: 'Team takes 15% less damage' },
  { id: 'army',    name: 'Conscripts',   desc: 'An ally strikes for 3% of enemy HP each round' },
  { id: 'regen',   name: 'Regeneration', desc: 'Heal 8 Team HP every round' },
];
function coopBoonDefaults() {
  return { dmgMult: 0, poisonMult: 0, healMult: 0, roundsBonus: 0, soakReduce: 0, secondWind: 0,
    dmgTakenMult: 1, allyPct: 0, regen: 0, taken: [] };
}
/* Three distinct boons on offer. Every boon stacks without limit, so all seven
   are always eligible — Second Wind included (each copy is another revive). */
function coopOfferBoons(c) {
  const out = [];
  const bag = COOP_BOONS.slice();
  while (out.length < 3 && bag.length) out.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
  return out.map(b => ({ id: b.id, name: b.name, desc: b.desc }));
}
/* Vote counts per offered boon, for the client to show the live tally. */
function coopVoteTally(c) {
  const t = {};
  for (const opt of (c.pendingBoons || [])) t[opt.id] = 0;
  for (const id of Object.keys(c.boonVotes || {})) {
    if (t[c.boonVotes[id]] !== undefined) t[c.boonVotes[id]] += 1;
  }
  return t;
}
function coopApplyBoon(c, id) {
  const b = c.boons;
  switch (id) {
    case 'vigor':  c.teamHpBonus = (c.teamHpBonus || 0) + 30; break;   // realized as +max & heal on the next spawn
    case 'venom':  b.poisonMult += 0.5; break;
    case 'zeal':   b.dmgMult += 0.12; break;
    case 'medic':  b.healMult += 0.5; break;
    case 'slayer': b.roundsBonus += 1; break;
    case 'purify': b.soakReduce += 0.15; break;
    case 'wind':   b.secondWind = (b.secondWind || 0) + 1; break;      // stacks — one revive charge each
    case 'bulwark': b.dmgTakenMult = (b.dmgTakenMult || 1) * 0.85; break;  // team shield, multiplicative
    case 'army':    b.allyPct = (b.allyPct || 0) + 0.03; break;        // summoned ally damage per round
    case 'regen':   b.regen = (b.regen || 0) + 8; break;              // heal each round
    default: return false;
  }
  b.taken.push(id);
  return true;
}

/* Tally the current votes and apply the winner — shared by choose-boon
   (once everyone has voted) and advance() (once the vote's deadline passes
   regardless of who has). Ties, including "nobody voted at all" where
   every tally sits at 0, break by offer order — there is always a winner
   to fall back to, even out of zero votes. */
function coopResolveBoonVote(r, now) {
  const c = r.coop;
  const offered = (c.pendingBoons || []).map(x => x.id);
  const tally = {};
  for (const id of Object.keys(r.players)) {
    const vote = c.boonVotes && c.boonVotes[id];
    if (vote) tally[vote] = (tally[vote] || 0) + 1;
  }
  let winner = offered[0], best = -1;
  for (const opt of offered) {
    const v = tally[opt] || 0;
    if (v > best) { best = v; winner = opt; }
  }
  coopApplyBoon(c, winner);
  c.lastBoon = winner;
  c.awaitingBoon = false;
  c.pendingBoons = null;
  c.boonVotes = null;
  c.boonVoteDeadline = null;
  coopSpawn(r, c.wave + 1);
  r.status = 'intermission';
  r.intermissionEndsAt = now + COOP_INTERMISSION_MS;
}

/* The enemy roster — real art from the itch.io packs, keyed by slug with its
   idle-strip frame count so the client can animate it. Generated from
   games/mana-clash/assets/enemies/manifest.json. */
const COOP_ROSTER = {
  normal: [
    { slug: 'bat', name: 'Bat', frames: 9 },
    { slug: 'boar', name: 'Boar', frames: 4 },
    { slug: 'character', name: 'Adventurer', frames: 4 },
    { slug: 'devil', name: 'Devil', frames: 4 },
    { slug: 'gingerbread', name: 'Gingerbread', frames: 4 },
    { slug: 'golem-blue', name: 'Blue Golem', frames: 8 },
    { slug: 'golem-orange', name: 'Orange Golem', frames: 8 },
    { slug: 'kid-ghost', name: 'Kid Ghost', frames: 4 },
    { slug: 'nasta', name: 'Nasta', frames: 4 },
    { slug: 'pig', name: 'Pig', frames: 4 },
    { slug: 'piggy', name: 'Piggy', frames: 4 },
    { slug: 'reindeer', name: 'Reindeer', frames: 4 },
    { slug: 'reindeer-phurold', name: 'Phurold Reindeer', frames: 4 },
    { slug: 'reindeer-rudolph', name: 'Rudolph Reindeer', frames: 4 },
    { slug: 'skeleton', name: 'Skeleton', frames: 4 },
    { slug: 'skeleton-white', name: 'White Skeleton', frames: 12 },
    { slug: 'skeleton-yellow', name: 'Yellow Skeleton', frames: 12 },
    { slug: 'slime', name: 'Slime', frames: 4 },
    { slug: 'snowman-a', name: 'Snowman', frames: 4 },
    { slug: 'snowman-b', name: 'Frost Snowman', frames: 4 },
    { slug: 'snowman-c', name: 'Grim Snowman', frames: 4 },
    { slug: 'snowman-d', name: 'Coal Snowman', frames: 4 },
    { slug: 'snowman-e', name: 'Icy Snowman', frames: 4 },
    { slug: 'snowman-f', name: 'Cursed Snowman', frames: 4 },
    { slug: 'snowman-g', name: 'Wicked Snowman', frames: 4 },
    { slug: 'witch-doctor', name: 'Witch Doctor', frames: 4 },
  ],
  boss: [
    { slug: 'boss-badger', name: 'Badger', frames: 5 },
    { slug: 'boss-cat', name: 'Gunslinger Cat', frames: 5 },
    { slug: 'boss-dino-rex', name: 'Dino Rex', frames: 5 },
    { slug: 'boss-dino-tri', name: 'Dino Tri', frames: 6 },
    { slug: 'boss-frogger', name: 'Frogger', frames: 5 },
    { slug: 'boss-gollux', name: 'Gollux', frames: 5 },
    { slug: 'boss-pengu', name: 'Pengu', frames: 5 },
    { slug: 'demon-slime', name: 'Demon Slime', frames: 6 },
    { slug: 'necromancer', name: 'Necromancer', frames: 8 },
  ],
  final: { slug: 'bringer-of-death', name: 'Bringer of Death', frames: 8 },
};
const COOP_BACKGROUNDS = ['cave', 'dead-forest', 'dock', 'plains', 'snowy-mountains'];

/* Random, not a fixed cycle — a fixed `wave*7 % len` formula meant every run
   fought the exact same enemy on the exact same wave, in the exact same
   order, forever. Picked once here and stored on the room (enemySlug etc.),
   so every polling client still agrees on the result without needing the
   pick itself to be deterministic — they're just reading what the server
   already decided.

   `avoidSlug` (the outgoing enemy) is excluded so two same-tier waves in a
   row can't hand back the exact same enemy that was just cleared. */
export function pickRandom(pool, avoidSlug) {
  if (pool.length <= 1) return pool[0];
  let choice;
  do { choice = pool[Math.floor(Math.random() * pool.length)]; } while (choice.slug === avoidSlug);
  return choice;
}

/* Which enemy stands at `wave`. Final boss at wave 20; a random boss every
   fifth wave; a random pick from the normal roster otherwise. Past the
   final boss it keeps randomly cycling into ever-tougher Nightmare waves. */
export function coopPick(wave, avoidSlug) {
  if (wave === COOP_FINAL_WAVE) return Object.assign({ tier: 'final' }, COOP_ROSTER.final);
  if (wave % 5 === 0) return Object.assign({ tier: 'boss' }, pickRandom(COOP_ROSTER.boss, avoidSlug));
  return Object.assign({ tier: 'normal' }, pickRandom(COOP_ROSTER.normal, avoidSlug));
}

/* Team HP is a shared pool sized to the CURRENT roster (plus any Vigor boons).
   Kept in a helper so spawn can resize it when players join or leave mid-run. */
function coopTeamMax(players, bonus = 0) {
  return COOP_TEAM_HP_BASE + COOP_TEAM_HP_PER_PLAYER * (Math.max(1, players) - 1) + bonus;
}

/* Set the room's current enemy for `wave`. HP and attack grow with the wave and
   with the party size. A bigger team banks proportionally more damage each
   round, so enemy HP scales near-LINEARLY with players (not the old half-rate
   curve that made big teams a pushover); attack scales too, since more players
   also means a deeper HP pool and more healing to out-pace. */
function coopSpawn(room, wave) {
  const pick = coopPick(wave, room.coop.enemySlug);
  const isFinal = pick.tier === 'final';
  const isBoss = pick.tier === 'boss';
  const players = Math.max(1, Object.keys(room.players).length);
  let hp = COOP_BASE_HP * Math.pow(COOP_GROWTH, wave - 1);
  if (isBoss) hp *= 2.6;
  if (isFinal) hp *= 5;
  if (wave > COOP_FINAL_WAVE) hp *= 1.5;          // nightmare tier bites harder
  hp *= (0.2 + 0.8 * players);                    // party scaling — solo ×1.0, +0.8 per extra player
  hp = Math.ceil(Math.round(hp) / 100) * 100;     // round first so float dust (2.4000…) doesn't bump a clean value
  room.coop.wave = wave;
  room.coop.enemyName = wave > COOP_FINAL_WAVE ? pick.name + ' (Nightmare ' + (wave - COOP_FINAL_WAVE) + ')' : pick.name;
  room.coop.enemySlug = pick.slug;
  room.coop.enemyFrames = pick.frames;
  room.coop.enemyMaxHp = hp;
  /* Overkill from the previous clear spills in, but can't skip a whole enemy —
     it leaves at least 1 HP so every wave is still fought. */
  const carry = room.coop.carryover || 0;
  room.coop.enemyHp = carry > 0 ? Math.max(1, hp - carry) : hp;
  room.coop.carryover = 0;
  const roundsBonus = (room.coop.boons && room.coop.boons.roundsBonus) || 0;
  room.coop.roundsLeft = (isFinal ? 9 : isBoss ? 7 : 5) + roundsBonus;
  room.coop.isBoss = isBoss;
  room.coop.isFinal = isFinal;
  room.coop.bg = COOP_BACKGROUNDS[(wave - 1) % COOP_BACKGROUNDS.length];
  /* This enemy is vulnerable to one mana colour — that colour's banked effect
     lands doubled. Rotates so a run sees every colour matter. */
  room.coop.weakColor = ((wave * 7) % 6) + 1;

  /* How hard the enemy hits the team's shared HP each round, in team-HP
     units (not the point/damage scale the enemy's own HP lives in). */
  let atk = 4 + wave;
  if (isBoss) atk *= 1.7;
  if (isFinal) atk *= 2.3;
  if (wave > COOP_FINAL_WAVE) atk *= 1.4;
  atk *= (0.7 + 0.3 * players);                   // bigger parties get hit harder too
  room.coop.enemyAttack = Math.round(atk);

  /* Resize the shared team pool to the current roster (and Vigor bonuses),
     preserving current HP: a player joining reinforces the team by their
     share, one leaving trims the cap without draining what's left. Runs on
     every spawn, so a mid-run join/leave is reflected on the next enemy. */
  const newMax = coopTeamMax(players, room.coop.teamHpBonus || 0);
  const oldMax = room.coop.teamMaxHp || newMax;
  if (typeof room.coop.teamHp !== 'number') room.coop.teamHp = newMax;
  else if (newMax > oldMax) room.coop.teamHp += (newMax - oldMax);   // reinforcement / Vigor heal
  else room.coop.teamHp = Math.min(room.coop.teamHp, newMax);
  room.coop.teamMaxHp = newMax;
  /* Bosses raise a damage-halving shield on a cadence; normal enemies don't. */
  room.coop.shieldEvery = isFinal ? 2 : isBoss ? 3 : 0;
  /* Combat state is per-enemy — it resets with each new foe. Team HP does not
     (it is the run-long resource, carried across enemies by coopInit). */
  room.coop.poison = 0;
  room.coop.burn = 0;
  room.coop.shieldRounds = 0;
  room.coop.dmgBuffRounds = 0;
  room.coop.minions = { hp: 0, maxHp: 0, count: 0 };
  room.coop.summonedThresholds = [];
  room.coop.roundsThisEnemy = 0;
  room.coop.log = [];
}

function coopInit(room) {
  const players = Math.max(1, Object.keys(room.players).length);
  const teamMax = coopTeamMax(players);
  room.coop = {
    cleared: 0, victory: false, runOver: false, lastDamage: 0, justCleared: false,
    teamMaxHp: teamMax, teamHp: teamMax, teamHpBonus: 0, log: [],
    boons: coopBoonDefaults(), carryover: 0, awaitingBoon: false, pendingBoons: null,
  };
  coopSpawn(room, 1);
}

/* Count three-of-a-kinds banked this round, by die face (1-6 = the mana
   colours). Six-of-a-kind counts as two trios. Only dice that were kept and
   banked count — a Mana Burn clears them, so busting earns no colour effect. */
function coopTrios(room) {
  const t = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const p of Object.values(room.players)) {
    const turn = p.turn;
    if (!turn || (turn.done !== 'banked' && turn.done !== 'timeout')) continue;
    const counts = {};
    for (const d of (turn.kept || [])) {
      /* Kept dice are stored as LETTER faces ('C','W','U','B','R','G'); map to
         the 1-6 colour number. (Numbers are tolerated too, for seeded tests.) */
      const f = typeof d === 'number' ? d : FACE_VALUE[d];
      if (f) counts[f] = (counts[f] || 0) + 1;
    }
    for (let f = 1; f <= 6; f++) t[f] += Math.floor((counts[f] || 0) / 3);
  }
  return t;
}

/* The hit the enemy (plus any minions) will land next round, enrage included —
   for the telegraph the team plans around. */
function coopNextAttack(c) {
  if (!c || typeof c.enemyAttack !== 'number') return 0;
  let atk = c.enemyAttack + ((c.minions && c.minions.count) || 0) * COOP_MINION_ATK;
  if (c.roundsLeft <= 2 || (c.enemyMaxHp > 0 && c.enemyHp / c.enemyMaxHp < 0.25)) atk = Math.round(atk * COOP_ENRAGE_MULT);
  return atk;
}

/* Bosses and the final boss call in minions at HP thresholds. Minions are a
   single soak pool with a headcount: while alive they absorb a share of the
   team's damage and add to the enemy's attack, and Red Burn eats away at them. */
function coopSummon(c) {
  if (!c.isBoss && !c.isFinal) return 0;
  const frac = c.enemyHp / c.enemyMaxHp;
  for (const th of COOP_SUMMON_THRESHOLDS) {
    if (frac <= th && !c.summonedThresholds.includes(th)) {
      c.summonedThresholds.push(th);
      const count = c.isFinal ? 3 : 2;
      const pool = Math.ceil(c.enemyMaxHp * 0.15);
      const alive = c.minions.hp > 0;
      c.minions.count = (alive ? c.minions.count : 0) + count;
      c.minions.maxHp = (alive ? c.minions.maxHp : 0) + pool;
      c.minions.hp = (alive ? c.minions.hp : 0) + pool;
      return count;
    }
  }
  return 0;
}

/* End the run, no winner — the team either wiped or ran out of time. */
function coopEnd(room, now) {
  room.status = 'finished';
  room.winner = null;
  room.runOver = true;
  room.coop.runOver = true;
  room.finishedAt = now;
  room.intermissionEndsAt = null;
}

/* Resolve a co-op round. The team's banked points are damage; the COLOURS of
   the dice they banked (per three-of-a-kind) trigger the roll-reactive effects;
   the enemy hits back at the team's shared HP and works its own mechanics.
   Order matters — see the numbered steps. */
function endRoundCoop(room, now) {
  const c = room.coop;
  /* Defensive defaults so a room that was mid-run when this deployed (and any
     stripped-down test fixture) resolves instead of throwing on a missing field. */
  if (!c.minions) c.minions = { hp: 0, maxHp: 0, count: 0 };
  if (typeof c.teamHp !== 'number') { c.teamMaxHp = c.teamMaxHp || COOP_TEAM_HP_BASE; c.teamHp = c.teamMaxHp; }
  if (typeof c.enemyAttack !== 'number') c.enemyAttack = 6;
  c.poison = c.poison || 0; c.burn = c.burn || 0;
  c.dmgBuffRounds = c.dmgBuffRounds || 0; c.shieldRounds = c.shieldRounds || 0;
  c.summonedThresholds = c.summonedThresholds || [];
  c.shieldEvery = c.shieldEvery || 0;
  if (!c.boons) c.boons = coopBoonDefaults();
  if (!c.weakColor) c.weakColor = 1;
  c.roundsThisEnemy = (c.roundsThisEnemy || 0) + 1;
  const b = c.boons;
  const log = [];
  /* This enemy's weak colour lands its banked effect doubled. */
  const eff = (face) => trios[face] * (face === c.weakColor ? 2 : 1);

  /* 1. Raw banked points across the team, and the colour trios that back them. */
  let raw = 0;
  for (const p of Object.values(room.players)) raw += (p.turn && p.turn.gained) || 0;
  const trios = coopTrios(room);

  /* 2. Zealotry boon then a standing Green buff amplify this round's hit. */
  let dmg = Math.round(raw * (1 + b.dmgMult));
  if (c.dmgBuffRounds > 0) dmg = Math.round(dmg * COOP_DMG_BUFF_MULT);

  /* 3. Colourless: piercing straight damage — ignores shield and minions. */
  const pierce = eff(1) * Math.ceil(c.enemyMaxHp * COOP_COLORLESS_PCT);

  /* 4. Shield halves the ordinary (non-piercing) hit. */
  let shielded = false;
  if (c.shieldRounds > 0) { dmg = Math.round(dmg * 0.5); shielded = true; }

  /* 5. Minions soak a share of the ordinary hit (less if Purifier is held),
     then Red Burn eats them. */
  if (c.minions.hp > 0) {
    const soak = Math.round(dmg * Math.max(0, COOP_MINION_SOAK - b.soakReduce));
    c.minions.hp -= soak;
    dmg -= soak;
  }
  if (c.burn > 0 && c.minions.hp > 0) {
    c.minions.hp -= c.burn * Math.ceil(c.enemyMaxHp * COOP_BURN_PCT);
  }
  if (c.minions.count > 0 && c.minions.hp <= 0) {
    c.minions = { hp: 0, maxHp: 0, count: 0 };
    c.burn = 0;                       // nothing left to burn
    log.push('minions-cleared');
  }

  /* 6. The enemy takes what's left, plus piercing, plus the Poison DoT
     (harder with Venomcraft), plus a weakness strike — banking a trio of the
     enemy's weak colour always tears off bonus HP, on top of doubling that
     colour's effect. So weakness is felt every time, whatever colour it is. */
  const poisonDmg = c.poison * Math.ceil(c.enemyMaxHp * COOP_POISON_PCT * (1 + b.poisonMult));
  const weakTrios = c.weakColor ? (trios[c.weakColor] || 0) : 0;
  const weakBonus = weakTrios * Math.ceil(c.enemyMaxHp * COOP_WEAK_BONUS_PCT);
  /* Conscripts: summoned allies chip the enemy every round, regardless of dice. */
  const allyDmg = (b.allyPct || 0) > 0 ? Math.ceil(c.enemyMaxHp * b.allyPct) : 0;
  if (allyDmg) log.push('ally:' + allyDmg);
  const dealt = Math.max(0, dmg) + pierce + poisonDmg + weakBonus + allyDmg;
  const before = c.enemyHp;
  c.enemyHp = Math.max(0, before - dealt);
  c.lastDamage = raw;
  c.lastDealt = dealt;
  if (weakTrios) log.push('weak:' + c.weakColor);

  /* 7. Apply the colour effects that heal now or seed later rounds. */
  if (eff(2)) { c.teamHp = Math.min(c.teamMaxHp, c.teamHp + Math.round(eff(2) * COOP_WHITE_HEAL * (1 + b.healMult))); log.push('heal:' + eff(2)); }
  /* Blue (eff(3)) is applied at the round-spend step so it produces a visible
     net gain instead of being cancelled by the spend. */
  if (eff(4)) { c.poison += eff(4); log.push('poison:' + eff(4)); }
  if (eff(5)) { c.burn += eff(5); log.push('burn:' + eff(5)); }
  if (eff(6)) { c.dmgBuffRounds += eff(6) * COOP_GREEN_ROUNDS; log.push('buff:' + eff(6)); }
  if (eff(1)) log.push('pierce:' + eff(1));
  if (shielded) log.push('shielded');

  /* 8. Enemy down — bank the clear, capture overkill spill, heal the team, and
     offer a boon before the next enemy (the run pauses until one is chosen). */
  if (c.enemyHp <= 0) {
    c.cleared += 1;
    if (c.isFinal) c.victory = true;   // milestone flag; the gauntlet plays on
    c.justCleared = true;
    c.carryover = Math.max(0, Math.round((dealt - before) * COOP_OVERKILL_CARRY));
    c.teamHp = c.teamMaxHp;             // clearing an enemy fully restores the team
    c.log = log;
    c.awaitingBoon = true;
    c.pendingBoons = coopOfferBoons(c);
    c.boonVotes = {};                   // userId → boon id, tallied when everyone has voted
    /* Resolved early once everyone votes; force-resolved with whatever
       exists once this passes, so one AFK player can't hold the run open
       forever. See coopResolveBoonVote and its call from advance(). */
    c.boonVoteDeadline = now + COOP_BOON_VOTE_MS;
    room.status = 'intermission';
    room.intermissionEndsAt = null;    // no auto-advance until the vote resolves
    return;
  }
  c.justCleared = false;

  /* 9. Bosses summon reinforcements as their health falls. */
  const summoned = coopSummon(c);
  if (summoned) log.push('summon:' + summoned);

  /* 10. The enemy (and any minions) strike the team's shared HP, enraging
     when cornered on time or health. */
  let atk = c.enemyAttack + c.minions.count * COOP_MINION_ATK;
  if (c.roundsLeft <= 2 || c.enemyHp / c.enemyMaxHp < 0.25) { atk = Math.round(atk * COOP_ENRAGE_MULT); log.push('enrage'); }
  atk = Math.round(atk * (b.dmgTakenMult || 1));   // Bulwark softens the blow
  c.teamHp -= atk;
  c.lastAttack = atk;
  log.push('hit:' + atk);
  /* Regeneration heals a flat amount every round (after the hit lands). */
  if (b.regen > 0) { c.teamHp = Math.min(c.teamMaxHp, c.teamHp + b.regen); log.push('regen:' + b.regen); }

  /* 11. If the team barely scratched it, the enemy regenerates (anti-stall). */
  if (dealt < c.enemyMaxHp * 0.04) {
    const heal = Math.ceil(c.enemyMaxHp * COOP_HEAL_PCT);
    c.enemyHp = Math.min(c.enemyMaxHp, c.enemyHp + heal);
    log.push('enemyheal:' + heal);
  }

  /* 12. Bosses raise a shield for the coming round on their cadence. */
  if (c.shieldEvery && c.roundsThisEnemy % c.shieldEvery === 0) { c.shieldRounds = 2; log.push('shield-up'); }

  /* 13. Tick the timed effects down and settle the round budget. Blue trios
     extend the fight: the round you bank them in isn't spent, and each trio
     banks an extra round on top — so the counter visibly climbs (doubled on a
     Blue-weak enemy). Any other round simply spends one. */
  if (c.dmgBuffRounds > 0) c.dmgBuffRounds -= 1;
  if (c.shieldRounds > 0) c.shieldRounds -= 1;
  const blueRounds = eff(3);
  if (blueRounds > 0) { c.roundsLeft += blueRounds; log.push('rounds:' + blueRounds); }
  else c.roundsLeft -= 1;
  c.log = log;

  /* 14. Loss checks — wiped, or out of time with the enemy still standing.
     Second Wind cheats death from EITHER cause, each spending its own
     charge: a wipe revives the team to COOP_SECOND_WIND_HP_PCT of max HP, a
     timeout grants COOP_SECOND_WIND_ROUNDS more rounds to keep fighting.
     The two checks are independent (not else-if) — a room that manages to
     hit zero HP and zero rounds in the same round can cheat both, if it
     holds enough charges to cover them. */
  if (c.teamHp <= 0) {
    if (b.secondWind > 0) {
      b.secondWind -= 1;                // spend one revive charge
      c.teamHp = Math.max(1, Math.round(c.teamMaxHp * COOP_SECOND_WIND_HP_PCT));
      c.log = log.concat('second-wind');
    } else {
      c.teamHp = 0;
      return coopEnd(room, now);
    }
  }
  if (c.roundsLeft <= 0) {
    if (b.secondWind > 0) {
      b.secondWind -= 1;                // spend one revive charge
      c.roundsLeft = COOP_SECOND_WIND_ROUNDS;
      c.log = c.log.concat('second-wind-rounds');
    } else {
      return coopEnd(room, now);
    }
  }

  room.status = 'intermission';
  room.intermissionEndsAt = now + COOP_INTERMISSION_MS;
}

/* ══ Round lifecycle ══════════════════════════════════════════════════════ */

function startRound(room, now) {
  room.round++;
  room.isFinalRound = !!room.nextIsFinal;
  room.nextIsFinal = false;
  room.status = 'playing';
  room.roundStartedAt = now;
  room.intermissionEndsAt = null;

  /* Only a final round rests anyone. Cleared here so a tiebreak, or a game
     that somehow carries on, does not inherit a stale list. */
  if (!room.isFinalRound) room.restingIds = [];

  const playing = playersInRound(room);
  for (const [id, p] of Object.entries(room.players)) {
    p.turn = playing.includes(id) ? freshTurn(room, now) : sittingOut();
  }
}

/**
 * Every eligible player has banked or burned.
 *
 * The goal does not end the game on its own. Crossing it arms one final
 * round that everyone plays, so being last to act is not a disadvantage —
 * which is the point of simultaneous rounds.
 */
function endRound(room, now) {
  /* Co-op has its own resolution — team damage vs one enemy, not a race. */
  if (room.mode === 'coop') return endRoundCoop(room, now);

  /* Everyone eligible has left or been removed. Ending on whoever is still
     in the room beats looping the round forever with nobody in it. */
  const remaining = Object.keys(room.players);
  if (playersInRound(room).length === 0) {
    room.status = 'finished';
    room.winner = remaining.length
      ? remaining.reduce((a, b) => (room.players[b].total > room.players[a].total ? b : a))
      : null;
    room.finishedAt = now;
    room.intermissionEndsAt = null;
    return;
  }

  if (room.isFinalRound) {
    /* Over CONTENDERS, not over whoever rolled. The player resting on the
       goal is the one everybody was chasing; leaving them out of this
       comparison would hand the game to the best of the chasers even when
       none of them caught up. */
    const pool = contenders(room);
    const best = Math.max(...pool.map(id => room.players[id].total));
    const tied = pool.filter(id => room.players[id].total === best);

    if (tied.length > 1) {
      room.tiedPlayers = tied;
      room.restingIds = [];             // a tiebreak is played by all the tied
      room.nextIsFinal = true;          // the tiebreak is itself a final round
      room.status = 'intermission';
      room.intermissionEndsAt = now + INTERMISSION_MS;
      return;
    }

    room.status = 'finished';
    room.winner = tied[0];
    room.finishedAt = now;
    room.intermissionEndsAt = null;
    return;
  }

  /* Whoever crossed the goal is finished. They rest through the final round
     while everyone else gets one turn to beat them — which is the whole
     point of a final round, and is not what happens if the leader plays it
     too and simply extends their own lead. */
  const crossed = Object.keys(room.players).filter(id => room.players[id].total >= room.goal);
  room.nextIsFinal = crossed.length > 0;
  room.restingIds = crossed;
  room.status = 'intermission';
  room.intermissionEndsAt = now + INTERMISSION_MS;
}

function roundIsOver(room) {
  const playing = playersInRound(room);
  if (playing.length === 0) return true;
  return playing.every(id => room.players[id].turn && room.players[id].turn.done);
}

/**
 * Apply everything the clock owes: expired idle timers, then a finished
 * round, then an elapsed intermission — in that order, repeatedly, because
 * each can cause the next. A room polled after a long gap catches up in one
 * pass rather than one step per poll.
 *
 * Returns true if anything changed, which is what decides whether a poll
 * writes at all.
 */
function advance(room, now) {
  let changed = false;

  for (let guard = 0; guard < 50; guard++) {
    if (room.status === 'playing') {
      for (const id of playersInRound(room)) {
        const turn = room.players[id].turn;
        if (!turn || turn.done || turn.deadline === null || now < turn.deadline) continue;
        /* Expiry banks what they are holding rather than taking it. The
           clock exists so one closed tab cannot stall a room, not to punish
           slow play. Anything rolled but never selected is simply not part
           of `pending`, so it is neither kept nor lost — there was no
           decision, so nothing is taken for one. */
        room.players[id].total += turn.pending;
        turn.gained = turn.pending;
        turn.done = 'timeout';
        turn.awaitingSelection = false;
        changed = true;
      }

      if (roundIsOver(room)) { endRound(room, now); changed = true; continue; }
      break;
    }

    if (room.status === 'intermission') {
      /* A co-op clear pauses here until the team picks a boon; there is no
         intermission clock to run down (intermissionEndsAt is null) while
         this is open. It still has ITS OWN deadline though — force-resolve
         with whatever votes exist once that passes, so one AFK player can't
         hold the run open forever the way an unlimited wait would. */
      if (room.mode === 'coop' && room.coop && room.coop.awaitingBoon) {
        if (typeof room.coop.boonVoteDeadline === 'number' && now >= room.coop.boonVoteDeadline) {
          coopResolveBoonVote(room, now);
          changed = true;
          continue;
        }
        break;
      }
      if (room.intermissionEndsAt === null || now < room.intermissionEndsAt) break;
      startRound(room, now);
      changed = true;
      continue;
    }

    break;   // lobby or finished — nothing the clock owes
  }

  return changed;
}

/* ══ Leaderboards ═════════════════════════════════════════════════════════
   Written here, from the finished room, rather than POSTed by the winner's
   browser. The server already knows who won; asking the client to report it
   would make "most wins" a number anyone can curl.

   Only ranked games count: goal exactly 10,000, and not a practice room. */

const WINS_BOARD = 'lb_mana_clash_wins';
const SCORE_BOARD = 'lb_mana_clash';
const MAX_ENTRIES = 50;

function isRanked(room) {
  return room.goal === RANKED_GOAL && !room.practice;
}

async function recordResult(env, room) {
  if (!isRanked(room)) return;

  await env.MARKETPLACE.mutate(WINS_BOARD, (current) => {
    const lb = Array.isArray(current) ? current : [];
    const winner = room.players[room.winner];
    if (!winner) return undefined;
    const row = lb.find(e => e.id === room.winner);
    if (row) { row.score += 1; row.name = winner.displayName; row.updatedAt = Date.now(); }
    else lb.push({ id: room.winner, name: winner.displayName, score: 1, updatedAt: Date.now() });
    lb.sort((a, b) => b.score - a.score);
    return lb.slice(0, MAX_ENTRIES);
  });

  /* Every player's final score, not only the winner's — a strong losing
     game still deserves to register on a high-score board. */
  await env.MARKETPLACE.mutate(SCORE_BOARD, (current) => {
    const lb = Array.isArray(current) ? current : [];
    for (const [id, p] of Object.entries(room.players)) {
      if (p.total <= 0) continue;
      const row = lb.find(e => e.id === id);
      if (row) {
        if (p.total > row.score) { row.score = p.total; row.updatedAt = Date.now(); }
        row.name = p.displayName;
      } else {
        lb.push({ id, name: p.displayName, score: p.total, updatedAt: Date.now() });
      }
    }
    lb.sort((a, b) => b.score - a.score);
    return lb.slice(0, MAX_ENTRIES);
  });
}

/* ══ Views ════════════════════════════════════════════════════════════════
   A player is told about their own dice and everyone else's totals. Sending
   the whole room document would hand every client every other player's
   hand — harmless in a friendly game, but it is also how you would cheat,
   and with a hundred players it is a lot of JSON per poll. */

function publicPlayer(id, p, { dice = false } = {}) {
  const out = {
    id,
    name: p.displayName,
    avatar: p.profileImage,
    ready: !!p.ready,
    total: p.total,
    pending: p.turn ? p.turn.pending : 0,
    /* Null until the turn resolves, so the page can tell "holding 550, still
       rolling" from "banked 550" without guessing. */
    gained: p.turn ? p.turn.gained : null,
    done: p.turn ? p.turn.done : null,
    event: p.turn ? p.turn.event : null,
  };

  /* OPT-IN. The overlay always asks (viewFor's caller passes {dice:true});
     viewFor also now forces it on for every player in CO-OP, because a team
     deciding whether to chase a Blue trio or bank now needs to see what
     colour everyone else is actually holding, not just their point total —
     there's no opponent to hide a hand from. Versus keeps the old default
     off: the game page has never needed an opponent's dice there, and
     quietly widening what every client receives to serve one spectator (or
     one mode) is how a contract drifts, so it stays a deliberate opt-in
     rather than the default for everyone.

     Nothing here is secret regardless. Dice are rolled face up; every one
     of these numbers is already on the screen of the player who rolled it. */
  if (dice && p.turn) {
    out.dice = Array.isArray(p.turn.dice) ? p.turn.dice.slice() : [];
    out.kept = Array.isArray(p.turn.kept) ? p.turn.kept.slice() : [];
    out.remaining = p.turn.remaining;
    out.awaitingSelection = !!p.turn.awaitingSelection;
  }

  return out;
}

/**
 * The room as one client should see it.
 *
 * `userId` null is a SPECTATOR: no `you` block, which is the only part of
 * this that was ever private. Everything else — round, goal, standings,
 * who is resting, the winner, the intermission clock — already goes to
 * every player in the room, so the overlay needs no separate shape and
 * there is no second view to keep in step with this one.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dice] include each player's dice, for the overlay
 */
export function viewFor(room, userId, now, opts = {}) {
  const me = room.players[userId];
  /* Co-op always shows dice, to every player, not only the overlay. Versus
     is a race between opponents, where a hidden hand is part of the tension
     of "did they beat my total" — co-op has no opponent, only a team
     deciding together whether to chase a Blue trio for another round or
     bank now, and that decision needs to see what colour everyone else is
     actually holding, not just their point total. */
  const dice = !!opts.dice || room.mode === 'coop';
  const standings = Object.entries(room.players)
    .map(([id, p]) => publicPlayer(id, p, { ...opts, dice }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const view = {
    code: room.code,
    status: room.status,
    goal: room.goal,
    idleMs: room.idleMs,
    practice: !!room.practice,
    mode: room.mode || 'versus',
    coop: room.mode === 'coop' && room.coop ? {
      wave: room.coop.wave,
      cleared: room.coop.cleared,
      enemyName: room.coop.enemyName,
      enemySlug: room.coop.enemySlug || null,
      enemyFrames: room.coop.enemyFrames || 1,
      bg: room.coop.bg || null,
      enemyHp: Math.max(0, Math.round(room.coop.enemyHp)),
      enemyMaxHp: Math.round(room.coop.enemyMaxHp),
      roundsLeft: room.coop.roundsLeft,
      isBoss: !!room.coop.isBoss,
      isFinal: !!room.coop.isFinal,
      lastDamage: room.coop.lastDamage || 0,
      lastDealt: room.coop.lastDealt || 0,
      lastAttack: room.coop.lastAttack || 0,
      justCleared: !!room.coop.justCleared,
      victory: !!room.coop.victory,
      runOver: !!room.coop.runOver,
      /* Shared team HP — the second way to lose, alongside the round budget. */
      teamHp: Math.max(0, Math.round(room.coop.teamHp != null ? room.coop.teamHp : 0)),
      teamMaxHp: Math.round(room.coop.teamMaxHp || 0),
      /* Status effects, for the HUD. */
      poison: room.coop.poison || 0,
      burn: room.coop.burn || 0,
      shield: (room.coop.shieldRounds || 0) > 0,
      buff: room.coop.dmgBuffRounds || 0,
      enemyAttack: room.coop.enemyAttack || 0,
      minions: {
        hp: Math.max(0, Math.round((room.coop.minions && room.coop.minions.hp) || 0)),
        maxHp: Math.round((room.coop.minions && room.coop.minions.maxHp) || 0),
        count: (room.coop.minions && room.coop.minions.count) || 0,
      },
      /* Terse event tags from the last resolution (heal:2, poison:1, hit:14…). */
      log: Array.isArray(room.coop.log) ? room.coop.log.slice() : [],
      /* This enemy's weak colour (1-6); its banked effect lands doubled. */
      weakColor: room.coop.weakColor || 0,
      /* Telegraph: the hit the team should brace for next round. */
      nextAttack: coopNextAttack(room.coop),
      willEnrage: (room.coop.roundsLeft <= 2) || (room.coop.enemyMaxHp > 0 && room.coop.enemyHp / room.coop.enemyMaxHp < 0.25),
      /* Between-wave boon choice (a vote), and the run's accumulated boons. */
      awaitingBoon: !!room.coop.awaitingBoon,
      pendingBoons: room.coop.awaitingBoon && Array.isArray(room.coop.pendingBoons) ? room.coop.pendingBoons.slice() : null,
      /* Live vote tallies per offered boon, this viewer's vote, and progress. */
      boonVotes: room.coop.awaitingBoon ? coopVoteTally(room.coop) : null,
      myVote: room.coop.awaitingBoon && room.coop.boonVotes ? (room.coop.boonVotes[userId] || null) : null,
      votesCast: room.coop.awaitingBoon && room.coop.boonVotes ? Object.keys(room.coop.boonVotes).filter(id => room.players[id]).length : 0,
      /* Milliseconds left before an incomplete vote force-resolves — see
         COOP_BOON_VOTE_MS / coopResolveBoonVote. Same "ms left" shape as
         intermissionMsLeft, for the same reason: it survives a clock
         disagreement between server and client. */
      boonVoteMsLeft: room.coop.awaitingBoon && typeof room.coop.boonVoteDeadline === 'number'
        ? Math.max(0, room.coop.boonVoteDeadline - now) : 0,
      boons: (room.coop.boons && room.coop.boons.taken ? room.coop.boons.taken : []).slice(),
      secondWind: (room.coop.boons && room.coop.boons.secondWind) || 0,
    } : null,
    ranked: isRanked(room),
    round: room.round,
    isFinalRound: !!room.isFinalRound,
    nextIsFinal: !!room.nextIsFinal,
    tiedPlayers: room.tiedPlayers || null,
    /* Sent to EVERYONE, not only the player it applies to. The chasers
       should be able to see which player they are chasing; a strip that
       labels the leader "sitting out" describes the mechanic and hides the
       fact. */
    resting: (room.restingIds || []).slice(),
    host: room.host,
    hostName: room.hostName,
    hasPassword: !!room.password,
    maxPlayers: MAX_PLAYERS,
    playerCount: Object.keys(room.players).length,
    players: standings,
    winner: room.winner || null,
    intermissionMsLeft: room.intermissionEndsAt ? Math.max(0, room.intermissionEndsAt - now) : 0,
    serverNow: now,
  };

  /* `you` is present whenever the player is in the room, turn or no turn.
     Gating it on me.turn meant the lobby — where turn is null until the game
     starts — sent no `you` at all, so the page could not tell the host from
     anyone else and never showed the Start button. Being in the room is the
     fact the page needs; having a turn is not. */
  if (me) {
    /* Inside this gate on purpose: the same condition that decides whether
       `you` is safe to send decides whether chat is. The overlay passes a
       null viewer and therefore never reaches here. */
    view.chat = (room.chat || []).slice(-CHAT_KEEP);

    const t = me.turn;
    view.you = {
      id: userId,
      total: me.total,
      pending: t ? t.pending : 0,
      dice: t ? t.dice : [],
      /* Computed here so the page cannot disagree with the scorer about
         which dice are keepable. The client highlights what this says. */
      scorable: t && t.dice.length ? scorableMask(t.dice) : [],
      /* What the page pre-selects, so the player removes dice they don't
         want rather than assembling a keep from nothing. Sent from here
         because it must be a selection this server will accept — "every die
         that lights up" is not: a die lights up if it scores in some
         reading, and two dice can light up under readings that exclude each
         other. bestSelection() returns a real one, proven legal and optimal
         across every hand in test-scoring.js. */
      suggested: t && t.awaitingSelection && t.dice.length
        ? (bestSelection(t.dice) || { indices: [] }).indices
        : [],
      kept: t ? t.kept : [],
      remaining: t ? t.remaining : DICE_COUNT,
      awaitingSelection: !!(t && t.awaitingSelection),
      done: t ? t.done : null,
      /* `?? null` rather than a bare read: a room created before this field
         existed has turns without it, and JSON drops undefined entirely, so
         the page would see the key missing rather than empty. */
      gained: (t && t.gained !== undefined) ? t.gained : null,
      event: t ? t.event : null,
      msLeft: t && t.deadline ? Math.max(0, t.deadline - now) : 0,
      canRoll: !!(t && room.status === 'playing' && !t.done && !t.awaitingSelection),
      canBank: !!(t && room.status === 'playing' && !t.done && !t.awaitingSelection && t.pending > 0),
    };

    /* Sitting out is not the same as having nothing to do. The player who
       reached the goal has FINISHED — everyone else is rolling to beat
       them — and a screen that just greys out their dice reads as being
       locked out of their own win. They get told what is being chased and
       by whom. */
    if (me.turn && me.turn.done === 'out') {
      const resting = (room.restingIds || []).includes(userId);
      const chasers = playersInRound(room);
      view.you.spectating = {
        reason: resting ? 'goal' : 'tiebreak',
        target: me.total,
        chasers: chasers.length,
        /* Highest total among the people still rolling, so the screen can
           say how close the nearest one is. */
        closest: chasers.length
          ? Math.max(...chasers.map(id => room.players[id].total))
          : 0,
        done: chasers.filter(id => room.players[id].turn && room.players[id].turn.done).length,
      };
    }
  }

  return view;
}

/* ══ Shared write path ════════════════════════════════════════════════════ */

/**
 * Write the finished game to the boards exactly once.
 *
 * A game can end on any request that moves the clock — a bank, a burn, a
 * kick, or just somebody polling — so several callers can see `finished` at
 * the same moment. The right to record is claimed under the room's own lock;
 * everyone who loses the claim does nothing.
 */
async function settle(env, code, room) {
  if (!room || room.status !== 'finished' || room.resultsRecorded) return;

  let claimed = false;
  await env.MARKETPLACE.mutate('mc_room_' + code, (current) => {
    if (!current || current.status !== 'finished' || current.resultsRecorded) return undefined;
    current.resultsRecorded = true;
    claimed = true;
    return current;
  }, { expirationTtl: ROOM_TTL });

  if (claimed) await recordResult(env, room);
}

async function withRoom(env, code, fn) {
  let failed = null;
  const room = await env.MARKETPLACE.mutate('mc_room_' + code, (current) => {
    if (!current) { failed = json({ error: 'Room not found' }, 404); return undefined; }
    const now = Date.now();
    const moved = advance(current, now);
    const err = fn(current, now);
    if (err) {
      /* The action is refused, but the clock is not rolled back: an idle
         timer that expired stays expired. Writing the advance and refusing
         the action are not in conflict. */
      failed = err;
      return moved ? current : undefined;
    }
    return current;
  }, { expirationTtl: ROOM_TTL });

  await settle(env, code, room);
  return { failed, room };
}

/** The player's own turn, or a Response explaining why they cannot act. */
function activeTurn(room, userId) {
  if (room.status === 'intermission') return json({ error: 'Between rounds — hold on.' }, 409);
  if (room.status !== 'playing') return json({ error: 'Game not in progress' }, 400);
  const p = room.players[userId];
  if (!p) return json({ error: 'Not in this room' }, 403);
  if (!p.turn || p.turn.done === 'out') return json({ error: 'You are sitting this round out.' }, 400);
  if (p.turn.done) return json({ error: 'Your round is over.' }, 400);
  return null;
}

/* ══ GET ══════════════════════════════════════════════════════════════════ */

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'list-rooms') {
    const rows = await env.MARKETPLACE.listValues({ prefix: 'mc_room_' });
    const rooms = [];
    for (const { value: room } of rows) {
      if (!room || room.practice) continue;
      /* Games in progress are listed now that they can be joined. Finished
         ones never were and still are not -- there is nothing to join. */
      if (room.status !== 'lobby' && room.status !== 'playing') continue;
      /* A last round cannot take anyone, so listing it as joinable would
         only produce a refusal on click. */
      const closed = room.status === 'playing' &&
                     !!(room.isFinalRound || room.nextIsFinal || room.tiedPlayers);
      rooms.push({
        code: room.code,
        host: room.hostName,
        playerCount: Object.keys(room.players).length,
        maxPlayers: MAX_PLAYERS,
        hasPassword: !!room.password,
        goal: room.goal,
        mode: room.mode || 'versus',
        wave: room.mode === 'coop' && room.coop ? room.coop.wave : null,
        status: room.status,
        round: room.round || 0,
        /* The highest score on the table, so the list can say what someone
           starting from zero would be walking into. */
        topScore: Object.values(room.players).reduce((m, p) => Math.max(m, p.total || 0), 0),
        closed,
      });
    }
    return json(rooms);
  }

  if (action === 'get-state') {
    const code = (url.searchParams.get('code') || '').toUpperCase().trim();
    if (!code) return json({ error: 'Missing room code' }, 400);
    const player = getPlayer(request);
    if (!player) return json({ error: 'Log in with Twitch to play Mana Clash.' }, 401);

    /* Writes only when the clock actually moved something. This route is
       polled every couple of seconds by every player in the room; writing
       unconditionally would be a hundred writes a second to one row, all but
       one of them storing what was already there. */
    let finished = false;
    const room = await env.MARKETPLACE.mutate('mc_room_' + code, (current) => {
      if (!current) return undefined;
      const wasFinished = current.status === 'finished';
      const changed = advance(current, Date.now());
      finished = !wasFinished && current.status === 'finished';
      return changed ? current : undefined;
    }, { expirationTtl: ROOM_TTL });

    if (!room) return json({ error: 'Room not found' }, 404);
    if (finished) await settle(env, code, room);
    return json(viewFor(room, player.userId, Date.now()));
  }

  return json({ error: 'Invalid action' }, 400);
}

/* ══ POST ═════════════════════════════════════════════════════════════════ */

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const player = getPlayer(request);
  if (!player) return json({ error: 'Log in with Twitch to play Mana Clash.' }, 401);
  const { userId, displayName, profileImage } = player;

  const code = (body.code || '').toUpperCase().trim();

  /* ── create-room ──────────────────────────────────────────────────── */
  if (body.action === 'create-room') {
    const coop = body.mode === 'coop';
    /* Co-op has no point goal — the enemies are the target — so goal is only
       required and validated for a versus game. */
    const goal = coop ? 0 : Number(body.goal);
    if (!coop && !GOALS.includes(goal)) return json({ error: `Goal must be one of: ${GOALS.join(', ')}` }, 400);
    const idleMs = Number(body.idleMs);
    if (!IDLE_CHOICES.includes(idleMs)) return json({ error: 'Pick a 10, 30 or 60 second timer.' }, 400);
    const practice = !coop && !!body.practice;   // co-op is its own multiplayer mode

    let made = null;
    for (let i = 0; i < 10; i++) {
      const candidate = generateCode();
      const fresh = {
        code: candidate,
        host: userId, hostName: displayName,
        password: practice ? null : (body.password || null),
        practice,
        mode: coop ? 'coop' : 'versus',
        goal, idleMs,
        status: 'lobby',
        round: 0, roundStartedAt: null,
        isFinalRound: false, nextIsFinal: false, tiedPlayers: null,
        intermissionEndsAt: null,
        winner: null,
        players: {
          [userId]: { displayName, profileImage, ready: true, total: 0, turn: null },
        },
        createdAt: Date.now(),
      };
      /* The claim on the code is the write itself — a get-then-put let two
         simultaneous creates pick the same code, and the second replaced the
         first room out from under its host.

         Whether the claim succeeded is reported by the mutator rather than
         inferred from what mutate() hands back. Comparing the return value
         by identity would quietly depend on mutate() returning the very
         object it was given, which is an implementation detail and not
         something a caller should be able to break by changing. */
      let claimed = false;
      await env.MARKETPLACE.mutate('mc_room_' + candidate, (current) => {
        if (current) return undefined;
        claimed = true;
        return fresh;
      }, { expirationTtl: ROOM_TTL });
      if (claimed) { made = candidate; break; }
    }
    if (!made) return json({ error: 'Could not generate a room code' }, 500);
    return json({ success: true, code: made, practice, mode: coop ? 'coop' : 'versus' });
  }

  if (!code) return json({ error: 'Missing room code' }, 400);

  /* ── join-room ────────────────────────────────────────────────────── */
  if (body.action === 'join-room') {
    const { failed } = await withRoom(env, code, (room) => {
      if (room.players[userId]) return null;   // rejoining is not an error
      if (room.practice) return json({ error: 'That is a solo practice room.' }, 403);
      if (room.status === 'finished') return json({ error: 'That game is over.' }, 400);
      if (Object.keys(room.players).length >= MAX_PLAYERS) return json({ error: 'Room is full' }, 400);
      if (room.password && body.password !== room.password) return json({ error: 'Wrong password' }, 403);
      if (Array.isArray(room.kicked) && room.kicked.includes(userId)) {
        return json({ error: 'The host removed you from this room.' }, 403);
      }

      /* ── Joining a game already running ──────────────────────────────
         From zero, and counting for the leaderboard like any other game:
         arriving late is a disadvantage a player chooses, not something the
         room compensates for.

         NOT DURING A FINAL ROUND OR A TIEBREAK, and that is mechanical
         rather than a matter of fairness. playersInRound restricts the
         round to tiedPlayers when a tiebreak is running, and a final round
         belongs to the people chasing the leader -- someone arriving into
         either is not in the list the round is built from, so they would
         sit through it unable to act and with no way to be told why. */
      const running = room.status === 'playing';
      if (running && (room.isFinalRound || room.nextIsFinal || room.tiedPlayers)) {
        return json({ error: 'This game is on its last round — wait for the next one.' }, 409);
      }

      room.players[userId] = {
        displayName, profileImage, ready: false, total: 0,
        /* PARKED FOR THE ROUND IN PROGRESS. roundIsOver waits for every
           player in the round to have a finished turn, so a null turn here
           would stall the round for everyone, permanently. sittingOut()
           reads as already done; startRound deals them in next round along
           with everyone else. */
        turn: running ? sittingOut() : null,
      };
      if (running) room.joinedLate = (room.joinedLate || 0) + 1;
      return null;
    });
    if (failed) return failed;
    return json({ success: true, code });
  }

  /* ── ready ────────────────────────────────────────────────────────── */
  if (body.action === 'ready') {
    const { failed, room } = await withRoom(env, code, (r) => {
      if (r.status !== 'lobby') return json({ error: 'The game has already started.' }, 400);
      const p = r.players[userId];
      if (!p) return json({ error: 'Not in this room' }, 403);
      p.ready = body.ready === undefined ? true : !!body.ready;
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── kick ─────────────────────────────────────────────────────────── */
  if (body.action === 'kick') {
    const target = String(body.userId || '');
    const { failed, room } = await withRoom(env, code, (r) => {
      if (r.host !== userId) return json({ error: 'Only the host can remove players.' }, 403);
      if (target === userId) return json({ error: 'You cannot remove yourself — leave instead.' }, 400);
      if (!r.players[target]) return json({ error: 'That player is not here.' }, 404);
      delete r.players[target];
      /* Remembered, or they rejoin from the lobby list a second later and
         the host is back where they started. */
      r.kicked = Array.isArray(r.kicked) ? r.kicked : [];
      if (!r.kicked.includes(target)) r.kicked.push(target);
      if (r.tiedPlayers) r.tiedPlayers = r.tiedPlayers.filter(id => id !== target);
      /* Removing the player the round was waiting on ends it here. */
      if (r.status === 'playing' && roundIsOver(r)) endRound(r, Date.now());
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── rematch ──────────────────────────────────────────────────────── */
  if (body.action === 'rematch') {
    const { failed, room } = await withRoom(env, code, (r) => {
      if (r.host !== userId) return json({ error: 'Only the host can start a rematch.' }, 403);
      if (r.status !== 'finished') return json({ error: 'That game is still going.' }, 400);

      /* SAME ROOM, SAME CODE, SAME PEOPLE. A set of games otherwise costs
         everyone a trip back to the lobby, a new code to read out, and a
         re-join each -- which is where a table loses players between games.

         Settings are what the room IS and carry over untouched: goal, idle
         timer, password, host, and the kicked list, or someone removed
         during game one walks back in for game two. */
      r.status = 'lobby';
      r.round = 0;
      r.winner = null;
      r.finishedAt = null;
      r.intermissionEndsAt = null;
      r.isFinalRound = false;
      r.nextIsFinal = false;
      r.tiedPlayers = null;
      r.restingIds = [];
      r.joinedLate = 0;
      r.runOver = false;
      if (r.mode === 'coop') r.coop = null;   // re-initialised fresh on start-game

      /* THE ONE THAT WOULD HAVE GONE UNNOTICED. settle() claims a finished
         room once by setting resultsRecorded, and refuses to record again
         while it is set. Leaving it true here would not break anything
         visible -- the rematch would play perfectly -- it would just
         silently stop reaching the leaderboards, for this room, forever. */
      r.resultsRecorded = false;

      for (const p of Object.values(r.players)) {
        p.total = 0;
        p.turn = null;
        /* Ready is deliberately reset: a rematch is an offer, and someone
           who has had enough should not be counted in by a flag they set
           for the previous game. */
        p.ready = false;
      }
      /* Chat is kept. It is the same room and the same people, and a set of
         games reads as one sitting. */
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── chat ─────────────────────────────────────────────────────────── */
  if (body.action === 'chat') {
    const cleaned = cleanChat(body.text);
    if (cleaned.error) return json({ error: cleaned.error }, 400);

    let rejected = null;
    const { failed, room } = await withRoom(env, code, (r) => {
      const p = r.players[userId];
      /* BEING IN THE ROOM IS THE WHOLE PERMISSION. Anyone holding a code
         can poll get-state, so membership has to be checked against the
         room rather than inferred from knowing where to post. */
      if (!p) return json({ error: 'Join the room first.' }, 403);

      const now = Date.now();
      const gate = chatAllowed(p, now);
      if (gate.error) { rejected = gate.error; return null; }

      p.chatAt = gate.recent.concat(now);
      r.chat = Array.isArray(r.chat) ? r.chat : [];
      r.chat.push({
        id: 'm' + now.toString(36) + Math.random().toString(36).slice(2, 6),
        at: now,
        by: userId,
        name: p.displayName,
        text: cleaned.text,
      });
      /* Trimmed here rather than on read: the document is what grows, and
         a room that ran for an hour would otherwise carry every line of it
         through every turn's write. */
      if (r.chat.length > CHAT_KEEP) r.chat = r.chat.slice(-CHAT_KEEP);
      return null;
    });
    if (failed) return failed;
    /* Refused for pace, not for content -- 429 so the page can tell the
       difference between "too fast" and "not allowed". */
    if (rejected) return json({ error: rejected }, 429);
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── leave-room ───────────────────────────────────────────────────── */
  if (body.action === 'leave-room') {
    let emptied = false;
    const { failed } = await withRoom(env, code, (r) => {
      if (!r.players[userId]) return null;
      delete r.players[userId];
      if (Object.keys(r.players).length === 0) { emptied = true; return null; }
      if (r.host === userId) {
        const next = Object.keys(r.players)[0];
        r.host = next;
        r.hostName = r.players[next].displayName;
      }
      if (r.tiedPlayers) r.tiedPlayers = r.tiedPlayers.filter(id => id !== userId);
      if (r.status === 'playing' && roundIsOver(r)) endRound(r, Date.now());
      return null;
    });
    if (failed) return failed;
    /* Deleted outside the lock. A join landing in the gap costs that player
       a rejoin; an empty room is the one state where losing a write is free. */
    if (emptied) await env.MARKETPLACE.delete('mc_room_' + code);
    return json({ success: true });
  }

  /* ── start-game ───────────────────────────────────────────────────── */
  if (body.action === 'start-game') {
    const { failed, room } = await withRoom(env, code, (r, now) => {
      if (r.host !== userId) return json({ error: 'Only the host can start.' }, 403);
      if (r.status !== 'lobby') return json({ error: 'Already started' }, 400);
      const ids = Object.keys(r.players);
      /* Co-op can be run solo (a one-person gauntlet); versus still needs an
         opponent. */
      if (!r.practice && r.mode !== 'coop' && ids.length < 2) return json({ error: 'Wait for someone to join.' }, 400);
      if (ids.some(id => !r.players[id].ready)) return json({ error: 'Not everyone is ready.' }, 400);
      r.round = 0;
      r.tiedPlayers = null;
      r.nextIsFinal = false;
      for (const p of Object.values(r.players)) p.total = 0;
      if (r.mode === 'coop') coopInit(r);
      startRound(r, now);
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── choose-boon (co-op, between waves) — a VOTE ──────────────────────
     Each player votes for one of the three offered boons; the tally resolves
     once everyone in the room has voted. Solo, that's a single vote. A player
     may change their vote until it resolves. Ties break by offer order. */
  if (body.action === 'choose-boon') {
    const { failed, room } = await withRoom(env, code, (r, now) => {
      if (r.mode !== 'coop' || !r.coop || !r.coop.awaitingBoon) return json({ error: 'No boon to choose.' }, 400);
      if (!r.players[userId]) return json({ error: 'Join the room first.' }, 403);
      const offered = (r.coop.pendingBoons || []).map(x => x.id);
      if (!offered.includes(body.boon)) return json({ error: 'That boon is not on offer.' }, 400);

      r.coop.boonVotes = r.coop.boonVotes || {};
      r.coop.boonVotes[userId] = body.boon;

      /* Resolve only when every current player has cast a vote; otherwise
         the vote's own deadline (see advance()) is what moves this along. */
      const ids = Object.keys(r.players);
      if (!ids.every(id => r.coop.boonVotes[id])) return null;   // still waiting on votes
      coopResolveBoonVote(r, now);
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── roll ─────────────────────────────────────────────────────────── */
  if (body.action === 'roll') {
    const { failed, room } = await withRoom(env, code, (r, now) => {
      const blocked = activeTurn(r, userId);
      if (blocked) return blocked;
      const t = r.players[userId].turn;
      if (t.awaitingSelection) return json({ error: 'Keep at least one die first.' }, 400);

      t.dice = rollDice(t.remaining);
      t.event = null;

      if (!hasAnyScore(t.dice)) {
        /* MANA BURN. Everything pending is lost — that is the whole risk of
           rolling again, and softening it would remove the decision. */
        t.pending = 0;
        t.kept = [];
        t.gained = 0;
        t.done = 'burned';
        t.event = 'burn';
        t.awaitingSelection = false;
        t.deadline = null;
        if (roundIsOver(r)) endRound(r, now);
        return null;
      }

      if (isHotDice(t.dice)) {
        /* MANA CLASH. Every die scores, so there is nothing to choose and
           nothing to be gained by making them click it. */
        t.pending += scoreSelection(t.dice).points;
        t.kept = t.kept.concat(t.dice);
        t.dice = [];
        t.remaining = DICE_COUNT;
        t.awaitingSelection = false;
        t.event = 'clash';
        touch(r, t, now);
        return null;
      }

      t.awaitingSelection = true;
      touch(r, t, now);
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── keep ─────────────────────────────────────────────────────────── */
  if (body.action === 'keep') {
    const picks = Array.isArray(body.indices) ? body.indices : null;
    const { failed, room } = await withRoom(env, code, (r, now) => {
      const blocked = activeTurn(r, userId);
      if (blocked) return blocked;
      const t = r.players[userId].turn;
      if (!t.awaitingSelection) return json({ error: 'Roll first.' }, 400);
      if (!picks || picks.length === 0) return json({ error: 'Keep at least one die.' }, 400);

      const seen = new Set();
      for (const i of picks) {
        if (!Number.isInteger(i) || i < 0 || i >= t.dice.length) return json({ error: 'That die is not on the table.' }, 400);
        if (seen.has(i)) return json({ error: 'Same die picked twice.' }, 400);
        seen.add(i);
      }

      const chosen = picks.map(i => t.dice[i]);
      const result = scoreSelection(chosen);
      if (!result.valid) return json({ error: result.reason }, 400);

      t.pending += result.points;
      t.kept = t.kept.concat(chosen);
      t.dice = t.dice.filter((_, i) => !seen.has(i));
      t.remaining = t.dice.length;
      t.awaitingSelection = false;
      t.event = null;

      /* Unreachable in practice — a hand where every die scores is taken on
         the roll — but a player left with zero dice and no pickup would be
         stuck forever, so it is not a state worth trusting to an argument. */
      if (t.remaining === 0) {
        t.dice = [];
        t.remaining = DICE_COUNT;
        t.event = 'clash';
      }

      touch(r, t, now);
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  /* ── bank ─────────────────────────────────────────────────────────── */
  if (body.action === 'bank') {
    const { failed, room } = await withRoom(env, code, (r, now) => {
      const blocked = activeTurn(r, userId);
      if (blocked) return blocked;
      const t = r.players[userId].turn;
      if (t.awaitingSelection) return json({ error: 'Keep your scoring dice first.' }, 400);
      if (t.pending <= 0) return json({ error: 'Nothing to bank yet.' }, 400);

      r.players[userId].total += t.pending;
      t.gained = t.pending;
      t.done = 'banked';
      t.deadline = null;
      t.dice = [];
      if (roundIsOver(r)) endRound(r, now);
      return null;
    });
    if (failed) return failed;
    return json({ success: true, room: viewFor(room, userId, Date.now()) });
  }

  return json({ error: 'Invalid action' }, 400);
}
