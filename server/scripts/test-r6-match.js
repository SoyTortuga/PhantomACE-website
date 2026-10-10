#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SIEGE MATCH TRACKER — the ranked side rotation

     node server/scripts/test-r6-match.js

   RUNS OFFLINE. There is no R6 API; the whole point of this file is that the
   rotation is deterministic enough to derive without one.

   THE RULES BEING ENCODED:
     Rounds 1-3   the side he started on
     Rounds 4-6   the other side
     First to 4 round wins takes it (4-0, 4-1, 4-2)
     3-3 after six rounds goes to overtime
     Overtime     sides reset, then swap EVERY round; first to 5 wins

   WHAT THIS IS GUARDING. The derived side decides which operator pool the
   draft opens on, so an off-by-one in the rotation puts chat on the wrong
   roster at the tensest moment of a match:

     - The swap lands at round 4, not 3 or 5.
     - A match ending 4-0 never reaches the swap at all.
     - Overtime alternates from round 7 and does NOT inherit the regulation
       rotation.
     - Overtime's side is ASKED FOR, never derived. Until it is given, the
       side reads null and the draft refuses rather than guessing.
     - Swap corrects the ANCHOR, so every later round stays consistent with
       the correction instead of alternating wrongly again.
     - History records the side as it was WHEN PLAYED, so a correction does
       not rewrite what already happened.
     - Undo steps back out of overtime cleanly.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as m from '../../functions/api/r6-match.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

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

async function state(env) {
  return await (await m.onRequestGet({ env, request: new Request('https://p.tv/api/r6-match') })).json();
}
async function season(env) {
  return await (await m.onRequestGet({ env, request: new Request('https://p.tv/api/r6-match?season=1') })).json();
}

/* ── The rotation, computed directly ─────────────────────────────────────── */
{
  const atk = { startSide: 'attack', otStartSide: null };
  check('round 1 is the starting side', m.sideForRound(atk, 1), 'attack');
  check('round 3 still is', m.sideForRound(atk, 3), 'attack');
  /* THE SWAP: round 4, not 3 and not 5. */
  check('round 4 swaps', m.sideForRound(atk, 4), 'defence');
  check('round 6 is still swapped', m.sideForRound(atk, 6), 'defence');

  const def = { startSide: 'defence', otStartSide: null };
  check('and it works from defence too', m.sideForRound(def, 1), 'defence');
  check('swapping at 4', m.sideForRound(def, 4), 'attack');

  /* Overtime must not inherit the regulation rotation. */
  check('overtime without a side given is unknown', m.sideForRound(atk, 7), null);
  const ot = { startSide: 'attack', otStartSide: 'defence' };
  check('overtime round 7 is the overtime side', m.sideForRound(ot, 7), 'defence');
  check('round 8 swaps', m.sideForRound(ot, 8), 'attack');
  check('round 9 swaps back', m.sideForRound(ot, 9), 'defence');
}

/* ── A CLEAN 4-0 STILL CROSSES THE SWAP ─────────────────────────────────
   Easy to get wrong: four wins means winning rounds 1 through 4, and round 4
   is already on the other side. The shortest possible match still changes
   sides once, so the draft has to follow it there. */
{
  const env = makeEnv();
  await m.startMatch(env, 'attack');
  await m.scoreRound(env, 'won');
  check('round 2 is attack', (await state(env)).side, 'attack');
  await m.scoreRound(env, 'won');
  check('round 3 is attack', (await state(env)).side, 'attack');
  await m.scoreRound(env, 'won');
  check('round 4 has already swapped to defence', (await state(env)).side, 'defence');
  const last = await m.scoreRound(env, 'won');
  check('the fourth win ends it', last.finished, true);
  check('4-0', [last.us, last.them], [4, 0]);
  check('and the panel goes quiet', (await state(env)).status, 'none');

  const s = await season(env);
  check('the season records the match', s.matches, 1);
  check('as a win', s.wins, 1);
  check('with its rounds', [s.roundsWon, s.roundsLost], [4, 0]);
}

/* ── The swap at round 4 ─────────────────────────────────────────────────── */
{
  const env = makeEnv();
  await m.startMatch(env, 'attack');
  check('round 1 attack', (await state(env)).side, 'attack');
  /* The panel warns before it happens — that is the moment the draft matters. */
  await m.scoreRound(env, 'won');
  await m.scoreRound(env, 'lost');
  const r3 = await state(env);
  check('round 3 is attack', r3.side, 'attack');
  check('and it says the next one flips', r3.nextSide, 'defence');

  await m.scoreRound(env, 'lost');
  check('round 4 is defence', (await state(env)).side, 'defence');
}

