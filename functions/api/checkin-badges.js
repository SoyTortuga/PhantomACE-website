/* ══════════════════════════════════════════════
   EVENT BADGES ON CHECK-IN

   Library, not a route — declared in server/router.js NON_ROUTE_MODULES.

   A badge that can only be EARNED inside a window, and is kept for ever
   once earned. Not a badge that expires: nothing in an inventory has ever
   expired, and a badge that vanished off a profile and out of every forum
   post it had been shown on would be a much larger change than this one.

   WHY THE WINDOW IS UTC IN THE SOURCE AND PACIFIC IN THE COMMENT.
   A window written as "12:00 Pacific" has to be resolved against a
   timezone database at the moment a redemption arrives, on a server whose
   own clock is whatever Windows says. Written as an absolute instant it is
   the same moment everywhere and cannot drift. The Pacific times are in the
   comments because that is the form the broadcaster announces them in, and
   the two must be checked against each other by eye when a window is added.

   ON PDT vs PST. September is DAYLIGHT time on the US west coast — UTC−7,
   not UTC−8. The instants below are PDT, which is what a clock in Oregon
   actually reads on those dates. If a window is ever genuinely meant as
   UTC−8, add an hour to both ends and say so here.
   ══════════════════════════════════════════════ */

/* One entry per event. Left in place after it closes rather than deleted:
   the record of what was offered and when is the only way to answer "why
   does this person have that badge", and a closed window grants nothing. */
export const CHECKIN_BADGES = [
  {
    key: 'agate-hunt-2026-09',
    /* Matches server/scripts/mint-badge-code.js exactly. The same badge is
       claimable by code, so the two must produce ONE item — same id, same
       type, same artwork — or somebody who does both ends up holding two
       Agate Hunts. */
    id: 'agate-hunt',
    game: 'profile',
    type: 'badge',
    name: 'Agate Hunt',
    rarity: 'rare',
    image: '/assets/badges/agate-hunt.png',

    /* 2026-09-17 10:00 PDT → 2026-09-18 17:00 PDT.
       Opened two hours earlier than first planned, because the stream did. */
    from: Date.UTC(2026, 8, 17, 17, 0, 0),
    to: Date.UTC(2026, 8, 19, 0, 0, 0),
  },
];

/** Every badge whose window is open at `at`. */
export function badgesOpenAt(at = Date.now()) {
  const t = Number(at);
  /* Half-open: a badge is earned AT the opening instant and not at the
     closing one, so two adjacent windows can never both pay out. */
  return CHECKIN_BADGES.filter(b => t >= b.from && t < b.to);
}

/**
 * Add any open event badges to an inventory, in place.
 *
 * IDENTITY IS TYPE PLUS ID, not id alone. The site has two different things
 * called 'void' — a skull skin and a click effect — and deduping on id
 * alone once swallowed the second grant silently. It is also why holding
 * this badge from a redeemed code correctly blocks a second copy here.
 *
 * @returns {Array} the badges actually granted, empty if none
 */
export function grantOpenBadges(inv, at = Date.now(), source = 'pham-checkin') {
  const open = badgesOpenAt(at);
  if (!open.length) return [];

  const items = Array.isArray(inv.items) ? inv.items : (inv.items = []);
  const granted = [];

  for (const b of open) {
    if (items.some(i => i && i.id === b.id && i.type === b.type)) continue;
    items.push({
      id: b.id,
      game: b.game,
      type: b.type,
      name: b.name,
      rarity: b.rarity,
      consumable: false,
      quantity: 1,
      grantedAt: Date.now(),
      source,
      ...(b.image ? { meta: { image: b.image } } : {}),
    });
    granted.push(b);
  }

  return granted;
}
