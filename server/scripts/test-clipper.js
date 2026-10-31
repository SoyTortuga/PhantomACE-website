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

import { normalizeConfig, resolveRoute, loadConfig } from '../clipper/config.js';
import { clipMp4Url, pickQuality, clipSourceUrl } from '../clipper/twitch.js';
import { buildFilter, ffmpegArgs, wrapTitle, FRAME } from '../clipper/render.js';
import { buildDescription } from '../clipper/publish/youtube.js';
import { selectForRun, attachRoutes, prioritizeFresh } from '../clipper/run.js';
import { zonedTimeToUtc, slotsFor } from '../clipper/schedule.js';
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

/* exclude: beats both the routes and the fallback */
const EXCL = normalizeConfig({
  routes: [{ label: 'MTG', match: { gameIds: ['2748'] }, youtube: { credsEnv: 'YT_MTG' } }],
  fallback: { label: 'Games', youtube: { credsEnv: 'YT_GAMES' } },
  exclude: { gameIds: ['509672'], gameNames: ['Just Chatting'] },
});
check('excluded by gameId → null, not the fallback', resolveRoute(EXCL, { gameId: '509672' }), null);
check('excluded by gameName (case-insensitive) → null',
  resolveRoute(EXCL, { gameName: 'JUST CHATTING' }), null);
check('a non-excluded unmatched game still reaches the fallback',
  resolveRoute(EXCL, { gameId: '999' }).label, 'Games');
check('a routed game is unaffected by exclude', resolveRoute(EXCL, { gameId: '2748' }).label, 'MTG');
check('config without an exclude block still works',
  resolveRoute(normalizeConfig({ routes: [], fallback: { label: 'F', youtube: { credsEnv: 'Y' } } }),
    { gameId: '1' }).label, 'F');

/* an excluded clip must never be selected, even with room in the run */
const exPool = attachRoutes(
  [clip('irl1', '509672', 500), clip('mtg1', '2748', 10)],
  EXCL, new Map([['509672', 'IRL'], ['2748', 'Magic: The Gathering']]));
check('excluded clip is dropped from selection despite the highest views',
  selectForRun(exPool, { perAccount: 2, maxPerRun: 20, isPosted: () => false }).map(p => p.slug),
  ['mtg1']);

/* a Notepad-saved config carries a UTF-8 BOM; it must still load */
import fsx from 'node:fs';
import osx from 'node:os';
import pathx from 'node:path';
const bomFile = pathx.join(osx.tmpdir(), 'clipper-bom-test.json');
fsx.writeFileSync(bomFile, '\uFEFF' + JSON.stringify({
  routes: [], fallback: { label: 'F', youtube: { credsEnv: 'Y' } },
}), 'utf8');
check('a config saved with a UTF-8 BOM still parses',
  loadConfig(bomFile).fallback.label, 'F');
fsx.unlinkSync(bomFile);

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

/* ── schedule: DST-correct wall-clock -> UTC ──────────────────────────── */

const LA = 'America/Los_Angeles';
check('10:00 PST (winter) is 18:00Z',
  zonedTimeToUtc(2026, 1, 15, 10, 0, LA).toISOString(), '2026-01-15T18:00:00.000Z');
check('10:00 PDT (summer) is 17:00Z — the hour DST would silently lose',
  zonedTimeToUtc(2026, 7, 15, 10, 0, LA).toISOString(), '2026-07-15T17:00:00.000Z');
check('14:00 PST is 22:00Z',
  zonedTimeToUtc(2026, 1, 15, 14, 0, LA).toISOString(), '2026-01-15T22:00:00.000Z');
check('the day after spring-forward is PDT',
  zonedTimeToUtc(2026, 3, 9, 10, 0, LA).toISOString(), '2026-03-09T17:00:00.000Z');
check('the day before spring-forward is still PST',
  zonedTimeToUtc(2026, 3, 7, 10, 0, LA).toISOString(), '2026-03-07T18:00:00.000Z');

const SCHED = { daysAhead: 7, times: ['10:00', '14:00'], timezone: LA };
const slots = slotsFor(Date.parse('2026-10-26T12:00:00Z'), SCHED, 2);
check('slots land 7 days out, in slot order',
  slots.map(d => d.toISOString()),
  ['2026-11-02T18:00:00.000Z', '2026-11-02T22:00:00.000Z']);
