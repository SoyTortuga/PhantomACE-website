/* ══════════════════════════════════════════════
   POST /api/forum/post { action: 'edit' | 'delete', id, body? }

   Your own post, and only your own — the rule is the same for both
   actions. Deleting somebody else's, pinning, locking and restoring are
   moderation and arrive with step 4.

   A delete is a soft delete with deleted_by = you, which is what makes
   the tombstone read "removed by the author" rather than "by a
   moderator". The body stays in the row; nothing here is unrecoverable.
   ══════════════════════════════════════════════ */

import { getPool, withTransaction } from '../../../server/lib/db.js';
import { parseId, validateBody, getPost, editPost, deleteOwnPost, reportPost } from './queries.js';
import { ownPostRule, reportRule, validateReason } from './rules.js';

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
  const { request } = context;
  const session = getSession(request);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!payload || typeof payload !== 'object') return json({ error: 'Bad request' }, 400);

  const action = ['edit', 'delete', 'report'].includes(payload.action) ? payload.action : null;
  if (!action) return json({ error: 'Bad request' }, 400);
  const id = parseId(payload.id);
  if (!id) return json({ error: 'That post is not here.' }, 404);

  let body = null;
  if (action === 'edit') {
    body = validateBody(payload.body);
    if (body.error) return json({ error: body.error }, 400);
  }
  let reason = null;
  if (action === 'report') {
    reason = validateReason(payload.reason);
    if (reason.error) return json({ error: reason.error }, 400);
  }

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const post = await getPost(db, id);

    /* Reporting is anybody's; the rest is the author's. */
    if (action === 'report') {
      const rule = reportRule({ session, post });
      if (!rule.ok) return json({ error: rule.error }, rule.status);
      const fresh = await withTransaction(tx => reportPost(tx, { postId: id, reporterId: session.user_id, reason: reason.value }));
      /* A second report from the same person is not an error to them —
         the post is in the queue either way. */
      return json({ ok: true, duplicate: !fresh });
    }

    const rule = ownPostRule({ session, post });
    if (!rule.ok) return json({ error: rule.error }, rule.status);

    if (action === 'edit') {
      const done = await withTransaction(tx => editPost(tx, { id, body: body.value }));
      if (!done) return json({ error: 'That post has already been removed.' }, 410);
      return json({ ok: true, body: body.value });
    }

    const done = await withTransaction(tx => deleteOwnPost(tx, { id, userId: session.user_id }));
    if (!done) return json({ error: 'That post has already been removed.' }, 410);
    return json({ ok: true });
  } catch (err) {
    console.error('[forum/post]', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
