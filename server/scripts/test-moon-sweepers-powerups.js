#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MOON SWEEPERS BITS POWER-UPS — the soft gate

     node server/scripts/test-moon-sweepers-powerups.js

   RUNS OFFLINE. Helix is stubbed; nothing here reaches Twitch.

   WHAT THIS IS GUARDING.

   THE LIST IS COPIED BY HAND AND MUST NOT DRIFT. Twitch has no API to
   create or read back a custom Power-up's configuration, so the 21 titles in
   the data module, the 21 in docs/MOON-SWEEPERS-POWERUPS.md and the 21 typed
   into the Creator Dashboard are three hand-kept copies. A title that drifts
   does not error anywhere — it just stops matching PowerUpMappings in the
   mod, and the Power-up silently does nothing for the viewer who paid. Two
   of those copies are files, so two of them can be checked.

   THE ANNOUNCEMENT MUST FIRE ONCE, ON A REAL MOVE. channel.update is one
   event carrying four kinds of change: a title edit, a Twitch rename of the
   same category and a plain redelivery all arrive looking much like a switch.
   Announcing on any of them is repeat spam in chat, which is how a bot gets
   muted. Announcing on none of them means viewers spend Bits on a game we
   are not playing.

   AND IT MUST NEVER BREAK THE WEBHOOK. A throw inside the handler answers
   Twitch non-200, and enough of those disable the subscription — which would
   take the stored category down with it, breaking far more than one line of
   chat. So a dead chat send has to leave the webhook at 200.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ms from '../../functions/api/powerups/moon-sweepers.js';
import * as cu from '../../functions/api/channel-update.js';
import * as commands from '../../functions/api/bot/commands.js';
import { playableNow, _resetCache, HELP_KEYS } from '../../functions/api/bot/chat-help.js';
import { NON_ROUTE_MODULES } from '../router.js';
import { resolveKey } from '../lib/registry.js';
import { signEventSub } from '../lib/eventsub.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/* Line endings normalised on the way in. Git checks these files out with
   CRLF on Windows, which silently broke the doc parse below: a pattern
   anchored on "```\n" matched nothing, so the copy-paste block read as
   empty rather than as a disagreement. */
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8').replace(/\r\n/g, '\n');
const SECRET = 'test-eventsub-secret';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── Harness ─────────────────────────────────────────────────────────── */

let sent = [];
/* Set to make the chat send fail the way Twitch really can. */
let chatFails = null;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/helix/chat/messages')) {
    if (chatFails) throw new Error(chatFails);
    sent.push(JSON.parse(opts.body).message);
    return new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 });
  }
  if (u.includes('oauth2/token')) {
    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

/* The store consults the REAL registry, so an unregistered key throws here
   exactly as it does on the rig. That is how !commands shipped silent. */
function makeEnv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  const guard = (k, op) => {
    if (!resolveKey(k)) throw new Error(`${op}() key "${k}" has no table mapping`);
  };
  return {
    TWITCH_EVENTSUB_SECRET: SECRET,
    TWITCH_BROADCASTER_ID: '900',
    TWITCH_CLIENT_ID: 'cid',
    twitch_bot_user_id: '555',
    MARKETPLACE: {
      async get(k, t) { guard(k, 'get'); if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { guard(k, 'put'); store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { guard(k, 'delete'); store.delete(k); },
      async mutate(k, fn) {
        guard(k, 'mutate');
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next === undefined) return cur;
        store.set(k, JSON.stringify(next));
        return JSON.parse(store.get(k));
      },
      async listValues() { return []; },
      async claim(k) { guard(k, 'claim'); if (!store.has(k)) return null; const v = store.get(k); store.delete(k); return JSON.parse(v); },
    },
    _store: store,
  };
}

const BOT = { twitch_bot_token: { access_token: 'x', expiresAt: Date.now() + 3600e3 } };

/** Post a signed channel.update, flushing whatever it defers. */
async function categoryEvent(env, event) {
  sent = [];
  const raw = JSON.stringify({ subscription: { type: 'channel.update' }, event });
  const mid = 'mid-' + Math.random().toString(36).slice(2);
  const ts = new Date().toISOString();
  const request = new Request('https://phantomace.tv/api/channel-update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-id': mid,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': await signEventSub(SECRET, mid, ts, raw),
    },
    body: raw,
  });
  const deferred = [];
  const res = await cu.onRequestPost({ env, request, waitUntil: (p) => deferred.push(p) });
  await Promise.all(deferred);
  return { status: res.status, sent: [...sent] };
}

