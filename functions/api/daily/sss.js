/* ══════════════════════════════════════════════
   /api/daily/sss — Soup, Salad, or Sandwich (a daily)

   The bit: every food is exactly one of three — soup, salad, or sandwich —
   per the r/PaymoneyWubby ruling. Each Pacific day serves the SAME five foods
   to everyone (seeded off the day key, no reroll). The player calls each one;
   the server owns the right answer and reveals it only after a call is locked.
   One call per food per day. Finishing the set marks the daily done on the
   hub; a PERFECT set (all five right) pays one bonus giveaway entry.

   GRADING IS A LOOKUP, NOT A RULE. The categories below are the committed
   answer key (the broadcaster dictated the contested ones — pizza is a
   sandwich, cereal-with-milk is a soup, and so on). Append to BANK to grow it;
   each entry is [name, category]. Keep categories to the three CATS exactly.
   ══════════════════════════════════════════════ */

import { dayKey } from '../season-time.js';
import { markDailyComplete } from './state.js';

export const CATS = ['soup', 'salad', 'sandwich'];
const PER_DAY = 5;

/* The answer key. [food, category]. The contested calls are the broadcaster's;
   the clear ones follow the soup→sandwich→salad tree. */
const BANK = [
  // ── Soups ──
  ['Cereal (with milk)', 'soup'], ['Oatmeal', 'soup'], ['Ramen', 'soup'],
  ['Chili', 'soup'], ['Beef stew', 'soup'], ['Clam chowder', 'soup'],
  ['Pho', 'soup'], ['French onion soup', 'soup'], ['Lobster bisque', 'soup'],
  ['Gazpacho', 'soup'], ['Tomato soup', 'soup'], ['Miso soup', 'soup'],
  ['Minestrone', 'soup'], ['Split pea soup', 'soup'], ['Egg drop soup', 'soup'],
  ['Borscht', 'soup'], ['Matzo ball soup', 'soup'], ['Congee', 'soup'],
  // ── Sandwiches ──
  ['Pizza', 'sandwich'], ['Hot dog', 'sandwich'], ['Burrito', 'sandwich'],
  ['Taco', 'sandwich'], ['Sushi roll', 'sandwich'], ['Potstickers', 'sandwich'],
  ['Soup dumplings', 'sandwich'], ['Calzone', 'sandwich'], ['Corn dog', 'sandwich'],
  ['Fruit pie', 'sandwich'], ['French fries', 'sandwich'], ['Casserole', 'sandwich'],
  ['Enchiladas', 'sandwich'], ['Stuffed pepper', 'sandwich'], ['Hamburger', 'sandwich'],
  ['Grilled cheese', 'sandwich'], ['BLT', 'sandwich'], ['Sub sandwich', 'sandwich'],
  ['Wrap', 'sandwich'], ['Gyro', 'sandwich'], ['Quesadilla', 'sandwich'],
  ['Pop-Tart', 'sandwich'], ['Uncrustable', 'sandwich'], ['Oreo', 'sandwich'],
  ['Ice-cream sandwich', 'sandwich'], ['Club sandwich', 'sandwich'], ['Hot Pocket', 'sandwich'],
  ['Panini', 'sandwich'], ['Bánh mì', 'sandwich'], ['Philly cheesesteak', 'sandwich'],
  ['PB&J', 'sandwich'],
  // ── Salads ──
  ['Dry cereal', 'salad'], ['Ravioli', 'salad'], ['Nachos', 'salad'],
  ['Quiche', 'salad'], ['Lasagna', 'salad'], ['Spaghetti', 'salad'],
  ['Poke bowl', 'salad'], ['Chips & salsa', 'salad'], ['Mac & cheese', 'salad'],
  ['Garden salad', 'salad'], ['Fruit salad', 'salad'], ['Trail mix', 'salad'],
  ['Charcuterie board', 'salad'], ['Pasta salad', 'salad'], ['Potato salad', 'salad'],
  ['Coleslaw', 'salad'], ['Caprese salad', 'salad'], ['Caesar salad', 'salad'],
  ['Greek salad', 'salad'], ['Three-bean salad', 'salad'], ['Waldorf salad', 'salad'],
  ['Tabbouleh', 'salad'],
];

/* xmur3 string hash → 32-bit seed, then mulberry32 for a deterministic PRNG.
   Same day key → same five foods for everyone, no stored roll. */
