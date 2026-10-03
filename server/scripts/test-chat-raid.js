#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SKULL CLICKER — chat fights the raid boss (!hit)

     node server/scripts/test-chat-raid.js

   Stream interactivity #11. Chatters strike the co-op raid boss with `!hit`,
   attributed to a CHAT contributor keyed by their Twitch id. These tests cover
   that a chat strike lands through skull-raid's OWN mutate + rate-limit path (no
   second limiter), that chat vs site damage are totalled separately and without
   per-hit growth, that a scripted chatter is throttled to the SAME per-account
   ceiling a site striker has, that a chat-only striker earns no reward it is not
   entitled to, and that the contributor cap still holds. Plus the bot/overlay
   wiring.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet, onRequestPost, strikeRaidFromChat, CHAT_HIT_DAMAGE } from '../../functions/api/skull-raid.js';

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
    async delete(k) { store.delete(k); },
    async mutate(k, fn) { const cur = store.has(k) ? JSON.parse(store.get(k)) : null; const out = await fn(cur); if (out === undefined) return; store.set(k, JSON.stringify(out)); },
  };
}
const BC = '555';
const cookie = (id) => id ? { Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) } : {};
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/skull-raid', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });
const GET = (e, qs, h) => onRequestGet({ env: e, request: new Request('https://x/api/skull-raid?' + (qs || ''), { headers: { ...h } }) });
const envWith = (seed) => ({ MARKETPLACE: fakeKV(seed), TWITCH_BROADCASTER_ID: BC });

/* A live boss, tickless (nextTickAt far ahead), source/site totals zeroed. */
function boss(over = {}) {
  return Object.assign({
    id: 'r', name: 'Undead Executioner', maxHp: 1000, hp: 1000,
    startedAt: Date.now(), endsAt: Date.now() + 3600000, status: 'active',
    contributors: {}, attackCount: 0, skillCount: 0, summonCount: 0, minionDeaths: 0,
    chatDamage: 0, siteDamage: 0,
    shieldUntil: 0, nextTickAt: Date.now() + 999999, summonedThresholds: [], minions: { hp: 0, maxHp: 0 },
  }, over);
}
/* Rewind a contributor's bucket stamp to simulate elapsed time without sleeping. */
function rewind(e, id, ms) {
  const r = e.MARKETPLACE.read('sc_raid');
  r.contributors[id].t -= ms;
  e.MARKETPLACE.store.set('sc_raid', JSON.stringify(r));
}

/* ══ A chat !hit lands on the active boss and totals as CHAT damage ═════ */
{
  const e = envWith({ sc_raid: boss() });
  const r = await strikeRaidFromChat(e, { userId: '7', name: 'chatKnight' });
  ok('a chat strike lands', r.ok === true && r.landed === CHAT_HIT_DAMAGE);
  const rec = e.MARKETPLACE.read('sc_raid');
  check('it lowers the boss HP by the chat-hit amount', rec.hp, 1000 - CHAT_HIT_DAMAGE);
  check('and totals as chat damage', rec.chatDamage, CHAT_HIT_DAMAGE);
  check('while site damage stays zero', rec.siteDamage, 0);
  check('attributed to a chat-namespaced contributor', Object.keys(rec.contributors), ['chat_7']);
  check('with the chatter name, sanitized', rec.contributors.chat_7.name, 'chatKnight');
  check('the public state reports chat damage', (await (await GET(e)).json()).chatDamage, CHAT_HIT_DAMAGE);
}

