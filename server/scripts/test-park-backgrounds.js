#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PARK BACKGROUNDS — the studio's data layer

     node server/scripts/test-park-backgrounds.js

   A studio background is data other people's games will render: the
   tilemap becomes URLs in every visitor's browser and the mask decides
   where every player's dinos may stand. So the tests are about the shape
   of what is accepted, who may write it, and the ids that hold player
   saves together.

   THE REFS ARE THE SECURITY LINE. A tilemap cell is turned into an image
   URL by every client that renders the background, so the charset bound
   (set/index only) is what keeps a record from naming a path outside the
   palette tree. Everything else -- mask/tile agreement, aesthetics -- is a
   gameplay concern among trusted authors, and the route says so in the
   comment this suite pins.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet, onRequestPost, validateBackground, GRID }
  from '../../functions/api/park-backgrounds.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const API = fs.readFileSync(path.join(REPO, 'functions/api/park-backgrounds.js'), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, v) { store.set(key, String(v)); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      return { keys: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })) };
    },
    /* Mirrors the real DAL: one scan returning {name, value} for a prefix. */
    async listValues({ prefix } = {}) {
      const out = [];
      for (const [name, raw] of store) {
        if (!prefix || name.startsWith(prefix)) {
          out.push({ name, value: raw === undefined ? null : JSON.parse(raw) });
        }
      }
      return out;
    },
  };
}

const BROADCASTER = '111';
function env(seed = {}) {
  return {
    /* The shape isModerator actually reads: site_moderators.entries[].userId. */
    MARKETPLACE: fakeKV({ site_moderators: JSON.stringify({ entries: [{ userId: '222' }] }), ...seed }),
    TWITCH_BROADCASTER_ID: BROADCASTER,
  };
}
const as = (id, name = 'Someone') => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: name })) });
/* The cookie's `role` is what the subscriber gate reads; the moderator
   LIST is separate and outranks it, which is why staff are still `as`. */
const asRole = (id, role) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'Member ' + id, role })) });
const GET = (e, qs = '', h) => onRequestGet({ env: e, request: new Request('https://phantomace.tv/api/park-backgrounds' + qs, { headers: h }) });
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://phantomace.tv/api/park-backgrounds', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });

const row = (c) => Array(GRID).fill(c);
/* THE MASK MUST NOW MATCH THE TILES — the server derives it from
   park-zones.js and refuses a submission that disagrees, because authors
   are no longer all staff. So the fixture paints water where it claims
   water: grass on top, pond underneath. Before this it painted grass
   everywhere and declared the bottom third ocean, which is precisely the
   forgery the check exists to catch. */
const good = (over = {}) => ({
  action: 'save',
  name: 'Moonlit Lagoon',
  tilemap: Array.from({ length: GRID }, (_, y) => row(y < 24 ? 'moonlit/03' : 'water/00')),
  mask: Array.from({ length: GRID }, (_, y) => (y < 24 ? 'L' : 'O').repeat(GRID)),
  ...over,
});

/* ══ Only staff can write ══════════════════════════════════════════════ */
{
  const e = env();
  check('anonymous save is refused', (await POST(e, good())).status, 401);
  check('a viewer cannot save', (await POST(e, good(), as('999'))).status, 403);
  check('a moderator can', (await POST(e, good(), as('222', 'Mod'))).status, 200);
  check('and the broadcaster can', (await POST(e, good({ name: 'Volcano Rim' }), as(BROADCASTER))).status, 200);
  ok('a viewer wrote nothing', ![...e.MARKETPLACE.store.keys()].some(k => k.includes('999')));
}