/* ── 3-3 GOES TO OVERTIME, AND ASKS ──────────────────────────────────────── */
{
  const env = makeEnv();
  await m.startMatch(env, 'attack');
  for (const r of ['won', 'lost', 'won', 'lost', 'won', 'lost']) await m.scoreRound(env, r);

  const s = await state(env);
  check('six rounds played, three each', [s.us, s.them], [3, 3]);
  check('it is round 7', s.round, 7);
  check('in overtime', s.overtime, true);
  /* The one thing it cannot derive. */
  check('and it does not guess the side', s.side, null);
  check('it says it is waiting', s.needsOvertimeSide, true);

  /* The draft must refuse rather than open on a guess. */
  const draft = await import('../../functions/api/r6-draft.js');
  check('so auto-open has no side to use', await (await import('../../functions/api/r6-match.js')).activeSide(env), null);

  await m.setOvertimeSide(env, 'defence');
  const s2 = await state(env);
  check('once told, round 7 is defence', s2.side, 'defence');
  check('and it stops asking', s2.needsOvertimeSide, false);
  check('with round 8 flipping', s2.nextSide, 'attack');
}

/* ── Overtime swaps every round, and ends at 5 ───────────────────────────── */
{
  const env = makeEnv();
  await m.startMatch(env, 'attack');
  for (const r of ['won', 'lost', 'won', 'lost', 'won', 'lost']) await m.scoreRound(env, r);
  await m.setOvertimeSide(env, 'attack');

  check('round 7 attack', (await state(env)).side, 'attack');
  await m.scoreRound(env, 'won');            // 4-3
  check('round 8 defence', (await state(env)).side, 'defence');
  const fin = await m.scoreRound(env, 'won'); // 5-3
  check('the fifth win ends overtime', fin.finished, true);
  check('5-3', [fin.us, fin.them], [5, 3]);
  check('recorded as a win', (await season(env)).wins, 1);
}

/* ── Overtime can run to round 9 ─────────────────────────────────────────── */
{
  const env = makeEnv();
  await m.startMatch(env, 'defence');
  for (const r of ['won', 'lost', 'won', 'lost', 'won', 'lost']) await m.scoreRound(env, r);
  await m.setOvertimeSide(env, 'attack');
  await m.scoreRound(env, 'won');            // 4-3, round 8
  await m.scoreRound(env, 'lost');           // 4-4, round 9
  const s = await state(env);
  check('it reaches round 9', s.round, 9);
  check('4-4', [s.us, s.them], [4, 4]);
  check('back on attack', s.side, 'attack');
  const fin = await m.scoreRound(env, 'lost');
  check('and the ninth round settles it', fin.finished, true);
  check('as a loss', (await season(env)).losses, 1);
}

/* ── SWAP CORRECTS THE ANCHOR, not just this round ───────────────────────── */
{
  const env = makeEnv();
  await m.startMatch(env, 'attack');
  const r = await m.swapSides(env);
  check('swapping flips the current side', r.side, 'defence');
  check('round 1 now reads defence', (await state(env)).side, 'defence');

  await m.scoreRound(env, 'won');
  await m.scoreRound(env, 'won');
  check('round 3 is still defence', (await state(env)).side, 'defence');
  /* The correction must survive the rotation, not be undone by it. */
  await m.scoreRound(env, 'won');
  check('and round 4 swaps to attack, consistently', (await state(env)).side, 'attack');
}

/* ── Swapping in overtime moves the overtime anchor ──────────────────────── */
{
  const env = makeEnv();
  await m.startMatch(env, 'attack');
  for (const x of ['won', 'lost', 'won', 'lost', 'won', 'lost']) await m.scoreRound(env, x);
  await m.setOvertimeSide(env, 'attack');
  check('round 7 attack', (await state(env)).side, 'attack');
  await m.swapSides(env);
  check('swapped to defence', (await state(env)).side, 'defence');
  await m.scoreRound(env, 'won');
  check('and round 8 alternates from the correction', (await state(env)).side, 'attack');
}

/* ── History keeps the side as it was WHEN PLAYED ────────────────────────── */
{
  const env = makeEnv();
  await m.startMatch(env, 'attack');
  await m.scoreRound(env, 'won');            // round 1, attack
  await m.swapSides(env);                    // correction from here on
  const h = (await state(env)).history;
  check('the played round still says attack', h[0], { round: 1, side: 'attack', result: 'won' });
}

