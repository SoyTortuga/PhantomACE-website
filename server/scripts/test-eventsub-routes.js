#!/usr/bin/env node
/* ══════════════════════════════════════════════
   EVENTSUB ROUTES — test suite

     node server/scripts/test-eventsub-routes.js

   test-eventsub-verify.js proves the VERIFIER is right. This proves the
   five webhook routes actually use it — which is a different claim, and
   the one that was false for four of them until they were migrated off
   their own byte-identical copies.

   Every route is driven for real: a Request is built, signed or not, and
   handed to the route's own onRequestPost. No database is needed because
   an unsigned request is refused before any handler logic runs, and a
   signed `webhook_callback_verification` returns the challenge and stops.

   The three things asserted of each route:

     no secret        → 500, never "skip verification"
     bad signature    → 403
     good signature   → 200 and the challenge echoed back

   The middle one is what the old copies got right. The first is what
   they got wrong: `if (secret)` meant a missing secret turned a public
   endpoint into one that accepts unsigned posts from anyone.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signEventSub } from '../lib/eventsub.js';

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

const SECRET = 'a-test-eventsub-secret';

/* Every route that Twitch posts EventSub notifications to. */
const ROUTES = [
  ['hype train', '../../functions/api/hype-train.js', 'functions/api/hype-train.js'],
  ['channel points', '../../functions/api/channel-points.js', 'functions/api/channel-points.js'],
  ['chat commands', '../../functions/api/bot/commands.js', 'functions/api/bot/commands.js'],
  ['giveaway entry', '../../functions/api/bot/giveaway-entry.js', 'functions/api/bot/giveaway-entry.js'],
  ['milestones', '../../functions/api/milestones.js', 'functions/api/milestones.js'],
  ['predictions', '../../functions/api/prediction-events.js', 'functions/api/prediction-events.js'],
  ['ad break', '../../functions/api/ad-break.js', 'functions/api/ad-break.js'],
  ['bits', '../../functions/api/bits.js', 'functions/api/bits.js'],
  ['channel update', '../../functions/api/channel-update.js', 'functions/api/channel-update.js'],
];

/* EVERY route must surface a revocation. Twitch revokes and then simply stops
   sending, so a route that swallows one goes quiet with nothing anywhere
   saying why and the Step 4 snapshot still reading green. giveaway-entry was
   the one that did exactly that. */
const REVOCATION_ROUTES = [
  'functions/api/hype-train.js', 'functions/api/channel-points.js',
  'functions/api/prediction-events.js', 'functions/api/milestones.js',
  'functions/api/ad-break.js', 'functions/api/bits.js',
  'functions/api/channel-update.js', 'functions/api/bot/commands.js',
  'functions/api/bot/giveaway-entry.js',
];

/** A Twitch-shaped request. `sign` false leaves the headers off entirely. */
async function makeRequest(body, { sign = true, secret = SECRET, type = 'webhook_callback_verification', timestamp = null } = {}) {
  const raw = JSON.stringify(body);
  const messageId = 'test-message-id-0001';
  const ts = timestamp || new Date().toISOString();
  const headers = { 'Content-Type': 'application/json', 'twitch-eventsub-message-type': type };
  if (sign) {
    headers['twitch-eventsub-message-id'] = messageId;
    headers['twitch-eventsub-message-timestamp'] = ts;
    headers['twitch-eventsub-message-signature'] = await signEventSub(secret, messageId, ts, raw);
  }
  return new Request('https://phantomace.tv/api/x', { method: 'POST', headers, body: raw });
}

