/* ══════════════════════════════════════════════
   SOFT READS — degrade, but never in silence.

   A page that shows several things should not go down because one of
   them is unreadable: a profile missing its Dino Park panel is better
   than a profile that 500s. So a lot of reads were written

       env.MARKETPLACE.get(key, 'json').catch(() => null)

   and that half is right. The other half is not. A thrown read and an
   empty one come back identical, so the worst case on this site —
   a key with no mapping in server/lib/registry.js, which THROWS on every
   read — looks exactly like "this player has nothing yet". That is not
   hypothetical: an unregistered key is how the monthly giveaway draw
   broke, and a swallowed error is why it took a while to find.

   softRead keeps the fallback and adds the one thing missing: a line
   saying which key could not be read, and why.

   Library, not a route. Declared in server/router.js NON_ROUTE_MODULES —
   a handler-less file under functions/ that is not declared fails the
   boot, which has taken production down before.
   ══════════════════════════════════════════════ */

/**
 * Await a storage read, falling back to `fallback` and LOGGING on failure.
 *
 *   const inv = await softRead(env.MARKETPLACE.get(`inv_${id}`, 'json'), `inv_${id}`);
 *
 * @param {Promise<any>} promise the read already in flight
 * @param {string} what          the key, for the log line
 * @param {any} [fallback=null]  what the caller gets instead
 */
export function softRead(promise, what, fallback = null) {
  return Promise.resolve(promise).catch((err) => {
    /* console.error, not a throw: the caller chose to degrade, and this is
       only here so the degrading is visible. An unregistered key will log on
       every request, which is correct — it is broken on every request. */
    try {
      console.error(`[storage] could not read ${what}:`, (err && err.message) || err);
    } catch { /* logging must never be the thing that fails */ }
    return fallback;
  });
}
