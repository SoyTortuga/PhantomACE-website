/* ══════════════════════════════════════════════
   GET /api/forum/thread?id=<id>&page=<n>

   One thread: its metadata, one page of its posts oldest first (deleted
   ones as tombstones), and the identities of everyone on the page.

   Read-only and public. Replying is POST, and arrives with step 3.
   ══════════════════════════════════════════════ */

import { getPool } from '../../../server/lib/db.js';
import { parseId, parsePage, getThread, listPosts, authorIds } from './queries.js';
import { authorsFor } from './authors.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
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
