#!/usr/bin/env node
/* ══════════════════════════════════════════════
   GIVEAWAY CHANNEL POINT REWARDS — inspect and manage

     node server/scripts/giveaway-rewards.js --service phantomace-web
     node server/scripts/giveaway-rewards.js --service phantomace-web --create --confirm
     node server/scripts/giveaway-rewards.js --service phantomace-web --set-cost "Enter Giveaway=1" --confirm
     node server/scripts/giveaway-rewards.js --service phantomace-web --hide "Enter Giveaway" --confirm
     node server/scripts/giveaway-rewards.js --service phantomace-web --sync --confirm
     node server/scripts/giveaway-rewards.js --service phantomace-web --set-cost "TTSMonster TTS=500" --force --confirm

   WHY A SCRIPT AND NOT THE ADMIN PAGE. Managing a channel's rewards needs
   a broadcaster token with channel:manage:redemptions. The site already
   holds one — it refreshes it for the giveaway toggle — but the admin
   page additionally gates on the SESSION being the broadcaster, which is
   not always available. A script run on the rig uses the stored token and
   needs nobody signed in.

   THE QUESTION THIS ANSWERS FIRST. Twitch only lets a client id manage
   the rewards that client id CREATED. A reward made by hand in the
   creator dashboard belongs to Twitch's own client and is permanently
   read-only to us — no scope grants it. Helix exposes this directly as
   `only_manageable_rewards`, so the listing below marks each reward
   MANAGEABLE or read-only rather than guessing, and any attempt to change
   a read-only one is refused here rather than failing at the API.

   --force SENDS THE REQUEST ANYWAY. Normally a change to a read-only
   reward is refused here, on the manageability answer Twitch gave in the
   listing, rather than being sent and failing. --force skips that check so
   Twitch itself answers, verbatim, and prints the whole response body. It
   exists because "the docs say no" and "Twitch said no" are different
   claims, and only the second one settles an argument.

   Dry run unless --confirm. The listing is always read-only.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl, readServiceEnv } from '../lib/service-env.js';

const HELIX = 'https://api.twitch.tv/helix/channel_points/custom_rewards';

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}
const line = (s = '') => console.log(s);

/* The two entry rewards. Both cost 1: the rarity is a property of the
   DRAW, announced up front, not something a viewer pays more for. The
   colours are the only thing telling them apart in the reward list, so
   they carry the weight. */
export const ENTRY_REWARDS = [
  {
    title: 'Enter Rare Giveaway',
    cost: 1,
    background_color: '#c7a550',            // gold
    prompt: 'Enter the Rare giveaway running now. One entry each.',
  },
  {
    title: 'Enter Mythic Giveaway',
    cost: 1,
    background_color: '#eb6726',            // orange
    prompt: 'Enter the Mythic giveaway running now. One entry each.',
  },
];

/* Shared by every created reward. Disabled on creation: a reward is opened
   for a draw and closed after it, which the site already does through
   giveaway.js.

   THE QUEUE STAYS OPEN, and it is the whole refund mechanism. A redemption
   that skips the queue goes straight to FULFILLED, and Twitch only allows
   status changes on UNFULFILLED ones -- so with skip on, a viewer who
   redeemed twice was simply charged twice, with no way to give the second
   point back. With the queue open, the entry webhook FULFILS the first
   entry and CANCELS duplicates, which refunds them automatically. Nobody
   approves anything by hand; the webhook is the approver.

   No per-stream cap either: Twitch resets that between broadcasts, and a
   night with a Rare draw and a Mythic draw is two giveaways in one stream.
   "Once per GIVEAWAY" is the server's rule to enforce, and refunding is
   how it says no. */
const COMMON = {
  is_enabled: false,
  should_redemptions_skip_request_queue: false,
  is_max_per_user_per_stream_enabled: false,
};

async function helix(token, clientId, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Client-Id': clientId,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, data, raw: text };
}

