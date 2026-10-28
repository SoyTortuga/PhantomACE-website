/* ══════════════════════════════════════════════
   GETTING CLIPS OUT OF TWITCH, AND THE FILE BEHIND ONE.

   Selection uses the SAME app token everything else does (auth/app-token.js),
   so the bot does not mint its own and get the shared one revoked — the exact
   failure that file documents.

   Get Clips returns each clip's `game_id` (the category at clip time, which is
   what the router keys on), `view_count`, `created_at`, `duration` and a
   `thumbnail_url`. Twitch sorts the list by views and offers no other order,
   so we ask for a page over a date window and keep the top ones.

   THE DOWNLOAD IS THE UNOFFICIAL PART. Helix has no "download this clip"
   endpoint. The source MP4 lives at a URL derivable from the thumbnail: the
   thumbnail is `<base>-preview-<WxH>.jpg`, and the video is `<base>.mp4`. This
   is well known and stable in practice but is NOT a documented contract — if
   Twitch changes the thumbnail scheme this is the first thing to break, and
   downloadClip() throws loudly rather than posting a broken file.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { withAppToken } from '../../functions/api/auth/app-token.js';

async function helix(env, path) {
  const res = await withAppToken(env, (token) => fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': env.TWITCH_CLIENT_ID },
  }));
  if (!res) throw new Error('Could not get a Twitch app token');
  if (!res.ok) throw new Error(`Twitch Helix ${path} returned ${res.status}`);
  return res.json();
}

/**
 * The channel's clip POOL over a lookback window, highest-view first.
 *
 * Get Clips returns a broadcaster's clips in descending view count and
 * paginates in that same order, so walking the cursor yields the window's
 * clips globally view-sorted — exactly the pool the router then splits per
 * account. The caller (run.js) decides how many of each game to actually post;
 * this just gathers eligible candidates up to `max`.
 *
 * @returns {Promise<object[]>} normalized clips, view-desc
 */
export async function findClips(env, { lookbackDays = 365, minViews = 0, max = 1000 } = {}) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_BROADCASTER_ID) {
    throw new Error('TWITCH_CLIENT_ID and TWITCH_BROADCASTER_ID must be set to find clips');
  }
  const startedAt = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const endedAt = new Date().toISOString();
  const base = `clips?broadcaster_id=${encodeURIComponent(env.TWITCH_BROADCASTER_ID)}` +
    `&first=100&started_at=${encodeURIComponent(startedAt)}&ended_at=${encodeURIComponent(endedAt)}`;

  const out = [];
  let cursor = '';
  /* Cap the page walk so a channel with thousands of clips cannot run the
     lookback forever; `max` eligible is far more than any run posts. */
  for (let page = 0; page < 50 && out.length < max; page++) {
    const data = await helix(env, cursor ? `${base}&after=${encodeURIComponent(cursor)}` : base);
    for (const c of (data.data || [])) {
      if ((c.view_count || 0) < minViews) continue;
      out.push({
        slug: c.id,
        title: c.title || 'Clip',
        url: c.url,
        gameId: c.game_id ? String(c.game_id) : '',
        views: c.view_count || 0,
        duration: c.duration || 0,
        thumbnailUrl: c.thumbnail_url || '',
        creator: c.creator_name || '',
        createdAt: c.created_at || '',
      });
    }
    cursor = data.pagination && data.pagination.cursor;
    if (!cursor) break;
  }
  return out.slice(0, max);
}

/**
 * Resolve game ids to names (for the frame label and hashtags/logging).
 * @param {string[]} gameIds
 * @returns {Promise<Map<string,string>>} id -> name
 */
export async function resolveGames(env, gameIds) {
  const ids = [...new Set(gameIds.filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  /* Get Games takes up to 100 ids per call. */
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const qs = batch.map(id => `id=${encodeURIComponent(id)}`).join('&');
    const data = await helix(env, `games?${qs}`);
    for (const g of (data.data || [])) out.set(String(g.id), g.name);
  }
  return out;
}

/**
 * The MP4 URL behind a clip, from its thumbnail. Pure and testable.
 * Returns null if the thumbnail is not in the expected `-preview-` shape.
 */
export function clipMp4Url(thumbnailUrl) {
  const t = String(thumbnailUrl || '');
  const at = t.indexOf('-preview-');
  if (at === -1) return null;
  return t.slice(0, at) + '.mp4';
}

/**
 * Download a clip's source MP4 to a file.
 * @param {string} thumbnailUrl the clip's Helix thumbnail_url
 * @param {string} destPath where to write the .mp4
 */
export async function downloadClip(thumbnailUrl, destPath) {
  const mp4 = clipMp4Url(thumbnailUrl);
  if (!mp4) {
    throw new Error(`Could not derive a video URL from thumbnail: ${thumbnailUrl}`);
  }
  const res = await fetch(mp4);
  if (!res.ok || !res.body) {
    throw new Error(`Clip download failed (${res.status}) for ${mp4}`);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  const { size } = fs.statSync(destPath);
  if (size < 1024) throw new Error(`Downloaded clip is suspiciously small (${size} bytes) — ${mp4}`);
  return { path: destPath, bytes: size, source: mp4 };
}
