#!/usr/bin/env node
/* ══════════════════════════════════════════════
   ALERT SOUNDS — test suite

     node server/scripts/test-alert-sounds.js

   Covers the three edit surfaces of the uploadable alert-sound feature:
   the media store + upload now accept audio (and reject non-audio / oversize),
   the /api/alert-sounds config is staff-gated and validates type + url + volume,
   and the overlay's selection logic prefers the per-type url and falls back to
   the default sting when none is set.

   A real temporary directory backs the media store, as in test-media-about.js —
   the content-type-driven extension and the /cdn/media url shape are most of
   what the alert-sounds url validation depends on.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMediaStore, ALLOWED_TYPES, AUDIO_TYPES } from '../lib/media-store.js';
import * as mediaUpload from '../../functions/api/media/upload.js';
import * as mediaServe from '../../functions/cdn/media/[[path]].js';
import * as alertSounds from '../../functions/api/alert-sounds.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pham-alert-'));

function makeEnv({ moderators = [] } = {}) {
  const store = new Map();
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
  mod: { user_id: '101', display_name: 'Mod', role: 'visitor' },
  viewer: { user_id: '303', display_name: 'Viewer', role: 'follower' },
};
const cookie = (who) => `pham_session=${encodeURIComponent(JSON.stringify(USERS[who]))}`;

async function upload(env, who, fields = {}) {
  const fd = new FormData();
  fd.set('title', fields.title ?? 'Alert sound: sub');
  fd.set('category', fields.category ?? 'audio');
  const bytes = fields.bytes ?? Buffer.from('fakeaudio');
  fd.set('file', new File([bytes], fields.name ?? 'sting.mp3', { type: fields.type ?? 'audio/mpeg' }));
  const headers = who ? { Cookie: cookie(who) } : {};
  const res = await mediaUpload.onRequestPost({
    env, request: new Request('https://t.local/api/media/upload', { method: 'POST', headers, body: fd }),
  });
  return { status: res.status, data: await res.json() };
}

async function setSound(env, who, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Cookie = cookie(who);
  const res = await alertSounds.onRequestPost({
    env, request: new Request('https://t.local/api/alert-sounds', { method: 'POST', headers, body: JSON.stringify(body) }),
  });
  return { status: res.status, data: await res.json() };
}

async function getSounds(env) {
  const res = await alertSounds.onRequestGet({ env, request: new Request('https://t.local/api/alert-sounds') });
  return { status: res.status, data: await res.json() };
}

/* ── The media store accepts audio ─────────────────────────────────────── */
{
  const store = createMediaStore(path.join(TMP, 'direct'));
  ok('ALLOWED_TYPES includes audio/mpeg', ALLOWED_TYPES.includes('audio/mpeg'));
  ok('AUDIO_TYPES has the four audio types', AUDIO_TYPES.length === 4 && AUDIO_TYPES.every(t => t.startsWith('audio/')));
  check('extFor maps mpeg to mp3', store.extFor('audio/mpeg'), 'mp3');
  check('audio/mp4 is stored as m4a, not mp4', store.extFor('audio/mp4'), 'm4a');

  const name = await store.put(Buffer.from('x'), 'audio/mpeg');
  ok('put writes an .mp3 name', /^[0-9]{13}_[a-z0-9]{10}\.mp3$/.test(name));
  check('typeFor reads it back as audio/mpeg', store.typeFor(name), 'audio/mpeg');
}

/* ── Upload accepts audio, rejects non-audio and oversize ──────────────── */
{
  const env = makeEnv({ moderators: ['101'] });

  const good = await upload(env, 'mod', { type: 'audio/mpeg' });
  check('a moderator can upload an audio sting', [good.status, good.data.error || null], [200, null]);
  ok('it is stored as .mp3', good.data.item.file.endsWith('.mp3'));
  ok('the url points into /cdn/media/', good.data.item.url.startsWith('/cdn/media/'));
  check('and is typed as audio', good.data.item.type, 'audio');

  /* Audio is a utility upload, not gallery content — it must not land in the
     public media index. */
  check('an audio upload does not touch the gallery index', env._store.has('media_index'), false);

  check('an ogg sting is accepted', (await upload(env, 'mod', { type: 'audio/ogg', name: 'x.ogg' })).status, 200);
  check('a non-audio, non-media type is refused', (await upload(env, 'mod', { type: 'text/html' })).status, 400);

  const big = await upload(env, 'mod', { type: 'audio/mpeg', bytes: Buffer.alloc(2 * 1024 * 1024 + 1) });
  check('an audio file over the 2MB cap is refused', big.status, 400);

  check('a viewer cannot upload', (await upload(env, 'viewer', { type: 'audio/mpeg' })).status, 403);
  check('logged out cannot upload', (await upload(env, null, { type: 'audio/mpeg' })).status, 401);

  /* An image still uploads under its 10MB cap and still reaches the gallery. */
  const img = await upload(env, 'mod', { type: 'image/png', name: 'x.png', category: 'art', title: 'Pic' });
  check('an image upload still works', img.status, 200);
  check('and still lands in the gallery index', env._store.has('media_index'), true);
}

