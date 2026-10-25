/* ══════════════════════════════════════════════
   UPLOAD A SHORT TO TIKTOK — one account, named by credsEnv.

   Tokens, like YouTube, come from the service environment so nothing secret is
   committed:
     <NAME>_CLIENT_KEY      TikTok app client key
     <NAME>_CLIENT_SECRET   TikTok app client secret
     <NAME>_REFRESH_TOKEN   per-ACCOUNT refresh token (the creator the video
                            posts as — see README for the authorize flow)

   THE AUDIT GATE — read this before expecting public posts. TikTok's Content
   Posting API only lets an UNAUDITED app post as `SELF_ONLY` (a private draft
   visible to the creator). A video goes public only after the app passes
   TikTok's audit AND the app is allowed the public privacy levels. So this
   defaults privacy to SELF_ONLY; once audited, set `"privacy": "PUBLIC_TO_EVERYONE"`
   on the route and nothing else changes. A route left unconfigured (no creds)
   no-ops, exactly like YouTube.

   Flow: refresh -> query creator_info (returns the privacy levels the account
   may use, which we must honour) -> init a FILE_UPLOAD direct post -> PUT the
   bytes. For a <=60s Short the file is one chunk.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';

const API = 'https://open.tiktokapis.com/v2';

/** Read a credential family from env, or null if incomplete. */
export function credsFromEnv(env, name) {
  const key = env[`${name}_CLIENT_KEY`];
  const secret = env[`${name}_CLIENT_SECRET`];
  const refresh = env[`${name}_REFRESH_TOKEN`];
  if (!key || !secret || !refresh) return null;
  return { clientKey: key, clientSecret: secret, refreshToken: refresh };
}

async function accessToken(creds) {
  const res = await fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: creds.clientKey,
      client_secret: creds.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`TikTok token refresh failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.access_token;
}

/**
 * The privacy levels this account may actually use. An unaudited app gets only
 * ['SELF_ONLY']; posting any other value is rejected, so we check rather than
 * assume. Returns the array (possibly just SELF_ONLY).
 */
async function creatorPrivacyOptions(token) {
  const res = await fetch(`${API}/post/publish/creator_info/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`TikTok creator_info failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return (data.data && data.data.privacy_level_options) || ['SELF_ONLY'];
}

/**
 * Upload a rendered vertical MP4 as a TikTok post.
 * @param {object} o
 * @param {object} o.creds    from credsFromEnv
 * @param {string} o.file     path to the rendered .mp4
 * @param {string} o.title    caption (TikTok caps around 2200 chars)
 * @param {string[]} [o.hashtags]
 * @param {string} [o.privacy] desired level; downgraded to SELF_ONLY if the
 *                 account/app is not allowed it
 * @returns {Promise<{id:string, privacy:string}>}
 */
export async function uploadVideo({ creds, file, title, hashtags = [], privacy = 'SELF_ONLY' }) {
  const token = await accessToken(creds);

  const allowed = await creatorPrivacyOptions(token);
  const level = allowed.includes(privacy) ? privacy : 'SELF_ONLY';

  const bytes = fs.readFileSync(file);
  const caption = [String(title || '').trim(), hashtags.join(' ')].filter(Boolean).join(' ').slice(0, 2200);

  const initRes = await fetch(`${API}/post/publish/video/init/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      post_info: { title: caption, privacy_level: level, disable_comment: false, disable_duet: false, disable_stitch: false },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: bytes.length,
        chunk_size: bytes.length,   // one chunk — a Short is well under the limit
        total_chunk_count: 1,
      },
    }),
  });
  const init = await initRes.json();
  if (!initRes.ok || !init.data || !init.data.upload_url) {
    throw new Error(`TikTok init failed (${initRes.status}): ${JSON.stringify(init).slice(0, 300)}`);
  }

  const putRes = await fetch(init.data.upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(bytes.length),
      'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
    },
    body: bytes,
  });
  if (!putRes.ok) {
    throw new Error(`TikTok upload failed (${putRes.status}): ${(await putRes.text()).slice(0, 300)}`);
  }
  return { id: init.data.publish_id, privacy: level };
}
