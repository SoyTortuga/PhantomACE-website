/* ══════════════════════════════════════════════
   GET /api/forum/threads?category=<id>&page=<n>

   One page of a board: pinned threads first, then by latest activity,
   with the identities of everyone who started one.

   GET is public. POST /api/forum/threads { category, title, body } starts
   a topic: it needs a session, the board's own rule (staff-only,
   subscribers-only), and room under the rate limits. Validation runs
   before the database is touched; the rules run on what the database
   says; the write is one transaction.
   ══════════════════════════════════════════════ */

import { getPool, withTransaction } from '../../../server/lib/db.js';
import { isModerator } from '../admin/moderators.js';
import {
  parseCategoryId, parsePage, validateTitle, validateBody,
  getCategory, listThreads, createThread, recentThreadCount, recentPostCount, addMentions, authorIds,
} from './queries.js';
import { threadRule } from './rules.js';
import { authorsFor } from './authors.js';
import { parseMentions, resolveMentions } from './mentions.js';

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

  const categoryId = parseCategoryId(payload.category);
  const title = validateTitle(payload.title);
  if (title.error) return json({ error: title.error }, 400);
  const body = validateBody(payload.body);
  if (body.error) return json({ error: body.error }, 400);

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const category = categoryId ? await getCategory(db, categoryId) : null;
    const staff = await isModerator(env, session);
    const [recentThreads, recentPosts] = session && session.user_id
      ? await Promise.all([recentThreadCount(db, session.user_id, 10), recentPostCount(db, session.user_id, 1)])
      : [0, 0];

    const rule = threadRule({ session, staff, category, recentThreads, recentPosts });
    if (!rule.ok) return json({ error: rule.error }, rule.status);

    /* Resolved before the transaction (KV reads), written inside it. */
    const mentioned = await resolveMentions(env, parseMentions(body.value));
    const made = await withTransaction(async (tx) => {
      const out = await createThread(tx, { categoryId, userId: session.user_id, title: title.value, body: body.value });
      await addMentions(tx, { postId: out.postId, byUserId: session.user_id, userIds: mentioned.map(m => m.userId) });
      return out;
    });
    return json({ id: made.threadId }, 201);
  } catch (err) {
    console.error('[forum/threads] post:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const categoryId = parseCategoryId(url.searchParams.get('category'));
  if (!categoryId) return json({ error: 'No such board' }, 404);
  const page = parsePage(url.searchParams.get('page'));

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const category = await getCategory(db, categoryId);
    if (!category) return json({ error: 'No such board' }, 404);
    const { threads, total, pages } = await listThreads(db, categoryId, page);
    const authors = await authorsFor(env, authorIds(threads));
    return json({ category, threads, page, pages, total, authors });
  } catch (err) {
    console.error('[forum/threads]', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
