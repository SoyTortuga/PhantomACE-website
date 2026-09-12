/* ══════════════════════════════════════════════
   LEADERBOARDS API
   Unified leaderboard storage for all games
   ══════════════════════════════════════════════ */

import { createItemCode, activateItemCode } from './item-codes.js';
import { sendWhisper, announceAction } from './bot/send-chat.js';

const MAX_ENTRIES = 50;

const BOARDS = {
  'skull-clicker':    { key: 'sc_leaderboard',  label: 'High Score',  sort: 'desc' },
  'memory-match':     { key: 'lb_memory_match', label: 'Best Moves',  sort: 'asc' },
  'commander-bingo':  { key: 'lb_bingo',        label: 'Bingos',      sort: 'desc' },
  'mana-clash':       { key: 'lb_mana_clash',   label: 'High Score',  sort: 'desc' },
  'pham-shock':      { key: 'lb_shell_shock',  label: 'Wins',        sort: 'desc', mode: 'increment' },
  'phamily-time':     { key: 'lb_phamily_time', label: 'Hours',       sort: 'desc' },
};

/* ── Monthly top-3 prizes ─────────────────────────
   On the last day of the month, the top 3 on each
   competitive game's board (phamily-time excluded —
   it's a watch-time pass with its own reward system,
   not a game leaderboard) get a code at:
     1st = mythic, 2nd = rare, 3rd = uncommon
   Codes are whispered directly to the winner (not
   queued for a chat drop) with a 7-day redemption
   window, then that game's board resets to empty. ── */

const MONTHLY_GAME_LABELS = {
  'skull-clicker':   'Skull Clicker',
  'memory-match':    'Memory Match',
  'commander-bingo': 'Commander Bingo',
  'mana-clash':      'Mana Clash',
  'pham-shock':      'PhamShock',
};

const MONTHLY_PLACEMENTS = [
  { rarity: 'mythic',   suffix: 'Champion',    medal: '🥇' },
  { rarity: 'rare',     suffix: 'Runner-Up',   medal: '🥈' },
  { rarity: 'uncommon', suffix: 'Third Place', medal: '🥉' },
];

const MONTHLY_CODE_DURATION_SECONDS = 604800; // 7 days

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isLastDayOfMonth(d) {
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return next.getUTCMonth() !== d.getUTCMonth();
}

function monthLabel(d) {
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

async function maybeRunMonthlyAwards(env) {
  const now = new Date();
  if (!isLastDayOfMonth(now)) return;

  const key = monthKey(now);
  const flagKey = `monthly_awards_done_${key}`;
  if (await env.MARKETPLACE.get(flagKey)) return;

  // Claim the flag immediately so concurrent requests can't double-run this.
  await env.MARKETPLACE.put(flagKey, String(Date.now()));

  const label = monthLabel(now);
  const summaryLines = [];

  for (const [game, board] of Object.entries(BOARDS)) {
    const gameLabel = MONTHLY_GAME_LABELS[game];
    if (!gameLabel) continue;

    const lb = await env.MARKETPLACE.get(board.key, 'json') || [];
    const winners = lb.filter(e => !String(e.id).startsWith('guest_')).slice(0, 3);
    if (winners.length === 0) continue;

    const placementNames = [];

    for (let i = 0; i < winners.length; i++) {
      const winner = winners[i];
      const placement = MONTHLY_PLACEMENTS[i];

      try {
        const record = await createItemCode(env, {
          id: `monthly_${game}_${key}_${i + 1}`,
          game,
          type: 'badge',
          name: `${gameLabel} ${placement.suffix} — ${label}`,
          rarity: placement.rarity,
        });
        await activateItemCode(env, record.code, MONTHLY_CODE_DURATION_SECONDS);

        const msg = `${placement.medal} You placed #${i + 1} in ${gameLabel} for ${label}! ` +
          `Your ${placement.rarity} code: ${record.code} — redeem it at phantomace.tv/redeem.html ` +
          `within the next 7 days.`;
        await sendWhisper(env, winner.id, msg);
      } catch {
        // Skip this placement rather than aborting the whole run.
      }

      placementNames.push(`${placement.medal} ${winner.name}`);
    }

    summaryLines.push(`${gameLabel}: ${placementNames.join(' ')}`);
    await env.MARKETPLACE.put(board.key, JSON.stringify([]));
  }

  if (summaryLines.length > 0) {
    const announcement = `🏆 ${label} Champions! ${summaryLines.join(' | ')} — codes have been whispered to you. Congrats!`;
    await announceAction(env, announcement, 'monthly-awards');
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
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
  await maybeRunMonthlyAwards(env);

  const url = new URL(request.url);
  const game = url.searchParams.get('game');

  if (game === 'all') {
    const result = {};
    for (const [name, board] of Object.entries(BOARDS)) {
      const data = await env.MARKETPLACE.get(board.key, 'json') || [];
      result[name] = data.slice(0, 10);
    }
    return json(result);
  }

  if (game && BOARDS[game]) {
    const data = await env.MARKETPLACE.get(BOARDS[game].key, 'json') || [];
    return json(data.slice(0, 10));
  }

  return json({ error: 'Specify ?game=all or ?game=<name>' }, 400);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  await maybeRunMonthlyAwards(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const game = body.game;
  if (!game || !BOARDS[game]) return json({ error: 'Invalid game' }, 400);

  const player = getPlayer(request, body);
  if (!player) return json({ error: 'Not authenticated' }, 401);

  const board = BOARDS[game];

  /* Increment-mode boards (e.g. PhamShock wins) count occurrences rather
     than track a best single score — every valid POST means "this
     happened once more," so there's no score to validate or compare. */
  if (board.mode === 'increment') {
    const lb = await env.MARKETPLACE.get(board.key, 'json') || [];
    const existing = lb.find(e => e.id === player.id);
    if (existing) {
      existing.score += 1;
      existing.name = player.name;
      existing.updatedAt = Date.now();
    } else {
      lb.push({ id: player.id, name: player.name, score: 1, updatedAt: Date.now() });
    }
    lb.sort((a, b) => b.score - a.score);
    await env.MARKETPLACE.put(board.key, JSON.stringify(lb.slice(0, MAX_ENTRIES)));
    return json({ success: true, updated: true });
  }

  const score = typeof body.score === 'number' ? body.score : 0;
  if (score <= 0) return json({ error: 'Invalid score' }, 400);

  const lb = await env.MARKETPLACE.get(board.key, 'json') || [];

  const existing = lb.find(e => e.id === player.id);
  if (existing) {
    const isBetter = board.sort === 'asc'
      ? score < existing.score
      : score > existing.score;
    if (isBetter) {
      existing.score = board.sort === 'asc' ? Math.round(score) : Math.floor(score);
      existing.name = player.name;
      existing.updatedAt = Date.now();
    } else {
      return json({ success: true, updated: false });
    }
  } else {
    lb.push({
      id: player.id,
      name: player.name,
      score: board.sort === 'asc' ? Math.round(score) : Math.floor(score),
      updatedAt: Date.now(),
    });
  }

  lb.sort((a, b) => board.sort === 'asc' ? a.score - b.score : b.score - a.score);
  const trimmed = lb.slice(0, MAX_ENTRIES);
  await env.MARKETPLACE.put(board.key, JSON.stringify(trimmed));

  return json({ success: true, updated: true });
}
