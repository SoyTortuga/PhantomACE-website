/* ══════════════════════════════════════════════
   FORUM — the queries

   Every question a forum page asks, as a function over a `db` that has one
   method: query(sql, params) → { rows }. That is the shape of a pg Pool, a
   pg client inside withTransaction(), and a pglite instance, which is what
   lets server/scripts/test-forum-queries.js run this file against a real
   Postgres with no server and no DATABASE_URL.

   Library, not a route: declared in NON_ROUTE_MODULES. The routes under
   functions/api/forum/ call these and add the session and the author map.

   Nothing here reads env.MARKETPLACE. The forum's tables are relational
   and are reached directly; the KV shim is for the documents that were
   documents before Postgres. See docs/FORUM-PLAN.md §3.
   ══════════════════════════════════════════════ */

export const PER_PAGE = 20;
export const TITLE_MAX = 120;
export const BODY_MAX = 8000;

/** Errors a caller can show to a person, as opposed to ones it cannot. */
export class ForumError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/* ── Parsing what a URL carries ─────────────────────────────────────── */

/** A bigserial id as a string, or null. Never a number: 2^53 is smaller
    than bigint and an id that lost precision would be somebody else's. */
export function parseId(raw) {
  const m = /^[1-9][0-9]{0,17}$/.exec(String(raw == null ? '' : raw).trim());
  return m ? m[0] : null;
}

export function parsePage(raw) {
  const n = parseInt(String(raw == null ? '' : raw), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 100000);
}

export function parseCategoryId(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(s) ? s : null;
}

/* ── Validating what a person typed ─────────────────────────────────── */

function normalise(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
}

/** Returns { value } or { error }. The database enforces the same caps as
    CHECK constraints; this is the version with a readable message. */
export function validateTitle(raw) {
  const value = normalise(raw).replace(/\s+/g, ' ');
  if (!value) return { error: 'A topic needs a title.' };
  if (value.length > TITLE_MAX) return { error: `Titles are at most ${TITLE_MAX} characters.` };
  return { value };
}

export function validateBody(raw) {
  const value = normalise(raw);
  if (!value) return { error: 'Write something first.' };
  if (value.length > BODY_MAX) return { error: `Posts are at most ${BODY_MAX} characters.` };
  return { value };
}

/* ── Row shaping ────────────────────────────────────────────────────── */

const iso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);

function shapeThread(r) {
  return {
    id: String(r.id),
    categoryId: r.category_id,
    userId: String(r.user_id),
    title: r.title,
    pinned: !!r.pinned,
    locked: !!r.locked,
    replyCount: Number(r.reply_count) || 0,
    createdAt: iso(r.created_at),
    lastPostAt: iso(r.last_post_at),
  };
}

/** A deleted post is a tombstone: who removed it, never what it said.
    `mentions` is who the post @named, resolved at post time — the client
    links exactly those names and no others. */
function shapePost(r) {
  const base = { id: String(r.id), userId: String(r.user_id), createdAt: iso(r.created_at) };
  if (r.deleted_at) {
    return { ...base, deleted: r.deleted_by && String(r.deleted_by) !== String(r.user_id) ? 'moderator' : 'author' };
  }
  return {
    ...base,
    body: r.body,
    editedAt: iso(r.edited_at),
    mentions: Array.isArray(r.mention_ids) ? r.mention_ids.map(String) : [],
  };
}

/** The subquery every post listing carries for shapePost's `mentions`. */
const MENTION_IDS = `(SELECT array_agg(m.user_id ORDER BY m.user_id) FROM forum_mentions m WHERE m.post_id = forum_posts.id) AS mention_ids`;

/* ── Reads ──────────────────────────────────────────────────────────── */

/** Every board with its counts and its most recently active thread. One
    query; the LATERAL join is what keeps it from being N+1. */
