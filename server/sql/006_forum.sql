-- ══════════════════════════════════════════════
-- 006 — Community forum, profile comments, mentions, notifications
--
-- Apply AFTER 005_profiles.sql:
--   node server/scripts/apply-sql.js server/sql/006_forum.sql --service phantomace-web
--   node server/scripts/apply-sql.js server/sql/006_forum.sql --service phantomace-web --confirm
--
-- Idempotent. Re-running it changes nothing.
--
-- THESE ARE REAL RELATIONAL TABLES, NOT KV FAMILIES. Nothing here goes
-- through registry.js or the MARKETPLACE shim, and no key prefix maps to
-- them. A forum is the first thing on this site whose questions are joins
-- and ranges — the newest threads in a category, page three of a thread,
-- every mention of one person — and a JSONB document per thread would have
-- to be read and rewritten whole to add a single reply. Handlers reach
-- these through server/lib/db.js (getPool / withTransaction), the way
-- milestones.js already reaches server/lib/eventsub.js.
--
-- NOTHING IS HARD-DELETED. Every user-facing row has deleted_at, and a
-- moderator delete also records deleted_by and delete_reason, because a
-- forum without an undo is one where a mis-click is permanent.
--
-- Length caps are CHECK constraints as well as handler checks. The handler
-- gives a readable error; the constraint means a handler that forgot to
-- cannot put a novel in a row.
--
-- Behaviour verified by server/scripts/test-forum-schema.js against a real
-- Postgres 18 (in-process, via pglite): every constraint below refuses what
-- it should, and every listed query uses an index at 20,000 rows.
-- ══════════════════════════════════════════════

BEGIN;

-- Categories are rows so adding one is an INSERT, not a deploy.
--   sub_only    only subscribers (and staff) may start threads or reply
--   staff_only  only moderators and the broadcaster may post — announcements
-- Neither column is a role name. Authorisation reads the moderator list and
-- subTier, never the session's display `role`.
CREATE TABLE IF NOT EXISTS forum_categories (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  position    int  NOT NULL DEFAULT 0,
  sub_only    boolean NOT NULL DEFAULT false,
  staff_only  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A thread's opening post is its first forum_posts row, not a column here.
-- reply_count and last_post_at are denormalised so a category listing is
-- one query; both are maintained inside the transaction that writes or
-- soft-deletes a post. `reply_count = reply_count + 1` is atomic under the
-- row lock, so two simultaneous replies cannot lose an increment.
CREATE TABLE IF NOT EXISTS forum_threads (
  id           bigserial PRIMARY KEY,
  category_id  text NOT NULL REFERENCES forum_categories(id),
  user_id      text NOT NULL,
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  pinned       boolean NOT NULL DEFAULT false,
  locked       boolean NOT NULL DEFAULT false,
  deleted_at   timestamptz,
  deleted_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reply_count  int NOT NULL DEFAULT 0,
  last_post_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forum_threads_listing
  ON forum_threads (category_id, pinned DESC, last_post_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS forum_threads_by_user
  ON forum_threads (user_id, created_at DESC) WHERE deleted_at IS NULL;

-- A profile comment is a post with profile_id set and thread_id null. One
-- table, because a comment and a reply differ in where they hang, not in
-- what they are: same editing, same moderation, same mentions, same
-- reporting. one_home makes exactly one of the two mandatory.
--
-- body is plain text, escaped at render. Never HTML.
CREATE TABLE IF NOT EXISTS forum_posts (
  id            bigserial PRIMARY KEY,
  thread_id     bigint REFERENCES forum_threads(id),
  profile_id    text,
  user_id       text NOT NULL,
  body          text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  edited_at     timestamptz,
  deleted_at    timestamptz,
  deleted_by    text,
  delete_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_home CHECK ((thread_id IS NULL) <> (profile_id IS NULL))
);
-- NOT partial, and that is deliberate. A thread page includes its deleted
-- posts as tombstones, so the page query has no deleted_at filter and a
-- partial index would not serve it. (An earlier revision had the partial
-- form; the DROP retires it wherever it was applied.)
DROP INDEX IF EXISTS forum_posts_thread_page;
CREATE INDEX IF NOT EXISTS forum_posts_thread_order
  ON forum_posts (thread_id, created_at, id);
CREATE INDEX IF NOT EXISTS forum_posts_profile_wall
  ON forum_posts (profile_id, created_at DESC) WHERE deleted_at IS NULL;
-- Not partial: the rate limit counts deleted posts too, or deleting your
-- own spam would refill your allowance.
CREATE INDEX IF NOT EXISTS forum_posts_by_user
  ON forum_posts (user_id, created_at DESC);

-- Parsed out of the body at post time, so "every mention of me" is an index
-- range rather than a scan of every post ever written. The PK dedupes a
-- name typed twice; the insert uses ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS forum_mentions (
  post_id     bigint NOT NULL REFERENCES forum_posts(id),
  user_id     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS forum_mentions_by_user ON forum_mentions (user_id, created_at DESC);

-- The moderation queue. One report per person per post; a second press is
-- a no-op, not a second row.
CREATE TABLE IF NOT EXISTS forum_reports (
  id          bigserial PRIMARY KEY,
  post_id     bigint NOT NULL REFERENCES forum_posts(id),
  reporter_id text NOT NULL,
  reason      text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  UNIQUE (post_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS forum_reports_open ON forum_reports (created_at) WHERE resolved_at IS NULL;

-- Written in the same transaction as the post that caused them, so a
-- notification cannot exist for a post that failed to save.
--   mention     somebody @named you
--   reply       somebody replied in a thread you started
--   comment     somebody commented on your profile
--   moderation  a moderator removed something of yours
CREATE TABLE IF NOT EXISTS notifications (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('mention','reply','comment','moderation')),
  post_id    bigint REFERENCES forum_posts(id),
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_list   ON notifications (user_id, created_at DESC);

-- The six categories the localStorage prototype already shipped with, in
-- its order. Announcements is staff-only; nothing is sub-only at launch.
INSERT INTO forum_categories (id, name, description, position, staff_only) VALUES
  ('announcements', 'Announcements',          'Stream schedules, community updates, and important news from PhantomACE.', 0, true),
  ('general',       'General Discussion',     'Talk about anything: streams, games, music, life. All chaos welcome.',      1, false),
  ('gaming',        'Gaming',                 'MTG Commander, co-op sessions, game recommendations, and lobby invites.',    2, false),
  ('creative',      'Creative Corner',        'Fan art, clips, edits, memes, and anything creative from the community.',   3, false),
  ('highlights',    'Stream Highlights',      'Best moments, clutch plays, and legendary fails from the stream.',          4, false),
  ('feedback',      'Suggestions & Feedback', 'Ideas for streams, events, website features, and community improvements.', 5, false)
ON CONFLICT (id) DO NOTHING;

COMMIT;
