/* ══════════════════════════════════════════════
   PARK BACKGROUNDS
   GET  — the catalogue: published backgrounds, tilemap and mask included
   POST — save / publish / delete, broadcaster & moderators only

   A background made in the studio is DATA, not a deploy. The studio paints
   a 32×32 grid of palette tiles; the game and the visit view compose the
   canvas from the same tiles; the walkability mask rides along, derived
   from the tiles at paint time. Saving here is the whole release process —
   no git, no restart, no file copy.

   THE MASK IS STRUCTURALLY VALIDATED, NOT ZONE-CHECKED. Its correctness
   against the tilemap (water tiles marking O, land marking L) is the
   studio's job at derivation, and every author who can reach this endpoint
   is a moderator — someone already trusted with the bot panel. A wrong
   mask is a gameplay bug on one background, not a security hole: nothing
   here executes, and the tile REFS are charset-bound so the client only
   ever loads files from its own palette tree. If backgrounds ever open to
   non-staff, cross-checking mask against palette zones server-side is the
   first thing to add, and this comment is the reminder.
   ══════════════════════════════════════════════ */

import { isModerator, isBroadcaster } from './admin/moderators.js';

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

const KEY_PREFIX = 'park_bg_';
const bgKey = (id) => `${KEY_PREFIX}${id}`;

export const GRID = 32;                    /* must match PARK_GRID in the game */
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const TILE_RE = /^[a-z0-9]{1,20}\/\d{2}$/; /* set/index into the palette tree */
const MASK_RE = new RegExp(`^[LROX]{${GRID}}$`);
const NAME_MAX = 40;

/* 'classic' is the built-in and every id the client falls back to must
   stay the client's own. A studio background shadowing it would change
   what "default" means out from under every save that never chose. */
const RESERVED_IDS = new Set(['classic', 'default']);

/**
 * Validate a studio submission down to a storable record, or explain.
 *
 * Everything here is structure: exact grid dimensions, bounded charsets,
 * capped name. The refs are what matter — they are the only part the
 * client turns into URLs, and the charset means the URL can only ever
 * point inside the palette directory.
 */
export function validateBackground(body) {
  const name = String(body.name || '').trim().slice(0, NAME_MAX);
  if (!name) return { error: 'A background needs a name.' };

  const tilemap = body.tilemap;
  if (!Array.isArray(tilemap) || tilemap.length !== GRID) {
    return { error: `The tilemap must be ${GRID} rows.` };
  }
  for (const row of tilemap) {
    if (!Array.isArray(row) || row.length !== GRID) {
      return { error: `Every tilemap row must be ${GRID} cells.` };
    }
    for (const cell of row) {
      if (cell !== null && !(typeof cell === 'string' && TILE_RE.test(cell))) {
        return { error: 'Tilemap cells must be palette refs like "jungle/07", or null.' };
      }
    }
  }

  const mask = body.mask;
  if (!Array.isArray(mask) || mask.length !== GRID || !mask.every(r => typeof r === 'string' && MASK_RE.test(r))) {
    return { error: `The mask must be ${GRID} rows of ${GRID} L/R/O/X characters.` };
  }

  /* A map with no walkable land strands every land dino the moment the
     background is applied — re-placement would spin its attempts and give
     up at (50,50) on unwalkable ground. Refused here, where the author is
     still looking at the editor, rather than discovered in a stranded park. */
  const flat = mask.join('');
  if (!/[LR]/.test(flat)) return { error: 'A background needs some walkable land (L or R).' };

  return { name, tilemap, mask };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const one = url.searchParams.get('id');
  if (one) {
    if (!ID_RE.test(one)) return json({ error: 'Unknown background' }, 404);
    const rec = await env.MARKETPLACE.get(bgKey(one), 'json');
    if (!rec) return json({ error: 'Unknown background' }, 404);
    if (!rec.published) {
      const session = getSession(request);
      if (!isBroadcaster(env, session) && !(await isModerator(env, session))) {
        return json({ error: 'Unknown background' }, 404);
      }
    }
    return json({ background: rec });
  }

  const listed = await env.MARKETPLACE.list({ prefix: KEY_PREFIX });
  const out = [];
  for (const k of listed.keys || []) {
    const rec = await env.MARKETPLACE.get(k.name, 'json');
    if (rec && rec.published) out.push(rec);
  }

  /* Drafts ride along only for staff, and only when asked — the game's
     ordinary catalogue fetch should never grow because someone is midway
     through painting. */
  if (url.searchParams.get('drafts') === '1') {
    const session = getSession(request);
    if (isBroadcaster(env, session) || await isModerator(env, session)) {
      for (const k of listed.keys || []) {
        const rec = await env.MARKETPLACE.get(k.name, 'json');
        if (rec && !rec.published) out.push(rec);
      }
    }
  }

  out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return json({ backgrounds: out, grid: GRID });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);

  if (!isBroadcaster(env, session) && !(await isModerator(env, session))) {
    return json({ error: 'The background studio is for the broadcaster and moderators.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'delete') {
    const id = String(body.id || '');
    if (!ID_RE.test(id)) return json({ error: 'Unknown background' }, 404);
    await env.MARKETPLACE.delete(bgKey(id));
    return json({ success: true });
  }

  if (body.action !== 'save') return json({ error: 'Unknown action' }, 400);

  const checked = validateBackground(body);
  if (checked.error) return json({ error: checked.error }, 400);

  /* The id is derived from the name on first save and immutable after —
     it is stored in every player save that selects the background, so a
     rename must never move it. */
  let id = String(body.id || '');
  const creating = !id;
  if (creating) {
    id = checked.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }
  if (!ID_RE.test(id) || RESERVED_IDS.has(id)) {
    return json({ error: 'That name does not make a usable id.' }, 400);
  }

  const existing = await env.MARKETPLACE.get(bgKey(id), 'json');
  if (creating && existing) return json({ error: 'A background with that name already exists.' }, 409);
  if (!creating && !existing) return json({ error: 'Unknown background' }, 404);

  const record = {
    id,
    name: checked.name,
    tilemap: checked.tilemap,
    mask: checked.mask,
    /* ABSENT means UNCHANGED. Save-with-edits used to send publish:false,
       which silently pulled a live background out of every player's
       picker -- the author thought they were saving progress and was
       actually unpublishing. Only an explicit true or false moves the
       flag now; a new background starts as a draft. */
    published: body.publish === undefined
      ? (existing ? !!existing.published : false)
      : !!body.publish,
    paletteVersion: 1,
    createdAt: existing ? existing.createdAt : Date.now(),
    /* The author comes from the session, never the request — same rule as
       the park-visit consent rows. */
    createdBy: existing ? existing.createdBy : String(session.user_id),
    createdByName: existing ? existing.createdByName : String(session.display_name || '').slice(0, NAME_MAX),
    updatedAt: Date.now(),
  };

  await env.MARKETPLACE.put(bgKey(id), JSON.stringify(record));
  return json({ success: true, background: record });
}
