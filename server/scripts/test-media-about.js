#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MEDIA + ABOUT — test suite

     node server/scripts/test-media-about.js

   Both features are edit surfaces exposed to people other than the
   developer, so the things worth asserting are the refusals: who cannot
   upload, what cannot be fetched off the disk, which media a visitor is not
   shown, and what a stored string is allowed to contain.

   Uses a real temporary directory for the media store — path handling is
   most of what is under test here, and a mocked filesystem would be testing
   the mock.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMediaStore } from '../lib/media-store.js';
import * as mediaList from '../../functions/api/media/index.js';
import * as mediaUpload from '../../functions/api/media/upload.js';
import * as mediaServe from '../../functions/cdn/media/[[path]].js';
import * as about from '../../functions/api/about.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pham-media-'));

function makeEnv({ moderators = [] } = {}) {
  const store = new Map();
  /* getModerators() derives userIds from `entries`, so the fixture has to be
     shaped the way the real record is — setting userIds directly looks right
     and grants nobody anything. */
  store.set('site_moderators', JSON.stringify({
    entries: moderators.map(id => ({ userId: String(id), name: 'Mod ' + id, addedBy: 'test' })),
  }));
  return {
    TWITCH_BROADCASTER_ID: '900',
    MEDIA_STORE: createMediaStore(path.join(TMP, 'run' + Math.random().toString(36).slice(2, 7))),
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next === undefined) return cur;
        store.set(k, JSON.stringify(next));
        return JSON.parse(store.get(k));
      },
      async listValues() { return []; },
    },
    _store: store,
  };
}

const USERS = {
  broadcaster: { user_id: '900', display_name: 'PhantomACE', role: 'broadcaster' },
  mod: { user_id: '101', display_name: 'Mod', role: 'visitor' },   // a site mod; cookie says visitor
  sub: { user_id: '202', display_name: 'Sub', role: 'sub_tier2' },
  viewer: { user_id: '303', display_name: 'Viewer', role: 'follower' },
};

const cookie = (who) => `pham_session=${encodeURIComponent(JSON.stringify(USERS[who]))}`;

function pngBytes() {
  /* Smallest thing that is unambiguously a PNG by signature. The upload path
     trusts the declared content type, so the bytes only need to be real
     enough to write and read back. */
  return Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
}

async function upload(env, who, fields = {}) {
  const fd = new FormData();
  fd.set('title', fields.title ?? 'A Title');
  fd.set('category', fields.category ?? 'art');
  if (fields.role !== undefined) fd.set('role', fields.role);
  const bytes = fields.bytes ?? pngBytes();
  fd.set('file', new File([bytes], fields.name ?? 'x.png', { type: fields.type ?? 'image/png' }));

  const headers = who ? { Cookie: cookie(who) } : {};
  const res = await mediaUpload.onRequestPost({
    env, request: new Request('https://t.local/api/media/upload', { method: 'POST', headers, body: fd }),
  });
  return { status: res.status, data: await res.json() };
}

async function list(env, who) {
  const headers = who ? { Cookie: cookie(who) } : {};
  const res = await mediaList.onRequestGet({
    env, request: new Request('https://t.local/api/media', { headers }),
  });
  return { status: res.status, data: await res.json() };
}

/* ── Who may upload ──────────────────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });

  check('logged out cannot upload', (await upload(env, null)).status, 401);
  check('an ordinary viewer cannot upload', (await upload(env, 'viewer')).status, 403);
  /* The old check allowed every subscriber, which is not what "moderators
     and broadcaster" means. */
  check('a subscriber cannot upload', (await upload(env, 'sub')).status, 403);
  check('a site moderator can', (await upload(env, 'mod')).status, 200);
  check('the broadcaster can', (await upload(env, 'broadcaster')).status, 200);
}

