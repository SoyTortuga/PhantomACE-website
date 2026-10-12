#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SITE ANNOUNCEMENTS — test suite

     node server/scripts/test-announcements.js

   A moderator's broadcast to the on-site bell. Two things must hold or it
   is either useless or a hole:

     THE GATE. Posting is moderators only, checked on the WRITE — a viewer
     who POSTs straight at the route is refused. Reading is public, because
     the bell shows these to everyone.

     IT SELF-CLEARS. Each entry carries its own expiry; the route must hide
     expired ones on read and drop them on the next write, so the bell never
     shows last month's maintenance notice and the stored list stays small.

   The bell ingests these into its own local list keyed by id, read-tracked
   by the device's last-opened time — so this also checks the client reads
   the fields the route actually sends.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { onRequestGet as annGet, onRequestPost as annPost } from '../../functions/api/announcements/index.js';

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

const DAY = 24 * 60 * 60 * 1000;

function store(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    map: m,
    MARKETPLACE: {
      async get(k) { return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null; },
      async put(k, v) { m.set(k, typeof v === 'string' ? JSON.parse(v) : v); },
      async mutate(k, fn) {
        const cur = m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null;
        const next = await fn(cur);
        if (next === undefined) return cur;
        m.set(k, next);
        return next;
      },
    },
  };
}

/* isModerator reads site_moderators from the same store. */
function withMods(env, ids) {
  env.map.set('site_moderators', { entries: ids.map(id => ({ userId: String(id) })) });
  return env;
}
const session = (id, name) => id == null ? {} :
  { Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: String(id), display_name: name || ('U' + id) })) };

async function get(env) {
  const res = await annGet({ env, request: new Request('http://localhost/api/announcements') });
  return { status: res.status, body: await res.json() };
}
async function post(env, body, headers) {
  const res = await annPost({
    env,
    request: new Request('http://localhost/api/announcements', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body),
    }),
  });
  return { status: res.status, body: await res.json() };
}

