/* ══════════════════════════════════════════════
   BOT TRIGGER
   Broadcaster-only control panel endpoint.
   Fires the same actions as chat commands
   (see commands.js) without needing to type in chat.
   ══════════════════════════════════════════════ */

import { dropCodeAction, dropItemAction, dropEggAction, announceAction, getBotActionLog } from './send-chat.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* ── GET — recent action log for the control panel ── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  /* Moderators may drop codes. Checked against the allowlist rather than
     the cookie's role field, so removing someone takes effect immediately
     instead of when their session happens to expire. */
  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  const log = await getBotActionLog(env);
  return json({ log });
}

/* ── POST — fire a drop or announcement ────────── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  /* Moderators may drop codes. Checked against the allowlist rather than
     the cookie's role field, so removing someone takes effect immediately
     instead of when their session happens to expire. */
  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const actor = session.display_name || 'broadcaster';

  if (body.action === 'drop') {
    const result = await dropCodeAction(env, body.rarity, actor);
    return json(result, result.success ? 200 : 400);
  }

  if (body.action === 'dropitem') {
    const result = await dropItemAction(env, body.code || null, actor);
    return json(result, result.success ? 200 : 400);
  }

  if (body.action === 'dropegg') {
    const result = await dropEggAction(env, body.rarity, actor, { mutation: !!body.mutation });
    return json(result, result.success ? 200 : 400);
  }

  if (body.action === 'announce') {
    const result = await announceAction(env, body.message, actor);
    return json(result, result.success ? 200 : 400);
  }

  return json({ error: 'Invalid action' }, 400);
}
