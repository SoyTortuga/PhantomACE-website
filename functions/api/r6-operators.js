/* ══════════════════════════════════════════════
   RAINBOW SIX SIEGE — THE OPERATOR ROSTER.

   A plain data file, deliberately. Ubisoft publishes no official developer
   API, every third-party wrapper is reverse-engineered and needs real Ubisoft
   credentials, and Tracker Network states it has no R6 API and no plans for
   one. Hanging a live stream feature on a scraped endpoint that can break
   mid-season — or get an account flagged — is not worth it for a list that
   changes four times a year.

   SO THIS IS THE ONE THING TO MAINTAIN. A new season adds an operator; add the
   codename to the right list and nothing else changes. Everything downstream
   reads from here.

   WHY VALIDATED AT ALL. The draft is binding — chat picks and he plays it — so
   a vote has to resolve to something playable. Validating against only the
   ACTIVE side's pool also kills every wrong-side vote for free: during a
   defence draft, "Thatcher" is not a near-miss to be fuzzy-matched, it is
   simply not a candidate.

   Codenames only, as they appear in game. Accents are kept (Jäger, Capitão) —
   matching strips them, so chat never has to type one.
   ══════════════════════════════════════════════ */

/* ── PASTE THE ROSTER HERE ────────────────────────────────────────────────
   Empty until the real lists land. The draft reports itself as unconfigured
   rather than silently accepting nothing, and the dashboard button says so —
   a draft that opens and rejects every vote is the worst way to find out. */
export const ATTACKERS = [];

export const DEFENDERS = [];

/** The two sides a draft can run for. */
export const SIDES = ['attack', 'defence'];

/** The pool for a side, or an empty list for anything else. */
export function rosterFor(side) {
  if (side === 'attack') return ATTACKERS;
  if (side === 'defence') return DEFENDERS;
  return [];
}

/** Is there a roster to draft from at all? Surfaced, never assumed. */
export function rosterReady() {
  return ATTACKERS.length > 0 && DEFENDERS.length > 0;
}

/* Accents, punctuation, case and spacing all discarded: chat types into a
   chat box at speed and should never need to produce "ä" or "ã". */
export function normalise(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve what someone typed to a codename on that side.
 * Exact normalised hit wins outright; otherwise a unique prefix. An ambiguous
 * prefix resolves to nothing rather than picking the first — a vote must never
 * land on an operator the voter did not name.
 */
export function matchOperator(side, typed) {
  const pool = rosterFor(side);
  const q = normalise(typed);
  if (!q || q.length < 2) return null;
  let prefix = null, prefixCount = 0;
  for (const name of pool) {
    const n = normalise(name);
    if (n === q) return name;
    if (n.startsWith(q)) { prefix = name; prefixCount++; }
  }
  return prefixCount === 1 ? prefix : null;
}
