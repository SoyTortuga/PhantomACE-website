/* ══════════════════════════════════════════════
   LINKED MEDIA ON THE WALL — Twitch clips and YouTube videos

   (The route is still /api/media/clip, which is where it started. Renaming
   it would mean changing the client again for no behavioural gain.)

   Adding a clip used to mean downloading it off Twitch and uploading the
   file — which costs the rig the storage and the bandwidth, splits the
   view count off the real clip, and leaves a copy that never updates.

   So a clip is a REFERENCE, not an upload. Paste a clip link (or pick one
   from the recent list) and the wall stores its slug, title, thumbnail and
   duration. The tile shows Twitch's own thumbnail; opening it plays
   Twitch's own embed, so the view counts where it should.

   THE SLUG IS VERIFIED AGAINST HELIX, never trusted from the paste. Two
   reasons. A clip id is user input that ends up in an iframe src, so it has
   to be known-good rather than merely pattern-matched; and a link to
   someone ELSE's clip would otherwise put another channel's content on this
   wall. The lookup confirms the clip exists and that its broadcaster is
   this channel.

   An app token is enough — this needs nothing from the broadcaster's OAuth
   grant, so it works today.

   YOUTUBE works the same way and needs no key either: oEmbed returns the
   title, the author and a stable thumbnail, and refuses an id that does not
   exist, so the same verify-then-store flow applies — including declining a
   video from somebody else's channel. A Short is 9:16 and is remembered as
   such, because playing one in the clips' 16:9 box pillarboxes it.

   GET  ?recent=1   the channel's recent CLIPS, for the picker. There is no
                    YouTube equivalent: listing a channel's uploads needs a
                    Data API key, which oEmbed does not.
   POST {url}       add a Twitch clip or a YouTube video to the wall
   ══════════════════════════════════════════════ */

const INDEX_KEY = 'media_index';
const MAX_INDEX = 500;
const RECENT_MAX = 30;
/* Twitch's maximum page. Asked for in full even though only RECENT_MAX are
   shown, because the list arrives sorted by VIEWS and has to be re-sorted by
   date — a 30-row page would just be the 30 biggest clips in the window. */
const RECENT_PAGE = 100;
/* How far back "recent" reaches before falling back to all-time. */
const RECENT_DAYS = 30;

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

/* From upload.js, which owns the upload contract — not a second copy. A
   clip filed under a category the page cannot filter by is as invisible as
   an upload under one, and two lists drifting apart is how that happens. */
import { CATEGORIES, ROLES } from './upload.js';

/**
 * The slug out of whatever was pasted.
 *
 * Twitch gives clip links in several shapes and people paste all of them:
 *   https://clips.twitch.tv/SomeSlug
 *   https://www.twitch.tv/phantomace/clip/SomeSlug?filter=clips
 *   https://m.twitch.tv/clip/SomeSlug
 * and sometimes just the slug. Anything else is refused rather than
 * guessed at — this value ends up in an iframe src.
 */
export function clipSlug(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  /* A bare slug: Twitch's are word characters and dashes. */
  if (/^[A-Za-z0-9_-]{4,100}$/.test(raw) && !raw.includes('/')) return raw;

  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/(^|\.)twitch\.tv$/.test(u.hostname)) return null;

  const parts = u.pathname.split('/').filter(Boolean);
  /* clips.twitch.tv/<slug> */
  if (u.hostname === 'clips.twitch.tv' && parts.length === 1) return valid(parts[0]);
  /* twitch.tv/<channel>/clip/<slug> and m.twitch.tv/clip/<slug> */
  const at = parts.indexOf('clip');
  if (at !== -1 && parts[at + 1]) return valid(parts[at + 1]);
  return null;

  function valid(s) { return /^[A-Za-z0-9_-]{4,100}$/.test(s) ? s : null; }
}

/* The channel a YouTube link must belong to. Mirrors the handle in
   js/components.js and about.html — test-mirrors keeps the three in step. */
const YT_CHANNEL = '@PhantomACE';

/**
 * The video out of a YouTube link, and whether it is a Short.
 *
 *   https://www.youtube.com/shorts/<id>      a Short: 9:16
 *   https://www.youtube.com/watch?v=<id>     a normal video
 *   https://youtu.be/<id>
 *   https://www.youtube.com/embed/<id>
 *
 * Orientation comes from the URL rather than from oEmbed, whose width and
 * height are the size you asked for and say nothing about the video's shape.
 * Returns null for anything that is not a YouTube video link — a bare id is
 * NOT accepted here, unlike a Twitch slug, because an 11-character string
 * could just as easily be a clip slug and guessing between them is worse
 * than asking for the link.
 */
