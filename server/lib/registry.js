/* ══════════════════════════════════════════════
   The single source of truth mapping KV keys -> Postgres tables.

   Imported by BOTH lib/kv.js (runtime) and scripts/load-kv.js (migration).
   If those two ever disagreed, data would be written to one table and read
   from another — silently, and looking exactly like data loss.

   EXPIRY POLICY lives here rather than at the 72 put() call sites. The DAL
   consults `expiry` and ignores any expirationTtl passed by a handler when
   the policy is 'none', which is how the deliberate divergences below take
   effect without editing a single handler.

     'real' — the TTL IS the business rule; the row must stop being visible.
     'none' — the TTL was storage hygiene only; an in-value timestamp
              (value.expiresAt / value.at / value.checkedAt) is the real rule.
   ══════════════════════════════════════════════ */

/* Exact-match keys are resolved BEFORE prefixes. This is what fixes the
   collision item-codes.js currently works around: `item_code_queue` begins
   with the `item_code_` prefix, and on KV the list() loop needed a hardcoded
   skip to avoid treating the queue as a code record. */
export const SINGLETONS = {
  // leaderboards (seven arrays, max 50 entries each)
  sc_leaderboard:        { table: 'singletons', expiry: 'none' },
  lb_memory_match:       { table: 'singletons', expiry: 'none' },
  lb_bingo:              { table: 'singletons', expiry: 'none' },
  lb_mana_clash:         { table: 'singletons', expiry: 'none' },
  lb_mana_clash_wins:    { table: 'singletons', expiry: 'none' },
  lb_shell_shock:        { table: 'singletons', expiry: 'none' },
  lb_phamily_time:       { table: 'singletons', expiry: 'none' },

  media_index:           { table: 'singletons', expiry: 'none' },
  about_content:         { table: 'singletons', expiry: 'none' },
  chat_scramble:         { table: 'singletons', expiry: 'none' },
  item_code_queue:       { table: 'singletons', expiry: 'none' },
  bridge_pending_actions:{ table: 'singletons', expiry: 'none' },
  eventsub_subscriptions:{ table: 'singletons', expiry: 'none' },
  giveaway_reward_id:    { table: 'singletons', expiry: 'none' },
  checkin_reward_id:     { table: 'singletons', expiry: 'none' },

  /* Rotating chat announcements: the list, the interval, and the rotation
     cursor. expiry 'none' — an expired row would silently stop the rotation
     and lose every message the broadcaster had written. */
  announcements:         { table: 'singletons', expiry: 'none' },

  /* Ordered list of recent broadcasts. Streaks need to know what the
     PREVIOUS stream was; without it, a viewer who attended two streams a
     month apart would look consecutive. Written by the server's minute tick
     rather than by a check-in, so a stream nobody checks into still counts
     as a stream and correctly breaks a streak. */
  stream_log:            { table: 'singletons', expiry: 'none' },

  /* Milestone drop config: on/off, the rarity per event, the raid floor. */
  milestone_drops:       { table: 'singletons', expiry: 'none' },

  /* Every code currently claimable, from any drop path. expiry 'none' is
     deliberate: each ENTRY carries its own expiresAt and is pruned on write,
     so no external lifecycle can clear a code that is still good — which is
     precisely the bug this replaced, where ending a hype train wiped codes
     that had minutes left. */
  live_drops:            { table: 'singletons', expiry: 'none' },

  /* On-stream alert feed and the key that guards it. Both 'none': an expired
     key would lock the overlay out mid-stream with no visible cause, and an
     expired event row would reset the sequence and replay old alerts. */
  overlay_events:        { table: 'singletons', expiry: 'none' },
  overlay_key:           { table: 'singletons', expiry: 'none' },

  /* Rebuilt from three full-table reads, so cached. 'real' expiry: the row
     going away IS the cache expiring, and a stale board is worse than a
     slightly slower one. */
  community_leaderboard_cache: { table: 'singletons', expiry: 'real' },

  /* Current broadcast's Pham Check-in list. One row, replaced wholesale when
     a new stream id appears — Twitch already resets the reward's per-stream
     limit on its own, and keeping only the live stream means no scheduled
     cleanup and no new table. The trade is that check-ins are not kept once
     the next stream begins. */
  checkin_current:       { table: 'singletons', expiry: 'none' },

  /* The MTGBBB set dropdown, cached for a day. An EXACT key, deliberately
     NOT `mtgbbb_set_INDEX`: that would sit inside the `mtgbbb_set_` family
     below while holding something else entirely and expiring on a different
     clock, which is the item_code_queue-inside-item_code_ trap. Exact keys
     resolve before any prefix, so this one cannot be mistaken for a set.
     'real' expiry IS the rule here — the row going away is what makes the
     list refetch when a new set is announced. */
  mtgbbb_sets_index:     { table: 'singletons', expiry: 'real' },

  /* The pointer to whichever MTGBBB room is live, so the overlay can find
     its own game instead of the broadcaster editing an OBS URL every
     stream. Set on create, cleared on end. Same exact-key shape as
     checkin_current, and for the same reason: it is a single pointer that
     gets explicitly replaced, not a record with its own lifecycle. */
  mtgbbb_current:        { table: 'singletons', expiry: 'none' },

  /* MTGBBB's season board. NOT a `lb_mtgbbb_<YYYY-MM>` family — that was
     this feature's own plan document guessing at a shape the existing
     system does not use. leaderboards.js keeps ONE rolling board per game
     and wipes it after paying the top 3 on the last day of the month
     (maybeRunMonthlyAwards); there is no per-month key anywhere in that
     system for any game. Registered here as an ordinary exact singleton so
     MTGBBB rides that machinery exactly like commander-bingo's lb_bingo
     does, rather than building a second, disconnected award system. */
  lb_mtgbbb:             { table: 'singletons', expiry: 'none' },

  /* Moderator allowlist. expiry 'none' is load-bearing: if this row expired
     every moderator would silently lose access, and the only symptom would
     be a mod saying "the drop button stopped working". */
  site_moderators:       { table: 'singletons', expiry: 'none' },

  // group (b): value.checkedAt / value.at are the real rules
  twitch_live_cache:     { table: 'singletons', expiry: 'none' },
  bot_cooldown_drop:     { table: 'singletons', expiry: 'none' },
  bot_cooldown_dropitem: { table: 'singletons', expiry: 'none' },
  bot_cooldown_announce: { table: 'singletons', expiry: 'none' },
  bot_action_log:        { table: 'singletons', expiry: 'none' },

  // group (a): these genuinely need to disappear
  giveaway_state:        { table: 'singletons', expiry: 'real' },
  giveaway_entrants:     { table: 'singletons', expiry: 'real' },
  giveaway_winner:       { table: 'singletons', expiry: 'real' },
  hype_train_active:     { table: 'singletons', expiry: 'real' },
  hype_train_site:       { table: 'singletons', expiry: 'real' },
  hype_train_drops:      { table: 'singletons', expiry: 'real' },

  // Live Twitch credentials — separate table so backups can exclude them.
  twitch_bot_token:                 { table: 'oauth_tokens', expiry: 'none' },
  twitch_bot_refresh_token:         { table: 'oauth_tokens', expiry: 'none' },
  twitch_bot_user_id:               { table: 'oauth_tokens', expiry: 'none' },
  twitch_broadcaster_token:         { table: 'oauth_tokens', expiry: 'none' },
  twitch_broadcaster_refresh_token: { table: 'oauth_tokens', expiry: 'none' },
  twitch_app_token:                 { table: 'oauth_tokens', expiry: 'none' },
  twurple_bot_token:                { table: 'oauth_tokens', expiry: 'none' },
};

