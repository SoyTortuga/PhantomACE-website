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
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
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
    /* A WHITELIST, deliberately: the stored record also holds the storage
       filename and the uploader's id, and neither belongs in a public
       response. But it means a field the page needs and this forgets simply
       vanishes, and only after a reload — the page has the whole item in
       memory right after it is added, so a clip looked perfect until you
       navigated away and came back to a broken thumbnail and a dead embed.
       Anything renderItem or the lightbox reads has to be listed here;
       test-media-clips checks that it is. */
    .map(m => ({
      id: m.id,
      url: m.url,
      title: m.title,
      category: m.category,
      type: m.type,
      role: m.role || null,
      uploadedBy: m.uploadedBy,
      uploadedAt: m.uploadedAt,
      /* Linked media — Twitch clips and YouTube videos — are references
         rather than files, so the tile and the embed are built from these
         rather than from `url`. Forgetting one here is invisible until a
         reload, which is exactly how the clip fields got missed. */
      slug: m.slug,
      videoId: m.videoId,
      short: m.short,
      thumbnail: m.thumbnail,
      duration: m.duration,
      clipCreator: m.clipCreator,
    }));

  /* canManage decides whether the page offers Upload and Remove. It is a
     server answer, not a CSS role class: media.html gates the button with
     `role-moderator`, which reads the cookie's role field and is therefore
     false for every site moderator — the people the button is for. */
  return json({ items, canManage, viewerRole: effective });
}
