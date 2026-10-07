#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CHAT VOTE — one question, any game

     node server/scripts/test-chat-vote.js

   RUNS OFFLINE.

   WHAT THIS IS GUARDING. This is the fallback for every game with no
   integration, so it has to behave the same every time regardless of what it
   is asked:

     - FIXED mode cannot be derailed. Anything that is not one of the options
       is dropped, including a number out of range.
     - An ambiguous prefix resolves to NOTHING. A vote landing on an option the
       voter did not choose is worse than no vote.
     - FIXED mode shows options nobody picked. A tally that hides the losers
       makes 5-0 look the same as 5-4.
     - OPEN mode merges identical answers on case and spacing, or one good
       answer typed three ways splits its own vote and loses.
     - OPEN mode credits the FIRST person to say the winning answer, and keeps
       crediting them when others pile on behind.
     - FIXED mode credits nobody. Picking the popular option out of four is a
       group decision, and paying every voter would mint hundreds of entries a
       stream.
     - Locking computes the winner ONCE, so a vote slipping in under the lock
       cannot change what is already on screen.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cv from '../../functions/api/chat-vote.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function makeEnv({ profiles = [] } = {}) {
  const store = new Map();
  const chains = new Map();
  for (const id of profiles) store.set(`profile_${id}`, JSON.stringify({ userId: String(id) }));
  return {
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
          const next = await fn(cur);
          if (next === undefined) return cur;
          store.set(k, JSON.stringify(next));
          return JSON.parse(store.get(k));
        });
        chains.set(k, run.then(() => {}, () => {}));
        return run;
      },
      async listValues() { return []; },
    },
    _store: store,
  };
}

const vote = (env, id, text, name) => cv.voteFromChat(env, { userId: id, name: name || ('u' + id), text });
async function view(env) {
  return await (await cv.onRequestGet({ env })).json();
}
const entries = (env, id) => {
  for (const [k, v] of env._store) if (k.startsWith(`gwe_${id}_`)) return JSON.parse(v).entries;
  return 0;
};
const OPTS = ['Leshy', 'Heket', 'Kallamar'];

/* ── Opening ─────────────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  check('a vote needs a question', (await cv.openVote(env, { question: '  ' })).ok, false);
  check('options make it fixed', (await cv.openVote(env, { question: 'Q', options: OPTS })).mode, 'fixed');
  check('no options makes it open', (await cv.openVote(env, { question: 'Q' })).mode, 'open');
  /* One option is not a choice. */
  check('one option is refused', (await cv.openVote(env, { question: 'Q', options: ['Only'] })).ok, false);
  /* Duplicates would split their own tally. */
  check('duplicate options collapse and are then too few',
    (await cv.openVote(env, { question: 'Q', options: ['Leshy', 'leshy'] })).ok, false);
}

/* ── FIXED: by number, by name, by prefix ────────────────────────────────── */
{
  const env = makeEnv();
  await cv.openVote(env, { question: 'Which bishop?', options: OPTS });

  check('a number votes', (await vote(env, '1', '1')).answer, 'Leshy');
  check('an exact name votes', (await vote(env, '2', 'Heket')).answer, 'Heket');
  check('case does not matter', (await vote(env, '3', 'kallamar')).answer, 'Kallamar');
  check('a unique prefix works', (await vote(env, '4', 'les')).answer, 'Leshy');

  const v = await view(env);
  check('the question is carried', v.question, 'Which bishop?');
  check('four votes in', v.total, 4);
  check('Leshy leads', v.tally[0], { answer: 'Leshy', votes: 2, n: 1, by: null });
}

/* ── FIXED cannot be derailed ────────────────────────────────────────────── */
{
  const env = makeEnv();
  await cv.openVote(env, { question: 'Q', options: OPTS });
  check('an answer that is not an option is dropped', (await vote(env, '1', 'Doritos')).reason, 'no-match');
  check('a number out of range too', (await vote(env, '1', '9')).reason, 'no-match');
  check('and zero', (await vote(env, '1', '0')).reason, 'no-match');
  check('nothing counted', (await view(env)).total, 0);
}

/* ── An ambiguous prefix resolves to nothing ─────────────────────────────── */
{
  const env = makeEnv();
  await cv.openVote(env, { question: 'Q', options: ['Attack', 'Attempt', 'Retreat'] });
  check('a prefix matching two options matches neither', (await vote(env, '1', 'att')).reason, 'no-match');
  check('but a longer one resolves', (await vote(env, '1', 'attac')).answer, 'Attack');
}

