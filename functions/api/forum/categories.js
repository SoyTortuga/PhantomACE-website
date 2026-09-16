/* ══════════════════════════════════════════════
   GET /api/forum/categories

   The boards, each with its counts and its newest thread, plus the
   identities of the people who started those newest threads.

   Read-only and public. There is no session check because there is
   nothing here a guest may not see.
   ══════════════════════════════════════════════ */

import { getPool } from '../../../server/lib/db.js';
import { listCategories, authorIds } from './queries.js';
import { authorsFor } from './authors.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const categories = await listCategories(db);
    const authors = await authorsFor(env, authorIds(categories));
    return json({ categories, authors });
  } catch (err) {
    console.error('[forum/categories]', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
