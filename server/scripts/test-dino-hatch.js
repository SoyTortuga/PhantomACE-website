#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO HATCH — the on-stream gambling minigame

     node server/scripts/test-dino-hatch.js

   Covers the species table's integrity, the weighted rarity roll, grantDino's
   park → vault → both-full placement ladder and its grantSeq/grantId protocol,
   and runDinoHatch end to end: the batch overlay event, the inventory-egg
   overflow (pinned to the exact species), the anonymous reveal-only path, and
   the on/off toggle.
   ══════════════════════════════════════════════ */

import {
  SPECIES, ROSTER_BY_RARITY, RARITIES, speciesMeta, rollSpeciesId, rollHatchRarity,
} from '../../functions/api/dino-species.js';
import { grantDino } from '../../functions/api/dino-park.js';
import { runDinoHatch, getHatchConfig, setHatchConfig } from '../../functions/api/dino-hatch.js';

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
    async delete(k) { store.delete(k); },
    async mutate(k, fn) { const cur = store.has(k) ? JSON.parse(store.get(k)) : null; const out = await fn(cur); if (out === undefined) return; store.set(k, JSON.stringify(out)); },
  };
}
const envWith = (seed) => ({ MARKETPLACE: fakeKV(seed) });

/* A Dino Park save record at the current epoch with the given park/vault. */
const SAVE_EPOCH = 2;
function saveWith({ park = [], vault = [], grantSeq = 0 } = {}) {
  return {
    userId: 'u1',
    state: {
      saveEpoch: SAVE_EPOCH, coins: 100, level: 1, xp: 0,
      park, vault, eggs: [], discovered: [], grantSeq,
    },
  };
}
const dummyDino = (i) => ({ speciesId: 'compy', nickname: 'p' + i, xp: 0 });

/* ══ Species table integrity ═══════════════════════════════════════════ */
{
  check('roster has all five tiers', RARITIES.map(r => ROSTER_BY_RARITY[r].length).every(n => n > 0), true);
  const total = RARITIES.reduce((n, r) => n + ROSTER_BY_RARITY[r].length, 0);
  check('every species is in exactly one tier pool', total, Object.keys(SPECIES).length);

  let rarityMatches = true, hasIcon = true, hasName = true;
  for (const [id, s] of Object.entries(SPECIES)) {
    if (!ROSTER_BY_RARITY[s.rarity] || !ROSTER_BY_RARITY[s.rarity].includes(id)) rarityMatches = false;
    if (!s.icon || !s.icon.startsWith('/games/dino-park/assets/dino-assets/') || !s.icon.endsWith('.png')) hasIcon = false;
    if (!s.name) hasName = false;
  }
  ok('every species is filed under its own rarity', rarityMatches);
  ok('every species has a site-absolute icon path', hasIcon);
  ok('every species has a name', hasName);

  const m = speciesMeta('brachio');
  check('speciesMeta resolves a known id', m && m.name, 'Brachiosaurus');
  check('speciesMeta is null for an unknown id', speciesMeta('nope'), null);
  ok('rollSpeciesId stays within the requested tier',
    Array.from({ length: 200 }, () => rollSpeciesId('legendary')).every(id => SPECIES[id].rarity === 'legendary'));
}

/* ══ Weighted rarity roll ══════════════════════════════════════════════ */
{
  const counts = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 };
  const N = 60000;
  for (let i = 0; i < N; i++) counts[rollHatchRarity()]++;
  ok('common is by far the most frequent', counts.common > counts.uncommon && counts.common / N > 0.7 && counts.common / N < 0.87);
  ok('uncommon sits around 1 in 6 of the weight', counts.uncommon / N > 0.12 && counts.uncommon / N < 0.21);
  ok('every tier is reachable', RARITIES.every(r => counts[r] > 0));
  ok('legendary is the rarest', counts.legendary < counts.epic && counts.epic < counts.rare);
}

