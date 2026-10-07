#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MILESTONE FOLLOW / CHEER ALERTS — test suite

     node server/scripts/test-milestone-alerts.js

   Phase 6a adds the two missing Twitch-native alerts — channel.follow and
   channel.cheer — to the milestones webhook so they run through OUR overlay
   queue. Pinned here: each pushes the right overlay event, records to the
   activity feed, a repeat follow inside the window is deduped, and a
   toggled-off type is dropped before it is ever enqueued.

   Driven end-to-end through milestones.onRequestPost with signed requests
   (verification exercised too); the fake KV is then inspected.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { signEventSub } from '../lib/eventsub.js';
import * as milestones from '../../functions/api/milestones.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const SECRET = 'a-test-eventsub-secret';

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  return {
    TWITCH_EVENTSUB_SECRET: SECRET,
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
    },
    _store: store,
  };
}

async function notify(env, subType, event) {
  const raw = JSON.stringify({ subscription: { type: subType }, event });
  const messageId = 'mid-' + subType + '-' + Math.random().toString(36).slice(2);
  const ts = new Date().toISOString();
  const request = new Request('https://phantomace.tv/api/milestones', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-id': messageId,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': await signEventSub(SECRET, messageId, ts, raw),
    },
    body: raw,
  });
  return milestones.onRequestPost({ env, request });
}

const overlayEvents = (env, type) => {
  const rec = env._store.get('overlay_events');
  const events = rec ? JSON.parse(rec).events : [];
  return type ? events.filter(e => e.type === type) : events;
};
const activityRows = (env, category) => {
  const rec = env._store.get('activity_feed');
  const rows = rec ? JSON.parse(rec) : [];
  return category ? rows.filter(r => r.category === category) : rows;
};

/* ── Follow: pushes an alert + records activity ───────────────────────── */
{
  const env = makeEnv();
  await notify(env, 'channel.follow', { user_id: '1', user_name: 'alice', user_login: 'alice' });
  const ev = overlayEvents(env, 'follow');
  check('a follow pushes one overlay alert', ev.length, 1);
  check('carrying the follower name', ev[0].user, 'alice');
  check('and records one activity row', activityRows(env, 'follow').length, 1);
  ok('the activity summary names the follower', /alice followed/.test(activityRows(env, 'follow')[0].summary));
}

/* ── Follow dedupe: a repeat from the same user is dropped ─────────────── */
{
  const env = makeEnv();
  await notify(env, 'channel.follow', { user_id: '7', user_name: 'bob' });
  await notify(env, 'channel.follow', { user_id: '7', user_name: 'bob' });   // duplicate within window
  check('a repeat follow does not alert twice', overlayEvents(env, 'follow').length, 1);
  check('nor record twice', activityRows(env, 'follow').length, 1);

  await notify(env, 'channel.follow', { user_id: '8', user_name: 'carol' });  // different user
  check('a different follower still alerts', overlayEvents(env, 'follow').length, 2);
}

/* ── Cheer: pushes an alert with bits + records activity ───────────────── */
{
  const env = makeEnv();
  await notify(env, 'channel.cheer', { user_id: '2', user_name: 'dave', bits: 500, message: 'take my bits' });
  const ev = overlayEvents(env, 'cheer');
  check('a cheer pushes one overlay alert', ev.length, 1);
  check('carrying the cheerer name', ev[0].user, 'dave');
  check('the bits amount', ev[0].bits, 500);
  check('and the message', ev[0].message, 'take my bits');
  ok('the activity row notes the bits', /dave cheered 500 bits/.test(activityRows(env, 'cheer')[0].summary));

  /* Anonymous cheer keeps its bits but hides the name. */
  await notify(env, 'channel.cheer', { is_anonymous: true, bits: 100 });
  const anon = overlayEvents(env, 'cheer')[1];
  check('an anonymous cheer is named generically', anon.user, 'An anonymous cheerer');
  check('with its bits', anon.bits, 100);
}

/* ── The per-alert toggle drops a disabled type: no overlay AND no feed ── */
{
  const env = makeEnv();
  env._store.set('alert_toggles', JSON.stringify({ follow: false }));   // follow OFF, cheer default ON

  await notify(env, 'channel.follow', { user_id: '9', user_name: 'erin' });
  check('a disabled follow is never enqueued', overlayEvents(env, 'follow').length, 0);
  check('and records no feed row', activityRows(env, 'follow').length, 0);

  await notify(env, 'channel.cheer', { user_id: '10', user_name: 'frank', bits: 200 });
  check('an enabled cheer still fires', overlayEvents(env, 'cheer').length, 1);
  check('and still records to the feed', activityRows(env, 'cheer').length, 1);
}

/* ── A disabled sub: neither overlay alert nor feed entry ─────────────── */
{
  const env = makeEnv();
  env._store.set('alert_toggles', JSON.stringify({ sub: false }));
  env._store.set('milestone_drops', JSON.stringify({ enabled: true }));   // drops on, but the type is off
  await notify(env, 'channel.subscribe', { user_id: '40', user_name: 'zed', tier: '1000', is_gift: false });
  check('a disabled sub shows no overlay alert', overlayEvents(env, 'sub').length, 0);
  check('and records no feed row', activityRows(env, 'sub').length, 0);
}

