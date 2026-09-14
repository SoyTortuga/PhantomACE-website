/* ══════════════════════════════════════════════
   LIVE DROPS — every code currently claimable, whatever dropped it.

   Public on purpose. These codes are already posted in chat and are
   claimable once per account by anyone, so the site showing them adds no
   exposure — it just means a viewer who was not staring at chat at the exact
   moment can still catch one. That is the whole point of a drop.

   Feeds the giveaway page, the moderator dashboard, and (next) the on-stream
   overlay, so all three agree about what is live rather than each keeping
   its own partial view.
   ══════════════════════════════════════════════ */

export async function onRequestGet(context) {
  const { env } = context;
  const { getLiveDrops } = await import('./giveaway-entries.js');
  const drops = await getLiveDrops(env);

  return new Response(JSON.stringify({ drops, serverNow: Date.now() }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      /* Never cached. A five-minute window cached for even thirty seconds
         means a viewer can be shown a code that has already expired, or miss
         one that just dropped — and a drop nobody sees in time is the exact
         failure this endpoint exists to fix.

         serverNow travels with it so a client with a skewed clock counts
         down against the server's time rather than its own. */
      'Cache-Control': 'no-store',
    },
  });
}