/* ══ grantDino — placement ladder ══════════════════════════════════════ */
{
  const e = envWith({ dino_park_u1: saveWith({ grantSeq: 3 }) });
  const r = await grantDino(e, 'u1', { rarity: 'rare', source: 'giftsub' });
  check('a forced-rarity grant lands at that rarity', r.rarity, 'rare');
  check('it goes to the park when there is room', r.placed, 'park');
  ok('it reports the species it granted', r.speciesId && r.name && r.icon);
  const rec = e.MARKETPLACE.read('dino_park_u1');
  check('the dino is written into the park', rec.state.park.length, 1);
  ok('the park dino carries a grantId', rec.state.park[0].grantId);
  check('grantSeq is bumped so a stale client save is refused', rec.state.grantSeq, 4);
  ok('the species is marked discovered', rec.state.discovered.includes(r.speciesId));
}
{
  const park = Array.from({ length: 10 }, (_, i) => dummyDino(i));   // MAX_ACTIVE_PARK
  const e = envWith({ dino_park_u1: saveWith({ park }) });
  const r = await grantDino(e, 'u1', { source: 'bits' });
  check('a full park overflows the grant to the vault', r.placed, 'vault');
  check('the vault now holds it', e.MARKETPLACE.read('dino_park_u1').state.vault.length, 1);
}
{
  const park = Array.from({ length: 10 }, (_, i) => dummyDino(i));
  const vault = Array.from({ length: 200 }, (_, i) => dummyDino(i));  // MAX_VAULT_SIZE
  const e = envWith({ dino_park_u1: saveWith({ park, vault }) });
  const before = JSON.stringify(e.MARKETPLACE.read('dino_park_u1'));
  const r = await grantDino(e, 'u1', { source: 'channel-points' });
  check('both full is reported as full', r.placed, 'full');
  check('and granted is false', r.granted, false);
  ok('it still reports the rolled species for the reveal', r.speciesId && r.name);
  check('nothing is written to the save when both are full', JSON.stringify(e.MARKETPLACE.read('dino_park_u1')), before);
}
{
  const e = envWith({});
  const r = await grantDino(e, null, { source: 'giftsub' });
  check('an anonymous grant is reveal-only', r.granted, false);
  check('placed is none', r.placed, 'none');
  ok('it still returns a species to announce', r.speciesId && r.name && r.icon);
  check('and writes no save', e.MARKETPLACE.read('dino_park_u1'), null);
}
{
  const e = envWith({});
  const r = await grantDino(e, 'newbie', { rarity: 'epic' });
  check('a viewer with no save yet gets one created', e.MARKETPLACE.read('dino_park_newbie').state.park.length, 1);
  check('at the current save epoch so the client keeps it', e.MARKETPLACE.read('dino_park_newbie').state.saveEpoch, SAVE_EPOCH);
}

/* ══ runDinoHatch — orchestration ══════════════════════════════════════ */
{
  const e = envWith({ dino_hatch_config: { enabled: false } });
  const res = await runDinoHatch(e, { userId: 'u1', displayName: 'Gifter', count: 2, source: 'giftsub' });
  check('a disabled minigame does not fire', res.fired, false);
  check('and pushes no overlay event', e.MARKETPLACE.read('overlay_events'), null);
}
{
  const e = envWith({ dino_park_u1: saveWith({}) });   // enabled by default
  const res = await runDinoHatch(e, { userId: 'u1', displayName: 'Gifter', count: 3, source: 'giftsub' });
  check('a gift bomb of 3 fires', res.fired, true);
  check('and grants all three', res.granted, 3);
  const ov = e.MARKETPLACE.read('overlay_events');
  check('exactly one overlay event is pushed (one animation)', ov.events.length, 1);
  const ev = ov.events[0];
  check('the event is a dino-hatch', ev.type, 'dino-hatch');
  check('it names the triggerer', ev.who, 'Gifter');
  check('it carries the roll count', ev.count, 3);
  check('and all three results for the batch reveal', ev.results.length, 3);
  ok('each result has what the overlay renders', ev.results.every(r => r.speciesId && r.name && r.rarity && 'icon' in r));
  check('the park received three dinos', e.MARKETPLACE.read('dino_park_u1').state.park.length, 3);
}
{
  // Both full -> the hatched dino is held as an inventory egg, pinned to species.
  const park = Array.from({ length: 10 }, (_, i) => dummyDino(i));
  const vault = Array.from({ length: 200 }, (_, i) => dummyDino(i));
  const e = envWith({ dino_park_u1: saveWith({ park, vault }) });
  const res = await runDinoHatch(e, { userId: 'u1', displayName: 'Gifter', count: 1, source: 'channel-points' });
  check('a full park+vault still counts as granted (held as an egg)', res.granted, 1);
  const inv = e.MARKETPLACE.read('inv_u1');
  check('an inventory egg is created', inv.items.length, 1);
  const egg = inv.items[0];
  check('it is a dino-park egg', [egg.game, egg.type].join('/'), 'dino-park/egg');
  ok('pinned to the exact rolled species', egg.meta && egg.meta.speciesId === res.results[0].speciesId);
  ok('and marked guaranteed so useInventoryEgg honours it', egg.meta && egg.meta.guaranteed === true);
  const ov = e.MARKETPLACE.read('overlay_events');
  check('the reveal still shows the dino', ov.events[0].results[0].speciesId, res.results[0].speciesId);
}
{
  // Anonymous gifter: reveal fires, nothing granted, no save written.
  const e = envWith({});
  const res = await runDinoHatch(e, { userId: null, displayName: 'An anonymous gifter', count: 2, source: 'giftsub' });
  check('an anonymous hatch fires', res.fired, true);
  check('but grants nothing', res.granted, 0);
  const ov = e.MARKETPLACE.read('overlay_events');
  check('the overlay still announces it', ov.events[0].who, 'An anonymous gifter');
  check('with both rolls shown', ov.events[0].results.length, 2);
}
{
  // The toggle round-trips.
  const e = envWith({});
  check('default config is on', (await getHatchConfig(e)).enabled, true);
  await setHatchConfig(e, { enabled: false });
  check('setHatchConfig turns it off', (await getHatchConfig(e)).enabled, false);
  await setHatchConfig(e, { enabled: true });
  check('and back on', (await getHatchConfig(e)).enabled, true);
}

/* ══ Report ════════════════════════════════════════════════════════════ */
if (failures.length) {
  console.error(`\n  ✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('    ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  ✓ all ${passed} dino-hatch checks passed\n`);