/* ── sub/gift/raid alerts are DECOUPLED from the milestone-DROPS toggle ── */
{
  const env = makeEnv();   // no milestone_drops → drops default OFF
  await notify(env, 'channel.subscribe', { user_id: '3', user_name: 'grace', tier: '1000', is_gift: false });
  check('a sub alerts with drops off', overlayEvents(env, 'sub').length, 1);
  check('and records to the feed', activityRows(env, 'sub').length, 1);

  await notify(env, 'channel.subscription.gift', { user_id: '31', user_name: 'gigi', total: 5 });
  check('a gift alerts with drops off', overlayEvents(env, 'giftsub').length, 1);
  check('and records to the feed', activityRows(env, 'giftsub').length, 1);

  /* A small raid (below the drop threshold) still ALERTS — the threshold only
     gates the code drop now. */
  await notify(env, 'channel.raid', { from_broadcaster_user_name: 'raidLeader', viewers: 2 });
  check('a below-threshold raid still alerts with drops off', overlayEvents(env, 'raid').length, 1);
  check('and records to the feed', activityRows(env, 'raid').length, 1);
}

/* ── follow/cheer fire even with milestone DROPS off ──────────────────── */
{
  const env = makeEnv();
  await notify(env, 'channel.follow', { user_id: '4', user_name: 'heidi' });
  check('a follow fires with milestone drops off', overlayEvents(env, 'follow').length, 1);
  await notify(env, 'channel.cheer', { user_id: '5', user_name: 'ivan', bits: 300 });
  check('a cheer fires with milestone drops off', overlayEvents(env, 'cheer').length, 1);
}

/* ── THE CONTROL THAT DID NOT EXIST ─────────────────────────────────────
   Automatic drops have always been built, wired to the sub/gift/raid events,
   and OFF by default — with nothing in any panel that could read or change
   them. The feature was switchable only by a hand-made API call, which in
   practice means it was never switchable at all.

   The config lands on /api/bot/dashboard rather than a request of its own,
   because Bot Control already polls that every 20 seconds. Which makes WHERE
   it is read the thing worth guarding: a refusal must carry no config. */
{
  const env = makeEnv();
  const { getMilestoneConfig, setMilestoneConfig } = milestones;

  const d = await getMilestoneConfig(env);
  check('it is off until somebody turns it on', d.enabled, false);
  check('with a sane sub rarity', d.subRarity, 'common');
  check('gifts worth more', d.giftRarity, 'uncommon');
  check('and a raid floor', d.raidMinViewers, 5);

  const on = await setMilestoneConfig(env, { enabled: true });
  check('it can be turned on', on.config.enabled, true);
  check('without disturbing the rarities', on.config.giftRarity, 'uncommon');

  const r = await setMilestoneConfig(env, { subRarity: 'rare', raidMinViewers: 20 });
  check('rarities can be changed', r.config.subRarity, 'rare');
  check('and the raid floor', r.config.raidMinViewers, 20);
  check('and it stays on through an edit', r.config.enabled, true);

  check('an unknown rarity is refused', !!(await setMilestoneConfig(env, { subRarity: 'legendary' })).error, true);
  check('and a raid floor below one', !!(await setMilestoneConfig(env, { raidMinViewers: 0 })).error, true);
  const after = await getMilestoneConfig(env);
  check('a refused edit changes nothing', [after.subRarity, after.raidMinViewers], ['rare', 20]);
}

{
  /* The config is read AFTER the moderator gate and returned only on success.
     Read before it, a refusal would hand out channel configuration. */
  const dash = fs.readFileSync(path.join(REPO, 'functions/api/bot/dashboard.js'), 'utf8');
  const gate = dash.indexOf('if (!(await isModerator(env, session)))');
  const refusal = dash.indexOf('}, 403);', gate);
  const read = dash.indexOf('getMilestoneConfig', gate);
  ok('the dashboard hands the panel the live config', read !== -1);
  ok('read only after the moderator gate has passed', read > refusal);
  ok('and the refusal carries no config',
     !/return json\(\{[^}]*milestoneDrops[^}]*\}, 403\)/.test(dash));

  const html = fs.readFileSync(path.join(REPO, 'bot-control.html'), 'utf8');
  ok('Bot Control has the card', /Automatic Drops/.test(html));
  ok('with a toggle', /id="msToggle"/.test(html));
  ok('a rarity per event', /id="msSubRarity"/.test(html) && /id="msGiftRarity"/.test(html) && /id="msRaidRarity"/.test(html));
  ok('and the raid floor', /id="msRaidMin"/.test(html));

  const js = fs.readFileSync(path.join(REPO, 'js/pages/bot-control.js'), 'utf8');
  ok('wired to the config action', /action: 'milestone-config'/.test(js));
  ok('rendered from the real stored state, not the defaults', /renderMilestoneDrops\(data\.milestoneDrops\)/.test(js));
  /* Flipping against last-known state, so a stale panel cannot turn it ON
     when the button it is showing says "Turn Off". */
  ok('and the toggle flips against what it was last told',
     /enabled: !\(msConfig && msConfig\.enabled\)/.test(js));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[milestone-alerts] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[milestone-alerts] ${passed} assertions passed.`);
console.log('');
