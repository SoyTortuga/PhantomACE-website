/* ══════════════════════════════════════════════
   CHANNEL UPDATE — the broadcaster changed category, title or language.

   Twitch EventSub `channel.update` v2. The reason this one is worth having:
   it needs NO OAUTH SCOPE AT ALL. Every other push on this site waits on the
   broadcaster's Step 2 grant; this one works the moment the subscription is
   created, which makes it the cheapest signal we have for "what is he playing
   right now".

   IT FIRES ON MORE THAN THE CATEGORY. Title, language and content
   classification changes all arrive as the same event, so a handler that acted
   on every notification would fire every time he fixes a typo in the title
   mid-stream. This one diffs the CATEGORY and does nothing when only the other
   fields moved — `changed` in the stored record says which it was.

   IT ALSO FIRES WHILE OFFLINE. Setting the category during pre-stream setup is
   a real notification. We still record it, because the category is true either
   way, but anything that ARMS something off this must check the channel is live
   first — the record deliberately does not do that gating for you, since the
   live check is a second lookup and most readers already have one.

   TWO SOURCES, ON PURPOSE. `stream-info.js` also carries the category, read
   from /helix/streams on a 30s cache: authoritative, but only while live and up
   to half a minute late. This route is immediate and works offline. Read
   stream-info when you want the truth now; read this when you want to know a
   change just happened.
   ══════════════════════════════════════════════ */

import { verifyEventSub } from '../../server/lib/eventsub.js';

const KEY = 'stream_category';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

/**
 * The current category, for anything that wants to branch on it.
 * Returns the empty shape rather than null so callers never have to null-check
 * before reading `.categoryName`.
 */
export async function getStreamCategory(env) {
  try {
    const cur = await env.MARKETPLACE.get(KEY, 'json');
    if (cur) return cur;
  } catch { /* fall through to the empty shape */ }
  return { categoryId: null, categoryName: null, title: null, changedAt: 0, changed: null };
}

export async function onRequestGet(context) {
  const cur = await getStreamCategory(context.env);
  /* 15s: short enough that a mid-stream switch shows up promptly, long enough
     that an overlay polling this every second costs one read a quarter minute. */
  return json(cur, 200, { 'Cache-Control': 'public, max-age=15' });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  /* Read as TEXT and verify before parsing — the signature covers the exact
     bytes Twitch sent. */
  const rawBody = await request.text();

  const check = await verifyEventSub(request, env.TWITCH_EVENTSUB_SECRET, rawBody);
  if (!check.ok) return new Response(check.reason, { status: check.status });

  let body;
  try { body = JSON.parse(rawBody); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (check.messageType === 'webhook_callback_verification') {
    return new Response(body.challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (check.messageType === 'notification') {
    const event = body.event;
    const type = body.subscription && body.subscription.type;

    if (type === 'channel.update' && event) {
      try {
        const categoryId = event.category_id ? String(event.category_id) : null;
        const categoryName = event.category_name ? String(event.category_name) : null;
        const title = typeof event.title === 'string' ? event.title : null;

        await env.MARKETPLACE.mutate(KEY, (cur) => {
          const prev = cur || {};
          /* The whole point of this handler: tell him SWITCHING GAMES apart
             from everything else this event carries. Compared on the id, not
             the name — Twitch renames categories, and a rename is not a switch.
             A rename still writes (so the stored display name does not go
             stale) but lands as 'details', the same as a title edit. */
          const categoryChanged = (prev.categoryId || null) !== categoryId;
          const detailsChanged = (prev.title || null) !== title
            || (prev.categoryName || null) !== categoryName;
          if (!categoryChanged && !detailsChanged) return undefined;  // nothing moved: no write

          return {
            categoryId,
            categoryName,
            title,
            changed: categoryChanged ? 'category' : 'details',
            changedAt: Date.now(),
            /* What it was before, so a consumer can say "switched FROM Magic"
               without keeping its own copy. Only meaningful on a category move. */
            prevCategoryId: categoryChanged ? (prev.categoryId || null) : (prev.prevCategoryId || null),
            prevCategoryName: categoryChanged ? (prev.categoryName || null) : (prev.prevCategoryName || null),
          };
        });
      } catch (err) {
        /* Never 500 at Twitch — repeated failures get the subscription
           disabled, which costs more than losing one category change. */
        console.error('[channel-update] could not record the change:', err.message);
      }
    }

    const { clearEventSubRevocation } = await import('./bot/dashboard.js');
    await clearEventSubRevocation(env, type);

    return json({ ok: true });
  }

  if (check.messageType === 'revocation') {
    const { recordEventSubRevocation } = await import('./bot/dashboard.js');
    await recordEventSubRevocation(env, body, 'channel-update');
    return json({ ok: true });
  }

  return json({ ok: true });
}
