-- ══════════════════════════════════════════════
-- 009 — Forum social: follows, unread, reactions, moderation log
--
-- Apply AFTER 006_forum.sql:
--   node server/scripts/apply-sql.js --service phantomace-web server/sql/009_forum_social.sql
--   node server/scripts/apply-sql.js --service phantomace-web server/sql/009_forum_social.sql --confirm
--
-- Idempotent. CREATE ... IF NOT EXISTS throughout; the one CHECK it widens
-- is dropped and re-added, which re-running leaves exactly as it found it.
-- One transaction, so a half-applied social layer cannot exist.
--
-- THESE ARE REAL RELATIONAL TABLES, same as 006 — nothing here is KV. They
-- hang off forum_threads and forum_posts and are reached through
-- server/lib/db.js. Behaviour is verified by
-- server/scripts/test-forum-social.js against pglite with 006 + 009 applied.
--
-- Soft-delete/restore needs no new column: 006 already gives forum_posts and
-- forum_threads deleted_at / deleted_by (and forum_posts delete_reason), and
-- queries.js already restores both. 009 only records WHO did it, in
-- forum_mod_log.
-- ══════════════════════════════════════════════

BEGIN;

-- Following a topic: one row per person per topic. The PK makes a second
-- press a no-op (ON CONFLICT DO NOTHING), and "who follows this topic" the
-- range the reply path reads to notify them.
CREATE TABLE IF NOT EXISTS forum_thread_follows (
  thread_id  bigint NOT NULL REFERENCES forum_threads(id),
  user_id    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);
-- "Topics I follow", newest-followed first.
CREATE INDEX IF NOT EXISTS forum_follows_by_user
  ON forum_thread_follows (user_id, created_at DESC);

-- Where a person last read a topic. A topic is unread for them when its
-- last_post_at is newer than their last_read_at — so a topic never opened
-- carries no marker (no row), and opening one clears it (upsert to now()).
-- The PK is the exact lookup: one (thread, user) pair at a time.
CREATE TABLE IF NOT EXISTS forum_thread_reads (
  thread_id    bigint NOT NULL REFERENCES forum_threads(id),
  user_id      text NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

-- A reaction is one person placing one mark on one post. The PK allows a
-- person several different marks on a post but not the same one twice, and
-- answers "every reaction on these posts" by its post_id prefix. The mark
-- is a short id from a closed set the handler enforces (the room guestbook's
-- twelve stamps); the CHECK is the belt to that handler's braces.
CREATE TABLE IF NOT EXISTS forum_reactions (
  post_id    bigint NOT NULL REFERENCES forum_posts(id),
  user_id    text NOT NULL,
  emoji      text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 24),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id, emoji)
);

-- The moderation record. Every reversible thing a moderator does leaves a
-- line here: who, what, to which thread or post, and the reason or note.
-- target_id has no foreign key on purpose — a thread id and a post id share
-- the column, told apart by target_type — and nothing is ever deleted from
-- it, so a restored post still carries the line that removed it.
CREATE TABLE IF NOT EXISTS forum_mod_log (
  id          bigserial PRIMARY KEY,
  actor_id    text NOT NULL,
  action      text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('thread','post','report')),
  target_id   bigint NOT NULL,
  detail      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forum_mod_log_recent ON forum_mod_log (created_at DESC, id DESC);

-- A follow adds one notification kind: "somebody replied to a topic you
-- follow". The thread's starter still gets 'reply'; followers who are not
-- the starter get 'follow', so neither is told twice. Reactions deliberately
-- send no notification — the notifications row derives its actor from the
-- referenced post's author, which for a reaction is the recipient, not the
-- reactor, and a reaction bar updating live says it better than a bell would.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('mention','reply','comment','moderation','follow'));

COMMIT;
