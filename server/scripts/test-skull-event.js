#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SKULL CLICKER — the site-wide frenzy event

     node server/scripts/test-skull-event.js

   A hype train (or a moderator) fires a cursed-skull frenzy that every
   Skull Clicker player feels. These tests cover the read the game polls, the
   moderator-gated manual trigger, the server-side cap and expiry, and the
   wiring that lets the hype-train webhook set it without being able to break
   itself.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet, onRequestPost, setSkullEvent } from '../../functions/api/skull-clicker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
  };
}
const BC = '555';
const cookie = (id) => id ? { Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) } : {};
const GET = (e, qs, h) => onRequestGet({ env: e, request: new Request('https://x/api/skull-clicker?' + (qs || ''), { headers: { ...h } }) });
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/skull-clicker', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });
const envWith = (seed) => ({ MARKETPLACE: fakeKV(seed), TWITCH_BROADCASTER_ID: BC });

/* ══ No event ══════════════════════════════════════════════════════════ */
{
  const e = envWith();
  check('no event set reads as null', (await (await GET(e, 'event=1')).json()).event, null);
}

/* ══ Manual trigger — moderator only ═══════════════════════════════════ */
{
  const e = envWith();
  check('an anonymous trigger is refused', (await POST(e, { action: 'trigger-event', minutes: 5 })).status, 403);
  check('a random user is refused', (await POST(e, { action: 'trigger-event', minutes: 5 }, cookie('999'))).status, 403);
  ok('and nothing was written', !e.MARKETPLACE.read('sc_event'));

  const res = await (await POST(e, { action: 'trigger-event', minutes: 5 }, cookie(BC))).json();
  check('the broadcaster can start a frenzy', res.success, true);
  ok('with an expiry in the future', res.event.until > Date.now());

  const live = await (await GET(e, 'event=1')).json();
  check('and the game now reads the frenzy', live.event.type, 'frenzy');
}

/* ══ Duration is capped, and an elapsed event reads as gone ════════════ */
{
  const e = envWith();
  await POST(e, { action: 'trigger-event', minutes: 999 }, cookie(BC));
  const cap = e.MARKETPLACE.read('sc_event');
  ok('a runaway duration is capped at 30 min', cap.until - Date.now() <= 30 * 60 * 1000 + 1000);

  /* An event whose time has passed is not served. */
  await e.MARKETPLACE.put('sc_event', JSON.stringify({ type: 'frenzy', until: Date.now() - 1000 }));
  check('an elapsed event reads as null', (await (await GET(e, 'event=1')).json()).event, null);
}

/* ══ The shared setter (what the hype train calls) ═════════════════════ */
{
  const e = envWith();
  const ev = await setSkullEvent(e, 'frenzy', 10 * 60 * 1000);
  ok('setSkullEvent returns a future expiry', ev.until > Date.now());
  check('and it is live to the game', (await (await GET(e, 'event=1')).json()).event.type, 'frenzy');
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('sc_event is a registered singleton', /sc_event:\s*\{ table: 'singletons'/.test(reg));

  const hype = fs.readFileSync(path.join(REPO, 'functions/api/hype-train.js'), 'utf8');
  ok('the hype train starts a frenzy, best-effort',
     /setSkullEvent/.test(hype) && /try \{[\s\S]*setSkullEvent[\s\S]*catch/.test(hype));

  /* A MODERATOR CAN REACH IT. trigger-event is gated, clamped and tested on
     the server, and its own comment says it is driven "from Bot Control" --
     which had no button, so for every frenzy anyone wanted to start on
     purpose, curl was the only way. Everything else that starts one is
     automatic (hype train, raid-boss kill, finished Bone Tithe). */
  const botHtml = fs.readFileSync(path.join(REPO, 'bot-control.html'), 'utf8');
  ok('Bot Control has a frenzy card', /id="skullFrenzySection"/.test(botHtml));
  ok('with a button and a duration', /id="botFrenzyBtn"/.test(botHtml) &&
     /id="botFrenzyMins"/.test(botHtml));

  /* Only durations the server will honour: it clamps to 1-30, so an option
     outside that silently becomes something else and the toast would lie
     about how long the frenzy runs. */
  const sel = (botHtml.match(/id="botFrenzyMins"[\s\S]*?<\/select>/) || [''])[0];
  const mins = [...sel.matchAll(/value="(\d+)"/g)].map(m => Number(m[1]));
  ok('the duration choices are a real list', mins.length >= 2);
  check('and every one is inside the server clamp',
    mins.filter(v => v < 1 || v > 30), []);

  const botJs = fs.readFileSync(path.join(REPO, 'js/pages/bot-control.js'), 'utf8');
  ok('the button posts trigger-event to the game route',
     /botFrenzyBtn/.test(botJs) && /'trigger-event'/.test(botJs) &&
     /\/api\/skull-clicker/.test(botJs));
  ok('and reports a refusal rather than claiming success',
     /data\.error \|\| 'Could not start the frenzy\.'/.test(botJs));

  const game = fs.readFileSync(path.join(REPO, 'games/skull-clicker/index.html'), 'utf8');
  ok('the game polls the event', /skull-clicker\?event=1/.test(game) && /function pollSkullEvent/.test(game));
  ok('and a frenzy speeds up cursed skulls', /__streamFrenzy/.test(game) && /function cursedFreqMult/.test(game));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[skull-event] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[skull-event] ${passed} assertions passed.`);
console.log('');
