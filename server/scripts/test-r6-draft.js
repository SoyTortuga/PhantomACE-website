#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SIEGE OPERATOR DRAFT — chat picks what he plays

     node server/scripts/test-r6-draft.js

   RUNS OFFLINE. Nothing reaches Ubisoft, which is the point: there is no
   official R6 API, so this feature deliberately reads no game state at all.

   WHAT THIS IS GUARDING. The draft is BINDING — he plays what chat picks — so
   every one of these is the difference between a working feature and one he
   stops trusting mid-stream:

     - A vote must resolve to something playable, or he cannot honour it.
     - Sides are disjoint pools. A defence draft must not accept Thatcher, and
       not as a fuzzy near-miss either: he is not a candidate.
     - An ambiguous prefix resolves to NOTHING. A vote landing on an operator
       the voter did not name is worse than no vote.
     - A vote can be CHANGED while open — unlike MTGBBB's guess round, nothing
       here is hidden, so swinging behind a pick is the game, not an exploit.
     - Locking computes the winner ONCE. Recomputing it per poll would let a
       vote that slipped in under the lock change what is already on screen.
     - With no roster pasted in yet, the draft refuses to open and SAYS SO.
       A draft that opens and silently rejects every vote is the worst way to
       discover the roster is empty.

   The real roster lives in functions/api/r6-operators.js and is empty until
   pasted; these tests inject their own fixture so they prove the mechanism
   rather than the data.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as draft from '../../functions/api/r6-draft.js';
import * as roster from '../../functions/api/r6-operators.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* A fixture roster. Deliberately includes an accented codename and two names
   sharing a prefix, because both are real and both break naive matching. */
const FIXTURE_ATK = ['Thatcher', 'Thermite', 'Ash', 'Sledge', 'Capitão'];
const FIXTURE_DEF = ['Jäger', 'Mute', 'Smoke', 'Mira'];

function seedRoster() {
  roster.ATTACKERS.length = 0;
  roster.ATTACKERS.push(...FIXTURE_ATK);
  roster.DEFENDERS.length = 0;
  roster.DEFENDERS.push(...FIXTURE_DEF);
}
function emptyRoster() {
  roster.ATTACKERS.length = 0;
  roster.DEFENDERS.length = 0;
}

