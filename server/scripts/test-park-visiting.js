#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO PARK — visiting someone else's park

     node server/scripts/test-park-visiting.js

   WHAT THIS FEATURE BREAKS, and why the tests look the way they do.
   dino-park.js says it plainly above sanitizeFavorite: the save is stored
   wholesale and never read by the server, which is harmless ONLY while one
   person can see it. The client writes that document, so every field in it
   is attacker-controlled. Visiting makes it public and therefore makes
   every field a thing somebody else's browser will render.

   So the assertions are about what a visitor CANNOT get, as much as what
   they can. A projection that returns one field too many is the bug, and a
   denylist would pass every test here while still leaking the next field
   somebody adds to the save. The whitelist is checked by feeding it a
   state full of things that must not come back.

   The other half is consent. A park is invisible until its owner turns
   visiting on, opting out takes effect at once, and nobody can list
   themselves under another player's name.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet, onRequestPost } from '../../functions/api/dino-park.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PAGE = fs.readFileSync(path.join(REPO, 'games/dino-park/index.html'), 'utf8').replace(/\r\n/g, '\n');
const API = fs.readFileSync(path.join(REPO, 'functions/api/dino-park.js'), 'utf8');
const MKT = fs.readFileSync(path.join(REPO, 'functions/api/marketplace.js'), 'utf8');

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
      return {
        keys: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })),
        list_complete: true,
      };
    },
  };
}
const envWith = (seed) => ({ MARKETPLACE: fakeKV(seed) });
const as = (userId, name) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: userId, display_name: name })) });
const GET = (env, qs, headers) => onRequestGet({ env, request: new Request('https://phantomace.tv/api/dino-park' + qs, { headers }) });
const POST = (env, body, headers) => onRequestPost({ env, request: new Request('https://phantomace.tv/api/dino-park', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }) });

/* A save carrying everything a visitor must never receive. */
const SECRETS = {
  coins: 999999,
  vault: [{ speciesId: 'rex', nickname: 'vaulted' }],
  eggs: [{ speciesId: 'rex', hatchTime: 1800 }],
  eggStorage: [{ speciesId: 'rex' }],
  cooldowns: { feed_0: 12 },
  energy: 7,
  subTier: 3,
  usedCodes: ['SECRET-CODE-1'],
  lastDailyDig: 123456789,
  grantSeq: 42,
  yardItems: [{ id: 'fern', x: 1, y: 2 }],
};
const OWNER_SAVE = JSON.stringify({
  userId: '200', savedAt: 1,
  state: {
    ...SECRETS,
    parkDay: 9,
    discovered: ['rex', 'trike', 'raptor'],
    park: [
      { speciesId: 'rex', nickname: 'Chomp', careCount: 90, xp: 5000, mutation: 'albino' },
      { speciesId: 'trike', nickname: '', careCount: 5, xp: 50 },
    ],
  },
});
const OPEN = JSON.stringify({ name: 'Keeper Two', since: 1 });

/* ══ A closed park stays closed ════════════════════════════════════════ */
{
  const env = envWith({ 'dino_park_200': OWNER_SAVE });      /* no parkpub_ row */
  const res = await GET(env, '?visit=200', as('100', 'Visitor'));
  check('visiting a park that never opted in is refused', res.status, 403);
  const body = await res.json();
  ok('and says so rather than 404ing ambiguously', /not open/i.test(body.error || ''));
}

/* ══ Opting out takes effect immediately ═══════════════════════════════ */
{
  const env = envWith({ 'dino_park_200': OWNER_SAVE, 'parkpub_200': OPEN });
  check('an opted-in park is visitable', (await GET(env, '?visit=200', as('100'))).status, 200);

  await POST(env, { action: 'set-visitable', visitable: false }, as('200', 'Keeper Two'));
  check('after opting out it is refused', (await GET(env, '?visit=200', as('100'))).status, 403);

  /* THE CONSENT CHECK RUNS BEFORE THE READ. If it ran after, a park would
     stay reachable for as long as somebody held its id. */
  ok('consent is checked before the save is loaded',
     API.indexOf("const pass = await env.MARKETPLACE.get(visitKey(userId)") <
     API.indexOf("const record = await env.MARKETPLACE.get(saveKey(userId)"));
}

