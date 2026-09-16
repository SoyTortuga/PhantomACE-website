-- Public identity: who a user is, so a page can render somebody other than
-- the person viewing it.
--
-- Two key shapes share this table:
--   profile_{userId}   the record — display name, avatar, login, role
--   loginidx_{login}   a lookup returning the user id
--
-- Keyed by user id because Twitch guarantees it stable; indexed by login
-- because that is what a URL carries. The index is verified against the
-- record on read, so a login that has been changed and taken by somebody
-- else resolves to nothing rather than to the wrong person.
--
-- expires_at stays NULL: losing this makes every profile anonymous.

BEGIN;

CREATE TABLE IF NOT EXISTS profiles (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
