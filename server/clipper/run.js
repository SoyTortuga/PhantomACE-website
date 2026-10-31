/* ══════════════════════════════════════════════
   THE CLIPPER BOT — one run.

   Daily on the rig (a scheduled task; see README):
     1. pull the clip pool over the lookback window (default 12 months),
        highest-view first;
     2. resolve each clip's game (the category at clip time) and route it to an
        account via config.js;
     3. per account (per route), take the top `perAccount` clips not already
        posted — so a 12-month backlog drains a couple per account per day;
     4. download -> render 1080×1920 gothic Short -> upload to that route's
        YouTube and TikTok (each no-ops if its creds are absent);
     5. record every success so the clip is never reposted.

   SELECTION IS PURE (attachRoutes + selectForRun) so the "2 per account, skip
   the already-posted, respect the ceiling" logic is unit-tested without a
   single network call. main() does the IO around it.

   "Per account" == per route by construction: a YouTube/TikTok account is one
   route that lists all of its games' ids, so two games sharing a channel share
   one cap. See config.example.json.

   Flags:
     --dry-run     select and log; render if --render, never upload or record
     --render      (with --dry-run) actually produce the MP4s for inspection
     --limit N     override maxPerRun for this invocation
     --config PATH override the config path
   ══════════════════════════════════════════════ */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig, resolveRoute } from './config.js';
import { findClips, resolveGames, downloadClip } from './twitch.js';
import { renderVertical } from './render.js';
import { slotsFor } from './schedule.js';
import { listPosted, recordPosted } from './state.js';
import * as youtube from './publish/youtube.js';
import * as tiktok from './publish/tiktok.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.join(HERE, '../../assets/fonts/GODOFWAR.TTF');
const LOGO = path.join(HERE, '../../assets/images/phantomace-logo.png');

/* ── pure selection ───────────────────────────────────────────────────── */

/** Attach { gameName, route } to each clip. Pure given the resolved names. */
export function attachRoutes(clips, config, gameNames) {
  return clips.map((c) => {
    const gameName = gameNames.get(c.gameId) || '';
    return { ...c, gameName, route: resolveRoute(config, { gameId: c.gameId, gameName }) };
  });
}

/**
 * Put FRESH HITS first: a clip created within `withinDays` that already has
 * `minViews` is taking off now, and ranking purely on lifetime views would
 * bury it under a year-old clip with one more view. Within each tier the
 * order is still views-desc. Pure.
 *
 * @param {object[]} clips
 * @param {{withinDays:number, minViews:number}} trending
 * @param {number} [now]
 */
export function prioritizeFresh(clips, trending, now = Date.now()) {
  const cutoff = now - trending.withinDays * 86400000;
  const fresh = [], rest = [];
  for (const c of clips) {
    const at = Date.parse(c.createdAt || '');
    const isFresh = Number.isFinite(at) && at >= cutoff && (c.views || 0) >= trending.minViews;
    (isFresh ? fresh : rest).push({ ...c, fresh: isFresh });
  }
  const byViews = (a, b) => (b.views || 0) - (a.views || 0);
  return [...fresh.sort(byViews), ...rest.sort(byViews)];
}

/**
 * Pick what to post this run: top `perAccount` per route, skipping the already
 * posted, capped at `maxPerRun`. Fresh hits are considered first. Pure.
 * @param {object[]} routedClips  from attachRoutes
 * @param {object} o
 * @param {number} o.perAccount
 * @param {number} o.maxPerRun
 * @param {(slug:string)=>boolean} o.isPosted
 * @param {object} [o.trending] omit to keep plain views-desc order
 * @param {number} [o.now]
 */
export function selectForRun(routedClips, { perAccount, maxPerRun, isPosted, trending, now = Date.now() }) {
  const ordered = trending ? prioritizeFresh(routedClips, trending, now) : routedClips;
  const perRoute = new Map();
  const picks = [];
  for (const c of ordered) {
    if (!c.route) continue;              // unrouted game, no fallback — skip
    if (isPosted(c.slug)) continue;
    const count = perRoute.get(c.route.label) || 0;
    if (count >= perAccount) continue;
    perRoute.set(c.route.label, count + 1);
    picks.push(c);
    if (picks.length >= maxPerRun) break;
  }
  return picks;
}

