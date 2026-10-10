/* ══════════════════════════════════════════════
   LEADERBOARDS API
   Unified leaderboard storage for all games
   ══════════════════════════════════════════════ */

import { createItemCode, activateItemCode } from './item-codes.js';
import { sendWhisper, announceAction } from './bot/send-chat.js';
import { resolveEquippedCosmetics } from './cosmetics.js';

const MAX_ENTRIES = 50;

/* A stored/incoming score must be a finite, non-negative number. Guards this
   shared board against a non-finite or overflowed value (e.g. a Skull Clicker
   run that overflowed to Infinity) rendering as "Infinity" or sorting to the
   top — clamp on write so it can't persist, and on read so an already-stored
   bad value self-heals. */
const SCORE_CAP = 1e300;
function finiteScore(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(SCORE_CAP, n)) : 0; }

/* ── Big-number scores (skull-clicker only) ───────────────────────────────
   Skull Clicker lifetime scores can exceed the JS double ceiling, so on its
   board a score is a STRING ("1.23e500") ranked by scoreLog (= log10). This
   board (sc_leaderboard) is written by BOTH this file and skull-clicker.js, so
   the two MUST agree on this shape. parseScoreLog accepts the new
   {score:string, scoreLog:number} AND legacy numeric scores; cleanScore keeps a
   finite legacy Number as-is and a string as-is. Other games are unaffected. */