/* ══ The projection: what comes back, and what must not ════════════════ */
{
  const env = envWith({ 'dino_park_200': OWNER_SAVE, 'parkpub_200': OPEN });
  const body = await (await GET(env, '?visit=200', as('100'))).json();

  check('the owner is named from their consent row', body.ownerName, 'Keeper Two');
  check('the roster comes through', body.park.park.length, 2);
  check('with the park day', body.park.parkDay, 9);
  check('and a species count rather than the list', body.park.speciesDiscovered, 3);

  /* THE WHOLE POINT. Every private field, by name. */
  const leaked = Object.keys(SECRETS).filter(k => k in body.park);
  check('nothing private is projected', leaked, []);

  /* And nothing private hides inside a dino either. */
  const dinoKeys = [...new Set(body.park.park.flatMap(d => Object.keys(d)))].sort();
  check('a visited dino carries only these fields', dinoKeys,
        ['careCount', 'mutation', 'nickname', 'speciesId', 'xp']);

  /* Serialise the whole response and look for the actual secret values —
     catches a leak through a field name nobody thought to list. */
  const wire = JSON.stringify(body);
  const traces = ['999999', 'SECRET-CODE-1', 'vaulted', 'feed_0'].filter(t => wire.includes(t));
  check('no private value appears anywhere in the response', traces, []);
}

/* ══ A hostile save cannot become markup or nonsense ═══════════════════ */
{
  const nasty = JSON.stringify({
    userId: '300', savedAt: 1,
    state: {
      parkDay: 1e9, discovered: [],
      park: [
        { speciesId: 'rex', nickname: '<img src=x onerror=alert(1)>'.repeat(20), careCount: -5, xp: 1e30 },
        { speciesId: '../../etc/passwd', nickname: 'path' },
        { speciesId: 'rex', mutation: '<script>', nickname: 'ok' },
        'not even an object',
        null,
      ],
    },
  });
  const env = envWith({ 'dino_park_300': nasty, 'parkpub_300': JSON.stringify({ name: 'Bad Actor' }) });
  const body = await (await GET(env, '?visit=300', as('100'))).json();
  const park = body.park.park;

  /* Five entries in, two out: the string, the null and the one whose
     speciesId is outside the ID charset are all refused. */
  check('only the valid dinos survive projection', park.length, 2);
  ok('an out-of-charset speciesId is dropped', !park.some(d => d.speciesId.includes('..')));
  check('a hostile mutation is blanked', park.find(d => d.nickname === 'ok').mutation, '');
  ok('a long nickname is capped', park[0].nickname.length <= 24);
  check('a negative careCount floors at zero', park[0].careCount, 0);
  ok('an absurd xp is capped to something finite', Number.isFinite(park[0].xp) && park[0].xp <= 1e9);
  ok('an absurd parkDay is capped', body.park.parkDay <= 100000);
}

/* ══ Consent rows carry the session's name, never the caller's claim ═══ */
{
  const env = envWith({});
  await POST(env, { action: 'set-visitable', visitable: true, name: 'PhantomACE' }, as('400', 'Honest Name'));
  const row = JSON.parse(env.MARKETPLACE.store.get('parkpub_400'));
  check('the listed name comes from the session', row.name, 'Honest Name');
  ok('a name in the request body is ignored', row.name !== 'PhantomACE');
}

