#!/usr/bin/env node
/* ══════════════════════════════════════════════
   ACHIEVEMENTS → badges, across four games

     node server/scripts/test-achievements.js

   Mana Clash had achievements and nothing else did. This covers the shared
   engine and the four games wired into it.

   WHAT ACTUALLY GOES WRONG with a feature like this, and is therefore what
   is pinned:

     - an achievement that can never fire, because the hook was never
       called or passes a field the catalogue does not read. Every game is
       driven through its OWN record call with the shape its hook sends,
       and the hooks are checked to exist in the game files.
     - a badge granted twice, or a row rewritten on an event that changed
       nothing.
     - progress read off a TRUNCATED board. Every board on this site is
       capped, so the engine must never need one — it is fed events.
     - an id colliding with a badge the site already grants by hand, which
       would hand somebody the wrong artwork and merge two unrelated items
       in one inventory row.
     - a guest earning a badge they have no inventory to hold.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  GAMES, allRewards, achKey, recordAchievement, onRequestGet,
} from '../../functions/api/achievements.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

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
  const writes = {};
  return {
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next === undefined) return cur;          /* opted out: no write */
        writes[k] = (writes[k] || 0) + 1;
        store.set(k, JSON.stringify(next));
        return next;
      },
      async listValues() { return []; },
    },
    store, writes,
  };
}

const inv = (env, uid) => {
  const raw = env.store.get('inv_' + uid);
  return raw ? JSON.parse(raw) : null;
};
const badges = (env, uid) => ((inv(env, uid) || {}).items || [])
  .filter(i => i.type === 'badge').map(i => i.id).sort();

const UID = '7';

/* ── Every game's achievements can actually be earned ────────────────── */
{
  /* Driven with the shape each game's hook really sends. An achievement
     nothing can satisfy is the failure this whole file exists to prevent. */
  const plays = {
    'memory-match': [
      { type: 'game', pairs: 20, moves: 20 },                       // flawless
      ...Array.from({ length: 49 }, () => ({ type: 'game', pairs: 20, moves: 30 })),
      ...['d1', 'd2', 'd3', 'd4', 'd5'].map(dayKey => ({ type: 'daily', dayKey })),
    ],
    'commander-bingo': [
      { type: 'game', bingos: 1, marked: 10 },
      { type: 'game', bingos: 12, marked: 25 },                     // blackout
      ...Array.from({ length: 8 }, () => ({ type: 'game', bingos: 0, marked: 3 })),
    ],
    'pham-shock': Array.from({ length: 10 }, () => ({ type: 'match', won: true })),
    'mtgbbb': [
      { type: 'box', points: 40, blackout: false },
      { type: 'box', points: 10, blackout: true },
      ...Array.from({ length: 3 }, () => ({ type: 'box', points: 0, blackout: false })),
    ],
  };

  for (const [game, events] of Object.entries(GAMES)) {
    void events;
    const env = makeEnv();
    for (const e of plays[game]) await recordAchievement(env, game, UID, e);

    const want = GAMES[game].catalog.map(a => a.reward.id).sort();
    check(`${game}: every achievement is reachable`, badges(env, UID), want);

    const row = JSON.parse(env.store.get(achKey(game, UID)));
    check(`${game}: and all are marked unlocked`,
      Object.keys(row.unlocked).sort(), GAMES[game].catalog.map(a => a.id).sort());
  }
}

