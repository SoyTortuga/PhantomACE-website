#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO MARKET — server-authoritative settlement + grant integrity

     node server/scripts/test-dino-market.js

   The marketplace settles against the players' park saves (escrow on list,
   debit on buy, credit to the seller) and every settlement rides the
   grantSeq/409 protocol. The client half — adoptServerGrants and the
   consumed-grant ledger — is lifted out of the page and run against the
   real handlers, so a stale tab is simulated end to end rather than
   asserted by regex.

   The fake store serialises mutate() and withLock() per name exactly as
   the Postgres advisory lock does (both hash the same name), yields
   between every read and write so races can interleave, and implements
   claim() as an atomic take.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Market from '../../functions/api/marketplace.js';
import * as Park from '../../functions/api/dino-park.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const page = fs.readFileSync(path.join(REPO, 'games/dino-park/index.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── Fake store ─────────────────────────────────────────────────────── */
const tick = () => new Promise(r => setImmediate(r));

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  const locks = new Map();
  async function locked(name, fn) {
    const prev = locks.get(name) || Promise.resolve();
    let release;
    const mine = new Promise(r => { release = r; });
    const tail = prev.then(() => mine);
    locks.set(name, tail);
    await prev;
    try { return await fn(); } finally {
      release();
      if (locks.get(name) === tail) locks.delete(name);
    }
  }
  const read = (k) => (store.has(k) ? JSON.parse(store.get(k)) : null);
  const write = (k, v) => store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const listValues = async ({ prefix = '' } = {}) => {
    await tick();
    return [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, value: read(name) }));
  };
  return {
    store, read,
    async get(k, t) { await tick(); const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { await tick(); write(k, v); },
    async delete(k) { await tick(); store.delete(k); },
    async list({ prefix = '' } = {}) { await tick(); return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
    listValues,
    async claim(k) { await tick(); const v = read(k); store.delete(k); return v; },
    mutate(k, fn) {
      return locked(k, async () => {
        await tick();
        const cur = read(k);
        const next = await fn(cur);
        if (next === undefined) return cur;
        await tick();
        write(k, next);
        return next;
      });
    },
    withLock(name, fn) {
      return locked(name, () => fn({
        async get(k, t) { await tick(); const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
        async put(k, v) { await tick(); write(k, v); },
        async delete(k) { await tick(); store.delete(k); },
        listValues,
      }));
    },
  };
}

/* ── Request helpers ────────────────────────────────────────────────── */
const cookie = (id, name) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: name || ('P' + id) })) });
async function call(handler, env, url, { method = 'GET', body, as } = {}) {
  const init = { method, headers: { 'Content-Type': 'application/json', ...(as ? cookie(as) : {}) } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await handler({ env, request: new Request('https://phantomace.tv' + url, init) });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}
const mkt = (env, body, as) => call(Market.onRequestPost, env, '/api/marketplace', { method: 'POST', body, as });
const mktGet = (env, qs, as) => call(Market.onRequestGet, env, '/api/marketplace' + qs, { as });
const savePost = (env, state, as) => call(Park.onRequestPost, env, '/api/dino-park', { method: 'POST', body: { state }, as });

const EPOCH = 2;
const dino = (uid, extra = {}) => ({ speciesId: 'compy', nickname: '', careCount: 3, xp: 40, mutation: null, uid, hunger: 80, ...extra });
function save(userId, { park = [], vault = [], coins = 100, grantSeq = 0, eggs = [], ...rest } = {}) {
  return { userId, savedAt: 1, state: { saveEpoch: EPOCH, coins, level: 1, xp: 0, park, vault, eggs, discovered: [], discoveredMutations: [], grantSeq, ...rest } };
}
const clone = (v) => JSON.parse(JSON.stringify(v));

/* ── The client's adoption path, lifted from the page ──────────────── */
function fnSource(name) {
  const start = page.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in the page`);
  const open = page.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < page.length; j++) {
    if (page[j] === '{') depth++;
    else if (page[j] === '}') { depth--; if (depth === 0) return page.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
const constLine = (name) => {
  const m = page.match(new RegExp(`const ${name} = [^;]+;`));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
};
function clientWith(initial) {
  return new Function('initial', `
    let state = initial;
    let selectedDinoIdx = -1, collSelectedIdx = -1;
    const MAX_ACTIVE_PARK = 10, MAX_VAULT_SIZE = 200;
    const window = { crypto: globalThis.crypto };
    function initDinoPosition() {}
    ${constLine('CONSUMED_GRANTS_MAX')}
    ${constLine('APPLIED_OPS_MAX')}
    ${fnSource('markGrantsConsumed')}
    ${fnSource('newDinoUid')}
    ${fnSource('backfillUid')}
    ${fnSource('ensureDinoUids')}
    ${fnSource('removeDinos')}
    ${fnSource('addNewDino')}
    ${fnSource('adoptServerGrants')}
    return { get state() { return state; }, adoptServerGrants, markGrantsConsumed, ensureDinoUids };
  `)(initial);
}
/* What doServerSave does: POST, and on a 409 adopt and retry once. */
async function clientSave(env, client, as) {
  let r = await savePost(env, client.state, as);
  if (r.status === 409) {
    client.adoptServerGrants(r.data.state);
    r = await savePost(env, client.state, as);
  }
  return r;
}

/* ══ Catalog validation ═════════════════════════════════════════════ */
{
  ok('a real species is known', Park.isKnownSpecies('trex'));
  ok('a made-up species is not', !Park.isKnownSpecies('godzilla'));
  ok('prototype keys are not species', !Park.isKnownSpecies('constructor'));
  ok('no mutation is fine', Park.isKnownMutation('trex', null));
  ok('a global mutation is known', Park.isKnownMutation('trex', 'phantomace'));
  ok('a colour swap is known', Park.isKnownMutation('trex', 'crimson'));
  ok('the species own special is known', Park.isKnownMutation('trex', 'sp_trex'));
  ok('another species rare is not', !Park.isKnownMutation('trex', 'rare_compy'));
  ok('junk is not', !Park.isKnownMutation('trex', '<script>'));
}

/* ══ List — ownership, escrow, validation ═══════════════════════════ */
{
  const env = { MARKETPLACE: fakeKV({ dino_park_1: save('1', { park: [dino('a1')] }) }) };
  const before = JSON.stringify(env.MARKETPLACE.read('dino_park_1'));

  const r = await mkt(env, { action: 'list', uid: 'not-mine', price: 50 }, '1');
  check('listing a dino not in the seller save is refused', r.status, 403);
  check('and no listing is created', (await env.MARKETPLACE.listValues({ prefix: 'listing_' })).length, 0);
  check('and the save is untouched', JSON.stringify(env.MARKETPLACE.read('dino_park_1')), before);

  const legacy = await mkt(env, { action: 'list', dino: { speciesId: 'trex', mutation: 'rare_trex' }, price: 50 }, '1');
  check('a client-described dino (the old protocol) is refused', legacy.status, 400);

  const someoneElse = await mkt(env, { action: 'list', uid: 'a1', price: 50 }, '2');
  check('another player cannot list my dino by its uid', someoneElse.status, 403);

  const forged = await mkt(env, {
    action: 'list', uid: 'f1', price: 50,
    state: { ...clone(env.MARKETPLACE.read('dino_park_1').state), park: [dino('f1', { speciesId: 'godzilla' })] },
  }, '1');
  check('a dino of an unknown species cannot be listed', forged.status, 400);
  const badMut = await mkt(env, {
    action: 'list', uid: 'm1', price: 50,
    state: { ...clone(env.MARKETPLACE.read('dino_park_1').state), park: [dino('m1', { mutation: 'rare_trex' })] },
  }, '1');
  check('nor one carrying another species mutation', badMut.status, 400);
}
{
  const env = { MARKETPLACE: fakeKV({ dino_park_1: save('1', { park: [dino('a1', { nickname: 'Chompy', xp: 777 }), dino('a2')], grantSeq: 4 }) }) };
  const r = await mkt(env, { action: 'list', uid: 'a1', price: 120 }, '1');
  check('listing an owned dino succeeds', r.status, 200);
  const s = env.MARKETPLACE.read('dino_park_1').state;
  check('the dino is escrowed out of the server save', s.park.map(d => d.uid), ['a2']);
  check('grantSeq is bumped so stale saves are refused', s.grantSeq, 5);
  check('an out op records the escrow', s.marketOps.map(o => [o.t, o.uid]), [['out', 'a1']]);
  ok('and the server state is marked as having applied it', s.appliedOps.includes(s.marketOps[0].id));
  const listing = env.MARKETPLACE.read('listing_' + r.data.id);
  check('the listing carries the escrowed dino, not request data', [listing.dino.speciesId, listing.dino.nickname, listing.dino.xp], ['compy', 'Chompy', 777]);
  check('and the server price', listing.price, 120);
  ok('the response hands back the state to adopt', r.data.state && r.data.state.grantSeq === 5);

  const again = await mkt(env, { action: 'list', uid: 'a1', price: 120 }, '1');
  check('the same dino cannot be listed twice', again.status, 403);
}
{
  /* With the client's state: a dino hatched since the last throttled sync
     is listable, but a state that predates a grant is refused. */
  const env = { MARKETPLACE: fakeKV({ dino_park_1: save('1', { park: [], grantSeq: 2 }) }) };
  const local = clone(env.MARKETPLACE.read('dino_park_1').state);
  local.park.push(dino('fresh'));
  const r = await mkt(env, { action: 'list', uid: 'fresh', price: 10, state: local }, '1');
  check('a dino only in the incoming (current) state is listable', r.status, 200);
  check('and the written save is that state minus the dino', env.MARKETPLACE.read('dino_park_1').state.park.length, 0);

  const stale = clone(local);
  stale.grantSeq = 1;
  stale.park = [dino('old')];
  const s = await mkt(env, { action: 'list', uid: 'old', price: 10, state: stale }, '1');
  check('a state older than a grant is refused with 409', s.status, 409);
  ok('and carries the server state to merge', s.data.state && s.data.state.grantSeq === 3);
}
{
  const park = Array.from({ length: 10 }, (_, i) => dino('c' + i));
  const vault = Array.from({ length: 4 }, (_, i) => dino('v' + i));
  const env = { MARKETPLACE: fakeKV({ dino_park_1: save('1', { park, vault }) }) };
  const uids = [...park, ...vault].map(d => d.uid);
  const results = await Promise.all(uids.map(uid => mkt(env, { action: 'list', uid, price: 5 }, '1')));
  check('fourteen concurrent listings: exactly ten are accepted', results.filter(r => r.status === 200).length, 10);
  check('ten listings exist', (await env.MARKETPLACE.listValues({ prefix: 'listing_' })).length, 10);
  const s = env.MARKETPLACE.read('dino_park_1').state;
  check('and exactly those ten dinos left the save', s.park.length + s.vault.length, 4);
}

/* ══ Buy — debit, credit, one winner ════════════════════════════════ */
async function listed(seedExtra = {}) {
  const env = { MARKETPLACE: fakeKV({
    dino_park_1: save('1', { park: [dino('s1', { speciesId: 'trex', mutation: 'sp_trex', xp: 900 })], coins: 50 }),
    dino_park_2: save('2', { coins: 500, grantSeq: 7 }),
    dino_park_3: save('3', { coins: 500 }),
    ...seedExtra,
  }) };
  const r = await mkt(env, { action: 'list', uid: 's1', price: 120 }, '1');
  return { env, id: r.data.id };
}
{
  const { env, id } = await listed();
  const r = await mkt(env, { action: 'buy', listingId: id }, '2');
  check('a buyer with the coins can buy', r.status, 200);
  const b = env.MARKETPLACE.read('dino_park_2').state;
  check('the buyer is debited server-side', b.coins, 380);
  check('the dino lands in the buyer save', b.park.map(d => [d.speciesId, d.mutation, d.xp]), [['trex', 'sp_trex', 900]]);
  ok('as a grant the client can adopt', b.park[0].grantId && b.park[0].grantId === r.data.grantId);
  ok('with a fresh uid, never the seller one', b.park[0].uid && b.park[0].uid !== 's1');
  check('the buyer grantSeq is bumped', b.grantSeq, 8);
  check('a coins op records the debit', b.marketOps.filter(o => o.t === 'coins').map(o => o.d), [-120]);
  ok('the species and mutation are discovered', b.discovered.includes('trex') && b.discoveredMutations.includes('trex_sp_trex'));

  const s = env.MARKETPLACE.read('dino_park_1').state;
  check('the seller is credited exactly once, in their save', s.coins, 170);
  check('by one coins op', s.marketOps.filter(o => o.t === 'coins').map(o => o.d), [120]);
  const earn = env.MARKETPLACE.read('earnings_1');
  check('earnings keeps the sale notice but owes nothing more', [earn.amount, earn.sales.length, earn.sales[0].credited], [0, 1, true]);
  check('the listing is gone', env.MARKETPLACE.read('listing_' + id), null);

  const again = await mkt(env, { action: 'buy', listingId: id }, '3');
  check('it cannot be bought twice', again.status, 404);
}
{
  const { env, id } = await listed({ dino_park_2: save('2', { coins: 30 }) });
  const r = await mkt(env, { action: 'buy', listingId: id }, '2');
  check('a buyer without the coins is refused', r.status, 400);
  check('their coins are untouched', env.MARKETPLACE.read('dino_park_2').state.coins, 30);
  ok('and the listing stays up', env.MARKETPLACE.read('listing_' + id));
  check('the seller is not paid', env.MARKETPLACE.read('dino_park_1').state.coins, 50);

  /* The old exploit: the client claims to be rich. Its state is the save
     being written, at the same trust as a plain POST, but it cannot dodge
     the debit — the debit is applied to whatever balance it states. */
  const noSave = { MARKETPLACE: fakeKV({ dino_park_1: save('1', { park: [dino('z1')] }) }) };
  const l = await mkt(noSave, { action: 'list', uid: 'z1', price: 999 }, '1');
  const free = await mkt(noSave, { action: 'buy', listingId: l.data.id }, '9');
  check('a buyer with no save (100 starter coins) cannot take a 999 dino', free.status, 400);
}
{
  const { env, id } = await listed();
  const [a, b] = await Promise.all([
    mkt(env, { action: 'buy', listingId: id }, '2'),
    mkt(env, { action: 'buy', listingId: id }, '3'),
  ]);
  check('two concurrent buyers: exactly one wins', [a.status, b.status].sort(), [200, 404]);
  const coins = [env.MARKETPLACE.read('dino_park_2').state.coins, env.MARKETPLACE.read('dino_park_3').state.coins].sort();
  check('exactly one buyer is debited', coins, [380, 500]);
  const delivered = env.MARKETPLACE.read('dino_park_2').state.park.length + env.MARKETPLACE.read('dino_park_3').state.park.length;
  check('exactly one dino is delivered', delivered, 1);
  check('the seller is credited once', env.MARKETPLACE.read('dino_park_1').state.coins, 170);
  check('one sale is recorded', env.MARKETPLACE.read('earnings_1').sales.length, 1);
}
{
  const { env, id } = await listed();
  const [buy, cancel] = await Promise.all([
    mkt(env, { action: 'buy', listingId: id }, '2'),
    mkt(env, { action: 'cancel', listingId: id }, '1'),
  ]);
  check('a buy racing a cancel: exactly one wins', [buy.status, cancel.status].filter(s => s === 200).length, 1);
  const total = env.MARKETPLACE.read('dino_park_1').state.park.length + env.MARKETPLACE.read('dino_park_2').state.park.length;
  check('and the dino exists exactly once', total, 1);
}
{
  const { env, id } = await listed();
  const r = await mkt(env, { action: 'cancel', listingId: id }, '1');
  check('cancel succeeds for the seller', r.status, 200);
  const s = env.MARKETPLACE.read('dino_park_1').state;
  check('the escrowed dino is granted back', s.park.map(d => [d.speciesId, d.xp, d.grantSource]), [['trex', 900, 'market-cancel']]);
  ok('with a fresh uid and a grantId', s.park[0].uid !== 's1' && s.park[0].grantId);
  check('a stranger cannot cancel it', (await mkt(env, { action: 'cancel', listingId: id }, '2')).status, 404);
}

/* ══ Expiry and earnings ════════════════════════════════════════════ */
{
  const { env, id } = await listed();
  const l = env.MARKETPLACE.read('listing_' + id);
  l.listedAt = Date.now() - 8 * 86400000;
  env.MARKETPLACE.store.set('listing_' + id, JSON.stringify(l));
  const browse = await mktGet(env, '', '3');
  check('an expired listing is not offered', browse.data.length, 0);
  check('it is swept back to the seller', env.MARKETPLACE.read('dino_park_1').state.park.map(d => d.grantSource), ['market-expired']);
  check('and the row is gone', env.MARKETPLACE.read('listing_' + id), null);
  const late = await mkt(env, { action: 'buy', listingId: id }, '2');
  check('it cannot be bought after expiry', late.status, 404);
}
{
  const { env, id } = await listed();
  const l = env.MARKETPLACE.read('listing_' + id);
  l.listedAt = Date.now() - 8 * 86400000;
  env.MARKETPLACE.store.set('listing_' + id, JSON.stringify(l));
  env.MARKETPLACE.store.set('earnings_1', JSON.stringify({ amount: 75, sales: [{ buyer: 'x', dino: 'compy', price: 75 }] }));
  const r = await mktGet(env, '?action=earnings', '1');
  check('a legacy earnings balance is reported', r.data.coins, 75);
  check('and the seller own expired listing came home on load', r.data.returned, 1);
  const s = env.MARKETPLACE.read('dino_park_1').state;
  check('the balance is credited into the save, server-side', s.coins, 125);
  ok('the response state carries the credit op to adopt', r.data.state.marketOps.some(o => o.t === 'coins' && o.d === 75));
  const again = await mktGet(env, '?action=earnings', '1');
  check('a second claim pays nothing', [again.data.coins, s.coins], [0, 125]);
}

/* ══ Stale saves cannot undo a settlement ═══════════════════════════ */
{
  const { env, id } = await listed();
  /* A second tab opened before the listing: it still holds the dino. */
  const env0 = { MARKETPLACE: fakeKV({ dino_park_1: save('1', { park: [dino('s1', { speciesId: 'trex', mutation: 'sp_trex' })], coins: 50 }) }) };
  const staleTab = clientWith(clone(env0.MARKETPLACE.read('dino_park_1').state));
  ok('the stale tab still has the dino', staleTab.state.park.some(d => d.uid === 's1'));

  const direct = await savePost(env, staleTab.state, '1');
  check('its save is refused with 409', direct.status, 409);
  check('so the escrowed dino is not written back', env.MARKETPLACE.read('dino_park_1').state.park.length, 0);

  const r = await clientSave(env, staleTab, '1');
  check('after adopting, its retry is accepted', r.status, 200);
  check('and the adopt removed the escrowed dino locally', staleTab.state.park.length, 0);
  check('the server save still has no dino', env.MARKETPLACE.read('dino_park_1').state.park.length, 0);
  ok('the listing is untouched', env.MARKETPLACE.read('listing_' + id));

  const twice = clientWith(clone(staleTab.state));
  const before = JSON.stringify(twice.state);
  twice.adoptServerGrants(env.MARKETPLACE.read('dino_park_1').state);
  check('adopting the same server state again changes nothing', JSON.stringify(twice.state), before);
}
{
  /* A buyer tab holding pre-purchase coins cannot restore them. */
  const { env, id } = await listed();
  const buyerTab = clientWith(clone(env.MARKETPLACE.read('dino_park_2').state));
  buyerTab.state.coins += 15;                       // progress made locally since
  await mkt(env, { action: 'buy', listingId: id }, '2');
  const r = await clientSave(env, buyerTab, '2');
  check('the buyer stale tab is made to adopt, then saves', r.status, 200);
  check('the debit survives, local progress kept', env.MARKETPLACE.read('dino_park_2').state.coins, 395);
  check('and the bought dino arrives exactly once', env.MARKETPLACE.read('dino_park_2').state.park.length, 1);

  const seller = clientWith(clone(save('1', { coins: 50 }).state));
  const s = await clientSave(env, seller, '1');
  check('the seller stale tab saves after adopting', s.status, 200);
  check('and keeps the sale credit', env.MARKETPLACE.read('dino_park_1').state.coins, 170);
}
{
  /* A client save can never rewrite the server-owned op log. */
  const { env } = await listed();
  const tab = clientWith(clone(env.MARKETPLACE.read('dino_park_1').state));
  tab.state.marketOps = [];
  await savePost(env, tab.state, '1');
  check('marketOps survives a client save that omits it', env.MARKETPLACE.read('dino_park_1').state.marketOps.length, 1);
}

/* ══ Granted eggs and dinos cannot duplicate ════════════════════════ */
{
  const env = { MARKETPLACE: fakeKV({ dino_park_1: save('1', { coins: 100 }) }) };
  await Park.grantEgg(env, '1', 'rare');
  const tab = clientWith(clone(env.MARKETPLACE.read('dino_park_1').state));
  const g = tab.state.eggs[0].grantId;

  /* Hatch it locally (what hatchEgg does), then a new grant lands before
     the throttled save reaches the server. */
  tab.state.eggs.splice(0, 1);
  tab.markGrantsConsumed([g]);
  await Park.grantEgg(env, '1', 'common');

  const r = await clientSave(env, tab, '1');
  check('the save 409s, adopts and lands', r.status, 200);
  check('only the new egg is adopted, the hatched one is not', tab.state.eggs.length, 1);
  ok('and it is the new one', tab.state.eggs[0].grantId !== g);
  check('the server save holds just the new egg', env.MARKETPLACE.read('dino_park_1').state.eggs.length, 1);
  ok('hatchEgg records the grant as consumed', /state\.eggs\.splice\(idx, 1\);\n\s*if \(egg\.grantId\) markGrantsConsumed\(\[egg\.grantId\]\);/.test(page));
}
{
  const env = { MARKETPLACE: fakeKV({ dino_park_1: save('1', {}) }) };
  await Park.grantDino(env, '1', { rarity: 'common', mutation: null, source: 'giftsub' });
  const tab = clientWith(clone(env.MARKETPLACE.read('dino_park_1').state));
  const gd = tab.state.park[0];
  tab.markGrantsConsumed([gd.grantId]);
  tab.state.park.splice(0, 1);                      // traded up / released locally
  await Park.grantEgg(env, '1', 'common');
  await clientSave(env, tab, '1');
  check('a consumed granted dino is not re-adopted after a 409', tab.state.park.length, 0);
  check('nor written back to the server', env.MARKETPLACE.read('dino_park_1').state.park.length, 0);
}
{
  /* The grant check and the save write are one locked step: a grant that
     lands while a save is in flight is either refused-and-merged or kept,
     never silently overwritten. */
  let lost = 0;
  for (let i = 0; i < 25; i++) {
    const env = { MARKETPLACE: fakeKV({ dino_park_1: save('1', {}) }) };
    const local = clone(env.MARKETPLACE.read('dino_park_1').state);
    const [r] = await Promise.all([savePost(env, local, '1'), Park.grantEgg(env, '1', 'common')]);
    const eggs = env.MARKETPLACE.read('dino_park_1').state.eggs.length;
    if (r.status === 200 && eggs === 0) lost++;
  }
  check('a grant racing a save is never lost', lost, 0);
}

/* ══ Size cap ═══════════════════════════════════════════════════════ */
{
  const env = { MARKETPLACE: fakeKV({}) };
  const huge = { saveEpoch: EPOCH, park: [], vault: [], blob: 'x'.repeat(Park.SAVE_MAX_BYTES + 8192) };
  check('an oversized save is refused with 413', (await savePost(env, huge, '1')).status, 413);
  check('and nothing is stored', env.MARKETPLACE.read('dino_park_1'), null);

  const full = { saveEpoch: EPOCH, coins: 1, park: Array.from({ length: 10 }, (_, i) => dino('p' + i)),
    vault: Array.from({ length: 200 }, (_, i) => dino('v' + i, { nickname: 'twenty-four characters!!', grantId: crypto.randomUUID() })) };
  check('a full park and vault is well under the cap', (await savePost(env, full, '1')).status, 200);
  const bigList = await mkt(env, { action: 'list', uid: 'x', price: 1, state: huge }, '1');
  check('the marketplace applies the same ceiling', bigList.status, 413);
}

/* ══ uid backfill is deterministic across devices ═══════════════════ */
{
  const base = save('1', { park: [{ speciesId: 'compy', careCount: 2 }, { speciesId: 'compy', careCount: 2 }], vault: [{ speciesId: 'trex' }] }).state;
  const a = clientWith(clone(base)); a.ensureDinoUids();
  const b = clientWith(clone(base)); b.ensureDinoUids();
  check('two devices backfill the same uids', [...a.state.park, ...a.state.vault].map(d => d.uid), [...b.state.park, ...b.state.vault].map(d => d.uid));
  check('and identical twins still get distinct uids', new Set(a.state.park.map(d => d.uid)).size, 2);
}

/* ══ Report ═════════════════════════════════════════════════════════ */
console.log('');
if (failures.length) {
  console.log(`[dino-market] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[dino-market] ${passed} assertions passed.`);
console.log('');
