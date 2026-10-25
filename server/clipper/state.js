/* ══════════════════════════════════════════════
   WHAT THE BOT HAS ALREADY POSTED.

   A daily run must never repost a clip it handled yesterday, so every success
   is recorded under the one singleton `clipper_posted` (mapped in
   server/lib/registry.js). The record is keyed by clip slug and remembers
   where it went, so a re-run is idempotent and a human can see the trail.

   Shape: { posted: { [slug]: record }, order: [slug, ...] }
     record = { at, route, title, youtube: {id|error}|null, tiktok: {id|error}|null }

   `order` caps the ledger (newest first) so it cannot grow without bound on a
   channel that clips forever. A slug that falls off the end could in theory be
   reposted months later — acceptable, and far better than an unbounded value.
   ══════════════════════════════════════════════ */

const KEY = 'clipper_posted';
const MAX = 2000;

function empty() { return { posted: {}, order: [] }; }

async function read(kv) {
  const cur = await kv.get(KEY, 'json');
  if (cur && typeof cur === 'object' && cur.posted) return cur;
  return empty();
}

/** Has this clip already been posted (successfully, to at least one place)? */
export async function wasPosted(kv, slug) {
  const state = await read(kv);
  return Boolean(state.posted[slug]);
}

/**
 * Record a posted clip. Uses mutate() so two runs (or a manual run beside the
 * scheduled one) cannot clobber each other's ledger.
 */
export async function recordPosted(kv, slug, record) {
  await kv.mutate(KEY, (current) => {
    const state = current && current.posted ? current : empty();
    const existed = Boolean(state.posted[slug]);
    state.posted[slug] = { at: Date.now(), ...record };
    if (!existed) state.order.unshift(slug);
    while (state.order.length > MAX) {
      const dropped = state.order.pop();
      if (dropped && dropped !== slug) delete state.posted[dropped];
    }
    return state;
  });
}

/** Everything the bot has posted, newest first — for a status read. */
export async function listPosted(kv) {
  const state = await read(kv);
  return state.order.map(slug => ({ slug, ...state.posted[slug] }));
}
