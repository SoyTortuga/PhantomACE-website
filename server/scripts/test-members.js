#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MEMBER DIRECTORY + PROFILE SOCIAL — test suite

     node server/scripts/test-members.js   (run from server/: node scripts/test-members.js)

   Two layers, both real:

   1. The migration itself, against Postgres (pglite, in-process) with
      005_profiles.sql + 010_profile_social.sql applied. The bio/links columns
      are GENERATED from the profile record's `value`, which is the only column
      the KV shim ever writes — so the test proves they populate from a shim
      write and track an UPDATE, and that the loginidx_ rows sharing the table
      (bare-string values) don't break the generated expressions.

   2. The handlers — functions/api/profile.js set-social and
      functions/api/members.js — against an in-memory env that COUNTS its
      calls. That is how "no N+1" is asserted: the directory must build itself
      from listValues() scans and make zero per-row get()s.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import {
  BIO_MAX, LINKS_MAX,
  sanitizeBio, sanitizeLink, sanitizeLinks,
  onRequestPost as profilePost,
  onRequestGet as profileGet,
} from '../../functions/api/profile.js';
import { onRequestGet as membersGet, PER_PAGE } from '../../functions/api/members.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_005 = fs.readFileSync(path.join(HERE, '../sql/005_profiles.sql'), 'utf8');
const SQL_010 = fs.readFileSync(path.join(HERE, '../sql/010_profile_social.sql'), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── An env that records how it was used ───────────────────────────────── */
function makeEnv(initial) {
  const store = new Map(Object.entries(initial || {}));
  const counts = { get: 0, listValues: 0, mutate: 0 };
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const MARKETPLACE = {
    async get(key, type) {
      counts.get++;
      if (!store.has(key)) return null;
      const v = clone(store.get(key));
      return type === 'json' ? v : (typeof v === 'string' ? v : JSON.stringify(v));
    },
    async listValues({ prefix } = {}) {
      counts.listValues++;
      const out = [];
      for (const [k, v] of store) if (k.startsWith(prefix || '')) out.push({ name: k, value: clone(v) });
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    },
    async mutate(key, fn) {
      counts.mutate++;
      const cur = store.has(key) ? clone(store.get(key)) : null;
      const next = await fn(cur);
      if (next === undefined) return cur;
      store.set(key, next);
      return next;
    },
    async put(key, value) { store.set(key, clone(value)); },
  };
  return { env: { MARKETPLACE }, store, counts };
}

function postReq(body, session) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers.Cookie = 'pham_session=' + encodeURIComponent(JSON.stringify(session));
  return new Request('http://localhost/api/profile', { method: 'POST', headers, body: JSON.stringify(body) });
}
const membersReq = (qs) => new Request('http://localhost/api/members' + (qs ? '?' + qs : ''));

