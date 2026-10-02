/* ══════════════════════════════════════════════
   COMMANDER BINGO SQUARES — the server's copy of the square list.

     GET /api/bingo/squares  ->  { squares: [{ id, text }], total }

   The client list (games/commander-bingo/events.js) is a plain browser
   script, so the server cannot import it. This is the server's canonical
   copy, used wherever a square's text must be trusted: call.js builds the
   overlay alert label from it instead of from the request body, which used
   to let any host put up to 120 characters of their own text on stream.
   test-commander-bingo-overlay.js fails if the two lists ever drift.

   Exposed as a GET route (rather than a handler-less library) so it needs
   no NON_ROUTE_MODULES entry in server/router.js; the data is public.
   ══════════════════════════════════════════════ */

const SQUARES = [
  [1, "Board wipe played"],
  [2, "Counterspell cast"],
  [3, "Someone tutors"],
  [4, "Commander removed"],
  [5, "Mana screwed, stuck on 3 lands"],
  [6, "Nobody attacks for 3+ turns"],
  [7, "Land destruction"],
  [8, "Planeswalker enters play"],
  [9, "Artifact destroyed"],
  [10, "Enchantment destroyed"],
  [11, "5+ cards drawn in a turn"],
  [12, "Sol Ring on turn 1"],
  [13, "Graveyard recursion"],
  [14, "Extra turn taken"],
  [15, "Someone announces one of their turn phases"],
  [16, "Someone double-checks a card's wording"],
  [17, "Chaos effect resolves"],
  [18, "Lethal commander damage"],
  [19, "Precon 'bomb' rare finally connects"],
  [20, "Player only plays a land on their turn before passing"],
  [21, "Power 10+ creature enters"],
  [22, "Turn takes forever (analysis paralysis)"],
  [23, "Treasure tokens created"],
  [24, "X spell for 10+"],
  [25, "10+ tokens on board"],
  [26, "10+ life gained in a turn"],
  [27, "Player eliminated"],
  [28, "Card played from exile"],
  [29, "3+ permanents sacrificed"],
  [30, "Equipment on commander"],
  [31, "Turn 1 mana dork"],
  [32, "Cascade triggers"],
  [33, "Player controls 5+ creatures of the same creature type"],
  [34, "A precon commander finally gets to attack"],
  [35, "Commander cast 3+ times"],
  [36, "Apologizes for their deck doing its thing"],
  [37, "Alliance formed"],
  [38, "Alliance broken"],
  [39, "Rules debate erupts"],
  [40, "A 15-minute-long turn"],
  [41, "Shitty infinite-token drawing"],
  [42, "Beautiful infinite-token drawing"],
  [43, "Card read aloud"],
  [44, "Threat assessment debate"],
  [45, "Kingmaker moment"],
  [46, "Deal offered"],
  [47, "Deal broken"],
  [48, "Bluffs having interaction"],
  [49, "Comment made about accessories (playmat, sleeves, box)"],
  [50, "Archenemy declared"],
  [51, "Someone scoops early"],
  [52, "Table groans at a play"],
  [53, "Trigger forgotten"],
  [54, "Someone begs for mercy"],
  [55, "Graveyard checked"],
  [56, "Phone check mid-game"],
  [57, "Someone says Chud's catchphrase"],
  [58, "Downplays themselves as the threat"],
  [59, "Awkward silence"],
  [60, "Someone asks another player to deal with a third player's card"],
  [61, "Salt moment"],
  [62, "Previous game story told"],
  [63, "Wordplay used to describe a game action"],
  [64, "Dice rolled for effect"],
  [65, "Someone interrupts another player's end step"],
  [66, "Player gets political"],
  [67, "Premature celebration"],
  [68, "Topdeck saves a player"],
];

export const BINGO_SQUARES = SQUARES.map(([id, text]) => Object.freeze({ id, text }));
export const TOTAL_EVENTS = BINGO_SQUARES.length;

const BY_ID = new Map(BINGO_SQUARES.map(s => [s.id, s.text]));

/** The canonical text of square `id`, or null for an id that is not a square. */
export function squareText(id) {
  return BY_ID.has(id) ? BY_ID.get(id) : null;
}

export async function onRequestGet() {
  return new Response(JSON.stringify({ squares: BINGO_SQUARES, total: TOTAL_EVENTS }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
}
