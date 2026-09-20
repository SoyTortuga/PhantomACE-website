-- ══════════════════════════════════════════════
-- PhantomACE schema — replaces the Cloudflare KV namespace MARKETPLACE.
--
-- Apply with:
--   psql "postgres://postgres:PASSWORD@localhost:5432/phantomace-tv-dev" -f 001_schema.sql
--
-- DESIGN: this deliberately mirrors the KV key/value shapes rather than
-- normalising them. Every table is (key, value jsonb, expires_at, updated_at)
-- and `key` holds the FULL original KV key verbatim — that is what lets the
-- data-access layer present Cloudflare KV's exact four-method interface, so
-- all 183 existing storage call sites keep working unchanged.
--
-- One table per key-prefix family rather than one giant kv table, because:
--   * a prefix list() becomes a cheap whole-table scan, with no LIKE and no
--     risk of one family's keys matching another's prefix
--   * it removes the hardcoded skip item-codes.js needs today, where
--     `item_code_queue` sits inside the `item_code_` prefix
--   * KV's 1000-key list() cap disappears
--   * expiry policy lives in the table definition instead of at call sites
--
-- EXPIRY comes in two flavours and they are handled differently:
--   (a) the TTL IS the business rule, so the row must disappear — rooms,
--       bingo games, giveaway state, hype train, listings, cp queues.
--       These get expires_at, and correctness comes from the read-time
--       filter in the DAL, never from the reaper having run.
--   (b) the TTL was only storage hygiene and an in-value timestamp is the
--       real rule — skull boosts, bot cooldowns, the live cache, item codes,
--       OAuth tokens. These keep expires_at NULL and need no mechanism.
-- ══════════════════════════════════════════════

BEGIN;

-- ── Per-user data ─────────────────────────────────────────────────────────

