#!/usr/bin/env node
/* ══════════════════════════════════════════════
   REPAIR COSMETIC GRANTS — test suite

     node server/scripts/test-repair-cosmetic-grants.js

   The repair script rewrites people's inventories, and it cannot be
   rehearsed here: this machine has no database. So the two things it
   decides on its own are checked instead.

   isBroken() — what it will DELETE. A false positive destroys a
   legitimate item, so every shape of real item must survive it.

   ITEM_FOR — what it will CREATE. These must be byte-identical to
   REWARD_ITEM_MAP in functions/api/phamily-time.js, which cannot be
   imported (it is a route module and importing runs its boot). So the
   mapper source is read and compared instead: if someone changes how a
   room piece is identified, this fails rather than the repair quietly
   writing items the game does not recognise.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITEM_FOR, isBroken, LEGACY_KEYS, resolveClaim } from './repair-cosmetic-grants.js';
import { FOLLOWER_REWARDS, PHAMILY_REWARDS } from '../../functions/api/phamily-rewards.js';

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

/* ── What it will create ─────────────────────────────────────────────── */
{
  check('a room piece', ITEM_FOR['room-piece']('snacks-r1c1'),
    { id: 'room-piece-snacks-r1c1', game: 'profile', type: 'room-piece', consumable: false, meta: { piece: 'snacks-r1c1' } });
  check('a room set', ITEM_FOR['room-set']('studio-lights'),
    { id: 'room-set-studio-lights', game: 'profile', type: 'room-set', consumable: false, meta: { category: 'studio-lights' } });
  check('a skull skin keeps the bare id the game equips by', ITEM_FOR['skull-skin']('blood'),
    { id: 'blood', game: 'skull-clicker', type: 'skull-skin', consumable: false });
  check('a click effect likewise', ITEM_FOR['click-effect']('ember').id, 'ember');
  check('a dice set keeps the bare id the game equips by', ITEM_FOR.dice('phyrexian'),
    { id: 'phyrexian', game: 'mana-clash', type: 'dice', consumable: false });
  /* Pinned so a type cannot be added here without someone deciding it
     belongs -- this table is what a repair run acts on. */
  check('five types and no more', Object.keys(ITEM_FOR).sort(),
    ['click-effect', 'dice', 'room-piece', 'room-set', 'skull-skin']);
}

/* ── …matches what a correct grant would have made ───────────────────── */
{
  const src = fs.readFileSync(path.join(REPO, 'functions/api/phamily-time.js'), 'utf8');
  /* The id each mapper builds, as written in the route module. */
  const idShapes = {
    'skull-skin': 'id: cosmeticId',
    'click-effect': 'id: cosmeticId',
    'room-set': 'id: `room-set-${cosmeticId}`',
    'room-piece': 'id: `room-piece-${cosmeticId}`',
  };
  for (const [type, shape] of Object.entries(idShapes)) {
    ok(`the ${type} mapper still builds its id as ${shape}`, src.includes(shape));
  }
  ok('the room-piece mapper still stores meta.piece', /meta:\s*\{\s*piece:\s*cosmeticId\s*\}/.test(src));
  ok('the room-set mapper still stores meta.category', /meta:\s*\{\s*category:\s*cosmeticId\s*\}/.test(src));
}

/* ── What it will delete ─────────────────────────────────────────────── */
{
  /* THE WRECKAGE. Both shapes, as JSON.stringify leaves them. */
  ok('a room piece granted with no cosmeticId',
    isBroken({ id: 'room-piece-undefined', type: 'room-piece', meta: {} }));
  ok('a room set likewise', isBroken({ id: 'room-set-undefined', type: 'room-set', meta: {} }));
  ok('a room piece with an id but no meta', isBroken({ id: 'room-piece-x', type: 'room-piece' }));
  ok('a skull skin that lost its id entirely', isBroken({ type: 'skull-skin', name: 'Skull Skin' }));
  ok('and a click effect', isBroken({ type: 'click-effect', rarity: 'rare' }));

  /* THE ONES IT MUST NOT TOUCH. A false positive deletes somebody's
     property, so this half matters more than the half above. */
  ok('a real room piece survives',
    !isBroken({ id: 'room-piece-snacks-r1c1', type: 'room-piece', meta: { piece: 'snacks-r1c1' } }));
  ok('a real room set survives',
    !isBroken({ id: 'room-set-neon', type: 'room-set', meta: { category: 'neon' } }));
  ok('a real skull skin survives', !isBroken({ id: 'blood', type: 'skull-skin' }));
  ok('a room slot is not one of the four types, so it is never touched',
    !isBroken({ id: 'room-slot-2', type: 'room-slot' }));
  ok('nor is a badge', !isBroken({ id: 'ms_60_badge_2026-09', type: 'badge' }));
  ok('nor a title with no meta', !isBroken({ id: 'title-guardian', type: 'title' }));
  ok('nor an egg', !isBroken({ id: 'egg_123', type: 'egg', quantity: 2 }));
  ok('nor a badge that happens to lack an id', !isBroken({ type: 'badge', name: 'Odd' }));
  ok('null is not an item', !isBroken(null));
  ok('undefined is not an item', !isBroken(undefined));

  /* A room-slot named 'undefined' would be wreckage too, but slots are
     granted only from milestones, whose call site always passed the id.
     The pattern covers it in case that ever changes — but only when the
     type is one of the four, which room-slot is not. */
  ok('the undefined pattern does not reach a type it does not own',
    !isBroken({ id: 'room-slot-undefined', type: 'room-slot' }));
}

