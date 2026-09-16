/* ══════════════════════════════════════════════
   GET /api/forum/threads?category=<id>&page=<n>

   One page of a board: pinned threads first, then by latest activity,
   with the identities of everyone who started one.

   Read-only and public. Posting is POST, and arrives with step 3 of the
   plan; until then this file has one export on purpose.
   ══════════════════════════════════════════════ */

import { getPool } from '../../../server/lib/db.js';
import { parseCategoryId, parsePage, getCategory, listThreads, authorIds } from './queries.js';
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
