#!/usr/bin/env node
/* ══════════════════════════════════════════════
   BITS POWER-UP → DINO HATCH — the matcher

     node server/scripts/test-bits-hatch.js

   THE BUG THIS EXISTS FOR. channel.bits.use carries event.type as one of
   'cheer', 'power_up' (a BUILT-IN Power-up) or 'custom_power_up' (one the
   broadcaster created). The egg-hatch reward can only be a custom Power-up, so
   it arrives as 'custom_power_up' with its name in custom_power_up.title. The
   original code matched event.type === 'power_up', so a 300-bit hatch Power-up
   never fired. These assertions pin the corrected matching: a custom Power-up
   named for the hatch fires; a built-in Power-up and an ordinary cheer never
   do; a 300-bit cost is only a fallback when there is no title.
   ══════════════════════════════════════════════ */

import { isHatchPowerUp } from '../../functions/api/bits.js';

let passed = 0;
const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
};

const customPowerUp = (title, bits = 300) => ({ type: 'custom_power_up', bits, custom_power_up: { title, reward_id: 'r1' } });

/* Custom Power-ups whose title names the hatch — the real trigger. Matched by
   keyword like the channel-point "Hatch a Dino" reward, so a rename that keeps
   the word still fires. */
check('custom "Hatch a Dino" hatches', isHatchPowerUp(customPowerUp('Hatch a Dino')), true);
check('custom "Dino Egg Hatch" hatches', isHatchPowerUp(customPowerUp('Dino Egg Hatch')), true);
check('custom "Egg" hatches', isHatchPowerUp(customPowerUp('Egg')), true);
check('custom "DINO" (case-insensitive) hatches', isHatchPowerUp(customPowerUp('DINO')), true);

/* A custom Power-up costing exactly the hatch price with NO title still fires
   (the fallback) — but a different cost with no title does not. */
check('custom with no title at 300 bits hatches (fallback)', isHatchPowerUp({ type: 'custom_power_up', bits: 300, custom_power_up: {} }), true);
check('custom with no title at 100 bits does NOT', isHatchPowerUp({ type: 'custom_power_up', bits: 100, custom_power_up: {} }), false);

/* A custom Power-up with an unrelated title does NOT hatch, even at 300 bits —
   the title is authoritative when present, so an unrelated reward can't fire it. */
check('custom "Confetti" at 300 bits does NOT hatch', isHatchPowerUp(customPowerUp('Confetti', 300)), false);

/* Built-in Power-ups and ordinary cheers never hatch, whatever the amount. */
check('built-in power_up does NOT hatch', isHatchPowerUp({ type: 'power_up', bits: 300, power_up: { type: 'gigantify_an_emote' } }), false);
check('ordinary 300-bit cheer does NOT hatch', isHatchPowerUp({ type: 'cheer', bits: 300 }), false);
check('large cheer does NOT hatch', isHatchPowerUp({ type: 'cheer', bits: 10000 }), false);

/* Defensive: garbage in, false out (the webhook must never throw). */
check('null event is false', isHatchPowerUp(null), false);
check('empty event is false', isHatchPowerUp({}), false);

console.log('');
if (failures.length) {
  console.log(`[bits-hatch] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[bits-hatch] ${passed} assertions passed.`);
