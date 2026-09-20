/* ══════════════════════════════════════════════
   USER DIRECTORY — everyone who has logged in, for the broadcaster to
   elevate to moderator.

     GET /api/admin/users        the full roster + who is a mod (staff)

   READ ONLY. Elevation and removal go through /api/admin/moderators, which
   already resolves a name against Twitch, stores canonical login/display,
   and is broadcaster-gated — there is one place the mod list is written,
   and this is not it. This route only joins two things the site already
   keeps: the profile written on every login, and the moderator list.

   A moderator may VIEW the roster (the same read the mod panel allows);
   only the broadcaster may act on it, which the page enforces cosmetically
   and the moderators route enforces for real.
   ══════════════════════════════════════════════ */

import { isModerator, isBroadcaster, getModerators } from './moderators.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!(await isModerator(env, session))) {
    return json({ error: 'Staff only.' }, 403);
  }

  const { userIds } = await getModerators(env);
  const modSet = new Set(userIds.map(String));

  /* Every profile_ row is one person who has logged in — the closest thing
     the site has to a user table, and enough to find and elevate anyone. */
  let rows = [];
  try {
    rows = await env.MARKETPLACE.listValues({ prefix: 'profile_' });
  } catch (err) {
    console.error('[admin/users] could not list profiles:', err.message);
    return json({ error: 'Could not read the user directory.' }, 500);
  }

  const broadcasterId = String(env.TWITCH_BROADCASTER_ID || '');
  const users = [];
  for (const row of rows) {
    const p = row.value;
    if (!p || typeof p !== 'object' || !p.userId) continue;
    const id = String(p.userId);
    users.push({
      userId: id,
      login: p.login || '',
      displayName: p.displayName || p.login || id,
      avatar: p.avatar || '',
      /* The role stamped at their last login, for display only — the
         authority for "is a mod" is the mod list, joined below, not this. */
      role: p.role || 'visitor',
      updatedAt: Number(p.updatedAt) || 0,
      isMod: modSet.has(id),
      isBroadcaster: id === broadcasterId,
    });
  }

  /* Mods first so the people with power are easy to review, then most
     recently seen — the page a broadcaster opens to elevate someone is
     usually opened right after that someone was around. */
  users.sort((a, b) =>
    (Number(b.isMod) - Number(a.isMod)) || (b.updatedAt - a.updatedAt));

  return json({
    users,
    count: users.length,
    modCount: modSet.size,
    canEdit: isBroadcaster(env, session),
  });
}