function parseScoreLog(score, scoreLog) {
  const sl = Number(scoreLog);
  if (Number.isFinite(sl) && sl > 0) return sl;
  const n = Number(score);
  if (Number.isFinite(n)) return n > 0 ? Math.log10(n) : 0;
  const m = String(score).match(/^(\d+(?:\.\d+)?)[eE]\+?(\d+)$/);
  if (m) return Math.log10(parseFloat(m[1])) + parseFloat(m[2]);
  return 0;
}
function cleanScore(score) {
  if (typeof score === 'string') return score;
  const n = Number(score);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const BOARDS = {
  /* Written only by skull-clicker.js (save push); the browser POST is gone. */
  'skull-clicker':    { key: 'sc_leaderboard',  label: 'High Score',  sort: 'desc', bignum: true, serverOnly: true },
  /* Written by memory-match.js from a server-dealt, server-revealed game
     (recordResult), one board per deck size so a 10-pair pack doesn't compete
     with the full 20-pair deck. The browser used to POST its own move count. */
  'memory-match':     { key: 'lb_memory_match',    label: 'Best Moves', sort: 'asc', serverOnly: true },
  'memory-match-15':  { key: 'lb_memory_match_15', label: 'Best Moves', sort: 'asc', serverOnly: true },
  'memory-match-10':  { key: 'lb_memory_match_10', label: 'Best Moves', sort: 'asc', serverOnly: true },
  /* Written by bingo/end.js from the room's own cards and calls, and only for
     staff-hosted rooms -- the client used to POST its own count. */
  'commander-bingo':  { key: 'lb_bingo',        label: 'Bingos',      sort: 'desc', serverOnly: true },
  /* Both Mana Clash boards are written by the game server from the
     finished room, never by a player's browser — see recordResult() in
     mana-clash.js. serverOnly refuses the POST below, because a board
     that carries a monthly prize and can be incremented with one curl
     is not a leaderboard. */
  'mana-clash':       { key: 'lb_mana_clash',   label: 'High Score',  sort: 'desc', serverOnly: true },
  'mana-clash-wins':  { key: 'lb_mana_clash_wins', label: 'Wins',     sort: 'desc', mode: 'increment', serverOnly: true },
  /* Written by pham-shock.js when resolve() settles a real multi-player
     match (recordWin), never by a browser -- one curl used to add a win. */
  'pham-shock':      { key: 'lb_shell_shock',  label: 'Wins',        sort: 'desc', mode: 'increment', serverOnly: true },
  /* Nothing writes this board (Watch Time is read from pt_ rows by
     community-leaderboard.js); serverOnly so it can't be filled by curl. */
  'phamily-time':     { key: 'lb_phamily_time', label: 'Hours',       sort: 'desc', serverOnly: true },
  /* Written by end.js from the room's own computed scores, same shape as
     Mana Clash's SCORE_BOARD — points come from mtgbbb-scoring, never from
     a client, so a client POST here has nothing legitimate to submit. */
  'mtgbbb':           { key: 'lb_mtgbbb',       label: 'Points',      sort: 'desc', serverOnly: true },
};

/* ── Monthly top-3 prizes ─────────────────────────
   Once a new month has begun (SEASON_TZ), the first
   leaderboard request settles the PREVIOUS month: the
   top 3 on each competitive game's board (phamily-time
   excluded — it's a watch-time pass with its own reward
   system, not a game leaderboard) win a profile badge:
     1st = mythic, 2nd = rare, 3rd = uncommon
   The badge goes straight into the winner's inventory
   (game 'profile', so it can be equipped/showcased) —
   that is the on-site record, and it does not depend on
   a whisper arriving. A backup code, restricted to the
   winner, is also minted and whispered. ── */

const MONTHLY_GAME_LABELS = {
  'memory-match':    'Memory Match',
  'memory-match-15': 'Memory Match (15 pairs)',
  'memory-match-10': 'Memory Match (10 pairs)',
  'commander-bingo': 'Commander Bingo',
  'mana-clash':      'Mana Clash High Score',
  'mana-clash-wins': 'Mana Clash Wins',
  'pham-shock':      'PhamShock',
  'mtgbbb':          'MTGBBB',
};

/* THE BOARDS THAT DELIBERATELY PAY NOTHING, and why.

   The settle loop skips any board with no label. That used to be a silent
   `continue`, so a board added to BOARDS without a label here carried no
   monthly prize and said nothing about it -- wrong for however long it took
   somebody to notice, which is the same shape as an unregistered KV key.

   Omission is a declaration now: every board is in this table or in
   MONTHLY_GAME_LABELS, a board in neither is logged by name on every settle,
   and test-monthly-awards.js fails if one is missing from both. */
const MONTHLY_NO_AWARD = {
  /* sc_leaderboard is the ALL-TIME board and must never be wiped. Skull
     Clicker's monthly race and prize live on the season board (sc_season),
     settled in skull-clicker.js. */
  'skull-clicker': 'all-time board; the monthly race is on sc_season',
  /* Nothing writes lb_phamily_time -- Watch Time is read straight off the pt_
     rows by community-leaderboard.js -- so there is nothing to snapshot, wipe
     or award. The pass has its own monthly cycle. */
  'phamily-time':  'derived view, never written; the pass settles its own month',
};

const MONTHLY_PLACEMENTS = [
  { rarity: 'mythic',   suffix: 'Champion',    medal: '🥇' },
  { rarity: 'rare',     suffix: 'Runner-Up',   medal: '🥈' },
  { rarity: 'uncommon', suffix: 'Third Place', medal: '🥉' },
];

const MONTHLY_CODE_DURATION_SECONDS = 604800; // 7 days

/* Month boundary + labels come from the shared season calendar (SEASON_TZ), so
   leaderboard awards settle on the same month as the giveaway ledger and Phamily
   Time — not on a separate UTC clock. */
import { prevMonthKey, monthLabel } from './season-time.js';

/* "September 2026" for a 'YYYY-MM' key. Mid-month noon UTC is the same
   calendar month in SEASON_TZ, so monthLabel names the key's own month. */
function labelForMonthKey(mk) {
  const [y, m] = String(mk).split('-').map(Number);
  return monthLabel(new Date(Date.UTC(y, m - 1, 15, 12)));
}

/* Months this process already knows are settled, per env, so a month's worth
   of leaderboard polls does not each attempt the claim INSERT. Purely a
   shortcut — claimMonthlyAward stays the source of truth. */
const settledMonths = new WeakMap();

/* The prize itself, written straight into the winner's inventory under the
   inventory's lock. Idempotent on item id, so a later redemption of the backup
   code (handleRedeem dedupes non-consumables by id) cannot double it. */
async function grantAwardBadge(env, userId, item) {
  await env.MARKETPLACE.mutate(`inv_${userId}`, (inv) => {
    const cur = inv || { userId: String(userId), items: [], equips: {} };
    cur.items = Array.isArray(cur.items) ? cur.items : [];
    if (!cur.equips) cur.equips = {};
    if (cur.items.some(i => i && i.id === item.id)) return undefined;
    cur.items.push({
      id: item.id,
      game: item.game,
      type: item.type,
      name: item.name,
      rarity: item.rarity,
      consumable: false,
      quantity: 1,
      grantedAt: Date.now(),
      source: 'monthly-award',
    });
    return cur;
  });
}

/* Read a board and empty it in ONE locked operation. The snapshot is what the
   month is awarded from; anything written after the lock releases lands on the
   fresh board and counts for the new month. A get-then-put here would let a
   score posted between the two be read by nobody and wiped. */
async function snapshotAndWipe(env, key) {
  let snapshot = [];
  await env.MARKETPLACE.mutate(key, (current) => {
    snapshot = Array.isArray(current) ? current : [];
    return snapshot.length ? [] : undefined;
  });
  return snapshot;
}

/**
 * Settle the PREVIOUS SEASON_TZ month's leaderboard prizes, once.
 *
 * Runs on the first leaderboard request on/after the 1st. Because the claim
 * is keyed by the previous month and checked on every request (until this
 * process has seen it settled), a month whose 1st had no traffic is still
 * awarded by whichever request comes next — that is the catch-up.
 *
 * @returns {Promise<null | {month: string, label: string, awards: object[]}>}
 *   null when there was nothing to do (already settled / claimed elsewhere).
 */
export async function maybeRunMonthlyAwards(env, now = new Date()) {
  const key = prevMonthKey(now);
  if (settledMonths.get(env) === key) return null;

  /* One atomic claim: INSERT ... ON CONFLICT DO NOTHING RETURNING hands a row
     to exactly one caller per month, ever, so two simultaneous requests on the
     1st cannot both pay out. */
  const claimed = await env.MARKETPLACE.claimMonthlyAward(key);
  settledMonths.set(env, key);
  if (!claimed) return null;

  const label = labelForMonthKey(key);
  const summaryLines = [];
  const awards = [];

  for (const [game, board] of Object.entries(BOARDS)) {
    const gameLabel = MONTHLY_GAME_LABELS[game];
    if (!gameLabel) {
      /* Declared exempt is fine and quiet. Undeclared is a board nobody gave
         a prize to, which is worth a line in the log every month until
         somebody picks a side. */
      if (!MONTHLY_NO_AWARD[game]) {
        console.error(`[leaderboards] monthly ${key}: board '${game}' has no label in ` +
          'MONTHLY_GAME_LABELS and is not declared in MONTHLY_NO_AWARD, so it was ' +
          'NOT awarded or wiped. Add it to one of them.');
      }
      continue;
    }

    let snapshot;
    try {
      snapshot = await snapshotAndWipe(env, board.key);
    } catch (err) {
      console.error(`[leaderboards] monthly ${key}: could not snapshot ${board.key}; ` +
        `its standings were NOT awarded and roll into next month:`, err && err.message);
      continue;
    }

    const winners = snapshot
      .filter(e => e && e.id && !String(e.id).startsWith('guest_'))
      .slice(0, 3);
    if (winners.length === 0) continue;

    const placementNames = [];

    for (let i = 0; i < winners.length; i++) {
      const winner = winners[i];
      const userId = String(winner.id);
      const placement = MONTHLY_PLACEMENTS[i];
      const item = {
        id: `monthly_${game}_${key}_${i + 1}`,
        game: 'profile',
        type: 'badge',
        name: `${gameLabel} ${placement.suffix} — ${label}`,
        rarity: placement.rarity,
      };
      const award = {
        game, place: i + 1, userId, name: winner.name, score: winner.score,
        itemId: item.id, granted: false, code: null, whispered: false,
      };

      try {
        await grantAwardBadge(env, userId, item);
        award.granted = true;
      } catch (err) {
        console.error(`[leaderboards] monthly ${key}: inventory grant failed for ${game} #${i + 1} ` +
          `(user ${userId}, ${winner.name}):`, err && err.message);
      }

      /* Backup code, locked to this winner — useless to anyone else who sees
         the whisper. If the grant above failed, this is the recovery path. */
      try {
        const record = await createItemCode(env, item, { restrictedTo: [userId] });
        await activateItemCode(env, record.code, MONTHLY_CODE_DURATION_SECONDS);
        award.code = record.code;
      } catch (err) {
        console.error(`[leaderboards] monthly ${key}: code mint failed for ${game} #${i + 1} ` +
          `(user ${userId}, ${winner.name}):`, err && err.message);
      }

      const where = award.granted
        ? `Your ${placement.rarity} badge is already in your inventory — equip it at phantomace.tv/inventory.html`
        : `Your ${placement.rarity} badge is waiting`;
      const backup = award.code
        ? (award.granted
          ? `. Missing? Redeem backup code ${award.code} at phantomace.tv/redeem.html within 7 days.`
          : `: redeem code ${award.code} at phantomace.tv/redeem.html within 7 days.`)
        : '.';
      try {
        award.whispered = !!(await sendWhisper(env, userId,
          `${placement.medal} You placed #${i + 1} in ${gameLabel} for ${label}! ${where}${backup}`));
      } catch (err) {
        console.error(`[leaderboards] monthly ${key}: whisper threw for user ${userId}:`, err && err.message);
      }

      if (!award.granted && !award.code) {
        console.error(`[leaderboards] monthly ${key}: ${game} #${i + 1} (user ${userId}, ${winner.name}, ` +
          `score ${winner.score}) received NOTHING — grant manually: ${JSON.stringify(item)}`);
      } else if (!award.whispered) {
        console.error(`[leaderboards] monthly ${key}: whisper not delivered to ${game} #${i + 1} ` +
          `(user ${userId}, ${winner.name}); badge granted=${award.granted}, backup code=${award.code}`);
      }

      awards.push(award);
      placementNames.push(`${placement.medal} ${winner.name}`);
    }

    summaryLines.push(`${gameLabel}: ${placementNames.join(' ')}`);
  }

  if (summaryLines.length > 0) {
    const announcement = `🏆 ${label} Champions! ${summaryLines.join(' | ')} — your badges are in your inventory. Congrats!`;
    try {
      const res = await announceAction(env, announcement, 'monthly-awards');
      if (res && res.success === false) console.error(`[leaderboards] monthly ${key}: announcement not sent:`, res.error);
    } catch (err) {
      console.error(`[leaderboards] monthly ${key}: announcement threw:`, err && err.message);
    }
  }

  return { month: key, label, awards };
}

async function settleQuietly(env) {
  try { await maybeRunMonthlyAwards(env); }
  catch (err) { console.error('[leaderboards] monthly awards failed:', err && err.message); }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function getPlayer(request, body) {
  const session = getSession(request);
  if (session) return { id: session.user_id, name: session.display_name };
  if (body && body.guestId && body.guestName) return { id: 'guest_' + body.guestId, name: body.guestName.slice(0, 20) };
  return null;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  await settleQuietly(env);

  const url = new URL(request.url);
  const game = url.searchParams.get('game');

  /* Stamp each shown entry with its owner's equipped { nameEffect, banner }
     variant, resolved once per response over the deduped set of shown ids —
     not once per row — so a name effect / banner backdrop can render without
     each row fetching its own inventory. Guests resolve to nulls. */
  const enrich = (entries, cosmetics) =>
    entries.map(e => {
      const c = (e && cosmetics[String(e.id)]) || { nameEffect: null, banner: null };
      /* A string score is a big-number (skull-clicker); keep it verbatim and carry
         its scoreLog. Numeric scores (every other game) still clamp via finiteScore. */
      const score = (e && typeof e.score === 'string') ? e.score : finiteScore(e && e.score);
      const out = { ...e, score, nameEffect: c.nameEffect, banner: c.banner };
      if (e && e.scoreLog !== undefined) out.scoreLog = parseScoreLog(e.score, e.scoreLog);
      return out;
    });

  if (game === 'all') {
    const boards = {};
    const ids = new Set();
    for (const [name, board] of Object.entries(BOARDS)) {
      const data = (await env.MARKETPLACE.get(board.key, 'json') || []).slice(0, 10);
      boards[name] = data;
      for (const e of data) if (e && e.id) ids.add(String(e.id));
    }
    const cosmetics = await resolveEquippedCosmetics(env, [...ids]);
    const result = {};
    for (const [name, data] of Object.entries(boards)) result[name] = enrich(data, cosmetics);
    return json(result);
  }

  if (game && BOARDS[game]) {
    const data = (await env.MARKETPLACE.get(BOARDS[game].key, 'json') || []).slice(0, 10);
    const cosmetics = await resolveEquippedCosmetics(env, data.map(e => e && e.id).filter(Boolean));
    return json(enrich(data, cosmetics));
  }

  return json({ error: 'Specify ?game=all or ?game=<name>' }, 400);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  await settleQuietly(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const game = body.game;
  if (!game || !BOARDS[game]) return json({ error: 'Invalid game' }, 400);

  const player = getPlayer(request, body);
  if (!player) return json({ error: 'Not authenticated' }, 401);

  const board = BOARDS[game];

  if (board.serverOnly) {
    return json({ error: 'That board is written by the game server, not by clients.' }, 403);
  }

  /* Increment-mode boards (e.g. PhamShock wins) count occurrences rather
     than track a best single score — every valid POST means "this
     happened once more," so there's no score to validate or compare. */
  /* Every write below is a mutate(), never get-then-put: a put built from a
     read taken before the monthly snapshot-and-wipe would otherwise write the
     whole old month back onto the fresh board (and two simultaneous posts
     would drop one of them). */
  if (board.mode === 'increment') {
    await env.MARKETPLACE.mutate(board.key, (current) => {
      const lb = Array.isArray(current) ? current : [];
      const existing = lb.find(e => e.id === player.id);
      if (existing) {
        existing.score += 1;
        existing.name = player.name;
        existing.updatedAt = Date.now();
      } else {
        lb.push({ id: player.id, name: player.name, score: 1, updatedAt: Date.now() });
      }
      lb.sort((a, b) => b.score - a.score);
      return lb.slice(0, MAX_ENTRIES);
    });
    return json({ success: true, updated: true });
  }

  /* Big-number board (skull-clicker): score is a string, ranked by scoreLog.
     Shares sc_leaderboard with skull-clicker.js, so the stored shape matches. */
  if (board.bignum) {
    const scoreLog = parseScoreLog(body.score, body.scoreLog);
    if (!(scoreLog > 0)) return json({ error: 'Invalid score' }, 400);
    const scoreVal = cleanScore(body.score);
    let updatedB = false;
    await env.MARKETPLACE.mutate(board.key, (current) => {
      const lbB = Array.isArray(current) ? current : [];
      const ex = lbB.find(e => e.id === player.id);
      if (ex) {
        if (!(scoreLog > parseScoreLog(ex.score, ex.scoreLog))) return undefined;
        ex.score = scoreVal; ex.scoreLog = scoreLog; ex.name = player.name; ex.updatedAt = Date.now();
      } else {
        lbB.push({ id: player.id, name: player.name, score: scoreVal, scoreLog, updatedAt: Date.now() });
      }
      lbB.sort((a, b) => parseScoreLog(b.score, b.scoreLog) - parseScoreLog(a.score, a.scoreLog));
      updatedB = true;
      return lbB.slice(0, MAX_ENTRIES);
    });
    return json({ success: true, updated: updatedB });
  }

  const score = finiteScore(body.score);
  if (score <= 0) return json({ error: 'Invalid score' }, 400);
  const stored = board.sort === 'asc' ? Math.round(score) : Math.floor(score);

  let updated = false;
  await env.MARKETPLACE.mutate(board.key, (current) => {
    const lb = Array.isArray(current) ? current : [];
    const existing = lb.find(e => e.id === player.id);
    if (existing) {
      const isBetter = board.sort === 'asc'
        ? score < existing.score
        : score > existing.score;
      if (!isBetter) return undefined;
      existing.score = stored;
      existing.name = player.name;
      existing.updatedAt = Date.now();
    } else {
      lb.push({ id: player.id, name: player.name, score: stored, updatedAt: Date.now() });
    }
    lb.sort((a, b) => board.sort === 'asc' ? a.score - b.score : b.score - a.score);
    updated = true;
    return lb.slice(0, MAX_ENTRIES);
  });

  return json({ success: true, updated });
}