/* Ordered LONGEST PREFIX FIRST. `pt_alltime_` must be tested before `pt_`,
   or lifetime stats would be filed as monthly records. */
export const FAMILIES = [
  /* Monthly giveaway entry ledger, one row per user per month. Mirrors
     pt_{userId}_{YYYY-MM}, and like that family it must NOT expire: the
     month's totals are what the draw reads, and a hygiene TTL on a record
     the business logic depends on is the bug we already fixed once. */
  { prefix: 'gwe_',            table: 'giveaway_entries', expiry: 'none' },

  /* A code dropped in chat. expiry is 'real' and load-bearing: the read
     filter makes the row invisible once expires_at passes, which IS the
     "claimable for five minutes only" rule. No handler has to check a
     clock — an expired code simply reads as a code that does not exist. */
  { prefix: 'gwc_',            table: 'giveaway_drop_codes', expiry: 'real' },

  /* MTGBBB, and the reason this list is ordered longest prefix first.
     `mtgbbb_set_` MUST be tested before `mtgbbb_`, or every cached Scryfall
     set pool would be filed as a game room — and then expired out from
     under itself, since rooms have a real TTL and a set pool is permanent.
     Two families, two tables, no shared key space.

     mtgbbb_set_{SETCODE} — the pool and treatment table for one set, kept
     forever because a set's contents never change. 'none': an expiring row
     would mean a live game's set data could vanish, and refetching it is
     precisely what must never happen while a box is being opened.

     mtgbbb_{CODE} — a game room. 'real', exactly like bingo_ and mc_room_:
     the TTL IS the rule that ends an abandoned game. */
  { prefix: 'mtgbbb_set_',     table: 'mtgbbb_sets',      expiry: 'none' },
  { prefix: 'mtgbbb_',         table: 'mtgbbb_rooms',     expiry: 'real' },

  { prefix: 'cp_skull_boost_', table: 'cp_skull_boosts',  expiry: 'none' },
  { prefix: 'pt_alltime_',     table: 'phamily_alltime',  expiry: 'none' },
  { prefix: 'dino_park_',      table: 'dino_parks',       expiry: 'none' },
  { prefix: 'item_code_',      table: 'item_codes',       expiry: 'none' },
  { prefix: 'cp_queue_',       table: 'cp_queues',        expiry: 'real' },
  { prefix: 'earnings_',       table: 'earnings',         expiry: 'none' },
  { prefix: 'listing_',        table: 'listings',         expiry: 'real' },
  { prefix: 'mc_room_',        table: 'mc_rooms',         expiry: 'real' },
  { prefix: 'ps_room_',        table: 'ps_rooms',         expiry: 'real' },
  { prefix: 'bingo_',          table: 'bingo_rooms',      expiry: 'real' },
  { prefix: 'inv_',            table: 'inventories',      expiry: 'none' },
  { prefix: 'pt_',             table: 'phamily_months',   expiry: 'none' },

  /* ci_{userId} — a viewer's check-in history, for streaks. Distinct from
     the `checkin_*` singletons, which are exact keys and matched before any
     prefix, so there is no collision between ci_ and checkin_current. */
  { prefix: 'ci_',             table: 'checkins',         expiry: 'none' },

  /* Per-asker cooldown for !entries. Group (a): the TTL IS the rule, so the
     row disappearing is what lets someone ask again. */
  { prefix: 'bot_cooldown_entries_', table: 'cp_queues',  expiry: 'real' },
];

