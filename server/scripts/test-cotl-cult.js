#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CULT OF THE LAMB — chat names the flock, the site remembers

     node server/scripts/test-cotl-cult.js

   RUNS OFFLINE. The game can tell us nothing — that is the premise.

   WHAT THIS IS GUARDING. The naming round is not just a vote: locking one
   writes a PERMANENT record, so a mistake here is a mistake that lives on a
   public page forever.

     - FIRST SUGGESTER OWNS THE NAME. Several people land on the same good
       name; crediting the last or a random one would make it worth spamming.
     - Identical names merge regardless of case and spacing, or the same name
       typed three ways splits its own vote and loses.
     - A changed suggestion keeps the original timestamp of whoever said the
       NAME first, not of whoever edited last.
     - Locking writes exactly one follower and leaves the roster otherwise
       untouched. Nothing is ever deleted — it is a memorial.
     - Entries pay only an account that exists, same rule as MTGBBB.
     - Cancelling names nobody and writes nothing.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cult from '../../functions/api/cotl-cult.js';

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
      async listValues({ prefix = '' } = {}) {
        const out = [];
        for (const [k, v] of store) if (k.startsWith(prefix)) out.push({ name: k, value: JSON.parse(v) });
        return out;
      },
    },
    _store: store,
  };
}

const suggest = (env, id, text, name) => cult.nameFromChat(env, { userId: id, name: name || ('u' + id), text });
async function view(env) {
  return await (await cult.onRequestGet({ env, request: new Request('https://p.tv/api/cotl-cult') })).json();
}
async function roster(env) {
  return await (await cult.onRequestGet({ env, request: new Request('https://p.tv/api/cotl-cult?roster=1') })).json();
}
const followers = (env) => [...env._store.keys()].filter(k => k.startsWith('cotl_follower_'));
const entries = (env, id) => {
  for (const [k, v] of env._store) if (k.startsWith(`gwe_${id}_`)) return JSON.parse(v).entries;
  return 0;
};

/* ── Name hygiene ────────────────────────────────────────────────────────── */
{
  check('a plain name passes', cult.cleanName('Bleaty'), 'Bleaty');
  check('whitespace is collapsed and trimmed', cult.cleanName('  Sir   Woolington '), 'Sir Woolington');
  check('control characters are stripped', cult.cleanName('Bl\u0000ea\u001fty'), 'Bleaty');
  check('it is bounded', (cult.cleanName('x'.repeat(80)) || '').length, 20);
  check('a one-character name is refused', cult.cleanName('x'), null);
  check('and an empty one', cult.cleanName('   '), null);
  /* Case and spacing fold so one name is one candidate. */
  check('names fold for comparison', cult.nameKey('Sir Woolington'), cult.nameKey('sirwoolington'));
}

/* ── Nothing happens with no round ───────────────────────────────────────── */
{
  const env = makeEnv();
  check('a suggestion with no round open is a no-op', (await suggest(env, '1', 'Bleaty')).ok, false);
  check('and the overlay shows nothing', (await view(env)).status, 'none');
}

/* ── Suggestions tally, and identical names merge ────────────────────────── */
{
  const env = makeEnv();
  await cult.openRound(env);
  await suggest(env, '1', 'Bleaty', 'Alice');
  await suggest(env, '2', 'bleaty', 'Bob');       // same name, typed differently
  await suggest(env, '3', 'BLEATY ', 'Carol');    // and again
  await suggest(env, '4', 'Mutton Chop', 'Dan');

  const v = await view(env);
  check('four people suggested', v.total, 4);
  check('but the three spellings are ONE candidate', v.tally.length, 2);
  check('with the votes merged', v.tally[0].votes, 3);
  check('under the first spelling seen', v.tally[0].name, 'Bleaty');
  check('credited to whoever said it first', v.tally[0].by, 'Alice');
}

/* ── A suggestion can be changed ─────────────────────────────────────────── */
{
  const env = makeEnv();
  await cult.openRound(env);
  await suggest(env, '1', 'Bleaty', 'Alice');
  const changed = await suggest(env, '1', 'Mutton Chop', 'Alice');
  check('a chatter may change their suggestion', changed.ok, true);
  check('reported as a change', changed.changed, true);
  const v = await view(env);
  check('they are still counted once', v.total, 1);
  check('under the new name', v.tally[0].name, 'Mutton Chop');
  check('suggesting the same name again is a no-op', (await suggest(env, '1', 'mutton chop')).reason, 'same');
}

