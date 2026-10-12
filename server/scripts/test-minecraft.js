#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MINECRAFT WHITELIST — test suite

     node server/scripts/test-minecraft.js

   Two things here can hurt somebody, and both are quiet.

   THE GATE. The page draws a form; the ROUTE decides who may write. A
   non-subscriber who posts straight at /api/minecraft must be refused, and
   the eligibility check must sit on the write rather than only in the
   markup.

   THE TWO LISTS AGREEING. The page tells a player they are whitelisted;
   the feed tells the server who may connect. If those two ever apply the
   grace period differently, somebody is told they are on the list and then
   kicked at the door, with no way to know which side is wrong. They share
   one `entryOf`, and this proves the feed actually uses it rather than
   having grown a copy.

   The feed is also the one route here that hands out personal data in
   bulk: every subscriber's Minecraft identity, next to the fact that they
   subscribe. Its token must fail CLOSED when unset.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  onRequestGet as mcGet, onRequestPost as mcPost,
  entryOf, dashUuid, flattenMotd, GRACE_DAYS, SERVER,
} from '../../functions/api/minecraft/index.js';
import { onRequestGet as feedGet } from '../../functions/api/minecraft/whitelist.js';

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

const DAY = 86400000;
const UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';          // Notch, dashed
const RAW = '069a79f444e94726a5befca90e38aaf5';

/* ── Harness ─────────────────────────────────────────────────────── */

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
      async listValues({ prefix }) {
        return [...m.entries()].filter(([k]) => k.startsWith(prefix)).map(([, value]) => ({ value }));
      },
    },
  };
}

const session = (role, id = '7', name = 'Keeper') =>
  ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, role, display_name: name })) });

async function get(env, headers) {
  const res = await mcGet({ env, request: new Request('http://localhost/api/minecraft', { headers: headers || {} }) });
  return { status: res.status, body: await res.json() };
}
async function post(env, body, headers) {
  const res = await mcPost({
    env,
    request: new Request('http://localhost/api/minecraft', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body),
    }),
  });
  return { status: res.status, body: await res.json() };
}
async function feed(env, query, headers) {
  const res = await feedGet({ env, request: new Request('http://localhost/api/minecraft/whitelist' + (query || ''), { headers: headers || {} }) });
  return { status: res.status, body: await res.json() };
}

/** Mojang, faked. Every test that writes a name goes through this. */
function mojang({ status = 200, name = 'Notch', id = RAW } = {}) {
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.mojang.com')) return new Response('{}', { status: 404 });
    if (status !== 200) return new Response('{}', { status });
    return new Response(JSON.stringify({ id, name }), { status: 200 });
  };
}

/* ── Pure helpers ────────────────────────────────────────────────── */
{
  check('a bare Mojang id is dashed', dashUuid(RAW), UUID);
  check('an already-dashed id survives', dashUuid(UUID), UUID);
  check('rubbish is refused rather than mangled', dashUuid('nope'), null);
  check('and an empty id', dashUuid(''), null);

  /* A MOTD is a string or a chat-component tree, and a server that sends
     the tree form would otherwise render as [object Object] on the page. */
  check('a plain MOTD', flattenMotd('Welcome'), 'Welcome');
  check('a component MOTD', flattenMotd({ text: 'Cursed', extra: [{ text: ' Walking' }] }), 'Cursed Walking');
  check('an array MOTD', flattenMotd([{ text: 'a' }, { text: 'b' }]), 'ab');
  check('a missing MOTD is empty, never undefined', flattenMotd(null), '');
}

