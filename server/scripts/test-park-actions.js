#!/usr/bin/env node
/* ══════════════════════════════════════════════
   VISITING — THE THINGS YOU CAN DO THERE

     node server/scripts/test-park-actions.js

   RUNS OFFLINE against a KV shim.

   Visiting used to be read-only. Clearing someone's rubbish and signing
   their guest book are the two things worth leaving behind, and both of
   them run into the same wall: a park save is written by exactly one
   browser, its owner's, and a visitor is not that browser.

   WHAT MATTERS:

     - A TIDY REACHES THE OWNER AS AN OP, never as a direct edit. A
       visitor writing the owner's save would be erased by the owner's
       next sync, which happens every twenty seconds — the change would
       simply vanish and nobody would know why.

     - THE TALLY IS CLAIMED BEFORE THE WORK. Spending the allowance after
       doing the writes would let a burst of parallel requests each see an
       unspent allowance and all go through.

     - CONSENT IS CHECKED EVERY TIME. A park that has closed to visitors
       must be closed to these too, not just to looking.

     - A NOTE IS TEXT, not markup, and one per park per day.
   ══════════════════════════════════════════════ */

import * as visit from '../../functions/api/park-visit.js';
import { resolveKey } from '../lib/registry.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* The shim resolves through the REAL registry: an unregistered key must
   throw here exactly as it does in production. Both new prefixes
   (parkbook_, parkact_) are new, and an unmapped one would 500 the route
   in a way nothing else would catch. */
