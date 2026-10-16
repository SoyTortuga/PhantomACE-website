/* ══════════════════════════════════════════════
   /api/daily/rite — The Daily Rite (one trivia question a day)

   GET  → today's question + options (the correct index is NEVER sent until
          you've answered), plus your answer and the crowd's % correct once
          you have.
   POST { pick } → lock in one guess for the day. Records it, updates the
          day's aggregate, grants a bonus giveaway entry if right, and marks
          the Rite done for the daily hub. One guess per Pacific day.

   The question is chosen deterministically from the day key, so everyone gets
   the same one and it can't be rerolled. DONE-ON-ANSWER, not done-on-correct:
   engaging is what counts toward the hub streak; being right is what pays the
   entry. The bank is a plain array — append to grow it.
   ══════════════════════════════════════════════ */

import { dayKey } from '../season-time.js';
import { markDailyComplete, readDaily, setRiteAnswer } from './state.js';

/* Each: question, four options, index of the correct one, a category tag.
   Themed to PhantomACE's world — the games, MTG, metal, horror, retro. */
const BANK = [
  { q: 'In Dino Park, which rarity sits at the very top of the roster?', o: ['Epic', 'Legendary', 'Mythic', 'Exclusive'], a: 1, c: 'PhantomACE' },
  { q: 'What does the Skull Clicker "Bone Tithe" ask chat to do?', o: ['Donate bits', 'Reach a shared offering goal', 'Vote on a boss', 'Click faster'], a: 1, c: 'PhantomACE' },
  { q: 'In Magic, how many cards are in a Commander deck (including the commander)?', o: ['60', '99', '100', '40'], a: 2, c: 'MTG' },
  { q: 'Which color pie in Magic is most associated with direct damage?', o: ['White', 'Blue', 'Red', 'Green'], a: 2, c: 'MTG' },
  { q: 'A "commander" in the format must be what type by default?', o: ['A legendary creature', 'Any planeswalker', 'An artifact', 'A land'], a: 0, c: 'MTG' },
  { q: 'What year did the original DOOM release?', o: ['1991', '1993', '1996', '1999'], a: 1, c: 'Retro' },
  { q: 'Which band released the album "Master of Puppets"?', o: ['Slayer', 'Megadeth', 'Metallica', 'Anthrax'], a: 2, c: 'Metal' },
  { q: 'In a zombie apocalypse pack like Cursed Walking, what typically scales the danger up?', o: ['Player level', 'In-game days survived', 'Coins spent', 'Chat size'], a: 1, c: 'Gaming' },
  { q: 'What is the standard Minecraft server port?', o: ['8080', '25565', '27015', '3000'], a: 1, c: 'Gaming' },
  { q: 'Which dinosaur is famously the "tyrant lizard king"?', o: ['Spinosaurus', 'Giganotosaurus', 'Tyrannosaurus rex', 'Allosaurus'], a: 2, c: 'Dinosaurs' },
  { q: 'Quetzalcoatlus, in Dino Park’s legendary tier, was a giant what?', o: ['Marine reptile', 'Pterosaur (flying reptile)', 'Sauropod', 'Raptor'], a: 1, c: 'Dinosaurs' },
  { q: 'Megalodon was an enormous prehistoric what?', o: ['Whale', 'Shark', 'Squid', 'Crocodile'], a: 1, c: 'Dinosaurs' },
  { q: 'In horror, what is a "final girl"?', o: ['The first victim', 'The lone survivor who confronts the killer', 'The villain', 'A sequel-only character'], a: 1, c: 'Horror' },
  { q: 'Which classic console was Nintendo’s 16-bit machine?', o: ['NES', 'SNES', 'N64', 'GameCube'], a: 1, c: 'Retro' },
  { q: 'In Magic, what does "mill" mean?', o: ['Draw extra cards', 'Put cards from a library into the graveyard', 'Gain life', 'Tap for mana'], a: 1, c: 'MTG' },
  { q: 'Dunkleosteus, an epic in Dino Park, was an armored prehistoric what?', o: ['Fish', 'Amphibian', 'Bird', 'Mammal'], a: 0, c: 'Dinosaurs' },
  { q: 'What does "SRT" refer to in streaming?', o: ['A subtitle format only', 'A low-latency video transport protocol', 'A scene transition', 'A chat bot'], a: 1, c: 'Streaming' },
  { q: 'Which of these is a real Magic set mechanic?', o: ['Proliferate', 'Overclock', 'Respawn', 'Checkpoint'], a: 0, c: 'MTG' },
  { q: 'A "prestige" in an idle game usually means what?', o: ['Buying cosmetics', 'Resetting progress for a lasting bonus', 'Ranking up chat', 'Pausing the game'], a: 1, c: 'Gaming' },
  { q: 'What mythological creature is a reanimated corpse that rises to feed?', o: ['Golem', 'Revenant', 'Wraith', 'Lich'], a: 1, c: 'Horror' },
  { q: 'The woolly mammoth is most closely related to which living animal?', o: ['Rhino', 'Elephant', 'Hippo', 'Bison'], a: 1, c: 'Dinosaurs' },
  { q: 'In Twitch terms, what is a "raid"?', o: ['A ban wave', 'Sending your viewers to another channel', 'A subathon', 'A chat game'], a: 1, c: 'Streaming' },
  { q: 'Which band is fronted by a corpse-painted act and known for "corpse paint" generally?', o: ['Black metal bands', 'Pop-punk bands', 'Jazz trios', 'Synthwave artists'], a: 0, c: 'Metal' },
  { q: 'Velociraptors were, in reality, closer in size to a:', o: ['Horse', 'Turkey', 'Elephant', 'Bus'], a: 1, c: 'Dinosaurs' },
  { q: 'What is the name of the Dino Park minigame where eggs are incubated?', o: ['The Hatchery', 'The Incubator', 'Dino Hatch', 'The Nest'], a: 2, c: 'PhantomACE' },
  { q: 'In Magic, "lethal" damage to a typical creature means damage equal to its:', o: ['Power', 'Toughness', 'Mana value', 'Loyalty'], a: 1, c: 'MTG' },
  { q: 'Which is a classic survival-horror series?', o: ['Resident Evil', 'Mario Kart', 'Tetris', 'Rocket League'], a: 0, c: 'Gaming' },
  { q: 'Sabertooth cats are famous for their oversized:', o: ['Claws', 'Canine teeth', 'Horns', 'Tails'], a: 1, c: 'Dinosaurs' },
  { q: 'A "frenzy" in Skull Clicker does what?', o: ['Ends the run', 'Doubles clicks for a short time', 'Resets prestige', 'Mutes chat'], a: 1, c: 'PhantomACE' },
  { q: 'What does OBS stand for?', o: ['Online Broadcast Studio', 'Open Broadcaster Software', 'Overlay Build System', 'Output Buffer Source'], a: 1, c: 'Streaming' },
];

