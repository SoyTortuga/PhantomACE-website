/* ══════════════════════════════════════════════
   PARK BACKGROUNDS
   GET  — the catalogue: published backgrounds, plus the caller's own
   POST — save / publish / delete; authoring needs a subscription

   A background made in the studio is DATA, not a deploy. The studio paints
   a 32×32 grid of palette tiles; the game and the visit view compose the
   canvas from the same tiles; the walkability mask rides along, derived
   from the tiles at paint time. Saving here is the whole release process —
   no git, no restart, no file copy.

   THE MASK IS NOW ZONE-CHECKED, because authors are no longer all
   moderators. It used to be validated for shape only — 32 rows of LROX —
   on the reasoning that everyone who could reach this endpoint was
   already trusted with the bot panel. That reasoning expired the moment
   subscribers could author, so the server derives the mask itself from
   park-zones.js and refuses a submission that disagrees. Without it a
   member could paint solid rock and mark it all swimmable.

   AUTHORING IS GATED, USE IS NOT. A subscription buys the studio, not the
   backgrounds made in it: someone whose sub lapses keeps every background
   they made and keeps using them. So the tier check sits on POST alone,
   and nothing in GET asks about it.

   PERSONAL BY DEFAULT. A member's background is theirs — it is served to
   them, and to anyone visiting their park, but it never enters the shared
   catalogue. `published` stays staff-only and is what "everyone can pick
   this" means. Sharing between members would be a third state and the
   ownership this adds is what it would build on.
   ══════════════════════════════════════════════ */

import { isModerator, isBroadcaster } from './admin/moderators.js';
import { zoneOfRef, isOverlaySet } from './park-zones.js';

/* Rank order of the cookie's role field. The moderator LIST outranks the
   cookie, which is why it is checked separately — see media/index.js. */
const ROLE_RANK = ['visitor', 'follower', 'sub_tier1', 'sub_tier2', 'sub_tier3', 'moderator', 'broadcaster'];

/** Authoring needs tier 1 or better, or staff. */
async function canAuthor(env, session) {
  if (!session || !session.user_id) return false;
  if (isBroadcaster(env, session)) return true;
  if (await isModerator(env, session)) return true;
  return ROLE_RANK.indexOf(String(session.role || 'visitor')) >= ROLE_RANK.indexOf('sub_tier1');
}

/* Enough to build a park out of, few enough that one member cannot fill
   the table. Staff are not counted against it. */
const PERSONAL_MAX = 8;

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

const KEY_PREFIX = 'park_bg_';
const bgKey = (id) => `${KEY_PREFIX}${id}`;

export const GRID = 32;                    /* must match PARK_GRID in the game */
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
/* set/index into the palette tree, with an optional right-angle
   rotation: `fencewire/03` or `fencewire/03r90`. The fence sheets ship
   one orientation per piece, so without this a corner only turns one
   way. Only the part before `r` ever becomes a file path, so the
   charset guarantee is unchanged. */
const TILE_RE = /^[a-z0-9]{1,20}\/\d{2}(r(?:90|180|270))?$/;
const MASK_RE = new RegExp(`^[LROX]{${GRID}}$`);
const NAME_MAX = 40;
/* The canvas behind the tiles. Unpainted cells show it, which is what
   lets an author paint features instead of all 1,024 cells. Strict
   six-digit hex: it is written straight into a style, so the charset
   is the guarantee that it can only ever be a colour. */
