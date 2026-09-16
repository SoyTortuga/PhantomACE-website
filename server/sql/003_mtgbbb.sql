-- ══════════════════════════════════════════════
-- 003 — MTGBBB (Magic: The Gathering Booster Box Bingo)
--
-- Apply AFTER 002_checkins.sql:
--   psql "postgres://postgres:PASSWORD@localhost:5432/phantomace-tv-dev" -f 003_mtgbbb.sql
--
-- Idempotent. Re-running it changes nothing, so a partial apply is safe to
-- repeat.
--
-- TWO TABLES, NOT ONE, AND THAT IS THE WHOLE POINT. The key families are
-- `mtgbbb_set_{SETCODE}` and `mtgbbb_{CODE}`, and the first sits inside the
-- second. registry.js orders families longest prefix first so a set pool is
-- never resolved as a room, and these two tables are what that ordering
-- resolves to. One shared table would have reproduced the
-- item_code_queue-inside-item_code_ hack that item-codes.js still needs a
-- hardcoded skip for — and it would have been worse than a skip, because
-- the two families have OPPOSITE expiry policies.
-- ══════════════════════════════════════════════

BEGIN;

-- mtgbbb_set_{SETCODE} — one row per MTG set: the rare/mythic booster pool
-- (25+ card names with images) and the treatment table derived from that
-- set's printings.
--
-- expires_at STAYS NULL, and that is load-bearing. A set's contents never
-- change, so the row is fetched from Scryfall exactly once and then kept
-- forever. It is also the one thing a live game reads that came from
-- outside: if this row could expire, a booster box being opened on camera
-- could find its own card pool missing and the server would have to go back
-- out to a free third-party API mid-stream to rebuild it. That is the
-- failure this whole caching layer exists to make impossible.
CREATE TABLE IF NOT EXISTS mtgbbb_sets (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- mtgbbb_{CODE} — a game room: the frozen set data, the players and their
-- cards, and the pulls so far.
--
-- expires_at IS the business rule, exactly as for bingo_rooms and mc_rooms:
-- an abandoned room has to stop being joinable on its own, and the DAL's
-- read-time filter is what enforces that rather than the reaper having run.
CREATE TABLE IF NOT EXISTS mtgbbb_rooms (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The host panel lists a moderator's own rooms, and the reaper sweeps by
-- expiry. Both are cheap with an index and a whole-table scan without one.
CREATE INDEX IF NOT EXISTS mtgbbb_rooms_host_idx
  ON mtgbbb_rooms ((value->>'host'));

CREATE INDEX IF NOT EXISTS mtgbbb_rooms_expires_idx
  ON mtgbbb_rooms (expires_at) WHERE expires_at IS NOT NULL;

COMMIT;