function seedFrom(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** Today's five foods: a seeded shuffle of the bank, first PER_DAY taken, so
    the set is stable per day and never repeats a food within a day. */
export function todaysFoods(day = dayKey()) {
  const rand = seedFrom('sss:' + day);
  const idx = BANK.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = rand() % (i + 1);
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  return idx.slice(0, PER_DAY).map((bankIndex, pos) => ({
    pos, bankIndex, food: BANK[bankIndex][0], cat: BANK[bankIndex][1],
  }));
}

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

const recKey = (userId) => 'sss_' + String(userId);
const aggKey = (day) => 'sss_agg_' + day;

/** The player's record for today, defaulted and day-scoped (a stale day reads
    as a fresh, unplayed set). */
async function readRec(env, userId, day) {
  let rec = null;
  try { rec = await env.MARKETPLACE.get(recKey(userId), 'json'); } catch { rec = null; }
  if (!rec || typeof rec !== 'object' || rec.day !== day) return { day, answers: {} };
  if (!rec.answers || typeof rec.answers !== 'object') rec.answers = {};
  return rec;
}

/** The crowd's per-food % correct for the day; a food with no calls yet is null. */
async function crowdPct(env, day, bankIndex) {
  let agg = null;
  try { agg = await env.MARKETPLACE.get(aggKey(day), 'json'); } catch { agg = null; }
  const f = agg && agg.byFood && agg.byFood[bankIndex];
  const total = Number(f && f.total) || 0;
  if (!total) return null;
  return Math.round(((Number(f.correct) || 0) / total) * 100);
}

/** Build the view of a single food — the correct category and crowd stat are
    only included once the player has locked their call for it. */
async function foodView(env, day, f, answered) {
  const base = { pos: f.pos, food: f.food };
  if (!answered) return { ...base, answered: false };
  return {
    ...base, answered: true,
    pick: answered.pick, correctCat: f.cat, correct: answered.pick === f.cat,
    pctCorrect: await crowdPct(env, day, f.bankIndex),
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const day = dayKey();
  const foods = todaysFoods(day);
  const session = getSession(request);

  const base = { day, cats: CATS, total: foods.length };

  if (!session || !session.user_id) {
    return json({ ...base, loggedIn: false, foods: foods.map(f => ({ pos: f.pos, food: f.food, answered: false })) });
  }

  const rec = await readRec(env, session.user_id, day);
  const views = [];
  for (const f of foods) views.push(await foodView(env, day, f, rec.answers[f.pos] || null));
  const doneCount = views.filter(v => v.answered).length;
  const correct = views.filter(v => v.answered && v.correct).length;

  return json({
    ...base, loggedIn: true, foods: views,
    doneCount, correct, done: doneCount === foods.length,
    perfect: doneCount === foods.length && correct === foods.length,
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const pos = Number(body && body.pos);
  const pick = String(body && body.pick || '');
  if (!Number.isInteger(pos) || pos < 0 || pos >= PER_DAY) return json({ error: 'Bad food' }, 400);
  if (!CATS.includes(pick)) return json({ error: 'Pick soup, salad, or sandwich' }, 400);

  const day = dayKey();
  const foods = todaysFoods(day);
  const f = foods[pos];

  /* One call per food per day, server-authoritative. */
  const existing = await readRec(env, session.user_id, day);
  if (existing.answers[pos]) {
    const a = existing.answers[pos];
    return json({ error: 'Already called', answered: true, pos, pick: a.pick, correctCat: f.cat, correct: a.pick === f.cat, pctCorrect: await crowdPct(env, day, f.bankIndex) }, 409);
  }

  const correct = pick === f.cat;

  /* Record the call on the day-scoped record (replaced on a new day). */
  const rec = await env.MARKETPLACE.mutate(recKey(session.user_id), (cur) => {
    const r = cur && typeof cur === 'object' && cur.day === day && cur.answers
      ? cur : { day, answers: {} };
    if (!r.answers[pos]) r.answers[pos] = { pick, correct };
    return r;
  });

  /* Per-food crowd tally for the day's % stat. */
  await env.MARKETPLACE.mutate(aggKey(day), (cur) => {
    const agg = cur && typeof cur === 'object' && cur.byFood ? cur : { byFood: {} };
    const slot = agg.byFood[f.bankIndex] || { total: 0, correct: 0 };
    slot.total += 1;
    if (correct) slot.correct += 1;
    agg.byFood[f.bankIndex] = slot;
    return agg;
  });

  const answeredCount = Object.keys(rec.answers).length;
  const correctCount = Object.values(rec.answers).filter(a => a.correct).length;
  const done = answeredCount === foods.length;
  const perfect = done && correctCount === foods.length;

  /* Finishing the set marks the daily done. A perfect set pays one bonus
     giveaway entry — granted once, guarded by the day-scoped record (a replay
     can't re-pay because the set is already fully answered). */
  let entryGranted = false;
  if (done) {
    await markDailyComplete(env, session.user_id, session.display_name, 'sss');
    if (perfect && !existing.paidPerfect) {
      try {
        const { addEntries } = await import('../giveaway-entries.js');
        await addEntries(env, session.user_id, session.display_name || 'Someone', 1, 'daily-sss');
        await env.MARKETPLACE.mutate(recKey(session.user_id), (cur) => {
          const r = cur && cur.day === day ? cur : { day, answers: {} };
          r.paidPerfect = true;
          return r;
        });
        entryGranted = true;
      } catch (err) { console.error('[sss] perfect entry failed:', err && err.message); }
    }
  }

  return json({
    answered: true, pos, pick, correctCat: f.cat, correct,
    pctCorrect: await crowdPct(env, day, f.bankIndex),
    doneCount: answeredCount, correct_total: correctCount, total: foods.length,
    done, perfect, entryGranted,
  });
}

export { BANK as SSS_BANK, PER_DAY };
