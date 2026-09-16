/* ══════════════════════════════════════════════
   GET /api/forum/thread?id=<id>&page=<n>

   One thread: its metadata, one page of its posts oldest first (deleted
   ones as tombstones), and the identities of everyone on the page.

   GET is public. POST /api/forum/thread { id, body } replies: a session,
   the board's rule, not locked, room under the rate limit. The reply
   transaction locks the thread row, so a lock landing at the same moment
   is seen rather than raced; a ForumError from it is a real answer, not a
   failure.
   ══════════════════════════════════════════════ */

import { getPool, withTransaction } from '../../../server/lib/db.js';
import { isModerator } from '../admin/moderators.js';
import {
  ForumError, parseId, parsePage, validateBody,
  getThread, getCategory, listPosts, createReply, recentPostCount, pageOfPost, authorIds,
} from './queries.js';
import { replyRule } from './rules.js';
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

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = getSession(request);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!payload || typeof payload !== 'object') return json({ error: 'Bad request' }, 400);

  const id = parseId(payload.id);
  if (!id) return json({ error: 'No such topic' }, 404);
  const body = validateBody(payload.body);
  if (body.error) return json({ error: body.error }, 400);

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const thread = await getThread(db, id);
    const category = thread ? await getCategory(db, thread.categoryId) : null;
    const staff = await isModerator(env, session);
    const recentPosts = session && session.user_id ? await recentPostCount(db, session.user_id, 1) : 0;

    const rule = replyRule({ session, staff, category, thread, recentPosts });
    if (!rule.ok) return json({ error: rule.error }, rule.status);

    let made;
    try {
      made = await withTransaction(tx => createReply(tx, { threadId: id, userId: session.user_id, body: body.value }));
    } catch (err) {
      if (err instanceof ForumError) return json({ error: err.message }, err.status);
      throw err;
    }
    const page = await pageOfPost(db, id, made.postId);
    return json({ postId: made.postId, page }, 201);
  } catch (err) {
    console.error('[forum/thread] post:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const id = parseId(url.searchParams.get('id'));
  if (!id) return json({ error: 'No such topic' }, 404);
  const page = parsePage(url.searchParams.get('page'));

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const thread = await getThread(db, id);
    if (!thread) return json({ error: 'No such topic' }, 404);
    const { posts, total, pages } = await listPosts(db, id, page);
    const authors = await authorsFor(env, authorIds([thread], posts));
    return json({ thread, posts, page, pages, total, authors });
  } catch (err) {
    console.error('[forum/thread]', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
