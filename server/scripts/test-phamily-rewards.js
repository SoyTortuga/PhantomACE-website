#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PHAMILY TIME REWARDS — test suite

     node server/scripts/test-phamily-rewards.js

   Two jobs.

   FIRST, the server table itself. functions/api/phamily-rewards.js is now the
   ONE source of truth for the reward tables: the page fetches them from the
   server (via /api/phamily-time?action=tables) rather than keeping a copy, so
   there is no second definition to drift against. This file asserts the
   server's own tables — their shape, their themes, their room drip, and that
   every cosmetic a reward names exists in the game that reads it.

   SECOND, the refusals. The server used to take rewardType, rewardRarity
   and rewardName from the request body and hand them to grantReward, which
   uses all three to decide what a claim is worth. Only the key and the level
   were checked. Anyone past level 2 could therefore claim any reward at
   mythic, turn a giveaway into a banner, or name one "Guaranteed Mutant Egg"
   and get exactly that.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from '../../functions/api/phamily-rewards.js';
import { piece, pieces as catalogPieces, basicCategories } from '../../functions/api/room-catalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── A clock the tests control ───────────────────────────────────────
   The tables are a function of the month, so nothing here may depend on
   what today happens to be. setNow() moves the global clock that
   monthKey() reads; every month-dependent assertion names its month. */
const RealDate = Date;
let FAKE_NOW = null;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length || FAKE_NOW === null) super(...a); else super(FAKE_NOW); }
  static now() { return FAKE_NOW === null ? RealDate.now() : FAKE_NOW; }
};
const setNow = (iso) => { FAKE_NOW = iso === null ? null : RealDate.parse(iso); };

/* ── The months the server-side assertions sweep ─────────────────────────
   A spread of unthemed months on either side of the themed ones — the month
   is always passed in, never read from today's date, so a reward table is
   tested for a month whether or not it is live yet. */
const BASE_MONTHS = ['2026-08', '2026-09', '2026-12', '2027-03'];

/* ── The server table is the one source of truth ─────────────────────────
   The page used to carry a verbatim mirror of these tables and this suite
   lifted the page's define* functions out and compared them reward-for-reward.
   The mirror is gone — the page fetches the finished tables from the server
   now — so there is nothing to compare against and no drift to guard. What the
   tables ARE is asserted here and in the sections that follow. */
{
  ok('at least one themed month is covered', R.THEMED_MONTHS.length > 0);

  /* A themed month must actually differ from a base month, or the themes are
     doing nothing at all. */
  for (const mk of R.THEMED_MONTHS) {
    const themed = R.rewardTablesFor(mk);
    const base = R.rewardTablesFor('2026-09');
    ok(`${mk} re-skins something on the follower track`,
      JSON.stringify(themed.follower) !== JSON.stringify(base.follower));
    ok(`${mk} re-skins the milestones`,
      JSON.stringify(themed.milestones) !== JSON.stringify(base.milestones));
    /* Keys are identical across months — that is what lets a grace claim
       name last month's reward with this month's key. */
    for (const track of ['follower', 'phamily']) {
      check(`${mk} ${track} keys match a base month`,
        themed[track].map(r => R.rewardKeyFor(r, track)), base[track].map(r => R.rewardKeyFor(r, track)));
    }
  }
}