/* ══ The shape gate ════════════════════════════════════════════════════ */
{
  const cases = [
    ['no name', { name: '  ' }],
    ['short tilemap', { tilemap: Array.from({ length: 5 }, () => row('mud/01')) }],
    ['short row', { tilemap: Array.from({ length: GRID }, () => Array(3).fill('mud/01')) }],
    ['a path-shaped ref', { tilemap: Array.from({ length: GRID }, () => row('../../secrets/00')) }],
    ['a URL-shaped ref', { tilemap: Array.from({ length: GRID }, () => row('https://evil/x')) }],
    ['a bad mask charset', { mask: Array.from({ length: GRID }, () => 'Z'.repeat(GRID)) }],
    ['a short mask row', { mask: Array.from({ length: GRID }, () => 'L'.repeat(5)) }],
  ];
  for (const [label, over] of cases) {
    ok(`${label} is refused`, 'error' in validateBackground(good(over)));
  }
  ok('a well-formed background is accepted', !('error' in validateBackground(good())));
  /* Null is a valid cell. A WHOLLY empty map is refused now for having no
     walkable land, which it always should have been — so this paints a
     real map with a hole in it and masks the hole X, which is what an
     unpainted cell means. */
  ok('empty cells are allowed as null', !('error' in validateBackground(good({
    tilemap: Array.from({ length: GRID }, (_, y) =>
      row(y < 24 ? 'moonlit/03' : 'water/00').map((c, x) => (y === 0 && x === 0 ? null : c))),
    mask: Array.from({ length: GRID }, (_, y) =>
      (y < 24 ? 'L' : 'O').repeat(GRID)).map((r, y) => (y === 0 ? 'X' + r.slice(1) : r)),
  }))));

  /* All-water strands every land dino at apply time; refuse it while the
     author is still in the editor. */
  /* Tiles and mask agree here, so this is refused for the reason it is
     meant to be — no walkable land — rather than for disagreeing. */
  ok('an all-ocean map is refused',
     'error' in validateBackground(good({
       tilemap: Array.from({ length: GRID }, () => row('water/00')),
       mask: Array.from({ length: GRID }, () => 'O'.repeat(GRID)),
     })));
}

/* ══ Ids: derived once, immutable, never the built-in ══════════════════ */
{
  const e = env();
  const made = await (await POST(e, good(), as('222'))).json();
  check('the id derives from the name', made.background.id, 'moonlit-lagoon');

  const dup = await POST(e, good(), as('222'));
  check('creating the same name again collides', dup.status, 409);

  const renamed = await POST(e, good({ id: 'moonlit-lagoon', name: 'Moonlit Cove' }), as('222'));
  check('an update keeps the id through a rename', (await renamed.json()).background.id, 'moonlit-lagoon');

  check('the classic id is reserved', (await POST(e, good({ name: 'Classic' }), as('222'))).status, 400);
  check('updating a ghost 404s', (await POST(e, good({ id: 'never-was' }), as('222'))).status, 404);

  const authored = JSON.parse(e.MARKETPLACE.store.get('park_bg_moonlit-lagoon'));
  check('the author comes from the session', authored.createdBy, '222');
}

/* ══ Publishing controls who sees what ═════════════════════════════════ */
{
  const e = env();
  await POST(e, good({ publish: false }), as('222', 'Mod'));
  await POST(e, good({ name: 'Volcano Rim', publish: true }), as('222', 'Mod'));

  const pub = await (await GET(e)).json();
  check('the public catalogue holds only published work', pub.backgrounds.map(b => b.id), ['volcano-rim']);
  check('and announces the grid size', pub.grid, GRID);

  const anonDraft = await GET(e, '?id=moonlit-lagoon');
  check('a draft 404s for the public', anonDraft.status, 404);
  check('but staff can open it', (await GET(e, '?id=moonlit-lagoon', as('222'))).status, 200);

  const staffList = await (await GET(e, '?drafts=1', as('222'))).json();
  check('and list it when they ask for drafts', staffList.backgrounds.length, 2);
  const anonDrafts = await (await GET(e, '?drafts=1')).json();
  check('asking for drafts anonymously changes nothing', anonDrafts.backgrounds.map(b => b.id), ['volcano-rim']);
}

/* ══ Saving edits must not unpublish ═══════════════════════════════════ */
{
  /* The trap that ate the first background anyone made: Save-with-edits
     sent publish:false and silently pulled a live background out of every
     player's picker. Absent now means unchanged. */
  const e = env();
  await POST(e, good({ publish: true }), as('222'));
  await POST(e, good({ id: 'moonlit-lagoon', name: 'Moonlit Lagoon' }), as('222'));   /* no publish field */
  const still = await (await GET(e)).json();
  check('a plain save leaves it published', still.backgrounds.map(b => b.id), ['moonlit-lagoon']);

  await POST(e, good({ id: 'moonlit-lagoon', publish: false }), as('222'));
  check('an explicit false does unpublish', (await (await GET(e)).json()).backgrounds, []);

  const fresh = await POST(e, good({ name: 'New One' }), as('222'));
  check('a new background with no flag starts as a draft', (await fresh.json()).background.published, false);
}

/* ══ Delete, and the record it leaves ══════════════════════════════════ */
{
  const e = env();
  await POST(e, good({ publish: true }), as('222'));
  check('a viewer cannot delete', (await POST(e, { action: 'delete', id: 'moonlit-lagoon' }, as('999'))).status, 403);
  await POST(e, { action: 'delete', id: 'moonlit-lagoon' }, as('222'));
  check('a moderator can', (await GET(e, '?id=moonlit-lagoon', as('222'))).status, 404);
}