/* ── FIXED SHOWS THE OPTIONS NOBODY PICKED ───────────────────────────────
   A tally that hides the losers makes 5-0 read like 5-4. */
{
  const env = makeEnv();
  await cv.openVote(env, { question: 'Q', options: OPTS });
  await vote(env, '1', '1');

  const v = await view(env);
  check('all three options are on screen', v.tally.length, 3);
  check('the picked one with its votes', v.tally[0], { answer: 'Leshy', votes: 1, n: 1, by: null });
  check('and the others at zero', v.tally.slice(1).map(t => t.votes), [0, 0]);
  check('each carrying the number chat types', v.tally.map(t => t.n), [1, 2, 3]);
}

/* ── OPEN: anything goes, identical answers merge ────────────────────────── */
{
  const env = makeEnv();
  await cv.openVote(env, { question: 'Name it' });
  await vote(env, '1', 'Bleaty', 'Alice');
  await vote(env, '2', 'bleaty', 'Bob');
  await vote(env, '3', 'BLEATY ', 'Carol');
  await vote(env, '4', 'Mutton', 'Dan');

  const v = await view(env);
  check('four voted', v.total, 4);
  check('three spellings are ONE candidate', v.tally.length, 2);
  check('with votes merged', v.tally[0].votes, 3);
  check('under the first spelling seen', v.tally[0].answer, 'Bleaty');
  check('credited to whoever said it first', v.tally[0].by, 'Alice');
}

/* ── FIRST SAYER KEEPS THE CREDIT when others pile on ────────────────────── */
{
  const env = makeEnv();
  await cv.openVote(env, { question: 'Name it' });
  await vote(env, '1', 'Bleaty', 'Alice');
  await vote(env, '2', 'Other', 'Bob');
  await vote(env, '2', 'Bleaty', 'Bob');       // Bob switches in later
  const v = await view(env);
  check('still credited to Alice', v.tally[0].by, 'Alice');
  check('with both votes', v.tally[0].votes, 2);
}

/* ── A vote can be changed ───────────────────────────────────────────────── */
{
  const env = makeEnv();
  await cv.openVote(env, { question: 'Q', options: OPTS });
  await vote(env, '1', '1');
  const changed = await vote(env, '1', '2');
  check('changing is allowed', changed.ok, true);
  check('and reported', changed.changed, true);
  const v = await view(env);
  check('counted once', v.total, 1);
  check('under the new answer', v.tally[0].answer, 'Heket');
  check('voting the same again is a no-op', (await vote(env, '1', '2')).reason, 'same');
}

/* ── Locking, and who gets paid ──────────────────────────────────────────── */
{
  const env = makeEnv({ profiles: ['1'] });
  await cv.openVote(env, { question: 'Name it' });
  await vote(env, '1', 'Bleaty', 'Alice');
  await vote(env, '2', 'Bleaty', 'Bob');
  await vote(env, '3', 'Mutton', 'Carol');

  const r = await cv.lockVote(env);
  check('the leader wins', r.winner, 'Bleaty');
  check('and the first sayer is paid', r.paid, true);
  check('Alice has entries', entries(env, '1'), 2);
  check('Bob, who agreed, does not', entries(env, '2'), 0);

  const v = await view(env);
  check('the panel flips to locked', v.status, 'locked');
  check('naming the winner', v.winner.answer, 'Bleaty');
  check('and who said it', v.winner.by, 'Alice');

  const late = await vote(env, '4', 'Mutton');
  check('a late vote is refused', late.ok, false);
  check('and the winner is unchanged', (await view(env)).winner.answer, 'Bleaty');
}

/* ── FIXED MODE PAYS NOBODY ──────────────────────────────────────────────
   Picking the popular option out of three is not an achievement. */
{
  const env = makeEnv({ profiles: ['1', '2'] });
  await cv.openVote(env, { question: 'Q', options: OPTS });
  await vote(env, '1', '1', 'Alice');
  await vote(env, '2', '1', 'Bob');

  const r = await cv.lockVote(env);
  check('it still resolves', r.winner, 'Leshy');
  check('but pays nobody', r.paid, false);
  check('no entries for the first voter', entries(env, '1'), 0);
  check('nor the second', entries(env, '2'), 0);
  check('and no name is attributed', (await view(env)).winner.by, null);
}

/* ── An open-mode winner with no account ─────────────────────────────────── */
{
  const env = makeEnv();                        // nobody has logged in
  await cv.openVote(env, { question: 'Name it' });
  await vote(env, '77', 'Lurkerson', 'Lurker');
  const r = await cv.lockVote(env);
  check('the answer still wins', r.winner, 'Lurkerson');
  check('but nothing is paid', r.paid, false);
  check('and no ledger row is invented', entries(env, '77'), 0);
  check('so the panel can say why', !!(await view(env)).winner.paid, false);
}

