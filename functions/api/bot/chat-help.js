/* ══════════════════════════════════════════════
   WHAT CAN I TYPE RIGHT NOW?

     chat: !commands

   Thirteen viewer commands have accumulated and nothing told anybody they
   exist. A command chat cannot discover is a feature that does not run.

   IT ANSWERS WITH WHAT IS PLAYABLE, NOT WITH EVERYTHING. A wall of thirteen
   is unreadable in chat and most of it would be wrong — !catch does nothing
   without a Safari, !op nothing without a draft. So this reads the live state
   and names only what works this second, which is usually two or three things
   and fits one line.

   This is the ONE chat command that is allowed to be chatty. Every other one
   is silent because it is typed by hundreds of people at once; this is typed
   by one person asking a question, and a question with no answer is worse
   than the noise.

   THE READS ARE CACHED IN-PROCESS for a few seconds. A dozen people asking
   at once during a raid should not each cost a dozen storage reads, and the
   answer cannot meaningfully change inside that window. Same trick the maze
   uses for its idle hint. The server is deliberately single-instance, so one
   process means one cache.
   ══════════════════════════════════════════════ */

/* Per-asker, not global: one person spamming it should silence only
   themselves, exactly as !entries does. */
export const HELP_COOLDOWN_MS = 30000;
const CACHE_MS = 5000;

let cache = { at: 0, line: null };

/** Read a key, and never let a missing one break the answer. */
async function get(env, key) {
  try { return await env.MARKETPLACE.get(key, 'json'); } catch { return null; }
}

/* The keys read below, in the order they destructure.
   EXPORTED SO A TEST CAN PIN THEM. Every read here is wrapped in a try/catch
   that returns null, which means a key that is misspelled or unregistered does
   not fail — it quietly reports "not running" forever. That is how !clash went
   un-offered: this read 'mana_clash_chat' while the game stores
   'mana_clash_vs_chat', and nothing anywhere could notice. */
export const HELP_KEYS = [
  'bingo_current', 'bingo_chat', 'sc_raid', 'bone_tithe', 'mana_clash_vs_chat',
  'pham_wind_night', 'dino_safari', 'mtgbbb_guess', 'r6_draft', 'chat_vote',
  'mm_chat', 'maze_current', 'chat_scramble',
];

/**
 * What is playable this second.
 *
 * Each check is deliberately shallow — "is this mode's record present and
 * live" — rather than importing each game's own state machine. A help line
 * that could be wrong is better than one that can break every chat command
 * by throwing inside somebody else's lifecycle logic.
 */
export async function playableNow(env, now = Date.now()) {
  const out = [];

  const [bingoPtr, bingoCard, raid, tithe, clash, wind, safari, guess, draft, vote, mem, maze, scramble] =
    await Promise.all(HELP_KEYS.map(k => get(env, k)));

  if (bingoPtr && bingoPtr.code) out.push('!bingo');
  if (bingoCard && bingoCard.stamp == null) out.push('!stamp <1-25>');
  if (raid && raid.status === 'active') out.push('!hit');
  if (tithe && tithe.status === 'active') out.push('!tithe');
  /* 'collecting' is the only phase !clash does anything in — 'resolved' is
     the reveal, when a vote would be refused. The window matters too: the
     record sits at 'collecting' until something advances it, so without this
     the line would keep offering a vote that has already closed. */
  if (clash && clash.status === 'collecting' && now < clash.collectUntil) out.push('!clash');
  if (wind && wind.status === 'active') out.push('!wind left/right');

  /* The Safari's two commands are mutually exclusive, and naming the wrong
     one is worse than naming neither — !catch between spawns does nothing. */
  if (safari && safari.status === 'active') {
    const catching = safari.spawn && now < safari.spawn.catchUntil;
    out.push(catching ? '!catch' : '!track');
  }

  if (guess && guess.status === 'open') out.push('!guess <card>');
  if (draft && draft.status === 'open') out.push('!op <operator>');
  if (vote && vote.status === 'open') out.push('!vote');
  if (mem && mem.status === 'live') out.push('!flip <n>');
  if (maze && maze.status === 'active') out.push('up/down/left/right');
  /* 'running' only: during 'reveal' the word is already on screen. */
  if (scramble && scramble.status === 'running') out.push('just type your answer');

  return out;
}

/** The one line the bot says. Null when it should stay quiet. */
export async function helpLine(env, now = Date.now()) {
  if (cache.line !== null && now - cache.at < CACHE_MS) return cache.line;

  const playable = await playableNow(env, now);
  const line = playable.length
    ? `Playable now: ${playable.join(' · ')} — and !entries for your giveaway count.`
    : 'Nothing running right now — !entries still works, and games get announced here when they start.';

  cache = { at: now, line };
  return line;
}

/** Test seam: the cache is process-level, so a suite must be able to clear it. */
export function _resetCache() { cache = { at: 0, line: null }; }
