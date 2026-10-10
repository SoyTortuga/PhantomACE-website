/* ══════════════════════════════════════════════
   PHAMILY QUESTS — weekly, server-checked challenges

   A small rotating manifest of weekly quests that pay giveaway entries or
   Phamily Time minutes. Everything that decides whether a quest is done is
   read on the SERVER from signals the rest of the site already writes:

     checkin-days   ci_<userId>.streams, filtered to this ISO week (Pacific)
     watch-days     pt_<userId>_<month>.attendance days that fall in this week
     watch-hours    the same attendance, summed
     memory-best    the lb_memory_match board row, if set this week
     room-visits    roomvisits_<userId>_<weekKey> — OPTIONAL, C3's to write.
                    Read defensively (try/catch → 0) so this route never
                    depends on C3 having shipped or registered its prefix.

   Nothing here trusts the client for progress. A claim recomputes progress
   from the signals and only then pays, exactly once, guarded by a durable
   per-quest `claimed` flag on quest_<userId>_<weekKey> — the same shape as
   giveaway-entries.js's amoeClaimed and checkin-rewards.js's paidStreak.

   Payment lands AFTER the claimed flag commits, the checkin-rewards pattern:
   the flag is the exactly-once guarantee, so a second claim (double click,
   second tab) finds it set and pays nothing even though the payout touches a
   different key.

   A completed claim writes a notice onto the row; the Phamily Time page reads
   it on GET and raises it in the notification bell (js/notifications.js),
   then acks it so it is announced once.

   This file exports onRequestGet/onRequestPost, so it is a ROUTE (/api/quests)
   — it does NOT belong in server/router.js NON_ROUTE_MODULES.
   ══════════════════════════════════════════════ */

import { weekKey, monthKey, prevMonthOf } from './season-time.js';

/* Watch minutes credited by a quest raise the current month's pass row, which
   never expires; a quest row is only interesting for its own week, so it may. */
const QUEST_TTL = 45 * 86400;
const PT_TTL = 5184000;
const MAX_LEVEL = 150;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function questKey(userId, wk) { return `quest_${userId}_${wk}`; }

/* ── The manifest ──────────────────────────────────────────────────────────
   A pool of quests, each verifiable from an existing signal. A week shows a
   rotating window of WEEKLY_COUNT of them, chosen deterministically from the
   week key so the set is stable for everyone all week and shifts on the roll.

   Every quest counts UP toward an integer goal; completed when progress >=
   goal. The memory-match achievement ("≤ N moves") is modelled the same way:
   progress is 1 when the board shows a qualifying run this week, else 0. */
export const CATALOG = [
  { id: 'answer-call', signal: 'checkin-days', goal: 3, reward: { type: 'entries', amount: 5 },
    title: 'Answer the Call', desc: 'Check in on 3 stream days this week.' },
  { id: 'keep-vigil', signal: 'watch-hours', goal: 6, reward: { type: 'minutes', amount: 60 },
    title: 'Keep the Vigil', desc: 'Watch 6 hours this week for an hour of pass time.' },
  { id: 'faithful', signal: 'watch-days', goal: 4, reward: { type: 'entries', amount: 4 },
    title: 'Faithful Attendance', desc: 'Watch on 4 different days this week.' },
  { id: 'steel-trap', signal: 'memory-best', goal: 1, meta: { moves: 24 }, reward: { type: 'entries', amount: 6 },
    title: 'Steel Trap', desc: 'Clear a 20-pair Memory Match in 24 moves or fewer this week.' },
  { id: 'unbroken', signal: 'checkin-days', goal: 5, reward: { type: 'entries', amount: 10 },
    title: 'Unbroken', desc: 'Check in on 5 stream days this week.' },
  /* C3 (Room Crawl) writes roomvisits_<userId>_<weekKey>; until then this
     reads 0 and simply cannot be completed. Harmless, and ready to light up. */
  { id: 'wandering-soul', signal: 'room-visits', goal: 3, reward: { type: 'entries', amount: 4 },
    title: 'Wandering Soul', desc: 'Visit 3 Phamily rooms this week.' },
];

const WEEKLY_COUNT = 4;

