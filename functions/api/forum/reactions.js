/* ══════════════════════════════════════════════
   POST /api/forum/reactions { id, emoji, action: 'add' | 'remove' }

   Place or lift one of the twelve marks on a post. The mark is from the
   closed set REACTION_IDS; anything else is refused. Returns the post's
   whole reaction state afterward — tallies for everyone, and which are
   yours — so the client redraws exactly that bar from the server's count
   rather than guessing at it.

   A reaction sends no notification: the notifications row derives its actor
   from the referenced post's author, which for a reaction is the recipient,
   not the reactor. The bar updating live says it instead.
   ══════════════════════════════════════════════ */

import { getPool, withTransaction } from '../../../server/lib/db.js';
import {
  parseId, getPost, isReaction, addReaction, removeReaction, reactionsForPost,
} from './queries.js';

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

export async function onRequestPost(context) {
  const { request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in to react.' }, 401);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!payload || typeof payload !== 'object') return json({ error: 'Bad request' }, 400);

  const id = parseId(payload.id);
  if (!id) return json({ error: 'That post is not here.' }, 404);
  if (!isReaction(payload.emoji)) return json({ error: 'Pick a reaction.' }, 400);
  const action = payload.action === 'remove' ? 'remove' : 'add';

  let db;
  try { db = getPool(); } catch { return json({ error: 'Forum unavailable' }, 503); }

  try {
    const post = await getPost(db, id);
    if (!post) return json({ error: 'That post is not here.' }, 404);
    if (post.deleted) return json({ error: 'That post has been removed.' }, 410);

    if (action === 'add') {
      await withTransaction((tx) => addReaction(tx, { postId: id, userId: session.user_id, emoji: payload.emoji }));
    } else {
      await withTransaction((tx) => removeReaction(tx, { postId: id, userId: session.user_id, emoji: payload.emoji }));
    }
    const reactions = await reactionsForPost(db, id, session.user_id);
    return json({ ok: true, reactions });
  } catch (err) {
    console.error('[forum/reactions]', err.message);
    return json({ error: 'Forum unavailable' }, 503);
  }
}
