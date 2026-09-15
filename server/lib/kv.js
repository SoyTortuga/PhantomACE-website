/* ══════════════════════════════════════════════
   Cloudflare KV's interface, backed by Postgres.

   index.js injects the object this returns as `env.MARKETPLACE`, so all 183
   existing storage call sites across functions/ keep working unchanged. That
   is the whole point: the migration's irreducible change is the storage
   engine, and rewriting call sites at the same time would double the blast
   radius for no benefit.

   THREE BEHAVIOURS THAT MUST MATCH KV EXACTLY — getting any of them wrong
   breaks several files at once:

   1. get(key) with no type returns a STRING; get(key, 'json') returns a
      parsed object. All five bingo files do a raw get() then JSON.parse()
      themselves, and twitch_bot_user_id is read raw. A DAL that always
      returned objects would break all of them. (gc_ptr_* used to be a
      third case; Phase 7 replaced that cursor with the giveaway_codes
      table, so nothing reads it any more.)

   2. list() returns { keys: [{ name }], list_complete: true } — every call
      site iterates `result.keys` and reads `key.name`.

   3. A missing OR expired key reads as null, never as a stale value. The
      read-time filter below is what guarantees that; the reaper is only
      reclaiming disk, so correctness never depends on it having run.

   STRING vs JSON STORAGE. KV stores opaque strings; jsonb needs valid JSON.
   Most values here are JSON.stringify'd objects, but several are raw strings
   that are NOT valid JSON (refresh tokens, user ids, integer cursors,
   timestamp flags). Those are stored as JSON string primitives and unwrapped
   on the way out, so a raw get() returns the original text. This relies on
   nothing in the codebase storing a bare JSON string it intends to
   JSON.parse() back — verified true across all 72 put() sites.
   ══════════════════════════════════════════════ */

import { resolveKey, TABLES_WITH_REAL_EXPIRY } from './registry.js';
import { toStorable, toRawString } from './value.js';

/** Minimum expirationTtl KV itself enforced. Postgres has no such floor, so
    send-chat.js's Math.max(seconds, 60) workaround is now redundant — but
    honouring the value as given is still correct. */
function ttlToExpiresAt(ttlSeconds) {
  if (!ttlSeconds || !Number.isFinite(ttlSeconds)) return null;
  return new Date(Date.now() + ttlSeconds * 1000);
}

const NOT_EXPIRED = '(expires_at IS NULL OR expires_at > now())';

/* Giveaway code pools, kept stocked automatically.

   `low` is the point at which a top-up is triggered and is deliberately well
   above the largest SINGLE drop for that tier — a level-5 hype train pulls
   four commons at once, so a threshold of four would let a pool empty mid-drop
   and hand out a partial batch. Refills go back up to `target`. */
const GIVEAWAY_POOL = {
  common:   { target: 100, low: 20 },   // 4 per level-5 drop
  uncommon: { target: 50,  low: 15 },   // 3 per level-10 drop
  rare:     { target: 20,  low: 10 },   // 2 per level-15 drop
  mythic:   { target: 5,   low: 5 },    // 1 per level-20 drop; refills after one
};

