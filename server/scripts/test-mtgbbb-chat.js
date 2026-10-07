#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MTGBBB — GUESS THE RARE, from chat

     node server/scripts/test-mtgbbb-chat.js

   RUNS OFFLINE against a fake KV. Nothing reaches Twitch or Scryfall.

   WHAT THIS IS GUARDING. The command is silent, so every failure mode here is
   invisible from chat and only shows up as "it didn't work" an hour into a box:

     - The first guess locks. The pulls stream in while the window is open, so
       a chatter who could re-guess would be able to wait for information and
       then "call" it.
     - Matching is forgiving but never ambiguous. A unique prefix resolves; a
       prefix matching two cards must resolve to neither, or a lazy guess wins
       a card it did not name.
     - Only a rare or mythic closes the window. Chat guesses the rare slot, and
       a marked common is not the card they called.
     - Entries pay only an account that exists. Crediting a Twitch id that has
       never logged in seeds the monthly draw with an entrant it cannot pay.
     - The panel reaches the idle state. It opens and closes thirty times in a
       box, on a source that stays open all night.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as chat from '../../functions/api/mtgbbb-chat.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const POOL = [
  { name: 'Sheoldred, the Apocalypse', rarity: 'mythic' },
  { name: 'Sheoldred, Whispering One', rarity: 'rare' },
  { name: 'Lightning Bolt', rarity: 'rare' },
  { name: 'Llanowar Elves', rarity: 'common' },
];

