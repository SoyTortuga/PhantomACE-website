#!/usr/bin/env node
/* ══════════════════════════════════════════
   Seed giveaway codes into Cloudflare KV

   Usage:
     cd "PhantomACE Website"
     node _private/seed-giveaway-codes.js

   Requires wrangler to be configured with
   the MARKETPLACE KV namespace binding.
   ══════════════════════════════════════════ */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CODE_DIR = path.join(__dirname, 'giveaway-codes');
const TIERS = ['common', 'uncommon', 'rare', 'mythic'];

function loadCodes(tier) {
  const file = path.join(CODE_DIR, `${tier}_bonus_codes.txt`);
  const raw = fs.readFileSync(file, 'utf-8');
  return raw.trim().split('\n').filter(Boolean);
}

async function seed() {
  console.log('Seeding giveaway codes into KV...\n');

  for (const tier of TIERS) {
    const codes = loadCodes(tier);
    console.log(`${tier}: ${codes.length} codes`);

    const kvKey = `gc_${tier}`;
    const value = JSON.stringify(codes);

    const tmpFile = path.join(__dirname, `_tmp_${tier}.json`);
    fs.writeFileSync(tmpFile, value);

    try {
      execSync(
        `npx wrangler kv:key put --binding=MARKETPLACE "${kvKey}" --path="${tmpFile}"`,
        { stdio: 'inherit' }
      );
      console.log(`  -> Stored as KV key "${kvKey}"\n`);
    } catch (e) {
      console.error(`  !! Failed to store ${tier} codes. Is wrangler configured?\n`);
    }

    fs.unlinkSync(tmpFile);
  }

  console.log('Done! Codes are ready in KV.');
  console.log('\nKV keys created:');
  TIERS.forEach(t => console.log(`  gc_${t} — code pool`));
  console.log('\nThe backend will also create:');
  TIERS.forEach(t => console.log(`  gc_ptr_${t} — tracks next code index`));
}

seed();