export function youtubeRef(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const ok = (id, short) => (/^[A-Za-z0-9_-]{11}$/.test(id) ? { id, short } : null);

  if (host === 'youtu.be') {
    return ok(u.pathname.split('/').filter(Boolean)[0] || '', false);
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com' && host !== 'm.youtube.com') {
    return null;
  }

  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'shorts' && parts[1]) return ok(parts[1], true);
  if (parts[0] === 'embed' && parts[1]) return ok(parts[1], false);
  if (parts[0] === 'watch') return ok(u.searchParams.get('v') || '', false);
  return null;
}

/** Twitch's thumbnail template carries %{width}/%{height} placeholders. */
function thumbAt(url, width, height) {
  return String(url || '')
    .replace('%{width}', String(width))
    .replace('%{height}', String(height));
}

async function helix(env, path) {
  const { withAppToken } = await import('../auth/app-token.js');
  const res = await withAppToken(env, (token) => fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': env.TWITCH_CLIENT_ID },
  }));
  if (!res) throw new Error('Could not get a Twitch app token');
  if (!res.ok) throw new Error(`Twitch returned ${res.status}`);
  return res.json();
}

/* ── GET — the channel's recent clips, for the picker ─────────────────── */
export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can add clips.' }, 403);
  }
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_BROADCASTER_ID) {
    return json({ error: 'Twitch is not configured on this server.' }, 503);
  }

  try {
    /* TWITCH SORTS BY VIEW COUNT AND OFFERS NO CHOICE. Get Clips returns its
       list in descending view count with no sort parameter, so a plain call
       gives the channel's biggest clips ever — which is what this picker was
       showing under the word "Recent". The date window is the only lever;
       the ordering is ours to do. */
    const base = `clips?broadcaster_id=${encodeURIComponent(env.TWITCH_BROADCASTER_ID)}&first=${RECENT_PAGE}`;
    const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();

    let data = await helix(env, `${base}&started_at=${encodeURIComponent(since)}`);
    let window = `${RECENT_DAYS}d`;

    /* A quiet month would leave the picker empty, which is worse than a
       wrong order. Fall back to all-time — still sorted by date. */
    if (!(data.data || []).length) {
      data = await helix(env, base);
      window = 'all';
    }

    const clips = (data.data || []).map(c => ({
      slug: c.id,
      title: c.title,
      thumbnail: thumbAt(c.thumbnail_url, 480, 272),
      duration: c.duration,
      views: c.view_count,
      creator: c.creator_name,
      createdAt: c.created_at,
    }))
      /* Newest first — the whole point. Twitch's own order is by views. */
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, RECENT_MAX);

    /* Which are already on the wall, so the picker can say so rather than
       letting somebody add the same clip twice. */
    let already = [];
    try {
      const index = await env.MARKETPLACE.get(INDEX_KEY, 'json');
      already = (Array.isArray(index) ? index : [])
        .filter(i => i && i.type === 'twitch-clip' && i.slug)
        .map(i => i.slug);
    } catch { /* the list is still useful without it */ }

    /* The UI says which window these came from, so "Recent" is never a
       claim the data does not support. */
    return json({ clips, already, window, days: RECENT_DAYS });
  } catch (err) {
    return json({ error: err.message || 'Could not reach Twitch.' }, 502);
  }
}

