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

   SERVER-AUTHORITATIVE SETTLEMENT. The market used to take the browser's
   word for what it owned and what it could afford: `list` accepted any dino
   object, and `buy` never touched the buyer's coins while crediting the
   seller for real. Every action now settles against the players' park saves
   (dino_park_<userId>) using the helpers in dino-park.js:

     list    the dino must be in the seller's save, by uid; it is removed
             into escrow in the SAME transaction that writes the listing.
     buy     the buyer's save must hold the price; it is debited and the
             dino delivered in one locked write, then the seller's save is
             credited. The listing claim still decides the race.
     cancel  the escrowed dino is granted back to the seller's save.
     expiry  a listing past its lifetime is swept back to its seller the
             same way, whenever anyone reads the market.

   Every settlement bumps the save's grantSeq, so a client holding a stale
   copy gets a 409 and merges the change rather than undoing it.
   ══════════════════════════════════════════════ */

import {
  prepareMarketState, sealMarketState, findDinoByUid, escrowDino, applyCoins,
  listingDinoFrom, deliverDino, hasRoomForDino, isKnownSpecies, isKnownMutation,
  usableState, SAVE_MAX_BYTES,
} from './dino-park.js';

const COOKIE_NAME = 'pham_session';
const MAX_ACTIVE_LISTINGS = 10;
const LISTING_TTL_SECONDS = 604800;   // 7 days — the LOGICAL lifetime
const LISTING_LIFETIME_MS = LISTING_TTL_SECONDS * 1000;
const SALES_KEPT = 100;

const parkKey = (userId) => `dino_park_${userId}`;

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const sameUser = (a, b) => String(a) === String(b);

/* A listing holds an escrowed dino, so it is written with NO storage TTL:
   a row the database silently reaped would take the dino with it. Expiry
   is a timestamp check instead, and an expired listing is returned to its
   seller by sweepExpired rather than deleted. */
function isExpired(listing, now = Date.now()) {
  return !listing || !listing.listedAt || now - listing.listedAt > LISTING_LIFETIME_MS;
}

/**
 * Grant a listed dino back to its seller's save. Returns {placed, state}.
 * Shared by cancel and expiry.
 */
async function returnToSeller(env, listing, source) {
  const sellerId = listing.seller.userId;
  let placed = null;
  const next = await env.MARKETPLACE.mutate(parkKey(sellerId), (record) => {
    const prep = prepareMarketState(record, null);
    placed = deliverDino(prep.state, listing.dino, source).placed;
    return sealMarketState(sellerId, prep.state, prep.nextSeq);
  });
  return { placed, state: next ? next.state : null };
}

/**
 * Return every expired listing in `rows` to its seller and hand back the
 * live ones. The claim decides who sweeps a given listing, so two readers
 * sweeping at once return it exactly once.
 */
async function sweepExpired(env, rows) {
  const now = Date.now();
  const live = [];
  let returned = 0;
  for (const r of rows) {
    const l = r.value;
    if (!l || !l.seller) continue;
    if (!isExpired(l, now)) { live.push(l); continue; }
    const claimed = await env.MARKETPLACE.claim(r.name);
    if (!claimed) continue;
    try {
      await returnToSeller(env, claimed, 'market-expired');
      returned++;
    } catch (err) {
      await env.MARKETPLACE.put(r.name, JSON.stringify(claimed));
      console.error('[marketplace] expiry return failed:', err && err.message);
    }
  }
  return { live, returned };
}

/**
 * Pay the seller. Straight into their save, so their next sync adopts the
 * coins; the earnings row is kept only as the "you sold something" notice.
 * If the save write fails the amount falls back into earnings.amount,
 * which the earnings GET moves into the save on their next load.
 */
