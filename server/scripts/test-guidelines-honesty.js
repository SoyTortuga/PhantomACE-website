#!/usr/bin/env node
/* ══════════════════════════════════════════════
   THE GUIDELINES PAGE PROMISES ONLY WHAT EXISTS — test suite

     node server/scripts/test-guidelines-honesty.js

   /guidelines is the page a moderator is pointed at and the page a reader
   is judged by. It used to describe a six-rung ladder of consequences —
   forum restrictions, chat and comment restrictions, removal from a single
   game, the account locked — and FOUR OF THE SIX DID NOT EXIST. There is no
   per-user restriction anywhere in this codebase and no site ban. It also
   said that a ban from PhantomACE's Twitch channel "carries here too"; the
   login flow has never checked for one.

   That is worse than an out-of-date page. A new moderator reads it and
   tells somebody they have been restricted, nothing happens, and the next
   thing anybody learns is that moderation here is theatre.

   TWO HALVES, AND THE SECOND ONE FAILS ON THE FIX. The first checks the
   page makes no claim from the list below. The second checks the site
   still cannot do those things — so the day somebody BUILDS account
   locking, this suite goes red and says to put it back on the page.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ACTIONS_FOR_TEST } from '../../functions/api/forum/moderate.js';

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

/* The page as a reader sees it: tags out, entities back to characters. */
const prose = read('guidelines.html')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&mdash;/g, '-').replace(/&amp;/g, '&').replace(/&rsquo;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ');

/* ── Half one: claims the site cannot keep ──────────────────────────
   Each line is a promise the page actually made, and the reason it was
   false. If one is reinstated, it must be because the capability exists —
   and half two is what checks that. */
const FALSE_CLAIMS = [
  [/lose the ability to start threads/i, 'there is no per-user posting restriction'],
  [/can'?t post in site chat/i, 'there is no site chat, and no mute'],
  [/can'?t comment on profiles/i, 'only the profile owner can switch their own comments off'],
  [/removal from one specific game/i, 'there is no per-game ban'],
  [/account locked/i, 'there is no site ban'],
  [/access to the site is removed/i, 'nothing removes access to the site'],
  [/carries here too/i, 'login never checks a Twitch channel ban'],
];

for (const [pattern, why] of FALSE_CLAIMS) {
  ok(`the page does not promise: ${pattern.source} (${why})`, !pattern.test(prose));
}

/* ── Half two: the site still cannot do them ────────────────────────
   Build any of this and the assertion below fails, which is the point:
   the page has to be updated in the same change. */
{
  /* A per-user enforcement record would have to be stored somewhere, and
     every key in this project is mapped in the registry. */
  const registry = read('server/lib/registry.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const enforcement = [...registry.matchAll(/^\s*(?:\{\s*prefix:\s*)?'?([a-z_]*(?:ban|suspend|mute|restrict)[a-z_]*)'?\s*:/gmi)]
    .map(m => m[1]);
  check('no storage family holds a per-user ban, mute or restriction', enforcement, []);

  /* And nothing refuses a request because of one. */
  const authGate = read('functions/api/auth/twitch.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  ok('login does not check a ban list', !/\bban/i.test(authGate));

  /* The moderation route's own vocabulary: every action it accepts is
     about a POST or a THREAD. Not one of them is about a person. If an
     action naming a user appears, the ladder is real and the page owes the
     reader a description of it. */
  const aboutPeople = [...ACTIONS_FOR_TEST].filter(a => /user|member|account|ban|mute|restrict/i.test(a));
  check('every moderation action targets content, not a person', aboutPeople, []);
}

/* ── What the page DOES say is real ─────────────────────────────────── */
{
  /* Removal and restore are the backbone of the honest version, so the
     page may only describe them while the route still implements them. */
  ok('the route can remove a post', ACTIONS_FOR_TEST.has('delete-post'));
  ok('and put it back', ACTIONS_FOR_TEST.has('restore-post'));
  ok('and lock a topic', ACTIONS_FOR_TEST.has('lock'));

  ok('the page says a removal is reversible', /restore|put it back/i.test(prose));
  ok('and that removals are logged with a reason', /logged with a reason|removal is logged/i.test(prose));
  ok('and that a locked topic stays readable', /stays readable/i.test(prose));
  /* The honest top rung: a person, not a button. */
  ok('and names escalation rather than an automatic penalty', /PhantomACE/.test(prose) && /conversation|his call/i.test(prose));

  /* Reporting: forum posts and profile comments only — the page claimed
     chat messages too, and nothing on this site can report one. */
  ok('reporting is scoped to what can be reported',
    /Forum posts and profile comments can be reported/i.test(prose));

  /* The date was stale by three weeks when the ladder was corrected; the
     page itself tells readers that date is how they know the revision. */
  ok('the page carries a last-updated date', /Last updated \d{1,2} \w+ \d{4}/.test(prose));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[guidelines-honesty] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[guidelines-honesty] ${passed} assertions passed.`);
