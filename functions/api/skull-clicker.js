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

const LB_KEY = 'sc_leaderboard';
const SAVE_MAX_BYTES = 20000;   /* a real save is a few hundred bytes */
const EVENT_KEY = 'sc_event';
const EVENT_MAX_MS = 30 * 60 * 1000;   /* cap a frenzy at 30 min, whoever sets it */

const saveKey = (userId) => `sc_save_${userId}`;

/**
 * Start a site-wide Skull Clicker event (a cursed-skull frenzy). Shared so
 * the hype-train webhook can call it too. Best-effort by contract: callers
 * wrap it so an event never breaks the thing that triggered it.
 */
export async function setSkullEvent(env, type, durationMs) {
  const until = Date.now() + Math.min(Math.max(0, durationMs || 0), EVENT_MAX_MS);
  await env.MARKETPLACE.put(EVENT_KEY, JSON.stringify({ type: type || 'frenzy', until }));
  return { type: type || 'frenzy', until };
}

/** The current event, or null when none is set or it has already elapsed. */
async function currentEvent(env) {
  const ev = await env.MARKETPLACE.get(EVENT_KEY, 'json');
  if (!ev || !ev.until || ev.until <= Date.now()) return null;
  return ev;
}

/* ── Seasonal leaderboard ──────────────────────────────────────────────
   sc_leaderboard is the ALL-TIME board (lifetime skulls, never reset). The
   SEASON board ranks skulls gathered THIS month, so it is a real monthly
   race rather than lifetime with a wipe that instantly refills. It is
   season-aware server-side: the stored month is the authority, so when the
   month turns the previous winners are prized (once) and the board clears —
   the client never has to get the reset moment right. */
const SEASON_KEY = 'sc_season';                 // { month:'YYYY-MM', entries:[] }
const SEASON_CODE_SECONDS = 604800;             // 7-day redemption, like the other monthly prizes
const SEASON_PLACEMENTS = [
  { rarity: 'mythic',   suffix: 'Champion',    medal: '🥇' },
  { rarity: 'rare',     suffix: 'Runner-Up',   medal: '🥈' },
  { rarity: 'uncommon', suffix: 'Third Place', medal: '🥉' },
];

function monthKeyUTC(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
function monthLabelFromKey(key) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function readSeason(raw) {
  if (raw && Array.isArray(raw.entries) && raw.month) return raw;
  return { month: monthKeyUTC(new Date()), entries: [] };
}

/* Whisper the ended season's top-3 a redeemable badge code, once. Best-effort
   per placement so one failure never aborts the rollover. */
async function awardSeasonWinners(env, winners, endedMonth) {
  const label = monthLabelFromKey(endedMonth);
  const names = [];
  const { createItemCode, activateItemCode } = await import('./item-codes.js');
  const { sendWhisper } = await import('./bot/send-chat.js');
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i], p = SEASON_PLACEMENTS[i];
    try {
      const record = await createItemCode(env, {
        id: `season_skull-clicker_${endedMonth}_${i + 1}`,
        game: 'skull-clicker', type: 'badge',
        name: `Skull Clicker ${p.suffix} — ${label}`, rarity: p.rarity,
      });
      await activateItemCode(env, record.code, SEASON_CODE_SECONDS);
      await sendWhisper(env, w.id,
        `${p.medal} You placed #${i + 1} in the Skull Clicker season for ${label}! ` +
        `Your ${p.rarity} code: ${record.code} — redeem at phantomace.tv/redeem.html within 7 days.`);
    } catch { /* skip this placement */ }
    names.push(`${p.medal} ${w.name}`);
  }
  try {
    const { announceAction } = await import('./bot/send-chat.js');
    if (names.length) await announceAction(env,
      `💀 Skull Clicker ${label} champions: ${names.join(' ')} — codes whispered. Congrats!`, 'sc-season');
  } catch { /* announcement is a nicety */ }
}

/* Ensure the season board is for the current month, rolling it over (and
   prizing the previous winners exactly once) when the month has turned. */
async function rolloverSeason(env) {
  const cur = monthKeyUTC(new Date());
  let s = readSeason(await env.MARKETPLACE.get(SEASON_KEY, 'json'));
  if (s.month === cur) return s;

  const winners = (s.entries || []).filter(e => !String(e.id).startsWith('guest_')).slice(0, 3);
  let claimed = true;
  try {
    if (typeof env.MARKETPLACE.claimMonthlyAward === 'function') {
      claimed = await env.MARKETPLACE.claimMonthlyAward('sc_season_' + s.month);
    }
  } catch { claimed = true; }
  if (claimed && winners.length) await awardSeasonWinners(env, winners, s.month);

  s = { month: cur, entries: [] };
  await env.MARKETPLACE.put(SEASON_KEY, JSON.stringify(s));
  return s;
}

/* The save-merge rank, matched exactly by the client. Prestige first, then
   lifetime skulls — never the run total, which prestige resets to zero. If
   the merge ranked on run total, a prestige (total 0) would lose to the old
   save and the sync would silently undo it. lifetime is monotonic and
   prestige only climbs, so this is safe from both directions. */
function num(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }
function lifetimeOf(state) { return Math.max(num(state && state.lifetimeSkulls), num(state && state.totalSkulls)); }
function prestigeOf(state) { return Math.floor(num(state && state.prestige)); }

