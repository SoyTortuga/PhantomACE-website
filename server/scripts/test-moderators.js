#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MODERATOR ALLOWLIST — test suite

     node server/scripts/test-moderators.js

   This list decides who can drop codes into chat and run a giveaway, so
   the interesting assertions are not about the happy path. They are about
   who may change it, and about what gets STORED when a human types a name.

   THE CHANGE THIS COVERS. Adding somebody used to require their numeric
   Twitch id, and the panel's own hint pointed at a third-party website to
   convert a username into one. The id is still what gets stored — names
   change hands, and an allowlist keyed on something renameable eventually
   hands one person's privileges to whoever claims their name next — but
   the lookup is the server's job now.

   Which introduces the failure worth guarding: a name that resolves to the
   WRONG account, or to none, must not reach the list. Twitch is stubbed
   here so both can be tested.
   ══════════════════════════════════════════════ */

import * as mods from '../../functions/api/admin/moderators.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const BROADCASTER = '900';

/* The channel, as Twitch would answer for it. */
const ACCOUNTS = [
  { id: '111', login: 'soytortuga', display_name: 'SoyTortuga' },
  { id: '222', login: 'nyxweaver', display_name: 'NyxWeaver' },
  { id: '333', login: 'grimlock_tv', display_name: 'GRIMLOCK' },
];

let lookups = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.pathname === '/helix/users') {
    const login = u.searchParams.get('login');
    const id = u.searchParams.get('id');
    lookups.push(login ? 'login:' + login : 'id:' + id);
    const hit = ACCOUNTS.find(a => (login && a.login === login.toLowerCase()) || (id && a.id === id));
    return new Response(JSON.stringify({ data: hit ? [hit] : [] }), { status: 200 });
  }
  if (u.pathname === '/oauth2/token') {
    return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

function makeEnv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  store.set('twitch_app_token', JSON.stringify({ access_token: 'app-token', expiresAt: Date.now() + 3600e3 }));
  return {
    TWITCH_BROADCASTER_ID: BROADCASTER,
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'secret',
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next !== undefined) store.set(k, JSON.stringify(next));
        return next === undefined ? cur : next;
      },
    },
    _store: store,
  };
}

const cookie = (userId, name) =>
  `pham_session=${encodeURIComponent(JSON.stringify({ user_id: userId, display_name: name || ('u' + userId) }))}`;

const post = (env, body, userId) => mods.onRequestPost({
  env,
  request: new Request('https://phantomace.tv/api/admin/moderators', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(userId ? { Cookie: cookie(userId) } : {}) },
    body: JSON.stringify(body),
  }),
});

const get = (env, userId) => mods.onRequestGet({
  env,
  request: new Request('https://phantomace.tv/api/admin/moderators', {
    headers: userId ? { Cookie: cookie(userId) } : {},
  }),
});

const listed = (env) => {
  const raw = env._store.get('site_moderators');
  return raw ? JSON.parse(raw).entries : [];
};

const fresh = () => { lookups = []; return makeEnv(); };

/* ── Only the broadcaster may grant it ───────────────────────────────── */
{
  const env = fresh();

  const anon = await post(env, { action: 'add', name: 'soytortuga' });
  check('a stranger cannot add a moderator', anon.status, 403);

  /* NOR CAN A MODERATOR. Managing who holds power is not itself delegated:
     one added account could otherwise add its friends, and the broadcaster
     would never see it happen. */
  await post(env, { action: 'add', name: 'soytortuga' }, BROADCASTER);
  const byMod = await post(env, { action: 'add', name: 'nyxweaver' }, '111');
  check('nor can an existing moderator', byMod.status, 403);
  check('so the list is unchanged', listed(env).map(m => m.userId), ['111']);
}

/* ── A username is enough ────────────────────────────────────────────── */
{
  const env = fresh();
  const r = await (await post(env, { action: 'add', name: 'nyxweaver' }, BROADCASTER)).json();

  check('adding by username works', r.changed, true);
  check('and it was looked up by login', lookups, ['login:nyxweaver']);
  /* THE ID IS WHAT IS STORED. Names change hands; this list cannot. */
  check('the numeric id is stored', listed(env)[0].userId, '222');
  /* Twitch's own name, not what was typed — the list is read to answer
     "who has this power". */
  check('with Twitch display name', listed(env)[0].displayName, 'NyxWeaver');
  check('and the login', listed(env)[0].login, 'nyxweaver');
  /* Echoed back so the panel can name who it added. */
  check('and the account is echoed back', r.account.displayName, 'NyxWeaver');
}

/* ── Typed carelessly, still right ───────────────────────────────────── */
{
  const env = fresh();
  await post(env, { action: 'add', name: '  @NyxWeaver  ' }, BROADCASTER);
  /* An @ and stray spaces are how a name arrives when it is copied out of
     chat, which is where it will usually be copied from. */
  check('an @ prefix and spaces are tolerated', listed(env)[0].userId, '222');
  check('and lower-cased for the lookup', lookups, ['login:nyxweaver']);
}

