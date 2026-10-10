#!/usr/bin/env node
/* ══════════════════════════════════════════════
   TWITCH CLIPS ON THE MEDIA WALL

     node server/scripts/test-media-clips.js

   Adding a clip meant downloading it off Twitch and uploading the file.
   A clip is a reference now — slug, title, thumbnail — so nothing is
   stored here and the views stay on the real clip.

   What is pinned, and why each one:

     - THE SLUG IS PARSED, NOT GUESSED. It ends up in an iframe src, and
       people paste every shape of Twitch link there is.
     - THE SLUG IS VERIFIED WITH TWITCH, and a clip belonging to another
       channel is refused. Without that, any clip on Twitch could be put
       on this wall by pasting its link.
     - STAFF ONLY, against the live moderator list.
     - the embed takes its `parent` from the host serving the page.
       Twitch refuses to frame otherwise, so a hardcoded domain works on
       phantomace.tv and nowhere else — including every preview.
     - the same clip twice replaces rather than doubles.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { clipSlug, onRequestGet, onRequestPost } from '../../functions/api/media/clip.js';
import { CATEGORIES } from '../../functions/api/media/upload.js';

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

/* ── Every shape of link somebody might paste ────────────────────────── */
{
  const S = 'HungryCovertBeaverDoritosChip';
  check('clips.twitch.tv', clipSlug(`https://clips.twitch.tv/${S}`), S);
  check('the channel page form', clipSlug(`https://www.twitch.tv/phantomace/clip/${S}`), S);
  check('with a query string', clipSlug(`https://www.twitch.tv/phantomace/clip/${S}?filter=clips&range=7d`), S);
  check('mobile', clipSlug(`https://m.twitch.tv/clip/${S}`), S);
  check('no scheme is not a URL, but a bare slug is', clipSlug(S), S);
  check('and surrounding whitespace is forgiven', clipSlug(`  ${S}  `), S);

  check('an empty paste is refused', clipSlug(''), null);
  check('and nothing at all', clipSlug(null), null);
  check('a non-Twitch host is refused', clipSlug('https://evil.example/clip/Abcd'), null);
  /* The check is on the HOST, not on the string containing "twitch.tv" —
     otherwise evil.example/?x=twitch.tv/clip/X would pass. */
  check('a lookalike host is refused', clipSlug('https://twitch.tv.evil.example/clip/Abcd'), null);
  check('a Twitch link that is not a clip is refused', clipSlug('https://www.twitch.tv/phantomace'), null);
  check('a VOD link is refused', clipSlug('https://www.twitch.tv/videos/12345'), null);
  /* Path traversal and quoting, since this lands in an attribute. */
  check('a slug with a slash is refused', clipSlug('foo/bar'), null);
  check('a slug with a quote is refused', clipSlug('Abcd"onerror=1'), null);
  check('a slug with an angle bracket is refused', clipSlug('<script>'), null);
  check('a too-short slug is refused', clipSlug('ab'), null);
}

/* ── The route ───────────────────────────────────────────────────────── */
const BROADCASTER = '555';
const SLUG = 'HungryCovertBeaverDoritosChip';

function makeEnv({ moderators = [], clip = undefined, helixStatus = 200 } = {}) {
  const store = new Map();
  store.set('site_moderators', JSON.stringify({ entries: moderators.map(id => ({ userId: String(id) })) }));
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 500000 }), { status: 200 });
    }
    if (u.includes('helix/clips')) {
      if (helixStatus !== 200) return new Response('{}', { status: helixStatus });
      return new Response(JSON.stringify({ data: clip === undefined ? [] : [clip] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return {
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'sec',
    TWITCH_BROADCASTER_ID: BROADCASTER,
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next === undefined) return cur;
        store.set(k, JSON.stringify(next));
        return next;
      },
      async listValues() { return []; },
    },
    store, calls,
  };
}

const REAL_CLIP = {
  id: SLUG, broadcaster_id: BROADCASTER, broadcaster_name: 'PhantomACE',
  title: 'Clutch at 1 HP', creator_name: 'GraveWalker', duration: 28.5,
  view_count: 412, created_at: '2026-10-09T20:11:00Z',
  url: `https://clips.twitch.tv/${SLUG}`,
  thumbnail_url: 'https://clips-media.twitch.tv/x-preview-%{width}x%{height}.jpg',
};

const as = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: String(id), display_name: 'Mod' + id })) });

const post = async (env, body, headers) => {
  const res = await onRequestPost({
    env,
    request: new Request('https://phantomace.tv/api/media/clip', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
    }),
  });
  return { status: res.status, data: await res.json() };
};

