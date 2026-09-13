#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Add someone to the existing beta-tester compensation codes.

   Usage:
     node server/scripts/add-compensation-recipient.js <twitch-username-or-id>
     node server/scripts/add-compensation-recipient.js <twitch-username-or-id> --confirm

   WHY THIS RATHER THAN MINTING A NEW SET

   The twelve codes already created are account-locked but redeemable ONCE
   PER ACCOUNT. Adding a user to their restrictedTo list gives that person
   the whole package, using the same twelve codes everyone else already has.
   So the owner can point them at the message that was already sent, instead
   of managing a second set of codes that does exactly the same thing.

   A username is resolved to a numeric id via Twitch, because the lock is
   keyed on ids. Names change hands; a list keyed on something renameable
   would hand someone's rewards to whoever claims the name next.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';

function parseArgs() {
  const args = process.argv.slice(2).filter(a => a !== '--confirm');
  const urlArg = process.argv.find(a => a.startsWith('--database-url='));
  return {
    who: args[0],
    confirm: process.argv.includes('--confirm'),
    databaseUrl: urlArg ? urlArg.slice('--database-url='.length) : process.env.DATABASE_URL,
  };
}

/** Resolve a Twitch login to a numeric user id. */
async function resolveUser(login) {
  const id = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) throw new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET missing from server/.env');

  const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
  });
  if (!tokenRes.ok) throw new Error(`Twitch token request failed: ${tokenRes.status}`);
  const { access_token } = await tokenRes.json();

  const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
    headers: { Authorization: `Bearer ${access_token}`, 'Client-Id': id },
  });
  if (!res.ok) throw new Error(`Twitch user lookup failed: ${res.status}`);
  const { data } = await res.json();
  if (!data || !data.length) throw new Error(`No Twitch user called "${login}"`);
  return { userId: data[0].id, login: data[0].login, displayName: data[0].display_name };
}

async function main() {
  const { who, confirm, databaseUrl } = parseArgs();
  if (!who) {
    console.error('usage: node add-compensation-recipient.js <twitch-username-or-id> [--confirm]');
    process.exit(2);
  }
  if (!databaseUrl) {
    console.error('[add] No DATABASE_URL. Set it in server/.env or pass --database-url=');
    process.exit(2);
  }

  let user;
  if (/^\d+$/.test(who)) {
    user = { userId: who, login: '(id given directly)', displayName: '' };
    console.log(`[add] using numeric id ${who} as given — no Twitch lookup`);
  } else {
    user = await resolveUser(who);
    console.log(`[add] ${who} -> ${user.displayName} (id ${user.userId})`);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  console.log(`[add] connected: ${info.db}`);

  if (!/phantomace-tv$/.test(info.db)) {
    console.error(`[add] REFUSING: connected to "${info.db}", expected "phantomace-tv".`);
    process.exit(1);
  }

  const store = createKVStore(pool);

  /* The compensation set is exactly the codes that carry a restrictedTo
     list — no other code on the site is account-locked. Identified by that
     rather than by a hardcoded list of twelve strings, so this keeps working
     if the set is ever regenerated. */
  const rows = await store.listValues({ prefix: 'item_code_' });
  const restricted = rows.filter(r => r.value && Array.isArray(r.value.restrictedTo));

  if (!restricted.length) {
    console.error('[add] Found no account-locked codes. Nothing to do.');
    process.exit(1);
  }

  const already = restricted.filter(r => r.value.restrictedTo.includes(String(user.userId)));
  const toAdd = restricted.filter(r => !r.value.restrictedTo.includes(String(user.userId)));

  console.log('');
  console.log(`[add] ${restricted.length} account-locked code(s) found:`);
  for (const r of restricted) {
    const code = r.name.replace(/^item_code_/, '');
    const has = r.value.restrictedTo.includes(String(user.userId));
    const claimed = (r.value.redeemedBy || []).length;
    console.log(`        ${code}  ${String(r.value.item?.name || '').padEnd(26)}` +
                `${r.value.restrictedTo.length} recipient(s), ${claimed} claimed` +
                `${has ? '   [already included]' : ''}`);
  }
  console.log('');
  console.log(`[add] would add ${user.userId} to ${toAdd.length} code(s)` +
              (already.length ? `, already on ${already.length}` : ''));

  if (!confirm) {
    console.log('[add] DRY RUN — nothing written. Re-run with --confirm.');
    await pool.end().catch(() => {});
    return;
  }

  let changed = 0;
  for (const r of toAdd) {
    /* mutate() rather than read-modify-write: redemptions are live, and a
       plain overwrite here could erase a redeemedBy entry recorded between
       our read and our write — costing someone a reward they had claimed. */
    await store.mutate(r.name, (current) => {
      if (!current || !Array.isArray(current.restrictedTo)) return undefined;
      if (current.restrictedTo.includes(String(user.userId))) return undefined;
      return { ...current, restrictedTo: [...current.restrictedTo, String(user.userId)] };
    });
    changed++;
  }

  console.log('');
  console.log(`[add] added to ${changed} code(s).`);
  console.log('');
  console.log(`${user.displayName || user.userId} can now redeem the SAME twelve codes at`);
  console.log('phantomace.tv/redeem — send them the list that already went to everyone else.');
  console.log('Each code is once per account, so the others are unaffected.');

  await pool.end().catch(() => {});
}

main().catch(err => {
  console.error('[add] FAILED:', err.message);
  process.exit(1);
});