/* ══ The lines the route promises ══════════════════════════════════════ */
{
  ok('the grid matches the game', GRID === 32);
  /* Still charset-bound; the ref now carries an optional right-angle
     rotation, because the fence sheets ship one orientation per piece.
     Only the part before `r` ever becomes a file path, so the guarantee
     this line exists for is unchanged. */
  ok('refs are charset-bound to the palette tree',
     /TILE_RE = \/\^\[a-z0-9\]\{1,20\}\\\/\\d\{2\}\(r\(\?:90\|180\|270\)\)\?\$\//.test(API));
  ok('the reserved list covers the built-in', /RESERVED_IDS = new Set\(\['classic', 'default'\]\)/.test(API));
  /* The limitation this used to pin is GONE: the mask is derived
     server-side from park-zones.js and a disagreeing submission is
     refused. What is worth pinning now is that the check is actually
     wired, because a forged mask is the whole risk of letting non-staff
     author. */
  ok('the mask is checked against the tiles, not trusted',
     /The mask does not match the tiles at/.test(API));
  ok('and it uses the server-side zone table', /from '\.\/park-zones\.js'/.test(API));
  /* Authoring is gated; USE is not. A lapsed subscriber keeps what they
     made, so no tier check may appear in the GET path. */
  ok('authoring is subscriber-gated', /canAuthor\(env, session\)/.test(API));
  ok('publishing to everyone stays staff-only', /publishing to everyone is staff only/.test(API));

  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the prefix is registered', /prefix: 'park_bg_'/.test(reg));
  ok('and never expires on a timer', /prefix: 'park_bg_'[^}]*expiry: 'none'/.test(reg));
}

/* ── Report ──────────────────────────────────────────────────────────── */

/* ══ Authoring is a sub perk; USE is not ═══════════════════════════════
   The rule that is easiest to break later: a subscription buys the
   STUDIO, not the backgrounds made in it. Someone whose sub lapses keeps
   every one they made and keeps picking them in-game. So the tier check
   belongs on POST alone, and a GET must never ask about it. */
{
  const e = env();

  check('a visitor cannot author', (await POST(e, good(), as('999'))).status, 403);
  check('a follower cannot either',
        (await POST(e, good(), asRole('998', 'follower'))).status, 403);

  const made = await POST(e, good(), asRole('777', 'sub_tier1'));
  check('a tier 1 subscriber can', made.status, 200);
  const rec = (await made.json()).background;

  /* Namespaced, so two members naming a background the same thing are not
     the same row. */
  ok('a member id is namespaced to them', rec.id.startsWith('u777-'));
  check('and it is theirs', rec.createdBy, '777');
  check('and personal, not published', rec.published, false);

  /* THE LAPSE. Same person, now a plain viewer. */
  const list = await (await GET(e, '', as('777'))).json();
  ok('a lapsed subscriber still sees their own background',
     (list.backgrounds || []).some(b => b.id === rec.id));
  check('and can still resolve it by id',
        (await GET(e, '?id=' + rec.id, as('777'))).status, 200);
  check('but can no longer author', (await POST(e, good({ name: 'Another' }), as('777'))).status, 403);
}

/* ══ Personal means personal ═══════════════════════════════════════════ */
{
  const e = env();
  const mine = (await (await POST(e, good(), asRole('777', 'sub_tier1'))).json()).background;

  const theirList = await (await GET(e, '', asRole('888', 'sub_tier1'))).json();
  ok('somebody else does not get it in their picker',
     !(theirList.backgrounds || []).some(b => b.id === mine.id));

  /* But a visitor standing in that park has to render it, and the park
     save already names the id — so by-id resolution is open. */
  check('though they can resolve it by id, to render a visit',
        (await GET(e, '?id=' + mine.id, as('888'))).status, 200);

  check('and they cannot edit it',
        (await POST(e, good({ id: mine.id, name: 'Hijack' }), asRole('888', 'sub_tier1'))).status, 403);
  check('nor delete it',
        (await POST(e, { action: 'delete', id: mine.id }, asRole('888', 'sub_tier1'))).status, 403);
  check('but the owner can delete it',
        (await POST(e, { action: 'delete', id: mine.id }, asRole('777', 'sub_tier1'))).status, 200);
}

/* ══ A member cannot publish to everyone ═══════════════════════════════ */
{
  const e = env();
  check('publishing is refused for a member',
        (await POST(e, good({ publish: true }), asRole('777', 'sub_tier1'))).status, 403);

  const saved = (await (await POST(e, good(), asRole('777', 'sub_tier1'))).json()).background;
  check('and a saved one is never published', saved.published, false);

  /* Staff keep the shared catalogue. */
  const staff = await POST(e, good({ name: 'Staff Map', publish: true }), as('222'));
  check('staff can publish', (await staff.json()).background.published, true);
}

