#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SUBSCRIBER LOYALTY BADGES — test suite

     node server/scripts/test-sub-badges.js

   Two bugs lived here, and both were invisible: the feature ran, returned
   success, and granted the wrong thing.

   ONE. Twitch encodes the tier in the badge version id. PhantomACE's set
   runs 0/2/3/6/12/24/36/48/60/72/84/96 at Tier 1, then the same ladder at
   2000+ for Tier 2 and 3000+ for Tier 3. Read as a plain number, version
   2012 is "two thousand and twelve months" — larger than any subscription,
   so every Tier 2 and Tier 3 badge was skipped in silence.

   TWO. The grant loop compared against `session.sub_months`, which nothing
   ever set. It read undefined, fell back to 1, and handed out the
   zero-month badge and nothing else however long someone had subscribed.
   Helix returns a tier and no duration; the only place cumulative months
   appear is the badge worn in chat, which the bot now records.
   ══════════════════════════════════════════════ */

import { decodeBadgeVersion, badgeRarity, badgeName, founderBadgeItem, vipBadgeItem } from '../../functions/api/import-badges.js';
import { pickSubBadge, hasVipBadge } from '../../functions/api/bot/commands.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* PhantomACE's real ladder, from the channel's badge set. */
const LADDER = [0, 2, 3, 6, 12, 24, 36, 48, 60, 72, 84, 96];

/* ── Decoding a version id ───────────────────────────────────────────── */
{
  check('a plain number is Tier 1', decodeBadgeVersion('6'), { tier: 1, months: 6 });
  check('zero is the entry badge, not nothing', decodeBadgeVersion('0'), { tier: 1, months: 0 });
  check('the top of the Tier 1 ladder', decodeBadgeVersion('96'), { tier: 1, months: 96 });

  /* THE BUG. 2012 is Tier 2 at twelve months. Read as 2012 months it
     exceeds every subscription, which is why no Tier 2 badge was granted. */
  check('2000 is Tier 2 at zero months', decodeBadgeVersion('2000'), { tier: 2, months: 0 });
  check('2012 is Tier 2 at twelve months', decodeBadgeVersion('2012'), { tier: 2, months: 12 });
  check('3036 is Tier 3 at three years', decodeBadgeVersion('3036'), { tier: 3, months: 36 });
  check('3120 is Tier 3 at ten years', decodeBadgeVersion('3120'), { tier: 3, months: 120 });

  check('junk decodes to nothing', decodeBadgeVersion('abc'), null);
  check('and an empty id too', decodeBadgeVersion(''), null);
  check('and a negative one', decodeBadgeVersion('-4'), null);

  /* Every real version decodes to a month count on the ladder. */
  const all = [...LADDER, ...LADDER.map(m => 2000 + m), ...LADDER.map(m => 3000 + m)];
  const decoded = all.map(v => decodeBadgeVersion(String(v)));
  check('every real version decodes', decoded.filter(d => !d).length, 0);
  check('and always to a month on the ladder',
    decoded.filter(d => !LADDER.includes(d.months)).length, 0);
  check('across exactly three tiers',
    [...new Set(decoded.map(d => d.tier))].sort(), [1, 2, 3]);
}

/* ── Which badges a subscriber has actually earned ───────────────────── */
{
  /* The grant rule, stated once here so the test is about the rule rather
     than about a copy of the loop. */
  const earned = (months, tier) =>
    [...LADDER, ...LADDER.map(m => 2000 + m), ...LADDER.map(m => 3000 + m)]
      .map(v => decodeBadgeVersion(String(v)))
      .filter(d => d.months <= months && d.tier <= tier);

  const brandNew = earned(0, 1);
  check('a brand new Tier 1 sub earns exactly one badge', brandNew.length, 1);
  check('and it is the zero-month one', brandNew[0], { tier: 1, months: 0 });

  const year = earned(12, 1);
  check('a one-year Tier 1 sub earns five', year.length, 5);
  check('none of them above their duration', year.filter(d => d.months > 12).length, 0);
  check('and none from a tier they do not hold', year.filter(d => d.tier > 1).length, 0);

  /* BOTH GATES, NOT EITHER. Duration alone would hand a Tier 1 subscriber
     the Tier 3 artwork; tier alone would hand a new Tier 3 subscriber the
     eight-year badge. */
  const t3new = earned(0, 3);
  check('a new Tier 3 sub earns the entry badge at each tier', t3new.length, 3);
  check('and nothing above zero months', t3new.filter(d => d.months > 0).length, 0);

  const t3long = earned(36, 3);
  check('a three-year Tier 3 sub earns every tier up to three years', t3long.length, 21);
  check('the longest of them is three years', Math.max(...t3long.map(d => d.months)), 36);

  /* Somebody who never chats has no recorded duration, so months is 0 and
     they get the entry badge until they speak. Fewer badges, never wrong
     ones. */
  check('an unknown duration is not an unlimited one', earned(0, 2).length, 2);
}

