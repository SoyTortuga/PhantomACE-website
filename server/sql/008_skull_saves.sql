-- Skull Clicker cross-device save.
--
--   sc_save_{userId}   the full game state — skulls, upgrades, milestones
--
-- Why this exists: Skull Clicker kept its ENTIRE state in the browser's
-- localStorage and nothing else. The server only ever held sc_leaderboard,
-- a single high-score number per player, so a cleared browser lost every
-- upgrade with no way back — the leaderboard number cannot rebuild a save.
-- This table gives logged-in players the same durable, cross-device save
-- Dino Park has had all along.
--
-- Login-only by nature: a guest's id also lived in localStorage, so a wipe
-- orphans the guest too and there is nothing stable to key their save on.
--
-- Uniform KV shape, like every other table here. Read and written by exact
-- key only (never list()'d), so it carries no indexes beyond the primary.

BEGIN;

CREATE TABLE IF NOT EXISTS skull_saves (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