/* ── What may be uploaded ────────────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  check('a title is required', (await upload(env, 'mod', { title: '' })).status, 400);
  check('an unknown category is refused', (await upload(env, 'mod', { category: 'memes' })).status, 400);
  check('an unknown visibility is refused', (await upload(env, 'mod', { role: 'vip' })).status, 400);
  check('a script is not an image', (await upload(env, 'mod', { type: 'text/html' })).status, 400);
  check('an oversized file is refused',
    (await upload(env, 'mod', { bytes: Buffer.alloc(11 * 1024 * 1024) })).status, 400);

  /* The stored name must come from the content type, never the filename —
     the uploader would otherwise choose the extension the serving handler
     later uses to decide what the file is. */
  const r = await upload(env, 'mod', { name: 'evil.html', type: 'image/png' });
  check('the upload succeeds', [r.status, r.data.error || null], [200, null]);
  ok('and is stored as .png regardless of the filename', r.data.item.file.endsWith('.png'));
  ok('the url points into /cdn/media/', r.data.item.url.startsWith('/cdn/media/'));
}

/* ── Visibility is enforced by the server ────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await upload(env, 'broadcaster', { title: 'Public', role: '' });
  await upload(env, 'broadcaster', { title: 'Subs only', role: 'sub_tier1' });
  await upload(env, 'broadcaster', { title: 'Mods only', role: 'moderator' });

  const anon = await list(env, null);
  check('a visitor sees only public media', anon.data.items.map(i => i.title), ['Public']);
  check('and is offered no controls', anon.data.canManage, false);

  const follower = await list(env, 'viewer');
  check('a follower sees only public media', follower.data.items.map(i => i.title), ['Public']);

  const sub = await list(env, 'sub');
  check('a tier-2 sub sees tier-1 media too',
    sub.data.items.map(i => i.title).sort(), ['Public', 'Subs only']);

  /* The cookie calls this account a visitor; the moderator LIST says
     otherwise, and the list wins — a moderator could not otherwise see
     moderator-only media on a page they administer. */
  const mod = await list(env, 'mod');
  check('a site moderator sees everything',
    mod.data.items.map(i => i.title).sort(), ['Mods only', 'Public', 'Subs only']);
  check('and is offered the controls', mod.data.canManage, true);
  check('their effective role is moderator', mod.data.viewerRole, 'moderator');
}

/* ── Serving: the path is the untrusted input ────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  const up = await upload(env, 'mod');
  const name = up.data.item.file;

  const serve = async (segments) => {
    const res = await mediaServe.onRequestGet({ env, params: { path: segments } });
    return { status: res.status, type: res.headers.get('Content-Type') };
  };

  const good = await serve([name]);
  check('a real file is served', good.status, 200);
  check('with the type from its extension', good.type, 'image/png');

  check('traversal is refused', (await serve(['..', '..', 'server', '.env'])).status, 404);
  check('an encoded traversal is refused', (await serve(['../../server/.env'])).status, 404);
  check('a subdirectory is refused', (await serve(['sub', name])).status, 404);
  check('an absolute path is refused', (await serve(['/etc/passwd'])).status, 404);
  check('a name we did not generate is refused', (await serve(['hello.png'])).status, 404);
  check('an unknown file is 404', (await serve(['1700000000000_abcdef0123.png'])).status, 404);
  check('no path at all is 404', (await serve([])).status, 404);
}

/* ── Removal ─────────────────────────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  const up = await upload(env, 'mod');
  const id = up.data.item.id;
  const file = up.data.item.file;

  const del = async (who, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Cookie = cookie(who);
    const res = await mediaUpload.onRequestDelete({
      env,
      request: new Request('https://t.local/api/media/upload', {
        method: 'DELETE', headers, body: JSON.stringify(body),
      }),
    });
    return { status: res.status, data: await res.json() };
  };

  check('a viewer cannot remove', (await del('viewer', { id })).status, 403);
  ok('the file is still there', !!(await env.MEDIA_STORE.head(file)));

  check('a moderator can remove', (await del('mod', { id })).status, 200);
  check('it leaves the gallery', (await list(env, 'mod')).data.items.length, 0);
  check('and the file is gone from disk', await env.MEDIA_STORE.head(file), null);
  check('removing it twice is a 404', (await del('mod', { id })).status, 404);
}

/* ══ ABOUT ═══════════════════════════════════════════════════════════════ */