/* ── Serving an audio file sets the right content type ──────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  const up = await upload(env, 'mod', { type: 'audio/mpeg' });
  const name = up.data.item.file;
  const res = await mediaServe.onRequestGet({ env, params: { path: [name] } });
  check('the audio file serves 200', res.status, 200);
  check('with an audio content type', res.headers.get('Content-Type'), 'audio/mpeg');
}

/* ── Setting the config is staff-only ──────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  const up = await upload(env, 'broadcaster', { type: 'audio/mpeg' });
  const url = up.data.item.url;

  check('a viewer cannot set an alert sound', (await setSound(env, 'viewer', { type: 'sub', url })).status, 403);
  check('logged out cannot set an alert sound', (await setSound(env, null, { type: 'sub', url })).status, 403);
  check('a site moderator can', (await setSound(env, 'mod', { type: 'sub', url })).status, 200);
  check('the broadcaster can', (await setSound(env, 'broadcaster', { type: 'raid', url })).status, 200);
}

/* ── Validation: type, url, volume ─────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  const up = await upload(env, 'broadcaster', { type: 'audio/mpeg' });
  const url = up.data.item.url;

  check('an unknown alert type is refused', (await setSound(env, 'broadcaster', { type: 'donation', url })).status, 400);
  check('an arbitrary external url is refused',
    (await setSound(env, 'broadcaster', { type: 'sub', url: 'https://evil.example/x.mp3' })).status, 400);
  check('a /cdn/media image url is refused (audio only)',
    (await setSound(env, 'broadcaster', { type: 'sub', url: '/cdn/media/1700000000000_abcdef0123.png' })).status, 400);
  check('a missing url is refused', (await setSound(env, 'broadcaster', { type: 'sub' })).status, 400);

  const hi = await setSound(env, 'broadcaster', { type: 'sub', url, volume: 1.5 });
  check('a volume above 1 is clamped', hi.data.sounds.sub.volume, 1);
  const lo = await setSound(env, 'broadcaster', { type: 'sub', url, volume: -1 });
  check('a volume below 0 is clamped', lo.data.sounds.sub.volume, 0);
  const mid = await setSound(env, 'broadcaster', { type: 'sub', url, volume: 0.4 });
  check('a volume in range is kept', mid.data.sounds.sub.volume, 0.4);
}

/* ── GET returns the config; clear reverts a type ──────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  const up = await upload(env, 'broadcaster', { type: 'audio/mpeg' });
  const url = up.data.item.url;
  await setSound(env, 'broadcaster', { type: 'cheer', url, volume: 0.8 });

  const got = await getSounds(env);
  check('GET is public and returns the stored sound', got.data.sounds.cheer.url, url);
  check('and lists the known alert types', got.data.types.includes('cheer'), true);

  const cleared = await setSound(env, 'broadcaster', { type: 'cheer', clear: true });
  check('clear removes the type', 'cheer' in (cleared.data.sounds || {}), false);
}

/* ── Overlay selection logic (mirrors playAlertSound in overlay.js) ─────── */
{
  const DEFAULT = '/assets/audio/alert.mp3';
  function pick(cfgMap, type) {
    const cfg = cfgMap[type];
    const src = (cfg && typeof cfg.url === 'string' && cfg.url) ? cfg.url : DEFAULT;
    const perVol = (cfg && typeof cfg.volume === 'number') ? Math.max(0, Math.min(1, cfg.volume)) : 1;
    return { src, perVol };
  }
  const cfg = { sub: { url: '/cdn/media/1700000000000_abcdef0123.mp3', volume: 0.5 } };
  check('a configured type uses its uploaded url', pick(cfg, 'sub').src, cfg.sub.url);
  check('and its configured volume', pick(cfg, 'sub').perVol, 0.5);
  check('an unset type falls back to the default sting', pick(cfg, 'raid').src, DEFAULT);
  check('and full relative volume when unset', pick(cfg, 'raid').perVol, 1);
}

/* ── Report ──────────────────────────────────────────────────────────── */
fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
if (failures.length) {
  console.log(`[alert-sounds] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[alert-sounds] ${passed} assertions passed.`);
console.log('');
