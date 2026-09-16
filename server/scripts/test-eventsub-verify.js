#!/usr/bin/env node
/* ══════════════════════════════════════════════
   EVENTSUB SIGNATURE VERIFICATION — test suite

     node server/scripts/test-eventsub-verify.js

   This is the security boundary for every inbound Twitch webhook. Anything
   that gets past verifyEventSub is treated as Twitch speaking, and Twitch
   speaking moves real value: hype train drops, channel point redemptions,
   giveaway entries.

   It had no automated coverage at all. `test-eventsub.js` is a CLI that
   fires signed payloads at a running endpoint — useful, but it needs a
   live server and it is not in `npm test`, so nothing guarded this module
   during a refactor. A rewrite from node:crypto to Web Crypto landed on
   exactly that gap.

   NOTHING HERE ASSUMES AN IMPLEMENTATION. Every call is awaited, which is
   a no-op on a synchronous return and correct on a Promise, so this suite
   passes against both the node:crypto version and the SubtleCrypto one —
   and fails against either if the behaviour drifts. That is the point: it
   is the thing that lets you swap the crypto underneath and know.

   THE KNOWN-ANSWER TEST IS THE ANCHOR. One fixed secret, id, timestamp and
   body with one fixed expected digest, computed independently. Any change
   that alters what gets signed, in what order, or how it is encoded, fails
   that single assertion no matter how the code is arranged.
   ══════════════════════════════════════════════ */

import nodecrypto from 'node:crypto';
import { verifyEventSub, signEventSub } from '../lib/eventsub.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const SECRET = 'phantomace-test-secret';
const BODY = JSON.stringify({ subscription: { type: 'channel.hype_train.progress' }, event: { level: 4 } });
const ID = 'msg-abc-123';

/** A Request, to the depth verifyEventSub uses: case-insensitive header lookup.
    `omit` names headers that are genuinely absent — passing undefined would
    only select the default and test nothing. */
function req({ id = ID, ts, sig, type = 'notification', omit = [] } = {}) {
  const headers = {
    'twitch-eventsub-message-id': id,
    'twitch-eventsub-message-timestamp': ts,
    'twitch-eventsub-message-signature': sig,
    'twitch-eventsub-message-type': type,
  };
  for (const name of omit) delete headers['twitch-eventsub-message-' + name];
  return {
    headers: {
      get(h) {
        const v = headers[String(h).toLowerCase()];
        return v === undefined ? null : v;
      },
    },
  };
}

const now = () => new Date().toISOString();
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/* ── The known-answer test ───────────────────────────────────────────────
   Fixed inputs, one fixed digest, computed independently of the module.
   This pins the algorithm itself: HMAC-SHA256 over
   messageId + timestamp + rawBody, hex, prefixed `sha256=`. */
{
  const KAT = 'sha256=9b64e28c605549b8a76a0194bc966267c973fab515e06be4a20a81da4147b2b3';
  check('the signature of known input is exactly the known digest',
    await signEventSub(SECRET, 'msg-0001', '2026-01-01T00:00:00.000Z', '{"a":1}'), KAT);
}

/* ── Agreement with a reference implementation ───────────────────────── */
{
  const ts = now();
  const reference = 'sha256=' + nodecrypto
    .createHmac('sha256', SECRET).update(ID + ts + BODY).digest('hex');
  check('signEventSub agrees with a plain HMAC-SHA256',
    await signEventSub(SECRET, ID, ts, BODY), reference);

  /* Round trip: what we sign, we accept. If these two ever disagree,
     every webhook 403s and the cause is invisible from the outside. */
  const r = await verifyEventSub(req({ ts, sig: reference }), SECRET, BODY);
  check('a signature we produced verifies', r.ok, true);
  check('and the message type comes back', r.messageType, 'notification');
}

/* ── Forgery ─────────────────────────────────────────────────────────── */
{
  const ts = now();
  const good = await signEventSub(SECRET, ID, ts, BODY);

  check('a tampered body is rejected',
    (await verifyEventSub(req({ ts, sig: good }), SECRET, BODY + ' ')).ok, false);
  check('a different message id is rejected',
    (await verifyEventSub(req({ id: 'msg-other', ts, sig: good }), SECRET, BODY)).ok, false);
  check('a different timestamp is rejected',
    (await verifyEventSub(req({ ts: ago(1000), sig: good }), SECRET, BODY)).ok, false);
  check('the wrong secret is rejected',
    (await verifyEventSub(req({ ts, sig: good }), SECRET + 'x', BODY)).ok, false);

  /* A single flipped hex digit. The whole point of a MAC. */
  const flipped = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
  check('one flipped hex digit is rejected',
    (await verifyEventSub(req({ ts, sig: flipped }), SECRET, BODY)).ok, false);

  check('an empty signature is rejected',
    (await verifyEventSub(req({ ts, sig: '' }), SECRET, BODY)).ok, false);
  check('the prefix alone is rejected',
    (await verifyEventSub(req({ ts, sig: 'sha256=' }), SECRET, BODY)).ok, false);
  check('a signature with no sha256= prefix is rejected',
    (await verifyEventSub(req({ ts, sig: good.slice('sha256='.length) }), SECRET, BODY)).ok, false);

  /* These matter specifically for a Web Crypto implementation, which has to
     turn the hex back into bytes itself. parseInt('zz', 16) is NaN, and NaN
     written into a Uint8Array becomes 0 — so unvalidated garbage could
     silently become a digest of zeroes and be compared on equal terms. */
  check('odd-length hex is rejected',
    (await verifyEventSub(req({ ts, sig: 'sha256=abc' }), SECRET, BODY)).ok, false);
  check('non-hex characters are rejected',
    (await verifyEventSub(req({ ts, sig: 'sha256=' + 'z'.repeat(64) }), SECRET, BODY)).ok, false);
  check('an all-zero digest is rejected',
    (await verifyEventSub(req({ ts, sig: 'sha256=' + '0'.repeat(64) }), SECRET, BODY)).ok, false);
  check('a too-short digest is rejected',
    (await verifyEventSub(req({ ts, sig: 'sha256=' + 'ab'.repeat(16) }), SECRET, BODY)).ok, false);
  check('a too-long digest is rejected',
    (await verifyEventSub(req({ ts, sig: good + 'ab' }), SECRET, BODY)).ok, false);
}