/* ── one clip, end to end ─────────────────────────────────────────────── */

async function processClip(env, clip, { workDir, dryRun, doRender }) {
  const route = clip.route;
  const log = (m) => console.log(`[clipper] ${clip.slug} (${route.label}): ${m}`);
  const jobDir = path.join(workDir, clip.slug);
  const raw = path.join(jobDir, 'source.mp4');
  const out = path.join(jobDir, 'short.mp4');
  fs.mkdirSync(jobDir, { recursive: true });

  log(`"${clip.title}" — ${clip.views} views, game ${clip.gameName || clip.gameId || 'unknown'}` +
    (clip.fresh ? ' [FRESH HIT]' : '') +
    (clip.publishAt ? ` — YouTube publishes ${clip.publishAt.toISOString()}` : ''));

  if (dryRun && !doRender) return { slug: clip.slug, dryRun: true };

  await downloadClip(clip, raw);
  await renderVertical({
    input: raw, output: out, title: clip.title,
    fontFile: FONT, logoFile: LOGO, footer: '@PhantomACE',
    maxDurationSec: env.__maxDurationSec || 60,
    zoom: route.zoom, layout: route.layout,
  });
  log(`rendered ${out} (${route.layout ? 'stacked cam+game' : `zoom ${route.zoom}`})`);

  if (dryRun) return { slug: clip.slug, rendered: out };

  const record = {
    route: route.label, title: clip.title, fresh: !!clip.fresh,
    scheduledFor: clip.publishAt ? clip.publishAt.toISOString() : null,
    youtube: null, tiktok: null,
  };

  if (route.youtube) {
    const creds = youtube.credsFromEnv(env, route.youtube.credsEnv);
    if (!creds) { log(`youtube (${route.youtube.credsEnv}): not configured — skipping`); }
    else {
      try {
        const r = await youtube.uploadShort({
          creds, file: out, title: clip.title, hashtags: route.hashtags,
          privacy: route.youtube.privacy, publishAt: clip.publishAt,
        });
        record.youtube = { id: r.id, url: r.url, publishAt: r.publishAt };
        log(`youtube: ${r.url}` + (r.publishAt ? ` (scheduled ${r.publishAt})` : ''));
      } catch (err) { record.youtube = { error: err.message }; log(`youtube FAILED: ${err.message}`); }
    }
  }

  if (route.tiktok) {
    const creds = tiktok.credsFromEnv(env, route.tiktok.credsEnv);
    if (!creds) { log(`tiktok (${route.tiktok.credsEnv}): not configured — skipping`); }
    else {
      try {
        const r = await tiktok.uploadVideo({ creds, file: out, title: clip.title, hashtags: route.hashtags, privacy: route.tiktok.privacy });
        record.tiktok = { id: r.id, privacy: r.privacy };
        log(`tiktok: publish_id ${r.id} (${r.privacy})`);
      } catch (err) { record.tiktok = { error: err.message }; log(`tiktok FAILED: ${err.message}`); }
    }
  }

  /* Record only if something actually landed, so a run where every account was
     unconfigured or failed leaves the clip eligible for a later run. */
  const posted = (record.youtube && record.youtube.id) || (record.tiktok && record.tiktok.id);
  if (posted) await recordPosted(env.MARKETPLACE, clip.slug, record);
  else log('nothing posted — leaving eligible for a later run');

  return { slug: clip.slug, ...record };
}

/* ── run ──────────────────────────────────────────────────────────────── */

