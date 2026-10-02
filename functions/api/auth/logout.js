import { safeReturnPath } from './session-crypto.js';

const COOKIE_NAME = 'pham_session';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  /* Validated: an unchecked return_to here was an open redirect
     (/api/auth/logout?return_to=//evil.com). See safeReturnPath. */
  const returnTo = safeReturnPath(url.searchParams.get('return_to') || '/');
  const isSecure = url.protocol === 'https:';
  const flags = [
    `Path=/`,
    `Max-Age=0`,
    `SameSite=Lax`,
  ];
  if (isSecure) flags.push('Secure');

  return new Response(null, {
    status: 302,
    headers: {
      'Location': new URL(returnTo, url.origin).toString(),
      'Set-Cookie': `${COOKIE_NAME}=; ${flags.join('; ')}`,
    },
  });
}
