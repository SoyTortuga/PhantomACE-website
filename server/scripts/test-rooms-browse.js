#!/usr/bin/env node
/* ══════════════════════════════════════════════
   ROOM CRAWL — the community reader over Dino Park saves

     node server/scripts/test-rooms-browse.js

   Room Crawl stores no parks of its own: it reads the `dino_park_` saves and
   gates them on the `parkpub_` consent rows the game already writes. So the
   tests are about who appears, who can write what, and the two bounded social
   records it adds — the guestbook and the weekly visit tally.

   THE OPT-IN IS THE LINE. A park is on the wall only when its owner opted into
   visiting; a private park is never listed and never served. The guestbook is
   bounded and one-per-visitor by construction, the visit tally counts an owner
   once a week, and Room of the Week is the broadcaster's alone.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet, onRequestPost } from '../../functions/api/rooms-browse.js';
import { weekKey, monthKey } from '../../functions/api/season-time.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const API = fs.readFileSync(path.join(REPO, 'functions/api/rooms-browse.js'), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Mirrors test-park-backgrounds.js's fake KV — get/put/delete/list/listValues —
   plus mutate(key, fn, options), which is the extension rooms-browse.js leans
   on. Call counters let the gallery assert it scans with listValues rather than
   list()-then-get-per-key. */
function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  const counts = { get: 0, put: 0, list: 0, listValues: 0, mutate: 0 };
  return {
    store, counts,
    async get(key, type) {
      counts.get++;
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, v) { counts.put++; store.set(key, String(v)); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      counts.list++;
      return { keys: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
    async listValues({ prefix } = {}) {
      counts.listValues++;
      const out = [];
      for (const [name, raw] of store) {
        if (!prefix || name.startsWith(prefix)) out.push({ name, value: raw === undefined ? null : JSON.parse(raw) });
      }
      return out;
    },
    async mutate(key, mutator, _options = {}) {
      counts.mutate++;
      const raw = store.get(key);
      const current = raw === undefined ? null : JSON.parse(raw);
      const next = await mutator(current);
      if (next === undefined) return current;
      store.set(key, JSON.stringify(next));
      return next;
    },
  };
}

const BROADCASTER = '111';
function env(seed = {}) {
  return { MARKETPLACE: fakeKV(seed), TWITCH_BROADCASTER_ID: BROADCASTER };
}
const as = (id, name = 'Someone', extra = {}) =>
  ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: name, ...extra })) });
const GET = (e, qs = '', h) => onRequestGet({ env: e, request: new Request('https://phantomace.tv/api/rooms-browse' + qs, { headers: h }) });
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://phantomace.tv/api/rooms-browse', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(h || {}) }, body: JSON.stringify(body) }) });

/* A Dino Park save and its consent row. */
const save = (over = {}) => JSON.stringify({
  userId: over.userId || '200', savedAt: over.savedAt || 1,
  state: {
    parkDay: 7, discovered: ['rex', 'trike'], coins: 99999,
    park: [{ speciesId: 'rex', nickname: 'Chomp', careCount: 10, xp: 100, px: 40, py: 40 }],
    yardItems: [{ id: 'a', type: 'cycad', x: 10, y: 20 }],
    background: 'lagoon',
    favorite: { specId: 'rex', src: '/games/dino-park/assets/rex.png', nickname: 'Chomp', species: 'T-Rex', rarity: 'legendary' },
    ...(over.state || {}),
  },
});
const consent = (name, avatar = '') => JSON.stringify({ name, avatar, since: 1 });

/* ══ The gallery lists only public parks, via listValues ════════════════ */
{
  const e = env({
    'dino_park_200': save({ userId: '200', savedAt: 50 }), 'parkpub_200': consent('Keeper Two', 'https://cdn/two.png'),
    'dino_park_300': save({ userId: '300', savedAt: 90 }), 'parkpub_300': consent('Keeper Three'),
    'dino_park_900': save({ userId: '900' }),                      /* NOT opted in */
  });
  e.MARKETPLACE.counts.list = 0; e.MARKETPLACE.counts.listValues = 0;

  const body = await (await GET(e)).json();
  check('only opted-in parks are listed', body.rooms.map(r => r.id).sort(), ['200', '300']);
  check('the private park is excluded', body.rooms.some(r => r.id === '900'), false);
  check('active parks sort first', body.rooms[0].id, '300');          /* savedAt 90 > 50 */
  check('the owner name comes from the consent row', body.rooms.find(r => r.id === '200').owner, 'Keeper Two');
  check('and the avatar too', body.rooms.find(r => r.id === '200').avatar, 'https://cdn/two.png');
  ok('a light summary rides along', body.rooms[0].summary && body.rooms[0].summary.species === 2);
  ok('the favourite card rides along', body.rooms[0].favorite && body.rooms[0].favorite.specId === 'rex');

  ok('the gallery scanned with listValues', e.MARKETPLACE.counts.listValues >= 2);
  check('and never fell back to list()-then-get-per-key', e.MARKETPLACE.counts.list, 0);

  /* No private field escapes onto a card. */
  ok('no coin balance reaches the gallery', !JSON.stringify(body).includes('99999'));
}

