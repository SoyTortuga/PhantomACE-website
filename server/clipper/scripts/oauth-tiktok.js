#!/usr/bin/env node
/* ══════════════════════════════════════════════
   ONE-TIME TIKTOK CONSENT — mint an account's refresh token.

   Run once PER POSTING ACCOUNT, broadcaster at the keyboard for the sign-in.

     node server/clipper/scripts/oauth-tiktok.js --name TT_MTG
     node server/clipper/scripts/oauth-tiktok.js --name TT_MTG --redirect https://phantomace.tv/tiktok/callback --manual

   --name      the route's credsEnv
   --redirect  the redirect URI REGISTERED ON THE TIKTOK APP
               (default http://127.0.0.1:8791/callback)
   --manual    don't run a loopback server; print the URL and wait for the
               redirected address to be pasted back

   TIKTOK IS FUSSIER THAN GOOGLE ABOUT REDIRECTS. Many TikTok apps are only
   allowed to register an https:// callback, in which case a loopback listener
   can never receive the redirect. That is what --manual is for: the browser
   lands on your real (possibly 404) https URL, and you copy the address bar
   back here. The code in the query string is all that is needed, so a 404 page
   is perfectly fine.

   IT ALSO REPORTS THE AUDIT GATE. After the exchange this queries
   creator_info and prints the privacy levels the account is actually allowed.
   If the only option is SELF_ONLY, the app has not passed audit yet and every
   post will be a private draft — which is expected, and is exactly what the
   route's "privacy" setting should stay at until approval lands.
   ══════════════════════════════════════════════ */

import { captureCode, openBrowser, printEnvBlock, need, argv, ask, codeFromPaste } from './_oauth-util.js';

const SCOPE = 'user.info.basic,video.publish,video.upload';

const name = need(argv('--name'), '--name (the route credsEnv, e.g. TT_MTG)');
const manual = process.argv.includes('--manual');
const port = Number(argv('--port', '8791'));
const redirectUri = argv('--redirect', `http://127.0.0.1:${port}/callback`);

const clientKey = need(argv('--client-key', process.env[`${name}_CLIENT_KEY`]),
  `${name}_CLIENT_KEY (or --client-key)`);
const clientSecret = need(argv('--client-secret', process.env[`${name}_CLIENT_SECRET`]),
  `${name}_CLIENT_SECRET (or --client-secret)`);

const state = Math.random().toString(36).slice(2);
const auth = new URL('https://www.tiktok.com/v2/auth/authorize/');
auth.searchParams.set('client_key', clientKey);
auth.searchParams.set('scope', SCOPE);
auth.searchParams.set('response_type', 'code');
auth.searchParams.set('redirect_uri', redirectUri);
auth.searchParams.set('state', state);

console.log(`\n── TikTok consent for "${name}" ───────────────────────────────`);
console.log(`Redirect URI (must be registered on the TikTok app):\n  ${redirectUri}\n`);
console.log('Hand the keyboard to the broadcaster and have them sign in to the');
console.log('account these clips should post to, then approve.\n');
console.log('If the browser does not open, paste this:\n');
console.log('  ' + auth.toString() + '\n');

openBrowser(auth.toString());

let code;
if (manual) {
  const pasted = await ask('Paste the full address you were redirected to (or just the code): ');
  code = codeFromPaste(pasted);
  if (!code) { console.error('\n✗ No ?code= found in that.\n'); process.exit(1); }
} else {
  ({ code } = await captureCode({ port }));
}
console.log('\n✓ Got the authorization code — exchanging it...');

const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_key: clientKey, client_secret: clientSecret,
    /* TikTok hands back a code that is percent-encoded in the address bar
       (it ends in something like *1!); decode before sending it back. */
    code: decodeURIComponent(code),
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }),
});
const token = await tokenRes.json();
if (!tokenRes.ok || !token.refresh_token) {
  console.error(`\n✗ Token exchange failed (${tokenRes.status}):`);
  console.error(JSON.stringify(token, null, 2));
  process.exit(1);
}

/* Who did we authorize, and is the app audited yet? */
let levels = null;
try {
  const info = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
  });
  const data = await info.json();
  if (data.data) {
    levels = data.data.privacy_level_options || [];
    console.log(`\n▸ AUTHORIZED ACCOUNT: ${data.data.creator_nickname || '(name unavailable)'}`);
  }
} catch { /* the token is still good */ }

if (levels) {
  console.log(`▸ ALLOWED PRIVACY LEVELS: ${levels.join(', ') || '(none reported)'}`);
  if (levels.length === 1 && levels[0] === 'SELF_ONLY') {
    console.log('  → App is NOT audited yet. Posts arrive as private drafts.');
    console.log('    Keep this route\'s tiktok.privacy at "SELF_ONLY" for now.');
  } else {
    console.log('  → Audited. You may set this route\'s tiktok.privacy to');
    console.log('    "PUBLIC_TO_EVERYONE" in config.json.');
  }
}

printEnvBlock(`Set these on the rig for route "${name}"`, [
  `${name}_CLIENT_KEY=${clientKey}`,
  `${name}_CLIENT_SECRET=${clientSecret}`,
  `${name}_REFRESH_TOKEN=${token.refresh_token}`,
]);

console.log('Then verify with:  node server/clipper/scripts/doctor.js\n');
process.exit(0);
