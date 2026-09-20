/* ══════════════════════════════════════════════
   MTGBBB SCORING

   Pure functions. No I/O, no session, no room — give it a card and a list
   of pulls and it tells you what that card is worth. Everything else in
   MTGBBB is measured against this, which is why it lives on its own and is
   covered by server/scripts/test-mtgbbb.js.

   THE RULES, EXACTLY (docs/MTGBBB-PLAN.md is the signed-off version):

     Mark         1  — the card came out of a pack. Once, however many
                       times it is pulled.
     Treatment    1  — each special treatment, EVERY time it is pulled.
                       A plain copy then a borderless foil copy is one mark
                       and two treatment points.
     Bingo        5  — per completed pattern, cumulative. Thirteen of them.
     Blackout    25  — all twenty-five squares marked.

   THERE IS NO FREE CENTRE SQUARE. That is deliberate, and it is why the
   corners-and-centre pattern is a real five-square pattern rather than the
   four-square one it would be on a traditional card.

   A perfect card is 25 + 65 + 25 = 115 before treatments.
   ══════════════════════════════════════════════ */

export const GRID = 5;
export const SQUARES = GRID * GRID;

export const POINTS = {
  mark: 1,
  treatment: 1,
  bingo: 5,
  blackout: 25,
};

/* ── The thirteen patterns ───────────────────────────────────────────────
   Five rows, five columns, two diagonals, and the four corners with the
   centre. That last one deliberately overlaps both diagonals: patterns
   score cumulatively, so a card completing it alongside a diagonal is paid
   for both. It is a bonus pattern, not a partition of the grid. */
function buildPatterns() {
  const out = [];

  for (let r = 0; r < GRID; r++) {
    const cells = [];
    for (let c = 0; c < GRID; c++) cells.push(r * GRID + c);
    out.push({ id: 'row' + r, kind: 'row', label: 'Row ' + (r + 1), cells });
  }

  for (let c = 0; c < GRID; c++) {
    const cells = [];
    for (let r = 0; r < GRID; r++) cells.push(r * GRID + c);
    out.push({ id: 'col' + c, kind: 'column', label: 'Column ' + (c + 1), cells });
  }

  const down = [], up = [];
  for (let i = 0; i < GRID; i++) {
    down.push(i * GRID + i);
    up.push(i * GRID + (GRID - 1 - i));
  }
  out.push({ id: 'diag', kind: 'diagonal', label: 'Diagonal', cells: down });
  out.push({ id: 'diagx', kind: 'diagonal', label: 'Diagonal', cells: up });

  const last = GRID - 1;
  out.push({
    id: 'corners', kind: 'corners', label: 'Corners & Centre',
    cells: [0, last, (GRID * GRID - 1) / 2, last * GRID, GRID * GRID - 1],
  });

  return out;
}

export const PATTERNS = buildPatterns();

/** The most a card can score before treatments: every square, every pattern. */
export const MAX_BASE_SCORE =
  SQUARES * POINTS.mark + PATTERNS.length * POINTS.bingo + POINTS.blackout;

/* ── Pulls ───────────────────────────────────────────────────────────── */

/**
 * How many treatment points one pull is worth.
 *
 * Deduplicated within the pull: a moderator working at the pace of a live
 * box will occasionally tick the same chip twice, and that must not pay
 * twice. Across separate pulls the same treatment DOES score again — that
 * is the rule, not an oversight.
 */
export function countTreatments(pull) {
  if (!pull || !Array.isArray(pull.treatments)) return 0;
  const seen = new Set();
  for (const t of pull.treatments) {
    if (typeof t === 'string' && t) seen.add(t);
  }
  return seen.size;
}

/* ── Scoring one card ────────────────────────────────────────────────── */

/**
 * Score a card against the pulls so far.
 *
 * @param {string[]} card   25 card ids, row-major
 * @param {Array} pulls     [{ card: id, treatments: string[] }]
 * @returns {{
 *   marked: boolean[], marks: number, treatments: number,
 *   lines: object[], blackout: boolean, points: number,
 *   breakdown: { marks: number, treatments: number, bingo: number, blackout: number }
 * }}
 */
/**
 * `wilds` is the wildcard stamps for THIS card: square indices (0-24)
 * marked by a spent item rather than a pull. They participate in lines
 * and blackout exactly like pulled marks -- a stamp that did not count
 * toward a bingo would be the old client-side bug wearing a new coat --
 * but they mint no treatment points, because treatments describe the
 * cardboard the broadcaster actually opened.
 */
export function scoreCard(card, pulls, wilds) {
  const marked = new Array(SQUARES).fill(false);

  /* Where each id sits on this card. A card holds distinct ids by
     construction, but building the lookup with "first wins" means a
     malformed card scores one square rather than throwing mid-game. */
  const at = new Map();
  for (let i = 0; i < SQUARES; i++) {
    const id = card && card[i];
    if (id !== undefined && id !== null && !at.has(id)) at.set(id, i);
  }

  for (const i of wilds || []) {
    if (Number.isInteger(i) && i >= 0 && i < SQUARES) marked[i] = true;
  }

  let treatments = 0;

  for (const pull of pulls || []) {
    if (!pull) continue;
    const i = at.get(pull.card);
    if (i === undefined) continue;     // pulled, but not on this card
    marked[i] = true;
    treatments += countTreatments(pull);
  }

  const lines = PATTERNS.filter(p => p.cells.every(c => marked[c]));

  let marks = 0;
  for (const m of marked) if (m) marks++;
  const blackout = marks === SQUARES;

  const breakdown = {
    marks: marks * POINTS.mark,
    treatments: treatments * POINTS.treatment,
    bingo: lines.length * POINTS.bingo,
    blackout: blackout ? POINTS.blackout : 0,
  };

  return {
    marked, marks, treatments, lines, blackout,
    breakdown,
    points: breakdown.marks + breakdown.treatments + breakdown.bingo + breakdown.blackout,
  };
}