/* ── Granted once, and a no-op event writes nothing ──────────────────── */
{
  const env = makeEnv();
  await recordAchievement(env, 'pham-shock', UID, { type: 'match', won: true });
  check('one win grants First Shot', badges(env, UID), ['ps-first']);

  const invWrites = env.writes['inv_' + UID];
  const rowWrites = env.writes[achKey('pham-shock', UID)];

  /* A second win advances progress (so the row writes) but grants nothing
     new, so the inventory must not be touched again. */
  await recordAchievement(env, 'pham-shock', UID, { type: 'match', won: true });
  check('a second win grants nothing more', badges(env, UID), ['ps-first']);
  check('and does not rewrite the inventory', env.writes['inv_' + UID], invWrites);
  ok('though it does advance progress', env.writes[achKey('pham-shock', UID)] > rowWrites);

  /* An event that changes nothing at all must not write either: a loss on a
     streak already at zero. */
  const after = env.writes[achKey('pham-shock', UID)];
  await recordAchievement(env, 'pham-shock', UID, { type: 'match', won: false });
  await recordAchievement(env, 'pham-shock', UID, { type: 'match', won: false });
  check('a second consecutive loss changes nothing and writes nothing',
    env.writes[achKey('pham-shock', UID)], after + 1);
}

/* ── A streak breaks, and the best is kept ───────────────────────────── */
{
  const env = makeEnv();
  const m = (won) => recordAchievement(env, 'pham-shock', UID, { type: 'match', won });
  await m(true); await m(true); await m(false);
  ok('two then a loss is not a streak', !badges(env, UID).includes('ps-streak'));
  await m(true); await m(true); await m(true);
  ok('three in a row earns it', badges(env, UID).includes('ps-streak'));
  await m(false);
  ok('and losing afterwards does not take it away', badges(env, UID).includes('ps-streak'));
}

/* ── Added later, unlocked retroactively ─────────────────────────────── */
{
  /* met() is recomputed from stored progress on every event, so somebody
     already past a new achievement gets it on their next game rather than
     having to do it again. */
  const env = makeEnv();
  for (let i = 0; i < 60; i++) {
    await recordAchievement(env, 'memory-match', UID, { type: 'game', pairs: 20, moves: 30 });
  }
  ok('fifty games earns Card Counter', badges(env, UID).includes('mm-fifty'));

  /* Wipe the unlocked set but keep the progress — the state somebody would
     be in if the achievement had not existed when they played. */
  const row = JSON.parse(env.store.get(achKey('memory-match', UID)));
  row.unlocked = {};
  env.store.set(achKey('memory-match', UID), JSON.stringify(row));
  const invRow = inv(env, UID);
  invRow.items = invRow.items.filter(i => i.id !== 'mm-fifty');
  env.store.set('inv_' + UID, JSON.stringify(invRow));

  await recordAchievement(env, 'memory-match', UID, { type: 'game', pairs: 20, moves: 30 });
  ok('and standing progress re-earns it on the next game',
    badges(env, UID).includes('mm-fifty'));
}

/* ── Guests earn nothing: there is no inventory to grant into ─────────── */
{
  const env = makeEnv();
  const r = await recordAchievement(env, 'pham-shock', 'guest_abc', { type: 'match', won: true });
  check('a guest is refused', r.guest, true);
  check('and nothing is written at all', [...env.store.keys()], []);
}

/* ── Nothing is read off a board ─────────────────────────────────────── */
{
  /* Every board on this site is truncated — lb_memory_match keeps 50 rows,
     the daily keeps 500 — so progress read from one would stop silently for
     a player off the end. The engine must touch only its own row and the
     inventory. */
  const env = makeEnv();
  await recordAchievement(env, 'memory-match', UID, { type: 'game', pairs: 20, moves: 20 });
  const touched = [...env.store.keys()].sort();
  check('only the progress row and the inventory are written',
    touched, [achKey('memory-match', UID), 'inv_' + UID].sort());
}