export async function runClipper(env, { configPath, dryRun = false, doRender = false, limit } = {}) {
  const config = loadConfig(configPath);
  env.__maxDurationSec = config.defaults.maxDurationSec;
  const maxPerRun = limit || config.defaults.maxPerRun;

  const pool = await findClips(env, {
    lookbackDays: config.defaults.lookbackDays,
    minViews: config.defaults.minViews,
  });
  console.log(`[clipper] pool: ${pool.length} clips over ${config.defaults.lookbackDays}d`);

  const gameNames = await resolveGames(env, pool.map(c => c.gameId));
  const routed = attachRoutes(pool, config, gameNames);

  /* Snapshot the ledger once into a Set so the pure selector decides both the
     dry run (nothing posted yet) and the real run (skip what KV already has). */
  const postedSet = dryRun
    ? new Set()
    : new Set((await listPosted(env.MARKETPLACE)).map(p => p.slug));

  const final = selectForRun(routed, {
    perAccount: config.defaults.perAccount,
    maxPerRun,
    isPosted: (slug) => postedSet.has(slug),
    trending: config.trending,
  });

  const freshCount = final.filter(c => c.fresh).length;
  console.log(`[clipper] selected ${final.length} clip(s) this run` +
    (freshCount ? `, ${freshCount} fresh hit(s)` : '') + (dryRun ? ' (dry run)' : ''));

  /* Each account's picks get that account's slots on the target day, in order.
     YouTube publishes at those times; TikTok has no scheduling and goes now. */
  const slotIndex = new Map();
  for (const clip of final) {
    const i = slotIndex.get(clip.route.label) || 0;
    slotIndex.set(clip.route.label, i + 1);
    clip.publishAt = slotsFor(Date.now(), config.schedule, i + 1)[i];
  }
  if (final.length) {
    console.log(`[clipper] publishing ${config.schedule.daysAhead} day(s) ahead ` +
      `at ${config.schedule.times.join(', ')} ${config.schedule.timezone}`);
  }

  const workDir = process.env.CLIPPER_WORK || path.join(os.tmpdir(), 'clipper');
  const results = [];
  for (const clip of final) {
    try {
      results.push(await processClip(env, clip, { workDir, dryRun, doRender }));
    } catch (err) {
      console.error(`[clipper] ${clip.slug}: ${err.message}`);
      results.push({ slug: clip.slug, error: err.message });
    } finally {
      /* Reclaim the job dir unless we are keeping a dry-run render for review. */
      if (!(dryRun && doRender)) {
        try { fs.rmSync(path.join(workDir, clip.slug), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }
  return results;
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

async function main() {
  /* server/.env (+ an optional --service overlay for the production
     DATABASE_URL) before anything reads process.env. */
  const { bootEnv, serviceArg } = await import('./env-boot.js');
  await bootEnv(serviceArg());

  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : undefined; };

  const dryRun = has('--dry-run');
  const doRender = has('--render');
  const limit = val('--limit') ? Number(val('--limit')) : undefined;
  const configPath = val('--config');

  let env;
  if (dryRun && !process.env.DATABASE_URL) {
    /* A dry run needs Twitch but not Postgres. It still needs SOME store:
       getAppToken caches the Twitch app token through env.MARKETPLACE. */
    const { memoryKv } = await import('./memory-kv.js');
    env = { ...process.env, MARKETPLACE: memoryKv() };
  } else {
    const { createPool, waitForDatabase } = await import('../lib/db.js');
    const { createKVStore } = await import('../lib/kv.js');
    createPool(process.env.DATABASE_URL);
    await waitForDatabase();
    const { getPool } = await import('../lib/db.js');
    env = { ...process.env, MARKETPLACE: createKVStore(getPool()) };
  }

  const results = await runClipper(env, { configPath, dryRun, doRender, limit });
  console.log(`[clipper] done — ${results.length} processed`);
  process.exit(0);
}

/* "Was this file run directly?" — via pathToFileURL, NOT string concatenation.
   `file://${process.argv[1]}` is a Linux-only approximation: on Windows argv[1]
   is a backslash path with a drive letter, and any space in it stays literal
   where import.meta.url percent-encodes it. On the rig
   (C:\Users\...\PhantomACE Website\...) the two never matched, so running
   run.js printed nothing at all and exited 0 — the module loaded, main() was
   skipped, and there was no error to go looking for. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`[clipper] fatal: ${err.stack || err.message}`); process.exit(1); });
}
