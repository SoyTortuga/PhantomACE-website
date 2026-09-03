const COOKIE_NAME = 'pham_session';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const returnTo = url.searchParams.get('return_to') || '/';
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
      'Location': returnTo,
      'Set-Cookie': `${COOKIE_NAME}=; ${flags.join('; ')}`,
    },
  });
}
