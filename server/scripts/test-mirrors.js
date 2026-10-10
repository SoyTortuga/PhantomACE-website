#!/usr/bin/env node
/* ══════════════════════════════════════════════
   HAND-SYNCED VALUES — the ones that must agree, checked

     node server/scripts/test-mirrors.js

   Several constants exist twice on purpose: an API handler cannot import
   from a game's inline <script>, so the server keeps its own copy of
   things the client also knows. Every one of them says "MUST MATCH" or
   "hand-synced" in a comment, and not one of them was checked by
   anything.

   A comment is not a constraint. The failure is always quiet — the two
   sides disagree, nobody sees an error, and something small goes wrong
   for somebody weeks later. SAVE_EPOCH is the clearest: the client
   DISCARDS any save whose epoch differs, so if the server stamps a
   different number, a player who redeems an egg gets a state the client
   throws away on sight and the egg silently vanishes. Its own comment
   says exactly that, in both files.

   Each check reads BOTH sides out of their real source. Adding a mirror
   means adding an entry here; that is the whole point of the file.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Pull one capture out of a file, failing loudly if the shape moved —
   a mirror check that silently matches nothing is worse than none. */
function grab(file, re, what) {
  const m = re.exec(read(file));
  ok(`${file}: ${what} is still findable`, !!m);
  return m ? m[1] : null;
}

const SERVER_PARK = 'functions/api/dino-park.js';
const CLIENT_PARK = 'games/dino-park/index.html';

/* ── SAVE_EPOCH ──────────────────────────────────────────────────────
   The client discards any save whose epoch differs — from localStorage
   OR the cloud. A server stamping a different number means a redeemed
   egg lands in a state the client throws away on sight. */
{
  const server = grab(SERVER_PARK, /^const SAVE_EPOCH = (\d+);/m, 'SAVE_EPOCH');
  const client = grab(CLIENT_PARK, /^const SAVE_EPOCH = (\d+);/m, 'SAVE_EPOCH');
  check('dino park: the save epoch agrees on both sides', server, client);

  /* A third copy lives in test-dino-hatch's fixtures. A fixture at the
     wrong epoch would build saves the real code rejects, and the suite
     would be testing a state that cannot happen. */
  const fixture = grab('server/scripts/test-dino-hatch.js', /^const SAVE_EPOCH = (\d+);/m, 'SAVE_EPOCH');
  check('and the hatch suite builds fixtures at that same epoch', fixture, server);
}

