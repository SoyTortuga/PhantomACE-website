#!/usr/bin/env node
/* ══════════════════════════════════════════════
   THE COMMANDS THAT REPLY ACTUALLY REPLY

     node server/scripts/test-chat-commands-reply.js

   RUNS OFFLINE. Drives the real webhook with a signed channel.chat.message
   and stubs Helix, so it asserts the whole path: parse → dispatch → outbox →
   deferred flush → POST /helix/chat/messages.

   WHY THIS EXISTS. !commands shipped silent twice and neither failure left a
   trace:

     1. Its cooldown used an unregistered key prefix, so every read threw and
        the handler's own try/catch swallowed it.
     2. It referenced sendChatMessage, which is NOT a module-level import in
        commands.js — every other caller imports it first. That is a
        ReferenceError raised when the OUTBOX FLUSHES, which happens after
        the try/catch has already returned. Nothing replied and nothing
        logged.

   Both were invisible to every test that existed, because the suites for
   those features tested the helper functions directly and never once drove a
   message through the dispatch. A unit test of helpLine() passes happily
   while the command it serves is dead.

   So this is deliberately end-to-end and deliberately about the PLUMBING, not
   the wording: does a message typed in chat cause a message sent to chat.
   ══════════════════════════════════════════════ */

import { signEventSub } from '../lib/eventsub.js';
import * as commands from '../../functions/api/bot/commands.js';
import { _resetCache, HELP_KEYS } from '../../functions/api/bot/chat-help.js';

const SECRET = 'test-eventsub-secret';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* The stub consults the REAL registry rather than a hand-kept list of keys.
   An unregistered key must throw here exactly as it does in production — that
   is failure #1 above — and a local copy of the mappings would drift from
   registry.js silently, which is the same class of bug one level up. */
import { resolveKey } from '../lib/registry.js';

let sent = [];

function makeEnv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  const guard = (k, op) => {
    if (!resolveKey(k)) throw new Error(`${op}() key "${k}" has no table mapping`);
  };
  return {
    TWITCH_EVENTSUB_SECRET: SECRET,
    TWITCH_BROADCASTER_ID: '900',
    TWITCH_CLIENT_ID: 'cid',
    MARKETPLACE: {
      async get(k, t) { guard(k, 'get'); if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { guard(k, 'put'); store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { guard(k, 'delete'); store.delete(k); },
      async mutate(k, fn) {
        guard(k, 'mutate');
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next !== undefined) store.set(k, JSON.stringify(next));
        return next;
      },
      async listValues() { return []; },
      async claim(k) { guard(k, 'claim'); if (!store.has(k)) return null; const v = store.get(k); store.delete(k); return JSON.parse(v); },
    },
    _store: store,
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/helix/chat/messages')) {
    sent.push(JSON.parse(opts.body).message);
    return new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 });
  }
  if (u.includes('oauth2/token')) {
    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

/** Type a message in chat as a plain viewer, and flush the deferred sends. */
async function say(env, text, { userId = '42', name = 'Viewer' } = {}) {
  sent = [];
  /* The help line caches in-process for a few seconds so a raid does not cost
     a dozen reads per asker. A suite runs well inside that window, so without
     this every block after the first would assert against the first block's
     answer. */
  _resetCache();
  const body = JSON.stringify({
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
      'twitch-eventsub-message-signature': await signEventSub(SECRET, mid, ts, body),
    },
    body,
  });

  /* The handler defers its sends to waitUntil so Twitch gets its 200 first,
     which means a test that does not await them sees an empty outbox and
     passes regardless. Collect and await. */
  const deferred = [];
  const res = await commands.onRequestPost({
    env, request, waitUntil: (p) => deferred.push(p),
  });
  await Promise.all(deferred);
  return { status: res.status, sent: [...sent] };
}

const BOT = {
  twitch_bot_token: { access_token: 'x', expiresAt: Date.now() + 3600e3 },
  twitch_bot_user_id: '555',
};

/* ── !commands replies, with nothing running ─────────────────────────────── */
{
  const env = makeEnv({ ...BOT });
  const r = await say(env, '!commands');
  check('Twitch gets its 200', r.status, 200);
  check('exactly one message goes out', r.sent.length, 1);
  ok('saying nothing is running', /Nothing running/.test(r.sent[0]));
  ok('and pointing at the one that always works', /!entries/.test(r.sent[0]));
}

