/* ══════════════════════════════════════════════
   GET /api/forum/categories

   The boards, each with its counts and its newest thread, plus the
   identities of the people who started those newest threads.

   Read-only and public: nothing here a guest may not see. The session is
   read only to say whether the viewer is staff (viewer.staff).
   ══════════════════════════════════════════════ */

import { getPool } from '../../../server/lib/db.js';
import { isModerator } from '../admin/moderators.js';
import { listCategories, authorIds } from './queries.js';
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
  const { env, request } = context;
  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const categories = await listCategories(db);
    const authors = await authorsFor(env, authorIds(categories));
    /* Whether to show the link to the moderation queue — the moderator
       list's answer, not the cookie's role. The queue checks again. */
    const staff = await isModerator(env, getSession(request));
    return json({ categories, authors, viewer: { staff } });
  } catch (err) {
    console.error('[forum/categories]', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
