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

/** A deleted post is a tombstone: who removed it, never what it said. */
function shapePost(r) {
  const base = { id: String(r.id), userId: String(r.user_id), createdAt: iso(r.created_at) };
  if (r.deleted_at) {
    return { ...base, deleted: r.deleted_by && String(r.deleted_by) !== String(r.user_id) ? 'moderator' : 'author' };
  }
  return { ...base, body: r.body, editedAt: iso(r.edited_at) };
}

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
           count(*) OVER() AS total
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
    `SELECT locked, deleted_at FROM forum_threads WHERE id = $1 FOR UPDATE`, [threadId]);
  const row = t.rows[0];
  if (!row || row.deleted_at) throw new ForumError('gone', 'That topic is no longer here.', 404);
  if (row.locked) throw new ForumError('locked', 'That topic is locked.', 403);
  const p = await tx.query(
    `INSERT INTO forum_posts (thread_id, user_id, body) VALUES ($1, $2, $3) RETURNING id`,
    [threadId, String(userId), body]);
  await tx.query(
    `UPDATE forum_threads SET reply_count = reply_count + 1, last_post_at = now() WHERE id = $1`, [threadId]);
  return { postId: String(p.rows[0].id) };
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

/** The distinct authors on a page, for the caller to turn into identities. */
export function authorIds(...lists) {
  const out = new Set();
  for (const list of lists) for (const x of list || []) {
    const id = x && (x.userId || (x.newest && x.newest.userId));
    if (id) out.add(String(id));
  }
  return [...out];
}