/* ── FIRST SUGGESTER OWNS THE NAME, even after others edit ───────────────── */
{
  const env = makeEnv();
  await cult.openRound(env);
  await suggest(env, '1', 'Bleaty', 'Alice');     // Alice first
  await suggest(env, '2', 'Other', 'Bob');
  await suggest(env, '2', 'Bleaty', 'Bob');       // Bob switches to it later

  const v = await view(env);
  check('the name is still credited to Alice', v.tally[0].by, 'Alice');
  check('with both votes', v.tally[0].votes, 2);
}

/* ── Locking writes exactly one permanent follower ───────────────────────── */
{
  const env = makeEnv({ profiles: ['1'] });
  await cult.openRound(env);
  await suggest(env, '1', 'Bleaty', 'Alice');
  await suggest(env, '2', 'Bleaty', 'Bob');
  await suggest(env, '3', 'Mutton Chop', 'Carol');

  const r = await cult.lockRound(env);
  check('locking succeeds', r.ok, true);
  check('with the most-backed name', r.follower.name, 'Bleaty');
  check('credited to the first suggester', r.follower.namedBy.displayName, 'Alice');
  check('alive to begin with', r.follower.status, 'alive');
  check('exactly one follower is written', followers(env).length, 1);

  const v = await view(env);
  check('the overlay shows the winner', v.winner.name, 'Bleaty');
  check('and who named them', v.winner.namedBy, 'Alice');

  check('Alice is paid, having an account', entries(env, '1'), 2);
  check('Bob, who merely agreed, is not', entries(env, '2'), 0);
}

/* ── A CHAT-ONLY NAMER STILL NAMES, BUT IS NOT PAID ──────────────────────── */
{
  const env = makeEnv();                       // nobody has an account
  await cult.openRound(env);
  await suggest(env, '77', 'Lurkerson', 'Lurker');
  const r = await cult.lockRound(env);
  check('the name still lands', r.follower.name, 'Lurkerson');
  check('still credited to them', r.follower.namedBy.displayName, 'Lurker');
  check('but nothing is paid', r.paid, false);
  check('and no ledger row is invented', entries(env, '77'), 0);
  const v = await view(env);
  check('so the panel can say why', !!v.winner.paid, false);
}

/* ── Locking an empty round does nothing ─────────────────────────────────── */
{
  const env = makeEnv();
  await cult.openRound(env);
  const r = await cult.lockRound(env);
  check('there is nothing to lock', r.ok, false);
  check('no follower is written', followers(env).length, 0);
  check('and the round stays open', (await view(env)).status, 'open');
}

/* ── Cancelling names nobody ─────────────────────────────────────────────── */
{
  const env = makeEnv();
  await cult.openRound(env);
  await suggest(env, '1', 'Bleaty', 'Alice');
  await cult.cancelRound(env);
  check('the panel clears', (await view(env)).status, 'none');
  check('and nobody joined the flock', followers(env).length, 0);
}

/* ── A locked round takes no more suggestions ────────────────────────────── */
{
  const env = makeEnv();
  await cult.openRound(env);
  await suggest(env, '1', 'Bleaty', 'Alice');
  await cult.lockRound(env);
  check('a late suggestion is refused', (await suggest(env, '2', 'Nope')).reason, 'closed');
  check('and the winner is unchanged', (await view(env)).winner.name, 'Bleaty');
}

/* ── The roster accumulates and never forgets ────────────────────────────── */
{
  const env = makeEnv({ profiles: ['1'] });
  for (const name of ['Bleaty', 'Woolington', 'Mutton']) {
    await cult.openRound(env);
    await suggest(env, '1', name, 'Alice');
    await cult.lockRound(env);
  }
  const r = await roster(env);
  check('all three are recorded', r.total, 3);
  check('all alive', r.counts.alive, 3);
  check('all three are named', r.followers.map(f => f.name).sort(), ['Bleaty', 'Mutton', 'Woolington']);
  /* Three rounds locked inside one millisecond is only reachable in a test,
     but the order must still be the SAME order on every read. */
  const again = await roster(env);
  check('and the order is stable across reads',
    again.followers.map(f => f.id), r.followers.map(f => f.id));
  /* The public answer is a memorial, not a user dump. */
  ok('and no account ids are published', r.followers.every(f => f.userId === undefined));
  ok('while still naming who named them', r.followers.every(f => f.namedBy === 'Alice'));
}

