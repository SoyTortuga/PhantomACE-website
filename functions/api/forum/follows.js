/* ══════════════════════════════════════════════
   /api/forum/follows — topics you want to hear about

   GET   { threads, page, pages, total, authors }  the topics you follow,
         latest activity first, each with an `unread` flag. Session only.
   POST  { id, action: 'follow' | 'unfollow' }  start or stop following a
         topic. Following means a reply to it reaches your bell (kind
         'follow'); the starter still gets 'reply', so neither doubles up.

   Who may do this is only "are you logged in" — you follow on your own
   behalf, about any topic you can read.
   ══════════════════════════════════════════════ */

import { getPool, withTransaction } from '../../../server/lib/db.js';
import {
  parseId, parsePage, getThread, followThread, unfollowThread,
  listFollowedThreads, authorIds,
} from './queries.js';
import { authorsFor } from './authors.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);
  const page = parsePage(new URL(request.url).searchParams.get('page'));

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const { threads, total, pages } = await listFollowedThreads(db, session.user_id, page);
    const authors = await authorsFor(env, authorIds(threads));
    return json({ threads, page, pages, total, authors });
  } catch (err) {
    console.error('[forum/follows] get:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}

export async function onRequestPost(context) {
  const { request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in to follow a topic.' }, 401);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!payload || typeof payload !== 'object') return json({ error: 'Bad request' }, 400);

  const id = parseId(payload.id);
  if (!id) return json({ error: 'No such topic' }, 404);
  const action = payload.action === 'unfollow' ? 'unfollow' : payload.action === 'follow' ? 'follow' : null;
  if (!action) return json({ error: 'Bad request' }, 400);

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    if (action === 'follow') {
      const thread = await getThread(db, id);
      if (!thread) return json({ error: 'That topic is no longer here.' }, 404);
      await withTransaction((tx) => followThread(tx, { threadId: id, userId: session.user_id }));
      return json({ ok: true, following: true });
    }
    await withTransaction((tx) => unfollowThread(tx, { threadId: id, userId: session.user_id }));
    return json({ ok: true, following: false });
  } catch (err) {
    console.error('[forum/follows] post:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