/* ── MY ROOM DRIPS BY MONTH ──────────────────────────────────────────
   The drip used to be one list edited in place on the 1st, so September's
   table silently became October's and a grace claim of a September piece
   paid October's. Each month now has its own list. */
{
  const pieces = (mk, track) => R.rewardTablesFor(mk)[track]
    .filter(r => r.type === 'room-piece').map(r => [R.rewardKeyFor(r, track), r.cosmeticId]);

  /* Each authored month must be the NEXT tenth of every set in catalog
     order: same levels, same per-set counts, no piece repeated from any
     earlier month. */
  const bySet = {};
  for (const p of catalogPieces()) (bySet[p.category] = bySet[p.category] || []).push(p.id);
  const setOf = (id) => id.replace(/-r\d+c\d+$/, '');
  for (const track of ['follower', 'phamily']) {
    const months = R.ROOM_DRIP_MONTHS;
    const first = pieces(months[0], track);
    months.forEach((mk, n) => {
      const cur = pieces(mk, track);
      check(`${track} ${mk}: drips at the same keys as ${months[0]}`, cur.map(p => p[0]), first.map(p => p[0]));
      check(`${track} ${mk}: same per-set counts`, cur.map(p => setOf(p[1])), first.map(p => setOf(p[1])));
      const counts = {};
      for (const p of cur) counts[setOf(p[1])] = (counts[setOf(p[1])] || 0) + 1;
      const expected = {};
      for (const [set, k] of Object.entries(counts)) expected[set] = bySet[set].slice(n * k, (n + 1) * k);
      const actual = {};
      for (const p of cur) (actual[setOf(p[1])] = actual[setOf(p[1])] || []).push(p[1]);
      check(`${track} ${mk}: is tenth #${n + 1} of every set, in catalog order`, actual, expected);
      for (const earlier of months.slice(0, n)) {
        const prior = new Set(pieces(earlier, track).map(p => p[1]));
        check(`${track} ${mk}: shares no piece with ${earlier}`, cur.map(p => p[1]).filter(id => prior.has(id)), []);
      }
    });
    const last = months[months.length - 1];
    check(`${track}: a month after the last drip keeps the last`, pieces('2027-03', track), pieces(last, track));
    check(`${track}: a month before the first drip uses the first`, pieces('2026-08', track), first);
  }
  check('three months of drip are authored', R.ROOM_DRIP_MONTHS, ['2026-09', '2026-10', '2026-11']);
  check('a September room-piece key resolves to September\'s piece',
    R.findReward('4_follower_room-piece_common', '2026-09').cosmeticId, 'snacks-r1c1');
  check('in October to October\'s', R.findReward('4_follower_room-piece_common', '2026-10').cosmeticId, 'snacks-r1c8');
  check('and in November to November\'s', R.findReward('4_follower_room-piece_common', '2026-11').cosmeticId, 'snacks-r2c2');

  /* Every month's pieces must be real catalog pieces of a set nobody has
     by default, and no track may drip the same piece twice in one month.
     test-room-validator checks the CURRENT table; this covers them all. */
  const basicSet = basicCategories();
  for (const mk of [...new Set([...R.ROOM_DRIP_MONTHS, ...BASE_MONTHS])]) {
    for (const track of ['follower', 'phamily']) {
      const ids = pieces(mk, track).map(p => p[1]);
      check(`${mk} ${track}: every drip piece exists in the room catalog`, ids.filter(id => !piece(id)), []);
      check(`${mk} ${track}: none is from a basic set`, ids.filter(id => piece(id) && basicSet.has(piece(id).category)), []);
      check(`${mk} ${track}: no piece dripped twice`, ids.length - new Set(ids).size, 0);
    }
  }
}

