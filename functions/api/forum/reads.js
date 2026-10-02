/* ══════════════════════════════════════════════
   /api/forum/reads — what you have caught up on

   GET   { followUnread }  how many topics you follow have moved since you
         last read them — the number a "Following" badge wants. Session only.
   POST  { id }  mark one topic read, now. The topic page marks itself read
         when it loads; this is the explicit version for clearing a badge
         without a reload.

   Unread means "new since you looked", not "you have not looked": a topic
   you have never opened carries no marker at all.
   ══════════════════════════════════════════════ */

import { getPool } from '../../../server/lib/db.js';
import { parseId, markThreadRead, unreadFollowCount } from './queries.js';

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
  const { request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const followUnread = await unreadFollowCount(db, session.user_id);
    return json({ followUnread });
  } catch (err) {
    console.error('[forum/reads] get:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}

export async function onRequestPost(context) {
  const { request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const id = parseId(payload && payload.id);
  if (!id) return json({ error: 'No such topic' }, 404);

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    await markThreadRead(db, { threadId: id, userId: session.user_id });
    return json({ ok: true });
  } catch (err) {
    console.error('[forum/reads] post:', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
