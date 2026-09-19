#!/usr/bin/env node
/* ══════════════════════════════════════════════
   REPAIR COSMETIC GRANTS

     node server/scripts/repair-cosmetic-grants.js --service phantomace-web
     node server/scripts/repair-cosmetic-grants.js --service phantomace-web --confirm

   handleClaimReward passed grantReward the reward's id, type, rarity and
   name — but never its cosmeticId, which is the field that says WHICH
   cosmetic was granted. Four reward types read it: skull-skin,
   click-effect, room-set and room-piece. Without it the mapper built an
   item carrying `undefined`, grantItem stored it, and nothing ever
   matched it: the reward was spent, gone from the track, and invisible
   in the game.

   Two shapes of wreckage, because JSON.stringify drops undefined values:

     room-*    id 'room-piece-undefined', and meta with no piece at all
     skull-*   NO id field whatsoever

   The second is the nastier one. grantItem dedupes non-consumables by
   id, and `i.id === item.id` is true for two items that both lack one —
   so the FIRST idless item silently blocked every later skull skin,
   click effect and (since they share the fault) room grant.

   What makes repair possible: the claim is recorded by key in
   pt_{userId}_{YYYY-MM}.claimedRewards, and a key names its reward
   exactly. So this reads what each person claimed, works out what they
   should have been given, drops the broken items and grants the right
   ones.

   Milestone bonuses are NOT touched. That call site always passed
   cosmeticId, and claimedMilestones does not record whether the person
   was a subscriber at the time — which is what decided whether a bonus
   was granted at all. Re-granting from it would hand out rewards nobody
   earned.

   Dry run unless --confirm. SAFE TO RUN TWICE: it only adds items that
   are missing and only removes ones that are provably broken.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';
import { findReward } from '../../functions/api/phamily-rewards.js';
import { piece, categories } from '../../functions/api/room-catalog.js';

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}
const line = (s = '') => console.log(s);

/* The types whose mapper reads cosmeticId, and the item each should have
   become. Kept here rather than imported because phamily-time.js is a
   route module: importing it would run its boot. These MUST match
   REWARD_ITEM_MAP in functions/api/phamily-time.js. */
export const ITEM_FOR = {
  'skull-skin': (id) => ({ id, game: 'skull-clicker', type: 'skull-skin', consumable: false }),
  'click-effect': (id) => ({ id, game: 'skull-clicker', type: 'click-effect', consumable: false }),
  'room-set': (id) => ({ id: `room-set-${id}`, game: 'profile', type: 'room-set', consumable: false, meta: { category: id } }),
  'room-piece': (id) => ({ id: `room-piece-${id}`, game: 'profile', type: 'room-piece', consumable: false, meta: { piece: id } }),
  /* DICE ARRIVED BROKEN A DIFFERENT WAY. The others were granted with
     `undefined` where their id should be; dice were granted with a
     perfectly valid id that named the wrong thing -- the reward key, under
     type 'dice-pack', which nothing has ever read. The wreck therefore
     looks healthy, and isBroken has to know the old type by name. */
  dice: (id) => ({ id, game: 'mana-clash', type: 'dice', consumable: false }),
};

/** The type a wreck of this kind was stored under, where it differs. */
const LEGACY_TYPE = { dice: 'dice-pack' };

/* ── KEYS THAT NO LONGER NAME ANYTHING ────────────────────────────────
   A reward's key is `level_track_type_rarity`, so changing any of those
   four on an existing reward orphans every past claim of it. That has
   happened once: 667e50b moved the Skull Clicker cosmetics off the
   catch-all type 'cosmetic' onto 'skull-skin' and 'click-effect', which
   was the right fix and silently invalidated four keys with it.

   Anyone who claimed one of those before that commit has a spent claim
   naming a reward findReward() cannot resolve, so the repair passed them
   over -- they paid a level and the system can no longer say for what.

   Each maps to exactly one current reward, because nothing else sits at
   that level, track and rarity with a cosmetic type; asserted in
   test-repair-cosmetic-grants.js rather than trusted. An orphan that
   became ambiguous would have to be left alone instead of guessed at. */
export const LEGACY_KEYS = {
  '85_follower_cosmetic_rare':   '85_follower_skull-skin_rare',
  '65_phamily_cosmetic_rare':    '65_phamily_skull-skin_rare',
  '85_phamily_cosmetic_rare':    '85_phamily_click-effect_rare',
  '115_phamily_cosmetic_mythic': '115_phamily_skull-skin_mythic',
};

/** findReward, but it also answers for keys that have since been renamed. */
export function resolveClaim(key) {
  return findReward(key) || (LEGACY_KEYS[key] ? findReward(LEGACY_KEYS[key]) : null);
}

/** Is this stored item one of the wrecks? */
export function isBroken(it) {
  if (!it) return false;
  /* A 'dice-pack' is broken by existing: the type was never read by
     anything, whatever its id says. */
  if (it.type === 'dice-pack') return true;
  if (!ITEM_FOR[it.type]) return false;
  if (it.id === undefined || it.id === null || it.id === '') return true;
  if (/^room-(set|piece|slot)-undefined$/.test(String(it.id))) return true;
  if (it.type === 'room-piece' && !(it.meta && it.meta.piece)) return true;
  if (it.type === 'room-set' && !(it.meta && it.meta.category)) return true;
  return false;
}

