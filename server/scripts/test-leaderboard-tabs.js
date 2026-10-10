#!/usr/bin/env node
/* ══════════════════════════════════════════════
   LEADERBOARDS — every board a player can earn on is one they can see

     node server/scripts/test-leaderboard-tabs.js

   A board exists in three places that have to agree, and nothing made
   them:

     BOARDS in functions/api/leaderboards.js   — what the server keeps
     BOARDS in js/pages/leaderboards.js        — what the page asks for
     community-leaderboards.html               — where it is drawn

   MTGBBB had the first and neither of the others. Its board was written
   by the game's own end.js from the room's computed scores, it was
   serverOnly, and it settled a monthly prize with all the rest — so chat
   played a whole box crack for points that were recorded, awarded, and
   shown to nobody. Nothing failed; the board was simply invisible.

   A board may legitimately have no tab of its own — mana-clash-wins
   shares the Mana Clash tab, the 15- and 10-pair Memory Match boards live
   inside the Memory Match tab, phamily-time is a derived view — but that
   has to be DECLARED, so the next board added to the server is either
   drawn or deliberately not.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Boards the server keeps. */
const api = read('functions/api/leaderboards.js');
const serverBlock = /const BOARDS = \{([\s\S]*?)\n\};/.exec(api);
ok('the server declares its boards', !!serverBlock);
const serverBoards = [...serverBlock[1].matchAll(/^\s*'([a-z0-9-]+)':/gm)].map(m => m[1]);
ok('and there are several of them', serverBoards.length > 5);

/* Boards the page asks for. */
const client = read('js/pages/leaderboards.js');
const clientBlock = /var BOARDS = \[([\s\S]*?)\];/.exec(client);
ok('the page declares what it fetches', !!clientBlock);
const clientBoards = [...clientBlock[1].matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]);

/* Tabs and panels in the markup. */
const html = read('community-leaderboards.html');
const tabs = [...html.matchAll(/data-board="([a-z0-9-]+)"/g)].map(m => m[1]);
/* The first panel carries `active`, so the class attribute is not an exact
   string match. */
const panels = [...html.matchAll(/class="leaderboard-panel[^"]*" id="board-([a-z0-9-]+)"/g)].map(m => m[1]);
ok('the page has tabs', tabs.length > 3);

/* ── Boards with no tab of their own, and why ────────────────────────── */
const NO_TAB_OF_ITS_OWN = {
  'mana-clash-wins': 'shares the Mana Clash tab with mana-clash',
  'memory-match-15': 'lives inside the Memory Match tab',
  'memory-match-10': 'lives inside the Memory Match tab',
  'phamily-time': 'a derived view, read from the pt_ rows by the community board above the tabs',
};

{
  const untabbed = serverBoards.filter(g => !tabs.includes(g) && !(g in NO_TAB_OF_ITS_OWN));
  check('every board the server keeps has a tab, or says why not', untabbed, []);

  const stale = Object.keys(NO_TAB_OF_ITS_OWN).filter(g => !serverBoards.includes(g));
  check('and nothing is excused that the server no longer keeps', stale, []);

  /* A board with no tab may still be FETCHED, because it is drawn inside
     someone else's tab — but one the page never fetches is drawn nowhere. */
  const neverFetched = serverBoards.filter(g =>
    !clientBoards.includes(g) && !(g in NO_TAB_OF_ITS_OWN && NO_TAB_OF_ITS_OWN[g].includes('derived')));
  check('and every board the server keeps is one the page asks for', neverFetched, []);
}

/* ── A tab must have a panel, and a panel a tab ──────────────────────── */
{
  check('every tab has a panel to show', tabs.filter(t => !panels.includes(t)), []);
  check('every panel has a tab to reach it', panels.filter(p => !tabs.includes(p)), []);
  check('and every tab names a board the server actually keeps',
    tabs.filter(t => !serverBoards.includes(t)), []);
}

/* ── Each panel has somewhere to put the rows ────────────────────────── */
{
  /* populateBoard fills `.lb-row` elements inside #table-<game> or
     #board-<game>; a panel with none renders an empty tab forever. */
  for (const p of panels) {
    const block = new RegExp(
      `id="board-${p}"[\\s\\S]*?(?=<div class="leaderboard-panel"|</div>\\s*</div>\\s*</section>)`
    ).exec(html);
    const rows = block ? (block[0].match(/class="lb-row/g) || []).length : 0;
    ok(`${p}: has rows for populateBoard to fill`, rows >= 10);
    ok(`${p}: has an empty state until the data lands`,
      !!block && /class="lb-empty"/.test(block[0]));
  }
}

/* ── MTGBBB specifically, since it is the one that was missing ───────── */
{
  ok('MTGBBB is kept by the server', serverBoards.includes('mtgbbb'));
  ok('fetched by the page', clientBoards.includes('mtgbbb'));
  ok('and has its own tab', tabs.includes('mtgbbb'));

  const block = /id="board-mtgbbb"[\s\S]*?class="lb-empty"/.exec(html);
  ok('its panel exists', !!block);
  /* Points, not Bingos: mtgbbb-scoring pays for rare and mythic pulls as
     well as for lines, so a score is not a count of bingos. */
  ok('and its score column says Points', !!block && /lb-col-score">Points</.test(block[0]));
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[leaderboard-tabs] ${passed} assertions passed.`);
