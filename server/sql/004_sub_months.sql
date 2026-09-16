-- Cumulative subscriber duration, keyed sub_months_{userId}.
--
-- Twitch's Helix subscriptions endpoint returns a tier and no duration, so
-- the only place cumulative months appear is the badge a subscriber wears in
-- chat. functions/api/bot/commands.js records it as they speak and
-- functions/api/import-badges.js reads it to decide which loyalty badges
-- someone has actually earned.
--
-- expires_at stays NULL: this is the only record of the duration.

BEGIN;

CREATE TABLE IF NOT EXISTS sub_months (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
