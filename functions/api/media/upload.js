const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
const MOD_ROLES = ['broadcaster', 'moderator', 'sub_tier3', 'sub_tier2', 'sub_tier1'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  if (!MOD_ROLES.includes(session.role)) {
    return json({ error: 'Insufficient permissions' }, 403);
  }

  let formData;
  try { formData = await request.formData(); } catch { return json({ error: 'Invalid form data' }, 400); }

  const file = formData.get('file');
  const title = (formData.get('title') || '').trim();
  const category = formData.get('category') || 'general';
  const role = formData.get('role') || '';

  if (!file || !title) return json({ error: 'Missing file or title' }, 400);
  if (file.size > MAX_SIZE) return json({ error: 'File too large (10MB max)' }, 400);
  if (!ALLOWED_TYPES.includes(file.type)) return json({ error: 'Unsupported file type' }, 400);

  const ext = file.name.split('.').pop() || 'bin';
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const key = `media/${id}.${ext}`;

  await env.MEDIA_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: {
      title,
      category,
      role,
      uploadedBy: session.display_name,
      userId: session.user_id,
    },
  });

  const meta = {
    id,
    key,
    title,
    category,
    role,
    type: file.type.startsWith('video/') ? 'video' : 'image',
    uploadedBy: session.display_name,
    uploadedAt: Date.now(),
  };

  const index = await env.MARKETPLACE.get('media_index', 'json') || [];
  index.unshift(meta);
  await env.MARKETPLACE.put('media_index', JSON.stringify(index));

  const bucketUrl = `/cdn/media/${id}.${ext}`;

  return json({ id, url: bucketUrl });
}