function makeEnv({ room = true, profiles = [] } = {}) {
  const store = new Map();
  const chains = new Map();
  if (room) store.set('mtgbbb_BOX1', JSON.stringify({ status: 'active', pool: POOL, pulls: [] }));
  for (const id of profiles) store.set(`profile_${id}`, JSON.stringify({ userId: String(id), login: 'u' + id }));
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

const round = (env) => {
  const r = env._store.get('mtgbbb_guess');
  return r ? JSON.parse(r) : null;
};
const entries = (env, id) => {
  for (const [k, v] of env._store) {
    if (k.startsWith(`gwe_${id}_`)) return JSON.parse(v).entries;
  }
  return 0;
};
async function view(env) {
  const res = await chat.onRequestGet({ env });
  return await res.json();
}

/* ── Matching: forgiving, but never ambiguous ────────────────────────────── */
{
  const names = POOL.map(c => c.name);
  check('an exact name matches', chat.matchCard(names, 'Lightning Bolt'), 'Lightning Bolt');
  check('case and punctuation are discarded', chat.matchCard(names, 'lightningbolt'), 'Lightning Bolt');
  check('and spacing', chat.matchCard(names, '  LIGHTNING   BOLT '), 'Lightning Bolt');
  check('a unique prefix is enough', chat.matchCard(names, 'llanowar'), 'Llanowar Elves');
  /* The one that matters: two cards share this prefix, so it must match
     NEITHER rather than silently picking the first. */
  check('an ambiguous prefix matches nothing', chat.matchCard(names, 'sheoldred'), null);
  check('but the full name disambiguates',
    chat.matchCard(names, 'sheoldred the apocalypse'), 'Sheoldred, the Apocalypse');
  check('an unknown card matches nothing', chat.matchCard(names, 'Black Lotus'), null);
  check('and something too short to mean anything', chat.matchCard(names, 'li'), null);
}

/* ── Nothing happens with no round open ──────────────────────────────────── */
{
  const env = makeEnv();
  const r = await chat.guessFromChat(env, { userId: '1', name: 'a', text: 'Lightning Bolt' });
  check('a guess with no round open is a no-op', r.ok, false);
  check('with no round written', round(env), null);
  check('and the overlay shows nothing', (await view(env)).status, 'none');
}

/* ── A guess lands ───────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  await chat.openGuessRound(env, { code: 'BOX1', pack: 3 });

  const v0 = await view(env);
  check('the overlay opens', v0.status, 'open');
  check('naming the pack', v0.pack, 3);
  check('with nobody in yet', v0.count, 0);
  ok('and a countdown', v0.secondsLeft > 0);

  const r = await chat.guessFromChat(env, { userId: '1', name: 'Alice', text: 'lightning bolt' });
  check('a guess is accepted', r.ok, true);
  check('resolved to the pool name', r.card, 'Lightning Bolt');
  check('and counted', (await view(env)).count, 1);
}

/* ── THE FIRST GUESS LOCKS ───────────────────────────────────────────────── */
{
  const env = makeEnv();
  await chat.openGuessRound(env, { code: 'BOX1', pack: 1 });
  await chat.guessFromChat(env, { userId: '1', name: 'Alice', text: 'Lightning Bolt' });
  const second = await chat.guessFromChat(env, { userId: '1', name: 'Alice', text: 'Llanowar Elves' });

  check('a second guess from the same chatter is refused', second.ok, false);
  check('for that reason specifically', second.reason, 'already');
  check('the first call still stands', round(env).guesses['1'].card, 'Lightning Bolt');
  check('and they are counted once', (await view(env)).count, 1);
}

/* ── Rejections are silent and cost nothing ──────────────────────────────── */
{
  const env = makeEnv();
  await chat.openGuessRound(env, { code: 'BOX1', pack: 1 });
  check('an unknown card is dropped', (await chat.guessFromChat(env, { userId: '9', name: 'x', text: 'Black Lotus' })).reason, 'no-match');
  check('an ambiguous one too', (await chat.guessFromChat(env, { userId: '9', name: 'x', text: 'sheoldred' })).reason, 'no-match');
  check('an empty one too', (await chat.guessFromChat(env, { userId: '9', name: 'x', text: '' })).ok, false);
  check('and none of them counted', (await view(env)).count, 0);
}

/* ── A guess against an ended room is refused ────────────────────────────── */
{
  const env = makeEnv();
  await chat.openGuessRound(env, { code: 'BOX1', pack: 1 });
  env._store.set('mtgbbb_BOX1', JSON.stringify({ status: 'ended', pool: POOL }));
  const r = await chat.guessFromChat(env, { userId: '1', name: 'a', text: 'Lightning Bolt' });
  check('an ended box takes no more guesses', r.reason, 'no-room');
}

/* ── Resolution: who called it ───────────────────────────────────────────── */
{
  const env = makeEnv({ profiles: ['1', '2'] });
  await chat.openGuessRound(env, { code: 'BOX1', pack: 7 });
  await chat.guessFromChat(env, { userId: '1', name: 'Alice', text: 'Lightning Bolt' });
  await chat.guessFromChat(env, { userId: '2', name: 'Bob', text: 'lightningbolt' });
  await chat.guessFromChat(env, { userId: '3', name: 'Carol', text: 'Llanowar Elves' });

  const out = await chat.resolveGuessRound(env, { code: 'BOX1', card: 'Lightning Bolt' });
  check('both callers win', out.winners, 2);
  check('and both are paid, having accounts', out.paid, 2);
  check('Alice got entries', entries(env, '1'), 2);
  check('Bob too', entries(env, '2'), 2);
  check('Carol, who called wrong, got none', entries(env, '3'), 0);

  const v = await view(env);
  check('the overlay flips to resolved', v.status, 'resolved');
  check('naming the card', v.result.card, 'Lightning Bolt');
  check('with both winners', v.result.winners.map(w => w.name), ['Alice', 'Bob']);
  check('both marked paid', v.result.winners.every(w => w.paid), true);
  check('and how many guessed in total', v.result.guessed, 3);
}

/* ── A CHAT-ONLY WINNER IS NAMED BUT NOT PAID ───────────────────────────────
   profile_<id> is written on every login. Crediting an id that has never
   logged in would put an entrant into the monthly draw that cannot be paid. */
{
  const env = makeEnv({ profiles: ['1'] });          // only Alice has an account
  await chat.openGuessRound(env, { code: 'BOX1', pack: 2 });
  await chat.guessFromChat(env, { userId: '1', name: 'Alice', text: 'Lightning Bolt' });
  await chat.guessFromChat(env, { userId: '77', name: 'Lurker', text: 'Lightning Bolt' });

  const out = await chat.resolveGuessRound(env, { code: 'BOX1', card: 'Lightning Bolt' });
  check('both called it', out.winners, 2);
  check('but only the account holder is paid', out.paid, 1);
  check('Alice has entries', entries(env, '1'), 2);
  check('the lurker has none', entries(env, '77'), 0);

  const v = await view(env);
  check('the lurker is still named on the overlay', v.result.winners.map(w => w.name), ['Alice', 'Lurker']);
  check('Alice marked paid', v.result.winners[0].paid, true);
  check('the lurker marked unpaid, so the panel can tell them why', v.result.winners[1].paid, false);
}

/* ── Nobody called it ────────────────────────────────────────────────────── */
{
  const env = makeEnv({ profiles: ['1'] });
  await chat.openGuessRound(env, { code: 'BOX1', pack: 4 });
  await chat.guessFromChat(env, { userId: '1', name: 'Alice', text: 'Llanowar Elves' });

  const out = await chat.resolveGuessRound(env, { code: 'BOX1', card: 'Lightning Bolt' });
  check('no winners', out.winners, 0);
  check('nothing paid', out.paid, 0);
  const v = await view(env);
  check('the overlay still shows what landed', v.result.card, 'Lightning Bolt');
  check('with an empty winners list', v.result.winners, []);
  check('and how many tried', v.result.guessed, 1);
}

/* ── A resolved round takes no more guesses ──────────────────────────────── */
{
  const env = makeEnv();
  await chat.openGuessRound(env, { code: 'BOX1', pack: 1 });
  await chat.resolveGuessRound(env, { code: 'BOX1', card: 'Lightning Bolt' });
  const late = await chat.guessFromChat(env, { userId: '5', name: 'Late', text: 'Lightning Bolt' });
  check('a guess after the reveal is refused', late.ok, false);
  check('for the right reason', late.reason, 'closed');
}

/* ── Resolving the wrong room does nothing ───────────────────────────────── */
{
  const env = makeEnv({ profiles: ['1'] });
  await chat.openGuessRound(env, { code: 'BOX1', pack: 1 });
  await chat.guessFromChat(env, { userId: '1', name: 'Alice', text: 'Lightning Bolt' });
  const out = await chat.resolveGuessRound(env, { code: 'OTHER', card: 'Lightning Bolt' });
  check('another room cannot resolve this round', out.winners, 0);
  check('nobody is paid', entries(env, '1'), 0);
  check('and the round stays open', (await view(env)).status, 'open');
}

/* ── The window expires on its own ───────────────────────────────────────
   The backstop for a pack the host never finishes marking. */
{
  const env = makeEnv();
  await chat.openGuessRound(env, { code: 'BOX1', pack: 1 });
  const r = JSON.parse(env._store.get('mtgbbb_guess'));
  r.closesAt = Date.now() - 1000;
  env._store.set('mtgbbb_guess', JSON.stringify(r));

  check('an expired window reads as nothing on the overlay', (await view(env)).status, 'none');
  check('and takes no guesses', (await chat.guessFromChat(env, { userId: '1', name: 'a', text: 'Lightning Bolt' })).reason, 'closed');
}

/* ── The result stops showing after it has had its moment ────────────────── */
{
  const env = makeEnv();
  await chat.openGuessRound(env, { code: 'BOX1', pack: 1 });
  await chat.resolveGuessRound(env, { code: 'BOX1', card: 'Lightning Bolt' });
  check('the result shows at first', (await view(env)).status, 'resolved');

  const r = JSON.parse(env._store.get('mtgbbb_guess'));
  r.resolvedAt = Date.now() - 60000;
  env._store.set('mtgbbb_guess', JSON.stringify(r));
  check('and clears itself afterwards', (await view(env)).status, 'none');
}

/* ── Opening a new pack replaces the last round ──────────────────────────── */
{
  const env = makeEnv();
  await chat.openGuessRound(env, { code: 'BOX1', pack: 1 });
  await chat.guessFromChat(env, { userId: '1', name: 'Alice', text: 'Lightning Bolt' });
  await chat.openGuessRound(env, { code: 'BOX1', pack: 2 });
  const v = await view(env);
  check('the new pack starts empty', v.count, 0);
  check('at the new number', v.pack, 2);
}

/* ── The wiring that fails silently when missed ──────────────────────────── */
{
  const registry = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the registry maps mtgbbb_guess', /mtgbbb_guess:\s*\{/.test(registry));

  const cmds = fs.readFileSync(path.join(REPO, 'functions/api/bot/commands.js'), 'utf8');
  ok('chat dispatches !guess', /parsed\.command === '!guess'/.test(cmds));
  /* It must sit ABOVE the moderator gate, or only mods could play. */
  ok('as a PUBLIC command, before the moderator gate',
     cmds.indexOf("'!guess'") < cmds.indexOf('if (!isAuthorizedSender(env, event)) return;'));

  const mark = fs.readFileSync(path.join(REPO, 'functions/api/mtgbbb/mark.js'), 'utf8');
  ok('a pack increment opens a round', /openGuessFor = room\.packsOpened/.test(mark));
  ok('only a rare or mythic resolves one',
     /poolCard\.rarity === 'rare' \|\| poolCard\.rarity === 'mythic'/.test(mark));
  ok('and both run after the room lock is released',
     mark.indexOf('mtgbbb-chat.js') > mark.indexOf('{ expirationTtl: GAME_TTL }'));

  const ovHtml = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay has the panel', /id="ovMtgGuess"/.test(ovHtml));
  ok('and loads its driver', /overlay-mtgbbb-guess\.js/.test(ovHtml));

  const ovCss = fs.readFileSync(path.join(REPO, 'css/pages/overlay.css'), 'utf8');
  /* The panel sets display:flex, which beats the UA [hidden] rule — without
     this guard it would stay composited over the capture all stream. */
  ok('the panel still reaches display:none when hidden',
     /\.ov-mtgguess\[hidden\] \{ display: none; \}/.test(ovCss));
  ok('and carries no backdrop-filter', !/\.ov-mtgguess[^{]*\{[^}]*backdrop-filter/.test(ovCss));

  const layout = fs.readFileSync(path.join(REPO, 'functions/api/overlay/layout.js'), 'utf8');
  ok('the layout route stores its position', /'ovMtgGuess'/.test(layout));

  const samples = fs.readFileSync(path.join(REPO, 'js/pages/overlay-samples.js'), 'utf8');
  ok('and the editor can place it', /id: 'ovMtgGuess'/.test(samples));

  const driver = fs.readFileSync(path.join(REPO, 'js/pages/overlay-mtgbbb-guess.js'), 'utf8');
  ok('the driver stands down in layout mode', /get\('layout'\)\) return;/.test(driver));
  ok('and backs off when nothing is running', /IDLE_POLL_MS/.test(driver));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[mtgbbb-chat] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[mtgbbb-chat] ${passed} assertions passed.`);
console.log('');