function weekSeed(wk) {
  const s = String(wk);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** This week's quests — a stable, deterministic window of the pool. */
export function questsForWeek(wk) {
  const start = weekSeed(wk) % CATALOG.length;
  const out = [];
  for (let i = 0; i < WEEKLY_COUNT; i++) out.push(CATALOG[(start + i) % CATALOG.length]);
  return out;
}

/* ── Signals ───────────────────────────────────────────────────────────── */

function pacificDay(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/* Watch time lives in the pass row keyed by day-of-month. A Pacific ISO week
   can straddle a month boundary, so both the current and previous month rows
   are scanned and each attended day is placed in a week by its own date (built
   at noon UTC so the Pacific calendar day is unambiguous). */
async function watchDaysAndHours(env, userId, wk) {
  const months = [monthKey(), prevMonthOf(monthKey())];
  const days = new Set();
  let hours = 0;
  for (const mk of months) {
    const row = await env.MARKETPLACE.get(`pt_${userId}_${mk}`, 'json');
    if (!row || !row.attendance) continue;
    const [y, m] = String(mk).split('-').map(Number);
    for (const [dStr, h] of Object.entries(row.attendance)) {
      const hrs = Number(h) || 0;
      if (hrs <= 0) continue;
      const date = new Date(Date.UTC(y, m - 1, Number(dStr), 12));
      if (weekKey(date) !== wk) continue;
      days.add(`${mk}-${dStr}`);
      hours += hrs;
    }
  }
  return { days: days.size, hours };
}

async function checkinDays(env, userId, wk) {
  const row = await env.MARKETPLACE.get(`ci_${userId}`, 'json');
  const streams = row && Array.isArray(row.streams) ? row.streams : [];
  const days = new Set();
  for (const s of streams) {
    const at = Number(s.at) || (s.startedAt ? Date.parse(s.startedAt) : NaN);
    if (!Number.isFinite(at)) continue;
    const date = new Date(at);
    if (weekKey(date) !== wk) continue;
    days.add(pacificDay(date));
  }
  return days.size;
}

/**
 * Did this player clear a board in `maxMoves` or fewer THIS week?
 *
 * Reads `weekBest`, which memory-match stamps on every recorded run.
 * It used to read `updatedAt` and `score` — the all-time record — but
 * `updatedAt` only moves when a run IMPROVES that record, so anyone
 * already at or under the target could never satisfy it however many
 * qualifying games they played. The quest was impossible for exactly the
 * players good enough for it.
 *
 * Rows written before `weekBest` existed simply have none, which reads
 * as "nothing yet this week" — correct, and it fills in on their next
 * game.
 */
async function memoryBestThisWeek(env, userId, wk, maxMoves) {
  const board = await env.MARKETPLACE.get('lb_memory_match', 'json');
  const lb = Array.isArray(board) ? board : [];
  const row = lb.find(e => e && String(e.id) === String(userId));
  if (!row || !row.weekBest || row.weekBest.wk !== wk) return 0;
  return Number(row.weekBest.moves) <= maxMoves ? 1 : 0;
}

async function roomVisits(env, userId, wk) {
  try {
    const rec = await env.MARKETPLACE.get(`roomvisits_${userId}_${wk}`, 'json');
    return rec && Number(rec.count) ? Math.floor(Number(rec.count)) : 0;
  } catch {
    /* The prefix is not registered until C3 ships; a read then throws rather
       than returning null, and a quest must never 500 the whole route. */
    return 0;
  }
}

async function computeProgress(env, userId, wk, quest) {
  switch (quest.signal) {
    case 'checkin-days': return await checkinDays(env, userId, wk);
    case 'watch-days':   return (await watchDaysAndHours(env, userId, wk)).days;
    case 'watch-hours':  return Math.floor((await watchDaysAndHours(env, userId, wk)).hours);
    case 'memory-best':  return await memoryBestThisWeek(env, userId, wk, (quest.meta && quest.meta.moves) || 24);
    case 'room-visits':  return await roomVisits(env, userId, wk);
    default:             return 0;
  }
}

/* ── The quest row ─────────────────────────────────────────────────────── */

function blankRow(userId, wk) {
  return { userId: String(userId), weekKey: wk, quests: {}, notices: [] };
}

function asRow(cur, userId, wk) {
  const r = cur && typeof cur === 'object' && cur.weekKey === wk ? cur : blankRow(userId, wk);
  if (!r.quests || typeof r.quests !== 'object') r.quests = {};
  if (!Array.isArray(r.notices)) r.notices = [];
  return r;
}

/* ── Payouts ───────────────────────────────────────────────────────────── */

/** Add watch-time credit to the current month's pass row — the "minutes"
    reward. Raises hours and the level derived from them; attendance is left
    alone, since these minutes were granted, not watched on a given day. */
async function addPhamilyMinutes(env, userId, username, minutes) {
  const mk = monthKey();
  const hoursAdd = Math.max(0, Number(minutes) || 0) / 60;
  let level = 0, hours = 0;
  await env.MARKETPLACE.mutate(`pt_${userId}_${mk}`, (cur) => {
    const d = cur && typeof cur === 'object'
      ? cur
      : { userId: String(userId), month: mk, hours: 0, level: 0, claimedRewards: [], claimedMilestones: [], attendance: {}, lastHeartbeat: 0 };
    d.hours = Math.min((Number(d.hours) || 0) + hoursAdd, MAX_LEVEL);
    d.level = Math.min(Math.floor(d.hours), MAX_LEVEL);
    const name = typeof username === 'string' ? username.trim().slice(0, 50) : '';
    if (name) d.displayName = name;
    hours = d.hours;
    level = d.level;
    return d;
  }, { expirationTtl: PT_TTL });
  return { hours: Math.round(hours * 10) / 10, level };
}

async function payReward(env, session, quest) {
  const reward = quest.reward;
  if (reward.type === 'entries') {
    const { addEntries } = await import('./giveaway-entries.js');
    const total = await addEntries(env, session.user_id, session.display_name, reward.amount, `quest:${quest.id}`);
    return { entriesTotal: total };
  }
  if (reward.type === 'minutes') {
    const res = await addPhamilyMinutes(env, session.user_id, session.display_name, reward.amount);
    return { minutes: reward.amount, hours: res.hours, level: res.level };
  }
  return {};
}

/* ── GET — this week's quests and the viewer's standing ────────────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  const wk = weekKey();
  const quests = questsForWeek(wk);

  if (!session || !session.user_id) {
    return json({
      weekKey: wk,
      loggedIn: false,
      quests: quests.map(q => ({
        id: q.id, title: q.title, desc: q.desc, goal: q.goal, reward: q.reward,
        progress: 0, completed: false, claimed: false,
      })),
      notices: [],
    });
  }

  const row = asRow(await env.MARKETPLACE.get(questKey(session.user_id, wk), 'json'), session.user_id, wk);
  const out = [];
  for (const q of quests) {
    const progress = await computeProgress(env, session.user_id, wk, q);
    const claimed = !!(row.quests[q.id] && row.quests[q.id].claimed);
    out.push({
      id: q.id, title: q.title, desc: q.desc, goal: q.goal, reward: q.reward,
      progress: Math.min(progress, q.goal),
      completed: progress >= q.goal,
      claimed,
    });
  }

  return json({ weekKey: wk, loggedIn: true, quests: out, notices: row.notices || [] });
}

/* ── POST — claim a completed quest, or ack announced notices ───────────── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in to track quests.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400);

  const wk = weekKey();
  if (body.action === 'ack-notices') return await handleAck(env, session, wk);
  if (body.action === 'claim') return await handleClaim(env, session, wk, body);
  return json({ error: 'Invalid action' }, 400);
}

async function handleClaim(env, session, wk, body) {
  const questId = String(body.questId || '');
  const quest = questsForWeek(wk).find(q => q.id === questId);
  if (!quest) return json({ error: 'No such quest this week' }, 400);

  /* Progress is read fresh and server-side; the client's word is never taken.
     Read before the lock so no network/KV scan is held across it. */
  const progress = await computeProgress(env, session.user_id, wk, quest);

  let granted = false;
  let refusal = null;
  await env.MARKETPLACE.mutate(questKey(session.user_id, wk), (cur) => {
    const row = asRow(cur, session.user_id, wk);
    const q = row.quests[questId] || (row.quests[questId] = { claimed: false });
    if (q.claimed) { refusal = 'Already claimed'; return undefined; }
    if (progress < quest.goal) { refusal = 'Quest not complete yet'; return undefined; }
    q.claimed = true;
    q.claimedAt = Date.now();
    q.reward = quest.reward;
    /* The notice the bell will announce — written in the same locked step that
       records the claim, so it exists only if the claim did. */
    row.notices.push({ questId, title: quest.title, reward: quest.reward, at: Date.now() });
    if (row.notices.length > 20) row.notices = row.notices.slice(-20);
    granted = true;
    return row;
  }, { expirationTtl: QUEST_TTL });

  if (refusal) return json({ error: refusal }, 400);
  if (!granted) return json({ error: 'Could not claim' }, 400);

  const paid = await payReward(env, session, quest);
  return json({ success: true, questId, reward: quest.reward, ...paid });
}

async function handleAck(env, session, wk) {
  await env.MARKETPLACE.mutate(questKey(session.user_id, wk), (cur) => {
    const row = asRow(cur, session.user_id, wk);
    if (!row.notices.length) return undefined;
    row.notices = [];
    return row;
  }, { expirationTtl: QUEST_TTL });
  return json({ ok: true });
}
