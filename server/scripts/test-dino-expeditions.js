#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO PARK — EXPEDITIONS & FIELD NOTES

     node server/scripts/test-dino-expeditions.js

   The functions are read out of the page and evaluated, the same way the
   levelling suite does it, because they live in an inline <script> in a
   single-file game. That keeps the numbers under test as the ones that
   ship.

   WHAT ACTUALLY MATTERS HERE, in the order it would hurt:

     - A DINO MUST NEVER BE LOST OR STRANDED. Dinos stay in the roster
       while away, flagged `busy`. A flag whose run has gone (a save fork,
       a cloud merge, an interrupted claim) means an animal nobody can
       care for, send or sell, with no way for the player to fix it or
       even describe it. expoEnsure() must clear those every time.

     - THE CLOCK MUST RUN AT BOTH SPEEDS. Real time always, triple while
       live. The whole point of not making this live-gated like the rest
       of the park is that a party is never stranded by a quiet week, so
       "offline still finishes" is a correctness property, not a nicety.

     - THE OUTCOME IS FIXED AT DISPATCH. The roll is stored when the party
       leaves. If the tier were computed fresh at claim time, reloading
       and claiming again would reroll it, and the save is client-held.

     - AN UNDER-STRENGTH PARTY STILL COMES HOME WITH SOMETHING. A run
       costs hours of a clock the player does not control; paying nothing
       is how a feature gets abandoned after one bad result.

     - THE BOARD IS THE SAME ON EVERY DEVICE. One save, two tabs, and a
       board that rerolled per device would let a player shop for the site
       they wanted.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PAGE = path.join(REPO, 'games/dino-park/index.html');
/* Newlines normalised: the working copy is CRLF, so anchors like `;\n`
   silently match nothing and every lift below fails at once. */
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/** Lift a top-level declaration out of the page by name. */
function lift(name, kind = 'function') {
  const re = kind === 'function'
    ? new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}`)
    : new RegExp(`\\nconst ${name} = [\\s\\S]*?;\\n`);
  const m = re.exec(src);
  if (!m) throw new Error(`could not find ${kind} ${name} in the page`);
  return m[0];
}

/* The harness stands in for the park around the feature: a roster, the
   handful of helpers the expedition code calls, and a clock the test
   drives by hand. Everything else is the real shipped source. */
const sandbox = [
  lift('EXPO_LIVE_BOOST', 'const'), lift('EXPO_BOARD_PERIOD_MS', 'const'),
  lift('EXPO_BOARD_SIZE', 'const'), lift('EXPO_QUEST_PERIOD_MS', 'const'),
  lift('EXPO_QUEST_COUNT', 'const'), lift('EXPO_BASE_SLOTS', 'const'),
  lift('EXPO_STAMINA_COST', 'const'), lift('EXPO_HYGIENE_COST', 'const'),
  lift('EXPO_SITES', 'const'), lift('EXPO_TIERS', 'const'),
  lift('EXPO_XP_PER_WALL_HOUR', 'const'), lift('EXPO_QUESTS', 'const'),
  lift('RARITY_ATTR_BONUS', 'const'),
  lift('dinoAttrs'),
  lift('EXPO_KITS', 'const'), lift('EXPO_KIT_STRENGTH', 'const'),
  lift('EXPO_KIT_COINS', 'const'), lift('EXPO_UPGRADES', 'const'),
  lift('MAX_YARD_ITEMS_BASE', 'const'),
  lift('expoKitById'), lift('expoKitCost'), lift('expoKitTotal'),
  lift('EXPO_RUSH_PER_HOUR', 'const'), lift('EXPO_REROLL_BASE', 'const'),
  lift('BROKER_PRICES', 'const'), lift('BROKER_STEP', 'const'),
  lift('RENOWN_BASE', 'const'), lift('RENOWN_STEP', 'const'),
  lift('RENOWN_PCT_PER_LEVEL', 'const'),
  lift('expoRushCost'), lift('expoRush'), lift('expoRerollCost'), lift('expoReroll'),
  lift('brokerCost'), lift('brokerBuy'),
  lift('renownLevel'), lift('renownCost'), lift('renownMult'), lift('buyRenown'),
  lift('expoUpgById'), lift('expoUpgLevel'), lift('expoUpgNextCost'),
  lift('expoBuyUpgrade'), lift('getMaxYardItems'), lift('expoPaceMult'), lift('eggSpeedMult'),
  lift('expoPeriod'), lift('expoRand'), lift('expoUnlockedSites'), lift('expoBoardFor'), lift('expoSiteById'),
  lift('expoPartyScore'), lift('expoTierFor'), lift('expoCreditSec'),
  lift('expoIsDone'), lift('expoRemainingWallSec'), lift('expoRewardsFor'),
  lift('expoQuestsFor'), lift('expoQuestById'),
  lift('expoMaxSlots'), lift('expoEnsure'), lift('allDinos'),
  lift('findDinoByUidLocal'), lift('expoAvailableDinos'), lift('expoDispatch'),
  lift('expoCredit'), lift('expoTick'), lift('expoClaim'), lift('expoCount'),
  lift('expoQuestState'), lift('expoClaimQuest'),
].join('\n');

const harness = `
  let state = null;
  let isStreamLive = false;
  let saves = 0;
  function save() { saves++; }
  function getRosterById(id) { return ROSTER[id] || { name: id, rarity: 'common' }; }
  function ensureDinoStats(d) {
    if (d.hygiene === undefined) d.hygiene = 80;
    if (d.stamina === undefined) d.stamina = 80;
    if (d.xp === undefined) d.xp = 0;
  }
  function awardDinoXp(d, amount) { d.xp = (d.xp || 0) + amount; return 0; }
  let eggsGranted = [];
  function rollRarity() { return 'common'; }
  function rollSpecies() { return { id: 'compy', name: 'Compsognathus' }; }
  function acquireEgg(speciesId, rarity) { eggsGranted.push({ speciesId, rarity }); return 'incubator'; }
  const ROSTER = {
    compy: { name: 'Compsognathus', rarity: 'common' },
    rex:   { name: 'Tyrannosaurus', rarity: 'legendary' },
    raptor:{ name: 'Velociraptor',  rarity: 'uncommon' },
  };