const index = (env) => {
  const raw = env.store.get('media_index');
  return raw ? JSON.parse(raw) : [];
};

/* ── Staff only ──────────────────────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['9'], clip: REAL_CLIP });
  check('logged out cannot add a clip', (await post(env, { url: SLUG })).status, 403);
  check('nor an ordinary viewer', (await post(env, { url: SLUG }, as('1'))).status, 403);
  check('nothing was written', index(env), []);
  check('a moderator can', (await post(env, { url: SLUG }, as('9'))).status, 200);
  check('and the broadcaster can', (await post(env, { url: SLUG }, as(BROADCASTER))).status, 200);

  const get = await onRequestGet({
    env, request: new Request('https://phantomace.tv/api/media/clip?recent=1'),
  });
  check('the recent list is staff-only too', get.status, 403);
}

/* ── A real clip lands as a reference, not a file ────────────────────── */
{
  const env = makeEnv({ moderators: ['9'], clip: REAL_CLIP });
  const r = await post(env, { url: `https://www.twitch.tv/phantomace/clip/${SLUG}` }, as('9'));
  check('it is accepted', r.status, 200);

  const item = index(env)[0];
  check('one item on the wall', index(env).length, 1);
  check('typed as a twitch clip', item.type, 'twitch-clip');
  check('carrying the slug the embed needs', item.slug, SLUG);
  /* The whole point: nothing of it is stored here. */
  ok('with no file', !item.file);
  ok('and no /cdn url', !String(item.url).startsWith('/cdn/'));
  check('the title comes from Twitch', item.title, 'Clutch at 1 HP');
  check('and the clipper is credited', item.clipCreator, 'GraveWalker');
  /* Twitch's thumbnail is a template; a raw %{width} would 404. */
  ok('the thumbnail has its placeholders filled',
    item.thumbnail.includes('480') && !item.thumbnail.includes('%{'));

  /* A typed title wins over Twitch's. */
  const env2 = makeEnv({ moderators: ['9'], clip: REAL_CLIP });
  await post(env2, { url: SLUG, title: 'The one with the crit' }, as('9'));
  check('a typed title is used instead', index(env2)[0].title, 'The one with the crit');
}

/* ── Verified with Twitch, not trusted from the paste ────────────────── */
{
  /* A clip that does not exist. */
  const missing = makeEnv({ moderators: ['9'], clip: undefined });
  const r1 = await post(missing, { url: SLUG }, as('9'));
  check('a slug Twitch does not know is refused', r1.status, 404);
  check('and nothing is written', index(missing), []);

  /* THE IMPORTANT ONE: somebody else's clip. Without this check, any clip
     on Twitch could be put on this wall by pasting its link. */
  const foreign = makeEnv({
    moderators: ['9'],
    clip: { ...REAL_CLIP, broadcaster_id: '999', broadcaster_name: 'SomeoneElse' },
  });
  const r2 = await post(foreign, { url: SLUG }, as('9'));
  check('another channel’s clip is refused', r2.status, 400);
  ok('and the message says whose it is', /SomeoneElse/.test(r2.data.error || ''));
  check('nothing is written', index(foreign), []);

  /* Twitch being down is not the same as the clip being wrong. */
  const down = makeEnv({ moderators: ['9'], helixStatus: 503 });
  const r3 = await post(down, { url: SLUG }, as('9'));
  check('a Twitch outage is reported as one', r3.status, 502);

  const bad = makeEnv({ moderators: ['9'], clip: REAL_CLIP });
  const r4 = await post(bad, { url: 'https://evil.example/clip/x' }, as('9'));
  check('a non-Twitch link never reaches Twitch', r4.status, 400);
  check('and no Helix call was made', bad.calls.filter(u => u.includes('helix')).length, 0);
}

/* ── The same clip twice replaces rather than doubles ────────────────── */
{
  const env = makeEnv({ moderators: ['9'], clip: REAL_CLIP });
  await post(env, { url: SLUG }, as('9'));
  const again = await post(env, { url: `https://clips.twitch.tv/${SLUG}`, title: 'Renamed' }, as('9'));
  check('the second add succeeds', again.status, 200);
  check('and says it replaced one', again.data.replaced, true);
  check('there is still only one', index(env).length, 1);
  check('with the newer title', index(env)[0].title, 'Renamed');
}