/* ── Badge ids are unique, and clear of the hand-minted ones ─────────── */
{
  const rewards = allRewards();
  check('twelve badges across the four games', rewards.length, 12);
  check('every id is unique', rewards.length, new Set(rewards.map(r => r.id)).size);
  ok('every one is a profile badge', rewards.every(r => r.game === 'profile' && r.type === 'badge'));
  ok('each names its artwork', rewards.every(r => r.image === `/assets/badges/${r.id}.png`));

  /* A collision with a hand-minted badge would hand somebody the wrong
     artwork and merge two unrelated items into one inventory row. */
  const minter = read('server/scripts/mint-badge-code.js');
  const minted = [...minter.matchAll(/^\s{2}'([a-z0-9-]+)': \{/gm)].map(m => m[1]);
  ok('the hand-minted list parses', minted.length >= 3);
  check('no achievement badge collides with one minted by hand',
    rewards.filter(r => minted.includes(r.id)).map(r => r.id), []);

  const checkin = read('functions/api/checkin-badges.js');
  const eventIds = [...checkin.matchAll(/^\s{4}id: '([a-z0-9-]+)',/gm)].map(m => m[1]);
  check('nor with an event badge', rewards.filter(r => eventIds.includes(r.id)).map(r => r.id), []);

  const raid = read('functions/api/raid-badges.js');
  check('nor with a raid ladder badge',
    rewards.filter(r => raid.includes(`'${r.id}'`)).map(r => r.id), []);

  /* Rarities have to be ones the site knows how to colour. */
  const known = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exclusive'];
  check('every rarity is a real one', rewards.filter(r => !known.includes(r.rarity)), []);
}

/* ── The games actually call it ──────────────────────────────────────── */
{
  /* An engine nothing invokes grants nobody anything — the failure mode this
     project has hit repeatedly. */
  const hooks = [
    ['functions/api/memory-match.js', "'memory-match'", 'a finished ranked game'],
    ['functions/api/memory-match.js', "type: 'daily'", 'the daily puzzle'],
    ['functions/api/bingo/end.js', "'commander-bingo'", 'a finished bingo room'],
    ['functions/api/pham-shock.js', "'pham-shock'", 'a settled match'],
    ['functions/api/mtgbbb/end.js', "'mtgbbb'", 'a finished box crack'],
  ];
  for (const [file, needle, what] of hooks) {
    const src = read(file);
    ok(`${what} records an achievement`,
      /recordAchievement/.test(src) && src.includes(needle));
  }

  /* Bingo must use the same 'u_' account test writeBoard uses, or it would
     try to grant to guest ids. */
  const bingo = read('functions/api/bingo/end.js');
  ok('bingo skips guests the same way the leaderboard does',
    /startsWith\('u_'\)/.test(bingo) && /slice\(2\)/.test(bingo));

  /* PhamShock must record losers too, or a streak could never break. */
  const ps = read('functions/api/pham-shock.js');
  ok('phamshock records every player, not only the winner',
    /won: id === room\.winner/.test(ps));

  /* Every hook isolated: a badge must not be able to break a game write. */
  for (const [file] of hooks) {
    const src = read(file);
    const calls = [...src.matchAll(/try \{[\s\S]{0,400}?recordAchievement[\s\S]{0,400}?\} catch/g)];
    ok(`${file}: the call is wrapped so it cannot break the game`, calls.length > 0);
  }

  /* And the row family is registered, or every read throws. */
  const reg = read('server/lib/registry.js');
  ok("the ach_ prefix is registered", /prefix: 'ach_'/.test(reg));
}

/* ── The GET the panel reads ─────────────────────────────────────────── */
{
  const env = makeEnv();
  await recordAchievement(env, 'mtgbbb', UID, { type: 'box', points: 40, blackout: false });

  const session = encodeURIComponent(JSON.stringify({ user_id: UID, display_name: 'P' }));
  const get = async (qs) => {
    const res = await onRequestGet({
      env,
      request: new Request('https://phantomace.tv/api/achievements' + qs, {
        headers: { Cookie: 'pham_session=' + session },
      }),
    });
    return { status: res.status, data: await res.json() };
  };

  const anon = await onRequestGet({
    env, request: new Request('https://phantomace.tv/api/achievements'),
  });
  check('logged out is refused', anon.status, 401);

  const all = await get('');
  check('all four games come back', (all.data.games || []).map(g => g.game),
    ['memory-match', 'commander-bingo', 'pham-shock', 'mtgbbb']);

  const one = await get('?game=mtgbbb');
  check('one game can be asked for', one.data.game, 'mtgbbb');
  const cracked = one.data.achievements.find(a => a.id === 'bbb-first');
  check('an earned one reads unlocked', cracked.unlocked, true);
  ok('with when', typeof cracked.unlockedAt === 'number');

  const fiend = one.data.achievements.find(a => a.id === 'bbb-five');
  check('and an unearned one carries a progress bar', fiend.progress, { cur: 1, goal: 5 });
  check('not yet unlocked', fiend.unlocked, false);
  ok('and names the badge it pays', fiend.reward && fiend.reward.image === '/assets/badges/bbb-five.png');

  const bad = await get('?game=nope');
  check('an unknown game is a 404', bad.status, 404);

  /* A player who has never played reads zeroes rather than failing. */
  const fresh = makeEnv();
  const res = await onRequestGet({
    env: fresh,
    request: new Request('https://phantomace.tv/api/achievements?game=pham-shock', {
      headers: { Cookie: 'pham_session=' + session },
    }),
  });
  const data = await res.json();
  check('a player with no history reads zero progress',
    data.achievements.map(a => a.progress.cur), [0, 0, 0]);
  check('and nothing unlocked', data.achievements.filter(a => a.unlocked), []);
}

/* ── A page actually shows the progress ──────────────────────────────── */
{
  /* Badges reach players whether or not anything reads this endpoint — they
     land in the inventory and on the profile on their own. What needed a
     reader was PROGRESS: without it, an achievement you are part-way through
     looks exactly like one that does not exist. */
  const html = read('inventory.html');
  ok('the inventory page has somewhere to put it', /id="achievementProgress"/.test(html));

  const js = read('js/pages/inventory.js');
  ok('and asks the endpoint for it', /\/api\/achievements/.test(js));
  ok('rendering each game', /renderAchievements/.test(js));
  ok('with a progress bar for the unfinished ones', /inv-ach-bar/.test(js));
  ok('and marking the earned ones', /is-done/.test(js));

  /* It must not be able to take the collection down with it: the grid is
     what the page is for. */
  ok('it loads separately from the collection',
     /loadInventory\(\);\s*\n\s*loadAchievements\(\);/.test(js));
  ok('and hides itself rather than erroring', /box\.hidden = true/.test(js));

  /* THE ART CONTRACT. Twelve badges have no PNG yet; a row must show a glyph
     rather than a broken image, which is what let the engine ship first. */
  ok('a missing badge image falls back to a glyph', /data-fallback/.test(js));

  const css = read('css/pages/inventory.css');
  ok('the panel is styled', /\.inv-ach-row \{/.test(css));

  /* House rules, over the block this change added. */
  const block = css.slice(css.indexOf('/* ── Achievements ─'));
  ok('the achievements block is found', block.length > 200);
  check('no box-shadow', block.match(/box-shadow/g) || [], []);
  check('no backdrop-filter', block.match(/backdrop-filter/g) || [], []);
  check('no coloured side rail', block.match(/border-(left|right):/g) || [], []);
  ok('rarity comes from the tokens', /var\(--rarity-/.test(block));
  check('and no rarity hex is hardcoded', block.match(/#[0-9a-fA-F]{3,6}\b/g) || [], []);

  /* --border-low was never defined in variables.css, so every rule using it
     fell back to currentColor. It had spread to three stylesheets. */
  check('no stylesheet uses an undefined border token',
    [...read('css/pages/inventory.css').matchAll(/var\(--border-low\)/g)].length +
    [...read('css/pages/home.css').matchAll(/var\(--border-low\)/g)].length +
    [...read('css/pages/background-studio.css').matchAll(/var\(--border-low\)/g)].length, 0);
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[achievements] ${passed} assertions passed.`);
