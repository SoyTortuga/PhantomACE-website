/* ══════════════════════════════════════════════
   UPLOAD A SHORT TO YOUTUBE — one account, named by credsEnv.

   A route names a credential family ("YT_TFT"); the tokens are read from the
   service environment so nothing secret is committed:
     <NAME>_CLIENT_ID      OAuth client id    (one per Google Cloud project)
     <NAME>_CLIENT_SECRET  OAuth client secret
     <NAME>_REFRESH_TOKEN  per-CHANNEL refresh token (the account the Short
                           lands on — see README for the one-time consent)

   Two channels => two refresh tokens, same or different client. That is how
   "post TFT to the TFT channel, Minecraft to the Minecraft channel" works
   without the pipeline knowing anything but the credsEnv string.

   A missing family is NOT an error: credsFromEnv returns null and the caller
   logs "youtube: not configured" and carries on — the same posture the site
   takes with any unconfigured integration.

   #Shorts: a <=60s, <=1080-wide vertical video with #Shorts in the title or
   description is treated as a Short by YouTube. We render 1080×1920 and put the
   tag in the description, so no special endpoint is needed — videos.insert is
   the whole API surface.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';

/** Read a credential family from env, or null if incomplete. */
export function credsFromEnv(env, name) {
  const id = env[`${name}_CLIENT_ID`];
  const secret = env[`${name}_CLIENT_SECRET`];
  const refresh = env[`${name}_REFRESH_TOKEN`];
  if (!id || !secret || !refresh) return null;
  return { clientId: id, clientSecret: secret, refreshToken: refresh };
}

async function accessToken(creds) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`YouTube token refresh failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()).access_token;
}

/** Build the description, folding in #Shorts and the route hashtags. Pure. */
export function buildDescription({ baseText = '', hashtags = [] } = {}) {
  const tags = ['#Shorts', ...hashtags.filter(t => t && t.toLowerCase() !== '#shorts')];
  const parts = [];
  if (baseText) parts.push(baseText.trim());
  parts.push(tags.join(' '));
  return parts.join('\n\n');
}

/**
 * Upload a rendered vertical MP4 as a Short.
 * @param {object} o
 * @param {object} o.creds       from credsFromEnv
 * @param {string} o.file        path to the rendered .mp4
 * @param {string} o.title       video title (<=100 chars enforced)
 * @param {string[]} [o.hashtags]
 * @param {string} [o.privacy]   'public' | 'unlisted' | 'private'
 * @param {string[]} [o.keywords] video tags
 * @returns {Promise<{id:string, url:string}>}
 */
export async function uploadShort({ creds, file, title, hashtags = [], privacy = 'public', keywords = [] }) {
  const token = await accessToken(creds);
  const metadata = {
    snippet: {
      title: String(title || 'Clip').slice(0, 100),
      description: buildDescription({ hashtags }),
      tags: keywords.slice(0, 20),
      categoryId: '20', // Gaming
    },
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
  };

  /* Resumable upload: open a session, then PUT the bytes. For a <=60s Short the
     file is small enough to send in one PUT. */
  const startRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify(metadata),
    });
  if (!startRes.ok) {
    throw new Error(`YouTube upload init failed (${startRes.status}): ${(await startRes.text()).slice(0, 300)}`);
  }
  const uploadUrl = startRes.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube upload init returned no resumable URL');

  const bytes = fs.readFileSync(file);
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) },
    body: bytes,
  });
  if (!putRes.ok) {
    throw new Error(`YouTube upload failed (${putRes.status}): ${(await putRes.text()).slice(0, 300)}`);
  }
  const video = await putRes.json();
  return { id: video.id, url: `https://www.youtube.com/shorts/${video.id}` };
}