/* ── Category and visibility are validated, not echoed ───────────────── */
{
  const env = makeEnv({ moderators: ['9'], clip: REAL_CLIP });
  await post(env, { url: SLUG, category: 'nonsense', role: 'emperor' }, as('9'));
  const item = index(env)[0];
  ok('an unknown category falls back to one the page can filter',
    CATEGORIES.includes(item.category));
  check('and an unknown role to everyone', item.role, null);

  /* The list is imported from upload.js rather than copied — two media
     lists drifting apart is how a category becomes unfilterable. */
  const src = read('functions/api/media/clip.js');
  ok('the category list is imported, not restated',
    /import \{ CATEGORIES, ROLES \} from '\.\/upload\.js'/.test(src));
  check('and no second copy is declared here',
    (src.match(/const CATEGORIES = \[/g) || []), []);
}

/* ── The client renders a reference, and embeds on open ──────────────── */
{
  const js = read('js/pages/media.js');

  ok('the grid draws the thumbnail, not a player',
    /item\.type === 'twitch-clip'[\s\S]{0,200}item\.thumbnail/.test(js));
  /* An embed per tile would load a Twitch player for every clip on the
     wall; the point of the thumbnail is that it does not. */
  ok('the embed is only in the lightbox', /lightbox-clip/.test(js));

  /* Twitch refuses to frame unless `parent` names the host serving the
     page, so hardcoding the domain works in production and nowhere else. */
  ok('the embed parent comes from the host', /parent=\$\{\s*encodeURIComponent\(location\.hostname\)/.test(js));
  ok('and the slug is encoded into the src', /clip=\$\{\s*\n?\s*encodeURIComponent\(item\.slug\)/.test(js));

  /* CLAUDE.md's sandbox rule is about OUR games. Twitch's player is another
     origin and needs scripts and same-origin for itself; a sandbox
     attribute breaks it. What it must NOT have is popups or top-navigation. */
  const iframe = /<iframe class="lightbox-clip"[\s\S]*?><\/iframe>/.exec(js);
  ok('the embed iframe is found', !!iframe);
  const tag = iframe ? iframe[0] : '';
  check('it does not allow popups', (tag.match(/allow-popups/g) || []), []);
  check('nor top navigation', (tag.match(/allow-top-navigation/g) || []), []);
  ok('it sets a referrer policy', /referrerpolicy=/.test(tag));

  /* EVERY FUNCTION THE CLIP PATH CALLS MUST EXIST. The first version called
     loadMedia(), which this file does not have — so a clip was added
     successfully and the page then reported "loadMedia is not defined",
     telling the moderator the add had failed when it had not. A missing
     global is invisible until the line runs, which is why it is checked. */
  const defined = new Set(
    [...js.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map(m => m[1]));
  ok('the file\u2019s own functions parse out', defined.size > 10);

  const bodyOf = (name) => {
    const re = new RegExp('(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}');
    const m = re.exec(js);
    return m ? m[0] : '';
  };
  /* Comments stripped first: the prose in this codebase is long and full of
     ordinary sentences, and a bare scan finds words like "doubling(" in it. */
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const clipBodies = stripComments(
    bodyOf('handleAddClip') + '\n' + bodyOf('loadRecentClips') + '\n' + bodyOf('setUploadMode'));
  ok('the clip handlers were found', clipBodies.length > 200);

  /* Calls in those bodies, minus built-ins and method calls, which are not
     this file's to define. */
  const BUILTIN = new Set(['fetch', 'JSON', 'String', 'Number', 'Boolean', 'Array', 'Object',
    'setTimeout', 'clearTimeout', 'encodeURIComponent', 'parseInt', 'parseFloat', 'Set', 'Map',
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new']);
  const called = [...new Set([...clipBodies.matchAll(/(^|[^.\w$])([a-z][A-Za-z0-9_$]*)\s*\(/g)]
    .map(m => m[2]))];
  const missing = called.filter(n => !defined.has(n) && !BUILTIN.has(n));
  check('every function the clip path calls is defined in this file', missing, []);

  /* And the add must not report a failure for a clip that landed: the
     success is shown before the page catches up, and the refresh is outside
     the try. */
  ok('the success is reported before the page catches up',
    /'Added\.'[\s\S]{0,160}added = data\.item/.test(js));
  ok('and a re-add replaces the tile rather than doubling it',
    /GALLERY_DATA\.findIndex\(i => i && i\.id === added\.id\)/.test(js));

  const html = read('media.html');
  ok('the modal offers both ways in', /id="modeClipBtn"/.test(html) && /id="modeFileBtn"/.test(html));
  ok('with a link field', /id="clipUrl"/.test(html));
  ok('and a recent-clip picker', /id="clipRecent"/.test(html));
  ok('the picker loads on demand, not when the modal opens',
    /onclick="loadRecentClips\(\)"/.test(html));
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[media-clips] ${passed} assertions passed.`);
