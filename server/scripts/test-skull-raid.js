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
import sharp from 'sharp';
import { onRequestGet, onRequestPost, spawnRaidFromRedemption } from '../../functions/api/skull-raid.js';

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

  /* The in-game claim: each account has a pending reward pointer it can fetch. */
  const topReward = e.MARKETPLACE.read('sc_raid_reward_7');
  check('the top damager has a pending rare reward', topReward && topReward.rarity, 'rare');
  ok('flagged as top', topReward.top === true);
  check('the pointer carries the same code', topReward.code, rare.code);
  check('a raider has a pending uncommon reward', (e.MARKETPLACE.read('sc_raid_reward_9') || {}).rarity, 'uncommon');
  ok('the guest has no pending reward', !e.MARKETPLACE.read('sc_raid_reward_z'));

  /* GET ?reward=1 returns it for that session; a stranger sees nothing. */
  const mine = await (await GET(e, 'reward=1', cookie('7'))).json();
  check('the player fetches their own reward in-game', mine.reward.code, rare.code);
  check('a session with no reward gets null', (await (await GET(e, 'reward=1', cookie('nobody'))).json()).reward, null);
  check('an anonymous reward fetch is null', (await (await GET(e, 'reward=1')).json()).reward, null);

  /* Claim (dismiss) clears the pointer so it does not nag on reload. */
  check('claiming succeeds', (await (await POST(e, { action: 'claim-reward' }, cookie('7'))).json()).success, true);
  ok('and the pointer is gone', !e.MARKETPLACE.read('sc_raid_reward_7'));
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
  check('the broadcaster removes it outright', e.MARKETPLACE.read('sc_raid'), null);
}
{
  /* End clears a stuck defeated boss too, not just an active one. */
  const e = envWith({ sc_raid: boss({ status: 'defeated', hp: 0, defeatedAt: Date.now() }) });
  await POST(e, { action: 'end' }, cookie(BC));
  check('and clears a lingering defeated boss', e.MARKETPLACE.read('sc_raid'), null);
}