export async function listCategories(db) {
  const { rows } = await db.query(`
    SELECT c.id, c.name, c.description, c.position, c.sub_only, c.staff_only,
           (SELECT count(*)::int FROM forum_threads t
              WHERE t.category_id = c.id AND t.deleted_at IS NULL) AS thread_count,
           (SELECT count(*)::int FROM forum_posts p
              JOIN forum_threads t ON t.id = p.thread_id
              WHERE t.category_id = c.id AND t.deleted_at IS NULL AND p.deleted_at IS NULL) AS post_count,
           n.id AS newest_id, n.title AS newest_title, n.user_id AS newest_user_id,
           n.last_post_at AS newest_at
    FROM forum_categories c
    LEFT JOIN LATERAL (
      SELECT id, title, user_id, last_post_at FROM forum_threads t
      WHERE t.category_id = c.id AND t.deleted_at IS NULL
      ORDER BY last_post_at DESC LIMIT 1
    ) n ON true
    ORDER BY c.position, c.id`);
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    subOnly: !!r.sub_only,
    staffOnly: !!r.staff_only,
    threadCount: r.thread_count,
    postCount: r.post_count,
    newest: r.newest_id ? {
      id: String(r.newest_id), title: r.newest_title,
      userId: String(r.newest_user_id), at: iso(r.newest_at),
    } : null,
  }));
}

export async function getCategory(db, id) {
  const { rows } = await db.query(
    `SELECT id, name, description, sub_only, staff_only FROM forum_categories WHERE id = $1`, [id]);
  const r = rows[0];
  return r ? { id: r.id, name: r.name, description: r.description, subOnly: !!r.sub_only, staffOnly: !!r.staff_only } : null;
}

/** One page of a board: pinned first, then by latest activity. `total` is
    the whole board, so the caller can say how many pages there are. */
export async function listThreads(db, categoryId, page = 1, perPage = PER_PAGE) {
  const { rows } = await db.query(`
    SELECT id, category_id, user_id, title, pinned, locked, reply_count, created_at, last_post_at,
           count(*) OVER() AS total
    FROM forum_threads
    WHERE category_id = $1 AND deleted_at IS NULL
    ORDER BY pinned DESC, last_post_at DESC, id DESC
    LIMIT $2 OFFSET $3`, [categoryId, perPage, (page - 1) * perPage]);
  const total = rows.length ? Number(rows[0].total) : await countThreads(db, categoryId);
  return { threads: rows.map(shapeThread), total, pages: Math.max(1, Math.ceil(total / perPage)) };
}

