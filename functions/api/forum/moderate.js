/* ══════════════════════════════════════════════
   /api/forum/moderate — staff only

   GET   the open report queue, oldest first, with the people involved.
   POST  { action, id, reason? }
           pin | unpin | lock | unlock      id = thread
           delete-thread | restore-thread   id = thread  (delete: reason)
           delete-post | restore-post       id = post    (delete: reason)
           resolve                          id = post    closes its reports

   Staff is the moderator list plus the broadcaster, read fresh on every
   request through isModerator(). The session's role field is not
   consulted; see rules.js for why.

   Everything a moderator does is reversible: pin/lock are flags, and
   both kinds of delete are soft, with restore as the undo. A removal
   requires a reason, which is stored on the row and shown to the author.
   ══════════════════════════════════════════════ */

import { getPool, withTransaction } from '../../../server/lib/db.js';
import { isModerator } from '../admin/moderators.js';
import {
  parseId, getThread, getPost, setThreadFlags, deleteThread, restoreThread,
  moderateDeletePost, restorePost, listOpenReports, resolveReports,
} from './queries.js';
import { staffRule, validateReason } from './rules.js';
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

const ACTIONS = new Set([
  'pin', 'unpin', 'lock', 'unlock', 'delete-thread', 'restore-thread',
  'delete-post', 'restore-post', 'resolve',
]);
const NEEDS_REASON = new Set(['delete-thread', 'delete-post']);

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = getSession(request);

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const staff = await isModerator(env, session);
    const rule = staffRule({ session, staff });
    if (!rule.ok) return json({ error: rule.error }, rule.status);

    const reports = await listOpenReports(db);
    const ids = [];
    for (const r of reports) ids.push(r.reporterId, r.authorId);
    const authors = await authorsFor(env, ids);
    return json({ reports, authors });
  } catch (err) {
    console.error('[forum/moderate] get:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = getSession(request);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!payload || typeof payload !== 'object') return json({ error: 'Bad request' }, 400);

  const action = ACTIONS.has(payload.action) ? payload.action : null;
  if (!action) return json({ error: 'Bad request' }, 400);
  const id = parseId(payload.id);
  if (!id) return json({ error: 'Nothing by that id.' }, 404);

  let reason = null;
  if (NEEDS_REASON.has(action)) {
    const v = validateReason(payload.reason);
    if (v.error) return json({ error: v.error }, 400);
    reason = v.value;
  }

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const staff = await isModerator(env, session);
    const rule = staffRule({ session, staff });
    if (!rule.ok) return json({ error: rule.error }, rule.status);
    const me = session.user_id;

    /* Thread actions. A deleted thread is refused for everything but
       restore, and restore is refused for a live one — the query's own
       WHERE makes each a no-op, reported as "nothing to do". */
    if (action === 'pin' || action === 'unpin' || action === 'lock' || action === 'unlock') {
      const flags = action === 'pin' ? { pinned: true } : action === 'unpin' ? { pinned: false }
                  : action === 'lock' ? { locked: true } : { locked: false };
      const done = await withTransaction(tx => setThreadFlags(tx, id, flags));
      if (!done) return json({ error: 'That topic is not here.' }, 404);
      const thread = await getThread(db, id);
      return json({ ok: true, thread });
    }
    if (action === 'delete-thread') {
      const done = await withTransaction(tx => deleteThread(tx, { id, byUserId: me }));
      if (!done) return json({ error: 'That topic is already removed.' }, 410);
      return json({ ok: true });
    }
    if (action === 'restore-thread') {
      const done = await withTransaction(tx => restoreThread(tx, { id }));
      if (!done) return json({ error: 'That topic is not removed.' }, 409);
      return json({ ok: true });
    }

    /* Post actions. */
    if (action === 'delete-post') {
      const post = await getPost(db, id);
      if (!post) return json({ error: 'That post is not here.' }, 404);
      if (post.deleted) return json({ error: 'That post is already removed.' }, 410);
      await withTransaction(async (tx) => {
        await moderateDeletePost(tx, { id, byUserId: me, reason });
        await resolveReports(tx, { postId: id, byUserId: me });
      });
      return json({ ok: true });
    }
    if (action === 'restore-post') {
      const done = await withTransaction(tx => restorePost(tx, { id }));
      if (!done) return json({ error: 'That post is not removed.' }, 409);
      return json({ ok: true });
    }
    if (action === 'resolve') {
      const n = await withTransaction(tx => resolveReports(tx, { postId: id, byUserId: me }));
      return json({ ok: true, resolved: n });
    }
    return json({ error: 'Bad request' }, 400);
  } catch (err) {
    console.error('[forum/moderate] post:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
