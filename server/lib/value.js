/* ══════════════════════════════════════════════
   Conversion between KV's opaque strings and Postgres jsonb.

   Shared by lib/kv.js (runtime) and scripts/load-kv.js (migration) for the
   same reason the table registry is shared: if the migration stored values
   one way and the DAL read them another, every affected key would come back
   subtly wrong — and the failure would look like corrupted data rather than
   a conversion bug.

   KV stores opaque strings. Most values here are JSON.stringify'd objects
   and arrays, but several are raw strings that are not valid JSON at all:
     twitch_bot_refresh_token   an opaque token
     twitch_bot_user_id         "115385716"
     gc_ptr_{tier}              "7"          (read back with parseInt)
     monthly_awards_done_*      "1789177801565"
     giveaway_reward_id         a reward uuid
   Those are stored as JSON string primitives and unwrapped on read, so a
   raw get() returns the original text rather than a quoted or retyped value.

   The one assumption: nothing stores a bare JSON string it intends to
   JSON.parse() back (e.g. putting `"\"hello\""` and expecting `"hello"`).
   Verified across all 72 put() call sites — every JSON write is an object
   or an array.
   ══════════════════════════════════════════════ */

/** String a caller passed  ->  value to store as jsonb. */
export function toStorable(value) {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    // Only objects/arrays round-trip unambiguously. Bare primitives are kept
    // as strings so "115385716" doesn't come back as the number 115385716,
    // and so a token like "abc.def" isn't mangled.
    if (parsed && typeof parsed === 'object') return parsed;
    return value;
  } catch {
    return value;              // not JSON at all
  }
}

/** Stored jsonb value  ->  the string KV's get(key) would have returned. */
export function toRawString(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
