#!/usr/bin/env node
/* ══════════════════════════════════════════════
   ONE-TIME YOUTUBE CONSENT — mint a channel's refresh token.

   Run this once PER DESTINATION CHANNEL, with the broadcaster at the keyboard
   for the sign-in step. Everything else is yours.

     node server/clipper/scripts/oauth-youtube.js --name YT_MTG

   --name   the route's credsEnv (decides which env vars are printed)
   --port   loopback port (default 8790; must match the OAuth client's
            registered redirect URI, see below)

   The client id/secret come from the environment as <name>_CLIENT_ID /
   <name>_CLIENT_SECRET, or from --client-id / --client-secret.

   REGISTER THIS REDIRECT URI on the OAuth client in Google Cloud:
       http://127.0.0.1:8790/callback

   WHY IT CONFIRMS THE CHANNEL. The whole point of routing is that MTG clips
   land on the MTG channel. If the broadcaster is signed into the wrong Google
   account, Google happily returns a perfectly valid token for the WRONG
   channel and nothing downstream would ever notice — the clips would just
   silently appear on the wrong one. So after the exchange this calls
   channels?mine=true and prints the channel it actually authorized. Read it
   back to the broadcaster before pasting the token anywhere.

   `prompt=consent` + `access_type=offline` are both required: without them
   Google returns a refresh token only on the user's FIRST ever consent and
   silently omits it on every later run, which looks like a broken script.
   ══════════════════════════════════════════════ */

import { captureCode, openBrowser, printEnvBlock, need, argv } from './_oauth-util.js';

const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

const name = need(argv('--name'), '--name (the route credsEnv, e.g. YT_MTG)');
const port = Number(argv('--port', '8790'));
const redirectUri = `http://127.0.0.1:${port}/callback`;

const clientId = need(argv('--client-id', process.env[`${name}_CLIENT_ID`]),
  `${name}_CLIENT_ID (or --client-id)`);
const clientSecret = need(argv('--client-secret', process.env[`${name}_CLIENT_SECRET`]),
  `${name}_CLIENT_SECRET (or --client-secret)`);

const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
auth.searchParams.set('client_id', clientId);
auth.searchParams.set('redirect_uri', redirectUri);
auth.searchParams.set('response_type', 'code');
auth.searchParams.set('scope', SCOPE);
auth.searchParams.set('access_type', 'offline');
auth.searchParams.set('prompt', 'consent');

console.log(`\n── YouTube consent for "${name}" ──────────────────────────────`);
console.log(`Redirect URI (must be registered on the OAuth client):\n  ${redirectUri}\n`);
console.log('Hand the keyboard to the broadcaster and have them sign in to the');
console.log('channel these clips should post to, then approve.\n');
console.log('If the browser does not open, paste this:\n');
console.log('  ' + auth.toString() + '\n');

openBrowser(auth.toString());

const { code } = await captureCode({ port });
console.log('\n✓ Got the authorization code — exchanging it...');

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code',
  }),
});
const token = await tokenRes.json();
if (!tokenRes.ok || !token.refresh_token) {
  console.error(`\n✗ Token exchange failed (${tokenRes.status}):`);
  console.error(JSON.stringify(token, null, 2));
  if (tokenRes.ok && !token.refresh_token) {
    console.error('\nGoogle returned no refresh_token. Revoke this app under the');
    console.error('channel\'s Google account > Third-party access, then re-run.');
  }
  process.exit(1);
}

/* Which channel did we actually just authorize? */
let channel = '(could not read the channel)';
try {
  const who = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    { headers: { Authorization: `Bearer ${token.access_token}` } });
  const data = await who.json();
  const item = (data.items || [])[0];
  if (item) channel = `${item.snippet.title}  (channel id ${item.id})`;
} catch { /* the token is still good; the label is a convenience */ }

console.log(`\n▸ AUTHORIZED CHANNEL: ${channel}`);
console.log('  ^ confirm this is the right channel BEFORE using the token below.\n');

printEnvBlock(`Set these on the rig for route "${name}"`, [
  `${name}_CLIENT_ID=${clientId}`,
  `${name}_CLIENT_SECRET=${clientSecret}`,
  `${name}_REFRESH_TOKEN=${token.refresh_token}`,
]);

console.log('Then verify with:  node server/clipper/scripts/doctor.js\n');
process.exit(0);