/* ══ A defeated boss shows briefly, then clears itself ═════════════════ */
{
  const fresh = envWith({ sc_raid: boss({ status: 'defeated', hp: 0, defeatedAt: Date.now() - 1000 }) });
  check('a fresh kill still shows (death + banner)', (await (await GET(fresh)).json()).status, 'defeated');
  const old = envWith({ sc_raid: boss({ status: 'defeated', hp: 0, defeatedAt: Date.now() - 20000 }) });
  check('but a long-defeated boss reads as gone', (await (await GET(old)).json()).status, 'none');
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
  /* The sprite loop must idle when hidden: it runs for the life of an OBS
     browser source (days), and re-writing the background-image ~9x/second
     while no boss is up is pure churn on a fragile CEF. */
  ok('the sprite animation is skipped while the panel is hidden', /if \(panel\.hidden\) return;/.test(ovjs));

  const game = fs.readFileSync(path.join(REPO, 'games/skull-clicker/index.html'), 'utf8');
  ok('a strike also hits the boss', /if \(raidActive\(\)\) raidQueue\+\+/.test(game));
  ok('the game polls and flushes damage', /function pollRaid/.test(game) && /function flushRaidDamage/.test(game));
  ok('the game claims raid rewards in-game', /function fetchRaidReward/.test(game) && /skull-raid\?reward=1/.test(game) && /id="rewardBanner"/.test(game));

  const reg2 = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the per-account reward key is registered', /prefix: 'sc_raid_reward_'/.test(reg2));

  const bc = fs.readFileSync(path.join(REPO, 'js/pages/bot-control.js'), 'utf8');
  ok('bot control can summon the boss', /function initOvRaid/.test(bc) && /action: 'start'/.test(bc));

  const samples = fs.readFileSync(path.join(REPO, 'js/pages/overlay-samples.js'), 'utf8');
  ok('layout mode knows the raid panel', /id: 'ovRaid'/.test(samples) && /function raidBoss/.test(samples));

  ok('the flattened sprite strips exist',
     ['idle', 'idle2', 'attack', 'skill', 'summon', 'death', 'minion-appear', 'minion-idle', 'minion-death']
       .every(n => fs.existsSync(path.join(REPO, 'games/skull-clicker/assets/raid/' + n + '.png'))));

  /* THE BUG THIS GUARDS AGAINST: a strip's real frame count silently
     drifting from the hand-typed constant that steps through it. That
     happened for real -- five different raid strips shipped with trailing
     fully-transparent frames the animator still stepped through, so the
     boss blinked invisible for part of every idle/attack/death/
     minion-death loop, because nothing checked the PNG against the number
     next to it. Re-derive both sides here: BOSS/MINI from the source, the
     real frame count from the file's own width, and require them to
     agree exactly. */
  const overlayJs = fs.readFileSync(path.join(REPO, 'js/pages/overlay-skull-raid.js'), 'utf8');
  const bossMatch = overlayJs.match(/var BOSS = \{([\s\S]*?)\};/);
  const miniMatch = overlayJs.match(/var MINI = \{([\s\S]*?)\};/);
  ok('BOSS/MINI frame-count tables are present', !!bossMatch && !!miniMatch);
  const parseCounts = (body) => Object.fromEntries(
    [...body.matchAll(/['"]?([\w-]+)['"]?\s*:\s*(\d+)/g)].map(m => [m[1], Number(m[2])])
  );
  const BOSS = parseCounts(bossMatch[1]);
  const MINI = parseCounts(miniMatch[1]);

  for (const [name, expected] of Object.entries(BOSS)) {
    const file = path.join(REPO, 'games/skull-clicker/assets/raid/' + name + '.png');
    const { width } = await sharp(file).metadata();
    check(`${name}.png is ${expected} frames at 100px (BOSS.${name})`, width / 100, expected);
  }
  for (const [name, expected] of Object.entries(MINI)) {
    const file = path.join(REPO, 'games/skull-clicker/assets/raid/' + name + '.png');
    const { width } = await sharp(file).metadata();
    check(`${name}.png is ${expected} frames at 50px (MINI.${name})`, width / 50, expected);
  }

  /* The mini idle icon on the game's own page reads idle.png at a
     different display size (34px) via its own hardcoded background-size
     and steps() count -- both have to track idle.png's real frame count
     too, independently of the overlay's BOSS table. */
  const gamePage = fs.readFileSync(path.join(REPO, 'games/skull-clicker/index.html'), 'utf8');
  const miniIconWidth = BOSS.idle * 34;
  ok(`the mini idle icon's background-size matches idle.png's ${BOSS.idle} frames`,
     gamePage.includes(`background-size: ${miniIconWidth}px 34px`));
  ok('and its steps() count matches', gamePage.includes(`steps(${BOSS.idle})`));
}

/* ══ Channel-point redemption spawn ═════════════════════════════════════
   "Summon Raid Boss" — 10,000 points, sized to a third of the room mashing
   at 550 clicks/min for the 10-minute fight. Cost/cooldown/per-stream cap
   are Twitch-side reward settings, not something this code tracks. */
{
  const e = envWith();
  const spawned = await spawnRaidFromRedemption(e, { viewers: 30 });
  ok('a redemption spawns a boss', !!spawned);
  check('HP is a third of viewers x 550/min x 10 minutes', spawned.maxHp, Math.round(30 * (1 / 3) * 550 * 10));
  check('it runs for 10 minutes', spawned.endsAt - spawned.startedAt, 10 * 60 * 1000);
  check('and is tagged by source', spawned.source, 'redemption');
  check('it is stored too', e.MARKETPLACE.read('sc_raid').id, spawned.id);
}
{
  /* An off-stream or test redemption (no live viewer count) still gets a
     real fight instead of a 0-HP boss. */
  const e = envWith();
  const spawned = await spawnRaidFromRedemption(e, { viewers: 0 });
  check('no/zero viewer count falls back to a minimum-sized boss', spawned.maxHp, Math.round(3 * (1 / 3) * 550 * 10));
}
{
  /* A viewer paying points for a boss that already exists gets refused —
     the caller (channel-points.js) refunds them. */
  const e = envWith({ sc_raid: boss() });
  const spawned = await spawnRaidFromRedemption(e, { viewers: 100 });
  ok('refuses to spawn over an active boss', spawned === null);
  check('the active boss is untouched', e.MARKETPLACE.read('sc_raid').id, 'r');
}
{
  /* Same refusal while a just-defeated boss is still showing its banner. */
  const e = envWith({ sc_raid: boss({ status: 'defeated', hp: 0, defeatedAt: Date.now() - 1000 }) });
  ok('refuses to spawn over a lingering kill', (await spawnRaidFromRedemption(e, { viewers: 50 })) === null);
}
{
  /* But a boss that has run out its clock, or a long-lingering kill, is
     fair game -- nothing else will ever clear those out for a fresh
     redemption to use. */
  const expired = envWith({ sc_raid: boss({ endsAt: Date.now() - 1 }) });
  ok('spawns over an expired boss', !!(await spawnRaidFromRedemption(expired, { viewers: 50 })));
  const oldKill = envWith({ sc_raid: boss({ status: 'defeated', hp: 0, defeatedAt: Date.now() - 20000 }) });
  ok('spawns over a long-lingering kill', !!(await spawnRaidFromRedemption(oldKill, { viewers: 50 })));
}
{
  const cp = fs.readFileSync(path.join(REPO, 'functions/api/channel-points.js'), 'utf8');
  ok('channel points routes a boss/raid reward title', /if \(lower\.includes\('boss'\) \|\| lower\.includes\('raid'\)\)/.test(cp));
  ok('and spawns the boss on redemption', /spawnRaidFromRedemption/.test(cp));
  ok('refunding when it refuses', /settleRedemption/.test(cp) && /CANCELED/.test(cp));

  const bs = fs.readFileSync(path.join(REPO, 'functions/api/admin/bot-setup.js'), 'utf8');
  ok('the admin panel can create the raid boss reward', /function createRaidBossReward/.test(bs) && /'create-raid-reward'/.test(bs));
  ok('sized so Twitch owns the cooldown/cap, not the site',
     /global_cooldown_seconds:\s*3600/.test(bs) && /max_per_stream:\s*3/.test(bs));
  ok('and leaves the redemption queued so a refusal can be refunded',
     /should_redemptions_skip_request_queue:\s*false/.test(bs));

  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the raid boss reward id is a registered singleton', /raid_boss_reward_id:\s*\{ table: 'singletons'/.test(reg));
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