/* ── Naming and rarity reflect the real duration ─────────────────────── */
{
  check('Twitch’s own title wins', badgeName(6, 1, '6-Month Subscriber'), '6-Month Subscriber');
  check('a missing title is reconstructed', badgeName(6, 1, ''), '6-Month Subscriber');
  check('zero months is not "0-Month"', badgeName(0, 1, ''), 'Subscriber');
  /* The title never mentions the tier, so anything above the first says so
     — otherwise Tier 1 and Tier 3 at twelve months are the same string. */
  check('a higher tier is named', badgeName(12, 2, '12-Month Subscriber'), 'Tier 2 · 12-Month Subscriber');
  check('and the top tier too', badgeName(36, 3, '36-Month Subscriber'), 'Tier 3 · 36-Month Subscriber');
  ok('so two tiers at one duration are never the same name',
    badgeName(12, 1, '12-Month Subscriber') !== badgeName(12, 2, '12-Month Subscriber'));

  check('under three months is common', badgeRarity(0, 1), 'common');
  check('three months is uncommon', badgeRarity(3, 1), 'uncommon');
  check('a year is rare', badgeRarity(12, 1), 'rare');
  check('three years is mythic', badgeRarity(36, 1), 'mythic');
  check('and eight years stays mythic', badgeRarity(96, 1), 'mythic');
  check('Tier 3 lifts the floor', badgeRarity(0, 3), 'uncommon');
  check('but never past what the duration earns', badgeRarity(36, 3), 'mythic');

  /* Rarity only ever climbs with duration — a longer subscription must not
     produce a lesser-looking badge. */
  const order = { common: 0, uncommon: 1, rare: 2, mythic: 3 };
  let worst = -1, monotonic = true;
  for (const m of LADDER) {
    const r = order[badgeRarity(m, 1)];
    if (r < worst) monotonic = false;
    worst = Math.max(worst, r);
  }
  ok('rarity never goes down as duration goes up', monotonic);
}

/* ── Item ids separate the tiers ─────────────────────────────────────── */
{
  const idFor = (v) => {
    const d = decodeBadgeVersion(String(v));
    return `twitch_sub_badge_t${d.tier}_${d.months}`;
  };
  /* The old id keyed on the raw version, which could not tell Tier 2 at a
     year from Tier 1 at a year once the version was decoded. */
  ok('the same duration at two tiers gets two ids', idFor(12) !== idFor(2012));
  check('and the tier is in the id', idFor(2012), 'twitch_sub_badge_t2_12');

  const all = [...LADDER, ...LADDER.map(m => 2000 + m), ...LADDER.map(m => 3000 + m)];
  const ids = all.map(idFor);
  check('every badge in the set has its own id', new Set(ids).size, ids.length);
}

/* ── Which badge carries the duration ────────────────────────────────
   Founders wear a founder badge INSTEAD of a subscriber one. Looking only
   for 'subscriber' missed them — and they are the channel's earliest
   subscribers, so they have the most months and the most to lose. */
{
  const B = (set_id, id, info) => ({ set_id, id, info });

  const sub = pickSubBadge([B('moderator', '1'), B('subscriber', '2012', '14')]);
  check('a subscriber badge is found among others', sub.badge.id, '2012');
  check('and is not a founder', sub.isFounder, false);

  const f = pickSubBadge([B('founder', '0', '41')]);
  ok('a founder badge is found at all', !!f);
  check('and is flagged as one', f.isFounder, true);
  check('carrying the months in info', f.badge.info, '41');

  /* THE BUG. A founder wears no subscriber badge, so a lookup for one
     returns nothing and forty-one months go unrecorded. */
  check('a founder has no subscriber badge to find',
    [B('founder', '0', '41')].filter(b => b.set_id === 'subscriber').length, 0);

  /* The broadcaster cannot subscribe to themselves, so they carry neither.
     No duration is recordable for them by design — the importer exempts
     them rather than gating on one. */
  check('the broadcaster carries neither', pickSubBadge([B('broadcaster', '1')]), null);
  check('nor does a plain viewer', pickSubBadge([]), null);
  check('and junk does not throw', pickSubBadge(null), null);
  check('nor a malformed entry', pickSubBadge([null, undefined, {}]), null);

  /* Subscriber wins when both appear: its version id carries the tier,
     which a founder badge's does not. */
  const both = pickSubBadge([B('founder', '0', '41'), B('subscriber', '3036', '41')]);
  check('subscriber is preferred over founder', both.badge.set_id, 'subscriber');
  check('so the tier stays readable', decodeBadgeVersion(both.badge.id).tier, 3);
}