/* Tiny deterministic string hash → 32-bit int (xmur3), so the day's question
   is stable for everyone without a stored roll. */
function pickIndex(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = (h ^ (h >>> 13)) >>> 0;
  return h % BANK.length;
}

function todaysQuestion(day = dayKey()) {
  const idx = pickIndex('daily-rite:' + day);
  return { index: idx, ...BANK[idx] };
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

const aggKey = (day) => 'rite_agg_' + day;

/** The crowd's % correct for the day, rounded; null until anyone has answered. */
async function pctCorrect(env, day) {
  let agg = null;
  try { agg = await env.MARKETPLACE.get(aggKey(day), 'json'); } catch { agg = null; }
  const total = Number(agg && agg.total) || 0;
  if (!total) return null;
  return Math.round(((Number(agg.correct) || 0) / total) * 100);
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const day = dayKey();
  const q = todaysQuestion(day);
  const session = getSession(request);

  const base = { day, category: q.c, question: q.q, options: q.o };

  if (!session || !session.user_id) return json({ ...base, loggedIn: false, answered: false });

  const rec = await readDaily(env, session.user_id);
  const mine = rec.rite && rec.rite.day === day ? rec.rite : null;
  if (!mine) return json({ ...base, loggedIn: true, answered: false });

  /* Answered: now it's safe to reveal the correct index and the crowd stat. */
  return json({
    ...base, loggedIn: true, answered: true,
    yourPick: mine.pick, correctIndex: q.a, wasCorrect: mine.correct,
    pctCorrect: await pctCorrect(env, day),
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const pick = Number(body && body.pick);
  if (!Number.isInteger(pick) || pick < 0 || pick > 3) return json({ error: 'Pick 0-3' }, 400);

  const day = dayKey();
  const q = todaysQuestion(day);

  /* One guess per day. Re-check against the stored record (the client also
     gates, but the server is authoritative). */
  const rec = await readDaily(env, session.user_id);
  if (rec.rite && rec.rite.day === day) {
    return json({ error: 'Already answered today', answered: true, yourPick: rec.rite.pick, correctIndex: q.a, wasCorrect: rec.rite.correct, pctCorrect: await pctCorrect(env, day) }, 409);
  }

  const correct = pick === q.a;
  await setRiteAnswer(env, session.user_id, { day, pick, correct });

  /* Aggregate for the crowd stat. */
  await env.MARKETPLACE.mutate(aggKey(day), (cur) => {
    const agg = cur && typeof cur === 'object' ? cur : { total: 0, correct: 0 };
    agg.total = (Number(agg.total) || 0) + 1;
    if (correct) agg.correct = (Number(agg.correct) || 0) + 1;
    return agg;
  });

  /* A right answer pays a bonus giveaway entry; engaging at all marks the Rite
     done for the hub streak. */
  let entryGranted = false;
  if (correct) {
    try {
      const { addEntries } = await import('../giveaway-entries.js');
      await addEntries(env, session.user_id, session.display_name || 'Someone', 1, 'daily-rite');
      entryGranted = true;
    } catch (err) { console.error('[rite] entry grant failed:', err && err.message); }
  }
  const daily = await markDailyComplete(env, session.user_id, session.display_name, 'daily-rite');

  return json({
    answered: true, yourPick: pick, correctIndex: q.a, wasCorrect: correct,
    entryGranted, pctCorrect: await pctCorrect(env, day),
    cleared: !!(daily && daily.newlyCleared), streak: daily && daily.streak,
  });
}

export { BANK as RITE_BANK, todaysQuestion };
