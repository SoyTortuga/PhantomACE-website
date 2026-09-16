-- ══════════════════════════════════════════════
-- 007 — My Room
--
-- Apply AFTER 006_forum.sql:
--   node server/scripts/apply-sql.js server/sql/007_rooms.sql --service phantomace-web
--   node server/scripts/apply-sql.js server/sql/007_rooms.sql --service phantomace-web --confirm
--
-- Idempotent. Re-running it changes nothing.
--
-- rooms_{userId} — everything one person has built: their rooms, and
-- which one their profile shows. One KV document, written whole by its
-- owner through mutate() and read whole by everyone else — the same shape
-- as dino_park_ and inv_, and for the same reason: nobody ever asks a
-- relational question of it. The document is validated against the piece
-- catalog before every write (functions/api/room-catalog.js), so a stored
-- room contains nothing but known images at known positions.
--
-- expires_at stays NULL: a room is somebody's work.
-- ══════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS rooms (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