/* ── POST — put one on the wall ───────────────────────────────────────── */
export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can add clips.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const category = CATEGORIES.includes(body.category) ? body.category : 'clip';
  const role = ROLES.includes(body.role) ? body.role : '';

  /* YouTube first: its links are unambiguous, where a bare string could be a
     Twitch slug. */
  const yt = youtubeRef(body.url);
  if (yt) return addYouTube(env, session, body, yt, category, role);

  const slug = clipSlug(body.url || body.slug);
  if (!slug) {
    return json({ error: 'That does not look like a Twitch clip or a YouTube link.' }, 400);
  }

  if (!env.TWITCH_CLIENT_ID) return json({ error: 'Twitch is not configured on this server.' }, 503);

  /* VERIFIED, NOT TRUSTED. The slug goes into an iframe src, and a link to
     another channel's clip would otherwise land on this wall. */
  let clip;
  try {
    const data = await helix(env, `clips?id=${encodeURIComponent(slug)}`);
    clip = (data.data || [])[0];
  } catch (err) {
    return json({ error: err.message || 'Could not reach Twitch.' }, 502);
  }
  if (!clip) return json({ error: 'Twitch does not have a clip with that link.' }, 404);

  if (env.TWITCH_BROADCASTER_ID &&
      String(clip.broadcaster_id) !== String(env.TWITCH_BROADCASTER_ID)) {
    return json({ error: `That clip is from another channel (${clip.broadcaster_name}).` }, 400);
  }

  /* The title Twitch has, unless somebody typed one. */
  const title = String(body.title || clip.title || 'Clip').trim().slice(0, 120);

  const meta = {
    id: `clip_${slug}`,
    /* No `file` and no /cdn url: nothing of this is stored here. */
    slug,
    url: clip.url,
    title,
    category,
    role: role || null,
    type: 'twitch-clip',
    thumbnail: thumbAt(clip.thumbnail_url, 480, 272),
    duration: clip.duration,
    clipCreator: clip.creator_name,
    clippedAt: clip.created_at,
    uploadedBy: session.display_name,
    uploadedById: String(session.user_id),
    uploadedAt: Date.now(),
  };

  /* mutate(), like upload.js: two moderators adding at once would otherwise
     each write an index built before the other's entry. Adding the same clip
     twice replaces it rather than doubling it — the id is the slug. */
  let duplicate = false;
  await env.MARKETPLACE.mutate(INDEX_KEY, (current) => {
    const index = Array.isArray(current) ? current : [];
    const without = index.filter(i => !(i && i.id === meta.id));
    duplicate = without.length !== index.length;
    return [meta, ...without].slice(0, MAX_INDEX);
  });

  return json({ success: true, item: meta, replaced: duplicate });
}

/* ── YouTube ──────────────────────────────────────────────────────────────
   oEmbed needs no key and gives everything the wall wants: the title, the
   author (so a video from another channel can be refused, exactly as a clip
   from another channel is) and a stable, hotlinkable thumbnail. It answers
   400 for an id that does not exist, which is the verification. */
async function addYouTube(env, session, body, ref, category, role) {
  const watch = `https://www.youtube.com/watch?v=${ref.id}`;
  let meta;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
      { headers: { Accept: 'application/json' } });
    if (res.status === 404 || res.status === 400) {
      return json({ error: 'YouTube does not have a video with that link.' }, 404);
    }
    if (!res.ok) throw new Error(`YouTube returned ${res.status}`);
    meta = await res.json();
  } catch (err) {
    return json({ error: err.message || 'Could not reach YouTube.' }, 502);
  }

  /* Another channel's video, refused by name — the same rule the Twitch side
     applies, and the reason a paste cannot put anyone's content on this wall.
     Compared on the handle, because author_url carries it in full. */
  const author = String(meta.author_name || '');
  const authorUrl = String(meta.author_url || '');
  const handle = YT_CHANNEL.toLowerCase();
  if (!authorUrl.toLowerCase().includes(handle)) {
    return json({ error: `That video is from another channel (${author || 'unknown'}).` }, 400);
  }

  const title = String(body.title || meta.title || 'Video').trim().slice(0, 120);
  const id = `yt_${ref.id}`;

  const item = {
    id,
    videoId: ref.id,
    /* 9:16 rather than 16:9. The embed box reads this; without it a Short
       plays between two black pillars. */
    short: !!ref.short,
    url: ref.short
      ? `https://www.youtube.com/shorts/${ref.id}`
      : watch,
    title,
    category,
    role: role || null,
    type: 'youtube',
    thumbnail: String(meta.thumbnail_url || `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`),
    clipCreator: author,
    uploadedBy: session.display_name,
    uploadedById: String(session.user_id),
    uploadedAt: Date.now(),
  };

  let duplicate = false;
  await env.MARKETPLACE.mutate(INDEX_KEY, (current) => {
    const index = Array.isArray(current) ? current : [];
    const without = index.filter(i => !(i && i.id === id));
    duplicate = without.length !== index.length;
    return [item, ...without].slice(0, MAX_INDEX);
  });

  return json({ success: true, item, replaced: duplicate });
}
