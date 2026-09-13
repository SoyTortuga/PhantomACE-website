#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Seed the beta-tester compensation codes.

   Usage:
     node server/scripts/seed-compensation-codes.js --dry-run
     node server/scripts/seed-compensation-codes.js --confirm
     node server/scripts/seed-compensation-codes.js --confirm --database-url=...

   WHY THESE CODES EXIST
   Eight accounts lost their Dino Park progress: their dino_park_* records
   were present in the production KV namespace on 2026-09-12 and gone on
   2026-09-13, with no TTL on those keys and no code path that deletes them.
   The cause was never established. This is the compensation.

   ACCOUNT-LOCKED. Every code carries restrictedTo, so only those eight
   accounts can redeem it — a leaked code is useless to anyone else. That
   matters here: 171 public giveaway codes were downloadable from the site
   until hours before this was written, and the lesson was cheap to apply.

   Codes are created through the real createItemCode / activateItemCode
   paths rather than by writing records by hand, so they cannot drift from
   whatever the redemption code expects.
   ══════════════════════════════════════════════ */

import 'dotenv/config';
import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { createItemCode, activateItemCode } from '../../functions/api/item-codes.js';

/* The eight accounts whose saves vanished, from the dino_parks table of the
   2026-09-12 rehearsal load. 77379157 is the broadcaster's own account. */
const RECIPIENTS = [
  '38108896',
  '40848342',
  '53418405',
  '77379157',
  '112872140',
  '115385716',
  '132220989',
  '151574789',
];

/* One set of codes serves all eight: a code is redeemable once PER ACCOUNT,
   so twelve codes give each recipient twelve eggs. Twelve codes to
   distribute instead of ninety-six to track. */
const PACKAGE = [
  { count: 2, rarity: 'common',   label: 'Common Dino Egg' },
  { count: 2, rarity: 'uncommon', label: 'Uncommon Dino Egg' },
  { count: 2, rarity: 'rare',     label: 'Rare Dino Egg' },
  { count: 4, rarity: 'mythic',   label: 'Mythic Dino Egg' },
  /* Guaranteed-mutation eggs at MYTHIC species rarity — owner's call, and
     it makes these unambiguously the best two codes in the package: a
     mythic species roll (random epic or legendary) AND a guaranteed
     mutation. Note the hatch time comes with it: epic is 4 hours and
     legendary 8, against 2 for rare. */
  { count: 2, rarity: 'mythic',   label: 'Mythic Mutation Dino Egg', guaranteedMutation: true },
];

/* 30 days. The default activation window is 300 seconds, which is right for
   a live stream drop and useless for compensation — a recipient who is away
   for a week would find every code expired. */
const VALID_FOR_SECONDS = 30 * 24 * 60 * 60;

function parseArgs() {
  const args = process.argv.slice(2);
  const urlArg = args.find(a => a.startsWith('--database-url='));
  return {
    confirm: args.includes('--confirm'),
    databaseUrl: urlArg ? urlArg.slice('--database-url='.length) : process.env.DATABASE_URL,
  };
}

async function main() {
  const { confirm, databaseUrl } = parseArgs();

  const planned = PACKAGE.flatMap(p =>
    Array.from({ length: p.count }, () => p)
  );

  console.log('[seed] compensation package, one set shared by all recipients:');
  for (const p of PACKAGE) {
    const extra = p.guaranteedMutation ? '  (guaranteed mutation)' : '';
    console.log(`         ${p.count} x ${p.label.padEnd(20)} rarity=${p.rarity}${extra}`);
  }
  console.log(`[seed] ${planned.length} codes total, redeemable once per account`);
  console.log(`[seed] restricted to ${RECIPIENTS.length} accounts: ${RECIPIENTS.join(', ')}`);
  console.log(`[seed] valid for ${VALID_FOR_SECONDS / 86400} days from creation`);
  console.log('');

  if (!confirm) {
    console.log('[seed] DRY RUN — nothing written. Re-run with --confirm to create them.');
    return;
  }

  if (!databaseUrl) {
    console.error('[seed] No DATABASE_URL. Set it in server/.env or pass --database-url=');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  console.log(`[seed] connected: ${info.db}`);

  /* Refuse to seed the dev database by accident. These are real rewards for
     real accounts; creating them in phantomace-tv-dev would look like it
     worked and hand out nothing. */
  if (!/phantomace-tv$/.test(info.db)) {
    console.error(`[seed] REFUSING: connected to "${info.db}", expected "phantomace-tv".`);
    console.error('[seed] Pass --database-url explicitly if this is deliberate.');
    process.exit(1);
  }

  const env = { ...process.env, MARKETPLACE: createKVStore(pool) };
  const created = [];

  for (const p of planned) {
    const record = await createItemCode(env, {
      id: p.guaranteedMutation ? 'dino_egg_mutation' : `dino_egg_${p.rarity}`,
      game: 'dino-park',
      type: 'egg',
      name: p.label,
      rarity: p.rarity,
      consumable: true,
      quantity: 1,
      guaranteedMutation: !!p.guaranteedMutation,
    }, { restrictedTo: RECIPIENTS });

    /* Created codes are inactive by design — the drop flow activates them
       for five minutes. Compensation codes have no drop, so activate here. */
    const active = await activateItemCode(env, record.code, VALID_FOR_SECONDS);
    if (!active || !active.active) {
      console.error(`[seed] FAILED to activate ${record.code}; aborting.`);
      process.exit(1);
    }
    created.push({ code: record.code, label: p.label, expiresAt: active.expiresAt });
    console.log(`[seed] ${record.code}  ${p.label}`);
  }

  console.log('');
  console.log('─'.repeat(52));
  console.log('SEND THESE TO THE EIGHT BETA TESTERS');
  console.log('─'.repeat(52));
  for (const c of created) {
    console.log(`  ${c.code}   ${c.label}`);
  }
  console.log('─'.repeat(52));
  console.log(`Expires: ${new Date(created[0].expiresAt).toISOString()}`);
  console.log('');
  console.log('Every code is account-locked to the eight recipients, so these are');
  console.log('safe to post in a group DM — nobody else can redeem them.');
  console.log('');
  console.log('Each recipient redeems all 12 at /redeem. The incubator holds 3 eggs');
  console.log('(+3 per sub tier), so they will redeem across several sessions; a full');
  console.log('incubator returns an error WITHOUT consuming the code.');

  await pool.end().catch(() => {});
}

main().catch(err => {
  console.error('[seed] FAILED:', err.message);
  process.exit(1);
});