check('one slot asked for returns one', slotsFor(Date.now(), SCHED, 1).length, 1);
/* Late UTC on a day is still "today" in Los Angeles, so +7 must not skip a day. */
check('a late-UTC run still targets the right local date',
  slotsFor(Date.parse('2026-10-26T23:30:00Z'), SCHED, 1)[0].toISOString(),
  '2026-11-02T18:00:00.000Z');

/* ── trending: fresh hits jump the backlog ───────────────────────────── */

const NOW = Date.parse('2026-10-26T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
function tclip(slug, views, ageDays) {
  return { slug, gameId: '1', views, title: slug, thumbnailUrl: '', createdAt: daysAgo(ageDays) };
}
const TREND = { withinDays: 14, minViews: 8 };

const pool2 = [
  tclip('old_big', 40, 300),   // the all-time best, but stale
  tclip('fresh_ok', 12, 3),    // recent and over the bar -> should lead
  tclip('fresh_weak', 4, 2),   // recent but under minViews -> backlog
  tclip('old_mid', 20, 200),
];
const ordered = prioritizeFresh(pool2, TREND, NOW).map(c => c.slug);
check('a fresh hit outranks a higher-view stale clip', ordered[0], 'fresh_ok');
check('the rest stay views-desc behind it', ordered, ['fresh_ok', 'old_big', 'old_mid', 'fresh_weak']);
check('fresh clips are flagged',
  prioritizeFresh(pool2, TREND, NOW).filter(c => c.fresh).map(c => c.slug), ['fresh_ok']);
check('a recent clip under the view bar is not a fresh hit',
  prioritizeFresh([tclip('x', 7, 1)], TREND, NOW)[0].fresh, false);
check('an old clip over the view bar is not a fresh hit',
  prioritizeFresh([tclip('y', 999, 90)], TREND, NOW)[0].fresh, false);
check('a clip with no createdAt is never fresh',
  prioritizeFresh([{ slug: 'z', views: 99, createdAt: '' }], TREND, NOW)[0].fresh, false);

/* and that selection actually honours it */
const trendRouted = attachRoutes(pool2, CFG, new Map([['1', 'Magic: The Gathering']]));
check('selectForRun schedules the fresh hit first',
  selectForRun(trendRouted, { perAccount: 2, maxPerRun: 20, isPosted: () => false, trending: TREND, now: NOW })
    .map(p => p.slug),
  ['fresh_ok', 'old_big']);
check('without trending it is plain views-desc',
  selectForRun(trendRouted, { perAccount: 2, maxPerRun: 20, isPosted: () => false })
    .map(p => p.slug),
  ['old_big', 'fresh_ok']);

/* ── schedule config validation ──────────────────────────────────────── */

const SC = normalizeConfig({ routes: [], fallback: { label: 'F', youtube: { credsEnv: 'Y' } } });
check('schedule defaults', SC.schedule.times, ['10:00', '14:00']);
check('trending defaults', [SC.trending.withinDays, SC.trending.minViews], [14, 8]);
throws('fewer slots than perAccount throws', () => normalizeConfig({
  defaults: { perAccount: 3 }, schedule: { times: ['10:00', '14:00'] },
  routes: [], fallback: { label: 'F', youtube: { credsEnv: 'Y' } } }));
throws('a malformed time throws', () => normalizeConfig({
  schedule: { times: ['25:00'] }, routes: [], fallback: { label: 'F', youtube: { credsEnv: 'Y' } } }));
throws('an unknown timezone throws', () => normalizeConfig({
  schedule: { timezone: 'Mars/Olympus' }, routes: [], fallback: { label: 'F', youtube: { credsEnv: 'Y' } } }));

/* ── clip MP4 URL derivation ──────────────────────────────────────────── */

check('derive mp4 from thumbnail',
  clipMp4Url('https://clips-media-assets2.twitch.tv/AbCdEf-preview-480x272.jpg'),
  'https://clips-media-assets2.twitch.tv/AbCdEf.mp4');
check('thumbnail without -preview- → null', clipMp4Url('https://x/y.jpg'), null);

/* ── GQL clip source: quality choice and signed-url assembly ─────────── */

const QUALITIES = [
  { quality: '360', frameRate: 30, sourceURL: 'https://cdn/x/360/index.mp4' },
  { quality: '1080', frameRate: 60, sourceURL: 'https://cdn/x/1080/index.mp4' },
  { quality: '720', frameRate: 60, sourceURL: 'https://cdn/x/720/index.mp4' },
];
check('picks 1080 when offered', pickQuality(QUALITIES).quality, '1080');
check('ignores anything above 1080 — the render is 1080 wide anyway',
  pickQuality([{ quality: '2160', sourceURL: 'a' }, { quality: '720', sourceURL: 'b' }]).quality, '720');
check('falls back to the lowest when everything exceeds 1080',
  pickQuality([{ quality: '2160', sourceURL: 'a' }, { quality: '1440', sourceURL: 'b' }]).quality, '1440');
check('skips entries with no sourceURL',
  pickQuality([{ quality: '1080' }, { quality: '720', sourceURL: 'b' }]).quality, '720');
check('no qualities -> null', pickQuality([]), null);

/* A fake GQL endpoint: records what was sent, answers like Twitch. */
function fakeGql(payload, { failPersisted = false } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, clientId: init.headers['Client-ID'] });
    const isPersisted = Array.isArray(body);
    if (isPersisted && failPersisted) return { ok: true, json: async () => [{ errors: [{ message: 'PersistedQueryNotFound' }] }] };
    return { ok: true, json: async () => (isPersisted ? [payload] : payload) };
  };
  return { impl, calls };
}

