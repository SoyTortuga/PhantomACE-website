/* ══════════════════════════════════════════════
   /api/forum/comments — a profile's wall

   GET  ?id=<userId>&page=<n>
        The comments on that profile, newest first, with the people who
        wrote them, whether comments are on, and whether the viewer is the
        owner. Public.

   POST { id, body }
        Leave a comment. A session, the owner's switch, and room under the
        rate limit. The owner is told in the same transaction.

   POST { action: 'settings', commentsEnabled: true|false }
        The owner's switch, on their own profile_ record. Turning it off
        refuses new comments and leaves the existing ones readable.

   A comment is a forum_posts row with profile_id set and no thread: the
   same editing (post.js), removal (moderate.js) and reporting apply to
   it, which is the whole reason it is not a table of its own.

   The profile record is a KV document, not a forum table, so the switch
   is read with get() and written with mutate() — the same two calls
   /api/profile and the login flow use for it.
   ══════════════════════════════════════════════ */

import { getPool, withTransaction } from '../../../server/lib/db.js';
import { parsePage, validateBody, listComments, createComment, recentPostCount, authorIds } from './queries.js';
import { commentRule } from './rules.js';
import { authorsFor } from './authors.js';

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

/** Twitch user ids are digits. Anything else is not a profile. */
function parseUserId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return /^[0-9]{1,20}$/.test(s) ? s : null;
}

async function ownerOf(env, id) {
  const p = await env.MARKETPLACE.get(`profile_${id}`, 'json');
  if (!p) return null;
  return {
    userId: id,
    login: p.login || '',
    displayName: p.displayName || p.login || '',
    commentsEnabled: p.commentsEnabled !== false,
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const session = getSession(request);

  const id = parseUserId(url.searchParams.get('id'));
  if (!id) return json({ error: 'There is nobody by that name.' }, 404);
  const page = parsePage(url.searchParams.get('page'));

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const owner = await ownerOf(env, id);
    if (!owner) return json({ error: 'There is nobody by that name.' }, 404);
    const { comments, total, pages } = await listComments(db, id, page);
    const authors = await authorsFor(env, authorIds(comments));
    return json({
      owner: { userId: owner.userId, login: owner.login, displayName: owner.displayName },
      enabled: owner.commentsEnabled,
      comments, page, pages, total, authors,
      viewer: { isOwner: !!session && String(session.user_id) === id },
    });
  } catch (err) {
    console.error('[forum/comments] get:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = getSession(request);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!payload || typeof payload !== 'object') return json({ error: 'Bad request' }, 400);

  /* The owner's switch. No database: the record is a KV document. */
  if (payload.action === 'settings') {
    if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);
    if (typeof payload.commentsEnabled !== 'boolean') return json({ error: 'Bad request' }, 400);
    try {
      const me = String(session.user_id);
      const after = await env.MARKETPLACE.mutate(`profile_${me}`, (p) => {
        if (!p) return undefined;                       // no record: nothing to switch
        return { ...p, commentsEnabled: payload.commentsEnabled };
      });
      if (!after) return json({ error: 'There is no profile to change yet. Log in again.' }, 404);
      return json({ ok: true, commentsEnabled: after.commentsEnabled !== false });
    } catch (err) {
      console.error('[forum/comments] settings:', err.message);
      return json({ error: 'Forum unavailable' }, 503);
    }
  }

  const id = parseUserId(payload.id);
  if (!id) return json({ error: 'There is nobody by that name.' }, 404);
  const body = validateBody(payload.body);
  if (body.error) return json({ error: body.error }, 400);

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const owner = await ownerOf(env, id);
    const recentPosts = session && session.user_id ? await recentPostCount(db, session.user_id, 1) : 0;
    const rule = commentRule({ session, owner, enabled: owner ? owner.commentsEnabled : true, recentPosts });
    if (!rule.ok) return json({ error: rule.error }, rule.status);

    const made = await withTransaction(tx => createComment(tx, { profileId: id, userId: session.user_id, body: body.value }));
    return json({ postId: made.postId }, 201);
  } catch (err) {
    console.error('[forum/comments] post:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