async function countThreads(db, categoryId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM forum_threads WHERE category_id = $1 AND deleted_at IS NULL`, [categoryId]);
  return rows[0].n;
}

/** A thread and the board it sits on. A deleted thread is nobody's to read. */
export async function getThread(db, id) {
  const { rows } = await db.query(`
    SELECT t.id, t.category_id, t.user_id, t.title, t.pinned, t.locked, t.reply_count,
           t.created_at, t.last_post_at, c.name AS category_name
    FROM forum_threads t JOIN forum_categories c ON c.id = t.category_id
    WHERE t.id = $1 AND t.deleted_at IS NULL`, [id]);
  const r = rows[0];
  return r ? { ...shapeThread(r), categoryName: r.category_name } : null;
}

/** One page of a thread, oldest first. Deleted posts are INCLUDED, as
    tombstones: a reply that quoted them still needs something to point at,
    and a page that silently shrank would move every later post. */
export async function listPosts(db, threadId, page = 1, perPage = PER_PAGE) {
  const { rows } = await db.query(`
    SELECT id, user_id, body, edited_at, deleted_at, deleted_by, created_at,
           count(*) OVER() AS total, ${MENTION_IDS}
    FROM forum_posts
    WHERE thread_id = $1
    ORDER BY created_at, id
    LIMIT $2 OFFSET $3`, [threadId, perPage, (page - 1) * perPage]);
  let total = rows.length ? Number(rows[0].total) : 0;
  if (!rows.length) {
    const c = await db.query(`SELECT count(*)::int AS n FROM forum_posts WHERE thread_id = $1`, [threadId]);
    total = c.rows[0].n;
  }
  return { posts: rows.map(shapePost), total, pages: Math.max(1, Math.ceil(total / perPage)) };
}

/** Posts (deleted ones included — deleting your own spam does not refill
    the allowance) this person made in the last `minutes`. */
export async function recentPostCount(db, userId, minutes) {
  const { rows } = await db.query(`
    SELECT count(*)::int AS n FROM forum_posts
    WHERE user_id = $1 AND created_at > now() - ($2 || ' minutes')::interval`, [String(userId), String(minutes)]);
  return rows[0].n;
}

export async function recentThreadCount(db, userId, minutes) {
  const { rows } = await db.query(`
    SELECT count(*)::int AS n FROM forum_threads
    WHERE user_id = $1 AND created_at > now() - ($2 || ' minutes')::interval`, [String(userId), String(minutes)]);
  return rows[0].n;
}

/* ── Writes. Each expects to be INSIDE a transaction. ───────────────── */

/** A thread and its opening post, together or not at all. */
export async function createThread(tx, { categoryId, userId, title, body }) {
  const t = await tx.query(
    `INSERT INTO forum_threads (category_id, user_id, title) VALUES ($1, $2, $3) RETURNING id`,
    [categoryId, String(userId), title]);
  const threadId = String(t.rows[0].id);
  const p = await tx.query(
    `INSERT INTO forum_posts (thread_id, user_id, body) VALUES ($1, $2, $3) RETURNING id`,
    [threadId, String(userId), body]);
  return { threadId, postId: String(p.rows[0].id) };
}

/** A reply. The thread row is locked first so that a lock or a delete
    landing at the same moment is seen rather than raced. */
export async function createReply(tx, { threadId, userId, body }) {
  const t = await tx.query(
    `SELECT user_id, locked, deleted_at FROM forum_threads WHERE id = $1 FOR UPDATE`, [threadId]);
  const row = t.rows[0];
  if (!row || row.deleted_at) throw new ForumError('gone', 'That topic is no longer here.', 404);
  if (row.locked) throw new ForumError('locked', 'That topic is locked.', 403);
  const p = await tx.query(
    `INSERT INTO forum_posts (thread_id, user_id, body) VALUES ($1, $2, $3) RETURNING id`,
    [threadId, String(userId), body]);
  const postId = String(p.rows[0].id);
  await tx.query(
    `UPDATE forum_threads SET reply_count = reply_count + 1, last_post_at = now() WHERE id = $1`, [threadId]);
  /* The person who started the topic hears about replies to it — unless
     the reply is their own. */
  if (String(row.user_id) !== String(userId)) {
    await tx.query(`INSERT INTO notifications (user_id, kind, post_id) VALUES ($1, 'reply', $2)`, [String(row.user_id), postId]);
  }
  return { postId };
}

/* ── One post, for editing or deleting ──────────────────────────────── */

/** A post with what the rules need to know about where it hangs. Deleted
    posts and posts in deleted threads are returned (marked), not hidden:
    the rule decides what to say about them. */
export async function getPost(db, id) {
  const { rows } = await db.query(`
    SELECT p.id, p.thread_id, p.profile_id, p.user_id, p.body, p.deleted_at, p.edited_at, p.created_at,
           t.locked AS thread_locked, t.deleted_at AS thread_deleted_at, t.category_id,
           (p.thread_id IS NOT NULL AND p.id = (SELECT min(id) FROM forum_posts WHERE thread_id = p.thread_id)) AS is_opening
    FROM forum_posts p LEFT JOIN forum_threads t ON t.id = p.thread_id
    WHERE p.id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    threadId: r.thread_id == null ? null : String(r.thread_id),
    profileId: r.profile_id == null ? null : String(r.profile_id),
    categoryId: r.category_id || null,
    userId: String(r.user_id),
    body: r.body,
    deleted: !!r.deleted_at,
    editedAt: iso(r.edited_at),
    createdAt: iso(r.created_at),
    threadLocked: !!r.thread_locked,
    threadDeleted: !!r.thread_deleted_at,
    isOpening: !!r.is_opening,
  };
}

