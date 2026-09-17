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
