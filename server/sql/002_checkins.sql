-- ══════════════════════════════════════════════
-- 002 — per-viewer check-in history
--
-- Applied AFTER 001_schema.sql. Idempotent: re-running it changes nothing,
-- so a partial apply is safe to repeat.
--
-- ci_{userId} — one row per viewer, holding the streams they checked into.
--
-- checkin_current (in singletons) keeps only the broadcast on air and is
-- replaced wholesale when the next one starts. That is right for "who is
-- here now" and useless for "how many streams in a row" — which is the
-- question streak rewards ask, and the reason this table exists.
--
-- expires_at stays NULL. A streak is a record of what somebody did; it does
-- not expire, and an expiring row would silently reset streaks people had
-- earned with no sign of why.
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS checkins (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The leaderboard orders by streak and by total, so both are worth an index
-- rather than pulling every row into JS to sort.
CREATE INDEX IF NOT EXISTS checkins_streak_idx
  ON checkins (((value->>'streak')::int) DESC);

CREATE INDEX IF NOT EXISTS checkins_total_idx
  ON checkins (((value->>'total')::int) DESC);