/* ══ No active boss → a quiet no-op ════════════════════════════════════ */
{
  const e = envWith();
  const r = await strikeRaidFromChat(e, { userId: '7', name: 'chatKnight' });
  check('no boss → nothing lands', r.landed, 0);
  ok('and the record is never created', !e.MARKETPLACE.read('sc_raid'));
}
{
  const e = envWith({ sc_raid: boss({ status: 'defeated', hp: 0, defeatedAt: Date.now() }) });
  const r = await strikeRaidFromChat(e, { userId: '7', name: 'x' });
  check('a chat strike on a dead boss lands nothing', r.landed, 0);
  check('and does not resurrect its HP', e.MARKETPLACE.read('sc_raid').hp, 0);
}
{
  const e = envWith({ sc_raid: boss({ endsAt: Date.now() - 1 }) });
  const r = await strikeRaidFromChat(e, { userId: '7', name: 'x' });
  check('a chat strike on an escaped boss lands nothing', r.landed, 0);
  check('and the boss reads escaped, not re-struck', (await (await GET(e)).json()).status, 'escaped');
}
{
  const e = envWith({ sc_raid: boss() });
  check('a chat strike with no user id is a no-op', (await strikeRaidFromChat(e, { name: 'x' })).landed, 0);
}

/* ══ Chat vs site totals are tracked SEPARATELY ════════════════════════ */
{
  const e = envWith({ sc_raid: boss({ maxHp: 1e6, hp: 1e6 }) });
  await strikeRaidFromChat(e, { userId: '7', name: 'chatKnight' });   // +5 chat
  await strikeRaidFromChat(e, { userId: '8', name: 'boneMob' });      // +5 chat
  await POST(e, { action: 'hit', damage: 100 }, cookie('9'));          // +100 site
  const rec = e.MARKETPLACE.read('sc_raid');
  check('chat damage sums only the chat strikes', rec.chatDamage, 2 * CHAT_HIT_DAMAGE);
  check('site damage sums only the site strikes', rec.siteDamage, 100);
  const pub = await (await GET(e)).json();
  check('the overlay sees chat total', pub.chatDamage, 2 * CHAT_HIT_DAMAGE);
  check('the overlay sees site total', pub.siteDamage, 100);
  ok('chat and site contributors live in distinct namespaces',
     !!rec.contributors.chat_7 && !!rec.contributors.chat_8 && !!rec.contributors.u_9);
}

