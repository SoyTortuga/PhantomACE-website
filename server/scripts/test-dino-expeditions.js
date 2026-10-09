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
  lift('expoPeriod'), lift('expoRand'), lift('expoBoardFor'), lift('expoSiteById'),
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
    EXPO_BASE_SLOTS, EXPO_STAMINA_COST, EXPO_QUESTS, EXPO_QUEST_COUNT,
    dinoAttrs, expoPeriod, expoBoardFor, expoSiteById, expoPartyScore, expoTierFor,
    expoCreditSec, expoIsDone, expoRemainingWallSec, expoRewardsFor, expoQuestsFor,
    expoMaxSlots, expoEnsure, expoAvailableDinos, expoDispatch, expoCredit, expoTick,
    expoClaim, expoCount, expoQuestState, expoClaimQuest, expoQuestById,
    setState: (s) => { state = s; },
    getState: () => state,
    setLive: (v) => { isStreamLive = v; },
    eggs: () => eggsGranted,
  };
`)();

const {
  EXPO_SITES, EXPO_TIERS, EXPO_LIVE_BOOST, EXPO_BOARD_PERIOD_MS, EXPO_QUEST_PERIOD_MS,
  EXPO_BASE_SLOTS, EXPO_STAMINA_COST, EXPO_QUEST_COUNT,
  dinoAttrs, expoPeriod, expoBoardFor, expoSiteById, expoPartyScore, expoTierFor,
  expoCreditSec, expoIsDone, expoRemainingWallSec, expoRewardsFor, expoQuestsFor,
  expoMaxSlots, expoEnsure, expoAvailableDinos, expoDispatch, expoCredit, expoTick,
  expoClaim, expoQuestState, expoClaimQuest, expoQuestById, setState, getState, setLive,
} = api;

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

/* A site big enough to need a real party, picked from the shipped table
   rather than invented, so the suite tracks the catalog. */
const THREE = EXPO_SITES.find(s => s.slots === 3);
const ONE = EXPO_SITES.find(s => s.slots === 1);

/** Put `siteId` on the board by finding a period whose board contains it. */
function periodShowing(siteId) {
  for (let p = 0; p < 5000; p++) {
    if (expoBoardFor(p).some(s => s.id === siteId)) return p;
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
  ok('a strictly longer run always pays strictly more',
    EXPO_SITES.every(a => EXPO_SITES.every(b => !(a.dur < b.dur) || a.coins < b.coins)));
}

/* ── The board is the same everywhere, and it rotates ────────────────── */
{
  const p = 1234;
  check('the board is deterministic for a period',
    expoBoardFor(p).map(s => s.id), expoBoardFor(p).map(s => s.id));
  ok('and a different period is a different board',
    expoBoardFor(p).map(s => s.id).join() !== expoBoardFor(p + 1).map(s => s.id).join());
  ok('a board never offers the same site twice',
    new Set(expoBoardFor(p).map(s => s.id)).size === expoBoardFor(p).length);
  check('three sites on offer', expoBoardFor(p).length, 3);

  /* Over many rotations every site must actually come up, or a site in the
     table is one nobody can ever visit. */
  const seen = new Set();
  for (let i = 0; i < 400; i++) expoBoardFor(i).forEach(s => seen.add(s.id));
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
  expoEnsure(now);

  check('too few animals is refused',
    expoDispatch(THREE.id, [a.uid], now).ok, false);
  check('a site not on the board is refused',
    expoDispatch(EXPO_SITES.find(x => !expoBoardFor(period).some(y => y.id === x.id)).id, [a.uid, b.uid, c.uid], now).ok, false);

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
  expoEnsure(now);
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
  expoEnsure(start);
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
  expoEnsure(start);
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
  expoEnsure(start);
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
  expoEnsure(start);
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
  expoEnsure(start);
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
  expoEnsure(now);
  expoDispatch(ONE.id, [a.uid], now);
  expoEnsure(now);
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

/* ── The page actually wires it up ───────────────────────────────────── */
{
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
