/* ══════════════════════════════════════════════
   MEDIA STORE — uploaded images and clips, on disk.

   Replaces env.MEDIA_BUCKET, which was Cloudflare R2. R2 went away with the
   migration and nothing replaced it, so both media routes referenced a
   binding that did not exist: uploading and viewing media each threw a
   TypeError rather than failing in any way a user could understand.

   WHY NOT INSIDE THE REPO. Uploads are user content, arriving while the
   server runs. In the repo they would show up in `git status`, risk being
   committed, and — because the static allowlist serves whole directories
   recursively — one careless addition to ALLOWED_DIRS would publish the
   lot. Kept outside the working tree instead, at MEDIA_DIR, and served only
   through a handler that checks what it is being asked for.

   EVERY PATH IS VALIDATED, not trusted. The id is generated here and
   filenames are matched against a strict pattern, then resolved and checked
   for containment. A media route takes its path straight from the URL, so
   "../../server/.env" is the obvious thing to try.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/* Extension is derived from the CONTENT TYPE, never from the uploaded
   filename. A file called "x.html" whose type is image/png must not be
   stored as .html, because the extension is what the serving handler
   later uses to decide what it is. */
const TYPE_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

const EXT_TYPE = Object.fromEntries(Object.entries(TYPE_EXT).map(([t, e]) => [e, t]));

/** Exactly what this store generates, and nothing else. */
const NAME_RE = /^[0-9]{13}_[a-z0-9]{10}\.(jpg|png|gif|webp|mp4|webm)$/;

export const MAX_SIZE = 10 * 1024 * 1024;
export const ALLOWED_TYPES = Object.keys(TYPE_EXT);

export function createMediaStore(dir) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });

  /** Resolve a request path to a real file, or null if it is not ours. */
  function resolveName(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
    const full = path.join(root, name);
    /* Belt and braces. NAME_RE already forbids separators and dots beyond
       the extension, so this cannot currently fail — which is exactly why it
       is here: the pattern could be loosened by someone who does not realise
       it is the only thing standing between a URL and the filesystem. */
    const rel = path.relative(root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return full;
  }

  return {
    root,

    extFor(contentType) {
      return TYPE_EXT[contentType] || null;
    },

    typeFor(name) {
      const ext = String(name).split('.').pop();
      return EXT_TYPE[ext] || 'application/octet-stream';
    },

    /**
     * Write a file and return its stored name.
     * @param {ArrayBuffer|Buffer|Uint8Array} bytes
     * @param {string} contentType one of ALLOWED_TYPES
     */
    async put(bytes, contentType) {
      const ext = TYPE_EXT[contentType];
      if (!ext) throw new Error(`Unsupported content type: ${contentType}`);

      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (buf.length === 0) throw new Error('Empty file');
      if (buf.length > MAX_SIZE) throw new Error('File too large');

      const name = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}.${ext}`;
      /* Written to a temp name and renamed, so a half-written file can never
         be served — the media index is updated after this returns, but a
         crash mid-write would otherwise leave a truncated image on disk
         under a name someone could already guess. */
      const tmp = path.join(root, `.tmp_${name}`);
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, path.join(root, name));
      return name;
    },

    /** Stat a stored file, or null. */
    async head(name) {
      const full = resolveName(name);
      if (!full) return null;
      try {
        const st = await fsp.stat(full);
        return st.isFile() ? { size: st.size, mtime: st.mtimeMs } : null;
      } catch {
        return null;
      }
    },

    /** Read a stored file, or null if it is absent or not ours. */
    async get(name) {
      const full = resolveName(name);
      if (!full) return null;
      try {
        return await fsp.readFile(full);
      } catch {
        return null;
      }
    },

    /** Remove a stored file. Returns false if it was not there. */
    async remove(name) {
      const full = resolveName(name);
      if (!full) return false;
      try {
        await fsp.unlink(full);
        return true;
      } catch {
        return false;
      }
    },
  };
}
