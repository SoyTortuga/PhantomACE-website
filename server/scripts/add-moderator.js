#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Add or remove a site moderator from the rig.

   WHY THIS EXISTS: the allowlist starts empty and only the broadcaster can
   change it through the UI, so there is no way to add the FIRST moderator
   from inside the site. This is the bootstrap.

   It is not a privilege escalation. Anyone who can run this already has the
   production database and the service credentials — the broadcaster-only
   rule in moderators.js guards the WEB path, where the actor is a cookie.
   Here the actor is someone with a shell on the rig, which is strictly more
   authority than the button grants.

   That said: being on this list means being able to drop codes, run the
   giveaway, and now link the chat bot. Tell the broadcaster who is on it.

   Usage:
     node server/scripts/add-moderator.js --list --service phantomace-web
     node server/scripts/add-moderator.js --user-id 12345678 --name Designer --service phantomace-web
     node server/scripts/add-moderator.js --user-id 12345678 --name Designer --service phantomace-web --confirm
     node server/scripts/add-moderator.js --user-id 12345678 --remove --service phantomace-web --confirm

   Dry run unless --confirm, and it resolves the id to a Twitch login name
   BEFORE writing — a mistyped id is otherwise indistinguishable from a
   correct one until the wrong person starts dropping codes.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl, readServiceEnv } from '../lib/service-env.js';
import { onRequestPost, getModerators } from '../../functions/api/admin/moderators.js';

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}

async function resolveLogin(clientId, clientSecret, id) {
  if (!clientId || !clientSecret) return null;
  try {
    const t = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    });
    if (!t.ok) return { error: `token HTTP ${t.status}` };
    const { access_token } = await t.json();
    const r = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${access_token}`, 'Client-Id': clientId },
    });
    if (!r.ok) return { error: `helix HTTP ${r.status}` };
    const u = (await r.json()).data?.[0];
    return u ? { login: u.login, displayName: u.display_name } : { error: 'no Twitch account has that id' };
  } catch (err) {
    return { error: err.message };
  }
}

async function main() {
  const service = arg('service');
  const userId = arg('user-id') ? String(arg('user-id')).trim() : '';
  const name = arg('name') === true ? '' : (arg('name') || '');
  const remove = arg('remove') === true;
  const listOnly = arg('list') === true;
  const confirm = arg('confirm') === true;

  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });
  if (!databaseUrl) {
    console.error('[mod] No DATABASE_URL. Use --service phantomace-web, or set it in server/.env');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  console.log(`Database: ${info.db}`);

  const serviceVars = service ? readServiceEnv(service) : {};
  const env = {
    TWITCH_BROADCASTER_ID: serviceVars.TWITCH_BROADCASTER_ID || process.env.TWITCH_BROADCASTER_ID,
    MARKETPLACE: createKVStore(pool),
  };
  if (!env.TWITCH_BROADCASTER_ID) {
    console.error('[mod] TWITCH_BROADCASTER_ID is not set — cannot act with broadcaster authority.');
    process.exit(2);
  }

  const show = async () => {
    const { entries } = await getModerators(env);
    console.log('');
    console.log('Current moderators:');
    if (!entries.length) console.log('  (none — only the broadcaster can use the panel)');
    for (const e of entries) {
      console.log(`  ${String(e.userId).padEnd(12)} ${e.displayName || '(no name)'}` +
        (e.addedAt ? `   added ${new Date(e.addedAt).toISOString().slice(0, 10)}` : ''));
    }
    console.log('');
  };

  await show();
  if (listOnly) { await pool.end().catch(() => {}); return; }

  if (!/^\d+$/.test(userId)) {
    console.error('[mod] --user-id must be a numeric Twitch user ID (not a username).');
    console.error('      Look one up at https://streamscharts.com/tools/convert-username');
    process.exit(2);
  }

  /* Resolve before writing. The whole failure mode this guards against is a
     transposed digit: the write succeeds, the list looks right, and somebody
     you have never heard of can drop codes. */
  const who = await resolveLogin(
    serviceVars.TWITCH_CLIENT_ID || process.env.TWITCH_CLIENT_ID,
    serviceVars.TWITCH_CLIENT_SECRET || process.env.TWITCH_CLIENT_SECRET,
    userId
  );
  if (who && who.login) {
    console.log(`${remove ? 'REMOVE' : 'ADD'}: ${userId} is @${who.login} (${who.displayName})`);
  } else if (who && who.error) {
    console.log(`${remove ? 'REMOVE' : 'ADD'}: ${userId} — could not confirm with Twitch (${who.error})`);
    if (!remove && who.error.includes('no Twitch account')) {
      console.error('[mod] Refusing to add an id that does not exist on Twitch.');
      process.exit(1);
    }
  } else {
    console.log(`${remove ? 'REMOVE' : 'ADD'}: ${userId} — no Twitch credentials available to confirm the name`);
  }

  if (!confirm) {
    console.log('');
    console.log('DRY RUN — nothing written. Re-run with --confirm.');
    await pool.end().catch(() => {});
    return;
  }

  /* Goes through the REAL endpoint rather than writing the row directly, so
     validation, the entry shape and the duplicate handling cannot drift from
     what the site does. The synthetic session carries the broadcaster's id
     because that is the authority this script is exercising — see the header
     for why holding a shell on the rig already exceeds it. */
  const session = { user_id: String(env.TWITCH_BROADCASTER_ID), display_name: 'rig console' };
  const request = new Request('https://phantomace.tv/api/admin/moderators', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify(session)),
    },
    body: JSON.stringify({ action: remove ? 'remove' : 'add', userId, displayName: name }),
  });

  const res = await onRequestPost({ env, request });
  const body = await res.json();

  if (!body.success) {
    console.error(`[mod] FAILED (${res.status}): ${body.error || 'unknown error'}`);
    process.exit(1);
  }
  console.log(body.changed
    ? `Done — ${remove ? 'removed' : 'added'}.`
    : `No change — ${body.note || 'already in that state'}.`);

  await show();
  console.log('Tell the broadcaster who is on this list. It grants code drops,');
  console.log('the giveaway, and bot linking.');

  await pool.end().catch(() => {});
}

main().catch(err => {
  console.error('[mod] FAILED:', err.message);
  process.exit(1);
});
