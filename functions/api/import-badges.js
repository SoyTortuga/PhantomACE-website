/* ══════════════════════════════════════════
   IMPORT TWITCH SUB BADGES
   Fetches the user's Twitch subscriber badges
   and grants them as profile inventory items
   ══════════════════════════════════════════ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function inventoryKey(userId) { return `inv_${userId}`; }

async function getInventory(env, userId) {
  return await env.MARKETPLACE.get(inventoryKey(userId), 'json') || { userId, items: [], equips: {} };
}

async function saveInventory(env, userId, inv) {
  await env.MARKETPLACE.put(inventoryKey(userId), JSON.stringify(inv));
}

/* TWITCH ENCODES THE TIER IN THE VERSION ID. A plain number is Tier 1;
   2000+ is Tier 2 and 3000+ is Tier 3, with the months as the remainder.
   PhantomACE's set runs 0/2/3/6/12/24/36/48/60/72/84/96 at Tier 1 and the
   same ladder again at 2000+ and 3000+.

   Read naively, version 2012 is "two thousand and twelve months" — larger
   than anyone's subscription, so every Tier 2 and Tier 3 badge was silently
   skipped and only Tier 1 was ever granted. */
export function decodeBadgeVersion(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 3000) return { tier: 3, months: n - 3000 };
  if (n >= 2000) return { tier: 2, months: n - 2000 };
  return { tier: 1, months: n };
}

/* Rarity tracks the duration, because that is what the badge is for. Tier
   raises the floor a little: a Tier 3 subscriber at six months is paying
   more than a Tier 1 at six months and the shelf should say so. */
export function badgeRarity(months, tier) {
  let r = months >= 36 ? 'mythic' : months >= 12 ? 'rare' : months >= 3 ? 'uncommon' : 'common';
  if (tier === 3 && r === 'common') r = 'uncommon';
  return r;
}

/* Twitch's own title — "6-Month Subscriber" — is the duration in the
   channel's own words, so it is preferred over anything reconstructed
   here. It does not mention the tier, so tiers above the first say so. */
export function badgeName(months, tier, title) {
  const base = title || (months > 0 ? `${months}-Month Subscriber` : 'Subscriber');
  return tier > 1 ? `Tier ${tier} \u00b7 ${base}` : base;
}

async function getAppAccessToken(env) {
  /* Shared cached token — see functions/api/auth/app-token.js. Minting one
     here independently is what revoked everyone else's. validate:true because
     a stale token on this path surfaces as six identical "Invalid OAuth token"
     failures on a page the broadcaster only visits during setup. */
  const { getAppToken } = await import('./auth/app-token.js');
  return getAppToken(env, { validate: false });
}


