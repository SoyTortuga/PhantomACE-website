#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CLIPPER — the pure logic of the clips → Shorts/TikTok bot.

     node server/scripts/test-clipper.js

   Everything here runs without a network or ffmpeg: config validation and
   game→account routing, the per-account selection (2 each, skip the posted,
   respect the ceiling), the ffmpeg filtergraph string, the clip MP4-URL
   derivation, the YouTube description, and the posted-ledger over a fake KV.
   The actual Helix calls, ffmpeg spawn and uploads are IO and are not covered.
   ══════════════════════════════════════════════ */

import { normalizeConfig, resolveRoute } from '../clipper/config.js';
import { clipMp4Url } from '../clipper/twitch.js';
import { buildFilter, ffmpegArgs, wrapTitle, FRAME } from '../clipper/render.js';
import { buildDescription } from '../clipper/publish/youtube.js';
import { selectForRun, attachRoutes } from '../clipper/run.js';
import { wasPosted, recordPosted, listPosted } from '../clipper/state.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);
function throws(label, fn) {
  try { fn(); failures.push(`${label}\n      expected a throw, got none`); }
  catch { passed++; }
}

/* ── config + routing ─────────────────────────────────────────────────── */

const CFG = normalizeConfig({
  defaults: { lookbackDays: 365, perAccount: 2, minViews: 5 },
  routes: [
    { label: 'MTG', match: { gameIds: ['29452'], gameNames: ['Magic: The Gathering'] },
      hashtags: ['#MTG'], youtube: { credsEnv: 'YT_MTG' }, tiktok: { credsEnv: 'TT_MTG' } },
    { label: 'Minecraft', match: { gameIds: ['27471'] },
      youtube: { credsEnv: 'YT_MC' } },
  ],
  fallback: { label: 'Main', youtube: { credsEnv: 'YT_MAIN' } },
});

check('defaults merged', CFG.defaults.perAccount, 2);
check('defaults fill unset', CFG.defaults.maxDurationSec, 60);
check('tiktok defaults to SELF_ONLY', CFG.routes[0].tiktok.privacy, 'SELF_ONLY');
check('youtube defaults to public', CFG.routes[0].youtube.privacy, 'public');
check('gameNames lowercased', CFG.routes[0].match.gameNames, ['magic: the gathering']);

check('route by gameId', resolveRoute(CFG, { gameId: '29452' }).label, 'MTG');
check('route by gameName (case-insensitive)',
  resolveRoute(CFG, { gameName: 'MAGIC: THE GATHERING' }).label, 'MTG');
check('route by id for name-less route', resolveRoute(CFG, { gameId: '27471' }).label, 'Minecraft');
check('unmatched falls to fallback', resolveRoute(CFG, { gameId: '999' }).label, 'Main');

const NOFALL = normalizeConfig({ routes: [CFG_rawRoute()], fallback: null });
function CFG_rawRoute() { return { label: 'X', match: { gameIds: ['1'] }, youtube: { credsEnv: 'Y' } }; }
check('no fallback → null', resolveRoute(NOFALL, { gameId: '42' }), null);

throws('route without a destination throws',
  () => normalizeConfig({ routes: [{ label: 'bad', match: {} }] }));
throws('route without a label throws',
  () => normalizeConfig({ routes: [{ match: {}, youtube: { credsEnv: 'Y' } }] }));
throws('bad lookbackDays throws',
  () => normalizeConfig({ defaults: { lookbackDays: 0 }, routes: [] }));

/* ── selection: 2 per account, skip posted, ceiling ───────────────────── */

function clip(slug, gameId, views) {
  return { slug, gameId, views, title: slug, thumbnailUrl: '' };
}
/* View-desc pool: MTG has 4 clips, Minecraft 3, one unroutable-but-fallback. */
const pool = [
  clip('a', '29452', 100), clip('b', '29452', 90), clip('c', '29452', 80), clip('d', '29452', 70),
  clip('e', '27471', 60), clip('f', '27471', 50), clip('g', '27471', 40),
  clip('h', '999', 30),
];
const names = new Map([['29452', 'Magic: The Gathering'], ['27471', 'Minecraft'], ['999', 'Pacman']]);
const routed = attachRoutes(pool, CFG, names);

check('attachRoutes sets gameName', routed[0].gameName, 'Magic: The Gathering');
check('attachRoutes routes fallback', routed[7].route.label, 'Main');

const picksFresh = selectForRun(routed, { perAccount: 2, maxPerRun: 20, isPosted: () => false });
/* MTG 2 + Minecraft 2 + Main 1 (the fallback account only has clip h) = 5. */
check('2 per account, capped by each account’s supply', picksFresh.length, 5);
check('MTG picks are the 2 highest-view', picksFresh.filter(p => p.route.label === 'MTG').map(p => p.slug), ['a', 'b']);
check('Minecraft picks are the 2 highest-view', picksFresh.filter(p => p.route.label === 'Minecraft').map(p => p.slug), ['e', 'f']);
check('fallback account also gets its clip', picksFresh.filter(p => p.route.label === 'Main').map(p => p.slug), ['h']);

