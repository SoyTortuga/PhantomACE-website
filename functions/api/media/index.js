/* ══════════════════════════════════════════════
   MEDIA GALLERY — what the page shows.

   The page had no list endpoint at all. js/pages/media.js held
   `const GALLERY_DATA = []` and rendered from it, so an upload appeared
   until the next refresh and then was gone: the file and the index entry
   both survived, and nothing ever read them back.

   VISIBILITY IS ENFORCED HERE, not in the page. Each item may carry a
   minimum role, and filtering client-side would mean sending every
   subscriber-only clip to every visitor and asking the browser not to draw
   it. The viewer's own role decides what this returns.
   ══════════════════════════════════════════════ */

const ROLES = ['visitor', 'follower', 'sub_tier1', 'sub_tier2', 'sub_tier3', 'moderator', 'broadcaster'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('../admin/moderators.js');
  const canManage = session ? await isModerator(env, session) : false;

  /* A moderator by the LIST outranks whatever the cookie says. The cookie's
     role field does not know about site moderators — that is the whole
     reason the list exists — so a moderator would otherwise be unable to see
     moderator-only media on a page they administer. */
  const cookieRole = session && ROLES.includes(session.role) ? session.role : 'visitor';
  const effective = canManage && ROLES.indexOf(cookieRole) < ROLES.indexOf('moderator')
    ? 'moderator'
    : cookieRole;
  const rank = ROLES.indexOf(effective);

  const index = await env.MARKETPLACE.get('media_index', 'json') || [];

  const items = index
    .filter(m => {
      if (!m || !m.role) return true;            // no restriction
      const need = ROLES.indexOf(m.role);
      return need !== -1 && rank >= need;
    })
    .map(m => ({
      id: m.id,
      url: m.url,
      title: m.title,
      category: m.category,
      type: m.type,
      role: m.role || null,
      uploadedBy: m.uploadedBy,
      uploadedAt: m.uploadedAt,
    }));

  /* canManage decides whether the page offers Upload and Remove. It is a
     server answer, not a CSS role class: media.html gates the button with
     `role-moderator`, which reads the cookie's role field and is therefore
     false for every site moderator — the people the button is for. */
  return json({ items, canManage, viewerRole: effective });
}
