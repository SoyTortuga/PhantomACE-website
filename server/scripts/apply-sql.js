#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Apply a .sql file to the database.

   Exists because psql is not on PATH on the rig — Postgres ships it under
   "C:\Program Files\PostgreSQL\<v>\bin", which turns every schema change
   into a hunt for the right path, with the connection string typed onto a
   command line to get there. The server already has `pg` and already knows
   how to find the production URL; this uses both.

   Wrapped in a TRANSACTION. Postgres does DDL transactionally, so a file
   that fails halfway leaves nothing behind rather than half a schema that
   the next run then trips over.

   Usage:
     node server/scripts/apply-sql.js server/sql/002_checkins.sql --service phantomace-web
     node server/scripts/apply-sql.js server/sql/002_checkins.sql --service phantomace-web --confirm

   Dry run unless --confirm: it connects, reports the database, and prints
   what it would run.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}

async function main() {
  /* First non-flag argument is the file. */
  const file = process.argv.slice(2).find(a => !a.startsWith('--') &&
    !process.argv.some((p, i) => p.startsWith('--') && process.argv[i + 1] === a));

  if (!file) {
    console.error('[sql] Usage: node server/scripts/apply-sql.js <file.sql> --service phantomace-web [--confirm]');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`[sql] No such file: ${file}`);
    process.exit(2);
  }

  const sql = fs.readFileSync(file, 'utf8');
  const service = arg('service');
  const confirm = arg('confirm') === true;
  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });

  if (!databaseUrl) {
    console.error('[sql] No DATABASE_URL. Use --service phantomace-web.');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  console.log(`Database: ${info.db}`);
  console.log(`File:     ${file}  (${sql.split('\n').length} lines)`);

  /* Statement count is a sanity signal, not a parser — a file that reads as
     one statement when you expected six is worth noticing before it runs. */
  const statements = sql.split(';').map(s => s.trim()).filter(s => s && !s.startsWith('--')).length;
  console.log(`Statements: ~${statements}`);
  console.log('');

  if (!confirm) {
    console.log(sql.split('\n').filter(l => l.trim() && !l.trim().startsWith('--')).join('\n'));
    console.log('');
    console.log('DRY RUN — nothing applied. Re-run with --confirm.');
    await pool.end().catch(() => {});
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Applied successfully.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    console.error(`[sql] FAILED, rolled back: ${err.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main().catch(err => {
  console.error('[sql] FAILED:', err.message);
  process.exit(1);
});