function makeEnv() {
  const store = new Map();
  const chains = new Map();
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

async function view(env) {
  const res = await draft.onRequestGet({ env });
  return await res.json();
}
const vote = (env, id, text, name) => draft.voteFromChat(env, { userId: id, name: name || ('u' + id), text });

/* ── An empty roster refuses to open, loudly ─────────────────────────────── */
{
  emptyRoster();
  const env = makeEnv();
  const r = await draft.openDraft(env, 'attack');
  check('a draft cannot open with no roster', r.ok, false);
  ok('and the error names the file to paste into', /r6-operators\.js/.test(r.error));
  check('the overlay reports the roster as not ready', (await view(env)).rosterReady, false);
}

/* ── Matching: forgiving, accent-free, never ambiguous ───────────────────── */
{
  seedRoster();
  check('an exact codename matches', draft.matchOperator('attack', 'Thatcher'), 'Thatcher');
  check('case does not matter', draft.matchOperator('attack', 'thatcher'), 'Thatcher');
  /* Chat should never have to produce an accented character. */
  check('an accent can be dropped', draft.matchOperator('attack', 'capitao'), 'Capitão');
  check('and on defence too', draft.matchOperator('defence', 'jager'), 'Jäger');
  check('a unique prefix is enough', draft.matchOperator('attack', 'sle'), 'Sledge');
  /* Thatcher and Thermite share "th" — this must resolve to neither. */
  check('an ambiguous prefix matches nothing', draft.matchOperator('attack', 'th'), null);
  check('but a longer one disambiguates', draft.matchOperator('attack', 'ther'), 'Thermite');
  check('an unknown name matches nothing', draft.matchOperator('attack', 'Gandalf'), null);
}

/* ── SIDES ARE DISJOINT ──────────────────────────────────────────────────── */
{
  seedRoster();
  check('a defender is not a candidate during an attack draft',
    draft.matchOperator('attack', 'Smoke'), null);
  check('and an attacker is not during a defence draft',
    draft.matchOperator('defence', 'Thatcher'), null);
  check('an unknown side has no pool', draft.matchOperator('both', 'Mute'), null);
}

/* ── Votes land and tally ────────────────────────────────────────────────── */
{
  seedRoster();
  const env = makeEnv();
  await draft.openDraft(env, 'attack');

  const v0 = await view(env);
  check('the panel opens', v0.status, 'open');
  check('naming the side', v0.side, 'attack');
  check('with nobody in', v0.total, 0);

  check('a vote is accepted', (await vote(env, '1', 'thatcher')).ok, true);
  await vote(env, '2', 'Thatcher');
  await vote(env, '3', 'ash');

  const v = await view(env);
  check('all three counted', v.total, 3);
  check('the leader is first', v.tally[0], { operator: 'Thatcher', votes: 2 });
  check('then the rest', v.tally[1], { operator: 'Ash', votes: 1 });
}

/* ── A WRONG-SIDE VOTE IS DROPPED, NOT MISMATCHED ────────────────────────── */
{
  seedRoster();
  const env = makeEnv();
  await draft.openDraft(env, 'defence');
  const r = await vote(env, '1', 'Thatcher');
  check('an attacker is refused on a defence draft', r.ok, false);
  check('for the right reason', r.reason, 'no-match');
  check('and nothing is counted', (await view(env)).total, 0);
}

/* ── A VOTE CAN BE CHANGED ───────────────────────────────────────────────
   Deliberately the opposite of MTGBBB's guess round: nothing here is hidden,
   so swinging behind a leader is the whole point of a draft. */
{
  seedRoster();
  const env = makeEnv();
  await draft.openDraft(env, 'attack');
  await vote(env, '1', 'Ash');
  const changed = await vote(env, '1', 'Thatcher');

  check('a chatter may change their pick', changed.ok, true);
  check('and it is reported as a change', changed.changed, true);
  const v = await view(env);
  check('they are still only counted once', v.total, 1);
  check('under the new operator', v.tally, [{ operator: 'Thatcher', votes: 1 }]);
  check('voting the same operator again is a no-op', (await vote(env, '1', 'Thatcher')).reason, 'same');
}

/* ── Rejections cost nothing ─────────────────────────────────────────────── */
{
  seedRoster();
  const env = makeEnv();
  await draft.openDraft(env, 'attack');
  check('an unknown operator is dropped', (await vote(env, '9', 'Gandalf')).reason, 'no-match');
  check('an ambiguous prefix too', (await vote(env, '9', 'th')).reason, 'no-match');
  check('an empty message too', (await vote(env, '9', '')).ok, false);
  check('and none of them counted', (await view(env)).total, 0);
}

/* ── Locking names the winner, once ──────────────────────────────────────── */
{
  seedRoster();
  const env = makeEnv();
  await draft.openDraft(env, 'attack');
  await vote(env, '1', 'Thatcher');
  await vote(env, '2', 'Thatcher');
  await vote(env, '3', 'Ash');

  const locked = await draft.lockDraft(env);
  check('locking succeeds', locked.ok, true);
  check('naming the leader', locked.winner.operator, 'Thatcher');

  const v = await view(env);
  check('the panel flips to locked', v.status, 'locked');
  check('showing the pick', v.winner.operator, 'Thatcher');
  check('its votes', v.winner.votes, 2);
  check('and the turnout behind it', v.winner.total, 3);

  /* THE POINT: a vote that slips in under the lock must not change what is
     already on screen. */
  const late = await vote(env, '4', 'Ash');
  check('a late vote is refused', late.ok, false);
  check('and the winner is unchanged', (await view(env)).winner.operator, 'Thatcher');
}

/* ── Locking an empty draft leaves it open ───────────────────────────────── */
{
  seedRoster();
  const env = makeEnv();
  await draft.openDraft(env, 'attack');
  const r = await draft.lockDraft(env);
  check('there is nothing to lock', r.ok, false);
  check('so the draft stays open for votes', (await view(env)).status, 'open');
}

/* ── Ties are stable, not jittery ────────────────────────────────────────
   Two operators on equal votes must not swap places between polls. */
{
  seedRoster();
  const env = makeEnv();
  await draft.openDraft(env, 'attack');
  await vote(env, '1', 'Thatcher');
  await vote(env, '2', 'Ash');
  const a = (await view(env)).tally.map(t => t.operator);
  const b = (await view(env)).tally.map(t => t.operator);
  check('the order is identical across polls', a, b);
  check('and alphabetical on a tie', a, ['Ash', 'Thatcher']);
}

/* ── Ending clears it ────────────────────────────────────────────────────── */
{
  seedRoster();
  const env = makeEnv();
  await draft.openDraft(env, 'attack');
  await vote(env, '1', 'Ash');
  await draft.endDraft(env);
  check('the panel goes away', (await view(env)).status, 'none');
  check('and a vote does nothing', (await vote(env, '1', 'Ash')).reason, 'closed');
}

/* ── A locked draft takes itself off screen ──────────────────────────────── */
{
  seedRoster();
  const env = makeEnv();
  await draft.openDraft(env, 'attack');
  await vote(env, '1', 'Ash');
  await draft.lockDraft(env);
  check('the pick shows while he loads in', (await view(env)).status, 'locked');

  const d = JSON.parse(env._store.get('r6_draft'));
  d.lockedAt = Date.now() - 600000;
  env._store.set('r6_draft', JSON.stringify(d));
  check('then clears itself', (await view(env)).status, 'none');
}

/* ── Opening the other side replaces the draft ───────────────────────────── */
{
  seedRoster();
  const env = makeEnv();
  await draft.openDraft(env, 'attack');
  await vote(env, '1', 'Ash');
  await draft.openDraft(env, 'defence');
  const v = await view(env);
  check('the new draft is for the other side', v.side, 'defence');
  check('and starts empty', v.total, 0);
}

/* ── Only staff may drive it ─────────────────────────────────────────────── */
{
  seedRoster();
  const env = makeEnv();
  env._store.set('site_moderators', JSON.stringify({ entries: [] }));
  const res = await draft.onRequestPost({
    env,
    request: new Request('https://phantomace.tv/api/r6-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'attack' }),
    }),
  });
  check('an anonymous caller cannot open a draft', res.status, 403);
}

