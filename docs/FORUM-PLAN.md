# Community Forum — plan

**Status:** proposed, nothing built.
**Owner:** `chat-system` agent (per CLAUDE.md).

`community.html` is a 74-line placeholder. There is no forum, no comment
system, and no notifications. This plan covers all three, because the profile
editor's **Comments** and **Mentions** tabs are not profile features — they are
a comment system and a notification system wearing profile clothing, and
building them as profile features would mean building them twice.

---

## 1. What this is for

A place for the community to talk when the stream is offline. Threads that
outlive a chat message, readable by anyone, postable by anyone logged in.

**Explicitly not** a chat replacement. Live conversation happens on Twitch; the
forum is for things worth keeping — deck lists, clips, event planning,
introductions.

---

## 2. The architectural decision

**Build this on real relational tables, not through the KV shim.**

Every other feature on this site mirrors a key-value document, because that is
what it was before Postgres. A forum is the first thing here that is genuinely
relational: posts belong to threads, threads to categories, and the questions
asked of it — *the twenty newest threads*, *page three of this thread*, *every
mention of this user*, *how many posts has this person made* — are joins and
ranges, not key lookups.

Forcing that through a JSONB document per thread means reading and rewriting an
entire thread to add one post, which is both a lost-update race and an
unbounded row. The KV shim stays for everything that already uses it; this gets
proper tables.

```sql
CREATE TABLE forum_categories (
  id          text PRIMARY KEY,          -- 'general', 'decks', 'events'
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  position    int  NOT NULL DEFAULT 0,
  min_role    text NOT NULL DEFAULT 'viewer',   -- who may post here
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE forum_threads (
  id           bigserial PRIMARY KEY,
  category_id  text NOT NULL REFERENCES forum_categories(id),
  user_id      text NOT NULL,
  title        text NOT NULL,
  pinned       boolean NOT NULL DEFAULT false,
  locked       boolean NOT NULL DEFAULT false,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Denormalised so a category listing is one query rather than N+1.
  -- Maintained by the same transaction that writes a post.
  reply_count  int NOT NULL DEFAULT 0,
  last_post_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON forum_threads (category_id, pinned DESC, last_post_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE forum_posts (
  id         bigserial PRIMARY KEY,
  thread_id  bigint REFERENCES forum_threads(id),
  -- A profile comment is a post with no thread. One table, because a comment
  -- and a reply differ in where they hang, not in what they are: same
  -- editing, same moderation, same mention parsing, same reporting.
  profile_id text,
  user_id    text NOT NULL,
  body       text NOT NULL,
  edited_at  timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_home CHECK ((thread_id IS NULL) <> (profile_id IS NULL))
);
CREATE INDEX ON forum_posts (thread_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX ON forum_posts (profile_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE forum_mentions (
  post_id     bigint NOT NULL REFERENCES forum_posts(id),
  user_id     text NOT NULL,              -- who was mentioned
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX ON forum_mentions (user_id, created_at DESC);

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL,
  kind       text NOT NULL,               -- 'mention' | 'reply' | 'moderation'
  post_id    bigint REFERENCES forum_posts(id),
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, read_at NULLS FIRST, created_at DESC);
```

**Nothing is hard-deleted.** `deleted_at` everywhere, because a forum without an
undo is a forum where one mis-click by a moderator is unrecoverable, and because
a deleted post that took a thread's replies with it is worse than the post.

---

## 3. Who can do what

Authorisation reads the moderator list and the broadcaster id on every request,
the way `isModerator()` already does. **Never the `role` field on the session** —
that is a display ladder in which moderator outranks every sub tier, and reading
it for authorisation has already cost this codebase three separate bugs.

| | Viewer | Logged in | Subscriber | Moderator |
|---|---|---|---|---|
| Read | yes | yes | yes | yes |
| Post / reply | — | yes | yes | yes |
| Edit own post | — | yes | yes | yes |
| Delete own post | — | yes | yes | yes |
| Post in a sub-only category | — | — | yes | yes |
| Pin / lock a thread | — | — | — | yes |
| Delete anyone's post | — | — | — | yes |

