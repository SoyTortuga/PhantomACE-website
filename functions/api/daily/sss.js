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
   everything added since follows the SAME established rulings — liquid in a
   bowl is a soup, a filling held by a bread/starch exterior is a sandwich, a
   named "___ salad" or a bowl of mixed/chopped things is a salad. Only foods
   that are unambiguous under those rulings are added without a fresh call;
   genuinely contested ones still get dictated before they go in. Append freely
   — the daily rotation spreads whatever is here evenly (see todaysFoods). */
const BANK = [
  // ── Soups (liquid / bowl-and-spoon) ──
  ['Cereal (with milk)', 'soup'], ['Oatmeal', 'soup'], ['Ramen', 'soup'],
  ['Chili', 'soup'], ['Beef stew', 'soup'], ['Clam chowder', 'soup'],
  ['Pho', 'soup'], ['French onion soup', 'soup'], ['Lobster bisque', 'soup'],
  ['Gazpacho', 'soup'], ['Tomato soup', 'soup'], ['Miso soup', 'soup'],
  ['Minestrone', 'soup'], ['Split pea soup', 'soup'], ['Egg drop soup', 'soup'],
  ['Borscht', 'soup'], ['Matzo ball soup', 'soup'], ['Congee', 'soup'],
  ['Chicken noodle soup', 'soup'], ['Vegetable soup', 'soup'], ['Butternut squash soup', 'soup'],
  ['Potato leek soup', 'soup'], ['Wonton soup', 'soup'], ['Hot and sour soup', 'soup'],
  ['Cream of mushroom soup', 'soup'], ['Lentil soup', 'soup'], ['Black bean soup', 'soup'],
  ['Beef barley soup', 'soup'], ['Tortilla soup', 'soup'], ['Tom yum', 'soup'],
  ['Laksa', 'soup'], ['Pozole', 'soup'], ['Menudo', 'soup'], ['Mulligatawny', 'soup'],
  ['Bouillabaisse', 'soup'], ['Cioppino', 'soup'], ['Gumbo', 'soup'], ['Hot pot', 'soup'],
  ['Udon soup', 'soup'], ['Avgolemono', 'soup'],
  ['Italian wedding soup', 'soup'], ['Cream of chicken soup', 'soup'], ['Chicken and rice soup', 'soup'],
  ['Cheddar broccoli soup', 'soup'], ['Manhattan clam chowder', 'soup'], ['Corn chowder', 'soup'],
  ['Potato soup', 'soup'], ['Pumpkin soup', 'soup'], ['Carrot ginger soup', 'soup'],
  ['Cabbage soup', 'soup'], ['Ham and bean soup', 'soup'], ['Turkey soup', 'soup'],
  ['Oxtail soup', 'soup'], ['Consommé', 'soup'], ['Sinigang', 'soup'],
  ['Tom kha gai', 'soup'], ['Kimchi jjigae', 'soup'], ['Oyster stew', 'soup'],
  ['Jambalaya', 'soup'], ['Smoothie bowl', 'soup'], ['Yogurt parfait', 'soup'], ['Açaí bowl', 'soup'],
  ["White chicken chili", 'soup'], ["Coffee", 'soup'], ["Iced coffee", 'soup'],
  ["Espresso", 'soup'], ["Black tea", 'soup'], ["Green tea", 'soup'],
  ["Matcha latte", 'soup'], ["Milkshake", 'soup'], ["Smoothie", 'soup'],
  ["Protein shake", 'soup'], ["Melting ice cream", 'soup'], ["Melting gelato", 'soup'],
  ["Kefir", 'soup'], ["Bone broth", 'soup'], ["Shark fin soup", 'soup'],
  ["Bird's nest soup", 'soup'], ["Soto ayam", 'soup'], ["Caldo de res", 'soup'],
  ["Soba noodle soup", 'soup'], ["Chilled cucumber soup", 'soup'], ["Beer cheese soup", 'soup'],
  ["Chorba", 'soup'], ["Harira", 'soup'], ["Pappa al pomodoro", 'soup'],
  ["Water", 'soup'], ["Orange juice", 'soup'], ["Maple syrup", 'soup'],
  ["Honey", 'soup'], ["Marinara sauce", 'soup'], ["Alfredo sauce", 'soup'],
  ["Queso dip", 'soup'], ["Hummus", 'soup'], ["Baba ganoush", 'soup'],
  ["Applesauce", 'soup'], ["Melted bone marrow", 'soup'], ["Asam pedas", 'soup'],
  ["Sundubu jjigae", 'soup'], ["Doenjang jjigae", 'soup'], ["Oden", 'soup'],
  ["Sukiyaki", 'soup'], ["Shabu-shabu", 'soup'], ["Turtle soup", 'soup'],
  ["Vegetable broth", 'soup'], ["Fish broth", 'soup'], ["Cullen skink", 'soup'],
  ["Watercress soup", 'soup'], ["Vichyssoise", 'soup'], ["Okroshka", 'soup'],
  ["Svekolnik", 'soup'], ["Runny guacamole", 'soup'],
  // ── Sandwiches (a filling held by a bread/starch exterior; also the
  //    broadcaster's wider rulings — a baked/folded single dish counts too:
  //    lasagna, quiche, pot pie, omelette, even fries-adjacent fried bites) ──
  ['Pizza', 'sandwich'], ['Hot dog', 'sandwich'], ['Burrito', 'sandwich'],
  ['Taco', 'sandwich'], ['Sushi roll', 'sandwich'], ['Potstickers', 'sandwich'],
  ['Soup dumplings', 'sandwich'], ['Calzone', 'sandwich'], ['Corn dog', 'sandwich'],
  ['Fruit pie', 'sandwich'], ['Casserole', 'sandwich'],
  ['Enchiladas', 'sandwich'], ['Stuffed pepper', 'sandwich'], ['Hamburger', 'sandwich'],
  ['Grilled cheese', 'sandwich'], ['BLT', 'sandwich'], ['Sub sandwich', 'sandwich'],
  ['Wrap', 'sandwich'], ['Gyro', 'sandwich'], ['Quesadilla', 'sandwich'],
  ['Pop-Tart', 'sandwich'], ['Uncrustable', 'sandwich'], ['Oreo', 'sandwich'],
  ['Ice-cream sandwich', 'sandwich'], ['Club sandwich', 'sandwich'], ['Hot Pocket', 'sandwich'],
  ['Panini', 'sandwich'], ['Bánh mì', 'sandwich'], ['Philly cheesesteak', 'sandwich'],
  ['PB&J', 'sandwich'], ['Cheeseburger', 'sandwich'], ['Slider', 'sandwich'],
  ['Reuben', 'sandwich'], ['Patty melt', 'sandwich'], ['French dip', 'sandwich'],
  ['Meatball sub', 'sandwich'], ['Italian sub', 'sandwich'], ['Chicken parm sub', 'sandwich'],
  ['Lobster roll', 'sandwich'], ["Po'boy", 'sandwich'], ['Muffuletta', 'sandwich'],
  ['Croque monsieur', 'sandwich'], ['Croque madame', 'sandwich'], ['Breakfast sandwich', 'sandwich'],
  ['Egg sandwich', 'sandwich'], ['Tuna melt', 'sandwich'], ['Sloppy joe', 'sandwich'],
  ['Fried chicken sandwich', 'sandwich'], ['Filet-o-Fish', 'sandwich'], ['Pulled pork sandwich', 'sandwich'],
  ['Shawarma', 'sandwich'], ['Döner kebab', 'sandwich'], ['Falafel pita', 'sandwich'],
  ['Cuban sandwich', 'sandwich'], ['Monte Cristo', 'sandwich'], ["S'more", 'sandwich'],
  ['Moon pie', 'sandwich'],
  ['Bacon sandwich', 'sandwich'], ['Ham sandwich', 'sandwich'], ['Turkey sandwich', 'sandwich'],
  ['Roast beef sandwich', 'sandwich'], ['Pimento cheese sandwich', 'sandwich'], ['Fluffernutter', 'sandwich'],
  ['Bagel sandwich', 'sandwich'], ['Breakfast burrito', 'sandwich'], ['Chimichanga', 'sandwich'],
  ['Taquito', 'sandwich'], ['Bratwurst', 'sandwich'], ['Sausage roll', 'sandwich'],
  ['Pigs in a blanket', 'sandwich'], ['Torta', 'sandwich'], ['Crunchwrap', 'sandwich'],
  ['Chalupa', 'sandwich'], ['Schnitzel sandwich', 'sandwich'], ['Pretzel dog', 'sandwich'],
  ['Lasagna', 'sandwich'], ['Quiche', 'sandwich'], ['Empanada', 'sandwich'],
  ['Samosa', 'sandwich'], ['Spring roll', 'sandwich'], ['Egg roll', 'sandwich'],
  ['Pierogi', 'sandwich'], ['Pupusa', 'sandwich'], ['Arepa', 'sandwich'],
  ['Crepe', 'sandwich'], ['Omelette', 'sandwich'], ['Frittata', 'sandwich'],
  ['Avocado toast', 'sandwich'], ['Bruschetta', 'sandwich'], ['Garlic bread', 'sandwich'],
  ['Pancakes', 'sandwich'], ['Waffles', 'sandwich'], ['French toast', 'sandwich'],
  ['Onion rings', 'sandwich'], ['Mozzarella sticks', 'sandwich'],
  ['Chicken pot pie', 'sandwich'], ["Shepherd's pie", 'sandwich'], ['Onigiri', 'sandwich'],
  ['Spam musubi', 'sandwich'],
  ["Tamale", 'sandwich'], ["Stromboli", 'sandwich'], ["Croissant sandwich", 'sandwich'],
  ["Beef Wellington", 'sandwich'], ["Jamaican beef patty", 'sandwich'], ["Gordita", 'sandwich'],
  ["Pita pocket", 'sandwich'], ["Macaron", 'sandwich'], ["Chipwich", 'sandwich'],
  ["Tortellini", 'sandwich'], ["Gyoza", 'sandwich'], ["Bao bun", 'sandwich'],
  ["Chicken nugget", 'sandwich'], ["Jalapeño popper", 'sandwich'], ["Scotch egg", 'sandwich'],
  ["Fish and chips", 'sandwich'], ["Chicken-fried steak", 'sandwich'], ["Tonkatsu", 'sandwich'],
  ["Stuffed naan", 'sandwich'], ["Matzo brei", 'sandwich'], ["Eggs Benedict", 'sandwich'],
  ["Éclair", 'sandwich'], ["Profiterole", 'sandwich'], ["Toaster Strudel", 'sandwich'],
  ["Cannoli", 'sandwich'], ["Egg McMuffin", 'sandwich'], ["Sausage biscuit", 'sandwich'],
  ["Dagwood sandwich", 'sandwich'], ["Pan bagnat", 'sandwich'], ["Francesinha", 'sandwich'],
  ["Tea sandwich", 'sandwich'], ["Chiko roll", 'sandwich'], ["Kachori", 'sandwich'],
  ["Siomai", 'sandwich'], ["Wonton", 'sandwich'],
  /* Group-vs-individual: ONE piece is a sandwich; the bowl/serving is a salad
     (those live in the salad block). */
  ["A single ravioli", 'sandwich'], ["A single french fry", 'sandwich'], ["A single tater tot", 'sandwich'],
  // ── Salads (named "___ salad", or a bowl of mixed / chopped things) ──
  ['Dry cereal', 'salad'], ['Nachos', 'salad'],
  ['Spaghetti', 'salad'],
  ['Poke bowl', 'salad'], ['Chips & salsa', 'salad'], ['Mac & cheese', 'salad'],
  ['Garden salad', 'salad'], ['Fruit salad', 'salad'], ['Trail mix', 'salad'],
  ['Charcuterie board', 'salad'], ['Pasta salad', 'salad'], ['Potato salad', 'salad'],
  ['Coleslaw', 'salad'], ['Caprese salad', 'salad'], ['Caesar salad', 'salad'],
  ['Greek salad', 'salad'], ['Three-bean salad', 'salad'], ['Waldorf salad', 'salad'],
  ['Tabbouleh', 'salad'], ['Cobb salad', 'salad'], ['Chef salad', 'salad'],
  ['Wedge salad', 'salad'], ['Spinach salad', 'salad'], ['Kale salad', 'salad'],
  ['Taco salad', 'salad'], ['Egg salad', 'salad'], ['Tuna salad', 'salad'],
  ['Chicken salad', 'salad'], ['Macaroni salad', 'salad'], ['Antipasto salad', 'salad'],
  ['Niçoise salad', 'salad'], ['Panzanella', 'salad'], ['Fattoush', 'salad'],
  ['Papaya salad', 'salad'], ['Ambrosia salad', 'salad'], ['Cucumber salad', 'salad'],
  ['Beet salad', 'salad'], ['Quinoa salad', 'salad'], ['Couscous salad', 'salad'],
  ['Corn salad', 'salad'], ['Broccoli salad', 'salad'], ['Seven-layer salad', 'salad'],
  ['Ham salad', 'salad'], ['Crab salad', 'salad'], ['Shrimp salad', 'salad'],
  ['Seafood salad', 'salad'], ['Pea salad', 'salad'], ['Carrot salad', 'salad'],
  ['Tomato salad', 'salad'], ['Watermelon salad', 'salad'], ['Jell-O salad', 'salad'],
  ['Orzo salad', 'salad'], ['Farro salad', 'salad'], ['Lentil salad', 'salad'],
  ['Chickpea salad', 'salad'], ['Arugula salad', 'salad'], ['House salad', 'salad'],
  ['Southwest salad', 'salad'], ['Pretzel salad', 'salad'], ['Larb', 'salad'],
  ['Gado-gado', 'salad'], ['Seaweed salad', 'salad'], ['Chopped salad', 'salad'],
  ['Fried rice', 'salad'], ['Risotto', 'salad'], ['Paella', 'salad'],
  ['Biryani', 'salad'], ['Mashed potatoes', 'salad'], ['Burrito bowl', 'salad'],
  ['Poutine', 'salad'], ['Chili cheese fries', 'salad'],
  ["Pico de gallo", 'salad'], ["Salsa verde", 'salad'], ["Chunky guacamole", 'salad'],
  ["Granola", 'salad'], ["Popcorn", 'salad'], ["Mixed nuts", 'salad'],
  ["Chicken and broccoli stir-fry", 'salad'], ["Beef and broccoli", 'salad'], ["Steamed rice", 'salad'],
  ["Lo mein", 'salad'], ["Pad thai", 'salad'], ["Fettuccine Alfredo", 'salad'],
  ["Penne alla vodka", 'salad'], ["Scrambled eggs", 'salad'], ["Crudité platter", 'salad'],
  ["Gummy bears", 'salad'], ["Jelly beans", 'salad'], ["M&Ms", 'salad'],
  ["Skittles", 'salad'], ["Roasted asparagus", 'salad'], ["Stuffing", 'salad'],
  ["Chana masala", 'salad'], ["Aloo gobi", 'salad'], ["Palak paneer", 'salad'],
  ["Raita", 'salad'], ["Kimchi", 'salad'], ["Sauerkraut", 'salad'],
  ["Ceviche", 'salad'], ["Bibimbap", 'salad'], ["Shaved Brussels sprouts salad", 'salad'],
  ["Edamame", 'salad'], ["Roasted Brussels sprouts", 'salad'], ["Glazed carrots", 'salad'],
  ["Sautéed mushrooms", 'salad'], ["Creamed corn", 'salad'], ["Succotash", 'salad'],
  ["Ratatouille", 'salad'], ["Caponata", 'salad'], ["Fiambre", 'salad'],
  ["Olivier salad", 'salad'], ["Shuba salad", 'salad'], ["Vinegret", 'salad'],
  ["Beef carpaccio", 'salad'], ["Chicken tenders", 'salad'], ["Hash browns", 'salad'],
  ["Home fries", 'salad'], ["Roasted chickpeas", 'salad'], ["Sunflower seeds", 'salad'],
  ["Cranberry sauce", 'salad'], ["Gorgonzola walnut salad", 'salad'],
  /* Group servings — one piece of each is a sandwich (see the sandwich block). */
  ["French fries", 'salad'], ["Tater tots", 'salad'], ["Bowl of ravioli", 'salad'],
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

/* Fisher–Yates with a seeded PRNG — a deterministic shuffle of the bank. */
function shuffledIndices(seed) {
  const rand = seedFrom(seed);
  const idx = BANK.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = rand() % (i + 1);
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  return idx;
}

/* Day 0 of the rotation. Whole days since this (Pacific) index the rotation;
   the exact epoch only sets which slice lands on which date, never anything
   the player can tell. */
const EPOCH = '2026-01-01';
function dayNumber(day) {
  const ms = Date.parse(day + 'T12:00:00Z') - Date.parse(EPOCH + 'T12:00:00Z');
  return Math.floor(ms / 86400000);
}

/**
 * Today's five foods — an EVEN ROTATION, not an independent daily roll. The
 * whole bank is shuffled once per cycle and walked PER_DAY at a time, so every
 * food appears exactly once before any repeats, and each new cycle reshuffles
 * (seeded by the cycle number) so the order differs year to year. Zero
 * maintenance: it runs forever off the date, and adding foods just lengthens
 * the no-repeat window. Still deterministic — same day, same five for everyone.
 */
export function todaysFoods(day = dayKey()) {
  const cycleLen = Math.max(1, Math.floor(BANK.length / PER_DAY));  // full no-repeat days per cycle
  const dn = dayNumber(day);
  const cycle = Math.floor(dn / cycleLen);
  const offset = ((dn % cycleLen) + cycleLen) % cycleLen;           // safe for dates before EPOCH
  const perm = shuffledIndices('sss-rotation:' + cycle);
  return perm.slice(offset * PER_DAY, offset * PER_DAY + PER_DAY).map((bankIndex, pos) => ({
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

  /* Climb the badge ladder (bronze/silver/gold at 10/25/50 correct). Fires at
     most once per food — a re-answer is refused with 409 above, before here.
     Best-effort: a cosmetic grant must never break answering. */
  if (correct) {
    try {
      const { recordAchievement } = await import('../achievements.js');
      await recordAchievement(env, 'sss', session.user_id, { type: 'correct' });
    } catch (err) { console.error('[sss] achievement record failed:', err && err.message); }
  }

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