/* ── The grace period, which both sides read ─────────────────────── */
{
  const now = 1000 * DAY;
  const fresh = { minecraft: { name: 'Notch', uuid: UUID, addedAt: now - DAY, lastSubAt: now - DAY } };
  const e = entryOf(fresh, now);
  check('a recent entry is active', e.active, true);
  check('and expires a grace period after the last proof of sub', e.expiresAt, (now - DAY) + GRACE_DAYS * DAY);

  const edge = { minecraft: { name: 'N', uuid: UUID, addedAt: 0, lastSubAt: now - GRACE_DAYS * DAY + 1 } };
  ok('one millisecond inside the window is still in', entryOf(edge, now).active);

  const gone = { minecraft: { name: 'N', uuid: UUID, addedAt: 0, lastSubAt: now - GRACE_DAYS * DAY - 1 } };
  const g = entryOf(gone, now);
  check('one millisecond past it is out', g.active, false);
  /* Still RETURNED though — the page has to be able to say "you lapsed"
     rather than showing an empty form as if nothing had happened. */
  check('but the entry is still reported, so the page can explain', g.name, 'N');

  check('no minecraft block means no entry', entryOf({}, now), null);
  check('a half-written entry is not an entry', entryOf({ minecraft: { name: 'N' } }, now), null);
  check('nor is a missing profile', entryOf(null, now), null);
}

