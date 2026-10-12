/* ══════════════════════════════════════════════
   /api/announcements — a moderator's message to the whole site

   GET   { announcements }  the live broadcasts, newest first. PUBLIC, and
         deliberately so: the bell shows these to everyone, signed in or
         not, which is the whole point of a site-wide notice.
   POST  { action: 'create', message, days? }   moderator only
         { action: 'delete', id }                moderator only

   NOT A NOTIFICATION PER PERSON. A broadcast is ONE stored row that every
   visitor's bell reads, read-tracked per device by the bell's own
   last-opened timestamp — the same way it already treats the live/offline
   and anniversary notices. Writing a forum_notifications row per user would
   be the wrong model: thousands of rows for one message, and nothing to
   write them against for a viewer who has never posted.

   EACH ENTRY CARRIES ITS OWN EXPIRY. The list is read far more than it is
   written, so stale notices are filtered out on read and compacted on the
   next write rather than swept by a timer. Default life is 7 days; a
   moderator can shorten it. There is no "forever", because a bell that
   still shows last month's maintenance notice is noise.

   The key is `site_announcements` (registry). Writes go through mutate() so
   two moderators posting at once cannot clobber each other's entry.
   ══════════════════════════════════════════════ */

const KEY = 'site_announcements';
const MAX_KEPT = 10;              // the newest few; a bell is not an archive
const MAX_MESSAGE = 280;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Live entries only, newest first — the one definition both verbs use. */
function live(list, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .filter(a => a && typeof a.message === 'string' && (!a.expiresAt || a.expiresAt > now))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, MAX_KEPT);
}

/** What a reader is allowed to see — never the author's id, only their name. */
function publicShape(a) {
  return { id: a.id, message: a.message, by: a.by || '', createdAt: a.createdAt, expiresAt: a.expiresAt };
}

export async function onRequestGet(context) {
  const { env } = context;
  let list = null;
  try { list = await env.MARKETPLACE.get(KEY, 'json'); } catch { list = null; }
  return json({ announcements: live(list).map(publicShape) });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  /* Read the list fresh on every call, so removing a moderator takes effect
     at once rather than at their session's expiry. */
  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Moderators only.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'Bad request' }, 400);

  if (body.action === 'create') {
    const message = String(body.message == null ? '' : body.message).trim();
    if (!message) return json({ error: 'Type a message first.' }, 400);
    if (message.length > MAX_MESSAGE) return json({ error: `Keep it under ${MAX_MESSAGE} characters.` }, 400);

    const days = Math.min(MAX_DAYS, Math.max(1, Number(body.days) || DEFAULT_DAYS));
    const now = Date.now();
    const entry = {
      /* Enough entropy that two posts in the same millisecond differ, which
         the bell relies on to dedupe by key. */
      id: 'a_' + now.toString(36) + Math.random().toString(36).slice(2, 7),
      message,
      by: String(session.display_name || 'Staff').slice(0, 40),
      createdAt: now,
      expiresAt: now + days * DAY_MS,
    };

    await env.MARKETPLACE.mutate(KEY, (cur) => {
      /* Prune stale entries in the same write, so the stored list stays
         small without a separate sweep. */
      const kept = live(cur, now);
      return [entry, ...kept].slice(0, MAX_KEPT);
    });
    return json({ ok: true, announcement: publicShape(entry) });
  }

  if (body.action === 'delete') {
    const id = String(body.id || '');
    if (!id) return json({ error: 'Which one?' }, 400);
    let found = false;
    await env.MARKETPLACE.mutate(KEY, (cur) => {
      const next = live(cur).filter(a => a.id !== id);
      found = next.length !== live(cur).length;
      return next;
    });
    /* Idempotent: deleting one already gone is not an error — it may have
       expired, or another moderator removed it. */
    return json({ ok: true, removed: found });
  }

  return json({ error: 'Unknown action' }, 400);
}