const COLOR_RE = /^#[0-9a-f]{6}$/;
const DEFAULT_BG_COLOR = '#0a0a0a';

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

  /* The fence layer. Optional, because every record written before
     fences existed has none, and absent must keep meaning "no fences"
     rather than failing validation. Same shape and same charset as the
     ground layer — it is the same kind of data one layer up. */
  let fences = null;
  if (body.fences != null) {
    const f = body.fences;
    if (!Array.isArray(f) || f.length !== GRID) {
      return { error: `The fence layer must be ${GRID} rows.` };
    }
    for (const row of f) {
      if (!Array.isArray(row) || row.length !== GRID) {
        return { error: `Every fence row must be ${GRID} cells.` };
      }
      for (const cell of row) {
        if (cell !== null && !(typeof cell === 'string' && TILE_RE.test(cell))) {
          return { error: 'Fence cells must be palette refs, or null.' };
        }
      }
    }
    fences = f;
  }

  const mask = body.mask;
  if (!Array.isArray(mask) || mask.length !== GRID || !mask.every(r => typeof r === 'string' && MASK_RE.test(r))) {
    return { error: `The mask must be ${GRID} rows of ${GRID} L/R/O/X characters.` };
  }

  /* A map with no walkable land strands every land dino the moment the
     background is applied — re-placement would spin its attempts and give
     up at (50,50) on unwalkable ground. Refused here, where the author is
     still looking at the editor, rather than discovered in a stranded park. */
  /* THE MASK MUST MATCH THE TILES. Derived here from the same rules the
     studio uses — a fence or decoration cell is X whatever is under it,
     otherwise the ground tile's zone decides, and an empty cell is X.
     Checked rather than trusted because an author is no longer
     necessarily staff: a forged mask would let someone paint solid rock
     and declare all of it swimmable. */
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const over = fences && fences[y] ? fences[y][x] : null;
      let want;
      if (over) {
        want = isOverlaySet(String(over).split('/')[0]) && zoneOfRef(over) !== 'X'
          ? zoneOfRef(over) : 'X';
      } else {
        const z = tilemap[y][x] ? zoneOfRef(tilemap[y][x]) : 'X';
        want = (z === 'L' || z === 'R' || z === 'O') ? z : 'X';
      }
      if (mask[y][x] !== want) {
        return { error: `The mask does not match the tiles at ${x},${y}. Reload the studio and save again.` };
      }
    }
  }

  const flat = mask.join('');
  if (!/[LR]/.test(flat)) return { error: 'A background needs some walkable land (L or R).' };

  const raw = String(body.bgColor || '').trim().toLowerCase();
  const bgColor = COLOR_RE.test(raw) ? raw : DEFAULT_BG_COLOR;

  return { name, tilemap, fences, mask, bgColor };
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
      /* An unpublished record is either a staff draft or a member's
         personal background. A personal one is NOT secret — a visitor
         standing in that member's park has to render it, and the park
         save already names the id — so by-id resolution is open. What
         stays closed is the LIST: personal backgrounds never appear in
         anyone else's picker. Staff drafts remain staff-only, because a
         draft is unfinished rather than personal. */
      const personal = !!rec.createdBy && String(rec.id || '').startsWith(`u${rec.createdBy}-`);
      if (!personal) {
        const session = getSession(request);
        if (!isBroadcaster(env, session) && !(await isModerator(env, session))) {
          return json({ error: 'Unknown background' }, 404);
        }
      }
    }
    return json({ background: rec });
  }

  /* One query for the whole family instead of a list() followed by a get()
     per key — listValues returns {name, value} rows in a single scan. */
  const rows = await env.MARKETPLACE.listValues({ prefix: KEY_PREFIX });
  const out = [];
  for (const { value: rec } of rows) {
    if (rec && rec.published) out.push(rec);
  }

  /* YOUR OWN RIDE ALONG, whatever your tier is now. A subscription buys
     the studio, not the backgrounds made in it — someone whose sub has
     lapsed keeps every one they made and keeps picking them in-game. So
     this asks who you are and never what you pay. */
  const seen = new Set(out.map(r => r.id));
  const me = getSession(request);
  if (me && me.user_id) {
    for (const { value: rec } of rows) {
      if (!rec || rec.published || seen.has(rec.id)) continue;
      if (String(rec.createdBy) === String(me.user_id)) { out.push(rec); seen.add(rec.id); }
    }
  }

  /* Drafts ride along only for staff, and only when asked — the game's
     ordinary catalogue fetch should never grow because someone is midway
     through painting. */
  if (url.searchParams.get('drafts') === '1') {
    const session = getSession(request);
    if (isBroadcaster(env, session) || await isModerator(env, session)) {
      for (const { value: rec } of rows) {
        /* `seen` spans both passes. A staff member's OWN draft is already
           in the list from the pass above, and pushing it again put it in
           their picker twice. */
        if (rec && !rec.published && !seen.has(rec.id)) { out.push(rec); seen.add(rec.id); }
      }
    }
  }

  out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  /* So the studio can say WHY rather than letting someone paint for ten
     minutes and meet a 403 on save. It is a capability of the caller, not
     a gate on this response — the list above is open to everyone. */
  return json({ backgrounds: out, grid: GRID, canAuthor: await canAuthor(env, getSession(request)) });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Not logged in' }, 401);

  if (!(await canAuthor(env, session))) {
    return json({ error: 'The background studio is a subscriber perk. Backgrounds you have already made stay yours.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const staff = isBroadcaster(env, session) || await isModerator(env, session);

  if (body.action === 'delete') {
    const id = String(body.id || '');
    if (!ID_RE.test(id)) return json({ error: 'Unknown background' }, 404);
    /* Yours, or you are staff. Without this a subscriber could delete any
       background by id, the broadcaster's published ones included. */
    const rec = await env.MARKETPLACE.get(bgKey(id), 'json');
    if (!rec) return json({ error: 'Unknown background' }, 404);
    if (!staff && String(rec.createdBy) !== String(session.user_id)) {
      return json({ error: 'That background is not yours.' }, 403);
    }
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
    const slug = checked.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    /* A member's ids live under their own prefix. Two members naming a
       background "my park" would otherwise be the same row, and the
       second save would be told the name was taken by a background they
       cannot see. The prefix is also what makes "list mine" one scan. */
    id = staff ? slug.slice(0, 40) : (`u${session.user_id}-` + slug).slice(0, 40);
  }
  if (!ID_RE.test(id) || RESERVED_IDS.has(id)) {
    return json({ error: 'That name does not make a usable id.' }, 400);
  }

  const existing = await env.MARKETPLACE.get(bgKey(id), 'json');
  if (creating && existing) return json({ error: 'A background with that name already exists.' }, 409);
  if (!creating && !existing) return json({ error: 'Unknown background' }, 404);

  if (existing && !staff && String(existing.createdBy) !== String(session.user_id)) {
    return json({ error: 'That background is not yours.' }, 403);
  }

  /* PUBLISHING IS THE SHARED CATALOGUE, so it stays staff-only. A member's
     background is personal: theirs to use and visible to anyone visiting
     their park, but it does not go into everyone's picker. Sharing between
     members would be a third state built on this ownership, not a flag a
     member can set for themselves. */
  if (!staff && body.publish === true) {
    return json({ error: 'Your backgrounds are yours to use — publishing to everyone is staff only.' }, 403);
  }

  /* The quota is on new rows only, so editing never trips it. */
  if (creating && !staff) {
    const mine = await env.MARKETPLACE.listValues({ prefix: `${KEY_PREFIX}u${session.user_id}-` });
    if ((mine || []).length >= PERSONAL_MAX) {
      return json({ error: `You can keep ${PERSONAL_MAX} backgrounds. Delete one to make another.` }, 409);
    }
  }

  const record = {
    id,
    name: checked.name,
    tilemap: checked.tilemap,
    /* Null when the author painted no fences, which is also every record
       written before the overlay existed. */
    fences: checked.fences,
    bgColor: checked.bgColor,
    mask: checked.mask,
    /* ABSENT means UNCHANGED. Save-with-edits used to send publish:false,
       which silently pulled a live background out of every player's
       picker -- the author thought they were saving progress and was
       actually unpublishing. Only an explicit true or false moves the
       flag now; a new background starts as a draft. */
    published: staff
      ? (body.publish === undefined ? (existing ? !!existing.published : false) : !!body.publish)
      : false,
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
