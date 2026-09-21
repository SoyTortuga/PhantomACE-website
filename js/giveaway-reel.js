/* ══════════════════════════════════════════════
   GIVEAWAY REEL — the arithmetic behind the spin

   ONE SLOT, NOT A WHEEL. The draw is a flat pick: every entrant has
   exactly one chance, whatever they redeemed or how long they have
   watched. A wheel's whole visual language is slice size — it tells a
   viewer "some of you have better odds" about a draw where nobody does —
   and it stops being readable somewhere around thirty entrants, which is a
   normal night. A single slot flicking through names says the true thing
   and stays legible at two hundred.

   Everything here is pure so server/scripts/test-giveaway-reel.js can
   check it, and because the one rule that actually matters — the reel
   stops on the name the SERVER picked — is not something you can verify by
   watching an animation.

   Loaded as a plain script; exposes window.PhamReel.
   ══════════════════════════════════════════════ */

(function (root) {
  'use strict';

  /* Row height in px. Shared with bot-control.css, which sizes the window
     to exactly one row — the strip is translated by whole rows, so a
     disagreement here shows up as a name sitting half out of frame. */
  var ROW_H = 56;

  /* How many names flick past before the winner, and how long the CSS
     transition that drives them takes. Kept together and exposed as the one
     source both callers (the control panel and the overlay alert) drive
     their animation from, rather than each guessing a number that has to
     agree with the other's. Six seconds of travel reads as a real spin
     rather than a jump cut, and is long enough to hold on stream. */
  var SPIN_ROWS = 40;
  var SPIN_MS = 6000;

  /**
   * The strip of names the reel scrolls through, ending on the winner.
   *
   * @param {Array<{username: string}>} entrants
   * @param {number} winnerIndex        index into `entrants`, from the server
   * @param {object} [opts]
   * @param {number} [opts.rows]        how many names flick past first
   * @param {function} [opts.rng]       0..1 source, injectable for tests
   * @returns {{names: string[], landing: number, offset: number}}
   */
  function strip(entrants, winnerIndex, opts) {
    var list = Array.isArray(entrants) ? entrants : [];
    var o = opts || {};
    var rows = Math.max(0, Math.floor(o.rows == null ? SPIN_ROWS : o.rows));
    var rng = o.rng || Math.random;

    var winner = list[winnerIndex];
    if (!winner) return { names: [], landing: 0, offset: 0 };

    var names = [];
    for (var i = 0; i < rows; i++) {
      var pick = list[Math.floor(rng() * list.length)] || winner;
      /* Never put the winner's name in the row immediately before the
         landing row. The reel decelerates hard at the end, so the same
         name twice there looks like it stopped a row early and jumped. */
      if (list.length > 1 && i === rows - 1 && pick.username === winner.username) {
        pick = list[(winnerIndex + 1) % list.length];
      }
      names.push(pick.username);
    }
    names.push(winner.username);

    var landing = names.length - 1;
    return { names: names, landing: landing, offset: -landing * ROW_H };
  }

  root.PhamReel = {
    ROW_H: ROW_H,
    SPIN_ROWS: SPIN_ROWS,
    SPIN_MS: SPIN_MS,
    strip: strip,
  };
})(typeof window !== 'undefined' ? window : globalThis);