/* ── What became of them ─────────────────────────────────────────────────── */
{
  const env = makeEnv({ profiles: ['1'] });
  await cult.openRound(env);
  await suggest(env, '1', 'Bleaty', 'Alice');
  const { follower } = await cult.lockRound(env);

  check('an unknown status is refused', (await cult.setStatus(env, follower.id, 'vibing')).ok, false);
  check('an unknown follower is refused', (await cult.setStatus(env, 'nobody', 'dead')).ok, false);
  check('sacrificing one works', (await cult.setStatus(env, follower.id, 'sacrificed')).ok, true);

  const r = await roster(env);
  check('the roster reflects it', r.followers[0].status, 'sacrificed');
  check('counted as such', r.counts.sacrificed, 1);
  check('and they are NOT removed — it is a memorial', r.total, 1);
}

/* ── Two followers can share a name without colliding ───────────────────── */
{
  const env = makeEnv();
  await cult.openRound(env);
  await suggest(env, '1', 'Bleaty', 'Alice');
  await cult.lockRound(env);
  await cult.openRound(env);
  await suggest(env, '2', 'Bleaty', 'Bob');
  await cult.lockRound(env);
  /* No sleep: same name, same millisecond. The ids must still differ, or the
     second silently erases the first from the memorial. */
  check('both exist as separate records', followers(env).length, 2);
  check('and both are on the roster', (await roster(env)).total, 2);
}

/* ── Only staff may run it ───────────────────────────────────────────────── */
{
  const env = makeEnv();
  env._store.set('site_moderators', JSON.stringify({ entries: [] }));
  const res = await cult.onRequestPost({
    env,
    request: new Request('https://p.tv/api/cotl-cult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open' }),
    }),
  });
  check('an anonymous caller cannot open a round', res.status, 403);
}

/* ── The wiring that fails silently when missed ──────────────────────────── */
{
  const registry = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the registry maps the naming round', /cotl_naming:\s*\{/.test(registry));
  /* The followers are a permanent, growing family — a prefix, never expiring. */
  ok('and the follower prefix, non-expiring',
     /prefix: 'cotl_follower_',[^\n]*expiry: 'none'/.test(registry));

  const cmds = fs.readFileSync(path.join(REPO, 'functions/api/bot/commands.js'), 'utf8');
  ok('chat dispatches !name', /parsed\.command === '!name'/.test(cmds));
  ok('as a PUBLIC command, before the moderator gate',
     cmds.indexOf("'!name'") < cmds.indexOf('if (!isAuthorizedSender(env, event)) return;'));

  const ovHtml = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay has the panel', /id="ovCotl"/.test(ovHtml));
  ok('and loads its driver', /overlay-cotl-cult\.js/.test(ovHtml));

  const ovCss = fs.readFileSync(path.join(REPO, 'css/pages/overlay.css'), 'utf8');
  ok('the panel still reaches display:none when hidden',
     /\.ov-cotl\[hidden\] \{ display: none; \}/.test(ovCss));

  const layout = fs.readFileSync(path.join(REPO, 'functions/api/overlay/layout.js'), 'utf8');
  ok('the layout route stores its position', /'ovCotl'/.test(layout));

  const samples = fs.readFileSync(path.join(REPO, 'js/pages/overlay-samples.js'), 'utf8');
  ok('and the editor can place it', /id: 'ovCotl'/.test(samples));

  const dashHtml = fs.readFileSync(path.join(REPO, 'overlay-dashboard.html'), 'utf8');
  ok('the dashboard can open, lock and cancel',
     /id="odCotlOpenBtn"/.test(dashHtml) && /id="odCotlLockBtn"/.test(dashHtml) && /id="odCotlCancelBtn"/.test(dashHtml));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[cotl-cult] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[cotl-cult] ${passed} assertions passed.`);
console.log('');
