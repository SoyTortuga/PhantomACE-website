/* ══════════════════════════════════════════════
   MODERATOR ALLOWLIST

   A broadcaster-managed list of accounts trusted to run code drops and the
   giveaway from the bot control panel. Deliberately NOT "everyone with a
   Twitch mod badge": the owner wanted an admin tier, a chosen few, and a
   manual list expresses that exactly — with no extra Twitch scope and no
   re-authorisation to add or remove someone.

   HOW AUTHORISATION WORKS, AND WHY IT IS NOT THE ROLE FIELD

   The session cookie carries `role`, and until today that was forgeable —
   anyone could type broadcaster into their own cookie. It is signed now, so
   `user_id` can be trusted. But the role field is still the WRONG thing to
   authorise on, for a different reason: it is a snapshot from login. Remove
   somebody from this list and their existing session would keep its
   moderator role until it expired.

   So isModerator() reads the list on every call. The role field exists only
   so the UI can decide what to render. The server never trusts it.

   Deliberately NOT extended to /api/admin/bot-setup. That runs the OAuth
   flows and creates channel point rewards on the broadcaster's own channel;
   "can drop a code in chat" and "can re-authorise the bot" are different
   levels of trust and should stay that way.
   ══════════════════════════════════════════════ */

const LIST_KEY = 'site_moderators';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/** @returns {Promise<{userIds: string[], entries: object[]}>} */
export async function getModerators(env) {
  const rec = await env.MARKETPLACE.get(LIST_KEY, 'json');
  const entries = Array.isArray(rec && rec.entries) ? rec.entries : [];
  return { userIds: entries.map(e => String(e.userId)), entries };
}

/**
 * The authorisation check every privileged bot endpoint uses.
 *
 * Read fresh each time on purpose — see the header. The broadcaster always
 * passes without being on the list, since requiring them to add themselves
 * would be a trap waiting for the day somebody empties the list.
 */
export async function isModerator(env, session) {
  if (!session || !session.user_id) return false;
  if (isBroadcaster(env, session)) return true;
  const { userIds } = await getModerators(env);
  return userIds.includes(String(session.user_id));
}

/**
 * Identity, not a claim.
 *
 * Compares the session's user id against TWITCH_BROADCASTER_ID rather than
 * trusting session.role === 'broadcaster'. The cookie is signed now, so the
 * role field cannot be forged — but authorisation resting on "the cookie
 * says so" is what made the unsigned cookie a total compromise, and there is
 * no reason to keep the pattern when a fixed id is right there. If signing
 * ever regresses, this does not.
 */
export function isBroadcaster(env, session) {
  const id = env && env.TWITCH_BROADCASTER_ID;
  if (!id || !session || !session.user_id) return false;
  return String(session.user_id) === String(id);
}

/** Broadcaster only — managing who has power is not itself delegated. */
function requireBroadcaster(env, session) {
  return isBroadcaster(env, session);
}

/* ── GET — who is on the list ─────────────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);

  /* A moderator may SEE the list — knowing who else can drop codes is
     useful and not sensitive — but only the broadcaster may change it. */
  if (!(await isModerator(env, session))) {
    return json({ error: 'Not authorized' }, 403);
  }

  const { entries } = await getModerators(env);
  return json({
    moderators: entries,
    canEdit: requireBroadcaster(env, session),
    you: { userId: session.user_id, role: session.role },
  });
}

/* ── POST — add or remove ─────────────────────── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  if (!requireBroadcaster(env, session)) {
    return json({ error: 'Broadcaster only' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const action = body && body.action;
  const userId = body && body.userId ? String(body.userId).trim() : '';

  if (action !== 'add' && action !== 'remove') {
    return json({ error: 'action must be add or remove' }, 400);
  }
  if (!/^\d+$/.test(userId)) {
    /* Twitch user ids are numeric. Taking a display name here would be
       friendlier and wrong: names change hands, ids do not, and an
       authorisation list keyed on something renameable is a way to hand
       somebody else's privileges to whoever claims the name next. */
    return json({ error: 'userId must be a numeric Twitch user ID' }, 400);
  }
  if (action === 'add' && userId === String(session.user_id)) {
    return json({ error: 'You are the broadcaster — you already have access.' }, 400);
  }

  let result = null;

  await env.MARKETPLACE.mutate(LIST_KEY, (current) => {
    const entries = Array.isArray(current && current.entries) ? [...current.entries] : [];
    const idx = entries.findIndex(e => String(e.userId) === userId);

    if (action === 'add') {
      if (idx !== -1) { result = { changed: false, reason: 'already on the list' }; return undefined; }
      entries.push({
        userId,
        displayName: (body.displayName || '').slice(0, 40),
        addedAt: Date.now(),
        addedBy: session.display_name || 'broadcaster',
      });
      result = { changed: true };
    } else {
      if (idx === -1) { result = { changed: false, reason: 'not on the list' }; return undefined; }
      entries.splice(idx, 1);
      result = { changed: true };
    }

    return { entries, updatedAt: Date.now() };
  });

  const { entries } = await getModerators(env);
  return json({
    success: true,
    changed: !!(result && result.changed),
    note: result && result.reason ? result.reason : undefined,
    moderators: entries,
  });
}