/* ── Fail closed ─────────────────────────────────────────────────────── */
{
  /* THE ORIGINAL BUG. `if (secret)` meant a missing TWITCH_EVENTSUB_SECRET
     made four endpoints accept unsigned POSTs. A missing secret is a
     server fault, not a reason to wave the request through — and 500 says
     that, where 403 would look like a caller problem. */
  const ts = now();
  const good = await signEventSub(SECRET, ID, ts, BODY);
  for (const missing of ['', null, undefined]) {
    const r = await verifyEventSub(req({ ts, sig: good }), missing, BODY);
    check(`a secret of ${JSON.stringify(missing)} refuses rather than skips`, r.ok, false);
    check(`and reports a server fault, not a caller one`, r.status, 500);
  }
}

/* ── Missing headers ─────────────────────────────────────────────────── */
{
  const ts = now();
  const good = await signEventSub(SECRET, ID, ts, BODY);

  check('no message id is rejected',
    (await verifyEventSub(req({ ts, sig: good, omit: ['id'] }), SECRET, BODY)).status, 403);
  check('no timestamp is rejected',
    (await verifyEventSub(req({ ts, sig: good, omit: ['timestamp'] }), SECRET, BODY)).status, 403);
  check('no signature is rejected',
    (await verifyEventSub(req({ ts, sig: good, omit: ['signature'] }), SECRET, BODY)).status, 403);

  /* Message type is NOT required — it selects the handler branch, it does
     not authenticate anything, and a missing one must not 403 a request
     whose signature is good. */
  const r = await verifyEventSub(req({ ts, sig: good, omit: ['type'] }), SECRET, BODY);
  check('a missing message type still verifies', r.ok, true);
  check('and comes back as an empty string, never undefined', r.messageType, '');
}

/* ── The replay window ───────────────────────────────────────────────── */
{
  const sigFor = (ts) => signEventSub(SECRET, ID, ts, BODY);

  const fresh = now();
  check('a fresh timestamp passes',
    (await verifyEventSub(req({ ts: fresh, sig: await sigFor(fresh) }), SECRET, BODY)).ok, true);

  const recent = ago(9 * 60 * 1000);
  check('nine minutes old still passes',
    (await verifyEventSub(req({ ts: recent, sig: await sigFor(recent) }), SECRET, BODY)).ok, true);

  /* A CORRECTLY SIGNED replay. The signature is genuine — age is the only
     thing rejecting it, which is exactly what the window is for. */
  const stale = ago(11 * 60 * 1000);
  const staleResult = await verifyEventSub(req({ ts: stale, sig: await sigFor(stale) }), SECRET, BODY);
  check('eleven minutes old is rejected even though the signature is valid', staleResult.ok, false);
  check('and says why', /replay window/.test(staleResult.reason || ''), true);

  /* Both directions: the check is on absolute skew, so a future-dated
     message cannot buy itself an indefinite replay window. */
  const future = new Date(Date.now() + 11 * 60 * 1000).toISOString();
  check('eleven minutes in the future is rejected',
    (await verifyEventSub(req({ ts: future, sig: await sigFor(future) }), SECRET, BODY)).ok, false);

  const garbage = 'not-a-date';
  check('an unparseable timestamp is rejected',
    (await verifyEventSub(req({ ts: garbage, sig: await sigFor(garbage) }), SECRET, BODY)).status, 403);
}

/* ── Body handling ───────────────────────────────────────────────────── */
{
  /* The raw body must be signed byte for byte. Anything that parses and
     re-serialises first produces a different signature and 403s every
     webhook — which is why the server has no body-parsing layer at all. */
  const ts = now();

  const empty = await signEventSub(SECRET, ID, ts, '');
  check('an empty body verifies',
    (await verifyEventSub(req({ ts, sig: empty }), SECRET, '')).ok, true);

  const spaced = '{ "a" : 1 }';
  const sigSpaced = await signEventSub(SECRET, ID, ts, spaced);
  check('whitespace is part of the signed body',
    (await verifyEventSub(req({ ts, sig: sigSpaced }), SECRET, '{"a":1}')).ok, false);

  const unicode = JSON.stringify({ who: 'PhantomÁCE 💀', note: 'éèê' });
  const sigUni = await signEventSub(SECRET, ID, ts, unicode);
  check('a body with non-ASCII verifies',
    (await verifyEventSub(req({ ts, sig: sigUni }), SECRET, unicode)).ok, true);

  /* UTF-8 encoding must match the reference byte for byte, or emoji and
     accented display names would break signatures in production only. */
  check('non-ASCII is encoded as UTF-8, matching a plain HMAC',
    sigUni,
    'sha256=' + nodecrypto.createHmac('sha256', SECRET).update(ID + ts + unicode, 'utf8').digest('hex'));

  const big = 'x'.repeat(200000);
  const sigBig = await signEventSub(SECRET, ID, ts, big);
  check('a large body verifies',
    (await verifyEventSub(req({ ts, sig: sigBig }), SECRET, big)).ok, true);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[eventsub-verify] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[eventsub-verify] ${passed} assertions passed.`);
console.log('');