async function creditSeller(env, listing, buyerName) {
  const sellerId = listing.seller.userId;
  let credited = false;
  try {
    await env.MARKETPLACE.mutate(parkKey(sellerId), (record) => {
      const prep = prepareMarketState(record, null);
      applyCoins(prep.state, listing.price, 'market-sale');
      return sealMarketState(sellerId, prep.state, prep.nextSeq);
    });
    credited = true;
  } catch (err) {
    console.error('[marketplace] seller credit fell back to earnings:', err && err.message);
  }

  await env.MARKETPLACE.mutate('earnings_' + sellerId, (current) => {
    const acc = current || { amount: 0, sales: [] };
    return {
      amount: (acc.amount || 0) + (credited ? 0 : listing.price),
      sales: [
        ...(acc.sales || []),
        { buyer: buyerName, dino: listing.dino.speciesId, price: listing.price, at: Date.now(), credited },
      ].slice(-SALES_KEPT),
    };
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'earnings' && session) {
    const userId = session.user_id;
    /* Claim, not read: two loads arriving together must not both see the
       same balance. Only a fallback or pre-settlement balance is ever left
       in `amount`; it is moved into the save here, server-side. */
    const data = await env.MARKETPLACE.claim('earnings_' + userId);
    const owed = data && data.amount > 0 ? Math.floor(data.amount) : 0;
    if (owed > 0) {
      try {
        await env.MARKETPLACE.mutate(parkKey(userId), (record) => {
          const prep = prepareMarketState(record, null);
          applyCoins(prep.state, owed, 'market-earnings');
          return sealMarketState(userId, prep.state, prep.nextSeq);
        });
      } catch (err) {
        await env.MARKETPLACE.put('earnings_' + userId, JSON.stringify(data));
        throw err;
      }
    }

    /* The seller's own expired listings come home on every game load, so
       an escrowed dino never depends on somebody else opening the market. */
    const rows = await env.MARKETPLACE.listValues({ prefix: 'listing_' });
    const { returned } = await sweepExpired(env, rows.filter(r =>
      r.value && r.value.seller && sameUser(r.value.seller.userId, userId) && isExpired(r.value)));

    const sales = data && Array.isArray(data.sales) ? data.sales : [];
    const earned = sales.reduce((n, s) => n + (Number(s.price) || 0), 0);
    let state = null;
    if (owed > 0 || returned > 0 || sales.length) {
      state = usableState(await env.MARKETPLACE.get(parkKey(userId), 'json'));
    }
    return json({ coins: owed, earned, sales, returned, state });
  }

  const rows = await env.MARKETPLACE.listValues({ prefix: 'listing_' });
  const { live } = await sweepExpired(env, rows);

  if (action === 'my-listings' && session) {
    const mine = live.filter(v => sameUser(v.seller.userId, session.user_id));
    mine.sort((a, b) => b.listedAt - a.listedAt);
    return json(mine);
  }

  live.sort((a, b) => b.listedAt - a.listedAt);
  return json(live);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Login with Twitch to use the marketplace.' }, 401);

  /* list and buy carry the player's whole park state, so they get the same
     ceiling as a save. */
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > SAVE_MAX_BYTES + 4096) return json({ error: 'Request too large' }, 413);
  let raw;
  try { raw = await request.text(); } catch { return json({ error: 'Invalid request' }, 400); }
  if (new TextEncoder().encode(raw).length > SAVE_MAX_BYTES + 4096) return json({ error: 'Request too large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid request' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400);
  if (body.state != null && typeof body.state !== 'object') return json({ error: 'Invalid request' }, 400);

  const userId = session.user_id;

  if (body.action === 'list') {
    if (typeof body.uid !== 'string' || !body.uid) {
      return json({ error: body.dino ? 'Reload the game to use the marketplace.' : 'Invalid listing' }, 400);
    }
    const price = Math.floor(Number(body.price));
    if (!(price >= 1)) return json({ error: 'Invalid listing' }, 400);
    if (price > 99999) return json({ error: 'Price too high (max 99,999)' }, 400);
    const id = crypto.randomUUID();

    /* ONE TRANSACTION for ownership, the cap, the escrow and the listing.
       The lock name is the save key on purpose: withLock and mutate take
       the same pg_advisory_xact_lock(hashtext(name)), so this excludes a
       grant (or a save) landing on this park mid-listing, and it serialises
       this seller's listings so the cap cannot be raced. Either the dino
       leaves the save AND the listing exists, or neither happens. */
    const outcome = await env.MARKETPLACE.withLock(parkKey(userId), async (tx) => {
      const record = await tx.get(parkKey(userId), 'json');
      const prep = prepareMarketState(record, body.state || null);
      if (prep.stale) {
        return { status: 409, body: { error: 'stale', grantSeq: Number(prep.state.grantSeq || 0), state: prep.state } };
      }
      if (prep.error) return { status: prep.status, body: { error: prep.error } };
      const state = prep.state;

      const found = findDinoByUid(state, body.uid);
      if (!found) return { status: 403, body: { error: 'That dino is not in your park or vault.' } };
      if (!isKnownSpecies(found.dino.speciesId) || !isKnownMutation(found.dino.speciesId, found.dino.mutation)) {
        return { status: 400, body: { error: 'That dino cannot be listed.' } };
      }

      const now = Date.now();
      const rows = await tx.listValues({ prefix: 'listing_' });
      const active = rows.filter(r => r.value && r.value.seller &&
        sameUser(r.value.seller.userId, userId) && !isExpired(r.value, now));
      if (active.length >= MAX_ACTIVE_LISTINGS) {
        return { status: 400, body: { error: `Max ${MAX_ACTIVE_LISTINGS} active listings.` } };
      }

      const dino = escrowDino(state, body.uid);
      /* nickname is player-authored free text every OTHER player renders:
         capped by listingDinoFrom and escaped at render. xp rides along
         because this object IS the dino once it is bought. */
      const listing = {
        id,
        seller: { userId, displayName: session.display_name, profileImage: session.profile_image },
        dino: listingDinoFrom(dino),
        price,
        listedAt: now,
      };
      await tx.put('listing_' + id, JSON.stringify(listing));
      await tx.put(parkKey(userId), JSON.stringify(sealMarketState(userId, state, prep.nextSeq)));
      return { status: 200, body: { success: true, id, listing, state } };
    });

    return json(outcome.body, outcome.status);
  }

  if (body.action === 'buy') {
    if (!body.listingId) return json({ error: 'Missing listing ID' }, 400);
    const key = 'listing_' + body.listingId;

    /* Own-listing check must happen BEFORE the claim, or rejecting it would
       have already destroyed the listing. */
    const preview = await env.MARKETPLACE.get(key, 'json');
    if (!preview || isExpired(preview)) return json({ error: 'Listing no longer available.' }, 404);
    if (sameUser(preview.seller.userId, userId)) {
      return json({ error: 'Cannot buy your own listing.' }, 400);
    }

    /* Cheap refusal first, so a buyer who obviously cannot pay never takes
       the listing off the market even for a moment. Re-checked under the
       lock below — this read decides nothing. */
    const pre = prepareMarketState(await env.MARKETPLACE.get(parkKey(userId), 'json'), body.state || null);
    if (pre.stale) return json({ error: 'stale', grantSeq: Number(pre.state.grantSeq || 0), state: pre.state }, 409);
    if (pre.error) return json({ error: pre.error }, pre.status);
    if (pre.state.coins < preview.price) return json({ error: 'Not enough coins.' }, 400);
    if (!hasRoomForDino(pre.state)) return json({ error: 'Park and vault are both full!' }, 400);

    /* The atomic claim. Of two simultaneous buyers exactly one gets the
       listing back and the other gets null. */
    const listing = await env.MARKETPLACE.claim(key);
    if (!listing) return json({ error: 'Listing no longer available.' }, 404);

    /* Debit and deliver in one locked write of the buyer's save. Claim
       first, write second, and put the listing back if the write refuses
       or fails — the claim cannot sit inside the mutator without a second
       pooled connection per settlement. */
    let outcome = null;
    try {
      await env.MARKETPLACE.mutate(parkKey(userId), (record) => {
        const prep = prepareMarketState(record, body.state || null);
        if (prep.stale) {
          outcome = { status: 409, body: { error: 'stale', grantSeq: Number(prep.state.grantSeq || 0), state: prep.state } };
          return undefined;
        }
        if (prep.error) { outcome = { status: prep.status, body: { error: prep.error } }; return undefined; }
        const s = prep.state;
        if (s.coins < listing.price) { outcome = { status: 400, body: { error: 'Not enough coins.' } }; return undefined; }
        if (!hasRoomForDino(s)) { outcome = { status: 400, body: { error: 'Park and vault are both full!' } }; return undefined; }

        applyCoins(s, -listing.price, 'market-buy');
        const { placed, grantId } = deliverDino(s, listing.dino, 'market-buy');
        outcome = { status: 200, body: { success: true, dino: listing.dino, price: listing.price, placed, grantId, state: s } };
        return sealMarketState(userId, s, prep.nextSeq);
      });
    } catch (err) {
      await env.MARKETPLACE.put(key, JSON.stringify(listing));
      throw err;
    }

    if (!outcome || outcome.status !== 200) {
      await env.MARKETPLACE.put(key, JSON.stringify(listing));
      return json(outcome ? outcome.body : { error: 'Purchase failed.' }, outcome ? outcome.status : 500);
    }

    await creditSeller(env, listing, session.display_name);
    return json(outcome.body);
  }

  if (body.action === 'cancel') {
    if (!body.listingId) return json({ error: 'Missing listing ID' }, 400);
    const key = 'listing_' + body.listingId;

    const preview = await env.MARKETPLACE.get(key, 'json');
    if (!preview) return json({ error: 'Listing not found.' }, 404);
    if (!sameUser(preview.seller.userId, userId)) return json({ error: 'Not your listing.' }, 403);

    /* Claim rather than delete, so a cancel racing a buy resolves to exactly
       one winner. */
    const listing = await env.MARKETPLACE.claim(key);
    if (!listing) return json({ error: 'Listing no longer available.' }, 404);

    let back;
    try {
      back = await returnToSeller(env, listing, 'market-cancel');
    } catch (err) {
      await env.MARKETPLACE.put(key, JSON.stringify(listing));
      throw err;
    }
    return json({ success: true, dino: listing.dino, placed: back.placed, state: back.state });
  }

  return json({ error: 'Invalid action' }, 400);
}
