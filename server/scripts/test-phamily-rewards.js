#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PHAMILY TIME REWARDS — test suite

     node server/scripts/test-phamily-rewards.js

   Two jobs.

   FIRST, the drift guard. functions/api/phamily-rewards.js is a port of the
   three definition functions in js/pages/phamily-time.js, and a port that
   quietly falls behind its original is worse than no port at all — the page
   would draw one track while the server granted another. This file evaluates
   the client's own copies straight out of that file and asserts the two
   agree, reward for reward.

   SECOND, the refusals. The server used to take rewardType, rewardRarity
   and rewardName from the request body and hand them to grantReward, which
   uses all three to decide what a claim is worth. Only the key and the level
   were checked. Anyone past level 2 could therefore claim any reward at
   mythic, turn a giveaway into a banner, or name one "Guaranteed Mutant Egg"
   and get exactly that.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from '../../functions/api/phamily-rewards.js';

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

/* ── The drift guard ─────────────────────────────────────────────────────
   The client's definitions are lifted out of the page and run here. They
   close over REWARD_ICONS and MILESTONE_INTERVAL and nothing else, so they
   evaluate cleanly outside a browser. */
{
  const src = fs.readFileSync(path.join(REPO, 'js/pages/phamily-time.js'), 'utf8');

  const grab = (re, what) => {
    const m = src.match(re);
    if (!m) throw new Error(`could not find ${what} in js/pages/phamily-time.js`);
    return m[0];
  };

  const pieces = [
    grab(/const REWARD_ICONS = \{[\s\S]*?\n {2}\};/, 'REWARD_ICONS'),
    grab(/const MILESTONE_INTERVAL = [^;]+;/, 'MILESTONE_INTERVAL'),
    grab(/ {2}function defineFollowerRewards\(\) \{[\s\S]*?\n {2}\}/, 'defineFollowerRewards'),
    grab(/ {2}function definePhamilyRewards\(\) \{[\s\S]*?\n {2}\}/, 'definePhamilyRewards'),
    grab(/ {2}function defineMilestones\(\) \{[\s\S]*?\n {2}\}/, 'defineMilestones'),
  ];

  const clientSide = new Function(
    pieces.join('\n') +
    '\nreturn { follower: defineFollowerRewards(), phamily: definePhamilyRewards(), milestones: defineMilestones() };'
  )();

  /* Compared entry by entry, not array against array. Diffing two
     twenty-five element lists as one blob prints both in full and leaves you
     to spot the changed word — which is the opposite of what a drift guard
     is for. */
  const compare = (what, page, server) => {
    check(`${what}: same number of entries`, page.length, server.length);
    const n = Math.min(page.length, server.length);
    const differing = [];
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(page[i]) !== JSON.stringify(server[i])) {
        differing.push({ index: i, page: page[i], server: server[i] });
      }
    }
    check(`${what}: every entry matches the page`, differing, []);
  };

  compare('follower track', clientSide.follower, R.FOLLOWER_REWARDS);
  compare('phamily track', clientSide.phamily, R.PHAMILY_REWARDS);
  compare('milestones', clientSide.milestones, R.MILESTONES);
}

/* ── The table itself ────────────────────────────────────────────────── */
{
  const all = [...R.FOLLOWER_REWARDS, ...R.PHAMILY_REWARDS];
  check('every reward has a level', all.filter(r => !Number.isInteger(r.level)).length, 0);
  check('every reward has a type', all.filter(r => !r.type).length, 0);
  check('every reward has a rarity', all.filter(r => !r.rarity).length, 0);
  check('rarities are all known',
    all.filter(r => !['common', 'uncommon', 'rare', 'mythic'].includes(r.rarity)).map(r => r.rarity), []);

  /* Keys are the identity of a reward, so two rewards sharing one would make
     the second unclaimable — the first claim marks the key done. */
  for (const [track, list] of [['follower', R.FOLLOWER_REWARDS], ['phamily', R.PHAMILY_REWARDS]]) {
    const keys = list.map(r => R.rewardKeyFor(r, track));
    check(`${track} keys are unique`, keys.filter((k, i, a) => a.indexOf(k) !== i), []);
  }

  check('ten milestones', R.MILESTONES.length, 10);
  check('every milestone has a title', R.MILESTONES.filter(m => !m.title).length, 0);
}

/* ── Lookup refuses what is not on the track ─────────────────────────── */
{
  const real = R.rewardKeyFor(R.FOLLOWER_REWARDS[0], 'follower');
  ok('a real key resolves', !!R.findReward(real));
  check('and carries its track', R.findReward(real).track, 'follower');

  /* THE EXPLOIT. A level-2 follower giveaway exists at common; the same key
     at mythic does not, and inventing one must not grant 50 entries. */
  check('the same reward at a higher rarity does not exist',
    R.findReward('2_follower_giveaway_mythic'), null);
  check('nor a type swapped for a richer one',
    R.findReward('2_follower_egg_mythic'), null);
  check('nor a level nobody reaches', R.findReward('999_follower_giveaway_mythic'), null);
  check('nor an empty key', R.findReward(''), null);
  check('nor a made-up track', R.findReward('2_broadcaster_giveaway_common'), null);

  check('a milestone resolves by level', R.findMilestone(15).level, 15);
  check('a level between milestones does not', R.findMilestone(16), null);
}

/* ── Track selection follows subTier, not role ───────────────────────── */
{
  check('no sub is the follower track', R.trackFor(0), 'follower');
  check('tier 1 is the phamily track', R.trackFor(1), 'phamily');
  check('tier 3 too', R.trackFor(3), 'phamily');
  /* The bug this shape avoids: a subscribing moderator whose role string
     says 'moderator' still has subTier 1 and belongs on the paid track. */
  check('a missing tier falls back to follower', R.trackFor(undefined), 'follower');
}

/* ── What is earned at a level ───────────────────────────────────────── */
{
  check('nothing at level 0', R.earnedRewards('follower', 0).length, 0);
  check('nothing at level 1', R.earnedRewards('follower', 1).length, 0);
  ok('something at level 2', R.earnedRewards('follower', 2).length > 0);

  const at50 = R.earnedRewards('follower', 50);
  check('everything earned is at or below the level',
    at50.filter(r => r.level > 50).length, 0);
  ok('and it is a real subset', at50.length < R.FOLLOWER_REWARDS.length);

  check('the whole track at max level',
    R.earnedRewards('phamily', 150).length, R.PHAMILY_REWARDS.length);

  check('no milestones before the first', R.earnedMilestones(14).length, 0);
  check('one at fifteen', R.earnedMilestones(15).length, 1);
  check('all ten at 150', R.earnedMilestones(150).length, 10);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[phamily-rewards] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[phamily-rewards] ${passed} assertions passed.`);
console.log('');