/* ══ A FORGED MASK IS REFUSED ══════════════════════════════════════════
   The whole reason non-staff authoring needed the zone check: without it
   a member paints solid rock and declares all of it swimmable. */
{
  const forged = good({
    mask: Array.from({ length: GRID }, (_, y) => (y < 24 ? 'L' : 'L').repeat(GRID)),
  });
  ok('a mask that disagrees with the tiles is refused',
     'error' in validateBackground(forged));

  const swimRock = good({
    tilemap: Array.from({ length: GRID }, () => row('stone/00')),
    mask: Array.from({ length: GRID }, () => 'O'.repeat(GRID)),
  });
  ok('solid rock cannot be declared swimmable', 'error' in validateBackground(swimRock));

  /* A fence is X whatever is painted under it. */
  const fenced = good();
  fenced.fences = Array.from({ length: GRID }, () => row(null));
  fenced.fences[1][1] = 'fencewood/00';
  ok('a fenced cell claimed walkable is refused', 'error' in validateBackground(fenced));
  fenced.mask = fenced.mask.map((r, y) => (y === 1 ? r.slice(0, 1) + 'X' + r.slice(2) : r));
  ok('and accepted once the mask marks it impassable',
     !('error' in validateBackground(fenced)));
}

/* ══ The quota ═════════════════════════════════════════════════════════ */
{
  const e = env();
  let last = null;
  for (let i = 0; i < 10; i++) {
    last = await POST(e, good({ name: 'Map ' + i }), asRole('777', 'sub_tier1'));
  }
  check('a member runs out of slots', last.status, 409);
  const mine = await (await GET(e, '', as('777'))).json();
  ok('and keeps the ones they made', (mine.backgrounds || []).length >= 8);
}

/* ══ The game carries through every field it renders ══════════════════
   loadBackgroundCatalog copies the API's record into the shape the rest of
   dino-park expects, field by field. A field the composer READS but the
   loader does not COPY is silently missing -- no error, no console warning,
   just a background that renders wrong, and only for studio maps, because
   the built-ins are constructed elsewhere.

   That is exactly what happened: composeTilemap reads `fences` and
   `bgColor`, the loader copied neither, and so every studio background lost
   its fence layer and sat on flat black instead of the ground colour its
   author had picked in the studio's own preview.

   DERIVED, not listed: whatever the composer reads, the loader must copy, so
   a layer added to the renderer is caught the day it is added. */
{
  const game = fs.readFileSync(path.join(REPO, 'games/dino-park/index.html'), 'utf8');

  const composer = (game.match(/function composeTilemap\(entry[\s\S]*?\n\}/) || [''])[0];
  ok('composeTilemap is found in the game', composer.length > 0);
  const reads = [...new Set([...composer.matchAll(/entry\.([a-zA-Z]+)/g)].map(m => m[1]))].sort();
  ok('and it reads at least the tilemap', reads.includes('tilemap'));

  const loader = (game.match(/studioBackgrounds\[bg\.id\] = \{[\s\S]*?\};/) || [''])[0];
  ok('the catalogue loader is found', loader.length > 0);
  const copied = new Set([...loader.matchAll(/([a-zA-Z]+):\s*bg\.([a-zA-Z]+)/g)].map(m => m[1]));

  check('every field composeTilemap renders is copied out of the API record',
    reads.filter(f => !copied.has(f)), []);

  /* And those fields have to survive the API round trip, or copying them in
     the client is moot. */
  const e = env();
  const withFence = good();
  withFence.fences = Array.from({ length: GRID }, () => row(null));
  withFence.fences[1][1] = 'fencewood/00';
  withFence.mask = withFence.mask.map((r, y) => (y === 1 ? r.slice(0, 1) + 'X' + r.slice(2) : r));
  withFence.bgColor = '#1a0b0b';
  const saved = await POST(e, withFence, asRole('555', 'sub_tier1'));
  check('a background with fences and a ground colour saves', saved.status, 200);

  const listed = await (await GET(e, '', as('555'))).json();
  const mine = (listed.backgrounds || []).find(b => String(b.createdBy) === '555');
  ok('and comes back in the listing', !!mine);
  check('with its fences intact', mine && mine.fences && mine.fences[1][1], 'fencewood/00');
  check('and its ground colour', mine && mine.bgColor, '#1a0b0b');
}

console.log('');
if (failures.length) {
  console.log(`[park-backgrounds] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[park-backgrounds] ${passed} assertions passed.`);
console.log('');
