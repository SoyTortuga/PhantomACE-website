/* ══════════════════════════════════════════════
   GET /api/forum/search?q=<term>&page=<n>

   Topics whose title or any live post contains the term, title hits first,
   then by latest activity. Public: anyone can search what anyone can read.
   Each result carries the author line's identities, and body hits carry a
   snippet so the result says where the word was.
   ══════════════════════════════════════════════ */

import { getPool } from '../../../server/lib/db.js';
import { parsePage, validateQuery, searchForum, authorIds } from './queries.js';
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

  const q = validateQuery(url.searchParams.get('q'));
  if (q.error) return json({ error: q.error }, 400);
  const page = parsePage(url.searchParams.get('page'));

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const { results, total, pages } = await searchForum(db, q.value, page);
    const authors = await authorsFor(env, authorIds(results));
    return json({ query: q.value, results, page, pages, total, authors });
  } catch (err) {
    console.error('[forum/search]', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
