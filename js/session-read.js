/* ══════════════════════════════════════════════
   READ THE SESSION COOKIE — one definition, shared by the games.

   The games are standalone pages that do not load js/auth.js, so each one
   grew its own copy of the cookie parser. When the cookie gained a signature
   all four broke at once: they still did
       JSON.parse(decodeURIComponent(value))
   on a value that had become `<base64url(json)>.<signature>`, so every game
   saw a logged-in player as a guest. In Dino Park that also silently stopped
   cloud saves, because save() only pushes to the server when it believes
   someone is logged in.

   The parse lives here now so the next format change is one edit, not four
   and a bug report.

   THIS IS NOT A SECURITY CHECK. The payload is readable by design — the
   pages need the display name, avatar and role to render without an extra
   round trip. The signature is verified server-side on every request, so
   editing the payload in a browser changes what YOUR screen shows and
   nothing else. Do not add a signature check here: it would mean checking a
   value the client controls against a secret the client must not have.
   ══════════════════════════════════════════════ */

function readPhamSession() {
  try {
    const match = document.cookie.match(/(?:^|;\s*)pham_session=([^;]*)/);
    if (!match) return null;

    const raw = decodeURIComponent(match[1]);
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;          // unsigned or legacy — the server rejects it too

    const b64 = raw.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    const session = JSON.parse(new TextDecoder().decode(bytes));

    return (session && typeof session === 'object' && session.user_id) ? session : null;
  } catch {
    return null;
  }
}