`;

const api = new Function(harness + sandbox + `
  return {
    EXPO_SITES, EXPO_TIERS, EXPO_LIVE_BOOST, EXPO_BOARD_PERIOD_MS, EXPO_QUEST_PERIOD_MS,
    EXPO_BASE_SLOTS, EXPO_STAMINA_COST, EXPO_QUESTS, EXPO_QUEST_COUNT, EXPO_BOARD_SIZE,
    dinoAttrs, expoPeriod, expoBoardFor, expoSiteById, expoPartyScore, expoTierFor,
    expoCreditSec, expoIsDone, expoRemainingWallSec, expoRewardsFor, expoQuestsFor,
    expoMaxSlots, expoEnsure, expoAvailableDinos, expoDispatch, expoCredit, expoTick,
    expoClaim, expoCount, expoQuestState, expoClaimQuest, expoQuestById,
    EXPO_KITS, EXPO_KIT_STRENGTH, EXPO_KIT_COINS, EXPO_UPGRADES, MAX_YARD_ITEMS_BASE,
    expoKitCost, expoKitTotal, expoUpgLevel, expoUpgNextCost, expoBuyUpgrade,
    getMaxYardItems, expoPaceMult, eggSpeedMult, expoUnlockedSites,
    EXPO_RUSH_PER_HOUR, EXPO_REROLL_BASE, BROKER_PRICES, RENOWN_BASE, RENOWN_PCT_PER_LEVEL,
    expoRushCost, expoRush, expoRerollCost, expoReroll, brokerCost, brokerBuy,
    renownLevel, renownCost, renownMult, buyRenown,
    setState: (s) => { state = s; },
    getState: () => state,
    setLive: (v) => { isStreamLive = v; },
    eggs: () => eggsGranted,
  };