/* ── The wiring that fails silently when missed ──────────────────────────── */
{
  const router = fs.readFileSync(path.join(REPO, 'server/router.js'), 'utf8');
  /* The roster is handler-less. Undeclared, boot crashes to SERVICE_PAUSED. */
  ok('the roster is declared a library, or the rig will not boot',
     /'api\/r6-operators\.js'/.test(router));

  const registry = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the registry maps r6_draft', /r6_draft:\s*\{/.test(registry));

  const cmds = fs.readFileSync(path.join(REPO, 'functions/api/bot/commands.js'), 'utf8');
  ok('chat dispatches !op', /parsed\.command === '!op'/.test(cmds));
  ok('as a PUBLIC command, before the moderator gate',
     cmds.indexOf("'!op'") < cmds.indexOf('if (!isAuthorizedSender(env, event)) return;'));

  const ovHtml = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay has the panel', /id="ovR6Draft"/.test(ovHtml));
  ok('and loads its driver', /overlay-r6-draft\.js/.test(ovHtml));

  const ovCss = fs.readFileSync(path.join(REPO, 'css/pages/overlay.css'), 'utf8');
  ok('the panel still reaches display:none when hidden',
     /\.ov-r6draft\[hidden\] \{ display: none; \}/.test(ovCss));

  const layout = fs.readFileSync(path.join(REPO, 'functions/api/overlay/layout.js'), 'utf8');
  ok('the layout route stores its position', /'ovR6Draft'/.test(layout));

  const samples = fs.readFileSync(path.join(REPO, 'js/pages/overlay-samples.js'), 'utf8');
  ok('and the editor can place it', /id: 'ovR6Draft'/.test(samples));

  const dashHtml = fs.readFileSync(path.join(REPO, 'overlay-dashboard.html'), 'utf8');
  ok('the dashboard has separate attack and defence buttons',
     /id="odR6AtkBtn"/.test(dashHtml) && /id="odR6DefBtn"/.test(dashHtml));
  ok('plus lock and end', /id="odR6LockBtn"/.test(dashHtml) && /id="odR6EndBtn"/.test(dashHtml));

  const dashJs = fs.readFileSync(path.join(REPO, 'js/pages/overlay-dashboard.js'), 'utf8');
  ok('wired to the route', /'\/api\/r6-draft'/.test(dashJs));
  ok('and the chip says when there is no roster', /No roster/.test(dashJs));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[r6-draft] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[r6-draft] ${passed} assertions passed.`);
console.log('');
