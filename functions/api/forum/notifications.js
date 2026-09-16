/* ══════════════════════════════════════════════
   /api/forum/notifications — what happened to you

   GET   { unread, notifications, authors }  for the session. Each row
         carries enough to say it in one line: kind, who did it, where
         (thread title or profile), the reason for a removal, and whether
         it has been read.
   POST  { action: 'read', ids?: [] }  marks those read, or everything
         unread when no ids are given. Scoped to the session's user.

   The bell in js/notifications.js is the consumer. It already exists,
   with a localStorage list of live/offline events; this is its second
   source, merged into the same panel rather than a second bell.

   Rows are written elsewhere, always in the transaction of the thing
   that caused them: a reply (createReply), a mention (addMentions), a
   comment on your profile (createComment), a moderator's removal
   (moderateDeletePost). Nothing here writes a notification.
   ══════════════════════════════════════════════ */

import { getPool, withTransaction } from '../../../server/lib/db.js';
import { parseId, listNotifications, unreadCount, markNotificationsRead, authorIds } from './queries.js';
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

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const [notifications, unread] = await Promise.all([
      listNotifications(db, session.user_id),
      unreadCount(db, session.user_id),
    ]);
    const authors = await authorsFor(env, authorIds(notifications));
    return json({ unread, notifications, authors });
  } catch (err) {
    console.error('[forum/notifications] get:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}

export async function onRequestPost(context) {
  const { request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!payload || typeof payload !== 'object' || payload.action !== 'read') return json({ error: 'Bad request' }, 400);

  let ids = null;
  if (Array.isArray(payload.ids)) {
    ids = payload.ids.map(parseId).filter(Boolean).slice(0, 200);
    if (!ids.length) return json({ ok: true, marked: 0 });
  }

  try {
    const marked = await withTransaction(tx => markNotificationsRead(tx, session.user_id, ids));
    return json({ ok: true, marked });
  } catch (err) {
    console.error('[forum/notifications] read:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
