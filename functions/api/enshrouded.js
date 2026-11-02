/* ══════════════════════════════════════════════
   /api/enshrouded — the subscriber-gated server details

   GET  → server name, address and slots for anyone; the PASSWORD only for a
          logged-in subscriber (or mod/broadcaster).
   POST → broadcaster/moderators set the details.

   WHY THE PASSWORD IS THE WHOLE PERK. Enshrouded has no whitelist — the
   official docs are explicit that "there is no rights management for the
   server other than the password". So unlike the Minecraft page, which added
   a username to a list, there is nothing per-user to grant here: everyone who
   knows the password is in. That makes this endpoint the gate, and it has one
   job it must never get wrong — the password must not appear in a response to
   anyone ineligible, and it is never baked into page markup.

   NO ROTATION, BY DECISION. Changing the password means editing
   enshrouded_server.json on the rig AND updating it here; the two are not
   linked. A leaked password stays valid until that happens.
   ══════════════════════════════════════════════ */

const KEY = 'enshrouded_config';

/* Same roles the Minecraft whitelist treated as subscribers, so one perk tier
   means the same thing across the site. */
const ELIGIBLE = new Set(['sub_tier1', 'sub_tier2', 'sub_tier3', 'moderator', 'broadcaster']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function blank() {
  return { name: '', address: '', password: '', slots: 16, notes: '', updatedAt: 0 };
}

async function readConfig(env) {
  try {
    const cur = await env.MARKETPLACE.get(KEY, 'json');
    return cur && typeof cur === 'object' ? { ...blank(), ...cur } : blank();
  } catch { return blank(); }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const cfg = await readConfig(env);
  const session = getSession(request);
  const loggedIn = !!(session && session.user_id);
  const role = (session && session.role) || 'visitor';
  const eligible = loggedIn && ELIGIBLE.has(role);

  /* The address is not a secret — the server shows up in Enshrouded's own
     browser by name either way. The password is the gate. */
  const body = {
    loggedIn,
    role,
    eligible,
    configured: !!(cfg.address && cfg.password),
    server: { name: cfg.name, address: cfg.address, slots: cfg.slots, notes: cfg.notes },
  };
  /* The ONE place the password is allowed out. */
  if (eligible && cfg.password) body.password = cfg.password;

  return json(body);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  /* Checked against the allowlist rather than the cookie's role, so removing
     somebody takes effect immediately instead of when their session expires. */
  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const slots = Math.max(1, Math.min(16, Math.floor(Number(body.slots) || 16)));
  const next = {
    name: String(body.name || '').trim().slice(0, 80),
    address: String(body.address || '').trim().slice(0, 200),
    password: String(body.password || '').trim().slice(0, 200),
    slots,
    notes: String(body.notes || '').trim().slice(0, 500),
    updatedAt: Date.now(),
  };
  await env.MARKETPLACE.put(KEY, JSON.stringify(next));

  /* Echo everything EXCEPT the password, so a saved form never re-renders the
     secret into a response that might be logged. */
  return json({ success: true, server: { name: next.name, address: next.address, slots: next.slots, notes: next.notes } });
}

export { ELIGIBLE as ENSHROUDED_ELIGIBLE_ROLES, KEY as ENSHROUDED_KEY };