/* ── THE MONTH IS ASKED, NOT REMEMBERED ──────────────────────────────
   The tables used to be built once at import, so a server started in
   October kept October's content into November, and a grace claim of a
   September key was looked up in October's table. */
{
  check('a September key resolves to September content',
    R.findReward('10_follower_cardback_common', '2026-09').name, 'Basic Card Back');
  check('the same key in October is October content',
    R.findReward('10_follower_cardback_common', '2026-10').name, 'Cobweb Card Back');
  check('November\'s is November\'s',
    R.findReward('10_follower_cardback_common', '2026-11').name, 'Withered Wheat Card Back');
  check('and in December it is back to base',
    R.findReward('10_follower_cardback_common', '2026-12').name, 'Basic Card Back');
  check('a September skull skin is September\'s cosmetic',
    R.findReward('85_follower_skull-skin_rare', '2026-09').cosmeticId, 'blood');
  check('October\'s is October\'s', R.findReward('85_follower_skull-skin_rare', '2026-10').cosmeticId, 'bonewhite');
  check('a September milestone has September\'s title', R.findMilestone(15, '2026-09').title, 'Initiate');
  check('October\'s has October\'s', R.findMilestone(15, '2026-10').title, 'Trick-or-Treater');
  check('November\'s has November\'s', R.findMilestone(15, '2026-11').title, 'Gleaner');
  const sepDice = R.findMilestone(60, '2026-09').bonusItems.find(b => b.type === 'dice');
  check('a September milestone bonus is September\'s dice', sepDice.cosmeticId, 'crimson');
  const sepBanner = R.findMilestone(45, '2026-09').bonusItems.find(b => b.type === 'banner');
  check('and a September banner carries no theme', sepBanner.meta, undefined);
  check('earnedRewards follows the month it is given',
    R.earnedRewards('follower', 10, '2026-10').find(r => r.type === 'cardback').name, 'Cobweb Card Back');
  check('earnedMilestones too', R.earnedMilestones(15, '2026-09')[0].title, 'Initiate');

  /* The current-month exports are live views, not load-time snapshots. */
  setNow('2026-10-15T19:00:00Z');
  check('FOLLOWER_REWARDS in October is October',
    R.FOLLOWER_REWARDS.find(r => r.level === 10 && r.type === 'cardback').name, 'Cobweb Card Back');
  check('MILESTONES in October is October', R.MILESTONES[0].title, 'Trick-or-Treater');
  check('findReward with no month means the current month',
    R.findReward('10_follower_cardback_common').name, 'Cobweb Card Back');
  setNow('2026-11-02T19:00:00Z');
  check('the same running module in November is November',
    R.FOLLOWER_REWARDS.find(r => r.level === 10 && r.type === 'cardback').name, 'Withered Wheat Card Back');
  check('MILESTONES in November is November', R.MILESTONES[0].title, 'Gleaner');
  setNow('2026-12-02T19:00:00Z');
  check('and in December is base', R.MILESTONES[0].title, 'Initiate');
  check('findReward with no month follows the clock',
    R.findReward('10_follower_cardback_common').name, 'Basic Card Back');
  ok('the views still behave as arrays', Array.isArray(R.PHAMILY_REWARDS) && [...R.PHAMILY_REWARDS].length === R.PHAMILY_REWARDS.length);
  check('and survive JSON', JSON.stringify(R.MILESTONES), JSON.stringify(R.rewardTablesFor('2026-12').milestones));
  let threw = false;
  try { R.FOLLOWER_REWARDS.push({}); } catch { threw = true; }
  ok('and are read-only', threw && R.FOLLOWER_REWARDS.length === R.rewardTablesFor('2026-12').follower.length);
  setNow(null);
}

