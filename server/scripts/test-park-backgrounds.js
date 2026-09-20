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
const GET = (e, qs = '', h) => onRequestGet({ env: e, request: new Request('https://phantomace.tv/api/park-backgrounds' + qs, { headers: h }) });
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://phantomace.tv/api/park-backgrounds', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });

const row = (c) => Array(GRID).fill(c);
const good = (over = {}) => ({
  action: 'save',
  name: 'Moonlit Lagoon',
  tilemap: Array.from({ length: GRID }, () => row('moonlit/03')),
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
  ok('empty cells are allowed as null',
     !('error' in validateBackground(good({ tilemap: Array.from({ length: GRID }, () => row(null)) }))));

  /* All-water strands every land dino at apply time; refuse it while the
     author is still in the editor. */
  ok('an all-ocean map is refused',
     'error' in validateBackground(good({ mask: Array.from({ length: GRID }, () => 'O'.repeat(GRID)) })));
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
  ok('refs are charset-bound to the palette tree', /TILE_RE = \/\^\[a-z0-9\]\{1,20\}\\\/\\d\{2\}\$\//.test(API));
  ok('the reserved list covers the built-in', /RESERVED_IDS = new Set\(\['classic', 'default'\]\)/.test(API));
  ok('the zone-check limitation is written down where the code is',
     /If backgrounds ever open to\s+non-staff, cross-checking mask against palette zones/.test(API));

  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the prefix is registered', /prefix: 'park_bg_'/.test(reg));
  ok('and never expires on a timer', /prefix: 'park_bg_'[^}]*expiry: 'none'/.test(reg));
}

/* ── Report ──────────────────────────────────────────────────────────── */
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