/** Replace the body and stamp edited_at. False if the post was deleted
    between the rule check and here. */
export async function editPost(tx, { id, body }) {
  const { rows } = await tx.query(
    `UPDATE forum_posts SET body = $2, edited_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id, body]);
  return rows.length === 1;
}

/** Soft-delete your own post. deleted_by = the author, which is what makes
    the tombstone read "removed by the author". A reply also gives back its
    count on the thread; the opening post does not, since it was never
    counted as one. */
export async function deleteOwnPost(tx, { id, userId }) {
  const { rows } = await tx.query(`
    UPDATE forum_posts SET deleted_at = now(), deleted_by = $2
    WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
    RETURNING thread_id,
      (thread_id IS NOT NULL AND id = (SELECT min(id) FROM forum_posts x WHERE x.thread_id = forum_posts.thread_id)) AS is_opening`,
    [id, String(userId)]);
  if (rows.length !== 1) return false;
  const r = rows[0];
  if (r.thread_id != null && !r.is_opening) {
    await tx.query(
      `UPDATE forum_threads SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = $1`, [r.thread_id]);
  }
  return true;
}

/** Which page of its thread a post is on, so a reply can land the person
    on the post they just wrote. Tombstones count: they occupy a slot. */
export async function pageOfPost(db, threadId, postId, perPage = PER_PAGE) {
  const { rows } = await db.query(`
    SELECT count(*)::int AS n FROM forum_posts
    WHERE thread_id = $1
      AND (created_at, id) <= (SELECT created_at, id FROM forum_posts WHERE id = $2)`,
    [threadId, postId]);
  return Math.max(1, Math.ceil(rows[0].n / perPage));
}

/* ── Moderation ─────────────────────────────────────────────────────── */

/** Pin, unpin, lock, unlock. Only the flags given are touched. */
export async function setThreadFlags(tx, id, { pinned, locked }) {
  const sets = [];
  const params = [id];
  if (typeof pinned === 'boolean') { params.push(pinned); sets.push(`pinned = $${params.length}`); }
  if (typeof locked === 'boolean') { params.push(locked); sets.push(`locked = $${params.length}`); }
  if (!sets.length) return false;
  const { rows } = await tx.query(
    `UPDATE forum_threads SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, params);
  return rows.length === 1;
}

/** A whole topic, off the board. Its posts are untouched: restoring the
    thread brings them all back exactly as they were. */
export async function deleteThread(tx, { id, byUserId }) {
  const { rows } = await tx.query(
    `UPDATE forum_threads SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id, String(byUserId)]);
  return rows.length === 1;
}

export async function restoreThread(tx, { id }) {
  const { rows } = await tx.query(
    `UPDATE forum_threads SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [id]);
  return rows.length === 1;
}

/** A moderator removing a post. Records who and why, gives a reply's
    count back to its thread, and tells the author — in the same
    transaction, so the notification exists only if the removal does.
    A moderator removing their OWN post is an author delete and is not
    notified about it. */
export async function moderateDeletePost(tx, { id, byUserId, reason }) {
  const { rows } = await tx.query(`
    UPDATE forum_posts SET deleted_at = now(), deleted_by = $2, delete_reason = $3
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING user_id, thread_id,
      (thread_id IS NOT NULL AND id = (SELECT min(id) FROM forum_posts x WHERE x.thread_id = forum_posts.thread_id)) AS is_opening`,
    [id, String(byUserId), reason]);
  if (rows.length !== 1) return false;
  const r = rows[0];
  if (r.thread_id != null && !r.is_opening) {
    await tx.query(`UPDATE forum_threads SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = $1`, [r.thread_id]);
  }
  if (String(r.user_id) !== String(byUserId)) {
    await tx.query(`INSERT INTO notifications (user_id, kind, post_id) VALUES ($1, 'moderation', $2)`, [String(r.user_id), id]);
  }
  return true;
}

