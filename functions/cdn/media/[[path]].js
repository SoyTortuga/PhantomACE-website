/* ══════════════════════════════════════════════
   SERVE UPLOADED MEDIA

   Was reading from Cloudflare R2 (env.MEDIA_BUCKET), which no longer exists,
   so every media URL threw. Now reads from the disk-backed store.

   The path comes straight out of the URL, so it is the one input on this
   server most worth distrusting. The store matches it against the exact
   pattern it generates and resolves containment before touching the disk;
   anything else is a 404 rather than an error, because telling a prober
   which of their guesses was the interesting one is a favour to them.
   ══════════════════════════════════════════════ */

export async function onRequestGet(context) {
  const { env, params } = context;

  if (!env.MEDIA_STORE) {
    return new Response('Media storage is not configured.', { status: 503 });
  }

  /* One segment only. Nothing this store writes is ever in a subdirectory,
     so a slash in the path means the request was not built from one of our
     own URLs. */
  const segments = Array.isArray(params.path) ? params.path : [];
  if (segments.length !== 1) return new Response('Not found', { status: 404 });

  const name = segments[0];
  const bytes = await env.MEDIA_STORE.get(name);
  if (!bytes) return new Response('Not found', { status: 404 });

  return new Response(bytes, {
    headers: {
      /* From the extension, which this store controls, never from anything
         the uploader supplied. */
      'Content-Type': env.MEDIA_STORE.typeFor(name),
      /* The name contains a timestamp and random suffix and is never reused,
         so the bytes behind a URL cannot change. */
      'Cache-Control': 'public, max-age=31536000, immutable',
      /* The store only ever holds image and video types, but this is the
         directory a hostile upload would aim at, so the browser is told not
         to second-guess the type it is given. */
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
}