/* ══ Random picks only from consenting parks, and never yourself ═══════ */
{
  const env = envWith({
    'dino_park_100': OWNER_SAVE, 'parkpub_100': JSON.stringify({ name: 'Me' }),
    'dino_park_200': OWNER_SAVE, 'parkpub_200': OPEN,
    'dino_park_900': OWNER_SAVE,                       /* has NOT opted in */
  });

  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const body = await (await GET(env, '?visit=random', as('100', 'Me'))).json();
    seen.add(body.ownerName);
  }
  check('random only ever lands on opted-in parks', [...seen].sort(), ['Keeper Two']);
  ok('and never on your own park', !seen.has('Me'));

  /* With nobody else listed, say so rather than serving your own park. */
  const alone = envWith({ 'dino_park_100': OWNER_SAVE, 'parkpub_100': JSON.stringify({ name: 'Me' }) });
  check('with no other parks it reports none', (await GET(alone, '?visit=random', as('100', 'Me'))).status, 404);
}

/* ══ Visiting needs a session ══════════════════════════════════════════ */
{
  const env = envWith({ 'dino_park_200': OWNER_SAVE, 'parkpub_200': OPEN });
  check('an anonymous visit is refused', (await GET(env, '?visit=200')).status, 401);
  check('and so is an anonymous random', (await GET(env, '?visit=random')).status, 401);
}

/* ══ The owner's own GET still works and reports the toggle ════════════ */
{
  const env = envWith({ 'dino_park_200': OWNER_SAVE, 'parkpub_200': OPEN });
  const mine = await (await GET(env, '', as('200'))).json();
  ok('the owner still gets their whole save', mine.state.coins === 999999);
  check('and is told they are visitable', mine.visitable, true);

  const closed = envWith({ 'dino_park_200': OWNER_SAVE });
  check('a private park reports false', (await (await GET(closed, '', as('200'))).json()).visitable, false);
}

/* ══ Nicknames are escaped wherever they are rendered ══════════════════ */
{
  /* The live bug this shipped alongside: market cards interpolated another
     player's nickname straight into innerHTML. */
  ok('the page has an escaper', /function escapeHtml\(/.test(PAGE));
  ok('and a single helper for dino names', /function dinoName\(/.test(PAGE));

  /* Only HTML sinks. A nickname inside confirm() or showToast is plain
     text — confirm renders no markup and showToast writes textContent — and
     escaping those would DISPLAY the entities rather than prevent anything.
     Checked line by line so the exclusion is visible rather than a regex
     nobody can read. */
  const htmlSinkLeaks = PAGE.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\$\{[^}]*\.nickname[^}]*\}/.test(line))
    .filter(({ line }) => !/\bconfirm\(|showToast\(|textContent/.test(line))
    .map(({ line, n }) => `${n}: ${line.trim().slice(0, 70)}`);
  check('no HTML template interpolates a raw nickname', htmlSinkLeaks, []);

  ok('the visit view escapes the owner name', /escapeHtml\(data\.ownerName/.test(PAGE));
  ok('and its cards use dinoName', /visit-card-name">\$\{dinoName\(/.test(PAGE));

  /* Capped on the server too: escaping is the render-side half, and the
     listing is stored and re-served for as long as it is up. */
  ok('the marketplace caps a listed nickname', /nickname: String\(body\.dino\.nickname[\s\S]{0,80}\.slice\(0, 24\)/.test(MKT));
  ok('and the projection caps it as well', /nickname: String\(d\.nickname \|\| ''\)\.trim\(\)\.slice\(0, 24\)/.test(API));
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the consent prefix is registered', /prefix: 'parkpub_'/.test(reg));
  ok('and never expires on a timer', /prefix: 'parkpub_'[^}]*expiry: 'none'/.test(reg));

  ok('the client reads the toggle from the server', /parkVisitable = !!\(data && data\.visitable\)/.test(PAGE));
  ok('the visit button is wired', /onclick="visitRandomPark\(\)"/.test(PAGE));
  /* Read-only: the visited park must never be written into state, or the
     care and sell paths would suddenly have something to act on. */
  ok('a visited park never enters state', !/state\.park = .*data\.park/.test(PAGE));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[park-visiting] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[park-visiting] ${passed} assertions passed.`);
console.log('');
