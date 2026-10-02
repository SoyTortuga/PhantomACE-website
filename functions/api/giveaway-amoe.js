/* ══════════════════════════════════════════════
   FREE ALTERNATE METHOD OF ENTRY (AMOE)

   POST /api/giveaway-amoe — grant the logged-in viewer their one free entry
   for the current month. No purchase, subscription, or watch time required;
   this is the sweepstakes' no-strings path to enter. The whole check-and-grant
   is one locked mutate() in claimFreeEntry (giveaway-entries.js), so it is
   exactly one entry per account per month however fast the button is tapped.

   Auto-routed by the file-based router (it exports onRequestPost) — do NOT add
   it to NON_ROUTE_MODULES, and it needs no registry change: it reuses the
   gwe_ ledger family.
   ══════════════════════════════════════════════ */

import { claimFreeEntry, monthKey } from './giveaway-entries.js';

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

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  /* Login is required so the free entry belongs to an account the draw can
     actually pay — the same rule the code-redeem endpoint uses. It is still
     free: signing in with Twitch costs nothing. */
  if (!session || !session.user_id) {
    return json({ error: 'Log in with Twitch to claim your free entry.' }, 401);
  }

  const result = await claimFreeEntry(env, session.user_id, session.display_name);

  if (!result.ok) {
    return json({ error: 'You already claimed your free entry this month.', total: result.total, month: monthKey() }, 409);
  }

  return json({ success: true, total: result.total, month: monthKey() });
}
