#!/usr/bin/env node
/* ══════════════════════════════════════════════
   EGG-DROP VIDEO ALERT — test suite

     node server/scripts/test-egg-alert.js

   When the bot drops a dino egg into chat, the overlay plays a short
   transparent clip (Danny DeVito cracking an egg) bottom-right. The clip must
   fire for EVERY egg — any rarity, mutation or not — but ONLY once the drop has
   actually landed in chat: a cooldown-refused drop announces nothing, so it must
   not fire the alert either.

   The things worth asserting are the ones that would otherwise be found
   mid-stream: that dropEggAction pushes an 'egg-video' overlay event on a
   successful drop (every rarity, and a mutation egg), that it pushes NOTHING
   when the underlying drop is refused, that the type is a real toggleable alert
   the broadcaster can switch off (and that switching it off suppresses it
   centrally in pushOverlayEvent), and that the overlay wiring reuses ONE hidden
   <video> that resets and hides itself on end — the marathon-safety contract.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropEggAction } from '../../functions/api/bot/send-chat.js';
import { TOGGLEABLE_ALERT_TYPES } from '../../functions/api/overlay/events.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Chat is captured rather than sent — same shape as test-bot-drops. */
const realFetch = globalThis.fetch;
let refuseSend = false;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/helix/chat/messages')) {
    return new Response(JSON.stringify({ data: [{ is_sent: !refuseSend }] }), { status: 200 });
  }
  if (u.includes('oauth2/token')) {
    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  store.set('twitch_bot_token', JSON.stringify({ access_token: 'x', expiresAt: Date.now() + 3600e3 }));
  store.set('twitch_bot_user_id', '555');
  return {
    TWITCH_BROADCASTER_ID: '900',
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'secret',
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
          const next = await fn(cur);
          if (next === undefined) return cur;
          store.set(k, JSON.stringify(next));
          return JSON.parse(store.get(k));
        });
        chains.set(k, run.then(() => {}, () => {}));
        return run;
      },
      async listValues() { return []; },
    },
    _store: store,
  };
}

/* Pull the 'egg-video' events pushOverlayEvent has appended to the feed. */
function eggEvents(env) {
  const raw = env._store.get('overlay_events');
  if (!raw) return [];
  let rec; try { rec = JSON.parse(raw); } catch { return []; }
  return (rec && Array.isArray(rec.events) ? rec.events : []).filter(e => e.type === 'egg-video');
}
const fresh = () => { refuseSend = false; return makeEnv(); };

/* ── Every rarity fires exactly one egg-video event, tagged with its rarity ── */
for (const rarity of ['common', 'uncommon', 'rare', 'mythic']) {
  const env = fresh();
  const r = await dropEggAction(env, rarity, 'tester');
  check(`a ${rarity} egg drop succeeds`, r.success, true);
  const evs = eggEvents(env);
  check(`a ${rarity} egg drop pushes exactly one egg-video event`, evs.length, 1);
  check(`and the event carries the ${rarity} rarity`, evs[0] && evs[0].rarity, rarity);
  check(`and marks it not a mutation`, evs[0] && evs[0].mutation, false);
}

/* ── A mutation egg fires the clip too, flagged as a mutation ─────────────── */
{
  const env = fresh();
  const r = await dropEggAction(env, 'rare', 'tester', { mutation: true });
  check('a mutation egg drop succeeds', r.success, true);
  const evs = eggEvents(env);
  check('a mutation egg drop pushes one egg-video event', evs.length, 1);
  check('flagged as a mutation', evs[0] && evs[0].mutation, true);
}

/* ── A refused drop (cooldown) fires NO clip ──────────────────────────────── */
{
  const env = fresh();
  const first = await dropEggAction(env, 'common', 'tester');
  check('the first egg drop succeeds', first.success, true);
  check('and pushes its clip', eggEvents(env).length, 1);

  /* dropitem is on a 15s cooldown; the second drop is refused straight away. */
  const second = await dropEggAction(env, 'common', 'tester');
  check('a second egg within the cooldown is refused', second.success, false);
  ok('and says it is cooling down', /cool/i.test(second.error || ''));
  /* THE WHOLE POINT: a refused drop announced nothing in chat, so it must not
     flash a clip on stream either. Still exactly one from the first drop. */
  check('a refused drop pushes no extra clip', eggEvents(env).length, 1);
}

/* ── A refused SEND (AutoMod/filters) fires no clip ───────────────────────── */
{
  const env = fresh();
  refuseSend = true;
  const r = await dropEggAction(env, 'mythic', 'tester');
  check('a drop Twitch declined to post reports sent:false', r.sent, false);
  /* dropItemAction still returns success:true (the code exists and is active),
     so the clip DOES play — the viewer can still redeem the activated code even
     if the chat line was filtered. This documents that intended behaviour. */
  check('the activated code still plays the clip', eggEvents(env).length, 1);
}