async function getAbout(env, who) {
  const headers = who ? { Cookie: cookie(who) } : {};
  const res = await about.onRequestGet({ env, request: new Request('https://t.local/api/about', { headers }) });
  return { status: res.status, data: await res.json() };
}

async function saveAbout(env, who, content) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Cookie = cookie(who);
  const res = await about.onRequestPost({
    env,
    request: new Request('https://t.local/api/about', {
      method: 'POST', headers, body: JSON.stringify({ content }),
    }),
  });
  return { status: res.status, data: await res.json() };
}

{
  const env = makeEnv({ moderators: ['101'] });

  /* Nothing stored: the page must be left exactly as its HTML has it. */
  const fresh = await getAbout(env, null);
  check('an unedited page returns no content at all', fresh.data.content, {});
  check('and offers no editing', fresh.data.canEdit, false);

  check('a viewer cannot edit', (await saveAbout(env, 'viewer', { bioTitle: 'x' })).status, 403);
  /* Moderators can add media; the broadcaster's own words are not delegated. */
  check('a moderator cannot edit the About page',
    (await saveAbout(env, 'mod', { bioTitle: 'x' })).status, 403);
  check('logged out cannot edit', (await saveAbout(env, null, { bioTitle: 'x' })).status, 403);

  const saved = await saveAbout(env, 'broadcaster', {
    bioTitle: 'PhantomACE',
    bioBody: 'First paragraph.\n\nSecond paragraph.',
    statStreams: '600+',
  });
  check('the broadcaster can edit', saved.status, 200);
  check('the text round-trips', saved.data.content.bioBody, 'First paragraph.\n\nSecond paragraph.');
  check('a stat comes back too', saved.data.content.statStreams, '600+');

  const after = await getAbout(env, 'broadcaster');
  check('and is returned on the next read', after.data.content.bioTitle, 'PhantomACE');
  check('with the editor offered', after.data.canEdit, true);
  ok('and an edited-at stamp', !!after.data.updatedAt);

  /* A field left out of a patch must not be wiped by editing a different one. */
  await saveAbout(env, 'broadcaster', { statGoals: '60+' });
  const merged = await getAbout(env, 'broadcaster');
  check('editing one field leaves the others alone', merged.data.content.bioTitle, 'PhantomACE');
  check('and adds the new one', merged.data.content.statGoals, '60+');

  /* Clearing a field is a RESET — the key goes away and the HTML default
     takes over, rather than the page rendering a blank heading. */
  await saveAbout(env, 'broadcaster', { bioTitle: '   ' });
  const cleared = await getAbout(env, 'broadcaster');
  ok('clearing a field removes it rather than storing empty', !('bioTitle' in cleared.data.content));
}

{
  const env = makeEnv();

  /* Stored copy is plain text and rendered with textContent. It is kept
     verbatim — escaping here as well would double-escape on the page — so
     what matters is that a field cannot be enormous, cannot smuggle control
     characters, and cannot be a key nobody declared. */
  const r = await saveAbout(env, 'broadcaster', { bioTitle: 'x'.repeat(500) });
  check('a long field is truncated to its limit', r.data.content.bioTitle.length, 60);

  const ctrl = await saveAbout(env, 'broadcaster', { subtitle: 'a bc' });
  check('control characters are stripped', ctrl.data.content.subtitle, 'abc');

  const oneLine = await saveAbout(env, 'broadcaster', { subtitle: 'one\ntwo' });
  check('a single-line field cannot become multiline', oneLine.data.content.subtitle, 'one two');

  const unknown = await saveAbout(env, 'broadcaster', { evil: 'x' });
  check('an undeclared field is refused outright', unknown.status, 400);

  const tags = await saveAbout(env, 'broadcaster', { bioTitle: '<script>alert(1)</script>' });
  check('markup is stored verbatim, for textContent to neutralise',
    tags.data.content.bioTitle, '<script>alert(1)</script>');
}

/* ── Report ──────────────────────────────────────────────────────────── */
fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
if (failures.length) {
  console.log(`[media/about] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[media/about] ${passed} assertions passed.`);
console.log('');
