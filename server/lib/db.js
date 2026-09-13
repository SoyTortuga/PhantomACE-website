/* ══════════════════════════════════════════════
   Postgres connection pool.

   The retry-on-boot matters more than it looks: once this runs as a Windows
   service it starts alongside postgresql-x64-18, and services don't wait for
   each other's readiness. NSSM gets a DependOnService entry too, but that
   only orders the *start*, not the moment Postgres is actually accepting
   connections — so exiting on first failure would leave the site down after
   every reboot until someone noticed.
   ══════════════════════════════════════════════ */

import pg from 'pg';

const { Pool } = pg;

let pool = null;

export function createPool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({
    connectionString,
    max: 10,
    application_name: 'phantomace-web',
    idle_timeout_millis: 30_000,
  });
  pool.on('error', (err) => {
    // An idle client erroring must not take the process down.
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

export function getPool() {
  if (!pool) throw new Error('createPool() has not been called');
  return pool;
}

/** Wait for Postgres to actually accept a connection. */
export async function waitForDatabase({ attempts = 30, delayMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await pool.query('SELECT current_database() AS db, version() AS v');
      return r.rows[0];
    } catch (err) {
      if (i === attempts) throw err;
      console.warn(`[db] not ready (${err.code || err.message}), retry ${i}/${attempts}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

/** Run fn inside a transaction, rolling back on throw. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}