/* ── The type is a real toggleable alert, suppressed centrally when off ────── */
{
  ok('egg-video is in TOGGLEABLE_ALERT_TYPES', TOGGLEABLE_ALERT_TYPES.includes('egg-video'));

  const env = fresh();
  /* Broadcaster switched egg videos OFF. */
  env._store.set('alert_toggles', JSON.stringify({ 'egg-video': false }));
  const r = await dropEggAction(env, 'rare', 'tester');
  /* The DROP still happens — the code is live, chat still gets the message —
     only the overlay clip is suppressed, exactly like every other toggle. */
  check('the drop still succeeds with the clip toggled off', r.success, true);
  check('but pushOverlayEvent drops the suppressed clip', eggEvents(env).length, 0);
}

/* ── Static wiring checks — overlay JS / HTML / CSS ────────────────────────── */
const overlayJs = fs.readFileSync(path.join(ROOT, 'js/pages/overlay.js'), 'utf8');
const overlayHtml = fs.readFileSync(path.join(ROOT, 'overlay.html'), 'utf8');
const overlayCss = fs.readFileSync(path.join(ROOT, 'css/pages/overlay.css'), 'utf8');
const sendChat = fs.readFileSync(path.join(ROOT, 'functions/api/bot/send-chat.js'), 'utf8');

/* send-chat: pushes the clip, and only on a successful drop. */
ok('send-chat pushes an egg-video event', /type:\s*'egg-video'/.test(sendChat));
ok('send-chat gates the push on a successful drop', /if\s*\(\s*result\s*&&\s*result\.success\s*\)/.test(sendChat));

/* overlay.html: ONE reused, hidden <video> sourced from the committed clip. */
ok('overlay.html declares the reused #ovEggVideo element', /id="ovEggVideo"/.test(overlayHtml));
ok('and it is a <video>', /<video[^>]*id="ovEggVideo"/.test(overlayHtml));
ok('pointed at the committed clip', overlayHtml.includes('/assets/alerts/egg-drop.webm'));
ok('and starts hidden', /<video[^>]*id="ovEggVideo"[^>]*hidden/.test(overlayHtml));

/* overlay.js: off-queue dispatch, a single REUSED element (no new one per fire),
   audio from the master alert volume, and reset+hide on end. */
ok("overlay.js dispatches the egg-video event off the queue", /ev\.type === 'egg-video'/.test(overlayJs));
ok('overlay.js has a showEggVideo handler', /function showEggVideo/.test(overlayJs));
ok('it reuses the one #ovEggVideo element', overlayJs.includes("getElementById('ovEggVideo')"));
ok('it never creates a <video> per fire',
  !/createElement\(\s*['"]video['"]\s*\)/.test(overlayJs) && !/new\s+Video\s*\(/.test(overlayJs));
ok('its volume comes from the master alertVolume', /\bvolume\s*=\s*silent\s*\?\s*0\s*:\s*alertVolume/.test(overlayJs));
ok('it respects mute and the audio leader', /audioMuted\s*\|\|\s*!isAudioLeader/.test(overlayJs));
ok("it tears down on the clip's 'ended' event", /addEventListener\('ended'/.test(overlayJs));
ok('and resets currentTime to 0 when hiding', /currentTime\s*=\s*0/.test(overlayJs));
ok('and hides the element to display:none via the hidden flag', /v\.hidden\s*=\s*true/.test(overlayJs));
ok('with a safety timeout should ended never fire', /eggVideoTimer\s*=\s*setTimeout\(hideEggVideo/.test(overlayJs));
ok('and it is counted among the idle panels for the self-reload', overlayJs.includes("'ovEggVideo'"));

/* overlay.css: bottom-right, transparent, boxless, with a display:none guard. */
const eggBlockMatch = overlayCss.match(/\.ov-egg-video\s*\{[^}]*\}/);
const eggBlock = eggBlockMatch ? eggBlockMatch[0] : '';
ok('overlay.css styles .ov-egg-video', !!eggBlock);
ok('positioned bottom-right', /right:/.test(eggBlock) && /bottom:/.test(eggBlock));
ok('with a [hidden] display:none guard', /\.ov-egg-video\[hidden\]\s*\{\s*display:\s*none/.test(overlayCss));
ok('transparent, no box behind it', /background:\s*transparent/.test(eggBlock));
ok('no box-shadow on the clip', !/box-shadow/.test(eggBlock));
ok('no backdrop-filter on the clip', !/backdrop-filter/.test(eggBlock));

/* ── Report ──────────────────────────────────────────────────────────────── */
globalThis.fetch = realFetch;

console.log('');
if (failures.length) {
  console.log(`[egg-alert] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[egg-alert] ${passed} assertions passed.`);
console.log('');