const posted = new Set(['a', 'e']);
const picksAfter = selectForRun(routed, { perAccount: 2, maxPerRun: 20, isPosted: (s) => posted.has(s) });
check('skips posted, tops up to 2 from the next-best', picksAfter.filter(p => p.route.label === 'MTG').map(p => p.slug), ['b', 'c']);
check('Minecraft tops up past posted e', picksAfter.filter(p => p.route.label === 'Minecraft').map(p => p.slug), ['f', 'g']);

const capped = selectForRun(routed, { perAccount: 2, maxPerRun: 3, isPosted: () => false });
check('maxPerRun ceiling honoured', capped.length, 3);

const noFallPool = attachRoutes([clip('z', '999', 10)], NOFALL, new Map([['999', 'Pacman']]));
check('unrouted + no fallback → not selected',
  selectForRun(noFallPool, { perAccount: 2, maxPerRun: 20, isPosted: () => false }).length, 0);

/* ── clip MP4 URL derivation ──────────────────────────────────────────── */

check('derive mp4 from thumbnail',
  clipMp4Url('https://clips-media-assets2.twitch.tv/AbCdEf-preview-480x272.jpg'),
  'https://clips-media-assets2.twitch.tv/AbCdEf.mp4');
check('thumbnail without -preview- → null', clipMp4Url('https://x/y.jpg'), null);

/* ── ffmpeg filtergraph ───────────────────────────────────────────────── */

const fWithLogo = buildFilter({ hasLogo: true });
ok('filter targets 1080x1920', fWithLogo.includes(`scale=${FRAME.width}:${FRAME.height}`));
ok('filter crops to frame', fWithLogo.includes(`crop=${FRAME.width}:${FRAME.height}`));
ok('filter blurs the bg', fWithLogo.includes('boxblur'));
ok('filter darkens the bg', fWithLogo.includes('brightness=-0.38'));
ok('filter draws the red hairline', fWithLogo.includes(`color=${FRAME.accent}`));
ok('filter draws the near-solid band', fWithLogo.includes(FRAME.band));
ok('filter sets the title from a staged file', fWithLogo.includes('textfile=title.txt'));
ok('filter uses the staged font (no path to escape)', fWithLogo.includes('fontfile=font.ttf'));
ok('no box-shadow / backdrop-filter sneaks in', !/shadow|backdrop|gblur/.test(fWithLogo));
ok('with logo → overlays a scaled logo', fWithLogo.includes('[logo];[vtxt][logo]overlay'));
ok('ends at [vout]', fWithLogo.trim().endsWith('[vout]'));
ok('without logo → still ends at [vout]', buildFilter({ hasLogo: false }).trim().endsWith('[vout]'));

const args = ffmpegArgs({ input: 'in.mp4', output: 'short.mp4', filter: fWithLogo, hasLogo: true, logoFile: 'logo.png', maxDurationSec: 60 });
ok('args map the composited video', args.includes('[vout]'));
ok('args keep audio if present', args.includes('0:a?'));
ok('args cap duration', args[args.indexOf('-t') + 1] === '60');
ok('args output faststart', args.includes('+faststart'));
ok('args take two inputs with a logo', args.filter(a => a === '-i').length === 2);

/* ── title wrapping ───────────────────────────────────────────────────── */

check('short title → one line', wrapTitle('Big play'), ['Big play']);
check('long title wraps to <=2 lines', wrapTitle('this is a really quite long clip title that keeps going').length <= 2, true);
ok('overflow is ellipsised', wrapTitle('alpha bravo charlie delta echo foxtrot golf hotel india').join(' ').includes('…'));

/* ── youtube description ──────────────────────────────────────────────── */

ok('description leads with #Shorts', buildDescription({ hashtags: ['#MTG'] }).startsWith('#Shorts'));
ok('description keeps route hashtags', buildDescription({ hashtags: ['#MTG'] }).includes('#MTG'));
check('description does not double #Shorts',
  (buildDescription({ hashtags: ['#shorts', '#MTG'] }).match(/#Shorts/gi) || []).length, 1);

/* ── ledger over a fake KV ────────────────────────────────────────────── */

function fakeKv() {
  const store = new Map();
  return {
    async get(key) { const v = store.get(key); return v === undefined ? null : v; },
    async put(key, val) { store.set(key, JSON.parse(JSON.stringify(val))); },
    async mutate(key, fn) {
      const cur = store.get(key) ?? null;
      const next = fn(cur ? JSON.parse(JSON.stringify(cur)) : null);
      store.set(key, JSON.parse(JSON.stringify(next)));
      return next;
    },
  };
}

await (async () => {
  const kv = fakeKv();
  check('nothing posted initially', await wasPosted(kv, 'a'), false);
  await recordPosted(kv, 'a', { route: 'MTG', youtube: { id: 'yt1' } });
  check('posted after record', await wasPosted(kv, 'a'), true);
  check('a different clip is still unposted', await wasPosted(kv, 'b'), false);

  await recordPosted(kv, 'a', { route: 'MTG', youtube: { id: 'yt1' }, tiktok: { id: 'tt1' } });
  const all = await listPosted(kv);
  check('re-recording the same slug does not duplicate the order entry',
    all.filter(p => p.slug === 'a').length, 1);
  check('listPosted carries the record', all[0].youtube.id, 'yt1');
})();

/* ── report ───────────────────────────────────────────────────────────── */

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ clipper: ${passed} checks passed`);