/* ── !help is the same command ───────────────────────────────────────────── */
{
  const env = makeEnv({ ...BOT });
  check('!help replies too', (await say(env, '!help')).sent.length, 1);
}

/* ── It names what is actually playable ──────────────────────────────────── */
{
  const env = makeEnv({
    ...BOT,
    mm_chat: { status: 'live' },
    sc_raid: { status: 'active' },
    mana_clash_vs_chat: { status: 'collecting', collectUntil: Date.now() + 60000 },
  });
  const r = await say(env, '!commands');
  const line = r.sent[0] || '';
  ok('Memory Match is offered', /!flip/.test(line));
  ok('the raid boss is offered', /!hit/.test(line));
  ok('Streamer vs Chat is offered', /!clash/.test(line));
  ok('and a mode that is NOT running is not', !/!catch/.test(line));
}

/* ── The cooldown is per asker, and silences only them ───────────────────── */
{
  const env = makeEnv({ ...BOT });
  check('the first ask answers', (await say(env, '!commands', { userId: '1' })).sent.length, 1);
  check('an immediate second from the same person does not', (await say(env, '!commands', { userId: '1' })).sent.length, 0);
  check('but somebody else still gets an answer', (await say(env, '!commands', { userId: '2' })).sent.length, 1);
}

/* ── THE CONTROL: !entries still replies ─────────────────────────────────
   If this breaks, the failure is the shared path, not the command above. */
{
  const env = makeEnv({ ...BOT });
  const r = await say(env, '!entries');
  check('!entries replies', r.sent.length, 1);
  ok('with their entry count', /entries in this month/.test(r.sent[0]));
}

/* ── A closed window is not offered ──────────────────────────────────────
   The record sits at 'collecting' until something advances it, so the phase
   alone is not enough — the vote is shut. */
{
  const env = makeEnv({
    ...BOT,
    mana_clash_vs_chat: { status: 'collecting', collectUntil: Date.now() - 1000 },
  });
  ok('an expired clash is not offered', !/!clash/.test((await say(env, '!commands')).sent[0] || ''));
}

/* ── EVERY KEY THE HELP LINE READS IS A REAL, MAPPED KEY ─────────────────
   The reads are wrapped in a try/catch returning null, so a misspelled or
   unregistered key does not fail — the mode silently never gets offered.
   !clash was dead this way: the line read 'mana_clash_chat' while the game
   stores 'mana_clash_vs_chat'. Assert against the registry AND against the
   owning module's own exported constant, which is what actually drifted. */
{
  for (const k of HELP_KEYS) ok(`${k} is mapped in registry.js`, !!resolveKey(k));

  const owners = [
    ['../../functions/api/mana-clash-chat.js', 'CLASH_KEY'],
    ['../../functions/api/dino-safari.js', 'SAFARI_KEY'],
    ['../../functions/api/pham-wind-night.js', 'WIND_NIGHT_KEY'],
  ];
  for (const [mod, name] of owners) {
    const value = (await import(mod))[name];
    ok(`the help line reads the real ${name}`, HELP_KEYS.includes(value));
  }
}

/* ── A SILENT COMMAND STAYS SILENT ───────────────────────────────────────
   Typed by hundreds at once; a reply each would bury the channel. */
{
  const env = makeEnv({ ...BOT, dino_safari: { status: 'active', spawn: null } });
  check('!track says nothing', (await say(env, '!track')).sent.length, 0);
  check('!hit says nothing', (await say(env, '!hit')).sent.length, 0);
}

/* ── An unknown command says nothing, and does not throw ─────────────────── */
{
  const env = makeEnv({ ...BOT });
  const r = await say(env, '!notacommand');
  check('still a 200', r.status, 200);
  check('and no reply', r.sent.length, 0);
}

/* ── A viewer cannot reach a moderator command ───────────────────────────── */
{
  const env = makeEnv({ ...BOT });
  const r = await say(env, '!announce hello');
  check('a plain viewer gets nothing from !announce', r.sent.length, 0);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[chat-commands-reply] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[chat-commands-reply] ${passed} assertions passed.`);
console.log('');