-- inv_{userId} — items[] and equips{} (incl. equips.profile.badgeShowcase).
-- Five different files write this; the DAL's kv_mutate() serialises them.
CREATE TABLE IF NOT EXISTS inventories (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- pt_{userId}_{YYYY-MM} — monthly watch time.
-- DIVERGENCE: KV expired these after 60 days. Dropped deliberately. The
-- grace-period logic reads the PREVIOUS month's record during the first
-- week of a month, so a correctness requirement was resting on a hygiene
-- TTL that merely happened to be long enough. Keeping them is free and
-- makes watch-time history queryable.
CREATE TABLE IF NOT EXISTS phamily_months (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- pt_alltime_{userId} — lifetime totals.
CREATE TABLE IF NOT EXISTS phamily_alltime (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- dino_park_{userId} — the whole client game state blob.
CREATE TABLE IF NOT EXISTS dino_parks (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- earnings_{userId} — marketplace proceeds, deleted when claimed.
-- DIVERGENCE: KV expired these after 30 days, whose only real effect was
-- that a seller who didn't log in for a month silently lost their coins.
-- That is a bug wearing a TTL's clothing; dropped.
CREATE TABLE IF NOT EXISTS earnings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- cp_queue_{userId} — pending channel-point redemptions (group (a), 24h).
CREATE TABLE IF NOT EXISTS cp_queues (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- cp_skull_boost_{userId} — group (b): value.expiresAt is the real rule.
CREATE TABLE IF NOT EXISTS cp_skull_boosts (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Marketplace ───────────────────────────────────────────────────────────

-- listing_{uuid} — group (a), 7 days.
-- The generated columns keep the mirror rule intact (the blob is still the
-- value of record) while making the only two queries the code needs
-- indexable. They replace the entire `market_index` document, which existed
-- solely to work around KV's eventually-consistent list() and missing
-- transactions — market_index is NOT migrated.
CREATE TABLE IF NOT EXISTS listings (
  key            text PRIMARY KEY,
  value          jsonb NOT NULL,
  expires_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  seller_user_id text   GENERATED ALWAYS AS (value -> 'seller' ->> 'userId') STORED,
  listed_at      bigint GENERATED ALWAYS AS ((value ->> 'listedAt')::bigint) STORED
);
CREATE INDEX IF NOT EXISTS listings_seller_idx    ON listings (seller_user_id);
CREATE INDEX IF NOT EXISTS listings_listed_at_idx ON listings (listed_at DESC);
CREATE INDEX IF NOT EXISTS listings_expires_idx   ON listings (expires_at) WHERE expires_at IS NOT NULL;

-- ── Codes and rooms ───────────────────────────────────────────────────────

-- item_code_{CODE} — group (b): expiry is value.expiresAt. Rows must PERSIST
-- past that so a used code reports "already redeemed" rather than "invalid".
-- Note `item_code_queue` deliberately does NOT live here: it goes in
-- singletons, which removes the prefix collision item-codes.js works around.
CREATE TABLE IF NOT EXISTS item_codes (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- bingo_{CODE} — group (a), 4h.
CREATE TABLE IF NOT EXISTS bingo_rooms (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bingo_rooms_expires_idx ON bingo_rooms (expires_at) WHERE expires_at IS NOT NULL;

-- mc_room_{CODE} — group (a), 2h.
CREATE TABLE IF NOT EXISTS mc_rooms (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mc_rooms_expires_idx ON mc_rooms (expires_at) WHERE expires_at IS NOT NULL;

-- ps_room_{CODE} — group (a), 2h.
CREATE TABLE IF NOT EXISTS ps_rooms (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ps_rooms_expires_idx ON ps_rooms (expires_at) WHERE expires_at IS NOT NULL;

-- ── Everything single-keyed ───────────────────────────────────────────────

-- One row per singleton document: market/media indexes, the six leaderboard
-- arrays, item_code_queue, giveaway state/entrants/winner, bot_action_log,
-- bot_cooldown_*, hype_train_*, twitch_live_cache, eventsub_subscriptions,
-- giveaway_reward_id, bridge_pending_actions.
-- Mixed expiry: the giveaway_* and hype_train_* rows are group (a) and carry
-- expires_at; the rest are group (b) and leave it NULL.
CREATE TABLE IF NOT EXISTS singletons (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS singletons_expires_idx ON singletons (expires_at) WHERE expires_at IS NOT NULL;

-- SEPARATE FROM singletons ON PURPOSE. These rows hold live Twitch access and
-- refresh tokens that can post as the bot and act as the broadcaster, so a
-- pg_dump of everything else can be taken and shared freely:
--   pg_dump --exclude-table=oauth_tokens ...
-- Covers twitch_bot_token, twitch_bot_refresh_token, twitch_bot_user_id,
-- twitch_broadcaster_token, twitch_broadcaster_refresh_token,
-- twitch_app_token, twurple_bot_token.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Families that are redesigned rather than mirrored ─────────────────────

-- Replaces monthly_awards_done_{YYYY-MM}, which was a raw-string flag that
-- accumulated forever and could not be claimed atomically — KV has no CAS,
-- so two concurrent requests on the last day of a month could both pass the
-- "has it run?" check and both hand out prizes. The claim is now:
--   INSERT INTO monthly_awards (month) VALUES ($1)
--   ON CONFLICT (month) DO NOTHING RETURNING month;
-- Zero rows returned means someone else claimed it.
CREATE TABLE IF NOT EXISTS monthly_awards (
  month  text PRIMARY KEY,          -- 'YYYY-MM'
  ran_at timestamptz NOT NULL DEFAULT now()
);

-- Replaces the gc_{tier} array + gc_ptr_{tier} cursor pair. That design
-- read, incremented and wrote the cursor non-atomically, so two viewers
-- redeeming at the same moment could be handed the SAME code. Claiming is
-- now a single statement:
--   UPDATE giveaway_codes SET claimed_at = now()
--   WHERE id = (SELECT id FROM giveaway_codes
--               WHERE tier = $1 AND claimed_at IS NULL
--               ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
--   RETURNING code;
-- SKIP LOCKED makes double-issuance structurally impossible, and zero rows
-- is exactly the existing "pool exhausted" case. Refilling is an INSERT
-- rather than rewriting an array and resetting a cursor.
CREATE TABLE IF NOT EXISTS giveaway_codes (
  id         bigserial PRIMARY KEY,
  tier       text NOT NULL CHECK (tier IN ('common','uncommon','rare','mythic')),
  code       text NOT NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tier, code)
);
CREATE INDEX IF NOT EXISTS giveaway_codes_unclaimed_idx
  ON giveaway_codes (tier, id) WHERE claimed_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- MONTHLY GIVEAWAY (native — replaces the Gleam embed, which was never
-- configured beyond a placeholder)
-- ══════════════════════════════════════════════════════════════════════════

-- gwe_{userId}_{YYYY-MM} — one row per user per month, holding that user's
-- running entry total and where each entry came from. Deliberately mirrors
-- phamily_months, and like it has NO expiry: the month's totals are what the
-- winner draw reads, so an expiring row would silently delete entries a
-- viewer earned.
CREATE TABLE IF NOT EXISTS giveaway_entries (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The draw reads every row for one month, so index the month rather than
-- scanning and filtering in JS.
CREATE INDEX IF NOT EXISTS giveaway_entries_month_idx
  ON giveaway_entries ((value->>'month'));

-- gwc_{CODE} — a code dropped in chat, claimable once per account by anyone
-- for five minutes.
--
-- expires_at is LOAD-BEARING here, not hygiene. kv.js filters every read by
-- it, so an expired code reads as a code that does not exist — which IS the
-- five-minute rule. No handler compares a clock, and there is no window
-- where a late claim can slip through because someone forgot a check.
CREATE TABLE IF NOT EXISTS giveaway_drop_codes (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- sc_save_{userId} — Skull Clicker cross-device save. See 008_skull_saves.sql
-- for why this exists (the game was localStorage-only; the leaderboard held
-- one number, not a rebuildable save). Login-only.
CREATE TABLE IF NOT EXISTS skull_saves (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Migration safety net ──────────────────────────────────────────────────

-- The loader routes each dumped KV key to a table by longest-matching
-- prefix. Anything it does not recognise lands here instead of being
-- silently dropped, and a non-zero count blocks the cutover. This is the
-- mechanism that catches a key family nobody remembered.
CREATE TABLE IF NOT EXISTS unmapped_kv (
  key        text PRIMARY KEY,
  value      text,
  expiration bigint,
  seen_at    timestamptz NOT NULL DEFAULT now()
);

COMMIT;
