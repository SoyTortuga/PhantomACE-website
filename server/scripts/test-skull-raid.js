#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SKULL CLICKER — the co-op raid boss

     node server/scripts/test-skull-raid.js

   One shared boss the whole site clicks down. These tests cover the moderator
   gate on summoning, per-request damage capping, contributor credit, the
   fight mechanics that justify its animations (timed heal, damage guard,
   minion summon-and-soak), and the kill (top contributor credited, victory
   frenzy fired), plus the client/overlay wiring.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet, onRequestPost } from '../../functions/api/skull-raid.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async mutate(k, fn) { const cur = store.has(k) ? JSON.parse(store.get(k)) : null; const out = await fn(cur); if (out === undefined) return; store.set(k, JSON.stringify(out)); },
  };
}
const BC = '555';
const cookie = (id) => id ? { Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) } : {};
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/skull-raid', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });
const GET = (e) => onRequestGet({ env: e });
const envWith = (seed) => ({ MARKETPLACE: fakeKV(seed), TWITCH_BROADCASTER_ID: BC });

/* A live boss with the fight fields, tickless (nextTickAt far ahead). */
function boss(over = {}) {
  return Object.assign({
    id: 'r', name: 'Undead Executioner', maxHp: 1000, hp: 1000,
    startedAt: Date.now(), endsAt: Date.now() + 3600000, status: 'active',
    contributors: {}, attackCount: 0, skillCount: 0, summonCount: 0, minionDeaths: 0,
    shieldUntil: 0, nextTickAt: Date.now() + 999999, summonedThresholds: [], minions: { hp: 0, maxHp: 0 },
  }, over);
}

/* ══ Summon gate ═══════════════════════════════════════════════════════ */
{
  const e = envWith();
  check('a stranger cannot summon', (await POST(e, { action: 'start' }, cookie('9'))).status, 403);
  const res = await (await POST(e, { action: 'start', hp: 3000, minutes: 10 }, cookie(BC))).json();
  check('the broadcaster summons a boss', res.success, true);
  check('with the requested HP', res.raid.maxHp, 3000);
  check('and it is active', e.MARKETPLACE.read('sc_raid').status, 'active');
}

/* ══ Strikes: damage, cap, credit ══════════════════════════════════════ */
{
  const e = envWith({ sc_raid: boss() });
  const s = await (await POST(e, { action: 'hit', damage: 100 }, cookie('7'))).json();
  check('a strike lowers HP', s.hp, 900);
  check('and records the striker', s.top[0].dmg, 100);

  const capped = await (await POST(e, { action: 'hit', damage: 9999 }, cookie('7'))).json();
  check('a strike is capped per request', capped.hp, 800);   /* only 100 more, not 9999 */
}

/* ══ Guard halves the strike ═══════════════════════════════════════════ */
{
  const e = envWith({ sc_raid: boss({ shieldUntil: Date.now() + 5000 }) });
  const s = await (await POST(e, { action: 'hit', damage: 100 }, cookie('7'))).json();
  check('a guarded boss takes half damage', s.hp, 950);
  ok('and reads as shielded', s.shielded === true);
}

/* ══ Minions: summoned at a threshold, then soak half ══════════════════ */
{
  const e = envWith({ sc_raid: boss({ hp: 670 }) });               /* just above 66% of 1000 */
  let s = await (await POST(e, { action: 'hit', damage: 100 }, cookie('7'))).json();
  check('crossing 66% summons minions', s.summonCount, 1);
  check('with a health pool', s.minions.maxHp, 150);               /* 15% of 1000 */
  const bossHpAfterSummon = s.hp;                                   /* 570 */

  s = await (await POST(e, { action: 'hit', damage: 100 }, cookie('7'))).json();
  check('while minions live, they soak half the strike', s.minions.hp, 100);  /* 150 - 50 */
  check('and the boss takes the other half', s.hp, bossHpAfterSummon - 50);
}

/* ══ Timed mechanics resolve lazily on read ════════════════════════════ */
{
  const e = envWith({ sc_raid: boss({ hp: 500, nextTickAt: Date.now() - 1 }) });   /* one tick due, act #1 → attack */
  const s = await (await GET(e)).json();
  check('an overdue tick heals the boss (attack)', s.hp, 530);      /* +ceil(3% of 1000) */
  check('and counts the attack', s.attackCount, 1);
}
{
  const e = envWith({ sc_raid: boss({ attackCount: 2, skillCount: 0, nextTickAt: Date.now() - 1 }) }); /* act #3 → skill */
  const s = await (await GET(e)).json();
  check('every third act is a guard, not a heal', s.skillCount, 1);
  ok('and the boss is shielded', s.shielded === true);
}

