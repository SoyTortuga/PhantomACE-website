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

/* ── TIMEOUTS ────────────────────────────────────────────────────────────
   idleTimeoutMillis was spelled idle_timeout_millis, which pg silently
   ignores (it happened to match pg's own 30s default, so nothing changed
   in practice — but the setting was never actually being applied).

   connectionTimeoutMillis bounds BOTH opening a new connection and waiting
   for a free client when all `max` are checked out. Without it a stalled
   Postgres or an exhausted pool makes every request hang forever instead of
   failing fast with a 500 the health check and logs can see.

   statement_timeout is per STATEMENT, not per transaction. That is why it
   is safe for kv.mutate()/withLock(): they hold one client across BEGIN →
   advisory lock → SELECT → (JS mutator) → INSERT → COMMIT, and the time the
   mutator spends in JavaScript is not inside any statement, so a slow but
   legitimate mutator is never cancelled. The one statement that can wait a
   long time is pg_advisory_xact_lock queueing behind another holder of the
   same key — a wait past 30s means that holder is wedged, and failing the
   waiter is better than piling up every client in the pool behind it.
   idle_in_transaction_session_timeout is deliberately NOT set: it WOULD fire
   while a mutator awaits, and roll back a legitimate mutate.

   The statement timeout is opt-in (server/index.js passes it) so one-off
   scripts under server/scripts — migrations, backfills, apply-sql — keep
   running unbounded as before. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

export function createPool(connectionString, options = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const config = {
    connectionString,
    max: 10,
    application_name: 'phantomace-web',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  };
  if (Number.isFinite(options.statementTimeoutMs) && options.statementTimeoutMs > 0) {
    config.statement_timeout = Math.floor(options.statementTimeoutMs);
  }
  pool = new Pool(config);
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