/* ── Locking with no votes leaves it open ────────────────────────────────── */
{
  const env = makeEnv();
  await cv.openVote(env, { question: 'Q', options: OPTS });
  check('there is nothing to lock', (await cv.lockVote(env)).ok, false);
  check('so it stays open', (await view(env)).status, 'open');
}

/* ── Cancelling decides nothing ──────────────────────────────────────────── */
{
  const env = makeEnv({ profiles: ['1'] });
  await cv.openVote(env, { question: 'Name it' });
  await vote(env, '1', 'Bleaty', 'Alice');
  await cv.cancelVote(env);
  check('the panel clears', (await view(env)).status, 'none');
  check('and nobody was paid', entries(env, '1'), 0);
}

/* ── A locked vote takes itself off screen ───────────────────────────────── */
{
  const env = makeEnv();
  await cv.openVote(env, { question: 'Q', options: OPTS });
  await vote(env, '1', '1');
  await cv.lockVote(env);
  check('the result shows at first', (await view(env)).status, 'locked');
  const d = JSON.parse(env._store.get('chat_vote'));
  d.lockedAt = Date.now() - 600000;
  env._store.set('chat_vote', JSON.stringify(d));
  check('then clears itself', (await view(env)).status, 'none');
}

/* ── Opening a new vote replaces the old ─────────────────────────────────── */
{
  const env = makeEnv();
  await cv.openVote(env, { question: 'First', options: OPTS });
  await vote(env, '1', '1');
  await cv.openVote(env, { question: 'Second' });
  const v = await view(env);
  check('the new question is up', v.question, 'Second');
  check('in the new mode', v.mode, 'open');
  check('with nobody carried over', v.total, 0);
}

/* ── Input hygiene ───────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  await cv.openVote(env, { question: 'Name it' });
  check('control characters are stripped', (await vote(env, '1', 'Ble\u0000aty')).answer, 'Bleaty');
  check('whitespace collapses', (await vote(env, '2', '  Sir   Wool ')).answer, 'Sir Wool');
  const long = await vote(env, '3', 'x'.repeat(90));
  check('and answers are bounded', long.answer.length, 28);
}

/* ── Only staff may run it ───────────────────────────────────────────────── */
{
  const env = makeEnv();
  env._store.set('site_moderators', JSON.stringify({ entries: [] }));
  const res = await cv.onRequestPost({
    env,
    request: new Request('https://p.tv/api/chat-vote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open', question: 'Q' }),
    }),
  });
  check('an anonymous caller cannot open a vote', res.status, 403);
}

/* ── The wiring that fails silently when missed ──────────────────────────── */
{
  const registry = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the registry maps chat_vote', /chat_vote:\s*\{/.test(registry));
  /* The follower roster duplicated the game's own gallery and is gone. */
  ok('and the retired follower prefix is gone', !/cotl_follower_/.test(registry));

  const cmds = fs.readFileSync(path.join(REPO, 'functions/api/bot/commands.js'), 'utf8');
  ok('chat dispatches !vote', /parsed\.command === '!vote'/.test(cmds));
  ok('as a PUBLIC command, before the moderator gate',
     cmds.indexOf("'!vote'") < cmds.indexOf('if (!isAuthorizedSender(env, event)) return;'));

  const ovHtml = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay has the panel', /id="ovVote"/.test(ovHtml));
  ok('and loads its driver', /overlay-chat-vote\.js/.test(ovHtml));
  ok('the retired panel is gone', !/ovCotl/.test(ovHtml));

  const ovCss = fs.readFileSync(path.join(REPO, 'css/pages/overlay.css'), 'utf8');
  ok('the panel still reaches display:none when hidden',
     /\.ov-vote\[hidden\] \{ display: none; \}/.test(ovCss));

  const layout = fs.readFileSync(path.join(REPO, 'functions/api/overlay/layout.js'), 'utf8');
  ok('the layout route stores its position', /'ovVote'/.test(layout));

  const samples = fs.readFileSync(path.join(REPO, 'js/pages/overlay-samples.js'), 'utf8');
  ok('and the editor can place it', /id: 'ovVote'/.test(samples));

  const dashHtml = fs.readFileSync(path.join(REPO, 'overlay-dashboard.html'), 'utf8');
  ok('the dashboard takes a question and options',
     /id="odVoteQuestion"/.test(dashHtml) && /id="odVoteOptions"/.test(dashHtml));
  ok('and can open, lock and cancel',
     /id="odVoteOpenBtn"/.test(dashHtml) && /id="odVoteLockBtn"/.test(dashHtml) && /id="odVoteCancelBtn"/.test(dashHtml));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[chat-vote] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[chat-vote] ${passed} assertions passed.`);
console.log('');
