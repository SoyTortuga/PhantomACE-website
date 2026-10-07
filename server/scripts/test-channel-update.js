#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CHANNEL UPDATE — category / title change webhook

     node server/scripts/test-channel-update.js

   RUNS OFFLINE against a fake KV. Nothing here reaches Twitch.

   WHAT THIS IS GUARDING. channel.update is one event carrying four different
   kinds of change, and the whole value of the handler is telling them apart:

     - A category change is the signal anything downstream will arm off.
     - A TITLE edit arrives as the same event. If it were treated as a change
       of category, every typo fix mid-stream would re-fire whatever is wired
       to this, which is the failure that makes a feature get switched off.
     - A category RENAME by Twitch is not him switching games, so the diff is
       on the id, never the name.
     - A redelivery of an identical event must write nothing at all.

   It also pins the three places a new webhook has to be registered, each of
   which fails silently when missed: the registry key (the route 500s), the
   subscription in bot-setup (it is never created), and the rate-limit
   exemption in the adapter (Twitch gets throttled and revokes it).
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cu from '../../functions/api/channel-update.js';
import { signEventSub } from '../lib/eventsub.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'test-eventsub-secret';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  return {
    TWITCH_EVENTSUB_SECRET: SECRET,
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
          const next = await fn(cur);
          if (next === undefined) return cur;
          store.set(k, JSON.stringify(next));
          return JSON.parse(store.get(k));
        });
        chains.set(k, run.then(() => {}, () => {}));
        return run;
      },
      async listValues() { return []; },
    },
    _store: store,
  };
}

async function post(env, event, { type = 'channel.update', messageType = 'notification', secret = SECRET, messageId } = {}) {
  const raw = JSON.stringify({ subscription: { type }, event });
  const mid = messageId || 'mid-' + Math.random().toString(36).slice(2);
  const ts = new Date().toISOString();
  const request = new Request('https://phantomace.tv/api/channel-update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': messageType,
      'twitch-eventsub-message-id': mid,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': await signEventSub(secret, mid, ts, raw),
    },
    body: raw,
  });
  const res = await cu.onRequestPost({ env, request });
  return { status: res.status, text: await res.text() };
}

const stored = (env) => {
  const r = env._store.get('stream_category');
  return r ? JSON.parse(r) : null;
};

const MTG = { category_id: '2748', category_name: 'Magic: The Gathering', title: 'Cracking a box' };

/* ── The signature is the gate ───────────────────────────────────────────── */
{
  const env = makeEnv();
  const bad = await post(env, MTG, { secret: 'wrong-secret' });
  ok('a bad signature is refused', bad.status >= 400);
  check('and nothing is recorded', stored(env), null);

  /* Fails CLOSED: no configured secret must not mean "skip verification". */
  const noSecret = { ...makeEnv(), TWITCH_EVENTSUB_SECRET: undefined };
  noSecret.MARKETPLACE = makeEnv().MARKETPLACE;
  const res = await cu.onRequestPost({
    env: noSecret,
    request: new Request('https://phantomace.tv/api/channel-update', { method: 'POST', body: '{}' }),
  });
  ok('a missing secret fails closed rather than skipping the check', res.status >= 400);
}

/* ── Twitch's subscription handshake ─────────────────────────────────────── */
{
  const env = makeEnv();
  const raw = JSON.stringify({ challenge: 'abc123', subscription: { type: 'channel.update' } });
  const mid = 'mid-verify';
  const ts = new Date().toISOString();
  const res = await cu.onRequestPost({
    env,
    request: new Request('https://phantomace.tv/api/channel-update', {
      method: 'POST',
      headers: {
        'twitch-eventsub-message-type': 'webhook_callback_verification',
        'twitch-eventsub-message-id': mid,
        'twitch-eventsub-message-timestamp': ts,
        'twitch-eventsub-message-signature': await signEventSub(SECRET, mid, ts, raw),
      },
      body: raw,
    }),
  });
  check('the verification challenge is echoed back verbatim', await res.text(), 'abc123');
  check('with a 200', res.status, 200);
}

/* ── A category change is recorded as one ────────────────────────────────── */
{
  const env = makeEnv();
  check('nothing stored reads as the empty shape, not null',
    (await cu.getStreamCategory(env)).categoryName, null);

  await post(env, MTG);
  const rec = stored(env);
  check('the category is recorded', rec.categoryName, 'Magic: The Gathering');
  check('with its id', rec.categoryId, '2748');
  check('and is flagged as a category change', rec.changed, 'category');
  ok('and timestamped', rec.changedAt > 0);
  check('the first change has no previous category', rec.prevCategoryId, null);

  const api = await cu.getStreamCategory(env);
  check('getStreamCategory reads it back', api.categoryName, 'Magic: The Gathering');
}

