#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PHAMILY TIME — the tables endpoint

     node server/scripts/test-phamily-tables.js

   The page no longer carries a copy of the reward tables; it fetches them from
   GET /api/phamily-time?action=tables. This asserts that endpoint:

     - it answers WITHOUT a session (the logged-out demo view needs it too, and
       the response is identical for every viewer),
     - it returns the CURRENT month for the pass ladder and the PREVIOUS month
       for the grace view, each exactly the canonical rewardTablesFor(mk),
     - it sends only the arrays the page renders (never byKey, a Map that would
       serialise to {}), and
     - it is cacheable, since it only changes at the month boundary.
   ══════════════════════════════════════════════ */

import * as R from '../../functions/api/phamily-rewards.js';
import { onRequestGet } from '../../functions/api/phamily-time.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Pin the clock, exactly as test-phamily-rewards.js does, so the month the
   endpoint derives is known and does not depend on when the suite runs. */
const RealDate = Date;
let FAKE_NOW = null;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length || FAKE_NOW === null) super(...a); else super(FAKE_NOW); }
  static now() { return FAKE_NOW === null ? RealDate.now() : FAKE_NOW; }
};
FAKE_NOW = RealDate.parse('2026-10-15T19:00:00Z');

const shape = (t) => ({ month: t.month, follower: t.follower, phamily: t.phamily, milestones: t.milestones });

const res = await onRequestGet({
  env: {},
  /* No Cookie header: the tables are served before the login gate. */
  request: new Request('https://phantomace.tv/api/phamily-time?action=tables'),
});

ok('served without a session (not 401)', res.status === 200);
check('is cacheable', res.headers.get('Cache-Control'), 'public, max-age=300');

const data = await res.json();

check('the current month is this month', data.current.month, '2026-10');
check('the previous month is last month', data.prev.month, '2026-09');

check('current follower track is the canonical one',
  data.current.follower, shape(R.rewardTablesFor('2026-10')).follower);
check('current phamily track is the canonical one',
  data.current.phamily, shape(R.rewardTablesFor('2026-10')).phamily);
check('current milestones are the canonical ones',
  data.current.milestones, shape(R.rewardTablesFor('2026-10')).milestones);
check('prev follower track is last month\'s',
  data.prev.follower, shape(R.rewardTablesFor('2026-09')).follower);
check('prev phamily track is last month\'s',
  data.prev.phamily, shape(R.rewardTablesFor('2026-09')).phamily);
check('prev milestones are last month\'s',
  data.prev.milestones, shape(R.rewardTablesFor('2026-09')).milestones);

/* The themed month really is shown — a smoke test that the endpoint serves the
   skinned table, not a base one. */
check('current shows the October card back', data.current.follower
  .find(r => r.level === 10 && r.type === 'cardback').name, 'Cobweb Card Back');
check('prev shows September\'s card back', data.prev.follower
  .find(r => r.level === 10 && r.type === 'cardback').name, 'Basic Card Back');

/* byKey is a Map; it must not have been serialised (it would be {}). */
ok('no byKey leaks into the response',
  !('byKey' in data.current) && !('byKey' in data.prev));

/* Every reward the page draws from carries the fields it renders. */
for (const side of ['current', 'prev']) {
  const all = [...data[side].follower, ...data[side].phamily];
  check(`${side}: every reward has a level/type/rarity/icon`,
    all.filter(r => !Number.isInteger(r.level) || !r.type || !r.rarity || !r.icon).length, 0);
}

FAKE_NOW = null;
globalThis.Date = RealDate;

console.log('');
if (failures.length) {
  console.log(`[phamily-tables] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[phamily-tables] ${passed} assertions passed.`);
console.log('');
