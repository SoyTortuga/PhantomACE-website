/* ══════════════════════════════════════════════
   MEDIA UPLOAD — broadcaster and moderators.

   Was written against Cloudflare R2 (env.MEDIA_BUCKET) and has been dead
   since the migration: the binding does not exist, so every upload threw a
   TypeError and the page showed a generic failure. Now writes through
   env.MEDIA_STORE, which is disk-backed on the rig.

   TWO THINGS CHANGED BEYOND THE STORAGE.

   Access is checked against the MODERATOR LIST, not the session cookie's
   role field. The old check read `MOD_ROLES.includes(session.role)` with
   MOD_ROLES including sub_tier1/2/3 — so every subscriber could upload to
   the public media page, which is not what "moderators and broadcaster" was
   ever meant to mean. isModerator() is the same check the bot control panel
   uses, and it consults the list the broadcaster actually manages.

   The extension comes from the CONTENT TYPE, never from the uploaded
   filename. Storing a file as whatever the client called it means the
   uploader picks the extension the serving handler will later use to decide
   what the file is.
   ══════════════════════════════════════════════ */

const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
const MAX_INDEX = 500;

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

/* Must match the filter bar and the form's own <select> on media.html.
   A category the page cannot filter by is an item nobody will ever see
   except under "All". */
const CATEGORIES = ['clip', 'screenshot', 'art', 'highlight'];

/* Visibility, lowest first — the same ladder js/auth.js uses. '' means
   everyone, including logged-out visitors. */
const ROLES = ['visitor', 'follower', 'sub_tier1', 'sub_tier2', 'sub_tier3', 'moderator', 'broadcaster'];

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Log in to upload.' }, 401);

  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can add media.' }, 403);
  }

  if (!env.MEDIA_STORE) {
    /* Says what is wrong rather than throwing. This is a configuration
       problem on the server, not anything the uploader did. */
    return json({ error: 'Media storage is not configured on this server.' }, 503);
  }

  let formData;
  try { formData = await request.formData(); } catch { return json({ error: 'Invalid form data' }, 400); }

  const file = formData.get('file');
  const title = String(formData.get('title') || '').trim().slice(0, 120);
  const category = String(formData.get('category') || 'general');
  /* Who may SEE it, not who uploaded it. Empty means everyone. */
  const visibility = String(formData.get('role') || '');

  if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'No file received.' }, 400);
  if (!title) return json({ error: 'Give it a title.' }, 400);
  if (!CATEGORIES.includes(category)) return json({ error: 'Unknown category.' }, 400);
  if (visibility && !ROLES.includes(visibility)) return json({ error: 'Unknown visibility.' }, 400);
  if (file.size > MAX_SIZE) return json({ error: 'File too large — 10MB maximum.' }, 400);
  if (!ALLOWED_TYPES.includes(file.type)) {
    return json({ error: 'Images (jpg, png, gif, webp) and video (mp4, webm) only.' }, 400);
  }

  let name;
  try {
    name = await env.MEDIA_STORE.put(await file.arrayBuffer(), file.type);
  } catch (err) {
    return json({ error: err.message || 'Could not save the file.' }, 400);
  }

  const meta = {
    id: name.replace(/\.[a-z0-9]+$/, ''),
    file: name,
    url: `/cdn/media/${name}`,
    title,
    category,
    role: visibility || null,
    type: file.type.startsWith('video/') ? 'video' : 'image',
    contentType: file.type,
    size: file.size,
    uploadedBy: session.display_name,
    uploadedById: String(session.user_id),
    uploadedAt: Date.now(),
  };

  /* mutate() rather than get-then-put: two moderators uploading at once
     would otherwise each write an index built before the other's entry, and
     one upload would vanish from the page while its file sat on disk. */
  await env.MARKETPLACE.mutate('media_index', (current) => {
    const index = Array.isArray(current) ? current : [];
    return [meta, ...index].slice(0, MAX_INDEX);
  });

  return json({ success: true, item: meta });
}

/* ── DELETE — remove an upload ────────────────────────────────────────────
   Without this a mistaken upload is permanent and public. Any moderator can
   remove any item: they can all add, and a media page where a bad post can
   only be taken down by whoever made it is not moderated. */

export async function onRequestDelete(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Log in first.' }, 401);

  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can remove media.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  const id = String(body.id || '');
  if (!id) return json({ error: 'Which item?' }, 400);

  let removed = null;
  await env.MARKETPLACE.mutate('media_index', (current) => {
    const index = Array.isArray(current) ? current : [];
    const hit = index.find(m => m.id === id);
    if (!hit) return undefined;          // nothing to do, write nothing
    removed = hit;
    return index.filter(m => m.id !== id);
  });

  if (!removed) return json({ error: 'Not found.' }, 404);

  /* The index entry going first is deliberate. If the file delete fails the
     item is already gone from the page, which is what was asked for; an
     orphaned file on disk is tidier to live with than an entry pointing at
     a file that is no longer there. */
  if (env.MEDIA_STORE && removed.file) {
    await env.MEDIA_STORE.remove(removed.file);
  }

  return json({ success: true, id });
}
