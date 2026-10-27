#!/usr/bin/env node
/* ══════════════════════════════════════════════
   ONE-TIME YOUTUBE CONSENT — mint a channel's refresh token.

   Run this once PER DESTINATION CHANNEL, with the broadcaster at the keyboard
   for the sign-in step. Everything else is yours.

     node server/clipper/scripts/oauth-youtube.js --name YT_MTG

   --name       the route's credsEnv (decides which env vars are printed)
   --port       loopback port (default 8790; must match the OAuth client's
                registered redirect URI, see below)

   WITHOUT A CALL. The broadcaster has to click Allow themselves, but they do
   not have to be sitting next to you. Split it in two:

     node ... oauth-youtube.js --name YT_MTG --print-url
         prints the consent URL and exits. Send that to the broadcaster.
     node ... oauth-youtube.js --name YT_MTG --code "<what they send back>"
         exchanges it. Accepts the whole redirected address or a bare code.

   Their browser will fail to load 127.0.0.1 (nothing is listening on THEIR
   machine) — that is expected and harmless. The address bar still carries
   ?code=..., which is the only part that matters.

   THE CODE EXPIRES IN MINUTES and is single use, so they need to send it
   promptly rather than the next day. If it lapses, just issue a new URL.

   --manual     print the URL and wait here for the pasted address, for when
                you are both online but not screen-sharing

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

import { captureCode, openBrowser, printEnvBlock, need, argv, ask, codeFromPaste } from './_oauth-util.js';

const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

const name = need(argv('--name'), '--name (the route credsEnv, e.g. YT_MTG)');
const printUrlOnly = process.argv.includes('--print-url');
const manual = process.argv.includes('--manual');
const suppliedCode = argv('--code');
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

/* --print-url: hand the URL over and stop. Nothing is listening, nothing is
   waiting; the exchange happens later with --code. */
if (printUrlOnly) {
  console.log(`\n── Send this to the broadcaster for "${name}" ─────────────────\n`);
  console.log(auth.toString());
  console.log(`\nThey sign in to the channel these clips post to, approve, then copy`);
  console.log(`the address their browser lands on (it will look like a connection`);
  console.log(`error — that is fine) and send it back. Then run:\n`);
  console.log(`  node server/clipper/scripts/oauth-youtube.js --name ${name} --code "<that address>"\n`);
  console.log(`The code expires within minutes, so exchange it promptly.\n`);
  process.exit(0);
}

let code;
if (suppliedCode) {
  code = codeFromPaste(suppliedCode);
  if (!code) { console.error('\n✗ No ?code= found in that. Pass the full redirected address or the bare code.\n'); process.exit(1); }
  console.log(`\n── Exchanging the code for "${name}" ─────────────────────────`);
} else {
  console.log(`\n── YouTube consent for "${name}" ──────────────────────────────`);
  console.log(`Redirect URI (must be registered on the OAuth client):\n  ${redirectUri}\n`);
  console.log('Have the broadcaster sign in to the channel these clips should');
  console.log('post to, then approve.\n');
  console.log('If the browser does not open, paste this:\n');
  console.log('  ' + auth.toString() + '\n');

  if (manual) {
    code = codeFromPaste(await ask('Paste the address they were redirected to (or just the code): '));
    if (!code) { console.error('\n✗ No ?code= found in that.\n'); process.exit(1); }
  } else {
    openBrowser(auth.toString());
    ({ code } = await captureCode({ port }));
  }
}
console.log('\n✓ Got the authorization code — exchanging it...');

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code: decodeURIComponent(code), client_id: clientId, client_secret: clientSecret,
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
