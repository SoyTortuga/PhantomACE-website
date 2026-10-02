#!/usr/bin/env node
/* ══════════════════════════════════════════════
   INVENTORY API — security regressions

     node server/scripts/test-inventory-security.js

   - POST {action:'grant'} is refused: there is no client-facing grant, and
     the refusal must not write anything.
   - A stored rarity outside the real ladder is reported as 'common' by both
     the public showcase read and the owner's own read; real tiers (including
     Dino Park's epic/legendary eggs) pass through untouched.
   - The client guards in js/pages/leaderboards.js and js/pages/profile.js
     (safeRarity / safeVariant / safeSrc) reject attribute-breaking input.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  onRequestGet, onRequestPost, normalizeRarity, RARITIES,
} from '../../functions/api/inventory.js';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), x = JSON.stringify(expected);
  if (a === x) { passed++; return; }
  failures.push(`${label}\n      expected ${x}\n      got      ${a}`);
}

const EVIL = 'x" onmouseover="alert(1)';

function makeEnv(store) {
  let writes = 0;
  return {
    get writes() { return writes; },
    MARKETPLACE: {
      async get(key) { return key in store ? JSON.parse(JSON.stringify(store[key])) : null; },
      async put(key, val) { writes++; store[key] = JSON.parse(val); },
      async mutate(key, fn) {
        const next = fn(key in store ? JSON.parse(JSON.stringify(store[key])) : null);
        if (next !== undefined) { writes++; store[key] = next; }
      },
    },
  };
}

function session(userId) {
  return 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'T' }));
}

function post(userId, body) {
  return new Request('http://localhost/api/inventory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session(userId) },
    body: JSON.stringify(body),
  });
}

/* ── grant is gone ─────────────────────────────────────────────────── */
{
  const store = { inv_1: { userId: '1', items: [], equips: {} } };
  const env = makeEnv(store);
  const res = await onRequestPost({ env, request: post('1', {
    action: 'grant',
    item: { id: 'free', game: 'profile', type: 'badge', name: 'Free', rarity: 'mythic' },
  }) });
  check('grant → 400', res.status, 400);
  check('grant → Unknown action', (await res.json()).error, 'Unknown action');
  check('grant wrote nothing', env.writes, 0);
  check('grant left inventory empty', store.inv_1.items.length, 0);

  const anon = await onRequestPost({ env, request: new Request('http://localhost/api/inventory', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'grant', item: { id: 'a', game: 'g', type: 't' } }),
  }) });
  check('grant signed-out → 401', anon.status, 401);
}

/* ── rarity normalization ──────────────────────────────────────────── */
check('normalizeRarity keeps mythic', normalizeRarity('mythic'), 'mythic');
check('normalizeRarity keeps exclusive', normalizeRarity('exclusive'), 'exclusive');
check('normalizeRarity keeps epic', normalizeRarity('epic'), 'epic');
check('normalizeRarity keeps legendary', normalizeRarity('legendary'), 'legendary');
check('normalizeRarity rejects payload', normalizeRarity(EVIL), 'common');
check('normalizeRarity rejects case variant', normalizeRarity('Mythic'), 'common');
check('normalizeRarity rejects non-string', normalizeRarity({ toString: () => 'rare' }), 'common');
check('normalizeRarity undefined', normalizeRarity(undefined), 'common');
check('RARITIES ladder', [...RARITIES], ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exclusive']);

{
  const store = {
    inv_2: {
      userId: '2',
      items: [
        { id: 'b1', game: 'profile', type: 'badge', name: 'Bad', rarity: EVIL },
        { id: 'b2', game: 'profile', type: 'badge', name: 'Good', rarity: 'rare' },
        { id: 'egg', game: 'dino-park', type: 'egg', name: 'Egg', rarity: 'legendary', consumable: true, quantity: 1 },
      ],
      equips: { profile: { badgeShowcase: ['b1', 'b2'] } },
    },
  };
  const env = makeEnv(store);

  const sc = await onRequestGet({ env, request: new Request('http://localhost/api/inventory?action=showcase&userIds=2') });
  const showcase = (await sc.json())['2'];
  check('showcase malicious rarity → common', showcase[0].rarity, 'common');
  check('showcase real rarity kept', showcase[1].rarity, 'rare');

  const own = await onRequestGet({ env, request: new Request('http://localhost/api/inventory?game=profile', {
    headers: { Cookie: session('2') },
  }) });
  const ownItems = (await own.json()).items;
  check('own read malicious rarity → common', ownItems.find(i => i.id === 'b1').rarity, 'common');

  const all = await onRequestGet({ env, request: new Request('http://localhost/api/inventory', {
    headers: { Cookie: session('2') },
  }) });
  const allItems = (await all.json()).items;
  check('full read malicious rarity → common', allItems.find(i => i.id === 'b1').rarity, 'common');
  check('full read keeps legendary egg', allItems.find(i => i.id === 'egg').rarity, 'legendary');
  check('reads do not rewrite storage', store.inv_2.items[0].rarity, EVIL);
  check('reads wrote nothing', env.writes, 0);
}

/* ── client guards ─────────────────────────────────────────────────── */
function extract(file, names) {
  const src = readFileSync(join(here, '../../js/pages', file), 'utf8');
  const parts = [];
  const rar = src.match(/var RARITIES = \[[^\]]*\];/);
  if (rar) parts.push(rar[0]);
  for (const n of names) {
    const start = src.indexOf('function ' + n + '(');
    if (start === -1) throw new Error(`${file}: ${n} not found`);
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    parts.push(src.slice(start, i + 1));
  }
  // eslint-disable-next-line no-eval
  return (0, eval)('(function(){' + parts.join('\n') + '\nreturn {' + names.join(',') + '};})()');
}

for (const file of ['leaderboards.js', 'profile.js']) {
  const g = extract(file, ['safeRarity', 'safeVariant']);
  check(`${file} safeRarity payload`, g.safeRarity(EVIL), 'common');
  check(`${file} safeRarity mythic`, g.safeRarity('mythic'), 'mythic');
  check(`${file} safeRarity exclusive`, g.safeRarity('exclusive'), 'exclusive');
  check(`${file} safeVariant halloween-mythic`, g.safeVariant('halloween-mythic'), 'halloween-mythic');
  check(`${file} safeVariant payload`, g.safeVariant('rare.png" onerror="alert(1)'), null);
  check(`${file} safeVariant traversal`, g.safeVariant('../../evil'), null);
  check(`${file} safeVariant spaces`, g.safeVariant('rare x'), null);
  check(`${file} safeVariant null`, g.safeVariant(null), null);
}

{
  const g = extract('profile.js', ['safeSrc']);
  check('safeSrc site path', g.safeSrc('/assets/badges/agate-hunt.png'), '/assets/badges/agate-hunt.png');
  check('safeSrc https', g.safeSrc('https://static-cdn.jtvnw.net/x.png'), 'https://static-cdn.jtvnw.net/x.png');
  check('safeSrc data png', g.safeSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  check('safeSrc javascript:', g.safeSrc('javascript:alert(1)'), '');
  check('safeSrc protocol-relative', g.safeSrc('//evil.example/x.png'), '');
  check('safeSrc data svg', g.safeSrc('data:image/svg+xml;base64,AAAA'), '');
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ all ${passed} inventory security checks passed`);