/* ── Undo ────────────────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  await m.startMatch(env, 'attack');
  await m.scoreRound(env, 'won');
  await m.scoreRound(env, 'lost');
  check('two rounds in', (await state(env)).round, 3);

  await m.undoRound(env);
  const s = await state(env);
  check('back to round 2', s.round, 2);
  check('with the score corrected', [s.us, s.them], [1, 0]);
  check('and the history trimmed', s.history.length, 1);
}

/* ── Undo steps back out of overtime ─────────────────────────────────────── */
{
  const env = makeEnv();
  await m.startMatch(env, 'attack');
  for (const x of ['won', 'lost', 'won', 'lost', 'won', 'lost']) await m.scoreRound(env, x);
  check('in overtime', (await state(env)).overtime, true);
  await m.undoRound(env);
  const s = await state(env);
  check('undoing leaves overtime behind', s.overtime, false);
  check('back in regulation at round 6', s.round, 6);
  /* And the derived side is regulation's again, not a stale overtime one. */
  check('on the swapped regulation side', s.side, 'defence');
}

/* ── Nothing to do with no match ─────────────────────────────────────────── */
{
  const env = makeEnv();
  check('no match reads as none', (await state(env)).status, 'none');
  check('scoring does nothing', (await m.scoreRound(env, 'won')).ok, false);
  check('swapping does nothing', (await m.swapSides(env)).ok, false);
  check('undo does nothing', (await m.undoRound(env)).ok, false);
  check('an overtime side cannot be set', (await m.setOvertimeSide(env, 'attack')).ok, false);
  check('and a bad side is refused', (await m.startMatch(env, 'sideways')).ok, false);
}

/* ── The season accumulates ──────────────────────────────────────────────── */
{
  const env = makeEnv();
  for (const win of [true, false, true]) {
    await m.startMatch(env, 'attack');
    for (let i = 0; i < 4; i++) await m.scoreRound(env, win ? 'won' : 'lost');
  }
  const s = await season(env);
  check('three matches', s.matches, 3);
  check('two won', s.wins, 2);
  check('one lost', s.losses, 1);
  check('rounds tallied', [s.roundsWon, s.roundsLost], [8, 4]);
}

/* ── Only staff may track ────────────────────────────────────────────────── */
{
  const env = makeEnv();
  env._store.set('site_moderators', JSON.stringify({ entries: [] }));
  const res = await m.onRequestPost({
    env,
    request: new Request('https://p.tv/api/r6-match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', side: 'attack' }),
    }),
  });
  check('an anonymous caller cannot start a match', res.status, 403);
}

/* ── Wiring ──────────────────────────────────────────────────────────────── */
{
  const registry = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the registry maps the live match', /r6_match:\s*\{/.test(registry));
  ok('and the season record, non-expiring',
     /prefix: 'r6_season_',[^\n]*expiry: 'none'/.test(registry));

  /* THE RECORD HAS TO BE READ BY SOMETHING. Every finished match updated
     r6_season_<month> and ?season=1 returned it, but nothing on the site ever
     called that endpoint -- so the record accumulated, correctly, for nobody.
     A number kept and never shown is indistinguishable from one not kept. */
  const dash = fs.readFileSync(path.join(REPO, 'js/pages/overlay-dashboard.js'), 'utf8');
  ok('the dashboard asks for the season record', /r6-match\?season=1/.test(dash));
  ok('and puts it on the match chip', /seasonSuffix\(/.test(dash) &&
     /odR6MatchChip/.test(dash));
  ok('a failed season read still leaves the live match on the chip',
     /\.catch\(\(\) => null\)/.test(dash));

  const draft = fs.readFileSync(path.join(REPO, 'functions/api/r6-draft.js'), 'utf8');
  ok('the draft can open on the tracked side', /action === 'auto'/.test(draft));
  ok('and refuses rather than guessing when there is none',
     /No tracked match/.test(draft));

  const dashHtml = fs.readFileSync(path.join(REPO, 'overlay-dashboard.html'), 'utf8');
  ok('the dashboard can start a match on either side',
     /id="odR6StartAtkBtn"/.test(dashHtml) && /id="odR6StartDefBtn"/.test(dashHtml));
  ok('score, swap and undo', /id="odR6WonBtn"/.test(dashHtml) && /id="odR6SwapBtn"/.test(dashHtml) && /id="odR6UndoBtn"/.test(dashHtml));
  ok('ask for the overtime side', /id="odR6OtRow"/.test(dashHtml));
  ok('and open the draft without naming a side', /id="odR6AutoBtn"/.test(dashHtml));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[r6-match] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[r6-match] ${passed} assertions passed.`);
console.log('');