/* ── Who may write ───────────────────────────────────────────────── */
{
  mojang();
  for (const role of ['visitor', 'follower']) {
    const env = store({ profile_7: { login: 'k' } });
    const r = await post(env, { action: 'join', name: 'Notch' }, session(role));
    check(`a ${role} is refused`, r.status, 403);
    check('and nothing is written', env.map.get('profile_7').minecraft, undefined);
  }
  for (const role of ['sub_tier1', 'sub_tier2', 'sub_tier3', 'moderator', 'broadcaster']) {
    const env = store({ profile_7: { login: 'k' } });
    const r = await post(env, { action: 'join', name: 'Notch' }, session(role));
    check(`a ${role} is allowed`, r.status, 200);
  }
  const anon = await post(store(), { action: 'join', name: 'Notch' }, {});
  check('and no session at all is 401', anon.status, 401);

  /* THE GATE IS ON THE WRITE. A page that only hides the form is not a
     gate, and this is the assertion that keeps it that way. */
  const src = read('functions/api/minecraft/index.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  ok('onRequestPost checks eligibility itself', /ELIGIBLE\.has\(session\.role/.test(src));
}

/* ── The name is real, and is only claimed once ──────────────────── */
{
  mojang();
  const env = store({ profile_7: { login: 'k' } });
  const r = await post(env, { action: 'join', name: 'notch' }, session('sub_tier1'));
  check('a join succeeds', r.status, 200);
  /* Mojang's capitalisation wins — it is what shows in game. */
  check('Mojang’s spelling is stored, not the typed one', env.map.get('profile_7').minecraft.name, 'Notch');
  check('with the dashed uuid whitelist.json wants', env.map.get('profile_7').minecraft.uuid, UUID);

  for (const bad of ['ab', 'a'.repeat(17), 'has space', 'bad-dash', '']) {
    const e2 = store({ profile_7: {} });
    const res = await post(e2, { action: 'join', name: bad }, session('sub_tier1'));
    check(`"${bad}" is refused before Mojang is asked`, res.status, 400);
  }

  mojang({ status: 404 });
  const missing = await post(store({ profile_7: {} }), { action: 'join', name: 'Ghostface' }, session('sub_tier1'));
  check('a name Mojang does not know is refused', missing.status, 404);
  ok('and the message says it is the Java name, not the Twitch one', /Java username/.test(missing.body.error || ''));

  mojang({ status: 429 });
  check('a rate limit is not reported as a bad name',
    (await post(store({ profile_7: {} }), { action: 'join', name: 'Notch' }, session('sub_tier1'))).status, 503);

  /* ONE ACCOUNT PER NAME. Otherwise two people share a place, and when one
     leaves the other is removed from the server with them. */
  mojang();
  const shared = store({
    profile_7: { login: 'me' },
    profile_9: { login: 'them', displayName: 'Them', userId: '9', minecraft: { name: 'Notch', uuid: UUID, addedAt: 1, lastSubAt: Date.now() } },
  });
  const dup = await post(shared, { action: 'join', name: 'Notch' }, session('sub_tier1'));
  check('a Minecraft account already claimed is refused', dup.status, 409);
  ok('and says who has it', /Them/.test(dup.body.error || ''));
  check('nothing was written for the second claimant', shared.map.get('profile_7').minecraft, undefined);

  /* Re-adding your OWN name is not a clash. */
  const mine = store({ profile_7: { login: 'me', userId: '7', minecraft: { name: 'Notch', uuid: UUID, addedAt: 55, lastSubAt: 1 } } });
  const again = await post(mine, { action: 'join', name: 'Notch' }, session('sub_tier1'));
  check('re-adding your own name is fine', again.status, 200);
  check('and the original join date is kept', mine.map.get('profile_7').minecraft.addedAt, 55);
}

/* ── Leaving ─────────────────────────────────────────────────────── */
{
  const env = store({ profile_7: { login: 'k', minecraft: { name: 'Notch', uuid: UUID, addedAt: 1, lastSubAt: Date.now() } } });
  const r = await post(env, { action: 'leave' }, session('sub_tier1'));
  check('leaving works', r.status, 200);
  check('the entry is gone', env.map.get('profile_7').minecraft, undefined);
  check('and the rest of the profile is untouched', env.map.get('profile_7').login, 'k');
  /* A double-click must not be an error. */
  check('leaving twice is still fine', (await post(env, { action: 'leave' }, session('sub_tier1'))).status, 200);
}

/* ── GET, and the stamp that keeps a place alive ─────────────────── */
{
  const old = Date.now() - 3 * DAY;
  const env = store({ profile_7: { login: 'k', minecraft: { name: 'Notch', uuid: UUID, addedAt: old, lastSubAt: old } } });
  const r = await get(env, session('sub_tier1'));
  check('a subscriber sees their entry', r.body.you.name, 'Notch');
  check('they are eligible', r.body.eligible, true);
  ok('and the stamp moved forward on the visit', env.map.get('profile_7').minecraft.lastSubAt > old);

  /* An INELIGIBLE visitor must not refresh it — that is the whole clock. */
  const lapsing = Date.now() - 3 * DAY;
  const env2 = store({ profile_7: { login: 'k', minecraft: { name: 'Notch', uuid: UUID, addedAt: 1, lastSubAt: lapsing } } });
  await get(env2, session('follower'));
  check('a lapsed sub loading the page does NOT refresh their stamp',
    env2.map.get('profile_7').minecraft.lastSubAt, lapsing);

  /* And the stamp must never CREATE an entry. */
  const env3 = store({ profile_7: { login: 'k' } });
  await get(env3, session('sub_tier3'));
  check('visiting without an entry creates nothing', env3.map.get('profile_7').minecraft, undefined);

  const out = await get(store(), {});
  check('logged out is not an error', out.status, 200);
  check('just not logged in', out.body.loggedIn, false);
  ok('and the join details are public, so the page can still explain itself', !!out.body.join.curseforge);
}

/* ── The feed ────────────────────────────────────────────────────── */
{
  const now = Date.now();
  const rows = {
    profile_1: { displayName: 'A', minecraft: { name: 'Zed', uuid: UUID, addedAt: 1, lastSubAt: now } },
    profile_2: { displayName: 'B', minecraft: { name: 'Abe', uuid: '11111111-1111-1111-1111-111111111111', addedAt: 1, lastSubAt: now - DAY } },
    profile_3: { displayName: 'C', minecraft: { name: 'Old', uuid: '22222222-2222-2222-2222-222222222222', addedAt: 1, lastSubAt: now - (GRACE_DAYS + 1) * DAY } },
    profile_4: { displayName: 'D' },
  };

  /* FAIL CLOSED. An unset secret must never mean "open". */
  const noTok = await feed(store(rows), '?token=anything');
  check('with no token configured, nobody gets the list', noTok.status, 503);

  const env = store(rows);
  env.MINECRAFT_WHITELIST_TOKEN = 's3cret';
  check('a wrong token is refused', (await feed(env, '?token=nope')).status, 403);
  check('and no token at all', (await feed(env, '')).status, 403);
  ok('a header works too', (await feed(env, '', { 'X-Whitelist-Token': 's3cret' })).status === 200);

  const r = await feed(env, '?token=s3cret');
  check('the right token is served', r.status, 200);
  check('it is a bare array, which IS whitelist.json', Array.isArray(r.body), true);
  check('lapsed players are left out', r.body.length, 2);
  check('sorted by name so a diff shows real changes', r.body.map(x => x.name), ['Abe', 'Zed']);
  check('each row is exactly uuid and name', Object.keys(r.body[0]).sort(), ['name', 'uuid']);

  const meta = await feed(env, '?token=s3cret&meta=1');
  check('the meta view counts the excluded', meta.body.lapsedExcluded, 1);
  check('and agrees on the grace period', meta.body.graceDays, GRACE_DAYS);

  /* A FAILED SCAN MUST NOT PRODUCE A SHORT LIST — it would be written over
     whitelist.json and lock out everyone it missed. */
  const broken = { MINECRAFT_WHITELIST_TOKEN: 's3cret', MARKETPLACE: { async listValues() { throw new Error('db down'); } } };
  const res = await feedGet({ env: broken, request: new Request('http://localhost/api/minecraft/whitelist?token=s3cret') });
  check('a failed roster read refuses rather than truncating', res.status, 503);

  /* ONE RULE, NOT TWO. */
  const feedSrc = read('functions/api/minecraft/whitelist.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  ok('the feed imports the page’s own entry rule', /import \{[^}]*entryOf[^}]*\} from '\.\/index\.js'/.test(feedSrc));
  ok('and does not re-derive the grace period', !/GRACE_DAYS\s*=/.test(feedSrc));
  ok('nor hardcode a day count', !/\b7\s*\*\s*24\b/.test(feedSrc));
}

/* ── The page says what the route says ───────────────────────────── */
{
  const html = read('minecraft.html');
  const js = read('js/pages/minecraft.js');

  /* The four states, each revealed rather than hidden, so nobody is told
     they are not a subscriber while the page is still finding out. */
  for (const id of ['mcGuest', 'mcNotSub', 'mcBody']) {
    ok(`${id} ships hidden`, new RegExp('id="' + id + '"[^>]*\\shidden').test(html));
  }
  ok('and the script reveals exactly one', /function show\(which\)/.test(js));

  /* CurseForge instructions: the pack is modded, so "paste the address" on
     its own would send players to a connection they cannot complete. */
  ok('the page links the CurseForge app', /curseforge\.com\/download\/app/.test(html));
  ok('and names the exact pack', /Cursed Walking/.test(html));
  ok('warning off the Lite Edition, which will not connect', /Lite Edition/.test(html));
  ok('it tells players to pick the server’s build', /Versions<\/em> tab/.test(html));
  ok('and to raise the memory, which the pack needs', /Allocated Memory/.test(html));

  /* The facts on the page come from the route, so they cannot drift. */
  ok('the address is filled from the API', /mcAddress/.test(js));
  check('the route knows the host', SERVER.host, 'mc.phantomace.tv');
  check('and the port', SERVER.port, 25566);
  ok('the CurseForge link in the markup matches the route’s',
    html.includes(SERVER.curseforge));

  /* Linked from where a subscriber would look. */
  ok('the nav links it', /href="\/minecraft"/.test(read('js/components.js')));
  ok('and the subscriber perks page', /href="\/minecraft"/.test(read('membership/subscriber.html')));

  /* Every onclick names a function one of this page's scripts defines. */
  const loaded = [...html.matchAll(/src="(\/js\/[^"]+)"/g)].map(m => read(m[1].slice(1))).join('\n');
  for (const fn of [...new Set([...html.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]))]) {
    ok(`${fn}() is defined by a script this page loads`, new RegExp('(?:async )?function ' + fn + '\\s*\\(').test(loaded));
  }
}

/* ── House style ─────────────────────────────────────────────────── */
{
  const css = read('css/pages/minecraft.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
  check('no box-shadow', (css.match(/box-shadow/g) || []).length, 0);
  check('no backdrop-filter', (css.match(/backdrop-filter/g) || []).length, 0);
  check('no side-edge borders', (css.match(/border-(left|right)\s*:/g) || []).length, 0);
  /* The reference screenshot was purple and orange; this is not that site. */
  const hexes = [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}/g)].map(m => m[0].toLowerCase()))];
  check('every colour comes from a token', hexes, []);
  const small = [...css.matchAll(/font-size:\s*(\d+)px/g)].map(m => Number(m[1])).filter(n => n < 11);
  check('nothing is unreadably small', small, []);
}

/* ── Report ──────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[minecraft] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[minecraft] ${passed} assertions passed.`);