/* ── CARD BACKS AND EMOTE PACKS: ONE ID PER COSMETIC ─────────────────
   These used to be granted with the reward KEY as their id. The key is the
   same every month, so October's Cobweb Card Back deduped against
   September's Basic Card Back and was never granted. The id is now the type
   plus the name: distinct per cosmetic, stable for a repeat of the same. */
{
  check('a card back id is type plus name',
    R.nameKeyedItemId('cardback', 'Cobweb Card Back'), 'cardback-cobweb-card-back');
  check('and an emote pack likewise',
    R.nameKeyedItemId('emote-pack', 'Spooky Emote Pack'), 'emote-pack-spooky-emote-pack');
  ok('October\'s card back is a different item from September\'s',
    R.nameKeyedItemId('cardback', R.findReward('10_follower_cardback_common', '2026-10').name) !==
    R.nameKeyedItemId('cardback', R.findReward('10_follower_cardback_common', '2026-09').name));
  check('the same cosmetic in two base months is the same item',
    R.nameKeyedItemId('cardback', R.findReward('10_follower_cardback_common', '2026-09').name),
    R.nameKeyedItemId('cardback', R.findReward('10_follower_cardback_common', '2026-12').name));

  /* Memory Match resolves these BY NAME, so the id change cannot affect
     what it draws — but every name the pass hands out must resolve to
     something the game actually has, rather than the fallback. */
  const mm = fs.readFileSync(path.join(REPO, 'games/memory-match/index.html'), 'utf8');
  const fnSrc = mm.match(/function getCosmeticId\(item, prefix\) \{[\s\S]*?\n {4}\}/);
  ok('Memory Match still resolves cosmetics by name', !!fnSrc && /item\.name/.test(fnSrc[0]));
  const getCosmeticId = new Function(`${fnSrc[0]}\nreturn getCosmeticId;`)();
  const keysOf = (decl) => {
    const block = mm.slice(mm.indexOf(decl), mm.indexOf('};', mm.indexOf(decl)));
    return [...block.matchAll(/^ {6}([a-z]+): \{/gm)].map(m => m[1]);
  };
  const CARD_BACKS = keysOf('const CARD_BACKS = {');
  const EMOTE_SETS = keysOf('const EMOTE_SETS = {');
  ok('the game defines card backs', CARD_BACKS.length >= 4);
  ok('and emote sets', EMOTE_SETS.length >= 3);

  for (const mk of [...new Set([...R.THEMED_MONTHS, ...BASE_MONTHS])]) {
    const t = R.rewardTablesFor(mk);
    const all = [...t.follower, ...t.phamily];
    const cbs = all.filter(r => r.type === 'cardback');
    const emotes = all.filter(r => r.type === 'emote');
    check(`${mk}: every card back resolves to one the game draws`,
      cbs.filter(r => !CARD_BACKS.includes(getCosmeticId({ name: r.name }, 'cb'))).map(r => r.name), []);
    check(`${mk}: every emote pack resolves to one the game draws`,
      emotes.filter(r => !EMOTE_SETS.includes(getCosmeticId({ name: r.name }, 'emote'))).map(r => r.name), []);
    const ids = [...cbs.map(r => R.nameKeyedItemId('cardback', r.name)), ...emotes.map(r => R.nameKeyedItemId('emote-pack', r.name))];
    check(`${mk}: no two of them share an id`, ids.filter((id, i) => ids.indexOf(id) !== i), []);
  }
  /* A themed month's card backs and emote packs must each resolve to their
     OWN cosmetic — never a fallback, never one another's, never an older
     month's. Resolution is by keyword, so a careless name silently draws
     the wrong art. */
  const resolvedBy = new Map();
  for (const mk of R.THEMED_MONTHS) {
    const t = R.rewardTablesFor(mk);
    const named = [...t.follower, ...t.phamily].filter(r => r.type === 'cardback' || r.type === 'emote');
    const resolved = named.map(r => `${r.type}:${getCosmeticId({ name: r.name }, r.type === 'emote' ? 'emote' : 'cb')}`);
    check(`${mk}: names resolve to themed cosmetics, not the fallbacks`,
      resolved.filter(id => /:(basic|bonus)$/.test(id)), []);
    check(`${mk}: each resolves to a different cosmetic`, resolved.filter((id, i) => resolved.indexOf(id) !== i), []);
    for (const id of resolved) {
      if (resolvedBy.has(id)) failures.push(`${mk}: ${id} was already ${resolvedBy.get(id)}'s`);
      else { resolvedBy.set(id, mk); passed++; }
    }
  }
  const novCb = [...R.rewardTablesFor('2026-11').follower, ...R.rewardTablesFor('2026-11').phamily]
    .filter(r => r.type === 'cardback').map(r => r.name);
  check('November\'s card backs are exactly the four the game ships',
    novCb.slice().sort(), ['Bone Sickle Card Back', 'Carrion Crow Card Back', 'Hollow Moon Card Back', 'Withered Wheat Card Back']);
  check('no card back is named with "harvest" (that keyword is the emote pack\'s)',
    R.THEMED_MONTHS.flatMap(mk => [...R.rewardTablesFor(mk).follower, ...R.rewardTablesFor(mk).phamily])
      .filter(r => r.type === 'cardback' && /harvest/i.test(r.name)).map(r => r.name), []);
  check('nor any "Scarecrow ... Card Back"',
    R.THEMED_MONTHS.flatMap(mk => [...R.rewardTablesFor(mk).follower, ...R.rewardTablesFor(mk).phamily])
      .filter(r => r.type === 'cardback' && /scarecrow/i.test(r.name)).map(r => r.name), []);
}

/* ── SKULL CLICKER: every skin / click effect names a theme the game has,
   and its name does not trip an older theme's keyword. The game resolves an
   item by NAME first and falls back to its id. ───────────────────────── */
{
  const sc = fs.readFileSync(path.join(REPO, 'games/skull-clicker/index.html'), 'utf8');
  const fnSrc = sc.match(/function getCosmeticThemeId\(item\) \{[\s\S]*?\n {4}\}/);
  ok('Skull Clicker still resolves cosmetics by name', !!fnSrc);
  const resolve = new Function(`${fnSrc[0]}\nreturn getCosmeticThemeId;`)();
  for (const mk of [...new Set([...R.THEMED_MONTHS, ...BASE_MONTHS])]) {
    const t = R.rewardTablesFor(mk);
    const skins = [...t.follower, ...t.phamily].filter(r => r.type === 'skull-skin' || r.type === 'click-effect');
    check(`${mk}: every skin / click effect id is defined in the game`,
      skins.filter(r => !sc.includes(`'${r.cosmeticId}': { name:`)).map(r => r.cosmeticId), []);
    check(`${mk}: and each name resolves to its own id`,
      skins.filter(r => resolve({ id: r.cosmeticId, name: r.name }) !== r.cosmeticId).map(r => `${r.name}->${resolve({ id: r.cosmeticId, name: r.name })}`), []);
  }
}

/* ── THEME KEYS ──────────────────────────────────────────────────────── */
{
  check('October is halloween', R.themeKeyFor('2026-10'), 'halloween');
  check('November is harvest', R.themeKeyFor('2026-11'), 'harvest');
  check('December is unthemed', R.themeKeyFor('2026-12'), null);
  for (const mk of R.THEMED_MONTHS) {
    const ms = R.rewardTablesFor(mk).milestones;
    const stamped = ms.flatMap(m => m.bonusItems || []).filter(b => b.type === 'banner' || b.type === 'nameeffect');
    check(`${mk}: every banner / name effect carries the month's theme key`,
      stamped.filter(b => !b.meta || b.meta.theme !== R.themeKeyFor(mk)).map(b => b.name), []);
    check(`${mk}: ten distinct titles`, new Set(ms.map(m => m.title)).size, 10);
  }
  check('November\'s titles in order', R.rewardTablesFor('2026-11').milestones.map(m => m.title),
    ['Gleaner', 'Crow Caller', 'Field Warden', 'Scarecrow Knight', 'Harvest Witch', 'Bone Thresher', 'Barrow Keeper', 'Sickle Saint', 'Hollow Lord', 'Lord of the Last Harvest']);
}

/* ── The table itself ────────────────────────────────────────────────── */
{
  const all = [...R.FOLLOWER_REWARDS, ...R.PHAMILY_REWARDS];
  check('every reward has a level', all.filter(r => !Number.isInteger(r.level)).length, 0);
  check('every reward has a type', all.filter(r => !r.type).length, 0);
  check('every reward has a rarity', all.filter(r => !r.rarity).length, 0);
  check('rarities are all known',
    all.filter(r => !['common', 'uncommon', 'rare', 'mythic'].includes(r.rarity)).map(r => r.rarity), []);

  /* Keys are the identity of a reward, so two rewards sharing one would make
     the second unclaimable — the first claim marks the key done. */
  for (const [track, list] of [['follower', R.FOLLOWER_REWARDS], ['phamily', R.PHAMILY_REWARDS]]) {
    const keys = list.map(r => R.rewardKeyFor(r, track));
    check(`${track} keys are unique`, keys.filter((k, i, a) => a.indexOf(k) !== i), []);
  }

  check('ten milestones', R.MILESTONES.length, 10);
  check('every milestone has a title', R.MILESTONES.filter(m => !m.title).length, 0);
}

/* ── Lookup refuses what is not on the track ─────────────────────────── */
{
  const real = R.rewardKeyFor(R.FOLLOWER_REWARDS[0], 'follower');
  ok('a real key resolves', !!R.findReward(real));
  check('and carries its track', R.findReward(real).track, 'follower');

  /* THE EXPLOIT. A level-2 follower giveaway exists at common; the same key
     at mythic does not, and inventing one must not grant 50 entries. */
  check('the same reward at a higher rarity does not exist',
    R.findReward('2_follower_giveaway_mythic'), null);
  check('nor a type swapped for a richer one',
    R.findReward('2_follower_egg_mythic'), null);
  check('nor a level nobody reaches', R.findReward('999_follower_giveaway_mythic'), null);
  check('nor an empty key', R.findReward(''), null);
  check('nor a made-up track', R.findReward('2_broadcaster_giveaway_common'), null);

  check('a milestone resolves by level', R.findMilestone(15).level, 15);
  check('a level between milestones does not', R.findMilestone(16), null);
}

/* ── Track selection follows subTier, not role ───────────────────────── */
{
  check('no sub is the follower track', R.trackFor(0), 'follower');
  check('tier 1 is the phamily track', R.trackFor(1), 'phamily');
  check('tier 3 too', R.trackFor(3), 'phamily');
  /* The bug this shape avoids: a subscribing moderator whose role string
     says 'moderator' still has subTier 1 and belongs on the paid track. */
  check('a missing tier falls back to follower', R.trackFor(undefined), 'follower');
}

/* ── What is earned at a level ───────────────────────────────────────── */
{
  check('nothing at level 0', R.earnedRewards('follower', 0).length, 0);
  check('nothing at level 1', R.earnedRewards('follower', 1).length, 0);
  ok('something at level 2', R.earnedRewards('follower', 2).length > 0);

  const at50 = R.earnedRewards('follower', 50);
  check('everything earned is at or below the level',
    at50.filter(r => r.level > 50).length, 0);
  ok('and it is a real subset', at50.length < R.FOLLOWER_REWARDS.length);

  check('the whole track at max level',
    R.earnedRewards('phamily', 150).length, R.PHAMILY_REWARDS.length);

  check('no milestones before the first', R.earnedMilestones(14).length, 0);
  check('one at fifteen', R.earnedMilestones(15).length, 1);
  check('all ten at 150', R.earnedMilestones(150).length, 10);
}

/* ── Every claim hands the mapper what it needs ──────────────────────
   A REGRESSION GUARD FOR A BUG THAT SHIPPED TWICE.

   grantReward() takes a cosmeticId and passes it to the item mapper.
   Four reward types read it to say WHICH cosmetic was granted — a skull
   theme, a click effect, a room set, a room piece — and leaving it out
   does not fail. The mapper builds an item with `undefined` in its id and
   its meta, grantItem stores it happily, and it matches nothing: the
   reward is claimed, gone from the track, and invisible in the game.
   Worse, grantItem dedupes non-consumables by id, so the SECOND such
   claim is silently dropped as a duplicate of the first `undefined`.

   There are two call sites in phamily-time.js — one for a reward, one for
   a milestone bonus — and the fix was once applied to only one of them.
   So this reads the source and insists on both, which no amount of
   testing the table alone would have caught.
   ─────────────────────────────────────────────────────────────────── */
{
  const src = fs.readFileSync(path.join(REPO, 'functions/api/phamily-time.js'), 'utf8');

  /* Every `await grantReward(env, session, { ... });` in the file. */
  const calls = [...src.matchAll(/await grantReward\(env, session, \{([\s\S]*?)\}\);/g)].map(m => m[1]);
  check('both call sites found', calls.length, 2);
  const without = calls.filter(body => !/cosmeticId/.test(body));
  check('every call site passes cosmeticId', without.length, 0);
  const notFromTable = calls.filter(body => !/cosmeticId:\s*(reward|bonus)\.cosmeticId/.test(body));
  check('and takes it from the table, not the request', notFromTable.length, 0);

  /* The mappers that read it, and the rewards that must therefore carry
     one. A table entry missing its cosmeticId is the same bug from the
     other end. */
  /* `dice` joined this list after the pass spent four years advertising
     dice cosmetics and delivering none: the mapper granted a generic
     'dice-pack' keyed by the reward key, and Mana Clash -- which read the
     inventory not at all -- had nothing to match it against. The guard did
     not catch it because the type was not named here. */
  const NEEDS_ID = ['skull-skin', 'click-effect', 'room-set', 'room-piece', 'dice'];
  const all = [...R.FOLLOWER_REWARDS, ...R.PHAMILY_REWARDS];
  const bare = all.filter(r => NEEDS_ID.includes(r.type) && !r.cosmeticId);
  check('every reward of an id-carrying type has one',
    bare.map(r => `${r.level}:${r.type}`), []);
  const bonuses = R.MILESTONES.flatMap(m => m.bonusItems || []);
  const bareBonus = bonuses.filter(b => NEEDS_ID.includes(b.type) && !b.cosmeticId);
  check('and every milestone bonus of one too', bareBonus.map(b => b.type), []);

  /* AND IDENTITY INCLUDES THE TYPE. grantItem decides whether somebody
     already has an item; cosmetic ids are namespaced per type by the
     games that read them, so 'void' names both the Dark Altar skin and
     the Void click effect. Matching on id alone made the second claim a
     duplicate of the first — spent, and nothing granted. grantItem is
     not exported (it needs env), so this reads the source. */
  ok('grantItem identifies an item by type as well as id',
    /i\.id === item\.id && i\.type === item\.type/.test(src));
  ok('and uses that same test for the consumable branch',
    (src.match(/inv\.items\.find\(same\)/g) || []).length === 2);

  /* The mappers really do read it — if one stops, this guard is moot and
     should be revisited rather than quietly passing. */
  const stillRead = NEEDS_ID.filter(t => {
    /* Quotes optional: a key only needs them when it contains a hyphen, so
       'skull-skin' has them and dice does not. Requiring them made this
       guard blind to exactly the mappers least likely to be noticed. */
    const m = new RegExp(`'?${t}'?:[\\s\\S]{0,240}?cosmeticId`);
    return m.test(src);
  });
  check('every id-carrying mapper still reads cosmeticId', stillRead.length, NEEDS_ID.length);
}

/* ── EVERY DICE REWARD NAMES A SET THE GAME HAS ──────────────────────
   The whole failure was an advertised cosmetic with nothing at the other
   end. A cosmeticId that matches no entry in DICE_SETS is exactly that
   again, and it would look perfectly healthy from the pass's side. */
{
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  const { fileURLToPath: f2 } = await import('node:url');
  const REPO2 = path2.resolve(path2.dirname(f2(import.meta.url)), '../..');
  const page = fs2.readFileSync(path2.join(REPO2, 'games/mana-clash/index.html'), 'utf8');

  const block = page.slice(page.indexOf('const DICE_SETS = {'), page.indexOf('let ownedDiceSets'));
  const sets = [...block.matchAll(/^  ([a-z]+): \{/gm)].map(m => m[1]);
  ok('the game defines dice sets', sets.length >= 2);
  ok('and classic is one of them', sets.includes('classic'));

  /* Every month, not just the current one: a themed month's dice must
     exist in the game before that month arrives. */
  for (const mk of [...new Set([...R.THEMED_MONTHS, ...BASE_MONTHS])]) {
    const t = R.rewardTablesFor(mk);
    const diceRewards = [...t.follower, ...t.phamily].filter(r => r.type === 'dice');
    const diceBonuses = t.milestones.flatMap(m => m.bonusItems || []).filter(b => b.type === 'dice');
    ok(`${mk}: the pass still advertises dice`, diceRewards.length + diceBonuses.length >= 4);

    const orphans = [...diceRewards, ...diceBonuses]
      .filter(r => !sets.includes(r.cosmeticId))
      .map(r => `${r.name}:${r.cosmeticId}`);
    check(`${mk}: every dice reward names a set the game has`, orphans, []);

    /* And no two award the same one, or the second is a duplicate grant --
       spent from the track and silently doing nothing, which is the shape
       of the original bug. */
    const ids = [...diceRewards, ...diceBonuses].map(r => r.cosmeticId);
    check(`${mk}: and no two hand out the same set`, ids.filter((id, i) => ids.indexOf(id) !== i), []);
  }
  const nov = R.rewardTablesFor('2026-11');
  check('November\'s six dice are exactly the harvest sets',
    [...nov.follower, ...nov.phamily].filter(r => r.type === 'dice').map(r => r.cosmeticId)
      .concat(nov.milestones.flatMap(m => m.bonusItems || []).filter(b => b.type === 'dice').map(b => b.cosmeticId)).sort(),
    ['chaff', 'crowfeather', 'hollow', 'scarecrow', 'scythe', 'withered']);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[phamily-rewards] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[phamily-rewards] ${passed} assertions passed.`);
console.log('');
