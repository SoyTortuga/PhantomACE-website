/* ══════════════════════════════════════════════
   FORUM — @mentions

   Parsed out of a body AT POST TIME, never at render: that is what makes
   "every mention of me" an index range on forum_mentions rather than a
   scan of every post ever written. The two halves:

     parseMentions(body)          → the distinct logins named, lowercased
     resolveMentions(env, logins) → the people those logins are, today

   Resolution goes through loginidx_<login>, verified against the profile
   record the way /api/profile does — a login that was changed and taken
   by somebody else must resolve to nobody, not to the wrong person. Only
   people who have logged in since migration 005 have a record and can
   be resolved; a name that matches nobody is left as text.

   Opting out (mentionsEnabled: false on the profile record) means the
   name stops resolving and notifying. The text stays.

   Library, not a route: declared in NON_ROUTE_MODULES.
   ══════════════════════════════════════════════ */

/* Twitch logins are letters, digits and underscore; legacy accounts can
   be 3 characters, current ones 4–25. A preceding word character means
   it is not a mention (foo@example.com); a preceding slash or dot means
   it is inside a URL (x.tv/@handle). */
const MENTION = /(^|[^A-Za-z0-9_\/.])@([A-Za-z0-9_]{3,25})(?![A-Za-z0-9_])/g;
const MAX_MENTIONS = 20;

export function parseMentions(body) {
  const out = [];
  const seen = new Set();
  for (const m of String(body == null ? '' : body).matchAll(MENTION)) {
    const login = m[2].toLowerCase();
    if (seen.has(login)) continue;
    seen.add(login);
    out.push(login);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

/** [{ login, userId }] for every login that resolves to somebody who has
    not opted out. Order preserved; unresolved names are simply absent. */
export async function resolveMentions(env, logins) {
  const out = [];
  for (const login of logins || []) {
    let id;
    try { id = await env.MARKETPLACE.get(`loginidx_${login}`); } catch { continue; }
    if (!id) continue;
    let profile;
    try { profile = await env.MARKETPLACE.get(`profile_${id}`, 'json'); } catch { continue; }
    if (!profile) continue;
    /* THE STALE-LOGIN CHECK, same as /api/profile. */
    if (String(profile.login || '').toLowerCase() !== login) continue;
    if (profile.mentionsEnabled === false) continue;
    out.push({ login, userId: String(id) });
  }
  return out;
}