/** Undo a removal, whoever made it. The count comes back with it. */
export async function restorePost(tx, { id }) {
  const { rows } = await tx.query(`
    UPDATE forum_posts SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
    WHERE id = $1 AND deleted_at IS NOT NULL
    RETURNING thread_id,
      (thread_id IS NOT NULL AND id = (SELECT min(id) FROM forum_posts x WHERE x.thread_id = forum_posts.thread_id)) AS is_opening`,
    [id]);
  if (rows.length !== 1) return false;
  const r = rows[0];
  if (r.thread_id != null && !r.is_opening) {
    await tx.query(`UPDATE forum_threads SET reply_count = reply_count + 1 WHERE id = $1`, [r.thread_id]);
  }
  return true;
}

/** One person flagging one post. A second press by the same person is
    the UNIQUE constraint's business and comes back as `false`, not an
    error. */
export async function reportPost(tx, { postId, reporterId, reason }) {
  const { rows } = await tx.query(`
    INSERT INTO forum_reports (post_id, reporter_id, reason) VALUES ($1, $2, $3)
    ON CONFLICT (post_id, reporter_id) DO NOTHING RETURNING id`,
    [postId, String(reporterId), reason]);
  return rows.length === 1;
}

/** The queue, oldest first, one row per report, with enough of the post
    to judge it without opening the thread. Reports on posts that have
    since been removed stay in the queue until resolved: somebody still
    has to say the matter is closed. */
export async function listOpenReports(db, limit = 50) {
  const { rows } = await db.query(`
    SELECT r.id, r.post_id, r.reporter_id, r.reason, r.created_at,
           p.user_id AS author_id, p.thread_id, p.profile_id, p.deleted_at AS post_deleted_at,
           left(p.body, 240) AS excerpt,
           t.title AS thread_title
    FROM forum_reports r
    JOIN forum_posts p ON p.id = r.post_id
    LEFT JOIN forum_threads t ON t.id = p.thread_id
    WHERE r.resolved_at IS NULL
    ORDER BY r.created_at, r.id
    LIMIT $1`, [limit]);
  return rows.map(r => ({
    id: String(r.id),
    postId: String(r.post_id),
    reporterId: String(r.reporter_id),
    reason: r.reason,
    at: iso(r.created_at),
    authorId: String(r.author_id),
    threadId: r.thread_id == null ? null : String(r.thread_id),
    threadTitle: r.thread_title || null,
    profileId: r.profile_id == null ? null : String(r.profile_id),
    postDeleted: !!r.post_deleted_at,
    excerpt: r.excerpt,
  }));
}

export async function openReportCount(db) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM forum_reports WHERE resolved_at IS NULL`);
  return rows[0].n;
}

/** Close one report. Resolving a post's other reports too is deliberate:
    a moderator who has looked at a post has looked at it. */
export async function resolveReports(tx, { postId, byUserId }) {
  const { rows } = await tx.query(`
    UPDATE forum_reports SET resolved_at = now(), resolved_by = $2
    WHERE post_id = $1 AND resolved_at IS NULL RETURNING id`, [postId, String(byUserId)]);
  return rows.length;
}

/* ── Profile comments ───────────────────────────────────────────────── */

/** One page of a profile's wall, newest first. Removed comments are left
    out: nothing on a wall replies to anything else, so there is no hole
    to mark, and the partial index serves exactly this query. */
export async function listComments(db, profileId, page = 1, perPage = PER_PAGE) {
  const { rows } = await db.query(`
    SELECT id, user_id, body, edited_at, created_at, count(*) OVER() AS total, ${MENTION_IDS}
    FROM forum_posts
    WHERE profile_id = $1 AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT $2 OFFSET $3`, [String(profileId), perPage, (page - 1) * perPage]);
  let total = rows.length ? Number(rows[0].total) : 0;
  if (!rows.length) total = await commentCount(db, profileId);
  return { comments: rows.map(shapePost), total, pages: Math.max(1, Math.ceil(total / perPage)) };
}

export async function commentCount(db, profileId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM forum_posts WHERE profile_id = $1 AND deleted_at IS NULL`, [String(profileId)]);
  return rows[0].n;
}

/** A comment, and the owner told about it in the same transaction — unless
    they wrote it themselves. */
