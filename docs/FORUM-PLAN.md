# Community Forum — plan

**Status:** schema written and tested (`server/sql/006_forum.sql`, 34 assertions in
`server/scripts/test-forum-schema.js`). Nothing applied to the rig, nothing served.
**Owner:** `chat-system` agent (per CLAUDE.md).

**Revision note.** The first draft of this plan was reviewed by executing its
schema against a real Postgres 18. Five of its claims did not hold: it promised
a report queue and a recorded moderator + reason for every delete and stored
neither; two of the queries it listed as cheap ("how many posts has this
person made", the posting rate limit) had no index and seq-scanned at 20,000
rows; its `min_role` column was a role name in a codebase whose own rule is
never to authorise on one. It also said "there is no forum" when a 264-line
localStorage prototype ships today, pointed at `profile.html?u=` after
profiles moved to `/user/<login>`, and proposed a header bell that already
exists. All of that is corrected below; the tests are what keep it corrected.

---

## 1. What this is for

A place for the community to talk when the stream is offline. Threads that
outlive a chat message, readable by anyone, postable by anyone logged in.

**Explicitly not** a chat replacement. Live conversation happens on Twitch; the
forum is for things worth keeping — deck lists, clips, event planning,
introductions.

This also covers **profile comments** and **notifications**, because the
profile editor's Comments and Mentions tabs are a comment system and a
notification system wearing profile clothing, and building them as profile
features would mean building them twice.

---

## 2. What exists today

- `community.html` — the shell, with a "Forums Coming Soon" overlay on top of
  `#forumBreadcrumb` / `#forumView`. The sub-nav (Forums / Phamily Time /
  Leaderboards) and Discord link stay.
- `js/pages/community-forums.js` — a working prototype against
  **localStorage**: six categories, home → category → thread views, breadcrumb,
  new-thread and reply forms, `escHtml`, `timeAgo`. Its data layer
  (`getForumData` / `saveForumData`) and its fake login (`promptLogin`, a name in
  `pa_forum_user`) are what get replaced; the view structure and the markup it
  renders are worth keeping.
- `css/pages/community.css` — 708 lines, already styles the cards, thread rows
  and forms the prototype renders.
- `js/notifications.js` + `#notifBell` in `components.js` — a header bell with
  an unread badge and a panel, fed today by live/offline events kept in
  localStorage. **This is the bell.** The forum adds a server-side source to
  it; it does not add a second bell.
- `/api/profile` — returns display name, avatar, equipped title/badge and the
  badge showcase for any user; `loginidx_<login>` → user id, verified against
  the profile record so a renamed-and-reassigned login resolves to nobody.
- `functions/api/admin/moderators.js` — `isModerator(env, session)` and
  `isBroadcaster(env, session)`, which read the moderator list and the
  broadcaster id, not the session's `role`.

---

## 3. The architectural decision

**Real relational tables, reached through `server/lib/db.js`. Not the KV shim.**

Every other feature mirrors a key-value document because that is what it was
on Cloudflare. A forum is the first thing here that is genuinely relational:
posts belong to threads, threads to categories, and the questions asked of it
— *the twenty newest threads*, *page three of this thread*, *every mention of
this user* — are joins and ranges. A JSONB document per thread would have to be
read and rewritten whole to add one reply: a lost-update race and an unbounded
row.

**How a handler gets at it.** The first draft never said. Handlers receive only
`env.MARKETPLACE` and `env.MEDIA_STORE`; there is no pool on `env`. The answer
is a direct import — `import { getPool, withTransaction } from
'../../server/lib/db.js'` — for which `functions/api/milestones.js` importing
`server/lib/eventsub.js` is the precedent. The pool is created once at boot in
`server/index.js` before any route is registered, so `getPool()` is always
populated by the time a request arrives. Consequence, stated plainly: forum
handlers do not run under `wrangler pages dev`. Neither does anything else the
rig does now, so this changes nothing in practice.

**The tables** are in `server/sql/006_forum.sql`, which is the source of truth;
the shape, for reading:

| table | what a row is | key decisions |
|---|---|---|
| `forum_categories` | a board | `sub_only`, `staff_only` booleans — **not** a role name |
| `forum_threads` | a topic; its opening post is its first `forum_posts` row | `reply_count`, `last_post_at` denormalised and maintained in the post transaction |
| `forum_posts` | a reply **or** a profile comment | `one_home` CHECK: exactly one of `thread_id` / `profile_id`; `deleted_by`, `delete_reason` |
| `forum_mentions` | "post P mentioned user U" | PK dedupes; `ON CONFLICT DO NOTHING` |
| `forum_reports` | one person flagging one post | `UNIQUE (post_id, reporter_id)` |
| `notifications` | one thing to tell one person | `kind` is CHECKed; written in the same transaction as its cause |

**Length caps are CHECK constraints as well as handler checks.** Title 120,
body 8000, report reason 500. The handler produces the readable error; the
constraint means a handler that forgets cannot put a novel in a row.

**Nothing is hard-deleted.** `deleted_at` everywhere, and a moderator delete
also records `deleted_by` and `delete_reason` — the first draft promised that in
prose and had no column for it.

**What the test proves** (`npm run test-forum-schema`, in-process Postgres via
pglite, no server needed): the migration applies twice; every cap and the
`one_home` rule refuse what they should; a reply's transaction advances
`reply_count` and a notification written beside a failing post rolls back with
it; soft-deleting the opening post leaves the replies readable; and **all nine
queries the pages run use an index at 20,000 rows** — category listing, thread
page, profile wall, threads-by-user, post count, rate-limit window, unread
count, notification list, open report queue.

---

## 4. Who can do what

Authorisation reads the moderator list and the broadcaster id on every request
through `isModerator()` / `isBroadcaster()`, and subscriber status through
`session.subTier`. **Never the `role` field** — that is a display ladder in
which moderator outranks every sub tier, and reading it for authorisation has
cost this codebase three separate bugs.

| | Guest | Logged in | Subscriber | Moderator / broadcaster |
|---|---|---|---|---|
| Read | yes | yes | yes | yes |
| Start a thread, reply, comment on a profile | — | yes | yes | yes |
| Edit / delete own post | — | yes | yes | yes |
| Report a post | — | yes | yes | yes |
| Post in a `sub_only` category | — | — | yes | yes |
| Post in a `staff_only` category (Announcements) | — | — | — | yes |
| Pin / lock a thread, delete anyone's post, work the report queue | — | — | — | yes |

*staff* = `isModerator(env, session) || isBroadcaster(env, session)`.
*subscriber* = `Number(session.subTier) > 0 || staff`.

The session cookie is signed (`SESSION_SECRET`); a forged one is stripped at the
adapter and the request proceeds as a guest. `user_id`, `login` and
`display_name` on the session are therefore trustworthy as the poster's
identity.

---

## 5. Moderation

- **Soft delete only.** Own-delete sets `deleted_at`; a moderator delete also
  sets `deleted_by` and a `delete_reason` (required, shown to the author as a
  `moderation` notification).
- **Tombstones.** A deleted post renders as "removed by a moderator" or
  "removed by the author", so a conversation that replied to it still reads.
  The body is kept; a moderator can restore.
- **Report button** on every post → `forum_reports`. One per person per post
  (the second press is a no-op). Moderators see the open queue, oldest first,
  and resolve with a note. **Built on day one** — retrofitting it means
  retrofitting every post's markup.
- **Lock** stops new replies, leaves the thread readable. **Pin** floats it.
- **Rate limits, server-side, from the database, not a KV cooldown key:** the
  `forum_posts_by_user` index answers "posts by this user in the last minute"
  in one indexed query (tested). Limits: 5 posts / minute, 2 new threads /
  10 minutes. Deleted posts count — deleting your own spam does not refill the
  allowance, which is why that index is not partial.
- **Bodies are plain text, escaped on render.** Never stored as HTML, never
  rendered as HTML. `http(s)://` URLs may be auto-linked at render with
  `rel="noopener noreferrer"`; nothing else is interpreted.

---

## 6. Profile comments and mentions

- **Comments on a profile** are `forum_posts` rows with `profile_id` set. The
  profile owner's `comments_enabled` flag lives on the `profile_<id>` record
  (updated through `mutate()`); off means new comments are refused and existing
  ones still show, as the reference described. A comment notifies the owner
  (`kind = 'comment'`).
- **Mentions** are parsed out of the body **at post time**:

  ```js
  const MENTION = /(^|[^A-Za-z0-9_\/.])@([A-Za-z0-9_]{3,25})(?![A-Za-z0-9_])/g;
  ```

  Lowercased, de-duplicated, resolved through `loginidx_<login>` with the same
  stale-login check `/api/profile` does, written to `forum_mentions`, and a
  `mention` notification queued — all inside the post's transaction. The
  pattern is checked against nine cases: it takes `@PhantomACE,` and
  `(@samii)`, ignores `foo@example.com` and `https://x.tv/@handle`, and allows
  the 3-character logins legacy Twitch accounts still have. Only people who
  have logged in since migration 005 have a `loginidx_` row and can be
  resolved; a name that resolves to nobody is left as text.
- **Opting out of mentions** (`mentions_enabled: false` on the profile record)
  means the name stops resolving and notifying. The text stays.

---

## 7. Notifications

- **Storage:** the `notifications` table; unread = `read_at IS NULL`.
- **Delivery:** the existing bell. `js/notifications.js` gains a second source:
  on page load (not on a timer) it fetches `/api/forum/notifications` and
  merges the rows into the panel it already renders, marking them read when
  the panel opens. Live/offline events stay where they are.
- **Not in this iteration:** email, push, whispers. Each is a delivery channel
  with its own consent question and failure modes, and none is needed to make
  the forum usable.

---

## 8. Pages and endpoints

**Pages**, in the site's gothic black-and-red, each including the shared
header scripts (`checkHeaderScripts()` fails the boot if one is missing):

- `/community` — categories, each with its newest thread and a count; the
  existing `community.html` with the overlay removed.
- `/thread/<id>` — one thread, oldest first, 20 per page, reply box at the
  bottom. Served from `thread.html` by a rewrite in `server/static.js`
  mirroring the `/user/<login>` one (numeric id, matched only tightly enough
  to tell a thread from a typo; a missing thread serves the page, which says
  so).
- `/user/<login>` — the comments section lives under the profile.

**Every post shows the author's avatar, display name, equipped title and badge
showcase.** A thread page fetches these **once per distinct author, not once
per post**: the thread endpoint returns an `authors` map keyed by user id,
built server-side from `profile_<id>` and the inventory equips, so twenty posts
by six people cost six lookups and one round trip. This is the N+1 the first
draft would have shipped.

**Endpoints** (`functions/api/forum/`):

| route | GET | POST |
|---|---|---|
| `categories.js` | boards with counts and newest thread | — |
| `threads.js?category=&page=` | listing, pinned first | start a thread (title + body) |
| `thread.js?id=&page=` | posts + `authors` map + thread meta | reply |
| `post.js` | — | edit / delete-own / report, by `action` |
| `moderate.js` | open report queue (staff) | pin / lock / delete-any / restore / resolve (staff) |
| `comments.js?u=` | a profile's comments | comment on a profile |
| `notifications.js` | unread + recent for the session | mark read |

Every write goes through `withTransaction()`. Reads use `getPool().query()`.
Polling: none. Pages load on navigation; the thread page has a "new replies"
check only if it turns out to be wanted.

---

## 9. Build order

Each step names the test that gates it. A step with no test is not done.

0. **Apply the migration on the rig** —
   `node server/scripts/apply-sql.js server/sql/006_forum.sql --service phantomace-web --confirm`
   (not raw `psql`; it is not on the rig's PATH). Gate: `test-forum-schema`
   green locally, `apply-sql` dry run shows the right database.
1. **Data layer** — `functions/api/forum/_queries.js` (in `NON_ROUTE_MODULES`):
   one function per query in §3's index list, plus the write transactions.
   Gate: `test-forum-queries.js`, run against pglite with the functions given
   a `{ query }` object, so the same code is exercised without the rig.
2. **Read-only forum** — categories and threads render from the server;
   nothing can be posted; the overlay comes off `community.html`; `/thread/<id>`
   rewrite lands with a `probe-urls` case. Proves the shape before anything is
   user-generated.
3. **Posting** — threads, replies, edit, delete-own, with rate limits and caps
   from the first commit. Gate: a mutation test that removes the rate-limit
   check and confirms the suite fails **by exit code**.
4. **Moderation** — pin, lock, delete-any with reason, restore, tombstones,
   the report button and queue.
5. **Profile comments** — step 3 pointed at `profile_id`, plus the
   `comments_enabled` toggle in the profile editor.
6. **Mentions and notifications** — the parser (nine cases already written),
   `forum_mentions`, the bell's second source, `mentions_enabled`.
7. **Retire the prototype's data layer** — `getForumData`, `saveForumData`,
   `promptLogin`, `pa_forum` and `pa_forum_user` are deleted, not left as a
   fallback that silently swallows posts when the API is down.

---

## 10. Decisions taken (formerly open questions)

- **Categories at launch:** the six the prototype already has — Announcements
  (staff-only), General Discussion, Gaming, Creative Corner, Stream Highlights,
  Suggestions & Feedback — seeded by the migration. Adding one is an `INSERT`.
- **Subscriber-only categories:** the column exists; none at launch. Divide
  the room once there are people in it.
- **Report queue on day one:** yes. The table and its index are in and tested.
- **Edit history:** no. `edited_at` only, and an edited post says "edited".
  Full history is a bigger table and a moderation aid; revisit if edit abuse
  turns out to be a real problem rather than an imagined one.

## 11. Still open

- **Thread page order for a pinned reply / "best answer"** — not designed;
  oldest-first is the only order for now.
- **Search** — none. Titles are indexed by category and recency, not by text.
  A `tsvector` on `forum_posts.body` is a one-line later addition.
- **Who may post in Announcements once the community grows** — currently staff
  only; a `trusted` flag is trivial to add if wanted.