for (const [name, spec, rel] of ROUTES) {
  const mod = await import(spec);
  ok(`${name}: exports onRequestPost`, typeof mod.onRequestPost === 'function');
  if (typeof mod.onRequestPost !== 'function') continue;

  const challenge = 'challenge-' + name.replace(/\s+/g, '-');
  const body = { challenge, subscription: { type: 'test' } };

  /* THE BUG THE MIGRATION FIXED. A missing secret must refuse, not skip. */
  const noSecret = await mod.onRequestPost({ env: {}, request: await makeRequest(body) });
  check(`${name}: no secret configured is a 500, not a free pass`, noSecret.status, 500);

  /* Unsigned. */
  const unsigned = await mod.onRequestPost({
    env: { TWITCH_EVENTSUB_SECRET: SECRET },
    request: await makeRequest(body, { sign: false }),
  });
  check(`${name}: an unsigned request is refused`, unsigned.status, 403);

  /* Signed with the wrong secret. */
  const wrong = await mod.onRequestPost({
    env: { TWITCH_EVENTSUB_SECRET: SECRET },
    request: await makeRequest(body, { secret: 'not-the-secret' }),
  });
  check(`${name}: a wrong signature is refused`, wrong.status, 403);

  /* Signed correctly but old — a captured request replayed. */
  const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const replayed = await mod.onRequestPost({
    env: { TWITCH_EVENTSUB_SECRET: SECRET },
    request: await makeRequest(body, { timestamp: stale }),
  });
  check(`${name}: a replayed request is refused`, replayed.status, 403);

  /* Signed, fresh, and a callback verification — answered with the
     challenge, which is what Twitch needs to activate a subscription. */
  const good = await mod.onRequestPost({
    env: { TWITCH_EVENTSUB_SECRET: SECRET },
    request: await makeRequest(body),
  });
  check(`${name}: a good signature is accepted`, good.status, 200);
  check(`${name}: and the challenge is echoed`, (await good.text()).trim(), challenge);

  /* And no copy of the verifier has grown back. */
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  ok(`${name}: imports the shared verifier`, /import \{ verifyEventSub \}/.test(src));
  ok(`${name}: has no verifySignature of its own`, !/function verifySignature/.test(src));
  ok(`${name}: does not sign its own HMAC`, !/crypto\.subtle\.sign/.test(src));
  ok(`${name}: does not compare signatures with ===`, !/HMAC_PREFIX \+ hex/.test(src));
}