export async function createComment(tx, { profileId, userId, body }) {
  const p = await tx.query(
    `INSERT INTO forum_posts (profile_id, user_id, body) VALUES ($1, $2, $3) RETURNING id`,
    [String(profileId), String(userId), body]);
  const postId = String(p.rows[0].id);
  if (String(profileId) !== String(userId)) {
    await tx.query(`INSERT INTO notifications (user_id, kind, post_id) VALUES ($1, 'comment', $2)`, [String(profileId), postId]);
  }
  return { postId };
}

/* ── Mentions and notifications ─────────────────────────────────────── */

/** Record who a post @named and tell each of them — in the post's own
    transaction, so a mention exists only if the post does. Naming
    yourself is not a mention; naming the same person twice is one. */
export async function addMentions(tx, { postId, byUserId, userIds }) {
  let added = 0;
  for (const raw of userIds || []) {
    const userId = String(raw);
    if (userId === String(byUserId)) continue;
    const { rows } = await tx.query(
      `INSERT INTO forum_mentions (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING post_id`,
      [postId, userId]);
    if (!rows.length) continue;
    await tx.query(`INSERT INTO notifications (user_id, kind, post_id) VALUES ($1, 'mention', $2)`, [userId, postId]);
    added++;
  }
  return added;
}

/** What has happened to this person, newest first, with enough of the
    cause to say it in one line: who did it, where, and — for a removal —
    why. A notification whose post has since been removed still lists;
    the client says so rather than linking to a tombstone. */
export async function listNotifications(db, userId, limit = 30) {
  const { rows } = await db.query(`
    SELECT n.id, n.kind, n.post_id, n.read_at, n.created_at,
           p.user_id AS actor_id, p.thread_id, p.profile_id, p.deleted_at AS post_deleted_at,
           p.delete_reason, left(p.body, 120) AS excerpt,
           t.title AS thread_title
    FROM notifications n
    LEFT JOIN forum_posts p ON p.id = n.post_id
    LEFT JOIN forum_threads t ON t.id = p.thread_id
    WHERE n.user_id = $1
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT $2`, [String(userId), limit]);
  return rows.map(r => ({
    id: String(r.id),
    kind: r.kind,
    postId: r.post_id == null ? null : String(r.post_id),
    actorId: r.actor_id == null ? null : String(r.actor_id),
    threadId: r.thread_id == null ? null : String(r.thread_id),
    threadTitle: r.thread_title || null,
    profileId: r.profile_id == null ? null : String(r.profile_id),
    postDeleted: !!r.post_deleted_at,
    reason: r.delete_reason || null,
    excerpt: r.excerpt || '',
    read: !!r.read_at,
    at: iso(r.created_at),
  }));
}

export async function unreadCount(db, userId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [String(userId)]);
  return rows[0].n;
}

/** Mark read: the ids given, or everything unread when none are. Scoped
    to the user, so one person's ids cannot mark another's. */
export async function markNotificationsRead(tx, userId, ids = null) {
  const params = [String(userId)];
  let where = `user_id = $1 AND read_at IS NULL`;
  if (Array.isArray(ids) && ids.length) {
    params.push(ids.map(String));
    where += ` AND id = ANY($2::bigint[])`;
  }
  const { rows } = await tx.query(`UPDATE notifications SET read_at = now() WHERE ${where} RETURNING id`, params);
  return rows.length;
}

/** The distinct people on a page, for the caller to turn into identities:
    authors, the newest-thread author on a board, actors on notifications,
    and everyone a post @named — mentioned names are linked by login, so
    the client needs those identities too. */
export function authorIds(...lists) {
  const out = new Set();
  for (const list of lists) for (const x of list || []) {
    if (!x) continue;
    if (x.userId) out.add(String(x.userId));
    if (x.actorId) out.add(String(x.actorId));
    if (x.newest && x.newest.userId) out.add(String(x.newest.userId));
    if (Array.isArray(x.mentions)) for (const m of x.mentions) out.add(String(m));
  }
  return [...out];
}