/** True when `a` should win the merge over `b`. */
function outranks(a, b) {
  const pa = prestigeOf(a), pb = prestigeOf(b);
  if (pa !== pb) return pa > pb;
  return lifetimeOf(a) > lifetimeOf(b);
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  /* `?event=1` — the live site-wide event the game polls for; kept separate
     from the leaderboard so the leaderboard's array shape never changes. */
  if (url.searchParams.get('event')) {
    return json({ event: await currentEvent(env) });
  }
  /* `?board=season` — this month's race (rolled over on read so the display
     is always current); `?board=alltime` (or no param) — the persistent
     lifetime board, unchanged in shape for any existing caller. */
  if (url.searchParams.get('board') === 'season') {
    const s = await rolloverSeason(env);
    return json({ month: s.month, entries: s.entries.slice(0, 15) });
  }
  const lb = await env.MARKETPLACE.get(LB_KEY, 'json') || [];
  return json(lb.slice(0, 15));
}

/**
 * Cross-device save, LOGGED-IN PLAYERS ONLY. A guest's id lives in the same
 * localStorage a wipe clears, so there is nothing stable to key their save
 * on — the very failure this fixes would orphan it too.
 *
 * HIGHEST LIFETIME TOTAL WINS, always. totalSkulls only ever climbs, so it
 * is a safe merge key: an old tab or a second device can never clobber a
 * better save, and a cleared browser (local total 0) adopts the server's
 * on load rather than the reverse. The write returns the winner so the
 * client can adopt it when the server's was ahead.
 */
async function saveState(env, session, body) {
  const state = body && body.state;
  if (!state || typeof state !== 'object') return json({ error: 'No state' }, 400);
  if (JSON.stringify(state).length > SAVE_MAX_BYTES) return json({ error: 'Save too large' }, 400);

  let winner = state;

  await env.MARKETPLACE.mutate(saveKey(session.user_id), (current) => {
    if (current && outranks(current, state)) {
      winner = current;                 /* server is ahead — keep it, tell the client */
      return undefined;                 /* no write */
    }
    return { ...state, savedAt: Date.now() };
  });

  return json({ success: true, adopted: winner !== state, state: winner });
}

async function loadState(env, session) {
  const state = await env.MARKETPLACE.get(saveKey(session.user_id), 'json');
  return json({ state: state || null });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  /* The save/load pair is login-only, so it checks the session directly
     rather than through getPlayer (which also admits guests). */
  if (body.action === 'save-state' || body.action === 'load-state') {
    const session = getSession(request);
    if (!session || !session.user_id) return json({ error: 'Log in to sync your progress.' }, 401);
    return body.action === 'save-state'
      ? saveState(env, session, body)
      : loadState(env, session);
  }

  /* Start a frenzy by hand — the broadcaster/moderators from Bot Control, or
     a curl. Bounded server-side so a bad client cannot set a forever-event. */
  if (body.action === 'trigger-event') {
    const session = getSession(request);
    const { isModerator } = await import('./admin/moderators.js');
    if (!(await isModerator(env, session))) {
      return json({ error: 'Only the broadcaster and moderators can start an event.' }, 403);
    }
    const mins = Math.min(30, Math.max(1, Math.floor(Number(body.minutes) || 5)));
    const ev = await setSkullEvent(env, 'frenzy', mins * 60 * 1000);
    return json({ success: true, event: ev });
  }

  if (body.action !== 'submit-score') return json({ error: 'Invalid action' }, 400);

  const player = getPlayer(request, body);
  if (!player) return json({ error: 'Not authenticated' }, 401);

  const score = typeof body.score === 'number' ? Math.floor(body.score) : 0;
  if (score <= 0) return json({ error: 'Invalid score' }, 400);
  /* Carried for display — a prestige tier beside the name is the visible
     reward for resetting. Bounded so a bad client cannot store nonsense. */
  const prestige = Math.max(0, Math.min(9999, Math.floor(Number(body.prestige) || 0)));

  /* SEASON board — skulls gathered this month, sent alongside the lifetime
     score. Handled first and independently so it still records even when the
     lifetime board's early-return fires below. */
  const seasonScore = Math.max(0, Math.floor(Number(body.seasonScore) || 0));
  if (seasonScore > 0) {
    const s = await rolloverSeason(env);
    const ex = s.entries.find(e => e.id === player.id);
    if (ex) {
      if (seasonScore > ex.score) { ex.score = seasonScore; ex.name = player.name; ex.prestige = prestige; ex.updatedAt = Date.now(); }
      else if (prestige > (ex.prestige || 0)) { ex.prestige = prestige; }
    } else {
      s.entries.push({ id: player.id, name: player.name, score: seasonScore, prestige, updatedAt: Date.now() });
    }
    s.entries.sort((a, b) => b.score - a.score);
    s.entries = s.entries.slice(0, 50);
    await env.MARKETPLACE.put(SEASON_KEY, JSON.stringify(s));
  }

  const lb = await env.MARKETPLACE.get(LB_KEY, 'json') || [];

  const existing = lb.find(e => e.id === player.id);
  if (existing) {
    if (score > existing.score) {
      existing.score = score;
      existing.name = player.name;
      existing.prestige = prestige;
      existing.updatedAt = Date.now();
    } else {
      /* Score only ever rises, but prestige can climb while the leaderboard
         number is still catching up to a past run — keep the badge current. */
      if (prestige > (existing.prestige || 0)) {
        existing.prestige = prestige;
        await env.MARKETPLACE.put(LB_KEY, JSON.stringify(lb));
      }
      return json({ success: true, updated: false });
    }
  } else {
    lb.push({ id: player.id, name: player.name, score, prestige, updatedAt: Date.now() });
  }

  lb.sort((a, b) => b.score - a.score);
  const trimmed = lb.slice(0, 50);
  await env.MARKETPLACE.put(LB_KEY, JSON.stringify(trimmed));

  return json({ success: true, updated: true });
}