/* Ambiguous characters are omitted — no 0/O, no 1/I/L. Viewers read these off
   a fast-moving chat and type them into a box under time pressure, so a code
   that can be misread costs someone their entry. 8 characters of a 31-symbol
   alphabet is roughly 40 bits, and the UNIQUE(tier, code) constraint plus
   ON CONFLICT DO NOTHING absorbs a collision rather than failing a refill. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function mintGiveawayCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function createKVStore(pool) {
  function mustResolve(key, op) {
    const target = resolveKey(key);
    if (!target) {
      throw new Error(
        `KV key "${key}" has no table mapping (during ${op}). ` +
        'Add it to lib/registry.js — refusing to guess, because guessing ' +
        'would write it somewhere it can never be read back from.'
      );
    }
    return target;
  }

  async function get(key, type) {
    const { table } = mustResolve(key, 'get');
    const { rows } = await pool.query(
      `SELECT value FROM ${table} WHERE key = $1 AND ${NOT_EXPIRED}`, [key]
    );
    if (!rows.length) return null;
    const v = rows[0].value;
    return type === 'json' ? v : toRawString(v);
  }

  async function put(key, value, options = {}) {
    const { table, expiry } = mustResolve(key, 'put');
    // Expiry policy comes from the registry, not the caller: that is how the
    // deliberate divergences (dropping the 60-day watch-time TTL and the
    // 30-day earnings TTL) take effect without editing any handler.
    const expiresAt = expiry === 'real' ? ttlToExpiresAt(options.expirationTtl) : null;
    await pool.query(
      `INSERT INTO ${table} (key, value, expires_at, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()`,
      [key, JSON.stringify(toStorable(value)), expiresAt]
    );
  }

  async function del(key) {
    const { table } = mustResolve(key, 'delete');
    await pool.query(`DELETE FROM ${table} WHERE key = $1`, [key]);
  }

  async function list(options = {}) {
    const prefix = options.prefix || '';
    const target = resolveKey(prefix) || resolveKey(prefix + 'x');
    if (!target) throw new Error(`KV list() prefix "${prefix}" has no table mapping`);
    const { rows } = await pool.query(
      `SELECT key FROM ${target.table}
        WHERE key LIKE $1 || '%' AND ${NOT_EXPIRED}
        ORDER BY key`, [prefix]
    );
    // KV's shape, including list_complete — no call site paginates, and with
    // one table per family there is no 1000-key cap to paginate around.
    return { keys: rows.map(r => ({ name: r.key })), list_complete: true, cursor: undefined };
  }

  /* ── Extensions beyond KV's interface ──────────────────────────────── */

  /**
   * Read-modify-write under a lock, replacing KV's unsynchronised
   * get-then-put. Uses an advisory lock rather than SELECT ... FOR UPDATE
   * because FOR UPDATE locks nothing when the row doesn't exist yet, and
   * most of these are upserts.
   *
   * @param {string} key
   * @param {(current: any) => any} mutator receives parsed value (or null)
   * @param {{expirationTtl?: number}} [options] slides the expiry forward,
   *        exactly as put() does. Ignored for group-(b) families, also
   *        exactly as put() ignores it.
   */
  async function mutate(key, mutator, options = {}) {
    const { table, expiry } = mustResolve(key, 'mutate');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const { rows } = await client.query(
        `SELECT value, expires_at FROM ${table} WHERE key = $1 AND ${NOT_EXPIRED}`, [key]
      );
      const current = rows.length ? rows[0].value : null;
      const next = await mutator(current);
      if (next === undefined) {          // mutator opted out
        await client.query('COMMIT');
        return current;
      }
      /* Without a passed TTL, keep whatever the row already carried. With
         one, slide it forward — room handlers re-write on every poll and
         rely on that to stay alive, so freezing the expiry at creation
         would make a long game vanish mid-play. */
      const slide = expiry === 'real' && !!options.expirationTtl;
      const expiresAt = slide
        ? ttlToExpiresAt(options.expirationTtl)
        : (expiry === 'real' && rows.length ? rows[0].expires_at : null);

      /* Only a caller that passed a TTL may touch the expiry column. Every
         existing caller passes none and must keep whatever the row carries —
         writing EXCLUDED.expires_at unconditionally would set NULL on
         giveaway_entrants and friends, quietly making TTL'd rows permanent. */
      const expiryClause = slide ? 'expires_at = EXCLUDED.expires_at,' : '';
      await client.query(
        `INSERT INTO ${table} (key, value, expires_at, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               ${expiryClause}
               updated_at = now()`,
        [key, JSON.stringify(next), expiresAt]
      );
      await client.query('COMMIT');
      return next;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * One query instead of list()-then-N-gets. game-activity.js does that
   * N+1 across three prefixes on every poll from every open game page;
   * mana-clash.js and pham-shock.js do the same for their room browsers.
   */
  async function listValues(options = {}) {
    const prefix = options.prefix || '';
    const target = resolveKey(prefix) || resolveKey(prefix + 'x');
    if (!target) throw new Error(`listValues() prefix "${prefix}" has no table mapping`);
    const { rows } = await pool.query(
      `SELECT key, value FROM ${target.table}
        WHERE key LIKE $1 || '%' AND ${NOT_EXPIRED}
        ORDER BY key`, [prefix]
    );
    return rows.map(r => ({ name: r.key, value: r.value }));
  }

  /**
   * Atomically remove a row and return what it held. Exactly one concurrent
   * caller receives the value; every other gets null.
   *
   * This is the fix for the marketplace double-sell. On KV, `buy` had to
   * read the listing, check it, then delete it — three separate operations
   * with no way to make them one. Two buyers clicking at the same moment
   * both read the same listing, both passed the check, and both were told
   * they had bought it: one dino delivered twice, the seller credited
   * twice. A single DELETE ... RETURNING makes the read and the claim the
   * same operation, so the race cannot be expressed.
   */
  async function claim(key) {
    const { table } = mustResolve(key, 'claim');
    const { rows } = await pool.query(
      `DELETE FROM ${table} WHERE key = $1 AND ${NOT_EXPIRED} RETURNING value`,
      [key]
    );
    return rows.length ? rows[0].value : null;
  }

  /**
   * Run `fn` inside one transaction, holding a named advisory lock for its
   * duration. `fn` receives a store with the same get/put/delete/list/
   * listValues methods, bound to that transaction.
   *
   * For invariants that span MULTIPLE keys, where mutate()'s single-key
   * lock is not enough — the marketplace's "at most 10 active listings per
   * seller" is one: the count and the insert have to be atomic with respect
   * to each other, and they touch different rows.
   *
   * The lock name is arbitrary text, not a key, so it does not need a table
   * mapping. Keep names namespaced (e.g. "listings:<userId>") so unrelated
   * call sites cannot collide on a hash.
   */
  async function withLock(lockName, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(lockName)]);

      const tx = {
        async get(key, type) {
          const { table } = mustResolve(key, 'get');
          const { rows } = await client.query(
            `SELECT value FROM ${table} WHERE key = $1 AND ${NOT_EXPIRED}`, [key]
          );
          if (!rows.length) return null;
          return type === 'json' ? rows[0].value : toRawString(rows[0].value);
        },
        async put(key, value, options = {}) {
          const { table, expiry } = mustResolve(key, 'put');
          const expiresAt = expiry === 'real' ? ttlToExpiresAt(options.expirationTtl) : null;
          await client.query(
            `INSERT INTO ${table} (key, value, expires_at, updated_at)
             VALUES ($1, $2::jsonb, $3, now())
             ON CONFLICT (key) DO UPDATE
               SET value = EXCLUDED.value,
                   expires_at = EXCLUDED.expires_at,
                   updated_at = now()`,
            [key, JSON.stringify(toStorable(value)), expiresAt]
          );
        },
        async delete(key) {
          const { table } = mustResolve(key, 'delete');
          await client.query(`DELETE FROM ${table} WHERE key = $1`, [key]);
        },
        async listValues(options = {}) {
          const prefix = options.prefix || '';
          const target = resolveKey(prefix) || resolveKey(prefix + 'x');
          if (!target) throw new Error(`listValues() prefix "${prefix}" has no table mapping`);
          const { rows } = await client.query(
            `SELECT key, value FROM ${target.table}
              WHERE key LIKE $1 || '%' AND ${NOT_EXPIRED}
              ORDER BY key`, [prefix]
          );
          return rows.map(r => ({ name: r.key, value: r.value }));
        },
      };

      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /* ── Two normalised families that are not key/value at all ──────────── */

  /**
   * Claim one unclaimed giveaway code, or null when the tier is exhausted.
   *
   * Replaces the `gc_{tier}` array plus `gc_ptr_{tier}` cursor. That pair
   * was read, incremented and written as three separate operations, so two
   * drops firing at the same moment handed the SAME code to two people and
   * burned one. FOR UPDATE SKIP LOCKED makes that structurally impossible:
   * concurrent claimers skip past each other's locked rows rather than
   * queueing on them or colliding.
   *
   * Zero rows is exactly the old "pool exhausted" case, so callers keep
   * their existing null handling.
   */
  async function claimOneGiveawayCode(tier) {
    const { rows } = await pool.query(
      `UPDATE giveaway_codes SET claimed_at = now()
        WHERE id = (SELECT id FROM giveaway_codes
                     WHERE tier = $1 AND claimed_at IS NULL
                     ORDER BY id LIMIT 1
                     FOR UPDATE SKIP LOCKED)
        RETURNING code`,
      [tier]
    );
    return rows.length ? rows[0].code : null;
  }

  async function pullGiveawayCode(tier) {
    let code = await claimOneGiveawayCode(tier);

    if (!code) {
      /* Pool exhausted. Refill and retry ONCE, synchronously.
         This is the difference between a hype train working and a hype train
         doing nothing whatsoever: hype-train.js returns early when it gets no
         codes, without posting to chat, without a drop record and without a
         log line. An empty pool used to make the entire feature silently
         vanish, and the first anyone would know is a viewer asking why
         nothing dropped. */
      const added = await topUpGiveawayCodes(tier, true);
      if (added) console.log(`[giveaway] ${tier} pool was empty — minted ${added}`);
      code = await claimOneGiveawayCode(tier);
      return code;
    }

    /* Running low: top up WITHOUT blocking the drop. A drop is on a live
       stream and should not wait on housekeeping. */
    topUpGiveawayCodes(tier).catch(err =>
      console.error(`[giveaway] ${tier} top-up failed: ${err.message}`)
    );
    return code;
  }

  /**
   * Keep a tier's pool stocked.
   *
   * @param {string} tier
   * @param {boolean} [force] refill regardless of the low-water mark, used
   *   when the pool has actually run dry.
   * @returns {Promise<number>} how many codes were minted
   */
  async function topUpGiveawayCodes(tier, force = false) {
    const cfg = GIVEAWAY_POOL[tier];
    if (!cfg) return 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      /* Locked per tier so two simultaneous drops cannot both decide the pool
         is low and each mint a full batch. */
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`giveaway_pool:${tier}`]);

      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM giveaway_codes
          WHERE tier = $1 AND claimed_at IS NULL`, [tier]
      );
      const have = rows[0].n;
      if (!force && have >= cfg.low) { await client.query('COMMIT'); return 0; }

      const need = Math.max(0, cfg.target - have);
      if (need === 0) { await client.query('COMMIT'); return 0; }

      const codes = Array.from({ length: need }, () => mintGiveawayCode());
      await client.query(
        `INSERT INTO giveaway_codes (tier, code)
         SELECT $1, unnest($2::text[])
         ON CONFLICT (tier, code) DO NOTHING`,
        [tier, codes]
      );
      await client.query('COMMIT');
      return need;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Current unclaimed count per tier, for the broadcaster's dashboard. */
  async function giveawayPoolLevels() {
    const { rows } = await pool.query(
      `SELECT tier,
              count(*) FILTER (WHERE claimed_at IS NULL)::int AS available,
              count(*)::int AS total
         FROM giveaway_codes GROUP BY tier`
    );
    const out = {};
    for (const t of Object.keys(GIVEAWAY_POOL)) {
      const row = rows.find(r => r.tier === t);
      out[t] = {
        available: row ? row.available : 0,
        total: row ? row.total : 0,
        target: GIVEAWAY_POOL[t].target,
        low: GIVEAWAY_POOL[t].low,
      };
    }
    return out;
  }

  /**
   * Claim the right to run a month's awards. Returns true for exactly one
   * caller per month, ever.
   *
   * Replaces the `monthly_awards_done_{YYYY-MM}` flag, which was checked
   * and then set non-atomically — so two requests on the last day of a
   * month could both pass the check and both hand out prizes.
   */
  async function claimMonthlyAward(month) {
    const { rows } = await pool.query(
      `INSERT INTO monthly_awards (month) VALUES ($1)
       ON CONFLICT (month) DO NOTHING
       RETURNING month`,
      [month]
    );
    return rows.length > 0;
  }

  /** Disk reclamation only — reads are already filtered. */
  async function reap() {
    let removed = 0;
    for (const table of TABLES_WITH_REAL_EXPIRY) {
      const r = await pool.query(
        `DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= now()`
      );
      removed += r.rowCount || 0;
    }
    return removed;
  }

  return {
    get, put, delete: del, list,
    mutate, listValues, claim, withLock,
    pullGiveawayCode, topUpGiveawayCodes, giveawayPoolLevels, claimMonthlyAward,
    reap,
  };
}
