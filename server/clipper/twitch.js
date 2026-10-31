/* ══════════════════════════════════════════════
   GETTING CLIPS OUT OF TWITCH, AND THE FILE BEHIND ONE.

   Selection uses the SAME app token everything else does (auth/app-token.js),
   so the bot does not mint its own and get the shared one revoked — the exact
   failure that file documents.

   Get Clips returns each clip's `game_id` (the category at clip time, which is
   what the router keys on), `view_count`, `created_at`, `duration` and a
   `thumbnail_url`. Twitch sorts the list by views and offers no other order,
   so we ask for a page over a date window and keep the top ones.

   ┌──────────────────────────────────────────────────────────────────┐
   │ THE DOWNLOAD IS THE UNOFFICIAL PART — READ BEFORE CHANGING IT.   │
   └──────────────────────────────────────────────────────────────────┘

   Helix has no "download this clip" endpoint, and the file cannot be derived
   from anything Helix returns. Twitch serves clips from a separate CDN under
   a SIGNED url:

     https://<cdn>/nauth/<uuid>/landscape/<codec>/<quality>/index.mp4
       ?token={...,"expires":...}&sig=<hmac>

   The signature is Twitch's, and it expires, so no amount of string
   manipulation produces a working link. The url has to be ASKED FOR.

   clipSourceUrl() asks Twitch's GQL endpoint — the one its own web player
   uses — with Twitch's public web client id. This is UNDOCUMENTED and is not
   part of the Helix contract the rest of this file relies on. It is used here
   deliberately and with the broadcaster's agreement, because it is the only
   way to automate posting their own clips. Expect it to break one day;
   downloadClip() throws loudly rather than posting a broken file, so the run
   fails visibly instead of uploading something wrong.

   If it does break, this is the ONLY function that needs replacing.

   A clip on the OLD cdn still derives from its thumbnail (`-preview-` →
   `.mp4`), so clipMp4Url() is kept as a fallback for those.
   ══════════════════════════════════════════════ */

/* Twitch's public web client id — the one its own site ships. Not ours, and
   not a secret; it is what identifies a request as coming from the player. */
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL_ENDPOINT = 'https://gql.twitch.tv/gql';

/* The persisted-query hash for VideoAccessToken_Clip. Twitch can rotate it,
   so a rejection falls through to sending the query text instead. */
const CLIP_TOKEN_HASH = '36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11';

const CLIP_TOKEN_QUERY = `query ClipAccess($slug: ID!) {
  clip(slug: $slug) {
    playbackAccessToken(params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) {
      signature
      value
    }
    videoQualities { frameRate quality sourceURL }
  }
}`;

/**
 * The best quality at or below 1080. Pure.
 *
 * The renderer scales to 1080 wide, so a 1440/2160 source is only a slower
 * download and a slower decode for no visible gain. Highest-first otherwise.
 *
 * @param {{quality:string, frameRate:number, sourceURL:string}[]} qualities
 */
export function pickQuality(qualities) {
  const sorted = [...(qualities || [])]
    .filter(q => q && q.sourceURL)
    .sort((a, b) => (Number(b.quality) || 0) - (Number(a.quality) || 0));
  if (!sorted.length) return null;
  return sorted.find(q => (Number(q.quality) || 0) <= 1080) || sorted[sorted.length - 1];
}

/**
 * Ask Twitch for a playable, signed url for one clip.
 *
 * @param {string} slug
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] injected for tests
 * @returns {Promise<string>}
 */
export async function clipSourceUrl(slug, { fetchImpl = fetch } = {}) {
  const post = (body) => fetchImpl(GQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  /* Persisted query first (what the player sends), then the query text if
     Twitch has rotated the hash out from under us. */
  let clip = await readClip(await post([{
    operationName: 'VideoAccessToken_Clip',
    variables: { slug },
    extensions: { persistedQuery: { version: 1, sha256Hash: CLIP_TOKEN_HASH } },
  }]));

  if (!clip) {
    clip = await readClip(await post({ query: CLIP_TOKEN_QUERY, variables: { slug } }));
  }
  if (!clip) throw new Error(`Twitch GQL returned no clip for "${slug}" (it may be deleted)`);

  const token = clip.playbackAccessToken;
  if (!token || !token.signature || !token.value) {
    throw new Error(`Twitch GQL returned no playback token for "${slug}"`);
  }
  const best = pickQuality(clip.videoQualities);
  if (!best) throw new Error(`Twitch GQL listed no video qualities for "${slug}"`);

  /* The signature and token ride as query parameters on the CDN url. */
  const url = new URL(best.sourceURL);
  url.searchParams.set('sig', token.signature);
  url.searchParams.set('token', token.value);
  return url.toString();
}

/** Pull `clip` out of either response shape, or null if it is not there. */
async function readClip(res) {
  if (!res || !res.ok) return null;
  let body;
  try { body = await res.json(); } catch { return null; }
  const payload = Array.isArray(body) ? body[0] : body;
  return (payload && payload.data && payload.data.clip) || null;
}

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
 * Where to fetch a clip's video from: a signed url from GQL, or — for a clip
 * still on the old cdn — one derived from its thumbnail.
 *
 * @param {{slug:string, thumbnailUrl:string}} clip
 * @param {object} [opts] passed through to clipSourceUrl (tests inject fetch)
 */
export async function resolveClipUrl(clip, opts = {}) {
  try {
    return await clipSourceUrl(clip.slug, opts);
  } catch (err) {
    /* Old-cdn clips still derive. Worth trying before giving up, but say so:
       if GQL has stopped working this is the line that explains the run. */
    const derived = clipMp4Url(clip.thumbnailUrl);
    if (derived) {
      console.warn(`[clipper] ${clip.slug}: GQL failed (${err.message}) — falling back to the thumbnail url`);
      return derived;
    }
    throw err;
  }
}

/**
 * Download a clip's source MP4 to a file.
 * @param {{slug:string, thumbnailUrl:string}} clip
 * @param {string} destPath where to write the .mp4
 */
export async function downloadClip(clip, destPath) {
  const mp4 = await resolveClipUrl(clip);
  const res = await fetch(mp4);
  if (!res.ok || !res.body) {
    throw new Error(`Clip download failed (${res.status}) for ${clip.slug}`);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  const { size } = fs.statSync(destPath);
  if (size < 1024) {
    throw new Error(`Downloaded clip is suspiciously small (${size} bytes) — ${clip.slug}`);
  }
  return { path: destPath, bytes: size };
}
