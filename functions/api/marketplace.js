const COOKIE_NAME = 'pham_session';

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
    const key = 'earnings_' + session.user_id;
    const data = await env.MARKETPLACE.get(key, 'json');
    if (data && data.amount > 0) {
      await env.MARKETPLACE.delete(key);
      return json({ coins: data.amount, sales: data.sales || [] });
    }
    return json({ coins: 0, sales: [] });
  }

  if (action === 'my-listings' && session) {
    const list = await env.MARKETPLACE.list({ prefix: 'listing_' });
    const mine = [];
    for (const key of list.keys) {
      const val = await env.MARKETPLACE.get(key.name, 'json');
      if (val && val.seller.userId === session.user_id) mine.push(val);
    }
    return json(mine);
  }

  const list = await env.MARKETPLACE.list({ prefix: 'listing_' });
  const listings = [];
  for (const key of list.keys) {
    const val = await env.MARKETPLACE.get(key.name, 'json');
    if (val) listings.push(val);
  }
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

    const existingList = await env.MARKETPLACE.list({ prefix: 'listing_' });
    let myCount = 0;
    for (const key of existingList.keys) {
      const val = await env.MARKETPLACE.get(key.name, 'json');
      if (val && val.seller.userId === session.user_id) myCount++;
    }
    if (myCount >= 10) return json({ error: 'Max 10 active listings.' }, 400);

    const id = crypto.randomUUID();
    const listing = {
      id,
      seller: { userId: session.user_id, displayName: session.display_name, profileImage: session.profile_image },
      dino: { speciesId: body.dino.speciesId, nickname: body.dino.nickname, mutation: body.dino.mutation || null, careCount: body.dino.careCount || 0 },
      price: Math.floor(body.price),
      listedAt: Date.now(),
    };
    await env.MARKETPLACE.put('listing_' + id, JSON.stringify(listing), { expirationTtl: 604800 });
    return json({ success: true, id });
  }

  if (body.action === 'buy') {
    if (!body.listingId) return json({ error: 'Missing listing ID' }, 400);
    const key = 'listing_' + body.listingId;
    const listing = await env.MARKETPLACE.get(key, 'json');
    if (!listing) return json({ error: 'Listing no longer available.' }, 404);
    if (listing.seller.userId === session.user_id) return json({ error: 'Cannot buy your own listing.' }, 400);

    await env.MARKETPLACE.delete(key);

    const earningsKey = 'earnings_' + listing.seller.userId;
    const existing = await env.MARKETPLACE.get(earningsKey, 'json') || { amount: 0, sales: [] };
    existing.amount += listing.price;
    existing.sales.push({ buyer: session.display_name, dino: listing.dino.speciesId, price: listing.price, at: Date.now() });
    await env.MARKETPLACE.put(earningsKey, JSON.stringify(existing), { expirationTtl: 2592000 });

    return json({ success: true, dino: listing.dino, price: listing.price });
  }

  if (body.action === 'cancel') {
    if (!body.listingId) return json({ error: 'Missing listing ID' }, 400);
    const key = 'listing_' + body.listingId;
    const listing = await env.MARKETPLACE.get(key, 'json');
    if (!listing) return json({ error: 'Listing not found.' }, 404);
    if (listing.seller.userId !== session.user_id) return json({ error: 'Not your listing.' }, 403);
    await env.MARKETPLACE.delete(key);
    return json({ success: true, dino: listing.dino });
  }

  return json({ error: 'Invalid action' }, 400);
}
