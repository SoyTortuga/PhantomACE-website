#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Send a correctly-signed EventSub webhook to any URL.

   Usage:
     node server/scripts/test-eventsub.js --url https://dev.phantomace.tv/api/hype-train --type hype-train-progress --level 5
     node server/scripts/test-eventsub.js --url ... --type hype-train-begin
     node server/scripts/test-eventsub.js --url ... --type hype-train-progress --level 20 --bad-secret
     node server/scripts/test-eventsub.js --url ... --type hype-train-progress --level 5 --stale

   WHY NOT THE TWITCH CLI. `twitch event trigger` mocks a hype train at level
   1, and hype-train.js only rewards levels 5, 10, 15 and 20 — every other
   level returns silently. A default CLI trigger therefore does nothing at
   all and looks exactly like a broken handler. Controlling the payload here
   removes that trap and lets us drive a specific level.

   It also lets us test the paths that MATTER for a public webhook: a wrong
   secret must be rejected, and a stale timestamp must be rejected. Those are
   the difference between a webhook and an open endpoint anyone can POST
   forged Twitch events to.

   POINT THIS AT DEV. It mints real codes and posts real chat messages if
   aimed at production.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return process.argv.includes(`--${name}`) ? true : fallback;
}

const TYPES = {
  'hype-train-begin':    'channel.hype_train.begin',
  'hype-train-progress': 'channel.hype_train.progress',
  'hype-train-end':      'channel.hype_train.end',
};

function buildEvent(type, level, broadcasterId) {
  const base = {
    id: `test-${Date.now()}`,
    broadcaster_user_id: broadcasterId,
    broadcaster_user_login: 'phantomace',
    broadcaster_user_name: 'PhantomACE',
    level: Number(level),
    total: Number(level) * 1000,
    goal: (Number(level) + 1) * 1000,
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300000).toISOString(),
  };
  if (type === 'channel.hype_train.end') base.ended_at = new Date().toISOString();
  return base;
}

async function main() {
  const url = arg('url');
  const shortType = arg('type', 'hype-train-progress');
  const level = arg('level', 5);
  const badSecret = arg('bad-secret') === true;
  const stale = arg('stale') === true;

  if (!url) {
    console.error('usage: --url <endpoint> [--type hype-train-progress] [--level 5] [--bad-secret] [--stale]');
    process.exit(2);
  }

  if (/^https:\/\/(www\.)?phantomace\.tv/.test(url)) {
    console.error('[eventsub] REFUSING to target production.');
    console.error('[eventsub] This mints real codes and posts real chat messages.');
    console.error('[eventsub] Use https://dev.phantomace.tv/... instead.');
    process.exit(1);
  }

  const type = TYPES[shortType] || shortType;
  const realSecret = process.env.TWITCH_EVENTSUB_SECRET;
  if (!realSecret) {
    console.error('[eventsub] TWITCH_EVENTSUB_SECRET not found in server/.env');
    process.exit(2);
  }
  const secret = badSecret ? 'deliberately-the-wrong-secret' : realSecret;

  const broadcasterId = process.env.TWITCH_BROADCASTER_ID || '77379157';
  const body = JSON.stringify({
    subscription: {
      id: crypto.randomUUID(),
      type,
      version: '1',
      status: 'enabled',
      condition: { broadcaster_user_id: broadcasterId },
      created_at: new Date().toISOString(),
    },
    event: buildEvent(type, level, broadcasterId),
  });

  const messageId = crypto.randomUUID();
  /* 11 minutes back, outside the 10-minute replay window. A webhook that
     accepts an old message can have a captured one replayed at it forever. */
  const timestamp = stale
    ? new Date(Date.now() - 11 * 60 * 1000).toISOString()
    : new Date().toISOString();

  const signature = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(messageId + timestamp + body)
    .digest('hex');

  console.log(`[eventsub] -> ${url}`);
  console.log(`[eventsub]    type=${type} level=${level}` +
    (badSecret ? '  SECRET=WRONG (expect 403)' : '') +
    (stale ? '  TIMESTAMP=STALE (expect rejection)' : ''));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Twitch-Eventsub-Message-Id': messageId,
      'Twitch-Eventsub-Message-Timestamp': timestamp,
      'Twitch-Eventsub-Message-Signature': signature,
      'Twitch-Eventsub-Message-Type': 'notification',
      'Twitch-Eventsub-Subscription-Type': type,
    },
    body,
  });

  const text = await res.text();
  console.log(`[eventsub] <- ${res.status} ${text.slice(0, 200)}`);

  if (badSecret) {
    if (res.status === 200) {
      console.error('');
      console.error('[eventsub] FAILURE: a WRONGLY SIGNED event was accepted.');
      console.error('[eventsub] Anyone could POST forged Twitch events at this endpoint.');
      process.exit(1);
    }
    console.log('[eventsub] OK — forged signature rejected.');
    return;
  }

  if (stale) {
    /* Reported rather than failed, because the handlers verify the signature
       but do NOT check the timestamp. server/lib/eventsub.js has a 10-minute
       replay window and tests for it, but the webhook handlers still use
       their own inlined copies and none of them call it — the consolidation
       described in the migration plan was written and never wired up.

       Severity is genuinely low: replaying requires a captured signed
       request, which over HTTPS means an attacker who already has the
       secret or the traffic. And hype-train.js is idempotent per event id
       and level, so replaying the SAME event changes nothing. It is
       defence in depth that is currently absent, not an open door. */
    if (res.status === 200) {
      console.log('');
      console.log('[eventsub] NOTE: an 11-minute-old event was ACCEPTED.');
      console.log('[eventsub] The handlers check the signature but not the timestamp, so');
      console.log('[eventsub] there is no replay window. server/lib/eventsub.js implements');
      console.log('[eventsub] one and is not wired into any handler. Low severity — a');
      console.log('[eventsub] replay needs a captured signed request — but worth closing.');
    } else {
      console.log('[eventsub] Replay rejected — a replay window is in place after all.');
    }
    return;
  }

  if (res.status !== 200) {
    console.error('');
    console.error('[eventsub] FAILURE: a correctly signed event was rejected.');
    process.exit(1);
  }
  console.log('[eventsub] OK — correctly signed event accepted.');
}

main().catch(err => {
  console.error('[eventsub] FAILED:', err.message);
  process.exit(1);
});