/* ── A TITLE EDIT IS NOT A CATEGORY CHANGE ───────────────────────────────
   The whole reason this handler diffs rather than acting on every event. */
{
  const env = makeEnv();
  await post(env, MTG);
  await post(env, { ...MTG, title: 'Cracking a box — pack 12' });

  const rec = stored(env);
  check('a title-only edit is NOT flagged as a category change', rec.changed, 'details');
  check('the new title is kept', rec.title, 'Cracking a box — pack 12');
  check('the category is untouched', rec.categoryName, 'Magic: The Gathering');
  check('and a title edit does not invent a previous category', rec.prevCategoryId, null);
}

/* ── Switching games carries where he came from ──────────────────────────── */
{
  const env = makeEnv();
  await post(env, MTG);
  await post(env, { category_id: '32982', category_name: 'Grand Theft Auto V', title: 'Something else' });

  const rec = stored(env);
  check('the new category lands', rec.categoryName, 'Grand Theft Auto V');
  check('flagged as a category change', rec.changed, 'category');
  check('and names what it switched from', rec.prevCategoryName, 'Magic: The Gathering');
  check('by id', rec.prevCategoryId, '2748');
}

/* ── A rename is not a switch ────────────────────────────────────────────
   Twitch renames categories. Same id, new name, must not read as him
   changing games. */
{
  const env = makeEnv();
  await post(env, MTG);
  const before = stored(env).changedAt;
  await post(env, { ...MTG, category_name: 'Magic: The Gathering Arena' });

  const rec = stored(env);
  check('a renamed category is not a category change', rec.changed, 'details');
  check('and does not fabricate a previous category', rec.prevCategoryId, null);
  check('but the new name IS stored, so it cannot go stale', rec.categoryName, 'Magic: The Gathering Arena');
  check('on the same id', rec.categoryId, '2748');
  ok('the record still updates', rec.changedAt >= before);
}

/* ── An identical redelivery writes nothing ──────────────────────────────── */
{
  const env = makeEnv();
  await post(env, MTG);
  const first = stored(env);
  await post(env, MTG);
  check('a duplicate event changes nothing at all', stored(env), first);
}

/* ── Twitch always gets a 200 ────────────────────────────────────────────
   Enough failures and Twitch disables the subscription, which costs more
   than losing one event. */
{
  const env = makeEnv();
  env.MARKETPLACE.mutate = async () => { throw new Error('store unavailable'); };
  const res = await post(env, MTG);
  check('a store failure still answers Twitch 200', res.status, 200);
}

/* ── An unrelated subscription type is ignored, not recorded ─────────────── */
{
  const env = makeEnv();
  await post(env, { category_id: '1', category_name: 'Nope' }, { type: 'channel.follow' });
  check('another event type writes no category', stored(env), null);
}

/* ── The three registrations that fail silently when missed ──────────────── */
{
  const registry = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the registry maps stream_category', /stream_category:\s*\{/.test(registry));

  const setup = fs.readFileSync(path.join(REPO, 'functions/api/admin/bot-setup.js'), 'utf8');
  ok('bot-setup registers channel.update', /type: 'channel\.update'/.test(setup));
  ok('at version 2 — v1 is retired and would be refused', /type: 'channel\.update',\s*\n\s*version: '2'/.test(setup));
  ok('pointed at this route', /callback: `\$\{origin\}\/api\/channel-update`/.test(setup));

  const adapter = fs.readFileSync(path.join(REPO, 'server/adapter.js'), 'utf8');
  ok('the adapter exempts the callback from rate limiting', /'\/api\/channel-update'/.test(adapter));

  const dash = fs.readFileSync(path.join(REPO, 'functions/api/bot/dashboard.js'), 'utf8');
  ok('Bot Control reports whether the subscription exists',
     /category: subTypes\.includes\('channel\.update'\)/.test(dash));
  ok('and whether it has been revoked', /category: isRevoked\(t => t === 'channel\.update'\)/.test(dash));

  const info = fs.readFileSync(path.join(REPO, 'functions/api/stream-info.js'), 'utf8');
  ok('the shared stream-info also carries the category', /category: stream \? \(stream\.game_name/.test(info));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[channel-update] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[channel-update] ${passed} assertions passed.`);
console.log('');