/* ══ Logged-out may browse, but not stamp ══════════════════════════════ */
{
  const e = env({ 'dino_park_200': save(), 'parkpub_200': consent('Keeper Two') });

  check('an anonymous gallery read is allowed', (await GET(e)).status, 200);
  const anonGallery = await (await GET(e)).json();
  check('and reports the viewer as logged out', anonGallery.you.loggedIn, false);

  check('an anonymous room view is allowed', (await GET(e, '?id=200')).status, 200);

  const stamp = await POST(e, { action: 'guestbook', ownerId: '200', stamp: 'skull' });
  check('but an anonymous stamp is refused', stamp.status, 401);
  ok('and nothing was written', !e.MARKETPLACE.store.has('roomguestbook_200'));
}

/* ══ A private park is never served ════════════════════════════════════ */
{
  const e = env({ 'dino_park_900': save({ userId: '900' }) });   /* no parkpub_ */
  const res = await GET(e, '?id=900', as('100', 'Visitor'));
  check('viewing a park that never opted in is refused', res.status, 403);
  ok('and says so', /not open/i.test((await res.json()).error || ''));
}

/* ══ The room view projects the park and carries the guestbook ═════════ */
{
  const e = env({ 'dino_park_200': save(), 'parkpub_200': consent('Keeper Two') });
  const body = await (await GET(e, '?id=200', as('100', 'Visitor'))).json();
  check('the owner is named from consent', body.room.owner, 'Keeper Two');
  check('the roster is projected', body.room.park.park.length, 1);
  check('and a species count, not the list', body.room.park.speciesDiscovered, 2);
  ok('the favourite comes through full', body.room.favorite && body.room.favorite.species === 'T-Rex');
  check('the guestbook starts empty', body.guestbook, []);
  ok('nothing private is projected', !JSON.stringify(body).includes('99999'));
  check('a visitor is told they can stamp', body.you.canStamp, true);
}

/* ══ Guestbook: one stamp per visitor, newest wins, bounded ════════════ */
{
  const e = env({ 'dino_park_200': save(), 'parkpub_200': consent('Keeper Two') });

  let r = await (await POST(e, { action: 'guestbook', ownerId: '200', stamp: 'skull', note: 'spooky!' }, as('100', 'Visitor'))).json();
  check('a stamp lands', r.stamps.length, 1);
  check('the stamp id is the visitor', r.stamps[0].id, '100');
  check('the name comes from the session', r.stamps[0].name, 'Visitor');

  r = await (await POST(e, { action: 'guestbook', ownerId: '200', stamp: 'ghost' }, as('100', 'Visitor'))).json();
  check('the same visitor stamping again does not stack', r.stamps.length, 1);
  check('and the latest stamp wins', r.stamps[0].stamp, 'ghost');

  check('an unknown stamp is refused', (await POST(e, { action: 'guestbook', ownerId: '200', stamp: 'nope' }, as('100'))).status, 400);
  check('a stamp on a private park is refused', (await POST(e, { action: 'guestbook', ownerId: '900', stamp: 'skull' }, as('100'))).status, 403);

  for (let i = 0; i < 60; i++) {
    r = await (await POST(e, { action: 'guestbook', ownerId: '200', stamp: 'star' }, as('5' + i, 'V' + i))).json();
  }
  ok('the guestbook stays bounded at 50', r.stamps.length <= 50);
  const ids = new Set(r.stamps.map(s => s.id));
  check('and every kept stamp is from a distinct visitor', ids.size, r.stamps.length);
}

/* ══ A visit is tallied once per owner per week ════════════════════════ */
{
  const e = env({
    'dino_park_200': save({ userId: '200' }), 'parkpub_200': consent('Keeper Two'),
    'dino_park_300': save({ userId: '300' }), 'parkpub_300': consent('Keeper Three'),
  });
  const wk = weekKey();
  const key = 'roomvisits_100_' + wk;

  await GET(e, '?id=200', as('100', 'Visitor'));
  check('the first visit is banked', JSON.parse(e.MARKETPLACE.store.get(key)).owners, ['200']);

  await GET(e, '?id=200', as('100', 'Visitor'));
  check('re-visiting the same park does not re-count', JSON.parse(e.MARKETPLACE.store.get(key)).owners, ['200']);

  await GET(e, '?id=300', as('100', 'Visitor'));
  const tally = JSON.parse(e.MARKETPLACE.store.get(key));
  check('a different park adds to the week', tally.owners.sort(), ['200', '300']);
  /* C2's quests.js reads rec.count, so it must track the set size. */
  check('the count C2 reads tracks the set', tally.count, 2);

  /* Viewing your own room is not a crawl. */
  const e2 = env({ 'dino_park_100': save({ userId: '100' }), 'parkpub_100': consent('Me') });
  await GET(e2, '?id=100', as('100', 'Me'));
  ok('viewing your own park records nothing', !e2.MARKETPLACE.store.has('roomvisits_100_' + wk));

  /* A logged-out view records nothing. */
  const e3 = env({ 'dino_park_200': save(), 'parkpub_200': consent('Keeper Two') });
  await GET(e3, '?id=200');
  ok('an anonymous view records no visit', ![...e3.MARKETPLACE.store.keys()].some(k => k.startsWith('roomvisits_')));
}