/* ── A name that is not an account ───────────────────────────────────── */
{
  const env = fresh();
  const r = await post(env, { action: 'add', name: 'nyxweavr' }, BROADCASTER);
  check('a typo is refused', r.status, 400);
  ok('and says the account does not exist', /No Twitch account called/.test((await r.json()).error));
  /* THE POINT. A resolution failure must not put anything on the list. */
  check('nothing was added', listed(env), []);

  const junk = await post(env, { action: 'add', name: 'not a name!' }, BROADCASTER);
  check('an impossible name is refused before Twitch is asked', junk.status, 400);
  check('without a lookup', lookups.length, 1);
}

/* ── A numeric id still works, and is still checked ──────────────────── */
{
  const env = fresh();
  const r = await (await post(env, { action: 'add', userId: '333' }, BROADCASTER)).json();
  check('pasting an id works', r.changed, true);
  check('and it is looked up, not trusted', lookups, ['id:333']);
  /* So the list shows a name even when an id was pasted. */
  check('so the entry still has a name', listed(env)[0].displayName, 'GRIMLOCK');

  const ghost = await post(env, { action: 'add', userId: '999999' }, BROADCASTER);
  /* An id belonging to nobody would sit on the list for ever, looking like
     somebody and matching no one. */
  check('an id belonging to no account is refused', ghost.status, 400);
}

/* ── The broadcaster is already in ───────────────────────────────────── */
{
  const env = fresh();
  ACCOUNTS.push({ id: BROADCASTER, login: 'phantomace', display_name: 'PhantomACE' });
  const r = await post(env, { action: 'add', name: 'phantomace' }, BROADCASTER);
  check('adding yourself is refused', r.status, 400);
  ok('and says why', /already have access/.test((await r.json()).error));
  ACCOUNTS.pop();
}

/* ── Adding twice ────────────────────────────────────────────────────── */
{
  const env = fresh();
  await post(env, { action: 'add', name: 'nyxweaver' }, BROADCASTER);
  const again = await (await post(env, { action: 'add', name: 'nyxweaver' }, BROADCASTER)).json();
  /* Accepted and did nothing, which is not the same as "added" and must
     not be reported as it. */
  check('adding the same person twice changes nothing', again.changed, false);
  check('and says so', again.note, 'already on the list');
  check('leaving one entry', listed(env).length, 1);
}

/* ── Removing ────────────────────────────────────────────────────────── */
{
  const env = fresh();
  await post(env, { action: 'add', name: 'nyxweaver' }, BROADCASTER);
  lookups = [];

  /* BY ID, NEVER BY NAME. The id comes from the rendered list; resolving a
     name at removal time could take out the wrong row after a rename. */
  const byName = await post(env, { action: 'remove', name: 'nyxweaver' }, BROADCASTER);
  check('removing by name is refused', byName.status, 400);
  check('and asks nothing of Twitch', lookups, []);
  check('so they are still listed', listed(env).length, 1);

  const byId = await (await post(env, { action: 'remove', userId: '222' }, BROADCASTER)).json();
  check('removing by id works', byId.changed, true);
  check('and the list is empty', listed(env), []);
}

/* ── Access takes effect at once ─────────────────────────────────────── */
{
  /* The whole reason isModerator() reads the list on every call rather than
     trusting the session's role field: a removed moderator must not keep
     access until their cookie expires. */
  const env = fresh();
  const session = { user_id: '222', display_name: 'NyxWeaver' };

  check('not on the list, not a moderator', await mods.isModerator(env, session), false);
  await post(env, { action: 'add', name: 'nyxweaver' }, BROADCASTER);
  check('added, and immediately a moderator', await mods.isModerator(env, session), true);
  await post(env, { action: 'remove', userId: '222' }, BROADCASTER);
  check('removed, and immediately not', await mods.isModerator(env, session), false);

  /* And the broadcaster never depends on the list, so emptying it cannot
     lock them out of their own panel. */
  check('the broadcaster always passes', await mods.isModerator(env, { user_id: BROADCASTER }), true);
}

/* ── Who may read it ─────────────────────────────────────────────────── */
{
  const env = fresh();
  await post(env, { action: 'add', name: 'nyxweaver' }, BROADCASTER);

  const viewer = await get(env, '12345');
  check('a viewer cannot read the list', viewer.status, 403);

  const mod = await (await get(env, '222')).json();
  /* Knowing who else can drop codes is useful and not sensitive. */
  check('a moderator can', mod.moderators.length, 1);
  check('but is told they may not edit it', mod.canEdit, false);

  const owner = await (await get(env, BROADCASTER)).json();
  check('and the broadcaster may', owner.canEdit, true);
}

/* ── The panel asks for a name, not an id ────────────────────────────── */
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  const html = fs.readFileSync(path.join(REPO, 'bot-control.html'), 'utf8');
  ok('the field asks for a username', /placeholder="Twitch username"/.test(html));
  /* The old field and the third-party converter it pointed at are the
     hassle this removed; neither should come back. */
  ok('the numeric-id field is gone', !/botModUserId/.test(html));
  ok('and so is the third-party lookup link', !/streamscharts/.test(html));

  const js = fs.readFileSync(path.join(REPO, 'js/pages/bot-control.js'), 'utf8');
  ok('the panel sends a name', /action: 'add', name:/.test(js));
  ok('and names who it added', /data\.account/.test(js));
  ok('with nothing left referring to the removed field', !/botModUserId/.test(js));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[moderators] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[moderators] ${passed} assertions passed.`);
console.log('');
