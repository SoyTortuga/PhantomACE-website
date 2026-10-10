#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MONTHLY LEADERBOARD AWARDS — test suite

     node server/scripts/test-monthly-awards.js

   Drives the real leaderboards.js + item-codes.js handlers against an
   in-memory store, with the clock faked (global Date) so the month boundary
   can be walked in SEASON_TZ (America/Los_Angeles):

     - the last day of a month awards nothing (it still belongs to the month),
     - the 1st awards the PREVIOUS month, once, labelled with that month,
     - a later day with no prior request still catches the month up,
     - a second request never re-awards,
     - prize codes are restricted to their winner,
     - the champion badge is a game:'profile' badge in the winner's inventory,
     - a score posted on the 1st lands on the fresh board, not in the award,
     - a failed delivery is logged and stays recoverable.
   ══════════════════════════════════════════════ */

const RealDate = Date;
function setClock(iso) {
  const ms = RealDate.parse(iso);
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(ms); }
    static now() { return ms; }
  };
}

const { maybeRunMonthlyAwards, onRequestGet, onRequestPost } =
  await import('../../functions/api/leaderboards.js');
const { onRequestPost: itemCodesPost } = await import('../../functions/api/item-codes.js');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

let whispers = [];
let whisperStatus = 204;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/helix/whispers')) {
    whispers.push({ to: new URL(u).searchParams.get('to_user_id'), message: JSON.parse(opts.body).message });
    return new Response(null, { status: whisperStatus });
  }
  return new Response('{}', { status: 200 });
};

const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

function makeEnv({ claimed = [], failInventory = false } = {}) {
  const store = new Map();
  const months = new Set(claimed);
  const chains = new Map();
  const mutated = [];
  store.set('twitch_bot_token', JSON.stringify({ access_token: 'x', expiresAt: RealDate.now() + 864e5 * 365 }));
  store.set('twitch_bot_user_id', '555');
  return {
    TWITCH_CLIENT_ID: 'cid',
    _store: store,
    _months: months,
    _mutated: mutated,
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        if (failInventory && k.startsWith('inv_')) throw new Error('db down');
        mutated.push(k);
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
      async listValues({ prefix }) {
        const out = [];
        for (const [name, raw] of store) if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        return out;
      },
      async claimMonthlyAward(m) {
        if (months.has(m)) return false;
        months.add(m);
        return true;
      },
    },
  };
}

function seedBoards(env) {
  const put = (k, v) => env._store.set(k, JSON.stringify(v));
  put('lb_mana_clash', [
    { id: '101', name: 'Ash', score: 9000 },
    { id: 'guest_x', name: 'Guesty', score: 8000 },
    { id: '202', name: 'Bry', score: 7000 },
    { id: '303', name: 'Cal', score: 6000 },
    { id: '404', name: 'Dee', score: 5000 },
  ]);
  put('lb_memory_match', [
    { id: '202', name: 'Bry', score: 12 },
    { id: '101', name: 'Ash', score: 15 },
  ]);
  put('sc_leaderboard', [{ id: '101', name: 'Ash', score: '1e50', scoreLog: 50 }]);
  put('lb_phamily_time', [{ id: '101', name: 'Ash', score: 40 }]);
}

const board = (env, k) => JSON.parse(env._store.get(k) || 'null');
const inv = (env, id) => JSON.parse(env._store.get(`inv_${id}`) || 'null');

function cookie(userId) {
  return `pham_session=${encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'U' + userId, role: 'member' }))}`;
}

async function redeem(env, userId, code) {
  const res = await itemCodesPost({
    env,
    request: new Request('https://test.local/api/item-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie(userId) },
      body: JSON.stringify({ action: 'redeem', code }),
    }),
  });
  return { status: res.status, data: await res.json() };
}

async function get(env, q = 'game=all') {
  return onRequestGet({ env, request: new Request(`https://test.local/api/leaderboards?${q}`) });
}

/* ── Last day of September: nothing is awarded ────────────────────────
   8pm Pacific on Sep 30 is already Oct 1 in UTC — the season calendar,
   not UTC, decides. August is settled (steady state). */
{
  setClock('2026-10-01T03:00:00Z');
  whispers = [];
  const env = makeEnv({ claimed: ['2026-08'] });
  seedBoards(env);
  const r = await maybeRunMonthlyAwards(env);
  check('last day: no award runs', r, null);
  ok('last day: September is not claimed', !env._months.has('2026-09'));
  check('last day: boards untouched', board(env, 'lb_mana_clash').length, 5);
  check('last day: nobody whispered', whispers.length, 0);
}