/* ── The park grid ───────────────────────────────────────────────────
   park-backgrounds validates a painted map against GRID; the game draws
   it at PARK_GRID. Disagree and either valid maps are rejected or
   invalid ones are stored. */
{
  const server = grab('functions/api/park-backgrounds.js', /^export const GRID = (\d+);/m, 'GRID');
  const cols = grab(CLIENT_PARK, /^const PARK_GRID = \{ COLS: (\d+)/m, 'PARK_GRID.COLS');
  const rows = grab(CLIENT_PARK, /^const PARK_GRID = \{ COLS: \d+, ROWS: (\d+)/m, 'PARK_GRID.ROWS');
  check('park backgrounds: the grid width agrees', server, cols);
  check('and the height', server, rows);
}

/* ── Incubator slots ─────────────────────────────────────────────────
   Both sides compute the cap from the sub tier. A server that allowed
   more than the client offers would accept a save the player could not
   have made; fewer, and a legitimate save is rejected. */
{
  const server = grab(SERVER_PARK, /return (\d+ \+ \(state\.subTier \|\| 0\) \* \d+);/, 'the slot formula');
  const client = grab(CLIENT_PARK,
    /function getMaxIncubatorSlots\(\) \{ return (\d+ \+ \(state\.subTier \|\| 0\) \* \d+); \}/,
    'getMaxIncubatorSlots');
  check('dino park: the incubator slot formula agrees', server, client);
}

/* ── Hatch times ─────────────────────────────────────────────────────
   The client runs the incubator clock and the server validates against
   it; a disagreement means eggs that hatch early are rejected, or late
   ones accepted. */
{
  const re = /^const HATCH_TIMES = (\{[^}]*\});/m;
  const server = grab(SERVER_PARK, re, 'HATCH_TIMES');
  const client = grab(CLIENT_PARK, re, 'HATCH_TIMES');
  const norm = (s) => (s || '').replace(/\s+/g, '');
  check('dino park: the hatch times agree', norm(server), norm(client));
  ok('and cover every rarity',
    ['common', 'uncommon', 'rare', 'epic', 'legendary'].every(r => (server || '').includes(r + ':')));
}

/* ── Colour swaps ────────────────────────────────────────────────────
   The server accepts any of the twelve ids; the client offers each
   species the three furthest from its base. A swap the client can apply
   and the server does not know is a save rejected on sync. */
{
  const serverList = grab(SERVER_PARK, /const COLOR_SWAP_IDS = \[([\s\S]*?)\];/, 'COLOR_SWAP_IDS');
  const serverIds = [...(serverList || '').matchAll(/'([a-z]+)'/g)].map(m => m[1]).sort();

  const clientBlock = /const COLOR_SWAPS=\[([\s\S]*?)\n\];/.exec(read(CLIENT_PARK));
  ok('the client colour swap list is findable', !!clientBlock);
  const clientIds = [...(clientBlock ? clientBlock[1] : '').matchAll(/id:'([a-z]+)'/g)].map(m => m[1]).sort();

  ok('both lists have entries', serverIds.length > 0 && clientIds.length > 0);
  check('dino park: the server knows every colour the client can apply',
    clientIds.filter(id => !serverIds.includes(id)), []);
  check('and offers none the client does not have',
    serverIds.filter(id => !clientIds.includes(id)), []);
}

/* ── Media categories ────────────────────────────────────────────────
   A category the upload route accepts but the page cannot filter by is
   an item nobody sees except under "All" — which is what the comment on
   the server list says, and what happened to audio until recently. */
{
  const list = grab('functions/api/media/upload.js', /^const CATEGORIES = \[([^\]]*)\];/m, 'CATEGORIES');
  const server = [...(list || '').matchAll(/'([a-z]+)'/g)].map(m => m[1]).sort();

  const html = read('media.html');
  /* The filter bar marks each category it can show. */
  const filters = [...html.matchAll(/data-filter="([a-z]+)"/g)].map(m => m[1])
    .filter(c => c !== 'all');
  /* And the upload form's own <select>. */
  const formBlock = /<select[^>]*id="uploadCategory"[\s\S]*?<\/select>/.exec(html);
  const options = formBlock
    ? [...formBlock[0].matchAll(/value="([a-z]+)"/g)].map(m => m[1]).filter(Boolean)
    : [];

  ok('the server category list is found', server.length > 0);
  ok('the page filter bar is found', filters.length > 0);
  ok('the upload form select is found', options.length > 0);

  check('media: every category the server accepts can be filtered for',
    server.filter(c => !filters.includes(c)), []);
  check('and every one can be chosen when uploading',
    server.filter(c => !options.includes(c)), []);
  check('and the page offers none the server would reject',
    [...new Set([...filters, ...options])].filter(c => !server.includes(c)), []);
}

/* ── The species roster ──────────────────────────────────────────────
   dino-species.js is hand-synced from the client roster. A species the
   server can roll and the client cannot draw is a dino with no sprite. */
{
  const server = read('functions/api/dino-species.js');
  const client = read(CLIENT_PARK);

  /* SPECIES is keyed by id: `compy : { name, rarity, icon }`. */
  const speciesBlock = /export const SPECIES = \{([\s\S]*?)\n\};/.exec(server);
  ok('the server roster block is found', !!speciesBlock);
  const serverIds = [...(speciesBlock ? speciesBlock[1] : '')
    .matchAll(/^\s*([a-z0-9_]+)\s*:\s*\{\s*name:/gm)].map(m => m[1]);
  ok('the server roster parses', serverIds.length > 5);

  /* The client names every species it can draw in its own roster. Checked
     by presence rather than by parsing its shape, which is inline and
     formatted for size. */
  const missing = [...new Set(serverIds)].filter(id => !client.includes(`'${id}'`));
  check('dino park: the client knows every species the server can roll', missing, []);
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[mirrors] ${passed} assertions passed.`);
