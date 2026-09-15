/* ══════════════════════════════════════════════
   MANA CLASH — FARKLE SCORING ENGINE

   Pure functions. No storage, no session, no clock. Every rule in
   docs/MANA-CLASH-RULES.md lives here and nowhere else, so the rules can be
   changed in one place and proven by server/scripts/test-scoring.js rather
   than by playing a game and squinting at the result.

   The client scores a hand too — dice light up as you roll, and waiting for
   a round trip to find out whether a die is scorable would make the game
   feel broken. That makes the client's copy a CONVENIENCE and this one the
   authority: every submitted selection is re-scored here, and a selection
   this module rejects is rejected no matter what the page showed. A player
   editing their own JavaScript changes what their screen says, not what
   they are paid.
   ══════════════════════════════════════════════ */

/* Faces, in value order. The mana symbol is the skin; the number behind it
   is what scores. This inverts the old Mana Clash mapping (which ran W:1
   through C:6) because Farkle's two scoring singles are the 1 and the 5, and
   Colorless-as-1 is the reading a player will expect from the pip count. */
export const FACES = ['C', 'W', 'U', 'B', 'R', 'G'];
export const FACE_VALUE = { C: 1, W: 2, U: 3, B: 4, R: 5, G: 6 };
export const VALUE_FACE = { 1: 'C', 2: 'W', 3: 'U', 4: 'B', 5: 'R', 6: 'G' };

export const DICE_COUNT = 6;

/* Named so a caller reads intent rather than a magic number. */
export const THREE_PAIRS = 1500;
export const TWO_TRIPLETS = 2500;
export const STRAIGHT = 1500;
export const SINGLE_ONE = 100;
export const SINGLE_FIVE = 50;

/**
 * n-of-a-kind, n >= 3. Three 1s are 1000, any other triple is face x 100,
 * and each die beyond the third doubles the whole thing — so six 1s are
 * 8000, enough to take a 5000-point game in one roll. That is deliberate:
 * six of a kind is roughly a 1-in-7776 roll and is meant to be a moment.
 */
export function nOfAKindScore(value, n) {
  if (n < 3) return 0;
  const base = value === 1 ? 1000 : value * 100;
  return base * Math.pow(2, n - 3);
}

/** Face letters -> counts[1..6]. Index 0 is unused so counts[v] reads as v. */
function toCounts(faces) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const f of faces) counts[FACE_VALUE[f]]++;
  return counts;
}

function totalOf(counts) {
  let n = 0;
  for (let v = 1; v <= 6; v++) n += counts[v];
  return n;
}

/* ── Whole-hand combinations ───────────────────────────────────────────
   Straight, three pairs and two triplets each consume all six dice, so they
   are only ever available on a full hand and are checked once at the top
   rather than inside the recursion. */

function wholeHandScores(counts) {
  const out = [];
  if (totalOf(counts) !== DICE_COUNT) return out;

  let ones = 0, pairs = 0, triples = 0, quads = 0;
  for (let v = 1; v <= 6; v++) {
    if (counts[v] === 1) ones++;
    if (counts[v] === 2) pairs++;
    if (counts[v] === 3) triples++;
    if (counts[v] === 4) quads++;
  }

  if (ones === 6) out.push(STRAIGHT);
  if (triples === 2) out.push(TWO_TRIPLETS);
  if (pairs === 3) out.push(THREE_PAIRS);

  /* Four of a kind plus a pair read as three pairs. The four contains two
     pairs and the remaining pair is the third. It only ever wins where the
     honest alternative is worse — four 2s and a pair of 3s is 400 the long
     way and 1500 this way — and "the best reading always wins" is the stated
     rule, so refusing it would be the surprise. */
  if (quads === 1 && pairs === 1) out.push(THREE_PAIRS);

  return out;
}

/* ── The recursion ─────────────────────────────────────────────────────
   Best score that consumes EVERY die in `counts`, or null if no reading
   consumes them all. Consuming everything is what makes this double as the
   validator: a selection holding a die that cannot score has no complete
   reading, and gets rejected rather than silently scored as if it were not
   there.

   Six dice, six faces — the search space is tiny and exhaustive is both
   fast enough and obviously correct, which matters more here than clever. */

