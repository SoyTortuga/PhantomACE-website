#!/usr/bin/env node
/* ══════════════════════════════════════════════
   USER DIRECTORY — the roster the broadcaster elevates from

     node server/scripts/test-admin-users.js

   The route joins two things and writes nothing: the profile_ rows (one
   per logged-in user) and the moderator list. So the tests are about the
   join being right and the gate being real — a moderator may read the
   roster, only the broadcaster gets canEdit, and the "is a mod" column
   comes from the mod LIST, never from the role stamped on a profile at its
   last login (which can lie: a mod who logged in before being promoted
   still carries the old role).
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet } from '../../functions/api/admin/users.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async listValues({ prefix } = {}) {
      return [...store.keys()].filter(k => k.startsWith(prefix))
        .map(k => ({ name: k, value: JSON.parse(store.get(k)) }));
    },
  };
}
const as = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) });
const GET = (e, h) => onRequestGet({ env: e, request: new Request('https://x/api/admin/users', { headers: h }) });

/* A world: three profiles (one of them a mod), the broadcaster, the mod list. */
function world() {
  return {
    MARKETPLACE: fakeKV({
      site_moderators: { entries: [{ userId: '222', displayName: 'HelperMod', login: 'helpermod' }] },
      profile_111: { userId: '111', login: 'phantomace', displayName: 'PhantomACE', role: 'broadcaster', avatar: 'a.png', updatedAt: 300 },
      profile_222: { userId: '222', login: 'helpermod', displayName: 'HelperMod', role: 'visitor', avatar: 'b.png', updatedAt: 100 },
      profile_333: { userId: '333', login: 'regular', displayName: 'Regular', role: 'follower', avatar: 'c.png', updatedAt: 200 },
    }),
    TWITCH_BROADCASTER_ID: '111',
  };
}

/* ══ The gate ══════════════════════════════════════════════════════════ */
{
  const e = world();
  check('anonymous is refused', (await GET(e)).status, 403);
  check('a plain viewer is refused', (await GET(e, as('333'))).status, 403);
  check('a moderator may view', (await GET(e, as('222'))).status, 200);
  check('and the broadcaster may', (await GET(e, as('111'))).status, 200);
}

/* ══ The join ══════════════════════════════════════════════════════════ */
{
  const e = world();
  const body = await (await GET(e, as('111'))).json();
  check('every logged-in user is listed', body.count, 3);
  check('the mod count comes from the list', body.modCount, 1);
  check('the broadcaster sees canEdit', body.canEdit, true);

  const byId = Object.fromEntries(body.users.map(u => [u.userId, u]));

  /* THE JOIN THAT MATTERS. HelperMod's profile role is 'visitor' — stamped
     before promotion — but the mod LIST says they are a mod, and the list
     wins. Trusting the profile role would show a moderator as a nobody. */
  check('a mod is flagged from the list, not the stale profile role', byId['222'].isMod, true);
  check('even though their profile role lags', byId['222'].role, 'visitor');
  check('a non-mod is not flagged', byId['333'].isMod, false);
  check('the broadcaster is marked as such', byId['111'].isBroadcaster, true);

  /* Mods first, then most-recently-seen. */
  check('mods sort to the top', body.users[0].userId, '222');
  check('then by last seen, newest first', [body.users[1].userId, body.users[2].userId], ['111', '333']);
}

/* ══ A moderator viewer gets the roster but not the keys ═══════════════ */
{
  const e = world();
  const body = await (await GET(e, as('222'))).json();
  check('a moderator sees everyone', body.count, 3);
  check('but has no canEdit', body.canEdit, false);
}

/* ══ Malformed rows are skipped, not crashed on ═══════════════════════ */
{
  const e = world();
  e.MARKETPLACE.store.set('profile_bad', JSON.stringify({ note: 'no userId here' }));
  e.MARKETPLACE.store.set('profile_null', 'null');
  const body = await (await GET(e, as('111'))).json();
  check('a profile with no userId is dropped', body.count, 3);
}

/* ══ Wiring: writes go through the mod route, not here ═════════════════ */
{
  const src = fs.readFileSync(path.join(REPO, 'functions/api/admin/users.js'), 'utf8');
  ok('the route is read-only — no POST handler', !/onRequestPost/.test(src));

  const page = fs.readFileSync(path.join(REPO, 'js/pages/users.js'), 'utf8');
  ok('elevation posts to the moderators route', /MODS_API = '\/api\/admin\/moderators'/.test(page));
  ok('elevate adds by name', /action: 'add', name: login/.test(page));
  ok('demote removes by id', /action: 'remove', userId: id/.test(page));
  ok('and hides the controls a moderator cannot use', /if \(!canEdit\)/.test(page));

  const tb = fs.readFileSync(path.join(REPO, 'functions/api/admin/toolbox.js'), 'utf8');
  ok('the toolbox links the users page', /\/users\.html/.test(tb));
  ok('the page exists', fs.existsSync(path.join(REPO, 'users.html')));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[admin-users] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[admin-users] ${passed} assertions passed.`);
console.log('');