/**
 * Squares that would each complete at least one pattern on their own.
 *
 * This is what the player page highlights. With thirteen overlapping
 * patterns a card can be one away several times over, so this returns
 * every such square rather than the first one found — and a square that
 * would complete two patterns at once appears once, not twice.
 */
export function oneAway(marked) {
  const out = new Set();
  for (const pat of PATTERNS) {
    let missing = -1;
    let count = 0;
    for (const c of pat.cells) {
      if (!marked[c]) { missing = c; count++; }
      if (count > 1) break;
    }
    if (count === 1) out.add(missing);
  }
  return [...out].sort((a, b) => a - b);
}

/* ── Building a card ─────────────────────────────────────────────────── */

/* Seeded so a card is reproducible from the room and the player. A card
   regenerated on every request would reroll on refresh, which is both a
   bug and an exploit: refresh until the grid looks good. The room stores
   the card, and this is what the room stores. */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw a card of 25 distinct ids from the set's pool.
 *
 * @param {string[]} pool  every rare/mythic name in the set's booster pool
 * @param {string} seed    stable per room and player, e.g. `${code}:${userId}`
 * @throws if the pool cannot fill a grid
 */
export function buildCard(pool, seed) {
  const bag = [];
  const seen = new Set();
  for (const id of pool || []) {
    if (id === undefined || id === null || seen.has(id)) continue;
    seen.add(id);
    bag.push(id);
  }

  /* Refused here rather than papered over. A set too small to fill a grid
     cannot be played, and finding that out as a card with holes in it —
     mid-stream, with players already joined — is far worse than refusing
     to open the room. */
  if (bag.length < SQUARES) {
    throw new Error(
      `MTGBBB needs ${SQUARES} distinct cards to fill a grid; this pool has ${bag.length}.`
    );
  }

  const rnd = mulberry32(hashSeed(String(seed)));

  /* Partial Fisher-Yates: only the first 25 positions need to be settled,
     and a full shuffle of an eighty-card pool to take a quarter of it is
     work for nothing. */
  for (let i = 0; i < SQUARES; i++) {
    const j = i + Math.floor(rnd() * (bag.length - i));
    const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
  }

  return bag.slice(0, SQUARES);
}

/* ── Across every player ─────────────────────────────────────────────── */

/**
 * How many cards hold each id. Feeds the pre-box heat map and the overlay's
 * "41 of 62 cards had this" line, which is the number that turns a pull
 * into a shared event rather than a private one.
 *
 * @param {Array<string[]>} cards
 * @returns {Map<string, number>}
 */
export function cardCounts(cards) {
  const counts = new Map();
  for (const card of cards || []) {
    for (const id of new Set(card || [])) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

/** The `n` ids appearing on the most cards, ties broken by id for stability. */
export function hottest(cards, n = 3) {
  return [...cardCounts(cards).entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
    .map(([id, count]) => ({ id, count }));
}

/**
 * Standings, highest first.
 *
 * Ties are NOT broken here. They are broken by a coin flip on stream, so
 * inventing a tiebreak would quietly decide something the host has said
 * they want to decide themselves. Equal scores come back adjacent and
 * equal, and the panel shows them as tied.
 */
/**
 * A player's cards and stamps, whatever era wrote the record. Rooms from
 * before powers hold a single `card` and nothing else.
 */
export function playerCards(p) {
  const cards = (Array.isArray(p.cards) && p.cards.length) ? p.cards : [p.card];
  const wildcards = Array.isArray(p.wildcards) ? p.wildcards : [];
  return { cards, wildcards };
}

/** The stamp indices belonging to one of a player's cards. */
export function wildsFor(wildcards, cardIndex) {
  return (wildcards || [])
    .filter(w => w.cardIndex === cardIndex)
    .map(w => w.squareIndex);
}

/**
 * Score every card a player holds and return the best, which is what the
 * player IS worth: standings, the winner, and the leaderboard all take one
 * number per player, and summing cards would make a second card worth more
 * than a better card -- pay-to-win by arithmetic. An extra card is another
 * CHANCE, not another score.
 */
export function bestOf(p, pulls) {
  const { cards, wildcards } = playerCards(p);
  let best = null, bestIndex = 0;
  cards.forEach((card, i) => {
    const scored = scoreCard(card, pulls, wildsFor(wildcards, i));
    if (!best || scored.points > best.points) { best = scored; bestIndex = i; }
  });
  return { scored: best, cardIndex: bestIndex, cardCount: cards.length, wildcardsUsed: (wildcards || []).length };
}

export function standings(players, pulls) {
  return (players || [])
    .map(p => {
      const b = bestOf(p, pulls);
      /* cardCount and wildcardsUsed ride along so the host panel can say
         "2 cards, 1 stamp" next to a claim -- a bingo the host cannot
         verify honestly is a prize dispute on stream. */
      return { ...p, ...b.scored, bestCard: b.cardIndex, cardCount: b.cardCount, wildcardsUsed: b.wildcardsUsed };
    })
    .sort((a, b) => (b.points - a.points) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