function bestConsumingAll(counts) {
  if (totalOf(counts) === 0) return 0;

  let best = null;
  const consider = (points) => {
    if (points !== null && (best === null || points > best)) best = points;
  };

  for (const whole of wholeHandScores(counts)) consider(whole);

  for (let v = 1; v <= 6; v++) {
    if (counts[v] >= 3) {
      for (let n = 3; n <= counts[v]; n++) {
        counts[v] -= n;
        const rest = bestConsumingAll(counts);
        counts[v] += n;
        if (rest !== null) consider(nOfAKindScore(v, n) + rest);
      }
    }
  }

  if (counts[1] >= 1) {
    counts[1]--;
    const rest = bestConsumingAll(counts);
    counts[1]++;
    if (rest !== null) consider(SINGLE_ONE + rest);
  }

  if (counts[5] >= 1) {
    counts[5]--;
    const rest = bestConsumingAll(counts);
    counts[5]++;
    if (rest !== null) consider(SINGLE_FIVE + rest);
  }

  return best;
}

/* ── Public API ────────────────────────────────────────────────────────── */

/**
 * Score a set of dice the player wants to keep.
 *
 * @param {string[]} faces face letters, 1..6 of them
 * @returns {{valid: boolean, points: number, reason: string|null}}
 *
 * `valid` is false when some die in the selection contributes nothing. That
 * is the whole point of scoring it here: a player cannot hold a 2 alongside
 * two 1s and bank the 1s while keeping the 2 on the table for a re-roll.
 */
export function scoreSelection(faces) {
  if (!Array.isArray(faces) || faces.length === 0) {
    return { valid: false, points: 0, reason: 'Keep at least one die.' };
  }
  if (faces.length > DICE_COUNT) {
    return { valid: false, points: 0, reason: 'That is more than six dice.' };
  }
  for (const f of faces) {
    if (!Object.prototype.hasOwnProperty.call(FACE_VALUE, f)) {
      return { valid: false, points: 0, reason: 'Unrecognised die.' };
    }
  }

  const points = bestConsumingAll(toCounts(faces));
  if (points === null) {
    return { valid: false, points: 0, reason: 'Every die you keep has to score.' };
  }
  return { valid: true, points, reason: null };
}

/**
 * The best a hand can possibly do if every die is kept. Used for hot dice —
 * when all six score there is nothing to choose, so the game takes them.
 */
export function scoreAll(faces) {
  const r = scoreSelection(faces);
  return r.valid ? r.points : 0;
}

/**
 * Which dice can take part in SOME scoring combination — what lights up
 * after a roll.
 *
 * A die qualifies if some valid selection contains it. Computed by asking
 * the real scorer rather than by re-listing the rules, so it cannot drift
 * out of step with what scoreSelection() will actually accept: a die that
 * lights up is always a die you are allowed to keep.
 *
 * @param {string[]} faces
 * @returns {boolean[]} one flag per die, positionally aligned with `faces`
 */
export function scorableMask(faces) {
  const n = faces.length;
  const mask = new Array(n).fill(false);
  if (n === 0) return mask;

  /* Every non-empty subset of at most six dice — 63 at worst. Each valid one
     marks its members. */
  for (let bits = 1; bits < (1 << n); bits++) {
    const subset = [];
    for (let i = 0; i < n; i++) if (bits & (1 << i)) subset.push(faces[i]);
    if (!scoreSelection(subset).valid) continue;
    for (let i = 0; i < n; i++) if (bits & (1 << i)) mask[i] = true;
  }
  return mask;
}

/**
 * Does this roll score at all? False is a MANA BURN: the turn's accumulated
 * points are lost and the turn ends.
 */
export function hasAnyScore(faces) {
  return scorableMask(faces).some(Boolean);
}

/**
 * Do ALL the dice in this roll score, with none left over? True is a MANA
 * CLASH: they are taken automatically and the player picks up all six again
 * with their running total intact.
 *
 * `faces` is the dice still in play, NOT always six. Rolling three and
 * having all three score is a Mana Clash just as much as rolling six is —
 * it is the same fact either way, that nothing is left on the table.
 */
export function isHotDice(faces) {
  return faces.length > 0 && scoreSelection(faces).valid;
}

/** A fair roll of `count` dice. */
export function rollDice(count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(FACES[Math.floor(Math.random() * FACES.length)]);
  return out;
}