`min_role` on a category is what makes a subscriber-only space possible without
a second system.

---

## 4. Moderation

- **Soft delete only**, with the moderator and a reason recorded.
- **A deleted post leaves a tombstone** — "removed by a moderator" — rather than
  vanishing, so a conversation that replied to it still reads.
- **Report button** on every post, writing to a queue a moderator can work
  through. Without one, moderation depends on a moderator happening to be
  reading the thread.
- **Locking a thread** stops new replies and leaves the thread readable.
- **Rate limits** on posting: a handful per minute, enforced server-side against
  the user id. The existing drop-cooldown pattern is the shape to copy.
- **Length caps**: title 120, body 8000. Enforced server-side, because a client
  that enforces a limit is a suggestion.

Bodies are stored as plain text and **escaped on render**, never stored as HTML.
A forum that accepts markup is a forum that accepts an injection, and the
overlay already demonstrates the escaping discipline this site uses.

---

## 5. Profile comments and mentions

The profile editor's two tabs are this system, exposed on a profile:

- **Comments on your profile** — `forum_posts` rows with `profile_id` set and
  `thread_id` null. The toggle sets `comments_enabled` on the profile record.
  Turning it off stops new posts and leaves existing ones readable, exactly as
  the reference describes.
- **Mentions** — `@login` is parsed out of a body at post time, resolved through
  `loginidx_` (which already exists), and written to `forum_mentions`. A
  notification follows unless the mentioned person has mentions off.

Parsing at post time rather than render time is what makes "every mention of
me" a index range rather than a scan of every post ever written.

**Opting out of mentions means the name stops linking**, not that the text is
removed. Someone can still type it; it just does not resolve or notify.

---

## 6. Notifications

The smallest thing that works: a bell in the header with an unread count, and a
list. `notifications` rows are written in the same transaction as the post that
caused them, so a notification cannot exist for a post that failed to save.

Deliberately **not** doing email, push, or Twitch whispers in this iteration.
Each is a delivery channel with its own failure modes and consent question, and
none of them is needed to make the forum usable.

---

## 7. What it looks like

Three pages, in the site's existing gothic black-and-red:

- **`community.html`** — categories, each with its newest thread and a count.
- **`thread.html?id=`** — one thread, paginated, oldest first, reply box at the
  bottom.
- **`profile.html?u=`** — the comments section lives here, under the profile.

Every post shows the author's **avatar, display name, equipped title and badge
showcase** — the profile identity record and `/api/profile` already return all
of it, which is most of why profiles came first.

---

## 8. Build order

1. **Schema and the data layer.** Tables, plus the handful of queries each page
   needs, written as functions with tests against a scratch database.
2. **Read-only forum.** Categories and threads render; nothing can be posted.
   Proves the shape before anything is user-generated.
3. **Posting** — threads, replies, edit, delete-own. Rate limits and length caps
   from the start, not retrofitted.
4. **Moderation** — pin, lock, delete-any, tombstones, the report queue.
5. **Profile comments**, which is step 3 pointed at a `profile_id`.
6. **Mentions and notifications.**

Steps 1–4 are a forum. Step 5 is the reference's Comments tab and step 6 is its
Mentions tab; both are small once the posts table exists, and neither is worth
building first.

---

## 9. Open questions

- **Which categories at launch?** They are rows, so adding one later is trivial,
  but starting with the wrong five makes a forum look dead.
- **Should subscriber-only categories exist at launch**, or is that a later
  addition once there is traffic to divide?
- **Is a report queue needed on day one?** It depends on expected volume — a
  small community with active moderators may not need one initially, but
  retrofitting it means retrofitting the UI on every post.
- **Editing history.** Currently `edited_at` only. Keeping full history is a
  bigger table and a moderation aid; worth deciding before people rely on edits.