/* ── Oct 1 (Pacific): September awarded once, via the real handler ──── */
{
  setClock('2026-10-01T07:05:00Z');          // 00:05 PDT Oct 1
  whispers = [];
  const env = makeEnv({ claimed: ['2026-08'] });
  seedBoards(env);

  const res = await get(env);
  check('the leaderboard GET still answers', res.status, 200);
  ok('September is claimed', env._months.has('2026-09'));
  ok('October is not', !env._months.has('2026-10'));

  check('mana clash board wiped', board(env, 'lb_mana_clash'), []);
  check('memory match board wiped', board(env, 'lb_memory_match'), []);
  check('all-time skull board NOT wiped', board(env, 'sc_leaderboard').length, 1);
  check('phamily time board NOT wiped', board(env, 'lb_phamily_time').length, 1);
  ok('boards were wiped under mutate()', env._mutated.includes('lb_mana_clash') && env._mutated.includes('lb_memory_match'));

  const ashInv = inv(env, '101');
  const champ = ashInv && ashInv.items.find(i => i.id === 'monthly_mana-clash_2026-09_1');
  ok('1st place badge is in the inventory', !!champ);
  check('champion badge is game:profile', champ && champ.game, 'profile');
  check('champion badge is type:badge', champ && champ.type, 'badge');
  check('champion badge is mythic', champ && champ.rarity, 'mythic');
  check('labelled with the PREVIOUS month', champ && champ.name, 'Mana Clash High Score Champion — September 2026');
  check('marked as a monthly award', champ && champ.source, 'monthly-award');

  check('guest skipped: 2nd place is Bry',
    (inv(env, '202').items.find(i => i.id === 'monthly_mana-clash_2026-09_2') || {}).rarity, 'rare');
  ok('3rd place is Cal', inv(env, '303').items.some(i => i.id === 'monthly_mana-clash_2026-09_3'));
  ok('4th place gets nothing', !inv(env, '404'));
  ok('guest gets nothing', !inv(env, 'guest_x'));
  check('asc board: fewest moves wins',
    (inv(env, '202').items.find(i => i.id === 'monthly_memory-match_2026-09_1') || {}).rarity, 'mythic');

  check('one whisper per winner', whispers.length, 5);
  const ashWhisper = whispers.find(w => w.to === '101' && /Mana Clash/.test(w.message));
  ok('whisper names September', ashWhisper && /September 2026/.test(ashWhisper.message));
  const code = ashWhisper && (ashWhisper.message.match(/backup code ([A-Z0-9]{8})/) || [])[1];
  ok('whisper carries a backup code', !!code);

  const rec = JSON.parse(env._store.get(`item_code_${code}`));
  check('the code is restricted to the winner', rec.restrictedTo, ['101']);
  check('the code item is game:profile', rec.item.game, 'profile');
  ok('the code is active for a week', rec.active && rec.expiresAt - Date.now() === 7 * 86400 * 1000);

  const stranger = await redeem(env, '999', code);
  check('another user cannot redeem it', stranger.status, 404);
  ok('and nothing was granted to them', !inv(env, '999'));
  check('the code was not spent by the stranger', JSON.parse(env._store.get(`item_code_${code}`)).redeemedBy, []);

  const own = await redeem(env, '101', code);
  check('the winner can redeem it', own.status, 200);
  check('redeeming the backup does not duplicate the badge',
    inv(env, '101').items.filter(i => i.id === 'monthly_mana-clash_2026-09_1').length, 1);

  /* A score a game server writes later on the 1st lands on the fresh board.
     (Every prize board is serverOnly now, so this is how scores arrive --
     e.g. memory-match.js recordResult -- not a browser POST.) */
  await env.MARKETPLACE.mutate('lb_memory_match', (lb) => {
    const list = Array.isArray(lb) ? lb : [];
    list.push({ id: '505', name: 'U505', score: 20, updatedAt: Date.now() });
    return list;
  });
  check('it sits alone on the new month board', board(env, 'lb_memory_match').map(e => e.id), ['505']);

  /* Second request: no re-award, the new score survives. */
  whispers = [];
  setClock('2026-10-01T20:00:00Z');
  check('second request: nothing to do', await maybeRunMonthlyAwards(env), null);
  await get(env);
  check('second request: no whispers', whispers.length, 0);
  check('second request: new month board kept', board(env, 'lb_memory_match').map(e => e.id), ['505']);
}

/* ── A POST on the 1st BEFORE any GET still settles the award first ──
   Prize boards refuse browser writes (serverOnly), but the request still
   runs the settle, so September is paid out and wiped even if the only
   traffic on the 1st is a refused POST. */
{
  setClock('2026-10-01T08:00:00Z');
  whispers = [];
  const env = makeEnv({ claimed: ['2026-08'] });
  seedBoards(env);
  const post = await onRequestPost({
    env,
    request: new Request('https://test.local/api/leaderboards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie('606') },
      body: JSON.stringify({ game: 'memory-match', score: 3 }),
    }),
  });
  check('a browser write to a prize board is refused', post.status, 403);
  ok('September settled anyway', env._months.has('2026-09'));
  ok('the refused score did NOT win September', !inv(env, '606'));
  check('and the board was wiped for October', board(env, 'lb_memory_match'), []);
}

/* ── Catch-up: nobody visited on the 1st ──────────────────────────────── */
{
  setClock('2026-10-17T19:00:00Z');
  whispers = [];
  const env = makeEnv({ claimed: ['2026-08'] });
  seedBoards(env);
  const r = await maybeRunMonthlyAwards(env);
  check('catch-up awards the previous month', r && r.month, '2026-09');
  check('catch-up label', r && r.label, 'September 2026');
  ok('catch-up granted the champion', inv(env, '101').items.some(i => i.id === 'monthly_mana-clash_2026-09_1'));
  check('catch-up wiped the board', board(env, 'lb_mana_clash'), []);
  check('catch-up does not repeat', await maybeRunMonthlyAwards(env), null);
}