/* ── The Founder badge ───────────────────────────────────────────────
   Global Twitch artwork rather than the channel's, one version for every
   founder everywhere, and unearnable once the window closes. */
{
  const V = {
    image_url_1x: 'https://cdn/1', image_url_2x: 'https://cdn/2',
    image_url_4x: 'https://cdn/4', description: 'Founder',
  };
  const item = founderBadgeItem(V);

  check('it lands in the profile inventory', item.game, 'profile');
  check('as a badge', item.type, 'badge');
  check('called Founder', item.name, 'Founder');
  /* Ten to fifty per channel, ever, and no amount of subscribing afterwards
     earns one. */
  check('at mythic', item.rarity, 'mythic');
  check('carrying its artwork', item.meta.imageUrl4x, 'https://cdn/4');
  check('and flagged as a founder badge', item.meta.founder, true);

  /* Loyalty skulls sort by monthThreshold. A founder badge carries no
     duration, so a naive 0 would file the rarest badge in the channel
     alongside the one every new subscriber gets. */
  ok('it sorts above every rung of the ladder',
    item.meta.monthThreshold > Math.max(...LADDER));

  /* Its id must not collide with the ladder, or importing one would make
     the other look already owned. */
  const ladderIds = LADDER.map(m => `twitch_sub_badge_t1_${m}`);
  ok('its id is its own', !ladderIds.includes(item.id));

  check('a missing version grants nothing', founderBadgeItem(null), null);
  check('and so does an absent set', founderBadgeItem(undefined), null);
}

/* ── VIP ─────────────────────────────────────────────────────────────
   Chat is the only place VIP is visible to this site, so it is found the
   same way founder is — and unlike everything else here it can be taken
   away again. */
{
  const B = (set_id, id, info) => ({ set_id, id, info });

  ok('a VIP badge is found', hasVipBadge([B('vip', '1'), B('subscriber', '12', '12')]));
  ok('alongside a founder badge', hasVipBadge([B('founder', '0', '41'), B('vip', '1')]));
  check('a non-VIP is not one', hasVipBadge([B('subscriber', '12', '12')]), false);
  check('nor an empty badge list', hasVipBadge([]), false);
  check('and junk does not throw', hasVipBadge(null), false);
  /* A moderator is not a VIP: Twitch treats them as separate badges and so
     must this, or every moderator would be handed a VIP badge. */
  check('a moderator is not a VIP', hasVipBadge([B('moderator', '1')]), false);

  const V = { image_url_1x: 'https://cdn/v1', image_url_2x: 'https://cdn/v2',
              image_url_4x: 'https://cdn/v4', description: 'VIP' };
  const item = vipBadgeItem(V, false);
  check('it lands in the profile inventory', item.game, 'profile');
  check('called VIP', item.name, 'VIP');
  check('at rare', item.rarity, 'rare');
  check('carrying its artwork', item.meta.imageUrl4x, 'https://cdn/v4');
  check('flagged as a VIP badge', item.meta.vip, true);
  check('and noted as Twitch default art', item.meta.custom, false);
  check('custom channel art is noted too', vipBadgeItem(V, true).meta.custom, true);

  /* Sorting: VIP sits above the whole month ladder and below Founder, so a
     showcase orders them the way the channel ranks them. */
  const founder = founderBadgeItem(V);
  ok('VIP sorts above every month badge',
    item.meta.monthThreshold > Math.max(...LADDER));
  ok('and below Founder', item.meta.monthThreshold < founder.meta.monthThreshold);

  ok('its id is its own', item.id !== founder.id);
  check('a missing version grants nothing', vipBadgeItem(null), null);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[sub-badges] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[sub-badges] ${passed} assertions passed.`);
console.log('');
