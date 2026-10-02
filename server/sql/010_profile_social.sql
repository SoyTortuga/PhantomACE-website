-- Profile social: a member's self-written bio and their links.
--
-- The profiles table is a KV-shim table (key / value / expires_at /
-- updated_at): every handler reaches it through env.MARKETPLACE, which only
-- ever writes the `value` jsonb. So bio and links live INSIDE the profile
-- record's value (profile_{userId}) — that is the one copy the handler reads
-- and writes, and what the directory's single listValues() scan returns.
--
-- These two columns are GENERATED from that value rather than written
-- directly: the shim's INSERT touches only (key, value, expires_at,
-- updated_at), and Postgres derives bio/links automatically on every write.
-- That keeps them honest (never stale against value, nothing to keep in sync)
-- while giving the table a relational, indexable view of the same data for
-- when the directory is promoted to a pushed-down SQL query.
--
-- The loginidx_ rows share this table; their value is a bare JSON string, and
-- value->>'bio' / value->'links' on a non-object are simply NULL, never an
-- error — so the generated columns are safe across every row here.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, so a
-- re-apply on the rig is a no-op.

BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS bio text
  GENERATED ALWAYS AS (value->>'bio') STORED;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS links jsonb
  GENERATED ALWAYS AS (value->'links') STORED;

-- The directory lists members newest-first by join date (and by name). The
-- scan is confined to profile_ rows, so the index is too — loginidx_ rows
-- carry no firstSeen and have no business widening it.
CREATE INDEX IF NOT EXISTS profiles_firstseen_idx
  ON profiles ((value->>'firstSeen'))
  WHERE key LIKE 'profile_%';

CREATE INDEX IF NOT EXISTS profiles_displayname_idx
  ON profiles (lower(value->>'displayName'))
  WHERE key LIKE 'profile_%';

COMMIT;