/* ══ Totals are BOUNDED — aggregate counters, never a per-hit log ═══════ */
{
  const e = envWith({ sc_raid: boss({ maxHp: 1e6, hp: 1e6 }) });
  for (let i = 0; i < 50; i++) await strikeRaidFromChat(e, { userId: '7', name: 'chatKnight' });
  const rec = e.MARKETPLACE.read('sc_raid');
  check('50 chat hits from one chatter make exactly one contributor', Object.keys(rec.contributors).length, 1);
  ok('chat damage is a single running number', typeof rec.chatDamage === 'number' && rec.chatDamage > 0);
  const json = JSON.stringify(rec);
  ok('no per-hit array/log grows on the record',
     !/"(hits|log|strikes|events|history)"\s*:\s*\[/.test(json));
  /* The record's key set is the same whether the boss took 1 chat hit or 50. */
  const baseline = envWith({ sc_raid: boss({ maxHp: 1e6, hp: 1e6 }) });
  await strikeRaidFromChat(baseline, { userId: '7', name: 'chatKnight' });
  check('the top-level shape does not grow with hit count',
     Object.keys(rec).sort(), Object.keys(baseline.MARKETPLACE.read('sc_raid')).sort());
}

/* ══ A scripted chatter is throttled to the SAME ceiling as a site striker
   The site suite proves a 100/s site script is held to ~40/s. A chat script
   posting !hit 100x/s over a minute must be held to the very same rate — one
   shared token bucket, not a second, weaker limiter. Both start from an empty
   bucket and are driven for 60 simulated seconds. ══════════════════════ */
{
  /* Site reference: 100 POST /hit per second, damage 100 each. */
  const site = envWith({ sc_raid: boss({ maxHp: 1e7, hp: 1e7, contributors: { u_7: { name: 'U7', dmg: 0, k: 0, t: Date.now() } } }) });
  let siteLanded = 0;
  for (let sec = 0; sec < 60; sec++) {
    rewind(site, 'u_7', 1000);
    for (let i = 0; i < 100; i++) siteLanded += (await (await POST(site, { action: 'hit', damage: 100 }, cookie('7'))).json()).landed;
  }

  /* Chat script: 100 !hit per second, CHAT_HIT_DAMAGE each. */
  const chat = envWith({ sc_raid: boss({ maxHp: 1e7, hp: 1e7, contributors: { chat_7: { name: 'C7', dmg: 0, k: 0, t: Date.now() } } }) });
  let chatLanded = 0;
  for (let sec = 0; sec < 60; sec++) {
    rewind(chat, 'chat_7', 1000);
    for (let i = 0; i < 100; i++) chatLanded += (await strikeRaidFromChat(chat, { userId: '7', name: 'C7' })).landed;
  }

  ok('a 100/s chat script is held to ~40/s over a minute', chatLanded >= 60 * 40 && chatLanded <= 60 * 40 + 120);
  /* Same shared bucket, so chat never earns a higher rate than site. Tolerance
     of one second's refill absorbs wall-clock drift between the two loops. */
  ok('— the same ceiling a 100/s site script hits (no higher rate for chat)', Math.abs(chatLanded - siteLanded) <= 60);
}

/* ══ A chat-only striker earns NO reward it is not entitled to ══════════
   A chat contributor keyed by a Twitch id has no site account to redeem into;
   the kill reward path pays only `u_` ids, so however much a chat striker deals,
   no defeat code and no pending reward are minted for it. ══════════════ */
{
  // minReward = 50; summon thresholds pre-marked so a low-HP boss spawns no
  // minions to soak the chat strikes — this isolates the kill/reward path.
  const e = envWith({ sc_raid: boss({ hp: 100, maxHp: 1000, summonedThresholds: [0.66, 0.33] }) });
  let defeated = false;
  for (let i = 0; i < 25 && !defeated; i++) {
    const r = await strikeRaidFromChat(e, { userId: '7', name: 'chatKnight' });
    defeated = r.defeated;
  }
  const rec = e.MARKETPLACE.read('sc_raid');
  check('the chat striker can land the killing blow', rec.status, 'defeated');
  ok('and dealt more than the reward minimum', rec.contributors.chat_7.dmg >= 50);
  const codes = [...e.MARKETPLACE.store.keys()].filter(k => k.startsWith('item_code_'));
  check('yet no defeat code is minted for a chat-only striker', codes.length, 0);
  ok('and no pending in-game reward is stashed for it', !e.MARKETPLACE.read('sc_raid_reward_7') && !e.MARKETPLACE.read('sc_raid_reward_chat_7'));
}
{
  /* A chat striker alongside an account: the account is still rewarded, the
     chat striker is still not — chat damage counts toward the kill either way. */
  const e = envWith({ sc_raid: boss({ hp: 60, maxHp: 1000, contributors: {
    u_9: { name: 'U9', dmg: 500 }, chat_7: { name: 'C7', dmg: 400 },
  } }) });
  await POST(e, { action: 'hit', damage: 100 }, cookie('9'));   // kills it
  const codes = [...e.MARKETPLACE.store.keys()].filter(k => k.startsWith('item_code_')).map(k => e.MARKETPLACE.read(k));
  check('only the account striker is coded on a mixed kill', codes.length, 1);
  check('the code is restricted to the account, not the chatter', codes[0].restrictedTo, ['9']);
  ok('no reward pointer for the chat striker', !e.MARKETPLACE.read('sc_raid_reward_7'));
}

/* ══ Contributor cap still holds for chat strikers ═════════════════════ */
{
  const contributors = {};
  for (let i = 0; i < 500; i++) contributors['guest_g' + i] = { name: 'Skull#' + i, dmg: 10 + i };
  const e = envWith({ sc_raid: boss({ maxHp: 1e6, hp: 1e6, contributors }) });
  const r = await strikeRaidFromChat(e, { userId: '7', name: 'chatKnight' });
  ok('a chat striker (non-guest) gets into a full map', r.landed > 0);
  const after = e.MARKETPLACE.read('sc_raid').contributors;
  check('by evicting the weakest guest, so the map never grows', Object.keys(after).length, 500);
  ok('the chat contributor is in, the weakest guest is out', !!after.chat_7 && !after.guest_g0 && !!after.guest_g1);
}
{
  /* A chat striker cannot evict a non-guest to get in; if the map is full of
     accounts/chatters only, it is refused — same rule accounts follow. */
  const contributors = {};
  for (let i = 0; i < 500; i++) contributors['u_' + i] = { name: 'U' + i, dmg: 10 + i };
  const e = envWith({ sc_raid: boss({ maxHp: 1e6, hp: 1e6, contributors }) });
  const r = await strikeRaidFromChat(e, { userId: 'new', name: 'latecomer' });
  check('a full map of accounts refuses a new chat striker', r.landed, 0);
  check('and stays at the ceiling', Object.keys(e.MARKETPLACE.read('sc_raid').contributors).length, 500);
}

/* ══ Name sanitization reaches the overlay through the chat path too ════ */
{
  const e = envWith({ sc_raid: boss() });
  await strikeRaidFromChat(e, { userId: 'z', name: '<img src=x>‮evil\u0000 ' + 'X'.repeat(80) });
  const top = (await (await GET(e)).json()).top;
  const n = top[0].name;
  ok('a chat name loses zero-width/bidi/control chars', !/[​‮\u0000]/.test(n));
  ok('and is length-capped', [...n].length <= 25);
  const pub = JSON.stringify(await (await GET(e)).json());
  ok('the public state never exposes rate buckets', !/"k":|"guestIps"/.test(pub));
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const cmds = fs.readFileSync(path.join(REPO, 'functions/api/bot/commands.js'), 'utf8').replace(/\r\n/g, '\n');
  ok('bot/commands routes the !hit command', /parsed\.command === '!hit'/.test(cmds));
  ok('to strikeRaidFromChat with the chatter identity', /strikeRaidFromChat/.test(cmds) && /chatter_user_id/.test(cmds));
  ok('!hit is a PUBLIC command (before the moderator gate)',
     cmds.indexOf("parsed.command === '!hit'") < cmds.indexOf('if (!isAuthorizedSender(env, event)) return;'));

  const api = fs.readFileSync(path.join(REPO, 'functions/api/skull-raid.js'), 'utf8');
  ok('the shared damage path is used by both site and chat', /function landStrike\(/.test(api));
  ok('chat and site damage are aggregate counters', /raid\.chatDamage =/.test(api) && /raid\.siteDamage =/.test(api));
  ok('publicState exposes both totals', /chatDamage: Math\.max/.test(api) && /siteDamage: Math\.max/.test(api));

  const html = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay has the chat-vs-site split markup',
     /id="ovRaidSplit"/.test(html) && /id="ovRaidSplitChat"/.test(html) && /id="ovRaidSplitSite"/.test(html));

  const ovjs = fs.readFileSync(path.join(REPO, 'js/pages/overlay-skull-raid.js'), 'utf8');
  ok('the overlay panel renders the split from chatDamage/siteDamage',
     /ovRaidSplit/.test(ovjs) && /s\.chatDamage/.test(ovjs) && /s\.siteDamage/.test(ovjs));
  ok('the split hides in place when there is no damage yet', /splitEl\.hidden = true/.test(ovjs));

  const css = fs.readFileSync(path.join(REPO, 'css/pages/overlay.css'), 'utf8');
  ok('the split has a display:none hidden guard (marathon-safe)', /\.ov-raid-split\[hidden\] \{ display: none; \}/.test(css));
  /* Scope the ban-check to just the split's own rules (from its hidden guard to
     the next unrelated block), not the whole file — the file's comments mention
     the banned properties by name. */
  const splitBlock = (css.match(/\.ov-raid-split\[hidden\][\s\S]*?\/\* Minions/) || [''])[0];
  ok('the split block exists', splitBlock.length > 0);
  ok('and uses no box-shadow or backdrop-filter', !/box-shadow|backdrop-filter/.test(splitBlock));

  const samples = fs.readFileSync(path.join(REPO, 'js/pages/overlay-samples.js'), 'utf8');
  ok('layout mode previews the split', /ovRaidSplit/.test(samples));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[chat-raid] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[chat-raid] ${passed} assertions passed.`);
console.log('');
