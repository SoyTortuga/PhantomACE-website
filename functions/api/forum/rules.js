/* ══════════════════════════════════════════════
   FORUM — who may do what

   Pure functions. Each takes what the route has already looked up — the
   session, whether the person is staff, the board, the thread, the post,
   how much they have posted lately — and answers { ok: true } or
   { error, status }. No database, no env, nothing async: that is what
   makes the answers testable one case at a time, and what lets a mutation
   test prove the rate limit is actually load-bearing.

   THE ROLE FIELD IS NEVER READ. `staff` comes from isModerator() /
   isBroadcaster(), which read the moderator list and the broadcaster id.
   `session.subTier` is the fact about subscription; `session.role` is a
   display ladder in which a moderator outranks every sub tier, and
   authorising on it has cost this codebase three bugs already.

   Library, not a route: declared in NON_ROUTE_MODULES.
   ══════════════════════════════════════════════ */

export const POSTS_PER_MINUTE = 5;
export const THREADS_PER_TEN_MINUTES = 2;

const ok = { ok: true };
const no = (error, status) => ({ ok: false, error, status });

export function isSubscriber(session) {
  return !!session && Number(session.subTier) > 0;
}

/** Whether this person may post on this board at all. */
function boardRule({ session, staff, category }) {
  if (!session || !session.user_id) return no('Log in to post.', 401);
  if (!category) return no('There is no board by that name.', 404);
  if (category.staffOnly && !staff) return no('Only staff post on this board.', 403);
  if (category.subOnly && !staff && !isSubscriber(session)) return no('This board is for subscribers.', 403);
  return ok;
}

export function threadRule({ session, staff, category, recentThreads = 0, recentPosts = 0 }) {
  const board = boardRule({ session, staff, category });
  if (!board.ok) return board;
  if (recentThreads >= THREADS_PER_TEN_MINUTES) {
    return no(`Slow down: ${THREADS_PER_TEN_MINUTES} new topics every ten minutes.`, 429);
  }
  if (recentPosts >= POSTS_PER_MINUTE) return no('Slow down: a few posts a minute is plenty.', 429);
  return ok;
}

export function replyRule({ session, staff, category, thread, recentPosts = 0 }) {
  if (!session || !session.user_id) return no('Log in to reply.', 401);
  if (!thread) return no('That topic is no longer here.', 404);
  const board = boardRule({ session, staff, category });
  if (!board.ok) return board;
  /* A lock is a lock for everyone. Staff unlock it (step 4) if they want
     to say something; a lock with exceptions is not one. */
  if (thread.locked) return no('That topic is locked.', 403);
  if (recentPosts >= POSTS_PER_MINUTE) return no('Slow down: a few posts a minute is plenty.', 429);
  return ok;
}

/** Leaving a comment on somebody's profile. `owner` is the profile record
    (null if nobody is there); `enabled` is their comments switch, on
    unless they turned it off. Turning it off refuses everyone, the owner
    included — a switch with exceptions is not one. */
export function commentRule({ session, owner, enabled = true, recentPosts = 0 }) {
  if (!session || !session.user_id) return no('Log in to leave a comment.', 401);
  if (!owner) return no('There is nobody by that name.', 404);
  if (!enabled) return no('They have turned comments off.', 403);
  if (recentPosts >= POSTS_PER_MINUTE) return no('Slow down: a few posts a minute is plenty.', 429);
  return ok;
}

/** Anything under /api/forum/moderate. `staff` is the moderator-list
    answer; the session is only consulted to tell "not logged in" from
    "logged in but not staff", which get different messages. */
export function staffRule({ session, staff }) {
  if (!session || !session.user_id) return no('Log in first.', 401);
  if (!staff) return no('Moderators only.', 403);
  return ok;
}

/** Reporting a post to the queue. Anyone logged in, about anyone else's
    live post. Reporting your own is refused rather than ignored, because
    the person pressed a button and deserves to know what happened. */
export function reportRule({ session, post }) {
  if (!session || !session.user_id) return no('Log in to report a post.', 401);
  if (!post) return no('That post is not here.', 404);
  if (post.deleted) return no('That post has already been removed.', 410);
  if (String(post.userId) === String(session.user_id)) return no('That is your own post. You can delete it.', 400);
  return ok;
}

export const REASON_MAX = 500;

/** A moderator's reason for removing something, or a reporter's reason
    for flagging it. Required: a removal with no reason is one the author
    cannot learn from and the queue cannot judge. */
export function validateReason(raw) {
  const value = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!value) return { error: 'Give a reason.' };
  if (value.length > REASON_MAX) return { error: `Reasons are at most ${REASON_MAX} characters.` };
  return { value };
}

/** Editing and deleting your own post — the same conditions. Deleting
    somebody else's is moderation: see moderate.js and staffRule. */
export function ownPostRule({ session, post }) {
  if (!session || !session.user_id) return no('Log in first.', 401);
  if (!post) return no('That post is not here.', 404);
  if (post.deleted) return no('That post has already been removed.', 410);
  if (String(post.userId) !== String(session.user_id)) return no('That is not your post.', 403);
  if (post.threadDeleted) return no('That topic is no longer here.', 404);
  if (post.threadLocked) return no('That topic is locked.', 403);
  return ok;
}