async function main() {
  const service = arg('service');
  const confirm = arg('confirm') === true;
  const force = arg('force') === true;

  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });
  if (!databaseUrl) {
    console.error('[rewards] No DATABASE_URL. Use --service phantomace-web.');
    process.exit(2);
  }

  /* The client id and broadcaster id live beside DATABASE_URL in whichever
     environment this is pointed at, so they are read the same way. */
  const svc = service ? readServiceEnv(service) : {};
  const clientId = svc.TWITCH_CLIENT_ID || process.env.TWITCH_CLIENT_ID;
  const clientSecret = svc.TWITCH_CLIENT_SECRET || process.env.TWITCH_CLIENT_SECRET;
  const broadcasterId = svc.TWITCH_BROADCASTER_ID || process.env.TWITCH_BROADCASTER_ID;
  if (!clientId || !clientSecret || !broadcasterId) {
    console.error('[rewards] Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET / TWITCH_BROADCASTER_ID.');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  line(`Database:    ${info.db}`);
  const kv = createKVStore(pool);
  const env = { MARKETPLACE: kv, TWITCH_CLIENT_ID: clientId, TWITCH_CLIENT_SECRET: clientSecret };

  const { getBroadcasterToken } = await import('../../functions/api/bot/send-chat.js');
  const token = await getBroadcasterToken(env);
  if (!token) {
    console.error('');
    console.error('[rewards] No broadcaster token. The site has never been authorised for');
    console.error('          channel points management, or the refresh token has been revoked.');
    console.error('          Step 2 of /api/admin/bot-setup grants it — that step DOES need');
    console.error('          the broadcaster signed in, once.');
    await pool.end();
    process.exit(3);
  }
  line('Broadcaster: token obtained');
  line('');

  /* Everything on the channel, then everything WE may change. The second
     list is the answer to "can we alter the 5000-point one". */
  const all = await helix(token, clientId, 'GET', `${HELIX}?broadcaster_id=${broadcasterId}`);
  if (!all.ok) {
    console.error(`[rewards] Could not list rewards: HTTP ${all.status} ${all.raw.slice(0, 200)}`);
    await pool.end();
    process.exit(4);
  }
  const mine = await helix(token, clientId, 'GET', `${HELIX}?broadcaster_id=${broadcasterId}&only_manageable_rewards=true`);
  const manageable = new Set((mine.ok && mine.data ? mine.data.data : []).map(r => r.id));

  const rewards = (all.data && all.data.data) || [];
  line(`CHANNEL POINT REWARDS (${rewards.length})`);
  line('');
  for (const r of rewards) {
    const flag = manageable.has(r.id) ? 'MANAGEABLE' : 'read-only ';
    const state = r.is_enabled ? (r.is_paused ? 'paused ' : 'enabled') : 'hidden ';
    /* The colour is shown because it is the ONLY thing distinguishing the
       two entry rewards in a viewer's reward list — same title shape, same
       one-point cost — and it is not otherwise visible from here. */
    const colour = (r.background_color || '').toLowerCase().padEnd(7);
    line(`  ${flag}  ${state}  ${String(r.cost).padStart(6)}pt  ${colour}  ${r.title}`);
  }
  line('');
  line(`  ${manageable.size} of ${rewards.length} were created by this application and can be changed.`);
  if (manageable.size < rewards.length) {
    line('  The rest were made in the Twitch dashboard. Twitch permanently refuses');
    line('  API changes to those, whatever scopes are granted — they can only be');
    line('  edited by hand, or deleted and recreated through this script.');
  }
  line('');

  const byTitle = new Map(rewards.map(r => [r.title.toLowerCase(), r]));
  const changes = [];

  /* --create: the two entry rewards, if they are not already there. */
  if (arg('create')) {
    for (const spec of ENTRY_REWARDS) {
      const existing = byTitle.get(spec.title.toLowerCase());
      if (existing) {
        line(`  = "${spec.title}" already exists (${existing.cost}pt) — leaving it alone`);
        continue;
      }
      changes.push({ kind: 'create', spec });
    }
  }

  /* --sync (formerly --fix-colours, still accepted): bring both entry
     rewards to the FULL spec in ENTRY_REWARDS plus COMMON's queue setting.
     A reward created before any of those were settled keeps whatever it was
     made with, and nothing else can change it: colour, prompt, and --
     critically -- whether redemptions skip the queue, which is the
     difference between a duplicate entry being refundable and a viewer
     just losing the point. */
  if (arg('sync') || arg('fix-colours') || arg('fix-colors')) {
    for (const spec of ENTRY_REWARDS) {
      const r = byTitle.get(spec.title.toLowerCase());
      if (!r) { line(`  ? "${spec.title}" does not exist yet — run --create`); continue; }
      if (!manageable.has(r.id)) { line(`  ! "${spec.title}" is read-only — change it by hand`); continue; }

      const body = {};
      const was = [];
      if ((r.background_color || '').toLowerCase() !== spec.background_color.toLowerCase()) {
        body.background_color = spec.background_color;
        was.push(`colour ${(r.background_color || 'unset').toLowerCase()}`);
      }
      if ((r.prompt || '') !== spec.prompt) {
        body.prompt = spec.prompt;
        was.push('prompt differs');
      }
      const skip = !!(r.should_redemptions_skip_request_queue);
      if (skip !== !!COMMON.should_redemptions_skip_request_queue) {
        body.should_redemptions_skip_request_queue = COMMON.should_redemptions_skip_request_queue;
        was.push(`skip_queue ${skip}`);
      }
      if (!Object.keys(body).length) { line(`  = "${spec.title}" already matches the spec`); continue; }
      changes.push({ kind: 'update', id: r.id, title: spec.title, body, was: was.join(', ') });
    }
  }

  /* --set-cost "Title=N", repeatable. */
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== '--set-cost') continue;
    const pair = process.argv[i + 1] || '';
    const eq = pair.lastIndexOf('=');
    if (eq < 1) { console.error(`[rewards] --set-cost wants "Title=N", got "${pair}"`); process.exit(2); }
    const title = pair.slice(0, eq).trim();
    const cost = parseInt(pair.slice(eq + 1), 10);
    const r = byTitle.get(title.toLowerCase());
    if (!r) { console.error(`[rewards] No reward titled "${title}".`); process.exit(2); }
    if (!manageable.has(r.id) && !force) {
      console.error(`[rewards] "${title}" was not created by this application — Twitch will not let us change it.`);
      console.error('          Change the cost by hand in the Twitch creator dashboard, or');
      console.error('          add --force to send the request anyway and see what Twitch says.');
      process.exit(5);
    }
    if (!Number.isInteger(cost) || cost < 1) { console.error('[rewards] Cost must be a whole number, 1 or more.'); process.exit(2); }
    changes.push({ kind: 'update', id: r.id, title, body: { cost }, was: `${r.cost}pt`, readOnly: !manageable.has(r.id) });
  }

  /* --hide "Title" — disabled, not deleted, so it keeps its id and history. */
  const hide = arg('hide');
  if (typeof hide === 'string') {
    const r = byTitle.get(hide.toLowerCase());
    if (!r) { console.error(`[rewards] No reward titled "${hide}".`); process.exit(2); }
    if (!manageable.has(r.id) && !force) {
      console.error(`[rewards] "${hide}" was not created by this application — hide it by hand instead,`);
      console.error('          or add --force to send the request anyway and see what Twitch says.');
      process.exit(5);
    }
    if (!r.is_enabled) line(`  = "${hide}" is already hidden`);
    else changes.push({ kind: 'update', id: r.id, title: hide, body: { is_enabled: false }, was: 'enabled', readOnly: !manageable.has(r.id) });
  }

  if (!changes.length) {
    line('Nothing to change. (Pass --create, --sync, --set-cost or --hide.)');
    await pool.end();
    return;
  }

  line('PLANNED CHANGES');
  for (const c of changes) {
    if (c.kind === 'create') line(`  + create "${c.spec.title}" — ${c.spec.cost}pt, ${c.spec.background_color}, hidden until a draw opens`);
    else line(`  ~ update "${c.title}" — ${JSON.stringify(c.body)} (was ${c.was})` +
      (c.readOnly ? '   [READ-ONLY — forced; Twitch is expected to refuse this]' : ''));
  }
  line('');

  if (!confirm) {
    line('DRY RUN — nothing sent to Twitch. Re-run with --confirm.');
    await pool.end();
    return;
  }

  for (const c of changes) {
    if (c.kind === 'create') {
      const res = await helix(token, clientId, 'POST', `${HELIX}?broadcaster_id=${broadcasterId}`, { ...COMMON, ...c.spec });
      if (!res.ok) {
        const msg = (res.data && res.data.message) || res.raw.slice(0, 160);
        line(`  ! "${c.spec.title}" not created: HTTP ${res.status} ${msg}`);
        if (/duplicate/i.test(msg)) line('    (a reward with this title already exists on the channel)');
        continue;
      }
      line(`  + "${c.spec.title}" created — id ${res.data.data[0].id}`);
    } else {
      const res = await helix(token, clientId, 'PATCH', `${HELIX}?broadcaster_id=${broadcasterId}&id=${c.id}`, c.body);
      if (!res.ok) {
        line(`  ! "${c.title}" not updated: HTTP ${res.status} ${(res.data && res.data.message) || ''}`);
        /* The WHOLE body, not a truncated message. A forced attempt exists
           to be read, and the difference between "not created by this
           client" and anything else is the entire answer. */
        if (c.readOnly) {
          line(`    Twitch said: ${res.raw || '(empty body)'}`);
          line('    A 403 naming the client id is ownership, not permission: only the');
          line('    application that CREATED a reward may change it, whatever scopes');
          line('    are granted. Nothing this script can do will alter that one.');
        }
        continue;
      }
      line(`  ~ "${c.title}" updated` + (c.readOnly ? '  — and Twitch ALLOWED it, so the listing was misleading' : ''));
    }
  }

  line('');
  line('Done. Re-run without flags to see the channel as it stands now.');
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[rewards]', err.message);
    process.exit(1);
  });
}
