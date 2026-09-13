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
  // leaderboards (six arrays, max 50 entries each)
  sc_leaderboard:        { table: 'singletons', expiry: 'none' },
  lb_memory_match:       { table: 'singletons', expiry: 'none' },
  lb_bingo:              { table: 'singletons', expiry: 'none' },
  lb_mana_clash:         { table: 'singletons', expiry: 'none' },
  lb_shell_shock:        { table: 'singletons', expiry: 'none' },
  lb_phamily_time:       { table: 'singletons', expiry: 'none' },

  media_index:           { table: 'singletons', expiry: 'none' },
  item_code_queue:       { table: 'singletons', expiry: 'none' },
  bridge_pending_actions:{ table: 'singletons', expiry: 'none' },
  eventsub_subscriptions:{ table: 'singletons', expiry: 'none' },
  giveaway_reward_id:    { table: 'singletons', expiry: 'none' },

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
];