/** Type a message in chat as a plain viewer, and flush the deferred sends. */
async function say(env, text, { userId = '42', name = 'Viewer' } = {}) {
  sent = [];
  _resetCache();
  const raw = JSON.stringify({
    subscription: { type: 'channel.chat.message' },
    event: {
      chatter_user_id: userId,
      chatter_user_name: name,
      chatter_user_login: name.toLowerCase(),
      broadcaster_user_id: '900',
      message: { text },
      badges: [],
    },
  });
  const mid = 'mid-' + Math.random().toString(36).slice(2);
  const ts = new Date().toISOString();
  const request = new Request('https://phantomace.tv/api/bot/commands', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-id': mid,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': await signEventSub(SECRET, mid, ts, raw),
    },
    body: raw,
  });
  const deferred = [];
  const res = await commands.onRequestPost({ env, request, waitUntil: (p) => deferred.push(p) });
  await Promise.all(deferred);
  return { status: res.status, sent: [...sent] };
}

const MOON = { category_id: '7777', category_name: 'Moon Sweepers', title: 'Dusting the moon' };
const MTG = { category_id: '2748', category_name: 'Magic: The Gathering', title: 'Cracking a box' };

/* ── THE DOC IS THE SOURCE OF TRUTH, AND IT AGREES ───────────────────────
   Parsed out of the markdown table rather than retyped here: a third copy
   in this file would only be a third thing to drift. */
{
  const doc = read('docs/MOON-SWEEPERS-POWERUPS.md');

  const rows = [...doc.matchAll(/^\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|\s*([\d,]+)\s*\|\s*(.+?)\s*\|\s*$/gm)]
    .map(m => ({
      n: Number(m[1]),
      title: m[2],
      bits: Number(m[3].replace(/,/g, '')),
      /* The doc marks the gravity warnings bold; the string pasted into the
         dashboard has no markdown in it. */
      effect: m[4].replace(/\*\*/g, '').trim(),
    }));

  check('the doc table still parses as 21 rows', rows.length, 21);
  check('and the module carries exactly 21', ms.POWERUPS.length, 21);

  check('every title matches the doc exactly, in order',
    ms.POWERUPS.map(p => p.title), rows.map(r => r.title));
  check('every Bit cost matches the doc',
    ms.POWERUPS.map(p => p.bits), rows.map(r => r.bits));
  check('every effect matches the doc',
    ms.POWERUPS.map(p => p.effect), rows.map(r => r.effect));
  check('and the numbering is the doc’s', ms.POWERUPS.map(p => p.n), rows.map(r => r.n));

  /* The copy-paste block is what actually gets typed into the dashboard, so
     it has to say the same thing as the table above it. */
  const block = doc.match(/### Titles only, for fast copy-paste\s*```\n([\s\S]*?)```/);
  ok('the copy-paste block is still there', !!block);
  const pasteTitles = block ? block[1].trim().split('\n').map(s => s.trim()).filter(Boolean) : [];
  check('the copy-paste block agrees with the module', pasteTitles, ms.POWERUPS.map(p => p.title));

  /* The three punctuation traps the doc calls out by name. Capitals do not
     matter to the mod; spaces and punctuation do. */
  const titles = ms.POWERUPS.map(p => p.title);
  ok('Shrink-Flation keeps its hyphen', titles.includes('Shrink-Flation'));
  ok('Spill The Dust keeps its capital T', titles.includes('Spill The Dust'));
  for (const g of ['2x Gravity', '4x Gravity', '8x Gravity']) {
    ok(`${g} is lowercase x with no space`, titles.includes(g));
  }

  check('cheapest first, so the page and the teaser agree on "cheapest"',
    ms.POWERUPS.map(p => p.bits), [...ms.POWERUPS.map(p => p.bits)].sort((a, b) => a - b));
  check('and CHEAPEST is the one chat is told about', ms.CHEAPEST.title, 'Lights Out');
  check('at its real price', ms.CHEAPEST.bits, 250);

  /* Every row's effect must actually say something — an empty one would
     render as a blank line on the page and nobody would notice. */
  check('no effect is empty', ms.POWERUPS.filter(p => !p.effect || p.effect.length < 20).map(p => p.title), []);
}

/* ── THE GRAVITY WARNING, WHICH IS THE ONE THAT COSTS BITS ───────────────
   A weaker gravity Power-up bought under a stronger one does nothing and
   nothing refunds it, so the warning has to be in the description itself —
   that is what shows on the buy screen — and it has to be liftable by the
   page, which emphasises exactly that sentence. */
{
  const byTitle = Object.fromEntries(ms.POWERUPS.map(p => [p.title, p]));

  check('2x warns about both stronger ones', byTitle['2x Gravity'].warning,
    'Does nothing while 4x or 8x Gravity is running.');
  check('4x warns about 8x', byTitle['4x Gravity'].warning,
    'Does nothing while 8x Gravity is running.');
  check('8x has nothing to warn about — it is the strongest',
    byTitle['8x Gravity'].warning, undefined);

  /* The page lifts the warning by slicing it off the end of the effect. If
     it stopped being the tail, the chip would silently stop rendering. */
  for (const t of ['2x Gravity', '4x Gravity']) {
    ok(`${t}'s warning is the tail of its own description`,
      byTitle[t].effect.endsWith(byTitle[t].warning));
  }

  /* The dashboard may truncate; the doc keeps these under ~200 chars. */
  for (const t of ['2x Gravity', '4x Gravity', '8x Gravity']) {
    ok(`${t}'s description still fits a dashboard field`, byTitle[t].effect.length <= 200);
  }

  /* Only the gravity three carry a warning — a stray one elsewhere would be
     emphasised red on the page for no reason. */
  check('nothing else claims a warning',
    ms.POWERUPS.filter(p => p.warning).map(p => p.title), ['2x Gravity', '4x Gravity']);

  /* The notes still carry the untested pair, which is a spending warning of
     its own. */
  const notes = ms.NOTES.map(n => n.heading + ' ' + n.body).join(' ');
  ok('the notes say Roomba Shutdown is untested', /Roomba Shutdown/.test(notes));
  ok('and JOONAS Shutdown', /JOONAS Shutdown/.test(notes));
  ok('and that effects hit the whole lobby', /lobby/.test(notes));
}

/* ── The category matcher ─────────────────────────────────────────────── */
{
  ok('the exact name matches', ms.isMoonSweepers('Moon Sweepers'));
  ok('case does not matter', ms.isMoonSweepers('MOON SWEEPERS'));
  ok('nor does odd case', ms.isMoonSweepers('moon sweepers'));
  ok('surrounding whitespace is trimmed', ms.isMoonSweepers('  Moon Sweepers  '));
  ok('a tab too', ms.isMoonSweepers('\tMoon Sweepers\n'));

  ok('a different game does not match', !ms.isMoonSweepers('Magic: The Gathering'));
  ok('a superstring does not match', !ms.isMoonSweepers('Moon Sweepers 2'));
  ok('nor a substring', !ms.isMoonSweepers('Moon'));
  /* Inner whitespace is NOT normalised on purpose: that would be guessing at
     a different category rather than tolerating a stray keystroke. */
  ok('a doubled inner space is not the same category', !ms.isMoonSweepers('Moon  Sweepers'));

  ok('null is not a match, and does not throw', !ms.isMoonSweepers(null));
  ok('nor undefined', !ms.isMoonSweepers(undefined));
  ok('nor empty', !ms.isMoonSweepers(''));
  ok('nor a non-string', !ms.isMoonSweepers(42));
}

/* ── Which moves are announcements ───────────────────────────────────── */
{
  check('arriving on the game opens them',
    ms.categoryTransition('Magic: The Gathering', 'Moon Sweepers'), 'open');
  check('arriving from nothing opens them too — a first event is a real move',
    ms.categoryTransition(null, 'Moon Sweepers'), 'open');
  check('leaving closes them',
    ms.categoryTransition('Moon Sweepers', 'Just Chatting'), 'close');
  check('leaving to nothing still closes them',
    ms.categoryTransition('moon sweepers', null), 'close');

  check('a move between two other games says nothing',
    ms.categoryTransition('Magic: The Gathering', 'Just Chatting'), null);
  check('and a move that lands on the same game says nothing',
    ms.categoryTransition('Moon Sweepers', '  MOON SWEEPERS '), null);
  check('nor does nothing moving at all', ms.categoryTransition(null, null), null);
}

/* ── THE WEBHOOK: one line, on a real move ──────────────────────────────── */
{
  const env = makeEnv({ ...BOT });

  const open = await categoryEvent(env, MOON);
  check('Twitch gets its 200', open.status, 200);
  check('arriving on the game says exactly one thing', open.sent.length, 1);
  ok('and it says they are open', /OPEN/.test(open.sent[0]));
  ok('naming the whole lobby, not just the broadcaster', /lobby/i.test(open.sent[0]));
  ok('with the link to the list', open.sent[0].includes(ms.LIST_URL));

  /* A TITLE EDIT IS NOT A SWITCH. This is the one that would re-announce
     every time he fixes a typo mid-stream. */
  const retitled = await categoryEvent(env, { ...MOON, title: 'Dusting the moon — sector 4' });
  check('a title-only edit announces nothing', retitled.sent.length, 0);

  /* A TWITCH RENAME THAT STILL MATCHES IS NOT A MOVE. It writes — the stored
     display name must not go stale — but the gate has not shifted. */
  const recased = await categoryEvent(env, { ...MOON, category_name: 'MOON SWEEPERS' });
  check('a rename that still matches announces nothing', recased.sent.length, 0);

  /* A REDELIVERY WRITES NOTHING, SO IT MUST SAY NOTHING. Twitch delivers at
     least once and retries; the stored record still reads changed:'category'
     from the real move above, which is exactly the trap a decision made off
     that field would fall into. */
  const again = await categoryEvent(env, { ...MOON, category_name: 'MOON SWEEPERS' });
  check('an identical redelivery announces nothing', again.sent.length, 0);

  const close = await categoryEvent(env, MTG);
  check('leaving says exactly one thing', close.sent.length, 1);
  ok('and it says they are closed', /CLOSED/.test(close.sent[0]));
  ok('telling people not to spend', /don't spend|do nothing|nothing will happen/i.test(close.sent[0]));
  ok('with the link still on it', close.sent[0].includes(ms.LIST_URL));

  const elsewhere = await categoryEvent(env, { category_id: '509658', category_name: 'Just Chatting', title: 'hello' });
  check('a switch between two other games says nothing', elsewhere.sent.length, 0);

  const back = await categoryEvent(env, MOON);
  check('coming back announces again', back.sent.length, 1);
  ok('as an open', /OPEN/.test(back.sent[0]));
}

/* ── A RENAME OUT OF THE MATCHED NAME IS A REAL CLOSE ────────────────────
   Twitch renames categories, and `changed` calls that 'details' because the
   id did not move. The gate, though, HAS closed: nothing matches "Moon
   Sweepers" any more, so !powerups and the page both read not-live. Deciding
   the announcement off the event's class rather than off the matched state
   left chat told the Power-ups were open while every other surface said
   otherwise. */
{
  const env = makeEnv({ ...BOT });
  await categoryEvent(env, MOON);

  const gone = await categoryEvent(env, { ...MOON, category_name: 'Lunar Sweepers' });
  check('a rename out of the name closes them', gone.sent.length, 1);
  ok('and says so', /CLOSED/.test(gone.sent[0]));
  ok('which is what the rest of the site now reports',
    !(await ms.arePowerupsLive(env)));

  /* And it must not then close a second time when he leaves for real. */
  const leave = await categoryEvent(env, MTG);
  check('leaving afterwards does not close them twice', leave.sent.length, 0);
}

/* ── A DEAD CHAT SEND MUST NOT BREAK THE WEBHOOK ─────────────────────────
   Answer Twitch non-200 often enough and it disables the subscription,
   which would take the stored category with it. */
{
  const env = makeEnv({ ...BOT });
  chatFails = 'helix is on fire';
  try {
    const r = await categoryEvent(env, MOON);
    check('a throwing chat send still answers Twitch 200', r.status, 200);
    check('and nothing went out', r.sent.length, 0);
    /* The category itself is the valuable part and must still be recorded. */
    check('the category is still stored', (await cu.getStreamCategory(env)).categoryName, 'Moon Sweepers');
  } finally {
    chatFails = null;
  }

  /* And with no bot token at all — the state before the OAuth grant. */
  const noBot = makeEnv();
  const r2 = await categoryEvent(noBot, MOON);
  check('an unconfigured bot still answers 200', r2.status, 200);
  check('and the category is recorded anyway', (await cu.getStreamCategory(noBot)).categoryName, 'Moon Sweepers');
}

/* ── !powerups ───────────────────────────────────────────────────────── */
{
  const live = makeEnv({ ...BOT, stream_category: { categoryId: '7777', categoryName: 'Moon Sweepers', changed: 'category', changedAt: Date.now() } });
  const r = await say(live, '!powerups');
  check('Twitch gets its 200', r.status, 200);
  check('exactly one reply goes out', r.sent.length, 1);
  ok('saying they are live', /LIVE/.test(r.sent[0]));
  ok('with the link to the list', r.sent[0].includes(ms.LIST_URL));
  ok('and the cheapest one as a teaser', r.sent[0].includes(ms.CHEAPEST.title));

  const off = makeEnv({ ...BOT, stream_category: { categoryId: '2748', categoryName: 'Magic: The Gathering', changed: 'category', changedAt: Date.now() } });
  const r2 = await say(off, '!powerups');
  check('it replies when they are not live too', r2.sent.length, 1);
  ok('saying they are NOT live', /NOT live/.test(r2.sent[0]));
  ok('and that Bits spent do nothing', /do nothing/.test(r2.sent[0]));
  ok('with the link for later', r2.sent[0].includes(ms.LIST_URL));

  /* A category that was never recorded reads as "not live" rather than
     throwing — that is the state before the first channel.update ever lands. */
  const blank = makeEnv({ ...BOT });
  const r3 = await say(blank, '!powerups');
  check('an unknown category still replies', r3.sent.length, 1);
  ok('as not live', /NOT live/.test(r3.sent[0]));

  /* A trimmed/odd-cased stored name must still read as live — the whole
     reason the matcher is not ===. */
  const messy = makeEnv({ ...BOT, stream_category: { categoryId: '7777', categoryName: ' moon sweepers ', changed: 'category', changedAt: Date.now() } });
  ok('an untidy stored category still reads as live', /LIVE/.test((await say(messy, '!powerups')).sent[0] || ''));

  /* ANYONE MAY ASK. It sits before the moderator gate; a viewer with no
     badges is exactly who needs the answer. */
  const viewer = await say(live, '!powerups', { userId: '77', name: 'Nobody' });
  check('a badge-less viewer gets an answer', viewer.sent.length, 1);

  /* Per-asker cooldown: one spammer silences only themselves. */
  const cd = makeEnv({ ...BOT });
  check('the first ask answers', (await say(cd, '!powerups', { userId: '1' })).sent.length, 1);
  check('an immediate second from the same person does not', (await say(cd, '!powerups', { userId: '1' })).sent.length, 0);
  check('but somebody else still gets an answer', (await say(cd, '!powerups', { userId: '2' })).sent.length, 1);

  ok('the cooldown prefix is mapped in registry.js', !!resolveKey('bot_cooldown_powerups_42'));
}

/* ── 21 ITEMS DO NOT FIT IN A CHAT MESSAGE ───────────────────────────────
   Twitch cuts a chat message at ~500 characters. Every line the bot can say
   about the Power-ups has to be a link, not a list. */
{
  const LIMIT = 500;
  const lines = {
    'the open announcement': ms.openAnnouncement(),
    'the close announcement': ms.closeAnnouncement(),
    'the live !powerups reply': ms.powerupsReply(true),
    'the not-live !powerups reply': ms.powerupsReply(false),
  };
  for (const [what, line] of Object.entries(lines)) {
    ok(`${what} fits a chat message`, line.length <= LIMIT);
    ok(`${what} is not empty`, line.trim().length > 40);
    ok(`${what} links the list`, line.includes(ms.LIST_URL));
    /* A dump would be thousands of characters and get truncated mid-code. */
    const titlesIn = ms.POWERUPS.filter(p => line.includes(p.title)).length;
    ok(`${what} names at most a couple of Power-ups, not the list`, titlesIn <= 2);
  }

  /* The link has to be the page that actually exists. */
  check('the link points at the page in this repo', ms.LIST_URL, 'phantomace.tv/moonsweepers');
  ok('and that page is in the repo', fs.existsSync(path.join(REPO, 'moonsweepers.html')));
}

/* ── The help line offers it, but only where it means something ───────── */
{
  const on = makeEnv({ stream_category: { categoryName: 'Moon Sweepers' } });
  ok('!powerups is offered while we are on the game',
    (await playableNow(on)).includes('!powerups'));

  const offGame = makeEnv({ stream_category: { categoryName: 'Just Chatting' } });
  ok('and is not offered anywhere else',
    !(await playableNow(offGame)).includes('!powerups'));

  ok('the key the help line reads is mapped', HELP_KEYS.every(k => !!resolveKey(k)));
  ok('and it is the category key, not a copy of the name', HELP_KEYS.includes('stream_category'));
}

/* ── The registrations that fail silently when missed ────────────────── */
{
  /* A library under functions/ with no handler crashes the rig's boot. This
     one HAS a handler, so it must NOT be declared a library — a declared
     route 404s with nothing logged. */
  ok('the route is not declared a library',
    !NON_ROUTE_MODULES.has('api/powerups/moon-sweepers.js'));
  ok('because it is a route', typeof ms.onRequestGet === 'function');

  const env = makeEnv({ stream_category: { categoryName: 'Moon Sweepers' } });
  const res = await ms.onRequestGet({ env, request: new Request('http://localhost/api/powerups/moon-sweepers') });
  const body = await res.json();
  check('GET serves the whole list', body.powerups.length, 21);
  check('with the count beside it', body.count, 21);
  check('the live flag', body.live, true);
  check('and the notes', body.notes.length, ms.NOTES.length);

  const envOff = makeEnv({ stream_category: { categoryName: 'Just Chatting' } });
  const off = await (await ms.onRequestGet({ env: envOff, request: new Request('http://localhost/api/powerups/moon-sweepers') })).json();
  check('off the game the flag is false', off.live, false);
  check('but the list is still served', off.powerups.length, 21);
  check('and it names what we are on instead', off.category, 'Just Chatting');

  /* The soft gate hangs off the channel.update subscription, so it is dead
     without it. */
  const setup = read('functions/api/admin/bot-setup.js');
  ok('bot-setup still registers channel.update', /type: 'channel\.update'/.test(setup));
}

/* ── The page says what the module says ─────────────────────────────── */
{
  const html = read('moonsweepers.html');
  const js = read('js/pages/moonsweepers.js');

  ok('the page loads its own stylesheet', /css\/pages\/moonsweepers\.css/.test(html));
  ok('and its own script', /js\/pages\/moonsweepers\.js/.test(html));
  ok('with the no-flash theme script, so light mode does not flicker',
    /pham-theme/.test(html));
  ok('it uses the shared page hero rather than a private one',
    /class="page-hero"/.test(html) && /class="page-hero-title"/.test(html));
  ok('and has no eyebrow kicker above it', !/eyebrow|kicker/i.test(html));

  /* THE LIST IS NOT IN THE MARKUP. Twenty-one titles typed into the page
     would be a fourth hand-kept copy; it renders from the route. One
     cross-reference in the prose is fine — Mercy is named because it is what
     cancels every other timed effect, which is worth knowing before you read
     the list. A second name creeping in is the start of the copy. */
  const inMarkup = ms.POWERUPS.filter(p => html.includes(p.title)).map(p => p.title);
  check('the page does not restate the list', inMarkup, ['Mercy']);
  const costs = ms.POWERUPS.filter(p => html.includes(p.bits.toLocaleString() + ' Bits')).map(p => p.title);
  check('and no Bit cost is hardcoded except the warning’s example', costs, ['2x Gravity']);
  ok('the script fetches the shared route', /\/api\/powerups\/moon-sweepers/.test(js));

  /* The expensive mistake has to be on the page before anyone scrolls. */
  ok('the page carries the gravity stacking warning', /does nothing at all/i.test(html));
  ok('saying it is about a WEAKER one under a stronger one', /weaker/i.test(html));
  ok('and names the price of getting it wrong', /750 Bits/.test(html));
  ok('it says effects hit the whole lobby', /every player in the lobby/i.test(html));
  ok('and the script emphasises each warning sentence', /ms-warn-strong/.test(js));

  /* The soft gate explained where a viewer can read it. */
  ok('the page says they stay buyable in every category', /buyable in every category/i.test(html));
  ok('and points at the chat command', /!powerups/.test(html));

  /* Rendered by replacing children, never appending — the page polls. */
  ok('the list is rebuilt, not appended to', /list\.textContent = ''/.test(js));
  ok('and the poll stops while the tab is hidden', /document\.hidden/.test(js));
  /* textContent throughout: the effects come from the server, and innerHTML
     would make the list a markup channel. */
  ok('nothing is injected as HTML', !/innerHTML/.test(js));

  /* Every onclick names a function one of this page's scripts defines. */
  const loaded = [...html.matchAll(/src="(\/js\/[^"]+)"/g)].map(m => read(m[1].slice(1))).join('\n');
  for (const fn of [...new Set([...html.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]))]) {
    ok(`${fn}() is defined by a script this page loads`, new RegExp('(?:async )?function ' + fn + '\\s*\\(').test(loaded));
  }
}

/* ── House style ─────────────────────────────────────────────────────
   The bans in CLAUDE.md, checked rather than trusted. */
{
  const raw = read('css/pages/moonsweepers.css');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, ' ');

  check('no box-shadow', (css.match(/box-shadow/g) || []).length, 0);
  check('no backdrop-filter', (css.match(/backdrop-filter/g) || []).length, 0);
  check('no blur()', (css.match(/blur\(/g) || []).length, 0);
  /* The accent-rail AI-tell. Full borders and top/bottom only. */
  check('no side-edge borders', (css.match(/border-(left|right)\s*:/g) || []).length, 0);
  check('no corner-bracket accents', (css.match(/corner-accent/g) || []).length, 0);

  /* Both themes flip off the tokens, which only works if nothing is a
     literal colour. #fff is allowed on a red FILL; this page has none. */
  const hexes = [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}/g)].map(m => m[0].toLowerCase()))];
  check('every colour comes from a token', hexes, []);
  ok('and surfaces use the surface tokens', /var\(--gray-mid\)/.test(css));

  /* Grenze at the 14px base; GodOfWar for the headings. */
  const small = [...css.matchAll(/font-size:\s*(\d+)px/g)].map(m => Number(m[1])).filter(n => n < 13);
  check('nothing is unreadably small', small, []);
  ok('headings use the display face', /font-family:\s*var\(--font-display\)/.test(css));
  ok('body text uses the UI face', /font-family:\s*var\(--font-ui\)/.test(css));
  ok('and no generic UI sans is named', !/Inter|Roboto|Helvetica|Arial/.test(raw));

  /* The one sanctioned non-palette colour is rarity/medal/tier, and this
     page has no rarities — so purple must not appear as a UI accent. */
  check('no purple as a UI accent', (css.match(/--purple|--rarity-/g) || []).length, 0);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[moon-sweepers-powerups] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[moon-sweepers-powerups] ${passed} assertions passed.`);
console.log('');
