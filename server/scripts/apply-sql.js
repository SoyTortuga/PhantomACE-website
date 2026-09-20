#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Apply a .sql migration to the site's database.

     node server/scripts/apply-sql.js --service phantomace-web server/sql/008_skull_saves.sql

   Why this exists rather than psql: psql is not on the rig's PATH, and the
   connection string lives in the Windows service's own environment, not the
   interactive shell — so `psql $env:DATABASE_URL` fails twice over. This
   reads the URL the same way every other maintenance script here does
   (resolveDatabaseUrl --service), so the password never touches the shell,
   and runs the file through the pool the app already uses.

     --service phantomace-web   read DATABASE_URL from that service's env
     --database-url <url>       or pass one explicitly (dev)
     --dry-run                  print the file and the target, run nothing

   The whole file is sent as one script, so its own BEGIN/COMMIT frames the
   transaction. Every migration here is written CREATE TABLE IF NOT EXISTS,
   so re-running one is safe.

   NEVER logs the connection string — only the database name.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return (next && !next.startsWith('--')) ? next : true;
}
const has = (name) => process.argv.includes('--' + name);

async function main() {
  /* The file is the first non-flag argument. */
  const file = process.argv.slice(2).find(a => !a.startsWith('--') &&
    a !== arg('service') && a !== arg('database-url'));
  if (!file) {
    console.error('Which file? e.g. node server/scripts/apply-sql.js --service phantomace-web server/sql/008_skull_saves.sql');
    process.exit(1);
  }
  const full = path.resolve(file);
  if (!fs.existsSync(full)) { console.error(`No such file: ${full}`); process.exit(1); }
  const sql = fs.readFileSync(full, 'utf8');

  const databaseUrl = resolveDatabaseUrl({ service: arg('service'), fallback: arg('database-url') });
  if (!databaseUrl) {
    console.error('No DATABASE_URL. Pass --service phantomace-web, or set it in server/.env.');
    process.exit(1);
  }
  const dbName = (databaseUrl.split('/').pop() || '').split('?')[0];

  console.log('');
  console.log(`  file      ${file}`);
  console.log(`  database  ${dbName}`);
  console.log(`  bytes     ${sql.length}`);
  console.log('');

  if (has('dry-run')) {
    console.log('  Dry run — nothing sent. Re-run without --dry-run to apply.');
    console.log('');
    console.log(sql);
    return;
  }

  const pool = createPool(databaseUrl);
  await waitForDatabase();
  await pool.query(sql);            // whole file as one script; its own BEGIN/COMMIT
  await pool.end();

  console.log('  Applied.');
  console.log('');
}

main().catch((err) => {
  console.error('[apply-sql] FAILED:', err.message);
  process.exit(1);
});