/** Does the cosmetic this reward names still exist? */
function stillReal(type, cosmeticId) {
  if (type === 'room-piece') return !!piece(cosmeticId);
  if (type === 'room-set') return !!categories()[cosmeticId];
  return true;                       // skull themes live in the game, not a catalog
}

async function main() {
  const service = arg('service');
  const confirm = arg('confirm') === true;

  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });
  if (!databaseUrl) {
    console.error('[repair] No DATABASE_URL. Use --service phantomace-web.');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  line(`Database: ${info.db}`);
  line('');

  const kv = createKVStore(pool);

  /* What each person claimed, gathered across every month they played. */
  const months = await kv.listValues({ prefix: 'pt_' });
  line(`Phamily Time records: ${months.length}`);
  const claimsByUser = new Map();
  for (const row of months) {
    const m = /^pt_([0-9]+)_\d{4}-\d{2}$/.exec(String(row.name || ''));
    if (!m) continue;
    const keys = (row.value && Array.isArray(row.value.claimedRewards)) ? row.value.claimedRewards : [];
    if (!keys.length) continue;
    const set = claimsByUser.get(m[1]) || new Set();
    for (const k of keys) set.add(String(k));
    claimsByUser.set(m[1], set);
  }
  line(`People with claims: ${claimsByUser.size}`);

  /* What each of those claims should have granted. */
  const owedByUser = new Map();
  let unknownKeys = 0;
  let legacyKeys = 0;
  let goneCosmetics = 0;
  for (const [userId, keys] of claimsByUser) {
    const owed = [];
    for (const key of keys) {
      const reward = resolveClaim(key);
      if (!reward) { unknownKeys++; continue; }
      if (!findReward(key)) legacyKeys++;
      if (!ITEM_FOR[reward.type]) continue;
      if (!reward.cosmeticId) continue;
      if (!stillReal(reward.type, reward.cosmeticId)) { goneCosmetics++; continue; }
      owed.push({ key, reward, item: ITEM_FOR[reward.type](reward.cosmeticId) });
    }
    if (owed.length) owedByUser.set(userId, owed);
  }
  line(`People owed a cosmetic: ${owedByUser.size}`);
  if (legacyKeys) line(`  (${legacyKeys} claimed under a key that has since been renamed — followed)`);
  if (unknownKeys) line(`  (${unknownKeys} claimed keys no longer name a reward — left alone)`);
  if (goneCosmetics) line(`  (${goneCosmetics} name a cosmetic no longer in the catalog — left alone)`);
  line('');

  /* What is actually in each inventory. */
  const plan = [];
  const perType = new Map();
  for (const [userId, owed] of owedByUser) {
    let inv;
    try { inv = await kv.get(`inv_${userId}`, 'json'); } catch { inv = null; }
    const items = inv && Array.isArray(inv.items) ? inv.items : [];
    /* Keyed on type AND id, the way grantItem now identifies an item:
       'void' names both a skull skin and a click effect. */
    const have = new Set(items.filter(i => i && i.id).map(i => `${i.type}\u0000${i.id}`));
    const broken = items.filter(isBroken);
    const missing = owed.filter(o => !have.has(`${o.item.type}\u0000${o.item.id}`));
    if (!broken.length && !missing.length) continue;
    plan.push({ userId, broken: broken.length, missing });
    for (const m of missing) perType.set(m.reward.type, (perType.get(m.reward.type) || 0) + 1);
  }

  const totalMissing = plan.reduce((n, p) => n + p.missing.length, 0);
  const totalBroken = plan.reduce((n, p) => n + p.broken, 0);
  line(`Inventories to repair: ${plan.length}`);
  line(`  broken items to remove: ${totalBroken}`);
  line(`  cosmetics to restore:   ${totalMissing}`);
  if (totalMissing) {
    line('');
    for (const [type, n] of [...perType].sort((a, b) => b[1] - a[1])) {
      line(`    ${type.padEnd(14)} ${String(n).padStart(4)}`);
    }
  }
  line('');

  if (!plan.length) { line('Nothing to do.'); await pool.end(); return; }
  if (!confirm) { line('DRY RUN — nothing written. Re-run with --confirm.'); await pool.end(); return; }

  let removed = 0, added = 0, touched = 0;
  for (const p of plan) {
    /* Re-read inside the lock: a claim landing right now must not be
       erased by a copy of the inventory read seconds ago. */
    await kv.mutate(`inv_${p.userId}`, (inv) => {
      if (!inv || !Array.isArray(inv.items)) return undefined;
      const before = inv.items.length;
      inv.items = inv.items.filter(i => !isBroken(i));
      const gone = before - inv.items.length;
      const have = new Set(inv.items.filter(i => i && i.id).map(i => `${i.type}\u0000${i.id}`));
      let put = 0;
      for (const { reward, item } of p.missing) {
        if (have.has(`${item.type}\u0000${item.id}`)) continue;
        inv.items.push({
          ...item,
          name: reward.name,
          rarity: reward.rarity,
          grantedAt: Date.now(),
          source: 'repair-cosmetic-grants',
        });
        have.add(`${item.type}\u0000${item.id}`);
        put++;
      }
      if (!gone && !put) return undefined;
      removed += gone; added += put; touched++;
      return inv;
    });
  }

  line(`Applied: removed ${removed}, restored ${added}, across ${touched} inventories.`);
  await pool.end();
}

/* Only when run, not when the test imports it for the pure parts. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[repair]', err.message);
    process.exit(1);
  });
}
