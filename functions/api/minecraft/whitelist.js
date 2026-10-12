/* ══════════════════════════════════════════════
   /api/minecraft/whitelist — what the game server pulls

   GET ?token=<MINECRAFT_WHITELIST_TOKEN>

   Returns Mojang's own whitelist.json shape — `[{ uuid, name }]` — so the
   file can be written straight to the server directory and reloaded with
   `/whitelist reload`. Nothing to transform on the far end.

   TOKEN-GATED, NOT PUBLIC. The list is every subscriber's Minecraft
   identity next to the implication that they are a PhantomACE subscriber,
   which is not ours to publish. The token lives in server/.env as
   MINECRAFT_WHITELIST_TOKEN.

   WITH NO TOKEN CONFIGURED THE ROUTE REFUSES EVERYONE. An unset secret
   must never mean "open" — that is how a config gap becomes a disclosure.

   ONE DEFINITION OF "WHITELISTED". The grace-period rule is imported from
   the page's own route rather than restated: if the two ever disagreed,
   the site would tell somebody they are on the list while the server kept
   them off it, and the player would have no way to tell who was lying.
   ══════════════════════════════════════════════ */

import { entryOf, GRACE_DAYS } from './index.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Length-independent compare, so a wrong token cannot be found by timing. */
function sameToken(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function onRequestGet(context) {
  const { env, request } = context;

  const expected = env.MINECRAFT_WHITELIST_TOKEN;
  if (!expected) {
    console.error('[minecraft/whitelist] MINECRAFT_WHITELIST_TOKEN is not set - refusing every request');
    return json({ error: 'Not configured' }, 503);
  }

  const url = new URL(request.url);
  /* Header or query. The query is what a scheduled curl on the rig will
     realistically use; the header is there for anything tidier. */
  const given = request.headers.get('X-Whitelist-Token') || url.searchParams.get('token');
  if (!sameToken(given, expected)) return json({ error: 'Not authorised' }, 403);

  let rows;
  try {
    rows = await env.MARKETPLACE.listValues({ prefix: 'profile_' });
  } catch (err) {
    /* REFUSE RATHER THAN RETURN A SHORT LIST. A partial read here would be
       written over whitelist.json and lock out everyone it missed. An error
       leaves the previous file in place, which is the safe failure. */
    console.error('[minecraft/whitelist] profile scan failed:', err.message);
    return json({ error: 'Could not read the roster' }, 503);
  }

  const now = Date.now();
  const seen = new Set();
  const list = [];
  let lapsed = 0;

  for (const row of rows || []) {
    const p = row && (row.value !== undefined ? row.value : row);
    if (!p || typeof p !== 'object') continue;
    const entry = entryOf(p, now);
    if (!entry) continue;
    if (!entry.active) { lapsed++; continue; }
    if (seen.has(entry.uuid)) continue;        // belt and braces; joins already refuse duplicates
    seen.add(entry.uuid);
    list.push({ uuid: entry.uuid, name: entry.name });
  }

  /* Stable order so a diff of the file shows real changes rather than
     whatever order the scan happened to return. */
  list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const wantsMeta = url.searchParams.get('meta') === '1';
  if (wantsMeta) {
    return json({ count: list.length, lapsedExcluded: lapsed, graceDays: GRACE_DAYS, generatedAt: new Date(now).toISOString(), whitelist: list });
  }

  /* The bare array by default — this response IS whitelist.json. */
  return json(list);
}