/* ── Nothing under functions/ verifies EventSub by hand ──────────────── */
{
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      /* session-crypto.js signs the login cookie — a different secret and
         a different job — so it is about EventSub headers, not HMAC. */
      if (/twitch-eventsub-message-signature/.test(src) && !/verifyEventSub/.test(src)) {
        offenders.push(path.relative(REPO, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(REPO, 'functions'));
  check('no route reads the EventSub signature header without the shared verifier', offenders, []);
}

/* ── Message-id dedupe reaches every route, with no route edits ──────────
   The routes call verifyEventSub(request, secret, body) with no store; the
   verifier dedupes through the store the server created. So this builds a
   REAL kv.js store — createKVStore over a fake pg pool that honours the
   advisory lock and the expiry column — exactly as index.js does, and then
   drives every webhook route's own onRequestPost.

   The route's env.MARKETPLACE is a separate counting stub, so "no side
   effects" is measured: a duplicate must be answered before the handler
   touches storage at all. */
{
  const { createKVStore } = await import('../lib/kv.js');

  function fakePool() {
    const rows = new Map();
    const locks = new Map();
    const tick = () => new Promise(r => setImmediate(r));
    return {
      rows,
      async query() { throw new Error('dedupe should only use mutate()'); },
      async connect() {
        let release = null;
        return {
          async query(sql, params = []) {
            if (/^\s*BEGIN/.test(sql)) return { rows: [] };
            if (/pg_advisory_xact_lock/.test(sql)) {
              const k = params[0];
              const prev = locks.get(k) || Promise.resolve();
              const mine = new Promise(r => { release = r; });
              locks.set(k, prev.then(() => mine));
              await prev;
              return { rows: [] };
            }
            if (/^\s*SELECT value, expires_at/.test(sql)) {
              await tick();
              const row = rows.get(params[0]);
              const live = row && (!row.expires_at || row.expires_at > new Date());
              return { rows: live ? [row] : [] };
            }
            if (/^\s*INSERT/.test(sql)) {
              await tick();
              rows.set(params[0], { value: JSON.parse(params[1]), expires_at: params[2] });
              return { rows: [] };
            }
            if (/^\s*(COMMIT|ROLLBACK)/.test(sql)) {
              if (release) release();
              release = null;
              return { rows: [] };
            }
            throw new Error('unexpected SQL: ' + sql);
          },
          release() {},
        };
      },
    };
  }

  const pool = fakePool();
  createKVStore(pool);

  function countingKV() {
    const kv = { touches: 0 };
    for (const op of ['get', 'put', 'delete', 'list', 'listValues', 'claim', 'withLock']) {
      kv[op] = async () => { kv.touches++; return op === 'list' ? { keys: [], list_complete: true } : null; };
    }
    kv.mutate = async (k, fn) => { kv.touches++; return fn(null); };
    kv.pullGiveawayCode = async () => { kv.touches++; return null; };
    return kv;
  }

  async function notify(mod, id, kv) {
    const raw = JSON.stringify({ subscription: { type: 'test.dedupe' }, event: {} });
    const ts = new Date().toISOString();
    const request = new Request('https://phantomace.tv/api/x', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-id': id,
        'twitch-eventsub-message-timestamp': ts,
        'twitch-eventsub-message-signature': await signEventSub(SECRET, id, ts, raw),
      },
      body: raw,
    });
    try {
      const res = await mod.onRequestPost({ env: { TWITCH_EVENTSUB_SECRET: SECRET, MARKETPLACE: kv }, request, waitUntil() {} });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      return { status: 'threw', text: err.message };
    }
  }

  /* Handlers log about the stub env; silenced for the section, once, so
     concurrent calls cannot restore each other's stubs. */
  const quiet = { error: console.error, log: console.log, warn: console.warn };
  console.error = console.log = console.warn = () => {};

  const DUP = /Duplicate EventSub message/;
  /* ROUTES is the single list — it used to carry only five, with ad break,
     bits and prediction events bolted on here, so those three were never put
     through the checks above. Listing a route twice also replays one message
     id through the dedupe cache and reads as a false failure. */
  const ALL_ROUTES = ROUTES.map(([name, spec]) => [name, spec]);

  for (const [name, spec] of ALL_ROUTES) {
    const mod = await import(spec);
    const slug = name.replace(/\s+/g, '-');

    /* (b) the same id twice. */
    const firstKV = countingKV();
    const first = await notify(mod, `dedupe-${slug}-A`, firstKV);
    check(`${name}: first delivery is answered 200`, first.status, 200);
    ok(`${name}: and handled, not deduped`, !DUP.test(first.text));

    const repeatKV = countingKV();
    const repeat = await notify(mod, `dedupe-${slug}-A`, repeatKV);
    check(`${name}: a redelivered message id is answered 200`, repeat.status, 200);
    ok(`${name}: as a duplicate`, DUP.test(repeat.text));
    check(`${name}: with no storage side effects at all`, repeatKV.touches, 0);

    /* (c) a different id is not mistaken for a repeat. */
    const other = await notify(mod, `dedupe-${slug}-B`, countingKV());
    check(`${name}: a different message id is answered 200`, other.status, 200);
    ok(`${name}: and proceeds`, !DUP.test(other.text));
  }

  /* The claim landed in the real store, under the registered key, with a
     real expiry — kv.js only writes expires_at for a 'real' family, so a
     null here would mean the registry entry had lost its expiry. */
  const row = pool.rows.get('eventsub_msg_dedupe-milestones-A');
  ok('the claim is stored as eventsub_msg_<id>', !!row);
  const ttl = row && row.expires_at ? (row.expires_at.getTime() - Date.now()) / 1000 : 0;
  ok('and expires after roughly the replay window', ttl > 600 && ttl <= 660);

  /* Atomic through the real mutate(): concurrent deliveries of one id. */
  const mod = await import('../../functions/api/hype-train.js');
  const racers = await Promise.all([1, 2, 3].map(() => notify(mod, 'dedupe-race', countingKV())));
  Object.assign(console, quiet);
  check('three concurrent deliveries of one id: exactly one is handled',
    racers.filter(r => !DUP.test(r.text)).length, 1);
}

{
  for (const rel of REVOCATION_ROUTES) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const name = rel.replace('functions/api/', '');
    ok(`${name} records a revocation`, /recordEventSubRevocation/.test(src));
    ok(`${name} clears one when it delivers again`, /clearEventSubRevocation/.test(src));
  }
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[eventsub-routes] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[eventsub-routes] ${passed} assertions passed.`);
console.log('');