/* ── Year rollover: Jan 1 awards December of the previous year ───────── */
{
  setClock('2027-01-01T09:00:00Z');
  const env = makeEnv({ claimed: ['2026-11'] });
  seedBoards(env);
  const r = await maybeRunMonthlyAwards(env);
  check('January settles December', r && r.month, '2026-12');
  check('labelled December 2026', r && r.label, 'December 2026');
}

/* ── Two simultaneous requests: exactly one pays out ─────────────────── */
{
  setClock('2026-11-01T08:00:00Z');
  whispers = [];
  const env = makeEnv({ claimed: ['2026-09'] });
  seedBoards(env);
  const [a, b] = await Promise.all([maybeRunMonthlyAwards(env), maybeRunMonthlyAwards(env)]);
  check('exactly one run', [a, b].filter(Boolean).length, 1);
  check('labelled October', (a || b).label, 'October 2026');
  check('winners whispered once', whispers.length, 5);
}

/* ── Failed deliveries are logged and recoverable ────────────────────── */
{
  setClock('2026-10-01T07:05:00Z');
  whispers = [];
  whisperStatus = 500;
  errors.length = 0;
  const env = makeEnv({ claimed: ['2026-08'] });
  seedBoards(env);
  const r = await maybeRunMonthlyAwards(env);
  whisperStatus = 204;
  const ash = r.awards.find(a => a.game === 'mana-clash' && a.place === 1);
  check('whisper failed', ash.whispered, false);
  check('badge still granted', ash.granted, true);
  ok('undelivered whisper logged with the code', errors.some(e => /whisper not delivered/.test(e) && e.includes(ash.code)));
}
{
  setClock('2026-10-01T07:05:00Z');
  errors.length = 0;
  const env = makeEnv({ claimed: ['2026-08'], failInventory: true });
  seedBoards(env);
  const r = await maybeRunMonthlyAwards(env);
  const ash = r.awards.find(a => a.game === 'mana-clash' && a.place === 1);
  check('grant failed', ash.granted, false);
  ok('grant failure logged', errors.some(e => /inventory grant failed/.test(e)));
  ok('a recovery code still exists', !!ash.code);
  const rec = JSON.parse(env._store.get(`item_code_${ash.code}`));
  check('restricted to the winner', rec.restrictedTo, ['101']);
  ok('and active', rec.active);
  const w = whispers.find(x => x.to === '101' && x.message.includes(ash.code));
  ok('the whisper gives it as the way to claim', w && /redeem code/.test(w.message));
}

/* ── Every board has decided whether it pays ───────────────────────
   The settle loop skips a board with no label in MONTHLY_GAME_LABELS. That
   was a bare `continue`, so a board added to BOARDS without a label carried
   no monthly prize and said nothing — wrong for however long it took somebody
   to notice. Omission is a declaration now: a board belongs to the label
   table or to MONTHLY_NO_AWARD, with a reason, and never to neither.

   Read from the source because the tables are module-private, and the point
   is to fail HERE rather than in a log line after a month has settled. */
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = readFileSync(join(repo, 'functions/api/leaderboards.js'), 'utf8');

  const keysOf = (declaration) => {
    const block = new RegExp(`const ${declaration} = \\{([\\s\\S]*?)\\n\\};`).exec(src);
    if (!block) return null;
    return [...block[1].matchAll(/^\s*'([a-z0-9-]+)'\s*:/gm)].map(m => m[1]);
  };

  const boards = keysOf('BOARDS');
  const labelled = keysOf('MONTHLY_GAME_LABELS');
  const exempt = keysOf('MONTHLY_NO_AWARD');
  ok('all three tables parse out of the source', !!boards && !!labelled && !!exempt);
  ok('and there is more than one board to check', boards.length > 1);

  const undeclared = boards.filter(g => !labelled.includes(g) && !exempt.includes(g));
  check('every board either pays a prize or declares why it does not', undeclared, []);

  const both = boards.filter(g => labelled.includes(g) && exempt.includes(g));
  check('and none is in both tables', both, []);

  const strays = [...labelled, ...exempt].filter(g => !boards.includes(g));
  check('neither table names a board that does not exist', strays, []);

  /* The two that pay nothing today, named so a change to either is a visible
     diff rather than a silent one. */
  check('the exempt boards are the two that have their own cycle',
    exempt.slice().sort(), ['phamily-time', 'skull-clicker']);

  /* And an undeclared board is loud, not skipped, if one ever gets through. */
  ok('an undeclared board is logged by name', /not declared in MONTHLY_NO_AWARD/.test(src));
}

console.error = realError;
globalThis.Date = RealDate;

console.log('');
if (failures.length) {
  console.log(`[monthly-awards] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[monthly-awards] ${passed} assertions passed.`);
console.log('');