function makeEnv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  const guard = (k, op) => {
    if (!resolveKey(k)) throw new Error(`${op}() key "${k}" has no table mapping`);
  };
  return {
    MARKETPLACE: {
      async get(k, t) { guard(k, 'get'); if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { guard(k, 'put'); store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { guard(k, 'delete'); store.delete(k); },
      async mutate(k, fn) {
        guard(k, 'mutate');
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next !== undefined) store.set(k, JSON.stringify(next));
        return next;
      },
      async list() { return { keys: [] }; },
    },
    _read: (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
    _has: (k) => store.has(k),
  };
}

const as = (id, name = 'Visitor') =>
  'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: name }));

async function POST(env, body, cookie) {
  const request = new Request('https://phantomace.tv/api/park-visit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const res = await visit.onRequestPost({ env, request });
  return { status: res.status, data: await res.json() };
}

async function GET(env, owner) {
  const request = new Request('https://phantomace.tv/api/park-visit?owner=' + owner);
  const res = await visit.onRequestGet({ env, request });
  return { status: res.status, data: await res.json() };
}

/* An owner open to visitors, with a save and some rubbish in it. */
const OWNER = '500';
function world(extra = {}) {
  return makeEnv({
    [`parkpub_${OWNER}`]: { name: 'Keeper' },
    [`dino_park_${OWNER}`]: {
      userId: OWNER,
      state: { saveEpoch: 2, coins: 10, park: [], vault: [], eggs: [], debris: [{ id: 'a' }, { id: 'b' }] },
    },
    'dino_park_100': { userId: '100', state: { saveEpoch: 2, coins: 0, park: [], vault: [], eggs: [] } },
    ...extra,
  });
}

/* ── Who may act ─────────────────────────────────────────────────────── */
{
  const env = world();
  check('a guest cannot tidy', (await POST(env, { action: 'tidy', owner: OWNER })).status, 401);
  check('nor sign', (await POST(env, { action: 'sign', owner: OWNER, text: 'hi' })).status, 401);

  check('you cannot tidy your own park',
    (await POST(env, { action: 'tidy', owner: OWNER }, as(OWNER))).status, 400);

  check('an unknown park is refused',
    (await POST(env, { action: 'tidy', owner: 'abc' }, as('100'))).status, 404);

  /* CONSENT, every time. */
  const closed = makeEnv({ 'dino_park_900': { userId: '900', state: { saveEpoch: 2 } } });
  check('a park that is not open to visitors is refused',
    (await POST(closed, { action: 'tidy', owner: '900' }, as('100'))).status, 403);

  check('an unknown action is refused',
    (await POST(env, { action: 'burn', owner: OWNER }, as('100'))).status, 400);
}

/* ── A TIDY REACHES THE OWNER AS AN OP ───────────────────────────────── */
{
  const env = world();
  const res = await POST(env, { action: 'tidy', owner: OWNER }, as('100', 'Tidy Pat'));
  check('tidying is accepted', res.status, 200);
  ok('and pays the visitor', res.data.reward > 0);

  const owner = env._read(`dino_park_${OWNER}`);
  const ops = owner.state.marketOps || [];
  const tidy = ops.find(o => o.t === 'tidy');
  ok('an op lands on the owner save', !!tidy);
  check('saying how many, never which', tidy.n, 1);
  /* The op's own id is required (it is what makes it apply once); what
     must NOT be there is any reference to a particular piece of rubbish,
     because the visitor was looking at a snapshot. */
  check('the op names a count and nothing else', Object.keys(tidy).sort(), ['at', 'by', 'id', 'n', 't']);
  ok('and it says who did it', /Tidy Pat/.test(tidy.by || ''));
  ok('every op carries an id so it applies exactly once', !!tidy.id);

  /* THE OWNER'S OWN DEBRIS IS UNTOUCHED HERE. It is their client that
     removes it, when it applies the op — the server editing it directly
     is the thing that would be overwritten on their next sync. */
  check('the server does not edit their yard itself', owner.state.debris.length, 2);

  /* The visitor is paid the same way, because their save has exactly one
     writer too. */
  const visitor = env._read('dino_park_100');
  const coinOp = (visitor.state.marketOps || []).find(o => o.t === 'coins');
  ok('the reward travels as an op on the visitor save', !!coinOp);
  ok('and it is a credit', coinOp.d > 0);
}

/* ── The caps ────────────────────────────────────────────────────────── */
{
  const env = world();
  let okCount = 0;
  for (let i = 0; i < 8; i++) {
    const r = await POST(env, { action: 'tidy', owner: OWNER }, as('100'));
    if (r.status === 200) okCount++;
  }
  ok('one park can only be tidied a few times a day', okCount > 0 && okCount < 8);
  const last = await POST(env, { action: 'tidy', owner: OWNER }, as('100'));
  check('and then it says so plainly', last.status, 429);

  const tally = env._read('parkact_100');
  ok('the tally is kept per visitor', !!tally && !!tally.tidied);
  check('and counted per park', tally.tidied[OWNER], okCount);

  /* A different visitor is unaffected. */
  const other = await POST(env, { action: 'tidy', owner: OWNER }, as('101'));
  check('somebody else can still help', other.status, 200);
}
{
  /* A new day is a clean slate. */
  const env = world({ 'parkact_100': { day: '1999-1-1', tidied: { [OWNER]: 99 }, signed: [OWNER] } });
  check('yesterday\'s tally does not block today',
    (await POST(env, { action: 'tidy', owner: OWNER }, as('100'))).status, 200);
  check('nor yesterday\'s signature',
    (await POST(env, { action: 'sign', owner: OWNER, text: 'back again' }, as('100'))).status, 200);
}

/* ── The guest book ──────────────────────────────────────────────────── */
{
  const env = world();
  check('an empty book reads as empty', (await GET(env, OWNER)).data.entries, []);

  const res = await POST(env, { action: 'sign', owner: OWNER, text: '  Lovely park.  ' }, as('100', 'Pat'));
  check('a note can be left', res.status, 200);

  const book = (await GET(env, OWNER)).data.entries;
  check('it is in the book', book.length, 1);
  check('trimmed', book[0].text, 'Lovely park.');
  check('and attributed', book[0].name, 'Pat');

  check('the same visitor cannot sign twice in a day',
    (await POST(env, { action: 'sign', owner: OWNER, text: 'again' }, as('100'))).status, 429);
  check('and the book did not grow', (await GET(env, OWNER)).data.entries.length, 1);

  check('an empty note is refused',
    (await POST(env, { action: 'sign', owner: OWNER, text: '   ' }, as('101'))).status, 400);

  /* A note is TEXT. The client escapes it on render, and control
     characters and runaway whitespace are stripped before storage so a
     book entry cannot be used to lay out the page. */
  await POST(env, { action: 'sign', owner: OWNER, text: 'a\n\n\nb\u0007c' }, as('102', 'Odd'));
  const odd = (await GET(env, OWNER)).data.entries.find(e => e.name === 'Odd');
  check('newlines and control characters are flattened', odd.text, 'a b c');

  await POST(env, { action: 'sign', owner: OWNER, text: 'x'.repeat(500) }, as('103'));
  const long = (await GET(env, OWNER)).data.entries[0];
  ok('and a note is length-capped', long.text.length <= 140);

  const newest = (await GET(env, OWNER)).data.entries;
  ok('newest first', newest[0].text.startsWith('x'));
}

/* ── Keys ────────────────────────────────────────────────────────────
   Both prefixes are new. An unmapped key throws on every read, which is
   how a feature ships looking fine and 500s on the rig. */
{
  ok('parkbook_ is mapped', !!resolveKey('parkbook_500'));
  ok('parkact_ is mapped', !!resolveKey('parkact_100'));
}

/* ── A park with no save ─────────────────────────────────────────────
   Open to visitors but nothing stored yet. Tidying must not throw. */
{
  const env = makeEnv({ 'parkpub_700': { name: 'New' }, 'dino_park_100': { userId: '100', state: { saveEpoch: 2, coins: 0 } } });
  const res = await POST(env, { action: 'tidy', owner: '700' }, as('100'));
  ok('it does not throw', res.status === 200 || res.status === 429);
  ok('and writes no save for a park that has none', !env._has('dino_park_700'));
}

console.log('');
if (failures.length) {
  console.log(`[park-actions] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[park-actions] ${passed} assertions passed.`);
console.log('');
