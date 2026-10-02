#!/usr/bin/env node
/* ══════════════════════════════════════════════
   REPAIR OCTOBER PASS — test suite

     node server/scripts/test-repair-october-pass.js

   planUser() decides who is owed what from the pass rows and the inventory
   alone. A false positive hands out an item nobody earned, so the cases it
   must REFUSE matter as much as the ones it must catch.
   ══════════════════════════════════════════════ */

import { planUser, applyPlan, OCT_START } from './repair-october-pass.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const SEPT_TIME = OCT_START - 10 * 86400000;
const OCT_TIME = OCT_START + 2 * 86400000;
const row = (claimedRewards = [], claimedMilestones = []) => ({ claimedRewards, claimedMilestones });
const it = (type, id, name, grantedAt, source = 'phamily-time', extra = {}) => ({ type, id, name, grantedAt, source, ...extra });
const grants = (p) => p.grants.map(g => `${g.part}:${g.item.type}:${g.item.id}`);

check('October starts at midnight Pacific', new Date(OCT_START).toISOString(), '2026-10-01T07:00:00.000Z');

/* ── (a) October card back deduped away by a September one ───────────── */
{
  const p = planUser({
    sep: row(['10_follower_cardback_common']),
    oct: row(['10_follower_cardback_common', '22_follower_emote_uncommon']),
    items: [
      it('cardback', '10_follower_cardback_common', 'Basic Card Back', SEPT_TIME),
      it('emote-pack', '22_follower_emote_uncommon', 'Emote Pack', SEPT_TIME),
    ],
  });
  check('(a) owes October\'s card back and emote pack', grants(p).sort(),
    ['a:cardback:cardback-cobweb-card-back', 'a:emote-pack:emote-pack-spooky-emote-pack']);
  check('and nothing unattributed', p.unattributed, []);
}
{
  const p = planUser({
    sep: null,
    oct: row(['10_follower_cardback_common']),
    items: [it('cardback', '10_follower_cardback_common', 'Cobweb Card Back', OCT_TIME)],
  });
  check('(a) refuses: October\'s card back already landed under the old id', grants(p), []);
}

/* ── (b) confirmed: September skull skin grace-claimed, October not claimed */
{
  const p = planUser({
    sep: row(['85_follower_skull-skin_rare']),
    oct: row([]),
    items: [it('skull-skin', 'bonewhite', 'Bonewhite Skull', OCT_TIME)],
  });
  check('(b) owes the Blood skull', grants(p), ['b:skull-skin:blood']);
  check('and reports the kept Bonewhite misgrant', p.misgranted.map(m => m.item.id), ['bonewhite']);
}
{
  const p = planUser({
    sep: row(['85_follower_skull-skin_rare']),
    oct: row(['85_follower_skull-skin_rare']),
    items: [it('skull-skin', 'bonewhite', 'Bonewhite Skull', OCT_TIME)],
  });
  check('(b) refuses to CONFIRM when October claimed the same key', grants(p), []);
  check('but lists it as unattributed', p.unattributed.map(u => u.item.id), ['blood']);
}
{
  const p = planUser({
    sep: row(['85_follower_skull-skin_rare']),
    oct: row([]),
    items: [it('skull-skin', 'bonewhite', 'Bonewhite Skull', SEPT_TIME)],
  });
  check('(b) refuses evidence granted before October began', [grants(p), p.unattributed], [[], []]);
}
{
  const p = planUser({
    sep: row(['85_follower_skull-skin_rare']),
    oct: row([]),
    items: [it('skull-skin', 'bonewhite', 'Bonewhite Skull', OCT_TIME, 'item-code')],
  });
  check('(b) refuses evidence from an unrelated source', grants(p), []);
}
{
  const p = planUser({
    sep: row(['85_follower_skull-skin_rare']),
    oct: row([]),
    items: [it('skull-skin', 'blood', 'Skull Skin', SEPT_TIME), it('skull-skin', 'bonewhite', 'Bonewhite Skull', OCT_TIME)],
  });
  check('(b) nothing when September\'s item is already owned', grants(p), []);
}
{
  const p = planUser({ sep: row(['85_follower_skull-skin_rare']), oct: row([]), items: [] });
  check('(b) nothing without evidence — not this bug', [grants(p), p.unattributed], [[], []]);
}