export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  const broadcasterId = env.TWITCH_BROADCASTER_ID || session.broadcaster_id;
  if (!broadcasterId) return json({ error: 'Broadcaster ID not configured' }, 500);

  const token = await getAppAccessToken(env);
  if (!token) return json({ error: 'Failed to get Twitch token' }, 500);

  const badgeRes = await fetch(
    `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${broadcasterId}`,
    { headers: { 'Client-Id': env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } }
  );

  if (!badgeRes.ok) return json({ error: 'Failed to fetch badges' }, 502);
  const badgeData = await badgeRes.json();

  const subBadgeSet = (badgeData.data || []).find(s => s.set_id === 'subscriber');
  if (!subBadgeSet) return json({ error: 'No subscriber badges found' }, 404);

  /* subTier, not role. `role` is a DISPLAY ladder in which moderator
     outranks every sub tier, so a subscribing moderator carries
     role 'moderator' and was refused their own badges here — the same
     confusion that once cost a subscribing moderator their boost rate, and
     that the inventory page's own button had until a moment ago.

     The broadcaster is checked by id rather than by the role string, the
     way admin/moderators.js does it: identity, not a claim. */
  const { isBroadcaster } = await import('./admin/moderators.js');
  const owner = isBroadcaster(env, session);
  const isSub = Number(session.subTier) > 0 || owner;
  if (!isSub) {
    return json({ error: 'Only subscribers have loyalty badges to import' }, 403);
  }

  /* HOW LONG THEY HAVE ACTUALLY SUBSCRIBED.

     Helix returns a tier and no duration, so `session.sub_months` was never
     set by anything — it read undefined, fell back to 1, and the loop then
     granted the zero-month badge and nothing else. Every click of Import
     Badges returned one badge no matter how long someone had subscribed.

     The real number only ever appears in the badge a subscriber wears in
     chat, which the bot records as they speak. Someone who has never typed
     in chat has no record, and gets the entry-level badge until they do. */
  let seen = null;
  let durationReadable = true;
  try {
    seen = await env.MARKETPLACE.get(`sub_months_${session.user_id}`, 'json');
  } catch (err) {
    durationReadable = false;
    /* The duration record is an enhancement, not a prerequisite. If the
       store cannot answer -- the table missing on a server that has not run
       the migration yet is the obvious case -- import what can be proven
       from the session instead of failing outright. Fewer badges, never
       none, and never a dead end the viewer cannot act on. */
    console.error('[import-badges] could not read sub duration:', err.message);
  }
  const subMonths = seen && Number.isFinite(Number(seen.months)) ? Number(seen.months) : 0;
  const subTier = Number(session.subTier) || (seen ? Number(seen.tier) : 0) || 1;

  const inv = await getInventory(env, session.user_id);
  let imported = 0;

  for (const version of subBadgeSet.versions) {
    const decoded = decodeBadgeVersion(version.id);
    if (!decoded) continue;

    /* THE BROADCASTER CANNOT SUBSCRIBE TO THEMSELVES, so they wear a
       broadcaster badge in their own chat and never a subscriber one. No
       duration can ever be recorded for them, and gating on one would deny
       the channel's owner every badge the channel has — permanently, with
       "say something in chat first" as the only explanation. They get the
       whole set. It is their artwork.

       Both gates apply to everyone else, not either: duration alone would
       hand a Tier 1 subscriber the Tier 3 artwork, and tier alone would
       hand a brand new Tier 3 subscriber the eight-year badge. */
    if (!owner && decoded.months > subMonths) continue;
    if (!owner && decoded.tier > subTier) continue;

    const badgeId = `twitch_sub_badge_t${decoded.tier}_${decoded.months}`;
    /* The old scheme keyed on the raw version id and so could not tell
       Tier 2 at twelve months from Tier 1 at twelve months. Checked too, so
       re-importing does not hand anyone a duplicate of what they hold. */
    const legacyId = `twitch_sub_badge_${version.id}`;
    if (inv.items.find(i => i.id === badgeId || i.id === legacyId)) continue;

    inv.items.push({
      id: badgeId,
      game: 'profile',
      type: 'badge',
      consumable: false,
      name: badgeName(decoded.months, decoded.tier, version.title),
      rarity: badgeRarity(decoded.months, decoded.tier),
      grantedAt: Date.now(),
      source: 'twitch-import',
      meta: {
        imageUrl1x: version.image_url_1x,
        imageUrl2x: version.image_url_2x,
        imageUrl4x: version.image_url_4x,
        monthThreshold: decoded.months,
        subTier: decoded.tier,
        description: version.description || '',
      },
    });
    imported++;
  }

  if (imported > 0) {
    await saveInventory(env, session.user_id, inv);
  }

  /* WHY NOTHING WAS IMPORTED IS THE USEFUL PART. Zero is the expected
     answer for someone already holding everything they have earned, and
     also the answer when their duration was never recorded — the two look
     identical from the button, and the second one is fixable. */
  return json({
    success: true,
    imported,
    totalBadges: inv.items.filter(i => i.source === 'twitch-import').length,
    months: subMonths,
    tier: subTier,
    /* False means the duration store could not be read at all, which is
       what an unapplied migration looks like from in here. */
    /* The broadcaster's duration is not unknown, it is not applicable —
       so the button must not tell them to go and post in chat. */
    durationKnown: owner || (durationReadable && !!seen),
    /* How many of the channel's badges they qualify for, so "nothing new"
       can distinguish "you have them all" from "you qualify for one". */
    eligible: subBadgeSet.versions.reduce((n, v) => {
      const d = decodeBadgeVersion(v.id);
      return n + (d && d.months <= subMonths && d.tier <= subTier ? 1 : 0);
    }, 0),
  });
}
