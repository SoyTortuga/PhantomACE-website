#!/usr/bin/env node
/* ══════════════════════════════════════════════
   EVENT BADGES ON CHECK-IN — test suite

     node server/scripts/test-checkin-badges.js

   A window that opens an hour late, or closes an hour early, is invisible
   until the event is over and somebody says they checked in and got
   nothing. There is no way to notice it by looking at the code: 15:00 UTC
   is either 08:00 Pacific or it is not, and the difference is one line in a
   timezone table nobody re-reads.

   So the window is asserted from BOTH ends here — as the absolute instant
   the handler compares against, and as the Pacific wall-clock time the
   broadcaster announced. The second is what makes a PDT/PST slip fail a
   test instead of failing an event.

   The rest guards the thing this codebase gets wrong repeatedly: two
   grants of the same item. The Agate Hunt badge is ALSO claimable by code,
   so somebody who does both must end up with one badge, not two.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHECKIN_BADGES, badgesOpenAt, grantOpenBadges } from '../../functions/api/checkin-badges.js';

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

const AGATE = CHECKIN_BADGES.find(b => b.id === 'agate-hunt');

/** What a clock in Los Angeles reads at an instant. */
const pacific = (ms) => new Date(ms).toLocaleString('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

/* ── The window, read off a Pacific clock ────────────────────────────── */
{
  ok('the Agate Hunt window exists', !!AGATE);

  /* THE ASSERTION THAT CATCHES A PST/PDT SLIP. September is daylight time
     on the west coast; an instant computed as UTC−8 reads 09:00 here, and
     the event would open an hour late with nothing else to show for it. */
  check('entries open at 08:00 Pacific on the 17th', pacific(AGATE.from), '09/17/2026, 08:00');
  check('and close at 17:00 Pacific on the 18th', pacific(AGATE.to), '09/18/2026, 17:00');

  /* And the same fact from the other side, so a change to one form without
     the other cannot pass. */
  check('which is 15:00 UTC', new Date(AGATE.from).toISOString(), '2026-09-17T15:00:00.000Z');
  check('to 00:00 UTC the next day', new Date(AGATE.to).toISOString(), '2026-09-19T00:00:00.000Z');
  check('a 33-hour window', (AGATE.to - AGATE.from) / 3600000, 33);
}

/* ── Open and shut ───────────────────────────────────────────────────── */
{
  const ids = (at) => badgesOpenAt(at).map(b => b.id);
  const min = 60000;

  check('nothing a minute before it opens', ids(AGATE.from - min), []);
  /* Half-open on purpose: earned AT the opening instant, not at the closing
     one, so two adjacent windows can never both pay. */
  check('open on the opening instant', ids(AGATE.from), ['agate-hunt']);
  check('open in the middle', ids(AGATE.from + 12 * 60 * min), ['agate-hunt']);
  check('open a minute before it closes', ids(AGATE.to - min), ['agate-hunt']);
  check('shut on the closing instant', ids(AGATE.to), []);
  check('and shut a day later', ids(AGATE.to + 1440 * min), []);
  check('and shut a year earlier', ids(Date.UTC(2025, 8, 17, 19, 0, 0)), []);
}

/* ── Granting ────────────────────────────────────────────────────────── */
{
  const inv = { userId: '1', items: [], equips: {} };
  const granted = grantOpenBadges(inv, AGATE.from + 1000);
  check('checking in during the window earns it', granted.map(b => b.id), ['agate-hunt']);
  check('and it lands in the inventory', inv.items.length, 1);

  const item = inv.items[0];
  check('as a badge', item.type, 'badge');
  check('on the profile', item.game, 'profile');
  check('named for the event', item.name, 'Agate Hunt');
  check('at its rarity', item.rarity, 'exclusive');
  check('not consumable', item.consumable, false);
  check('one of them', item.quantity, 1);
  check('marked as earned by checking in', item.source, 'pham-checkin');
  /* meta.image is where the inventory, profile and forum all look for
     artwork. Without it the badge renders as a rarity glyph — which is how
     the milestone badges shipped, and needed a backfill script. */
  check('carrying its artwork', item.meta && item.meta.image, '/assets/badges/agate-hunt.png');
  /* Stamped with WHEN IT WAS EARNED, not when the row was written. On the
     live path those are the same instant; on a backfill they are not, and
     grant order is the only record of who was first. */
  check('and stamped with when it was earned', item.grantedAt, AGATE.from + 1000);
}

/* ── Never twice ─────────────────────────────────────────────────────── */
{
  const inv = { userId: '1', items: [], equips: {} };
  grantOpenBadges(inv, AGATE.from + 1000);
  const again = grantOpenBadges(inv, AGATE.from + 2000);
  check('checking in twice earns it once', again, []);
  check('and leaves one badge', inv.items.length, 1);

  /* THE ONE THAT MATTERS. The same badge is claimable at /redeem with a
     minted code, which writes source: 'item-code'. Somebody who does both
     must end up holding one Agate Hunt. */
  const claimed = {
    userId: '2',
    items: [{ id: 'agate-hunt', game: 'profile', type: 'badge', name: 'Agate Hunt', source: 'item-code' }],
    equips: {},
  };
  check('a badge already claimed by code is not granted again', grantOpenBadges(claimed, AGATE.from + 1000), []);
  check('leaving the code-claimed one alone', claimed.items.length, 1);
  check('and untouched', claimed.items[0].source, 'item-code');
}

/* ── Identity is type PLUS id ────────────────────────────────────────── */
{
  /* The site has two things called 'void' — a skull skin and a click
     effect — and deduping on id alone once swallowed a real grant. A
     same-id item of a DIFFERENT type must not block this badge. */
  const inv = {
    userId: '3',
    items: [{ id: 'agate-hunt', game: 'profile', type: 'title', name: 'Agate Hunter' }],
    equips: {},
  };
  check('a same-id item of another type does not block it', grantOpenBadges(inv, AGATE.from + 1000).map(b => b.id), ['agate-hunt']);
  check('so both are held', inv.items.length, 2);
}

/* ── Outside the window, nothing happens at all ──────────────────────── */
{
  const inv = { userId: '4', items: [], equips: {} };
  check('a check-in before the event earns nothing', grantOpenBadges(inv, AGATE.from - 1), []);
  check('and writes nothing', inv.items, []);

  const after = { userId: '5', items: [], equips: {} };
  grantOpenBadges(after, AGATE.to);
  check('a check-in after it closes earns nothing', after.items, []);
}

/* ── An inventory that has never held anything ───────────────────────── */
{
  /* getInventory returns {items: []} — but mutate() hands the raw stored
     row, and the oldest ones predate the field. */
  const bare = { userId: '6' };
  check('an inventory with no items array still works', grantOpenBadges(bare, AGATE.from + 1000).length, 1);
  check('and gets one', bare.items.length, 1);
}

/* ── It matches the code-minted badge exactly ────────────────────────── */
{
  /* Two definitions of one badge. If they drift, a viewer holds an "Agate
     Hunt" whose artwork or rarity depends on how they got it. */
  const mint = fs.readFileSync(path.join(REPO, 'server/scripts/mint-badge-code.js'), 'utf8');
  const block = /'agate-hunt':\s*\{([\s\S]*?)\n  \}/.exec(mint);
  ok('mint-badge-code still defines agate-hunt', !!block);
  const field = (name) => {
    const m = new RegExp(name + ":\\s*'([^']*)'").exec(block ? block[1] : '');
    return m ? m[1] : null;
  };
  check('same id', field('id'), AGATE.id);
  check('same name', field('name'), AGATE.name);
  check('same rarity', field('rarity'), AGATE.rarity);
  check('same artwork', field('image'), AGATE.image);

  /* And the artwork is on disk. A badge granted against a missing file
     renders as nothing, and by the time anyone notices it is in
     inventories. */
  ok('the artwork exists', fs.existsSync(path.join(REPO, AGATE.image.replace(/^\//, ''))));
}

/* ── Every badge the minter offers, not just this one ─────────────────── */
{
  /* The block above pins agate-hunt field for field. It says nothing about
     the other entries, and one of them shipped with no `id`, `game` or
     `type` at all -- createItemCode() stores what it is handed, so that
     would have minted a real, redeemable code granting an item with
     `id: undefined`: unequippable, missing from every inventory filter, and
     already in an account before anyone looked.

     --confirm is not needed and no database is touched: the script now
     validates its whole table at startup, so --list exercises the guard for
     every badge including ones added after this test was written. */
  const run = spawnSync(process.execPath,
    [path.join(REPO, 'server/scripts/mint-badge-code.js'), '--list'],
    { encoding: 'utf8' });
  check('every mintable badge is completely defined', run.status, 0);
  if (run.status !== 0) {
    /* Node's own module warnings go to stderr too, and reporting the whole
       stream buries the one line that says which badge is wrong. */
    const said = (run.stderr || '').split('\n').map(l => l.trim())
      .filter(l => l.startsWith('[mint-badge-code]'));
    failures.push(`  minter said: ${said.join('; ') || (run.stderr || '').trim()}`);
  }

  /* And each one names artwork that is really there. */
  for (const m of (run.stdout || '').matchAll(/(\/assets\/badges\/\S+)/g)) {
    ok(`${m[1]} exists`, fs.existsSync(path.join(REPO, m[1].replace(/^\//, ''))));
  }
}

/* ── Every rarity a badge can carry is drawn everywhere it is shown ── */
{
  /* A RARITY THAT IS NOT STYLED IS A RARITY THAT RENDERS AS NOTHING.
     Four stylesheets colour a badge's rarity, on three different class
     shapes, and a new one added to the data alone falls through every
     selector — the tag renders in inherited grey and looks like a bug
     nobody can reproduce, because it only affects the people who earned it.

     Checked against the rarities CHECKIN_BADGES actually uses rather than a
     hardcoded list, so the next event badge is covered by writing it. */
  const rarities = [...new Set(CHECKIN_BADGES.map(b => b.rarity))];

  const surfaces = [
    ['inventory, equipped', 'css/pages/inventory.css', r => `.equipped-item.rarity-${r}`],
    ['inventory, collection', 'css/pages/inventory.css', r => `.collection-item.rarity-${r}`],
    ['inventory, the tag', 'css/pages/inventory.css', r => `.rarity-${r} .item-rarity-tag`],
    ['redeem, text', 'css/pages/redeem.css', r => `.rarity-${r}`],
    ['redeem, border', 'css/pages/redeem.css', r => `.rarity-border-${r}`],
    ['profile', 'css/pages/profile.css', r => `.prof-rarity.r-${r}`],
  ];

  for (const [where, file, selector] of surfaces) {
    const css = fs.readFileSync(path.join(REPO, file), 'utf8');
    const missing = rarities.filter(r => !css.includes(selector(r)));
    check(`every event rarity is styled — ${where}`, missing, []);
  }

  /* One definition of the colour, not four. The existing four rarities
     already disagree across these files; this is the one that cannot. */
  const vars = fs.readFileSync(path.join(REPO, 'css/variables.css'), 'utf8');
  ok('the exclusive colour is a token', /--exclusive:\s*#[0-9a-fA-F]{3,8};/.test(vars));

  /* And it sorts above everything, or it lands mid-list in a collection
     where its whole point is being at the top. */
  const inv = fs.readFileSync(path.join(REPO, 'js/pages/inventory.js'), 'utf8');
  const order = /const RARITY_ORDER = \{([^}]*)\}/.exec(inv);
  ok('the inventory ranks rarities', !!order);
  const ranks = Object.fromEntries((order ? order[1] : '').split(',')
    .map(p => p.split(':').map(x => x.trim())).filter(p => p.length === 2)
    .map(([k, v]) => [k, Number(v)]));
  check('exclusive outranks mythic', ranks.exclusive < ranks.mythic, true);
}

/* ── The handler actually calls it ───────────────────────────────────── */
{
  /* A pure function nothing invokes passes every test above and grants
     nobody anything. */
  const cp = fs.readFileSync(path.join(REPO, 'functions/api/channel-points.js'), 'utf8');
  const handler = /'pham-checkin':\s*async[\s\S]*?\n  \},/.exec(cp);
  ok('the check-in handler exists', !!handler);
  ok('and grants open event badges', /grantOpenBadges\(/.test(handler ? handler[0] : ''));
  /* Under mutate, because the theme-unlock handler writes the same row. */
  ok('through mutate, not read-modify-write', /mutate\(inventoryKey\(userId\)/.test(handler ? handler[0] : ''));

  const router = fs.readFileSync(path.join(REPO, 'server/router.js'), 'utf8');
  /* A library under functions/ that is not declared fails the boot. */
  ok('the module is declared a non-route', /'api\/checkin-badges\.js'/.test(router));
}

/* ── END TO END, through the real webhook ───────────────────────────── */
{
  /* Everything above tests a pure function and a regex. Neither would have
     caught the giveaway bug last week, where a function was correct and the
     path that should have called it did not. So: a signed Twitch redemption
     goes in at the top, and the badge comes out of the inventory row.

     Date.now is stubbed because the window is a fixed instant and the test
     has to run before, during and after the event without changing. */
  const { signEventSub } = await import('../lib/eventsub.js');
  const SECRET = 'a-test-eventsub-secret';

  const store = new Map();
  const chains = new Map();
  const env = {
    TWITCH_EVENTSUB_SECRET: SECRET,
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
  };

  async function checkIn(userId) {
    const raw = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: { id: 'r' + userId, user_id: String(userId), user_name: 'viewer' + userId, reward: { id: 'rw', title: 'Pham Check-In' } },
    });
    const id = 'mid-' + userId + '-' + Date.now();
    /* From the stubbed clock, not `new Date()`. The verifier rejects any
       message more than ten minutes from now, so a request stamped with the
       real time and judged against a stubbed one is a replay — 403, and
       nothing below it ever runs. */
    const ts = new Date(Date.now()).toISOString();
    const request = new Request('https://phantomace.tv/api/channel-points', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-id': id,
        'twitch-eventsub-message-timestamp': ts,
        'twitch-eventsub-message-signature': await signEventSub(SECRET, id, ts, raw),
      },
      body: raw,
    });
    const mod = await import('../../functions/api/channel-points.js');
    return mod.onRequestPost({ env, request });
  }

  const badges = (userId) => {
    const raw = store.get('inv_' + userId);
    return raw ? JSON.parse(raw).items.filter(i => i.type === 'badge').map(i => i.id) : [];
  };

  const realNow = Date.now;
  try {
    /* Before the event. */
    Date.now = () => AGATE.from - 60000;
    const early = await checkIn('early');
    check('a check-in before the window is accepted', early.status, 200);
    check('and earns no badge', badges('early'), []);

    /* During. */
    Date.now = () => AGATE.from + 3600000;
    const during = await checkIn('lucky');
    check('a check-in during the window is accepted', during.status, 200);
    check('and earns the badge', badges('lucky'), ['agate-hunt']);
    /* The redemption still does everything it did before. */
    ok('and is still recorded as present', !!store.get('checkin_current'));
    ok('with a streak history', !!store.get('ci_lucky'));

    /* After. */
    Date.now = () => AGATE.to + 60000;
    const late = await checkIn('late');
    check('a check-in after the window is accepted', late.status, 200);
    check('and earns no badge', badges('late'), []);
    /* And the badge already earned is not taken back — this is a window on
       EARNING it, not on holding it. */
    check('a badge earned during the window is kept', badges('lucky'), ['agate-hunt']);
  } finally {
    Date.now = realNow;
  }
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[checkin-badges] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[checkin-badges] ${passed} assertions passed.`);
console.log('');