/* ── (b) card backs: the old id-K item bearing October's name ─────────── */
{
  const p = planUser({
    sep: row(['10_follower_cardback_common']),
    oct: row(['10_follower_cardback_common']),
    items: [it('cardback', '10_follower_cardback_common', 'Cobweb Card Back', OCT_TIME)],
  });
  check('(b) a key-id card back named Cobweb proves the grace claim, even with October claimed',
    grants(p), ['b:cardback:cardback-basic-card-back']);
}
{
  const p = planUser({
    sep: row(['10_follower_cardback_common']),
    oct: row(['10_follower_cardback_common']),
    items: [it('cardback', 'cardback-cobweb-card-back', 'Cobweb Card Back', OCT_TIME)],
  });
  check('(b) a NEW-id Cobweb proves nothing about September', grants(p), []);
}

/* ── room pieces are never themed ─────────────────────────────────────── */
{
  const p = planUser({ sep: row(['4_follower_room-piece_common']), oct: row([]), items: [] });
  check('a September room piece is never repaired by this script', [grants(p), p.unattributed], [[], []]);
  check('and is counted as identical', p.roomGraceOk, 1);
}

/* ── (c) milestones ───────────────────────────────────────────────────── */
{
  const p = planUser({
    sep: row([], [60]),
    oct: row([], []),
    items: [
      it('title', 'ms_60_title_2026-09', 'Pumpkin Knight', OCT_TIME),
      it('badge', 'ms_60_badge_2026-09', 'Pumpkin Knight Badge', OCT_TIME, 'phamily-time', { meta: { rank: 'Pumpkin Knight', milestoneLevel: 60 } }),
      it('dice', 'blood', 'Bloodletter Dice', OCT_TIME),
    ],
  });
  check('(c) the September title and badge are renamed',
    p.renames.map(r => `${r.id}:${r.to}`), ['ms_60_title_2026-09:Guardian', 'ms_60_badge_2026-09:Guardian Badge']);
  check('(c) and Crimson dice are owed', grants(p), ['c:dice:crimson']);

  const inv = { items: JSON.parse(JSON.stringify([
    it('title', 'ms_60_title_2026-09', 'Pumpkin Knight', OCT_TIME),
    it('badge', 'ms_60_badge_2026-09', 'Pumpkin Knight Badge', OCT_TIME, 'phamily-time', { meta: { rank: 'Pumpkin Knight', milestoneLevel: 60 } }),
    it('dice', 'blood', 'Bloodletter Dice', OCT_TIME),
  ])), equips: {} };
  const out = applyPlan(inv, p);
  check('applied: title renamed', out.items.find(i => i.id === 'ms_60_title_2026-09').name, 'Guardian');
  check('applied: badge rank corrected', out.items.find(i => i.id === 'ms_60_badge_2026-09').meta.rank, 'Guardian');
  ok('applied: crimson granted', out.items.some(i => i.type === 'dice' && i.id === 'crimson' && i.source === 'repair-october-pass'));
  check('applying again changes nothing', applyPlan(out, p), undefined);
}
{
  const p = planUser({
    sep: row([], [15]),
    oct: row([], []),
    items: [it('title', 'ms_15_title_2026-09', 'Initiate', SEPT_TIME)],
  });
  check('(c) a correctly-named September title is left alone', p.renames, []);
}
{
  const p = planUser({
    sep: row([], [45]),
    oct: row([], []),
    items: [it('banner', 'ms_45_banner_2026-09', 'Profile Banner', OCT_TIME, 'phamily-time', { meta: { theme: 'halloween' } })],
  });
  check('(c) a Halloween-themed September banner is reported, not changed', p.misthemed.map(m => m.id), ['ms_45_banner_2026-09']);
  check('and nothing is granted for it', grants(p), []);
}

/* ── apply never doubles ─────────────────────────────────────────────── */
{
  const p = planUser({
    sep: row(['85_follower_skull-skin_rare']),
    oct: row([]),
    items: [it('skull-skin', 'bonewhite', 'Bonewhite Skull', OCT_TIME)],
  });
  const inv = { items: [it('skull-skin', 'bonewhite', 'Bonewhite Skull', OCT_TIME), it('skull-skin', 'blood', 'Skull Skin', OCT_TIME + 1)], equips: {} };
  check('a grant that landed since the plan was made is not doubled', applyPlan(inv, p), undefined);
}

console.log('');
if (failures.length) {
  console.log(`[repair-october-pass] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[repair-october-pass] ${passed} assertions passed.`);
console.log('');