/* ══════════════════════════════════════════════════════════════════════
   1. THE MIGRATION — generated columns over the shim's `value`
   ══════════════════════════════════════════════════════════════════════ */
{
  const db = new PGlite();
  await db.exec(SQL_005);
  await db.exec(SQL_010);
  /* Idempotent: a second apply must be a no-op, not a throw. */
  let reapplyErr = null;
  try { await db.exec(SQL_010); } catch (e) { reapplyErr = e; }
  check('010 re-applies cleanly', reapplyErr, null);

  /* A profile written exactly as the KV shim writes it: everything in value. */
  await db.query(
    `INSERT INTO profiles (key, value) VALUES ($1, $2::jsonb)`,
    ['profile_1', JSON.stringify({
      login: 'ace', displayName: 'Ace', firstSeen: '2026-01-02T00:00:00Z',
      bio: 'hello crypt', links: [{ label: 'Twitch', url: 'https://twitch.tv/x' }],
    })]
  );
  /* A loginidx row shares the table; its value is a bare JSON string. */
  await db.query(`INSERT INTO profiles (key, value) VALUES ($1, $2::jsonb)`, ['loginidx_ace', JSON.stringify('1')]);

  const r1 = (await db.query(`SELECT bio, links FROM profiles WHERE key = 'profile_1'`)).rows[0];
  check('bio is generated from value', r1.bio, 'hello crypt');
  check('links is generated from value', Array.isArray(r1.links) && r1.links.length, 1);

  const r2 = (await db.query(`SELECT bio, links FROM profiles WHERE key = 'loginidx_ace'`)).rows[0];
  check('a bare-string row generates a null bio', r2.bio, null);
  check('and a null links', r2.links, null);

  /* A shim UPDATE touches only value; the generated columns must follow. */
  await db.query(`UPDATE profiles SET value = jsonb_set(value, '{bio}', '"edited"') WHERE key = 'profile_1'`);
  check('generated bio tracks a value update',
    (await db.query(`SELECT bio FROM profiles WHERE key = 'profile_1'`)).rows[0].bio, 'edited');

  const idx = (await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'profiles'`)).rows.map(x => x.indexname);
  ok('the join-date index exists', idx.includes('profiles_firstseen_idx'));
  ok('the display-name index exists', idx.includes('profiles_displayname_idx'));

  await db.close();
}

/* ══════════════════════════════════════════════════════════════════════
   2a. set-social — validation and own-profile-only
   ══════════════════════════════════════════════════════════════════════ */

/* ── The sanitisers, directly ──────────────────────────────────────────── */
{
  check('a bio is trimmed', sanitizeBio('  hi  '), 'hi');
  check('a bio drops NULs', sanitizeBio('a\u0000b'), 'ab');
  check('a bio normalises newlines', sanitizeBio('a\r\nb'), 'a\nb');
  check('a bio is capped', sanitizeBio('x'.repeat(BIO_MAX + 50)).length, BIO_MAX);
  check('a null bio is empty string', sanitizeBio(null), '');

  check('an https link is kept', sanitizeLink({ label: 'Site', url: 'https://a.test/p' }),
    { label: 'Site', url: 'https://a.test/p' });
  ok('an http link is kept', !!sanitizeLink({ label: 'x', url: 'http://a.test' }));
  check('a label defaults to the host', sanitizeLink({ url: 'https://host.test/p' }).label, 'host.test');
  check('a javascript: url is refused', sanitizeLink({ label: 'x', url: 'javascript:alert(1)' }), null);
  check('a data: url is refused', sanitizeLink({ url: 'data:text/html,<script>' }), null);
  check('a mailto: url is refused', sanitizeLink({ url: 'mailto:a@b.test' }), null);
  check('a relative url is refused', sanitizeLink({ url: '/not/absolute' }), null);
  check('an empty url is refused', sanitizeLink({ url: '' }), null);
  check('a too-long url is refused', sanitizeLink({ url: 'https://a.test/' + 'y'.repeat(300) }), null);
  check('a long label is capped to 40', sanitizeLink({ label: 'z'.repeat(80), url: 'https://a.test' }).label.length, 40);

  const many = sanitizeLinks(Array.from({ length: 12 }, (_, i) => ({ label: 'L' + i, url: 'https://a.test/' + i })));
  check('links are capped to the max', many.length, LINKS_MAX);
  const mixed = sanitizeLinks([
    { label: 'ok', url: 'https://good.test' },
    { label: 'bad', url: 'javascript:1' },
    'not an object',
    { label: 'ok2', url: 'http://good2.test' },
  ]);
  check('bad links are dropped, good ones kept', mixed.map(l => l.label), ['ok', 'ok2']);
  check('a non-array links is empty', sanitizeLinks('nope'), []);
}

/* ── Through the handler ────────────────────────────────────────────────── */
{
  const { env } = makeEnv({});
  const res = await profilePost({ env, request: postReq({ action: 'set-social', bio: 'hi' }, null) });
  check('an anonymous set-social is 401', res.status, 401);
}
{
  const { env, store } = makeEnv({
    profile_100: { login: 'me', displayName: 'Me', firstSeen: '2026-01-01T00:00:00Z' },
    profile_999: { login: 'you', displayName: 'You', firstSeen: '2026-01-01T00:00:00Z' },
  });
  const res = await profilePost({
    env,
    request: postReq({
      action: 'set-social',
      /* A spurious target id in the body MUST be ignored. */
      userId: '999', id: '999',
      bio: 'x'.repeat(BIO_MAX + 100),
      links: [
        { label: 'Twitch', url: 'https://twitch.tv/me' },
        { label: 'evil', url: 'javascript:alert(1)' },
        { label: 'Discord', url: 'https://discord.gg/abc' },
      ],
    }, { user_id: '100', display_name: 'Me' }),
  });
  check('set-social succeeds for the owner', res.status, 200);
  const bodyOut = await res.json();
  check('the bio comes back capped', bodyOut.bio.length, BIO_MAX);
  check('a bad link is dropped', bodyOut.links.map(l => l.label), ['Twitch', 'Discord']);

  check('it wrote the OWN profile', store.get('profile_100').bio.length, BIO_MAX);
  check('and kept the existing login', store.get('profile_100').login, 'me');
  check('the body-named profile is untouched', store.get('profile_999').bio, undefined);
}
{
  /* No profile row yet → declined, not an identity minted from nothing. */
  const { env, store } = makeEnv({});
  const res = await profilePost({
    env, request: postReq({ action: 'set-social', bio: 'hi' }, { user_id: '42' }),
  });
  check('set-social with no profile is 404', res.status, 404);
  check('and wrote nothing', store.has('profile_42'), false);
}
{
  const { env } = makeEnv({ profile_7: { login: 'g', displayName: 'G' } });
  const res = await profilePost({ env, request: postReq({ action: 'nope' }, { user_id: '7' }) });
  check('an unknown action is 400', res.status, 400);
}

/* ── set-social surfaces on the public profile GET ──────────────────────── */
{
  const { env } = makeEnv({
    profile_55: {
      login: 'bio', displayName: 'Bio', firstSeen: '2026-01-01T00:00:00Z',
      bio: 'read me', links: [{ label: 'Site', url: 'https://s.test/' }, { label: 'x', url: 'ftp://nope' }],
    },
  });
  const res = await profileGet({ env, request: new Request('http://localhost/api/profile?id=55') });
  check('the profile reads back', res.status, 200);
  const p = await res.json();
  check('bio is surfaced to viewers', p.bio, 'read me');
  check('and only valid links are', p.links.map(l => l.label), ['Site']);
}

/* ══════════════════════════════════════════════════════════════════════
   2b. The directory — paging, search, equipped cosmetics, no N+1
   ══════════════════════════════════════════════════════════════════════ */
function seedDirectory(n) {
  const seed = {};
  for (let i = 1; i <= n; i++) {
    const id = String(i);
    seed['profile_' + id] = {
      login: 'user' + i,
      displayName: (i === 7 ? 'Zelda' : 'User ' + i),
      avatar: 'https://cdn.test/a' + i + '.png',
      role: 'viewer',
      /* Ascending join dates, so #n is newest. */
      firstSeen: new Date(Date.UTC(2026, 0, i)).toISOString(),
    };
  }
  /* The newest member (id n, first on page one) wears a title and a badge;
     everyone else wears nothing. */
  seed['inv_' + n] = {
    items: [
      { id: 'tt', game: 'profile', type: 'title', name: 'The Deathless', rarity: 'mythic' },
      { id: 'bd', game: 'profile', type: 'badge', name: 'Founder', rarity: 'rare', meta: { image: '/assets/b.png' } },
    ],
    equips: { profile: { title: 'tt', badge: 'bd' } },
  };
  /* A stray non-profile row under a different prefix must be ignored by the
     profile_ scan; a loginidx_ row must never be read as a member. */
  seed['loginidx_user1'] = '1';
  return seed;
}

{
  const { env, counts } = makeEnv(seedDirectory(30));
  const res = await membersGet({ env, request: membersReq('') });
  check('the directory responds', res.status, 200);
  const data = await res.json();

  check('a full page is returned', data.members.length, PER_PAGE);
  check('the total counts every member', data.total, 30);
  check('and the page count', data.pages, Math.ceil(30 / PER_PAGE));
  check('newest member leads by default', data.members[0].login, 'user30');

  const top = data.members.find(m => m.login === 'user30');
  check('an equipped title is resolved', top.title, { name: 'The Deathless', rarity: 'mythic' });
  check('and an equipped badge', top.badge, { name: 'Founder', rarity: 'rare', image: '/assets/b.png' });
  const bare = data.members.find(m => m.login === 'user29');
  check('a member with no inventory has no cosmetics', [bare.title, bare.badge], [null, null]);

  /* THE N+1 ASSERTION. The whole page was built from listValues() scans and
     not one per-row get(). */
  check('no per-row get()s', counts.get, 0);
  ok('it scanned with listValues', counts.listValues >= 1);
}

{
  /* Paging: page 2 of 30 holds the remainder, oldest last. */
  const { env } = makeEnv(seedDirectory(30));
  const res = await membersGet({ env, request: membersReq('page=2') });
  const data = await res.json();
  check('page two holds the remainder', data.members.length, 30 - PER_PAGE);
  check('page two reports its number', data.page, 2);
  check('the oldest member is last', data.members[data.members.length - 1].login, 'user1');
}

{
  /* A page past the end is empty but still knows the totals, and makes no
     inventory scan because there is nothing to resolve. */
  const { env, counts } = makeEnv(seedDirectory(30));
  const res = await membersGet({ env, request: membersReq('page=99') });
  const data = await res.json();
  check('a page past the end is empty', data.members.length, 0);
  check('but still reports the total', data.total, 30);
  check('an empty page needs only the profile scan', counts.listValues, 1);
}

{
  /* Name search matches login and display name, case-insensitively. */
  const { env } = makeEnv(seedDirectory(30));
  const zelda = await (await membersGet({ env, request: membersReq('q=zel') })).json();
  check('search matches a display name', zelda.members.map(m => m.login), ['user7']);

  const u1x = await (await membersGet({ env, request: membersReq('q=user1') })).json();
  /* user1, user10..user19 — eleven logins contain "user1". */
  check('search matches logins as a substring', u1x.total, 11);

  const none = await (await membersGet({ env, request: membersReq('q=zzzz') })).json();
  check('a miss returns nothing', none.total, 0);

  const short = await (await membersGet({ env, request: membersReq('q=u') })).json();
  check('a one-character term is ignored (no filter)', short.total, 30);
}

{
  /* Alphabetical sort. */
  const { env } = makeEnv(seedDirectory(5));
  const data = await (await membersGet({ env, request: membersReq('sort=name') })).json();
  check('A–Z sort orders by display name', data.members.map(m => m.displayName),
    ['User 1', 'User 2', 'User 3', 'User 4', 'User 5']);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[members] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[members] ${passed} assertions passed.`);
console.log('');
process.exit(0);