/* ── The gate ────────────────────────────────────────────────────────── */
{
  const env = withMods(store(), ['9']);

  check('a logged-out POST is refused', (await post(env, { action: 'create', message: 'hi' }, session(null))).status, 401);
  check('a viewer is refused', (await post(env, { action: 'create', message: 'hi' }, session('1'))).status, 403);
  check('nothing was written', env.map.get('site_announcements'), undefined);

  const r = await post(env, { action: 'create', message: 'Server down til 9pm' }, session('9', 'ModMandy'));
  check('a moderator may post', r.status, 200);
  check('and it is stored', env.map.get('site_announcements').length, 1);

  /* The gate is on the write, not just the page. */
  const src = read('functions/api/announcements/index.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  ok('onRequestPost checks isModerator', /isModerator\(env, session\)/.test(src));
}

/* ── Reading is public ──────────────────────────────────────────────── */
{
  const env = withMods(store(), ['9']);
  await post(env, { action: 'create', message: 'Giveaway at 8' }, session('9', 'Mandy'));
  const r = await get(env);           // no cookie at all
  check('anyone can read the list', r.status, 200);
  check('and sees the message', r.body.announcements[0].message, 'Giveaway at 8');
  check('with who posted it', r.body.announcements[0].by, 'Mandy');
  /* The author's user id is never STORED, only their display name — so
     there is nothing for a public read to leak even by accident. */
  const stored = env.map.get('site_announcements')[0];
  ok('the stored entry keeps only name, not the author id', !('userId' in stored) && !('by_id' in stored) && !('user_id' in stored));
  check('its fields are exactly these', Object.keys(stored).sort(), ['by', 'createdAt', 'expiresAt', 'id', 'message']);
}

/* ── Validation ─────────────────────────────────────────────────────── */
{
  const env = withMods(store(), ['9']);
  check('an empty message is refused', (await post(env, { action: 'create', message: '   ' }, session('9'))).status, 400);
  check('an over-long one is refused', (await post(env, { action: 'create', message: 'x'.repeat(281) }, session('9'))).status, 400);
  check('right at the limit is fine', (await post(env, { action: 'create', message: 'x'.repeat(280) }, session('9'))).status, 200);
  check('an unknown action is refused', (await post(env, { action: 'nope' }, session('9'))).status, 400);

  /* Days is clamped, never trusted. */
  const a = await post(env, { action: 'create', message: 'a', days: 999 }, session('9'));
  const life = a.body.announcement.expiresAt - a.body.announcement.createdAt;
  ok('a wild day count is clamped to the max', life <= 30 * DAY + 1000);
  const b = await post(env, { action: 'create', message: 'b', days: 0 }, session('9'));
  ok('and zero or less becomes at least a day', (b.body.announcement.expiresAt - b.body.announcement.createdAt) >= DAY - 1000);
}

/* ── It self-clears ─────────────────────────────────────────────────── */
{
  const now = Date.now();
  const env = withMods(store({
    site_announcements: [
      { id: 'live', message: 'still good', by: 'A', createdAt: now - DAY, expiresAt: now + DAY },
      { id: 'stale', message: 'last month', by: 'B', createdAt: now - 40 * DAY, expiresAt: now - 30 * DAY },
    ],
  }), ['9']);

  const r = await get(env);
  check('an expired entry is hidden on read', r.body.announcements.length, 1);
  check('and it is the live one', r.body.announcements[0].id, 'live');

  /* A new post compacts the stale one out of storage, not just the view. */
  await post(env, { action: 'create', message: 'new' }, session('9'));
  const stored = env.map.get('site_announcements').map(a => a.id);
  ok('the stale entry is gone from storage after a write', !stored.includes('stale'));
  ok('the live one survived', stored.includes('live'));

  /* Newest first. */
  const after = await get(env);
  check('newest is on top', after.body.announcements[0].message, 'new');
}

/* ── Delete ─────────────────────────────────────────────────────────── */
{
  const env = withMods(store(), ['9']);
  const made = await post(env, { action: 'create', message: 'oops wrong' }, session('9'));
  const id = made.body.announcement.id;
  const del = await post(env, { action: 'delete', id }, session('9'));
  check('a moderator can remove one', del.status, 200);
  check('and it reports it removed something', del.body.removed, true);
  check('the list is empty after', (await get(env)).body.announcements.length, 0);
  /* Idempotent: removing a gone one is not an error. */
  check('removing it again is still ok', (await post(env, { action: 'delete', id }, session('9'))).status, 200);
  check('a viewer cannot delete', (await post(env, { action: 'delete', id: 'x' }, session('1'))).status, 403);

  const cap = withMods(store(), ['9']);
  for (let i = 0; i < 14; i++) await post(cap, { action: 'create', message: 'm' + i }, session('9'));
  ok('the stored list is capped, not unbounded', cap.map.get('site_announcements').length <= 10);
}

/* ── A broken read never takes the bell down ────────────────────────── */
{
  const env = { MARKETPLACE: { async get() { throw new Error('db down'); } } };
  const r = await annGet({ env, request: new Request('http://localhost/api/announcements') });
  check('a storage error reads as empty, not an error', r.status, 200);
  check('with an empty list', (await r.json()).announcements, []);
}

/* ── The bell reads what the route writes ───────────────────────────── */
{
  const bell = read('js/notifications.js');
  ok('the bell fetches the endpoint', /fetch\('\/api\/announcements'/.test(bell));
  ok('it keys each one by id to dedupe across tabs and reloads', /'ann:' \+ a\.id/.test(bell));
  ok('and uses the server time, so an old notice does not nag as new', /Number\(a\.createdAt\)/.test(bell));
  ok('the type has an icon', /case 'announcement':/.test(bell));
  ok('it runs signed out too', /loadAnnouncements\);/.test(bell) && !/hasSessionCookie[\s\S]{0,40}loadAnnouncements/.test(bell));

  /* Registered, or the route 500s silently. */
  ok('the key is in the registry', /site_announcements:/.test(read('server/lib/registry.js')));

  /* Linked from where a moderator works. */
  const botHtml = read('bot-control.html');
  ok('Bot Control has the compose box', /id="siteNotifyText"/.test(botHtml) && /Notify the Site/.test(botHtml));
  ok('and the handler is wired', /initSiteNotify\(\)/.test(read('js/pages/bot-control.js')));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[announcements] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[announcements] ${passed} assertions passed.`);
