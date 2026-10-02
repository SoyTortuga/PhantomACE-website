/* ══════════════════════════════════════════════
   ABOUT PAGE CONTENT — editable by the broadcaster.

   The bio and the community values were prose inside about.html, so
   changing a sentence meant editing HTML, committing, pushing and
   restarting the server. This stores them instead.

   PLAIN TEXT, NEVER HTML. Everything here is rendered with textContent on
   the page. Storing markup would mean the edit box on a public page writes
   directly into the DOM of every visitor, and "only the broadcaster can
   reach it" is a thinner defence than simply not having the hole.
   Paragraphs are split on blank lines, which covers what this page needs.

   THE HTML REMAINS THE DEFAULT. Nothing is seeded here: GET returns null
   for anything never edited, and the page leaves its existing markup alone.
   So an empty database renders the page exactly as it does today, and a
   failed fetch is a no-op rather than a blank page.
   ══════════════════════════════════════════════ */

const KEY = 'about_content';

/* Every editable region, with the limits that keep one paste from turning
   the page into a wall. Anything not listed here cannot be written. */
const FIELDS = {
  subtitle: { max: 120, lines: 1 },
  bioTitle: { max: 60, lines: 1 },
  bioBody: { max: 2400, lines: 40 },
  valuesHeading: { max: 60, lines: 1 },
  value1Title: { max: 40, lines: 1 },
  value1Body: { max: 400, lines: 8 },
  value2Title: { max: 40, lines: 1 },
  value2Body: { max: 400, lines: 8 },
  value3Title: { max: 40, lines: 1 },
  value3Body: { max: 400, lines: 8 },
  statStreams: { max: 12, lines: 1 },
  statGoals: { max: 12, lines: 1 },
  statCommunity: { max: 12, lines: 1 },
};

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

/** Strip control characters, normalise newlines, and hold to the limits. */
function clean(value, rule) {
  let text = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000--]/g, '')
    .trim();

  if (rule.lines === 1) text = text.replace(/\n+/g, ' ');
  else text = text.split('\n').slice(0, rule.lines).join('\n');

  return text.slice(0, rule.max);
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const stored = await env.MARKETPLACE.get(KEY, 'json');

  const session = getSession(request);
  const { isBroadcaster } = await import('./admin/moderators.js');
  const canEdit = isBroadcaster(env, session);

  /* Only fields that have actually been set are returned. A field that is
     absent means "use whatever is in the HTML", which is what keeps the page
     working before anyone has ever edited it. */
  const content = {};
  for (const name of Object.keys(FIELDS)) {
    if (stored && typeof stored[name] === 'string' && stored[name] !== '') {
      content[name] = stored[name];
    }
  }

  return json({
    content,
    canEdit,
    updatedAt: (stored && stored.updatedAt) || null,
    updatedBy: (stored && stored.updatedBy) || null,
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  /* Broadcaster only. Moderators can add media; the broadcaster's own words
     about themselves are not delegated. */
  const { isBroadcaster } = await import('./admin/moderators.js');
  if (!isBroadcaster(env, session)) {
    return json({ error: 'Only the broadcaster can edit this page.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const patch = body && body.content;
  if (!patch || typeof patch !== 'object') return json({ error: 'Nothing to save.' }, 400);

  const unknown = Object.keys(patch).filter(k => !FIELDS[k]);
  if (unknown.length) {
    return json({ error: `Not editable: ${unknown.slice(0, 3).join(', ')}` }, 400);
  }

  const next = {};
  for (const [name, rule] of Object.entries(FIELDS)) {
    if (!(name in patch)) continue;
    const text = clean(patch[name], rule);
    /* An empty field is a RESET, not an empty page: the key is dropped and
       the HTML default takes over again. Otherwise clearing a box would
       leave a blank heading with no way back short of retyping it. */
    if (text) next[name] = text;
  }

  const saved = await env.MARKETPLACE.mutate(KEY, (current) => {
    const base = (current && typeof current === 'object') ? { ...current } : {};
    for (const name of Object.keys(FIELDS)) {
      if (!(name in patch)) continue;
      if (next[name]) base[name] = next[name];
      else delete base[name];
    }
    base.updatedAt = Date.now();
    base.updatedBy = session.display_name || String(session.user_id);
    return base;
  });

  const content = {};
  for (const name of Object.keys(FIELDS)) {
    if (typeof saved[name] === 'string' && saved[name] !== '') content[name] = saved[name];
  }

  return json({ success: true, content, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy });
}