/* Keys the migration handles specially instead of copying into a table.
   Used by scripts/load-kv.js; the DAL never sees them at runtime because
   the code paths that used them are rewritten in Phase 7. */
export const SPECIAL_MIGRATION_KEYS = {
  // gc_{tier} arrays + gc_ptr_{tier} cursors become rows in giveaway_codes
  giveawayPoolPrefix: 'gc_',
  giveawayCursorPrefix: 'gc_ptr_',
  // monthly_awards_done_{YYYY-MM} becomes a row in monthly_awards
  monthlyAwardPrefix: 'monthly_awards_done_',
  // Deliberately DISCARDED: an artefact of KV's eventually-consistent list(),
  // fully replaced by the listings table plus real transactions.
  discard: ['market_index'],
};

/**
 * Resolve a KV key to its table and expiry policy.
 * @returns {{table: string, expiry: 'real'|'none'}|null} null when unmapped
 */
export function resolveKey(key) {
  const exact = SINGLETONS[key];
  if (exact) return exact;
  for (const f of FAMILIES) {
    if (key.startsWith(f.prefix)) return { table: f.table, expiry: f.expiry };
  }
  return null;
}

/** Every table the DAL may touch — used to build the reaper's sweep list. */
export const TABLES_WITH_REAL_EXPIRY = [
  'cp_queues', 'listings', 'bingo_rooms', 'mc_rooms', 'ps_rooms', 'singletons',
  'giveaway_drop_codes', 'mtgbbb_rooms',
];