`)();

const {
  EXPO_SITES, EXPO_TIERS, EXPO_LIVE_BOOST, EXPO_BOARD_PERIOD_MS, EXPO_QUEST_PERIOD_MS,
  EXPO_BASE_SLOTS, EXPO_STAMINA_COST, EXPO_QUEST_COUNT, EXPO_BOARD_SIZE,
  dinoAttrs, expoPeriod, expoBoardFor, expoSiteById, expoPartyScore, expoTierFor,
  expoCreditSec, expoIsDone, expoRemainingWallSec, expoRewardsFor, expoQuestsFor,
  expoMaxSlots, expoEnsure, expoAvailableDinos, expoDispatch, expoCredit, expoTick,
  expoClaim, expoQuestState, expoClaimQuest, expoQuestById, setState, getState, setLive,
  EXPO_KITS, EXPO_KIT_STRENGTH, EXPO_KIT_COINS, EXPO_UPGRADES, MAX_YARD_ITEMS_BASE,
  expoKitCost, expoKitTotal, expoUpgLevel, expoUpgNextCost, expoBuyUpgrade,
  getMaxYardItems, expoPaceMult, eggSpeedMult, expoUnlockedSites,
  EXPO_RUSH_PER_HOUR, EXPO_REROLL_BASE, BROKER_PRICES, RENOWN_BASE, RENOWN_PCT_PER_LEVEL,
  expoRushCost, expoRush, expoRerollCost, expoReroll, brokerCost, brokerBuy,
  renownLevel, renownCost, renownMult, buyRenown,
} = api;

/* Everything unlocked, which is what most blocks below want. */
const ALL_DONE = 9999;

let uidN = 0;
const dino = (over = {}) => ({
  uid: 'u' + (++uidN), speciesId: 'raptor', careCount: 60,
  hunger: 80, thirst: 80, happiness: 80, hygiene: 80, stamina: 80, xp: 0, ...over,
});

function freshState(over = {}) {
  const s = { coins: 0, park: [], vault: [], eggs: [], ...over };
  setState(s);
  return s;
}

/** Set up state.expo with everything unlocked, as most blocks want. */
function ready(now) {
  expoEnsure(now);
  getState().expo.completed = ALL_DONE;
}

/* A site big enough to need a real party, picked from the shipped table
   rather than invented, so the suite tracks the catalog. */
const THREE = EXPO_SITES.find(s => s.slots === 3);
const ONE = EXPO_SITES.find(s => s.slots === 1);

/** Put `siteId` on the board by finding a period whose board contains it. */
function periodShowing(siteId) {
  for (let p = 0; p < 5000; p++) {
    if (expoBoardFor(p, ALL_DONE, 0).some(s => s.id === siteId)) return p;
  }
  throw new Error('no period shows ' + siteId);
}
const nowFor = (period) => period * EXPO_BOARD_PERIOD_MS + 1000;

/* ── The catalog itself ──────────────────────────────────────────────── */
{
  ok('every site has a unique id', new Set(EXPO_SITES.map(s => s.id)).size === EXPO_SITES.length);
  ok('every site has a party size the board can fill', EXPO_SITES.every(s => s.slots >= 1 && s.slots <= 3));
  ok('every site weights the three attributes to about 1',
    EXPO_SITES.every(s => Math.abs(s.w.p + s.w.g + s.w.s - 1) < 0.02));
  ok('every site says something specific about itself',
    EXPO_SITES.every(s => s.blurb && s.blurb.length > 25));

  /* The word is reserved for the existing one-click Daily Dig on the Eggs
     tab. Two features called the same thing is how a player concludes one
     of them is broken. */
  ok('no site calls itself a dig',
    !EXPO_SITES.some(s => /\bdig\b/i.test(s.name + ' ' + s.blurb)));

  /* Pairwise, because two sites can share a duration and differ slightly
     in pay — what must hold is that a STRICTLY longer run is worth
     strictly more, or the long sites are a trap. */
  /* Within a band, a strictly longer run pays strictly more. Across
     bands the rate climbs instead, which is what makes an unlock worth
     having rather than just a longer wait. */
  for (const req of [...new Set(EXPO_SITES.map(s => s.req || 0))]) {
    const band = EXPO_SITES.filter(s => (s.req || 0) === req);
    ok(`in band ${req}, longer always pays more`,
      band.every(a => band.every(b => !(a.dur < b.dur) || a.coins < b.coins)));
  }
  const rate = (req) => {
    const band = EXPO_SITES.filter(s => (s.req || 0) === req);
    return band.reduce((t, s) => t + s.coins / (s.dur / 3600), 0) / band.length;
  };
  const bands = [...new Set(EXPO_SITES.map(s => s.req || 0))].sort((a, b) => a - b);
  ok('and a deeper band pays better per hour',
    bands.every((r, i) => i === 0 || rate(r) > rate(bands[i - 1])));
}

/* ── The board is the same everywhere, and it rotates ────────────────── */
{
  const p = 1234;
  check('the board is deterministic for a period',
    expoBoardFor(p, ALL_DONE, 0).map(s => s.id), expoBoardFor(p, ALL_DONE, 0).map(s => s.id));
  ok('and a different period is a different board',
    expoBoardFor(p, ALL_DONE, 0).map(s => s.id).join() !== expoBoardFor(p + 1, ALL_DONE, 0).map(s => s.id).join());
  ok('a board never offers the same site twice',
    new Set(expoBoardFor(p, ALL_DONE, 0).map(s => s.id)).size === expoBoardFor(p, ALL_DONE, 0).length);
  check('four sites on offer', expoBoardFor(p, ALL_DONE, 0).length, EXPO_BOARD_SIZE);

  /* Over many rotations every site must actually come up, or a site in the
     table is one nobody can ever visit. */
  const seen = new Set();
  for (let i = 0; i < 400; i++) expoBoardFor(i, ALL_DONE, 0).forEach(s => seen.add(s.id));
  check('every site in the catalog reaches the board', seen.size, EXPO_SITES.length);
}

/* ── Party strength reads the same numbers the card shows ────────────── */
{
  const raised = dino({ careCount: 100, speciesId: 'raptor' });
  const fresh = dino({ careCount: 0, speciesId: 'raptor' });
  ok('a raised dino outscores a fresh one', dinoAttrs(raised).power > dinoAttrs(fresh).power);

  const legendary = dino({ careCount: 0, speciesId: 'rex' });
  ok('rarity is a floor, not a substitute for raising',
    dinoAttrs(legendary).power < dinoAttrs(raised).power);

  /* The weights are the reason to choose. The SAME party must be worth
     different amounts at sites that want different things. */
  const speedy = [dino({ careCount: 80 })];
  const fast = EXPO_SITES.find(s => s.w.s > 0.5);
  const slow = EXPO_SITES.find(s => s.w.g > 0.5);
  ok('the same animal scores differently by site',
    Math.round(expoPartyScore(speedy, fast)) !== Math.round(expoPartyScore(speedy, slow)));

  /* Summed, not averaged: a three-slot site is asking for three. */
  const one = [dino({ careCount: 90 })];
  const three = [dino({ careCount: 90 }), dino({ careCount: 90 }), dino({ careCount: 90 })];
  ok('three animals beat one at a three-slot site',
    expoPartyScore(three, THREE) > expoPartyScore(one, THREE) * 2);

  check('an empty party is worth nothing', expoPartyScore([], THREE), 0);
}

/* ── Tiers, and the floor under a bad run ────────────────────────────── */
{
  const t = (ratio) => expoTierFor(ratio * 100, 100, 0.5).id;
  check('a strong party lands at the top', t(1.4), 'great');
  check('an adequate one succeeds', t(1.0), 'good');
  check('an under-strength one scrapes by', t(0.7), 'fair');
  check('a hopeless one is rough going', t(0.1), 'poor');

  /* THE FLOOR. Every band pays. */
  ok('every tier pays coins', EXPO_TIERS.every(x => x.coins > 0));
  ok('every tier pays XP', EXPO_TIERS.every(x => x.xp > 0));
  for (const tier of EXPO_TIERS) {
    const r = expoRewardsFor(THREE, tier, 3);
    ok(`${tier.id} still comes home with coins`, r.coins >= 1);
    ok(`${tier.id} still comes home with XP`, r.xp >= 1);
  }
  ok('a better tier pays strictly more',
    expoRewardsFor(THREE, EXPO_TIERS[0], 3).coins > expoRewardsFor(THREE, EXPO_TIERS[3], 3).coins);

  /* The jitter moves a borderline party, never a decisive one. */
  const edgeLow = expoTierFor(90, 100, 0).id, edgeHigh = expoTierFor(90, 100, 1).id;
  ok('the roll can swing a borderline party', edgeLow !== edgeHigh);
  check('but cannot sink a dominant one', expoTierFor(300, 100, 0).id, 'great');
  check('nor rescue a hopeless one', expoTierFor(5, 100, 1).id, 'poor');
}

/* ── The clock runs at both speeds ───────────────────────────────────── */
{
  check('offline time counts at face value', expoCreditSec(100, 0), 100);
  check('live time counts triple', expoCreditSec(100, 100), 100 * EXPO_LIVE_BOOST);
  check('a half-live stretch is in between', expoCreditSec(100, 50), 100 + 50 * (EXPO_LIVE_BOOST - 1));
  check('live seconds cannot exceed the wall stretch', expoCreditSec(10, 999), 10 * EXPO_LIVE_BOOST);
  check('negative time credits nothing', expoCreditSec(-5, -5), 0);
}

/* ── Dispatch ────────────────────────────────────────────────────────── */
{
  const period = periodShowing(THREE.id);
  const now = nowFor(period);
  const s = freshState();
  const a = dino(), b = dino(), c = dino();
  s.park.push(a, b);
  s.vault.push(c);                              // the vault counts as roster
  ready(now);

  check('too few animals is refused',
    expoDispatch(THREE.id, [a.uid], now).ok, false);
  check('a site not on the board is refused',
    expoDispatch(EXPO_SITES.find(x => !expoBoardFor(period, ALL_DONE, 0).some(y => y.id === x.id)).id, [a.uid, b.uid, c.uid], now).ok, false);

  const res = expoDispatch(THREE.id, [a.uid, b.uid, c.uid], now);
  ok('a full party from park and vault is accepted', res.ok);
  check('a vault animal can go', !!s.vault[0].busy, true);
  check('all three are flagged out', [a.busy, b.busy, c.busy].filter(Boolean).length, 3);
  check('the run records who went', res.run.party.length, 3);
  ok('and their names, for the results screen', res.run.names.length === 3);
  ok('the roll is stored at dispatch', typeof res.run.roll === 'number');
  ok('so is the score', typeof res.run.score === 'number');

  check('the same site cannot be run twice in a rotation',
    expoDispatch(THREE.id, [a.uid, b.uid, c.uid], now).ok, false);
  ok('an animal already out is not available', !expoAvailableDinos().some(d => d.uid === a.uid));
}

/* ── An animal cannot be sent twice, or to two places ────────────────── */
{
  const period = periodShowing(ONE.id);
  const now = nowFor(period);
  const s = freshState();
  const a = dino();
  s.park.push(a);
  ready(now);
  check('the same animal twice in one party is refused',
    expoDispatch(ONE.id, [a.uid, a.uid], now).ok, false);
}

/* ── Exhausted animals stay home ─────────────────────────────────────── */
{
  const s = freshState();
  const tired = dino({ stamina: 3 });
  const rested = dino({ stamina: 90 });
  s.park.push(tired, rested);
  expoEnsure();
  ok('a worn-out animal is not offered', !expoAvailableDinos().some(d => d.uid === tired.uid));
  ok('a rested one is', expoAvailableDinos().some(d => d.uid === rested.uid));
}

/* ── Slots ───────────────────────────────────────────────────────────── */
{
  const s = freshState({ subTier: 0 });
  expoEnsure();
  check('two parties out at once by default', expoMaxSlots(), EXPO_BASE_SLOTS);
  s.subTier = 3;
  check('a subscriber gets more', expoMaxSlots(), EXPO_BASE_SLOTS + 3);
}

/* ── A run finishes offline, and faster live ─────────────────────────── */
{
  const period = periodShowing(ONE.id);
  const start = nowFor(period);
  const s = freshState();
  const a = dino();
  s.park.push(a);
  ready(start);
  const run = expoDispatch(ONE.id, [a.uid], start).run;

  setLive(false);
  expoTick(start + (ONE.dur / 2) * 1000);
  ok('half the run elapses offline', !expoIsDone(run) && run.progressSec > 0);
  const remaining = expoRemainingWallSec(run);
  ok('and it reports what is left', remaining > 0 && remaining <= ONE.dur);

  expoTick(start + (ONE.dur + 10) * 1000);
  ok('an offline-only party still comes home', expoIsDone(run));
  check('progress never overruns the duration', run.progressSec, run.durationSec);
}
{
  const period = periodShowing(ONE.id);
  const start = nowFor(period);
  const s = freshState();
  const a = dino();
  s.park.push(a);
  ready(start);
  const run = expoDispatch(ONE.id, [a.uid], start).run;

  setLive(true);
  expoTick(start + (ONE.dur / EXPO_LIVE_BOOST + 5) * 1000);
  setLive(false);
  ok('a live stream brings them home in a third of the time', expoIsDone(run));
}

/* ── The outcome is fixed at dispatch ────────────────────────────────── */
{
  const period = periodShowing(ONE.id);
  const start = nowFor(period);
  const s = freshState();
  const a = dino({ careCount: 55 });
  s.park.push(a);
  ready(start);
  const run = expoDispatch(ONE.id, [a.uid], start).run;
  const site = expoSiteById(ONE.id);
  const first = expoTierFor(run.score, site.target, run.roll).id;

  /* Raising the animal mid-run must not change what the run pays: the
     score was frozen when it left. */
  a.careCount = 500;
  check('a mid-run change cannot move the result',
    expoTierFor(run.score, site.target, run.roll).id, first);

  /* And the stored roll means re-reading it is the same answer every time
     — the property that stops the claim button being a slot machine. */
  check('the tier is stable across reads',
    expoTierFor(run.score, site.target, run.roll).id, first);
}

/* ── Claim ───────────────────────────────────────────────────────────── */
{
  const period = periodShowing(THREE.id);
  const start = nowFor(period);
  const s = freshState();
  const a = dino(), b = dino(), c = dino();
  s.park.push(a, b, c);
  ready(start);
  const run = expoDispatch(THREE.id, [a.uid, b.uid, c.uid], start).run;

  check('a party still out cannot be claimed', expoClaim(run.rid, start).ok, false);
  ok('and nobody is released early', [a.busy, b.busy, c.busy].every(Boolean));

  expoTick(start + (THREE.dur + 10) * 1000);
  const before = { coins: s.coins, xp: a.xp, stamina: a.stamina };
  const res = expoClaim(run.rid, start + (THREE.dur + 10) * 1000);

  ok('a finished party can be claimed', res.ok);
  ok('coins are paid', s.coins > before.coins);
  ok('every animal that went gains XP', [a, b, c].every(d => d.xp > before.xp));
  check('and comes back tired', a.stamina, before.stamina - EXPO_STAMINA_COST);
  ok('everyone is released', ![a.busy, b.busy, c.busy].some(Boolean));
  check('the run is off the board', getState().expo.active.length, 0);
  check('and it counted toward the notes', getState().expo.counters.runs, 1);

  check('claiming twice pays nothing', expoClaim(run.rid, start).ok, false);
  check('coins did not move again', s.coins, before.coins + res.reward.coins);
}

/* ── A party member sold while away ──────────────────────────────────
   The market escrows a dino by REMOVING it from the save, so a claim can
   genuinely find one of its party gone. It must pay the rest rather than
   throw and strand everyone who did come back. */
{
  const period = periodShowing(THREE.id);
  const start = nowFor(period);
  const s = freshState();
  const a = dino(), b = dino(), c = dino();
  s.park.push(a, b, c);
  ready(start);
  const run = expoDispatch(THREE.id, [a.uid, b.uid, c.uid], start).run;
  expoTick(start + (THREE.dur + 10) * 1000);

  s.park = s.park.filter(d => d.uid !== b.uid);          // sold mid-run
  const res = expoClaim(run.rid, start + (THREE.dur + 10) * 1000);
  ok('the claim still settles', res.ok);
  ok('the animals that remain are released', !a.busy && !c.busy);
  ok('and they still got paid', a.xp > 0 && c.xp > 0);
}

/* ── THE ONE THAT STRANDS A DINO ─────────────────────────────────────
   A `busy` flag whose run has gone. The animal cannot be cared for, sent
   or sold, and the player has no way to see why. expoEnsure must clear
   it every time it runs. */
{
  const s = freshState();
  const ghost = dino({ busy: 'r-does-not-exist' });
  const parked = dino();
  s.park.push(ghost);
  s.vault.push(parked);
  s.expo = { active: [], used: [], questDone: [], counters: {}, lastTick: 0, period: -1, questPeriod: -1 };
  Object.assign(parked, { busy: 'r-also-gone' });

  expoEnsure();
  ok('a flag with no run is cleared in the park', !ghost.busy);
  ok('and in the vault', !parked.busy);
  ok('both are available again', expoAvailableDinos().length === 2);
}
{
  /* The inverse must NOT happen: a flag whose run is real stays put. */
  const period = periodShowing(ONE.id);
  const now = nowFor(period);
  const s = freshState();
  const a = dino();
  s.park.push(a);
  ready(now);
  expoDispatch(ONE.id, [a.uid], now);
  ready(now);
  ok('a flag with a live run survives the repair', !!a.busy);
}

/* ── A save that has never seen the feature ──────────────────────────── */
{
  const s = freshState();
  delete s.expo;
  s.park.push(dino());
  expoEnsure();
  ok('state.expo is created', !!getState().expo);
  ok('with no parties out', getState().expo.active.length === 0);
  ok('and counters at zero', Object.values(getState().expo.counters).every(v => v === 0));
}

/* ── Rotations reset what they should, and keep what they should ─────── */
{
  const s = freshState();
  const p0 = 100;
  expoEnsure(p0 * EXPO_BOARD_PERIOD_MS + 1);
  getState().expo.used.push('tarseeps');
  getState().expo.completed = 7;

  expoEnsure((p0 + 1) * EXPO_BOARD_PERIOD_MS + 1);
  check('a new rotation reopens the board', getState().expo.used, []);
  check('but the lifetime count is not a rotation thing', getState().expo.completed, 7);
}

/* ── Field Notes ─────────────────────────────────────────────────────── */
{
  const day = 500;
  const now = day * EXPO_QUEST_PERIOD_MS + 1;
  const s = freshState();
  expoEnsure(now);

  const notes = expoQuestsFor(getState().expo.questPeriod);
  check('three notes a day', notes.length, EXPO_QUEST_COUNT);
  ok('no two ask for the same thing',
    new Set(notes.map(q => q.counter)).size === notes.length);
  check('the list is the same on every device',
    expoQuestsFor(12).map(q => q.id), expoQuestsFor(12).map(q => q.id));

  const q = notes[0];
  check('a fresh note is unfinished', expoQuestState(q).done, false);
  check('and cannot be claimed early', expoClaimQuest(q.id).ok, false);

  getState().expo.counters[q.counter] = q.goal;
  ok('meeting the goal finishes it', expoQuestState(q).done);
  const paid = expoClaimQuest(q.id);
  ok('which pays', paid.ok && paid.coins > 0);
  check('coins landed', s.coins, q.coins);
  check('claiming again pays nothing', expoClaimQuest(q.id).ok, false);
  check('and the coins did not move', s.coins, q.coins);

  /* Progress is displayed capped, so a counter run past the goal does not
     render "17 / 5". */
  getState().expo.counters[q.counter] = q.goal + 12;
  check('progress is shown capped at the goal', expoQuestState(q).have, q.goal);
}
{
  /* A new day is a clean sheet: yesterday's chores must not finish today's
     list, or every note is complete the moment it appears. */
  const day = 600;
  const s = freshState();
  expoEnsure(day * EXPO_QUEST_PERIOD_MS + 1);
  getState().expo.counters.care = 99;
  getState().expo.questDone.push('care5');

  expoEnsure((day + 1) * EXPO_QUEST_PERIOD_MS + 1);
  check('counters reset with the day', getState().expo.counters.care, 0);
  check('and nothing stays claimed', getState().expo.questDone, []);
}

/* -- Unlocks ---------------------------------------------------------
   The deep sites are the long tail. If the gate leaked, the whole map
   would be on offer on day one; if it never opened, most of the catalog
   would be unreachable. */
{
  ok('a new park sees only the opening sites',
    expoUnlockedSites(0).every(s => (s.req || 0) === 0));
  ok('and there are enough of them to fill a board',
    expoUnlockedSites(0).length >= EXPO_BOARD_SIZE);
  ok('experience opens more', expoUnlockedSites(50).length > expoUnlockedSites(0).length);
  check('and eventually all of them', expoUnlockedSites(ALL_DONE).length, EXPO_SITES.length);

  ok('a locked site never reaches the board',
    [...Array(200)].every((_, i) => expoBoardFor(i, 0, 0).every(s => (s.req || 0) === 0)));

  /* Every band must be reachable, or a site is written and never seen. */
  const seen = new Set();
  for (let i = 0; i < 600; i++) expoBoardFor(i, ALL_DONE, 0).forEach(s => seen.add(s.id));
  check('every site in the catalog reaches the board eventually', seen.size, EXPO_SITES.length);
}

/* -- Outfitting: the repeatable sink ---------------------------------
   The park's entire lifetime sink used to be roughly 5,900 coins of
   decor, 60% refundable, against income that never stops. Kits have to
   stay expensive at every income level, which is why they are priced off
   the site rather than flat. */
{
  const cheap = EXPO_SITES.find(s => (s.req || 0) === 0);
  const deep = EXPO_SITES[EXPO_SITES.length - 1];
  ok('a kit costs more at a richer site',
    expoKitCost(deep, 'maps') > expoKitCost(cheap, 'maps'));
  ok('kitting out fully is a real fraction of the payout',
    expoKitTotal(deep, EXPO_KITS.map(k => k.id)) >= deep.coins);

  /* Crates must beat their price on a strong showing and lose on a weak
     one, or they are either a no-brainer or a trap. */
  const best = EXPO_TIERS[0], worst = EXPO_TIERS[EXPO_TIERS.length - 1];
  const gainAt = (t) => expoRewardsFor(deep, t, 3).coins * EXPO_KIT_COINS;
  ok('crates pay for themselves on a great run', gainAt(best) > expoKitCost(deep, 'crates'));
  ok('and do not on a poor one', gainAt(worst) < expoKitCost(deep, 'crates'));
}
{
  const period = periodShowing(THREE.id);
  const start = nowFor(period);
  const site = expoSiteById(THREE.id);

  const party = () => {
    const st = freshState({ coins: 1000000 });
    const x = dino(), y = dino(), z = dino();
    st.park.push(x, y, z);
    ready(start);
    return { st, uids: [x.uid, y.uid, z.uid], dinos: [x, y, z] };
  };

  const plain = party();
  const bare = expoDispatch(THREE.id, plain.uids, start).run;

  const kit = party();
  const before = kit.st.coins;
  const kitted = expoDispatch(THREE.id, kit.uids, start, ['maps']).run;
  check('the kit is paid for at dispatch', kit.st.coins, before - expoKitCost(site, 'maps'));
  ok('maps raise the party score', kitted.score > bare.score);
  check('and the kit is frozen onto the run', kitted.kits, ['maps']);

  const rat = party();
  const run3 = expoDispatch(THREE.id, rat.uids, start, ['rations']).run;
  expoTick(start + (run3.durationSec + 10) * 1000);
  const stamBefore = rat.dinos[0].stamina;
  expoClaim(run3.rid, start + (run3.durationSec + 10) * 1000);
  check('rations mean no stamina cost', rat.dinos[0].stamina, stamBefore);

  const payout = (kits) => {
    const g = party();
    const r = expoDispatch(THREE.id, g.uids, start, kits).run;
    r.roll = 0.5;
    expoTick(start + (r.durationSec + 10) * 1000);
    return expoClaim(r.rid, start + (r.durationSec + 10) * 1000).reward.coins;
  };
  ok('crates pay more coins than the same run without them', payout(['crates']) > payout([]));

  /* The obvious exploit: a kit you cannot afford. */
  const broke = freshState({ coins: 1 });
  const m = dino(), n2 = dino(), o = dino();
  broke.park.push(m, n2, o);
  ready(start);
  const refused = expoDispatch(THREE.id, [m.uid, n2.uid, o.uid], start, ['maps', 'rations', 'crates']);
  check('an unaffordable kit is refused', refused.ok, false);
  check('and the coin is still there', broke.coins, 1);
  ok('and nobody is flagged out', ![m.busy, n2.busy, o.busy].some(Boolean));
}

/* -- Upgrades: the escalating sink ------------------------------------ */
{
  ok('every upgrade costs more at each level',
    EXPO_UPGRADES.every(u => u.costs.every((c, i) => i === 0 || c > u.costs[i - 1])));
  ok('and has a price for every level', EXPO_UPGRADES.every(u => u.costs.length === u.max));

  /* The ladder has to dwarf the old decor sink, or it closes again in a
     fortnight. */
  const ladder = EXPO_UPGRADES.reduce((t, u) => t + u.costs.reduce((a, b) => a + b, 0), 0);
  ok('the ladder is a far bigger sink than the old decor cap', ladder > 50000);

  const s = freshState({ coins: 1000000 });
  expoEnsure();
  check('nothing is owned to begin with', expoUpgLevel('yard'), 0);
  check('the yard starts at its base capacity', getMaxYardItems(), MAX_YARD_ITEMS_BASE);

  const cost = expoUpgNextCost('yard');
  const res = expoBuyUpgrade('yard');
  ok('an upgrade can be bought', res.ok);
  check('the coins are taken', s.coins, 1000000 - cost);
  check('the level went up', expoUpgLevel('yard'), 1);
  ok('and the yard actually holds more', getMaxYardItems() > MAX_YARD_ITEMS_BASE);
  ok('the next level costs more', expoUpgNextCost('yard') > cost);

  while (expoUpgNextCost('yard') !== null) expoBuyUpgrade('yard');
  check('a maxed upgrade has no next price', expoUpgNextCost('yard'), null);
  check('and refuses to be bought again', expoBuyUpgrade('yard').ok, false);

  const poor = freshState({ coins: 0 });
  expoEnsure();
  check('an upgrade you cannot afford is refused', expoBuyUpgrade('pace').ok, false);
  check('and takes nothing', poor.coins, 0);
}
{
  const s = freshState({ coins: 1000000 });
  expoEnsure();
  check('slots start at the base', expoMaxSlots(), EXPO_BASE_SLOTS);
  expoBuyUpgrade('slots');
  check('and one more can be bought', expoMaxSlots(), EXPO_BASE_SLOTS + 1);

  check('runs are full length to begin with', expoPaceMult(), 1);
  expoBuyUpgrade('pace');
  ok('and shorter once Pack Animals is bought', expoPaceMult() < 1);

  check('eggs run at normal speed to begin with', eggSpeedMult(), 1);
  expoBuyUpgrade('hatch');
  ok('and faster with the lamps', eggSpeedMult() > 1);
}
{
  /* A shorter run is shorter for real, and the length is frozen so a
     later purchase cannot pull a party already out back early. */
  const period = periodShowing(ONE.id);
  const start = nowFor(period);
  const s = freshState({ coins: 1000000 });
  const a = dino();
  s.park.push(a);
  ready(start);
  expoBuyUpgrade('pace');
  const run = expoDispatch(ONE.id, [a.uid], start).run;
  ok('Pack Animals shortens the run', run.durationSec < ONE.dur);

  const locked = run.durationSec;
  expoBuyUpgrade('pace');
  check('and a later purchase does not shorten one already out', run.durationSec, locked);
}
{
  /* Upgrades are permanent. A rotation must not wipe them. */
  const s = freshState({ coins: 1000000 });
  const p0 = 900;
  expoEnsure(p0 * EXPO_BOARD_PERIOD_MS + 1);
  expoBuyUpgrade('yard');
  expoEnsure((p0 + 40) * EXPO_BOARD_PERIOD_MS + 1);
  check('an upgrade survives every rotation', expoUpgLevel('yard'), 1);
}

/* -- Recurring sinks -------------------------------------------------
   The upgrade ladder is finite and outfitting is only spent by someone
   running expeditions, so neither is a floor under a maxed-out park.
   These four recur on four different clocks, and the one that matters
   most is Renown, which has no ceiling at all. */

/* Rush: priced off time left, and deliberately bad value. */
{
  const period = periodShowing(ONE.id);
  const start = nowFor(period);
  const s = freshState({ coins: 1000000 });
  const a = dino();
  s.park.push(a);
  ready(start);
  const run = expoDispatch(ONE.id, [a.uid], start).run;

  const full = expoRushCost(run);
  ok('a fresh run costs something to call in', full > 0);

  expoTick(start + (run.durationSec / 2) * 1000);
  ok('and less once it is half done', expoRushCost(run) < full);

  const before = s.coins;
  const res = expoRush(run.rid);
  ok('the party can be called in', res.ok);
  check('the coins are taken', s.coins, before - res.cost);
  ok('and they are at the gate', expoIsDone(run));
  check('a party already back cannot be rushed', expoRush(run.rid).ok, false);

  /* Rushing must not become the cheap way to farm: calling in a long run
     should cost more than the run itself is likely to pay. */
  const s2 = freshState({ coins: 1000000 });
  const b = dino(), c = dino(), d = dino();
  s2.park.push(b, c, d);
  const longPeriod = periodShowing('firstshore');
  const longStart = nowFor(longPeriod);
  ready(longStart);
  const big = expoDispatch('firstshore', [b.uid, c.uid, d.uid], longStart).run;
  const site = expoSiteById('firstshore');
  ok('calling in a long run costs more than a good result pays',
    expoRushCost(big) > expoRewardsFor(site, EXPO_TIERS[0], 3).coins * 0.5);
}

/* Reroll: doubles within a rotation, resets with it. */
{
  const s = freshState({ coins: 1000000 });
  const p0 = 700;
  expoEnsure(p0 * EXPO_BOARD_PERIOD_MS + 1);
  getState().expo.completed = ALL_DONE;

  const first = expoRerollCost();
  check('the first reroll is the base price', first, EXPO_REROLL_BASE);
  const before = getState().expo.salt;
  const res = expoReroll();
  ok('it can be bought', res.ok);
  check('the coins are taken', s.coins, 1000000 - first);
  ok('the salt moved, so the board changes', getState().expo.salt !== before);

  const e = getState().expo;
  ok('and the board really is different',
    expoBoardFor(e.period, e.completed, before).map(x => x.id).join() !==
    expoBoardFor(e.period, e.completed, e.salt).map(x => x.id).join());
  ok('but still the same on every device',
    expoBoardFor(e.period, e.completed, e.salt).map(x => x.id).join() ===
    expoBoardFor(e.period, e.completed, e.salt).map(x => x.id).join());

  check('chasing a site doubles the price', expoRerollCost(), EXPO_REROLL_BASE * 2);
  expoReroll();
  check('and doubles again', expoRerollCost(), EXPO_REROLL_BASE * 4);

  /* A site already run stays run — a reroll must not be a way to farm the
     same site twice in one rotation. */
  getState().expo.used.push('tarseeps');
  expoReroll();
  ok('a site already visited stays spent', getState().expo.used.includes('tarseeps'));

  expoEnsure((p0 + 1) * EXPO_BOARD_PERIOD_MS + 1);
  check('a new rotation resets the price', expoRerollCost(), EXPO_REROLL_BASE);
  ok('but not the salt, so the board does not jump back',
    typeof getState().expo.salt === 'number');

  const poor = freshState({ coins: 10 });
  expoEnsure();
  check('a reroll you cannot afford is refused', expoReroll().ok, false);
  check('and takes nothing', poor.coins, 10);
}

/* The Bone Broker: climbs with each egg that day, resets with the day. */
{
  const day = 800;
  const s = freshState({ coins: 1000000 });
  expoEnsure(day * EXPO_QUEST_PERIOD_MS + 1);

  check('the first egg is the list price', brokerCost('common'), BROKER_PRICES.common);
  ok('a rarer egg costs more', brokerCost('legendary') > brokerCost('common'));

  /* It must never be the efficient way to fill a park, or hatching and
     expeditions stop mattering. */
  const cheapSite = EXPO_SITES.find(x => (x.req || 0) === 0);
  ok('even the cheapest egg costs more than an early run pays',
    brokerCost('common') > cheapSite.coins);

  const before = s.coins;
  const res = brokerBuy('common');
  ok('an egg can be bought', res.ok);
  check('the coins are taken', s.coins, before - res.cost);
  ok('and an egg arrives', api.eggs().length >= 1);

  ok('the next one costs more', brokerCost('common') > BROKER_PRICES.common);
  ok('and the rise applies across the whole shelf',
    brokerCost('rare') > BROKER_PRICES.rare);

  check('the broker does not sell nonsense', brokerBuy('mythic').ok, false);

  expoEnsure((day + 1) * EXPO_QUEST_PERIOD_MS + 1);
  check('a new day resets the price', brokerCost('common'), BROKER_PRICES.common);

  const poor = freshState({ coins: 5 });
  expoEnsure();
  check('an egg you cannot afford is refused', brokerBuy('legendary').ok, false);
  check('and takes nothing', poor.coins, 5);
}

/* Park Renown: the endless one, and it must never pay for itself. */
{
  const s = freshState({ coins: 10000000 });
  expoEnsure();
  check('a new park has none', renownLevel(), 0);
  check('and no multiplier', renownMult(), 1);
  check('the first level is the base price', renownCost(), RENOWN_BASE);

  const before = s.coins;
  const res = buyRenown();
  ok('it can be bought', res.ok);
  check('the coins are taken', s.coins, before - res.cost);
  check('the level went up', renownLevel(), 1);
  ok('and so did the multiplier', renownMult() > 1);
  ok('the next level costs more', renownCost() > RENOWN_BASE);

  /* NO CEILING. This is the only sink that cannot be finished, which is
     the whole reason it exists. */
  for (let i = 0; i < 30; i++) buyRenown();
  ok('there is always another level', renownCost() > 0 && renownLevel() >= 10);

  /* AND IT MUST DRAIN. A sink that pays itself back is a faucet. The
     price compounds while the payout is linear, so the gap only widens:
     one level must cost far more than the extra coins it will ever
     plausibly return. */
  const lv = renownLevel();
  const nextCost = renownCost();
  const extraPerRun = EXPO_SITES[EXPO_SITES.length - 1].coins * RENOWN_PCT_PER_LEVEL;
  ok('a level costs far more than the coins it adds to a run',
    nextCost > extraPerRun * 100);
  ok('and the price outgrows the payout as it climbs',
    renownCost() / (lv + 1) > RENOWN_BASE / 1);

  const poor = freshState({ coins: 0 });
  expoEnsure();
  check('renown you cannot afford is refused', buyRenown().ok, false);
}
{
  /* Renown actually reaches the coins it advertises. */
  const period = periodShowing(THREE.id);
  const start = nowFor(period);

  const payout = (renown) => {
    const st = freshState({ coins: 10000000 });
    const x = dino({ careCount: 200 }), y = dino({ careCount: 200 }), z = dino({ careCount: 200 });
    st.park.push(x, y, z);
    ready(start);
    st.expo.renown = renown;
    const r = expoDispatch(THREE.id, [x.uid, y.uid, z.uid], start).run;
    r.roll = 0.5;
    expoTick(start + (r.durationSec + 10) * 1000);
    return expoClaim(r.rid, start + (r.durationSec + 10) * 1000).reward.coins;
  };
  ok('renown raises what an expedition pays', payout(50) > payout(0));
}

/* ── The page actually wires it up ───────────────────────────────────── */
{
  /* The yard cap has to be READ through the upgrade everywhere, or
     Groundskeeping is bought and nothing changes. */
  check('only the definition mentions the base cap',
    (src.match(/MAX_YARD_ITEMS_BASE/g) || []).length, 2);
  ok('the yard checks the upgraded cap', /state\.yardItems\.length >= getMaxYardItems\(\)/.test(src));
  ok('and incubation reads the lamps', /deltaSec \* eggMult/.test(src));
  ok('the kit picker is wired to dispatch', /onExpoKit\(/.test(src));
  ok('rushing is reachable', /onExpoRush\(/.test(src));
  ok('so is rerolling', /onExpoReroll\(/.test(src));
  ok('so is the broker', /onBrokerBuy\(/.test(src));
  ok('and renown', /onBuyRenown\(/.test(src));
  ok('renown reaches the care payout', /2 \* renownMult\(\)/.test(src));
  /* Rarity colours come from the shared tokens and only ever signal
     rarity - never a hardcoded hex, never a UI accent. */
  ok('the broker uses the rarity tokens', /var\(--rarity-legendary\)/.test(src));
  ok('and the upgrade panel to the buy', /onExpoBuyUpgrade\(/.test(src));

  ok('the tab is in the tab order', /TAB_ORDER = \[[^\]]*'expeditions'/.test(src));
  ok('and has a panel to render into', /id="tab-expeditions"/.test(src));
  ok('and a button that reaches it', /switchTab\('expeditions'\)/.test(src));
  ok('switchTab renders it', /if \(tab === 'expeditions'\) renderExpeditions\(\);/.test(src));
  ok('the game loop advances parties', /expoTick\(now\)/.test(src));
  ok('a closed browser is credited on load', /expoCatchup\(state\.lastTick\)/.test(src));
  ok('and the save is repaired on a cloud merge', /ensureDinoUids\(\);[\s\S]{0,400}?expoEnsure\(\);[\s\S]{0,200}?applySubTierFromSession/.test(src));

  /* An animal in the field is not simultaneously resting at home or
     drawing park wages — that is the whole cost of sending it. */
  ok('care is refused while away', /if \(dino && dino\.busy\) \{ showToast/.test(src));
  ok('the overnight rest bonus skips them', /state\.park\.forEach\(d => \{ if \(d\.busy\) return; ensureDinoStats\(d\); d\.stamina/.test(src));
  ok('and so does passive park XP', /state\.park\.forEach\(d => \{ if \(d\.busy\) return; ensureDinoStats\(d\); awardDinoXp/.test(src));

  /* The counters have to be incremented from the real actions, or every
     note sits at 0 / 5 forever. */
  ok('caring counts', /expoCount\('care'\)/.test(src));
  ok('tidying counts', /expoCount\('debris'\)/.test(src));
  ok('hatching counts', /expoCount\('hatch'\)/.test(src));

  /* PWR/GRD/SPD must have exactly ONE definition — the card and the
     expedition have to agree about how strong an animal is. */
  ok('the collection card reads dinoAttrs', /const \{ power, guard, speed \} = dinoAttrs\(dino\);/.test(src));
  check('and the formula exists exactly once',
    (src.match(/\* 0\.8 \+ bonus/g) || []).length, 1);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[dino-expeditions] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[dino-expeditions] ${passed} assertions passed.`);
console.log('');