/* ── Every repairable reward names something real ────────────────────── */
{
  const all = [...FOLLOWER_REWARDS, ...PHAMILY_REWARDS];
  const repairable = all.filter(r => ITEM_FOR[r.type]);
  ok('the pass has rewards this script would repair', repairable.length > 0);
  const noId = repairable.filter(r => !r.cosmeticId);
  check('and every one of them carries a cosmeticId', noId.map(r => `${r.level}:${r.type}`), []);
  /* Within ONE track the ids must be unique, or the repair would grant a
     single item where two rewards were claimed. Across the two tracks the
     same id is deliberate — a follower and a subscriber unlock the same
     piece at different levels, and grantItem's dedupe means whoever
     somehow earned both gets it once. */
  for (const [name, list] of [['follower', FOLLOWER_REWARDS], ['sub', PHAMILY_REWARDS]]) {
    /* Keyed on type AND id: 'void' names both a skull skin and a click
       effect, which is legitimate — the games namespace cosmetic ids per
       type — and grantItem identifies an item the same way. */
    const keys = list.filter(r => ITEM_FOR[r.type]).map(r => {
      const it = ITEM_FOR[r.type](r.cosmeticId);
      return `${it.type}\u0000${it.id}`;
    });
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    check(`${name}: no two rewards build the same item`, [...new Set(dupes)], []);
  }
  /* And the two tracks really do overlap, which is what the dedupe is
     there for — if they ever stopped, the comment above is stale. */
  const key = (r) => { const it = ITEM_FOR[r.type](r.cosmeticId); return `${it.type}\u0000${it.id}`; };
  const fIds = new Set(FOLLOWER_REWARDS.filter(r => ITEM_FOR[r.type]).map(key));
  const shared = PHAMILY_REWARDS.filter(r => ITEM_FOR[r.type]).filter(r => fIds.has(key(r)));
  ok('the tracks share unlocks, which grantItem dedupes', shared.length > 0);

  /* The collision that made this necessary, kept as a live example: if
     the table ever stops sharing an id across two types, the dedupe key
     could go back to being the id alone — and this says so. */
  const byId = {};
  for (const r of [...FOLLOWER_REWARDS, ...PHAMILY_REWARDS].filter(r => ITEM_FOR[r.type])) {
    const it = ITEM_FOR[r.type](r.cosmeticId);
    (byId[it.id] = byId[it.id] || new Set()).add(it.type);
  }
  const crossType = Object.entries(byId).filter(([, types]) => types.size > 1);
  ok('at least one cosmetic id is shared across two types, so type must be part of identity',
    crossType.length > 0);
}

/* ── A DICE WRECK LOOKS HEALTHY ──────────────────────────────────────
   Every other wreck this script repairs is missing something obvious: no
   id, or `undefined` baked into one. A dice grant has a perfectly good id
   -- the reward key -- under a type nothing has ever read. So it cannot be
   spotted by looking for damage, only by knowing 'dice-pack' was never a
   type the game understood. */
{
  const wreck = { id: 'f95_dice', game: 'mana-clash', type: 'dice-pack', name: 'Bone Dice', consumable: false };
  ok('a dice-pack is recognised as a wreck', isBroken(wreck));
  ok('even though it has a real id', !!wreck.id);

  ok('a repaired dice set is not', !isBroken(ITEM_FOR.dice('bone')));
  /* And the repair keeps the bare set id, because the game equips by it. */
  check('repaired into the id the game equips by', ITEM_FOR.dice('bone').id, 'bone');
  check('under the type the game reads', ITEM_FOR.dice('bone').type, 'dice');
}

/* ── KEYS THAT WERE RENAMED OUT FROM UNDER A CLAIM ───────────────────
   A key is `level_track_type_rarity`, so 667e50b moving the Skull Clicker
   cosmetics off the type 'cosmetic' invalidated every claim made before
   it. Those people paid a level for something the system could no longer
   name, and the repair skipped them.

   THE MAPPING IS ONLY SAFE WHILE IT IS UNAMBIGUOUS. Each old key is
   resolved by finding the one cosmetic reward at that level, track and
   rarity -- so this checks there really is exactly one, rather than taking
   the table's word for it. A second cosmetic arriving at the same slot
   would make the guess a coin flip, and it should be left alone instead. */
{
  const R = await import('../../functions/api/phamily-rewards.js');

  for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
    const target = R.findReward(newKey);
    ok(`${oldKey} points at a reward that exists`, !!target);
    ok(`and resolveClaim follows it`, resolveClaim(oldKey) === R.findReward(newKey));

    /* The old key still carries level, track and rarity; only the type
       moved. Those three must pick out one reward and no more. */
    const [lvl, track, , rarity] = oldKey.split('_');
    const list = track === 'phamily' ? R.PHAMILY_REWARDS : R.FOLLOWER_REWARDS;
    const candidates = list.filter(r => String(r.level) === lvl && r.rarity === rarity
                                     && ['skull-skin', 'click-effect'].includes(r.type));
    check(`${oldKey} still resolves to exactly one reward`, candidates.length, 1);
    check('and it is the one mapped', candidates[0] && candidates[0].type, target && target.type);
  }

  /* A key nobody has renamed must stay unresolved: guessing is how someone
     gets handed a reward they never earned. */
  check('an unknown key is still unknown', resolveClaim('999_phamily_dice_mythic'), null);
  /* And a live key must not be diverted through the table. */
  ok('a current key resolves directly',
     resolveClaim('48_phamily_dice_rare') === R.findReward('48_phamily_dice_rare'));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[repair-cosmetic-grants] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[repair-cosmetic-grants] ${passed} assertions passed.`);
console.log('');