const GOOD = { data: { clip: {
  playbackAccessToken: { signature: 'SIG123', value: '{"expires":1}' },
  videoQualities: QUALITIES,
} } };

await (async () => {
  const { impl, calls } = fakeGql(GOOD);
  const url = await clipSourceUrl('MySlug', { fetchImpl: impl });
  const u = new URL(url);
  check('uses the 1080 source', u.origin + u.pathname, 'https://cdn/x/1080/index.mp4');
  check('attaches the signature', u.searchParams.get('sig'), 'SIG123');
  check('attaches the token', u.searchParams.get('token'), '{"expires":1}');
  check('sends Twitch\u2019s web client id', calls[0].clientId, 'kimne78kx3ncx6brgo4mv6wki5h1ko');
  check('asks for the right slug', calls[0].body[0].variables.slug, 'MySlug');
  check('tries the persisted query first', Array.isArray(calls[0].body), true);
  check('one call is enough when it works', calls.length, 1);
})();

await (async () => {
  /* Twitch rotates the persisted hash -> fall through to the query text. */
  const { impl, calls } = fakeGql(GOOD, { failPersisted: true });
  const url = await clipSourceUrl('MySlug', { fetchImpl: impl });
  ok('still resolves when the persisted hash is rejected', url.includes('sig=SIG123'));
  check('falls back to sending the query text', typeof calls[1].body.query, 'string');
})();

await (async () => {
  const dead = async () => ({ ok: true, json: async () => [{ data: { clip: null } }] });
  let msg = '';
  try { await clipSourceUrl('Gone', { fetchImpl: dead }); } catch (e) { msg = e.message; }
  ok('a deleted clip fails loudly rather than silently', msg.includes('no clip'));
})();

await (async () => {
  const noToken = async () => ({ ok: true, json: async () => [{ data: { clip: { videoQualities: QUALITIES } } }] });
  let msg = '';
  try { await clipSourceUrl('X', { fetchImpl: noToken }); } catch (e) { msg = e.message; }
  ok('a missing playback token fails loudly', msg.includes('playback token'));
})();

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

/* ── the CLI entry guard must be path-correct on Windows ─────────────── */

import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

/* `file://${process.argv[1]}` is a Linux-only approximation. On the rig the
   repo lives under "PhantomACE Website" — argv[1] keeps the space literal and
   uses backslashes, while import.meta.url percent-encodes it. The two never
   matched, so run.js loaded, skipped main(), printed nothing and exited 0. */
const spaced = '/tmp/Phantom ACE Website/run.js';
check('a path with a space does NOT survive naive concatenation',
  ('file://' + spaced) === pathToFileURL(spaced).href, false);
check('pathToFileURL encodes the space',
  pathToFileURL(spaced).href, 'file:///tmp/Phantom%20ACE%20Website/run.js');

const runSrc = readFileSync(new URL('../clipper/run.js', import.meta.url), 'utf8');
/* Match the COMPARISON, not the bare template — the comment above the guard
   quotes the broken form on purpose, to explain it. */
ok('run.js does not compare against a naive file:// string',
  !runSrc.includes('=== `file://'));
ok('run.js guards its entry point with pathToFileURL',
  runSrc.includes('pathToFileURL(process.argv[1]).href'));

/* ── report ───────────────────────────────────────────────────────────── */

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ clipper: ${passed} checks passed`);