/* ══ The kill: credit, frenzy, and defeat codes ════════════════════════ */
{
  const e = envWith({ sc_raid: boss({ hp: 40, contributors: {
    u_7: { name: 'U7', dmg: 500 }, u_9: { name: 'U9', dmg: 10 }, guest_z: { name: 'Gz', dmg: 300 },
  } }) });
  const s = await (await POST(e, { action: 'hit', damage: 100 }, cookie('9'))).json();
  check('the boss falls', s.status, 'defeated');
  check('credit goes to the top striker, not the last hit', s.defeatedBy, 'U7');

  const ev = e.MARKETPLACE.read('sc_event');
  ok('a victory frenzy is fired', ev && ev.type === 'frenzy' && ev.until > Date.now());

  /* Every account that struck is coded; guests are skipped. */
  const codes = [...e.MARKETPLACE.store.keys()].filter(k => k.startsWith('item_code_')).map(k => e.MARKETPLACE.read(k));
  check('one code per account striker (guests excluded)', codes.length, 2);

  const rare = codes.find(c => c.item.rarity === 'rare');
  const uncommon = codes.find(c => c.item.rarity === 'uncommon');
  ok('the top damager gets a rare code', !!rare);
  check('restricted to the top damager', rare.restrictedTo, ['7']);
  ok('everyone else gets an uncommon code', !!uncommon);
  check('restricted to that raider', uncommon.restrictedTo, ['9']);
  ok('the codes are activated with an expiry', rare.active === true && rare.expiresAt > Date.now());
  ok('no code was minted for the guest striker', !codes.some(c => (c.restrictedTo || []).includes('z')));
}

/* ══ Expiry and manual end ═════════════════════════════════════════════ */
{
  const e = envWith({ sc_raid: boss({ endsAt: Date.now() - 1 }) });
  check('a boss past its timer reads expired', (await (await GET(e)).json()).status, 'expired');
}
{
  const e = envWith({ sc_raid: boss() });
  check('a stranger cannot end it', (await POST(e, { action: 'end' }, cookie('9'))).status, 403);
  await POST(e, { action: 'end' }, cookie(BC));
  check('the broadcaster ends it', e.MARKETPLACE.read('sc_raid').status, 'expired');
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('sc_raid is a registered singleton', /sc_raid:\s*\{ table: 'singletons'/.test(reg));

  const html = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay has the raid panel and loads it', /id="ovRaid"/.test(html) && /overlay-skull-raid\.js/.test(html));

  const layout = fs.readFileSync(path.join(REPO, 'functions/api/overlay/layout.js'), 'utf8');
  ok('the raid panel is a saveable layout id', /'ovRaid'/.test(layout));

  const ovjs = fs.readFileSync(path.join(REPO, 'js/pages/overlay-skull-raid.js'), 'utf8');
  ok('the overlay animates every reaper sprite',
     ['idle', 'attack', 'skill', 'summon', 'death', 'minion-appear', 'minion-idle', 'minion-death'].every(n => ovjs.includes(n)));

  const game = fs.readFileSync(path.join(REPO, 'games/skull-clicker/index.html'), 'utf8');
  ok('a strike also hits the boss', /if \(raidActive\(\)\) raidQueue\+\+/.test(game));
  ok('the game polls and flushes damage', /function pollRaid/.test(game) && /function flushRaidDamage/.test(game));

  const bc = fs.readFileSync(path.join(REPO, 'js/pages/bot-control.js'), 'utf8');
  ok('bot control can summon the boss', /function initOvRaid/.test(bc) && /action: 'start'/.test(bc));

  const samples = fs.readFileSync(path.join(REPO, 'js/pages/overlay-samples.js'), 'utf8');
  ok('layout mode knows the raid panel', /id: 'ovRaid'/.test(samples) && /function raidBoss/.test(samples));

  ok('the flattened sprite strips exist',
     ['idle', 'attack', 'skill', 'summon', 'death', 'minion-appear', 'minion-idle', 'minion-death']
       .every(n => fs.existsSync(path.join(REPO, 'games/skull-clicker/assets/raid/' + n + '.png'))));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[skull-raid] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[skull-raid] ${passed} assertions passed.`);
console.log('');
