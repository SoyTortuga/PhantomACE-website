/* ══════════════════════════════════════════════
   MARKETPLACE — Postgres-native (Phase 7 of the self-hosting migration).

   REQUIRES the self-hosted server. env.MARKETPLACE.claim(), .mutate() and
   .withLock() do not exist on a Cloudflare KV binding, so this file CANNOT
   run on Cloudflare Pages. Deploying it there breaks buying outright.

   Four races are closed here, all of which were unfixable on KV because it
   offers no transactions and no compare-and-swap:

     buy          read-check-delete became one DELETE ... RETURNING, so two
                  simultaneous buyers cannot both win. Previously both were
                  told they had bought it: the dino was delivered twice and
                  the seller was paid twice.
     earnings     get-then-put became mutate(), so two sales completing at
                  once cannot lose one another's credit.
     listing cap  count-then-insert now happens under one per-seller lock.
     browse       list()-then-N-gets became one query.
   ══════════════════════════════════════════════ */

const COOKIE_NAME = 'pham_session';
const MAX_ACTIVE_LISTINGS = 10;
const LISTING_TTL_SECONDS = 604800;   // 7 days, unchanged from KV
const EARNINGS_TTL_SECONDS = 2592000; // ignored by the registry (expiry: none)

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'earnings' && session) {
    /* Collecting earnings is a claim, not a read: the balance is handed to
       the player and the record destroyed. Done as get-then-delete, two
       requests arriving together both read the same balance and both paid
       out, minting coins. */
    const data = await env.MARKETPLACE.claim('earnings_' + session.user_id);
    if (data && data.amount > 0) {
      return json({ coins: data.amount, sales: data.sales || [] });
    }
    return json({ coins: 0, sales: [] });
  }

  if (action === 'my-listings' && session) {
    const rows = await env.MARKETPLACE.listValues({ prefix: 'listing_' });
    const mine = rows
      .map(r => r.value)
      .filter(v => v && v.seller && v.seller.userId === session.user_id);
    mine.sort((a, b) => b.listedAt - a.listedAt);
    return json(mine);
  }

  /* One query. This used to be a list() followed by a get() per key, which
     on KV also silently truncated at 1000 keys. */
  const rows = await env.MARKETPLACE.listValues({ prefix: 'listing_' });
  const listings = rows.map(r => r.value).filter(Boolean);
  listings.sort((a, b) => b.listedAt - a.listedAt);
  return json(listings);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Login with Twitch to use the marketplace.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'list') {
    if (!body.dino || !body.price || body.price < 1) return json({ error: 'Invalid listing' }, 400);
    if (body.price > 99999) return json({ error: 'Price too high (max 99,999)' }, 400);

    const id = crypto.randomUUID();
    const listing = {
      id,
      seller: { userId: session.user_id, displayName: session.display_name, profileImage: session.profile_image },
      /* xp is whitelisted alongside careCount because this object IS the
         listing — anything absent here is gone when the dino is bought.
         Without it a levelled dino would arrive at the buyer as level 1,
         which reads as data loss rather than as a missing field. */
      /* nickname is player-authored free text that every OTHER player then
         renders. Capped here and escaped at render — both, because this
         listing is stored and re-served for as long as it is up, and the
         client is not the only thing that will ever read it.

         xp is whitelisted alongside careCount because this object IS the
         listing: anything absent here is gone when the dino is bought, and
         a levelled dino arriving as level 1 reads as data loss rather than
         a missing field. */
      dino: {
        speciesId: body.dino.speciesId,
        nickname: String(body.dino.nickname == null ? '' : body.dino.nickname).trim().slice(0, 24),
        mutation: body.dino.mutation || null,
        careCount: body.dino.careCount || 0,
        xp: Math.max(0, Math.floor(Number(body.dino.xp) || 0)),
      },
      price: Math.floor(body.price),
      listedAt: Date.now(),
    };

    /* Count and insert under one per-seller lock. Separately they race:
       two requests could each see nine listings and both insert a tenth.
       The lock is per seller, so it never serialises unrelated sellers. */
    const accepted = await env.MARKETPLACE.withLock(`listings:${session.user_id}`, async (tx) => {
      const rows = await tx.listValues({ prefix: 'listing_' });
      const mine = rows.filter(r => r.value && r.value.seller && r.value.seller.userId === session.user_id);
      if (mine.length >= MAX_ACTIVE_LISTINGS) return false;
      await tx.put('listing_' + id, JSON.stringify(listing), { expirationTtl: LISTING_TTL_SECONDS });
      return true;
    });

    if (!accepted) return json({ error: `Max ${MAX_ACTIVE_LISTINGS} active listings.` }, 400);
    return json({ success: true, id });
  }

  if (body.action === 'buy') {
    if (!body.listingId) return json({ error: 'Missing listing ID' }, 400);
    const key = 'listing_' + body.listingId;

    /* Own-listing check must happen BEFORE the claim, or rejecting it would
       have already destroyed the listing. Read first, then claim — a stale
       read here is harmless, because the claim is what actually decides. */
    const preview = await env.MARKETPLACE.get(key, 'json');
    if (!preview) return json({ error: 'Listing no longer available.' }, 404);
    if (preview.seller.userId === session.user_id) {
      return json({ error: 'Cannot buy your own listing.' }, 400);
    }

    /* The atomic claim. Of two simultaneous buyers exactly one gets the
       listing back and the other gets null — there is no window between
       checking and taking, because they are the same statement. */
    const listing = await env.MARKETPLACE.claim(key);
    if (!listing) return json({ error: 'Listing no longer available.' }, 404);

    /* Credit the seller under a lock: two of their listings selling at the
       same instant previously read the same balance and one credit was
       silently lost. */
    await env.MARKETPLACE.mutate('earnings_' + listing.seller.userId, (current) => {
      const acc = current || { amount: 0, sales: [] };
      return {
        amount: (acc.amount || 0) + listing.price,
        sales: [
          ...(acc.sales || []),
          { buyer: session.display_name, dino: listing.dino.speciesId, price: listing.price, at: Date.now() },
        ],
      };
    });

    return json({ success: true, dino: listing.dino, price: listing.price });
  }

  if (body.action === 'cancel') {
    if (!body.listingId) return json({ error: 'Missing listing ID' }, 400);
    const key = 'listing_' + body.listingId;

    const preview = await env.MARKETPLACE.get(key, 'json');
    if (!preview) return json({ error: 'Listing not found.' }, 404);
    if (preview.seller.userId !== session.user_id) return json({ error: 'Not your listing.' }, 403);

    /* Claim rather than delete, so a cancel racing a buy resolves to exactly
       one winner. Previously both could succeed: the buyer received the dino
       and the seller got it back too, duplicating it. */
    const listing = await env.MARKETPLACE.claim(key);
    if (!listing) return json({ error: 'Listing no longer available.' }, 404);
    return json({ success: true, dino: listing.dino });
  }

  return json({ error: 'Invalid action' }, 400);
}
