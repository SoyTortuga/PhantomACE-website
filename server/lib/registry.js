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
  /* Skull Clicker site-wide event (a cursed-skull frenzy), set on a hype
     train or by a moderator. 'none' — the in-value `until` is the real
     expiry, read-filtered by the handler. */
  sc_event:              { table: 'singletons', expiry: 'none' },
  /* Skull Clicker's monthly race — { month, entries }. Rolled over and
     prized by skull-clicker.js; sc_leaderboard beside it stays all-time. */
  sc_season:             { table: 'singletons', expiry: 'none' },
  /* The co-op raid boss — one shared boss the whole site clicks down. */
  sc_raid:               { table: 'singletons', expiry: 'none' },
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
  /* The rarity entry rewards' ids, resolved from Twitch by title and
     cached. Unregistered at first, which 500'd the panel the moment a
     Mythic draw was opened on stream: they are written via a property
     lookup (RARITY_REWARDS[rarity].idKey), a shape the registry scan did
     not read. 'none' like the id above them — an expired cache would just
     re-resolve, but there is nothing gained by it expiring. */
  giveaway_reward_rare_id:   { table: 'singletons', expiry: 'none' },
  giveaway_reward_mythic_id: { table: 'singletons', expiry: 'none' },
  checkin_reward_id:     { table: 'singletons', expiry: 'none' },
  raid_boss_reward_id:   { table: 'singletons', expiry: 'none' },

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

  /* The intervals the channel was live, stamped by the same minute tick, so
     Dino Park's offline egg catch-up can credit the live time a closed
     browser missed without depending on Twitch VOD archiving. 'none': it is
     the record itself, pruned to a rolling window in code (see
     dino-park-catchup.js), not by a TTL. */
  dino_live_log:         { table: 'singletons', expiry: 'none' },

  /* Where each overlay panel sits, as percentages of the canvas — set in
     the overlay editor, read by every OBS source on boot. 'none': a layout
     that expired would snap every panel back to its default corner
     mid-stream with nothing to explain it. */
  overlay_layout:        { table: 'singletons', expiry: 'none' },

  /* Ad breaks: the running break and the cached schedule, one row.

     'none', and the reason is the point of the whole feature. The break is
     stored as an endsAt that readers compare against, never as a flag, so
     there is nothing for a TTL to clean up -- and a TTL that expired the
     row mid-break would UN-suppress drops while ads were still playing,
     which is the exact failure the design avoids. */
  ad_state:              { table: 'singletons', expiry: 'none' },

  /* The chat maze: one document holding the live board, the dot, and the
     running tallies. 'none' -- a maze that expired mid-stream would strand
     the overlay on a board the server no longer knows. */
  maze_current:          { table: 'singletons', expiry: 'none' },

  /* Commander Bingo's live-room pointer, exactly like mtgbbb_current: the
     overlay resolves "the game running now" from here so OBS never needs a
     room code in its URL. A SINGLETON, so it is matched before the `bingo_`
     room family below. 'none' -- a pointer that expired mid-stream would
     blank the overlay while a game was still going. */
  bingo_current:         { table: 'singletons', expiry: 'none' },

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

  /* Which Mana Clash room the overlay is showing, and whether it is on.
     'none' for the same reason as the key above: a pointer that quietly
     expired would switch the panel off mid-stream with nothing to explain
     it. A STALE pointer is harmless by contrast — the room it names is
     gone, so the panel shows nothing and says nothing, which is already the
     switched-off behaviour. */
  overlay_mana_clash:    { table: 'singletons', expiry: 'none' },

  /* Bumped to tell the overlay to reload itself. 'none': if this expired,
     the token would vanish, every open overlay would see a change on its
     next poll and reload in unison — a self-inflicted refresh nobody
     asked for, in the middle of a stream. */
  overlay_reload:        { table: 'singletons', expiry: 'none' },

  /* Rebuilt from three full-table reads, so cached. 'real' expiry: the row
     going away IS the cache expiring, and a stale board is worse than a
     slightly slower one. */
  community_leaderboard_cache: { table: 'singletons', expiry: 'real' },

  /* The Pham Check-In overlay reminder's timer config: { enabled,
     intervalMin, lastFiredAt }. The rig's minute tick reads it and fires the
     silent corner nudge on schedule while live. 'none' — losing it just
     resets the reminder to its default-off state, no lifecycle rides on it. */
  checkin_reminder:      { table: 'singletons', expiry: 'none' },

  /* Overlay audio-alert volume, 0-100, set from the bot control panel and
     applied by the overlay to its alert sounds. 'none' — a lost value just
     falls back to full volume. */
  overlay_alert_volume:  { table: 'singletons', expiry: 'none' },

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
  /* A giveaway winner's prize, keyed by the winner. 'real': the seven-day
     claim window IS the row's business rule — recordPrize sets the TTL and
     the page stops offering the prize when the row is gone. */
  { prefix: 'gwp_',            table: 'giveaway_drop_codes', expiry: 'real' },

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
  /* sub_months_{userId} — how long someone has actually subscribed, learned
     from the badge they wear in chat because no API returns it. 'none': this
     is the only record of it and losing it loses the duration. */
  { prefix: 'sub_months_',     table: 'sub_months',       expiry: 'none' },
  /* Who someone is, publicly: display name, avatar, login. Written at every
     login. 'none' — losing it makes every profile anonymous.
     `loginidx_` is deliberately NOT `profile_login_`, which would sit inside
     the `profile_` family and need longest-prefix care to stay out of it. */
  { prefix: 'profile_',        table: 'profiles',         expiry: 'none' },
  { prefix: 'loginidx_',       table: 'profiles',         expiry: 'none' },
  /* rooms_{userId} — everything one person built in My Room. 'none': it is
     their work. `rooms_` is nobody's prefix — mc_room_ and ps_room_ start
     differently — so it needs no ordering care. */
  { prefix: 'rooms_',          table: 'rooms',            expiry: 'none' },
  { prefix: 'mtgbbb_set_',     table: 'mtgbbb_sets',      expiry: 'none' },
  { prefix: 'mtgbbb_',         table: 'mtgbbb_rooms',     expiry: 'real' },

  { prefix: 'cp_skull_boost_', table: 'cp_skull_boosts',  expiry: 'none' },

  /* Skull Clicker's cross-device save, one row per logged-in player. Its
     own table (008_skull_saves.sql) rather than co-located, and read by
     exact key only. 'none': a save must not expire out from under someone
     who took a season off. */
  { prefix: 'sc_save_',        table: 'skull_saves',      expiry: 'none' },
  { prefix: 'pt_alltime_',     table: 'phamily_alltime',  expiry: 'none' },
  { prefix: 'dino_park_',      table: 'dino_parks',       expiry: 'none' },
  /* Who has opted into letting other players visit their park. Its own
     row per player, in the same table as the saves, so the listing is a
     cheap prefix scan and nobody's consent lives inside a document the
     client rewrites wholesale. Only the owner can write their own row.
     'none': a consent record that quietly expired would re-hide a park
     with nothing to explain it. */
  { prefix: 'parkpub_',        table: 'dino_parks',       expiry: 'none' },
  /* Studio-made park backgrounds: a 32x32 tilemap plus its derived
     walkability mask, one row per background. DATA, not a deploy -- saving
     in the studio is the whole release. 'none': a background that expired
     would strand every park that selected it back onto the default with
     nothing to say why. */
  { prefix: 'park_bg_',        table: 'dino_parks',       expiry: 'none' },


  /* A raider's pending raid-boss reward code, per account, claimed in-game.
     'real': it carries a TTL matching the code's redemption window, so an
     unclaimed one clears itself. Matched after the sc_raid singleton. */
  { prefix: 'sc_raid_reward_',  table: 'singletons',       expiry: 'real' },
  /* Lifetime count of "Summon Raid Boss" redemptions that actually spawned
     a boss, per account -- what the Undead Executioner badge ladder reads.
     'none': this is the only record of it, and it must never reset. */
  { prefix: 'raid_redeem_count_', table: 'singletons',     expiry: 'none' },

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