/* ══ Room of the Week is the broadcaster's alone ═══════════════════════ */
{
  const e = env({ 'dino_park_200': save(), 'parkpub_200': consent('Keeper Two', 'https://cdn/two.png') });

  check('an anonymous set is refused', (await POST(e, { action: 'room-of-week', ownerId: '200' })).status, 403);
  check('a viewer cannot set it', (await POST(e, { action: 'room-of-week', ownerId: '200' }, as('999'))).status, 403);
  ok('nothing was written', !e.MARKETPLACE.store.has('room_of_week'));

  const set = await POST(e, { action: 'room-of-week', ownerId: '200', note: 'Pick of the week' }, as(BROADCASTER));
  check('the broadcaster can set it', set.status, 200);
  const feat = (await set.json()).featured;
  check('and it names the park from consent', feat.ownerName, 'Keeper Two');
  check('the broadcaster note is kept', feat.note, 'Pick of the week');

  const gallery = await (await GET(e)).json();
  check('the gallery surfaces the featured room', gallery.featured.ownerId, '200');

  check('featuring a private park is refused', (await POST(e, { action: 'room-of-week', ownerId: '900' }, as(BROADCASTER))).status, 403);

  const cleared = await POST(e, { action: 'room-of-week', clear: true }, as(BROADCASTER));
  check('the broadcaster can clear it', (await cleared.json()).featured, null);
  ok('and the row is gone', !e.MARKETPLACE.store.has('room_of_week'));
}

/* ══ Haunted contest: enter your own public park, toggle off ═══════════ */
{
  const e = env({ 'dino_park_200': save({ userId: '200' }), 'parkpub_200': consent('Keeper Two') });
  const mk = monthKey();

  check('entering needs a login', (await POST(e, { action: 'haunted' })).status, 401);

  const noPark = await POST(e, { action: 'haunted' }, as('777', 'No Park'));
  check('entering without an open park is refused', noPark.status, 403);

  const entered = await (await POST(e, { action: 'haunted' }, as('200', 'Keeper Two'))).json();
  check('a keeper can enter their own park', entered.entered, true);
  check('and it is recorded for the month', JSON.parse(e.MARKETPLACE.store.get('room_haunted_' + mk)).owners, ['200']);

  /* And it shows on the gallery card and room view. */
  const card = (await (await GET(e)).json()).rooms.find(r => r.id === '200');
  check('the gallery marks the haunted room', card.haunted, true);

  const out = await (await POST(e, { action: 'haunted', enter: false }, as('200', 'Keeper Two'))).json();
  check('withdrawing works', out.entered, false);
  check('and clears the entry', JSON.parse(e.MARKETPLACE.store.get('room_haunted_' + mk)).owners, []);
}

/* ══ Login resolution mirrors profile.js ═══════════════════════════════ */
{
  const e = env({
    'dino_park_200': save(), 'parkpub_200': consent('Keeper Two'),
    'loginidx_keepertwo': '200',
  });
  const body = await (await GET(e, '?u=KeeperTwo', as('100'))).json();
  check('a park resolves by login', body.room.id, '200');
  check('an unknown login 404s', (await GET(e, '?u=ghostface', as('100'))).status, 404);
}

/* ══ The lines the route promises ══════════════════════════════════════ */
{
  ok('the guestbook key is the documented one', /roomguestbook_\$\{ownerId\}/.test(API));
  ok('the visit tally key is per-user-per-week', /roomvisits_\$\{userId\}_\$\{wk\}/.test(API));
  ok('the haunted key is per-month', /room_haunted_\$\{mk\}/.test(API));
  ok('Room of the Week is a singleton', /ROTW_KEY = 'room_of_week'/.test(API));
  ok('it reuses the park consent, not a second flag', /from '\.\/dino-park\.js'/.test(API) && /VISIT_KEY_PREFIX/.test(API));
  ok('the visit write is best-effort', /best-effort/.test(API));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[rooms-browse] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[rooms-browse] ${passed} assertions passed.`);
console.log('');
