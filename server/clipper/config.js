/* ══════════════════════════════════════════════
   THE CLIPPER'S ROUTING TABLE — which game goes to which account.

   A clip carries the game it was taken under (Helix `game_id`, the Twitch
   category AT CLIP TIME — not whatever is live now). This file turns that
   into a ROUTE: which YouTube channel it uploads to, which TikTok account,
   and the hashtags / frame label that dress it.

   WHY CONFIG AND NOT CODE. The broadcaster adds a game or swaps an account
   far more often than the pipeline changes, and the mapping is data, not
   logic. The config file lives on the rig (pointed at by CLIPPER_CONFIG, or
   server/clipper/config.json beside this file) and is NOT committed — see
   config.example.json for the shape.

   WHY SECRETS ARE NOT IN IT. A route names a `credsEnv` (e.g. "YT_TFT"); the
   actual tokens are read from the service environment as
   YT_TFT_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN. So the committable
   example and the on-rig config stay free of refresh tokens, and one account
   can serve several games just by sharing a credsEnv.

   MATCHING. gameIds win over gameNames — an id is stable where a name is
   localised and gets re-titled. The first route that matches wins; a clip
   that matches nothing falls to `fallback` (and if there is no fallback, it
   is skipped rather than guessed onto some default channel).

   EXCLUDE comes FIRST, before any route or the fallback. It is how a channel
   says "these categories never leave Twitch" — IRL and Just Chatting being
   the usual ones. Without it a catch-all fallback would sweep them up, and
   the alternative (naming every OTHER game explicitly, with no fallback)
   silently drops any new game the channel starts streaming.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  /* How the selector behaves when the config does not say. */
  lookbackDays: 365,      // how far back the clip pool reaches (12 months)
  perAccount: 2,          // Shorts/TikToks to post PER destination account per run
  minViews: 10,           // ignore clips below this many views
  maxDurationSec: 60,     // Shorts cap; longer clips are trimmed
  maxPerRun: 20,          // hard ceiling across all accounts, so a huge backlog
                          // cannot fire off dozens of uploads in one run
};

/**
 * Load and validate the routing config.
 * @param {string} [explicitPath] overrides CLIPPER_CONFIG / the default path
 * @returns {{defaults:object, routes:object[], fallback:(object|null)}}
 */
export function loadConfig(explicitPath) {
  const file = explicitPath
    || process.env.CLIPPER_CONFIG
    || path.join(HERE, 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `Clipper config not found at ${file}. Copy server/clipper/config.example.json ` +
      `to config.json (or set CLIPPER_CONFIG) and fill in your games and accounts.`);
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`Clipper config at ${file} is not valid JSON: ${err.message}`); }

  return normalizeConfig(parsed);
}

/**
 * Validate a parsed config object. Separated from file IO so it is testable
 * and so run.js can pass an already-loaded object.
 */
export function normalizeConfig(parsed) {
  if (!parsed || typeof parsed !== 'object') throw new Error('Clipper config must be an object');

  const defaults = { ...DEFAULTS, ...(parsed.defaults || {}) };
  if (!(defaults.lookbackDays > 0)) {
    throw new Error(`Clipper config: defaults.lookbackDays must be a positive number`);
  }
  if (!(defaults.perAccount > 0)) {
    throw new Error(`Clipper config: defaults.perAccount must be a positive number`);
  }

  const routes = Array.isArray(parsed.routes) ? parsed.routes.map(validateRoute) : [];
  const fallback = parsed.fallback ? validateRoute({ ...parsed.fallback, match: parsed.fallback.match || {} }) : null;
  const exclude = normalizeMatch(parsed.exclude);

  return { defaults, routes, fallback, exclude };
}

/** A {gameIds, gameNames} matcher, normalized. Names are lowercased. */
function normalizeMatch(match) {
  const m = match || {};
  return {
    gameIds: (m.gameIds || []).map(String),
    gameNames: (m.gameNames || []).map(s => String(s).toLowerCase()),
  };
}

function validateRoute(route, i) {
  if (!route || typeof route !== 'object') throw new Error(`Clipper route #${i} is not an object`);
  const label = String(route.label || '').trim();
  if (!label) throw new Error(`Clipper route #${i} is missing a "label"`);

  const { gameIds, gameNames } = normalizeMatch(route.match);

  /* At least one destination, or the route is a no-op that silently drops a
     game. A route may post to only YouTube or only TikTok. */
  if (!route.youtube && !route.tiktok) {
    throw new Error(`Clipper route "${label}" has neither a youtube nor a tiktok destination`);
  }

  return {
    label,
    match: { gameIds, gameNames },
    hashtags: Array.isArray(route.hashtags) ? route.hashtags.map(String) : [],
    youtube: route.youtube ? { credsEnv: String(route.youtube.credsEnv), privacy: route.youtube.privacy || 'public' } : null,
    tiktok: route.tiktok ? { credsEnv: String(route.tiktok.credsEnv), privacy: route.tiktok.privacy || 'SELF_ONLY' } : null,
  };
}

/**
 * Resolve the route for a clip. Pure — takes the already-known game name so it
 * needs no network. `fallback` is used when nothing matches; null if there is
 * none, and the caller then skips the clip.
 *
 * @param {{routes:object[], fallback:(object|null), exclude:(object|undefined)}} config
 * @param {{gameId:(string|undefined), gameName:(string|undefined)}} clip
 * @returns {(object|null)}
 */
export function resolveRoute(config, { gameId, gameName } = {}) {
  const id = gameId != null ? String(gameId) : '';
  const name = gameName ? String(gameName).toLowerCase() : '';

  /* Excluded categories never leave Twitch — checked before the routes AND
     before the fallback, which is the whole point of the list. */
  const ex = config.exclude;
  if (ex && ((id && ex.gameIds.includes(id)) || (name && ex.gameNames.includes(name)))) {
    return null;
  }

  for (const route of config.routes) {
    if (id && route.match.gameIds.includes(id)) return route;
    if (name && route.match.gameNames.includes(name)) return route;
  }
  return config.fallback || null;
}
