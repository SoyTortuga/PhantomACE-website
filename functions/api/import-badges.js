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

const BADGE_TIER_MAP = {
  1: { rarity: 'common', name: 'Tier 1 Sub Badge' },
  3: { rarity: 'uncommon', name: '3-Month Sub Badge' },
  6: { rarity: 'uncommon', name: '6-Month Sub Badge' },
  12: { rarity: 'rare', name: '1-Year Sub Badge' },
  24: { rarity: 'rare', name: '2-Year Sub Badge' },
  36: { rarity: 'mythic', name: '3-Year Sub Badge' },
};

async function getAppAccessToken(env) {
  const cached = await env.MARKETPLACE.get('twitch_app_token', 'json');
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();

  await env.MARKETPLACE.put('twitch_app_token', JSON.stringify({
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  }), { expirationTtl: data.expires_in });

  return data.access_token;
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

  const subRole = session.role || '';
  const isSub = subRole.startsWith('sub_') || subRole === 'broadcaster';
  if (!isSub) return json({ error: 'Must be a subscriber to import badges' }, 403);

  const subMonths = session.sub_months || 1;

  const inv = await getInventory(env, session.user_id);
  let imported = 0;

  for (const version of subBadgeSet.versions) {
    const monthThreshold = parseInt(version.id, 10);
    if (isNaN(monthThreshold) || monthThreshold > subMonths) continue;

    const badgeId = `twitch_sub_badge_${monthThreshold}`;
    if (inv.items.find(i => i.id === badgeId)) continue;

    const tierInfo = BADGE_TIER_MAP[monthThreshold] || {
      rarity: monthThreshold >= 24 ? 'rare' : monthThreshold >= 6 ? 'uncommon' : 'common',
      name: `${monthThreshold}-Month Sub Badge`,
    };

    inv.items.push({
      id: badgeId,
      game: 'profile',
      type: 'badge',
      consumable: false,
      name: tierInfo.name,
      rarity: tierInfo.rarity,
      grantedAt: Date.now(),
      source: 'twitch-import',
      meta: {
        imageUrl1x: version.image_url_1x,
        imageUrl2x: version.image_url_2x,
        imageUrl4x: version.image_url_4x,
        monthThreshold,
        description: version.description || '',
      },
    });
    imported++;
  }

  if (imported > 0) {
    await saveInventory(env, session.user_id, inv);
  }

  return json({
    success: true,
    imported,
    totalBadges: inv.items.filter(i => i.source === 'twitch-import').length,
  });
}
