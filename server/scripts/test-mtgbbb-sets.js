#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MTGBBB SET DATA — test suite

     node server/scripts/test-mtgbbb-sets.js

   RUNS OFFLINE, AGAINST CAPTURED FIXTURES. Scryfall is free, unauthenticated
   and run by other people; a test suite that called it would hammer it on
   every commit and would go red the day their service had a bad afternoon.

   The fixtures in scripts/fixtures/ are real Scryfall responses captured in
   September 2026, trimmed to the fields the deriver actually reads. Field
   names and value shapes are verbatim — that is the whole point of a
   fixture, and every filter below is a claim about real Magic data:

     scryfall-sets.json         GET /sets, all 1049 of them
     scryfall-blb-prints.json   Bloomburrow — Booster Fun variants that DO
                                come out of Play Boosters are flagged
                                `booster: false`, and six rares exist only
                                in starter decks
     scryfall-tla-prints.json   Avatar — the opposite convention, variants
                                flagged `booster: true`; also double-faced
                                cards, whose images hide inside card_faces
     scryfall-dsk-prints.json   Duskmourn — the richest treatment table
     scryfall-fin-prints.json   Final Fantasy — sixteen ffI..ffXVI promo
                                tags sitting on ordinary cards, the exact
                                noise that must not become sixteen chips
     scryfall-tmt-prints.json   a set with no booster data published yet

   WHAT THIS IS GUARDING. The pool is what a player's 25 squares are drawn
   from and the treatment table is what the moderator can tick for a point.
   A filter that is slightly wrong here does not throw — it quietly puts a
   card nobody can pull onto sixty bingo cards, or offers a chip worth a
   point that no pack can produce, and nobody finds out until a box is open
   on camera.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as M from '../../functions/api/mtgbbb-scryfall.js';
import { SQUARES, buildCard } from '../../functions/api/mtgbbb-scoring.js';
import { resolveKey } from '../lib/registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const read = f => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const SET_OBJECTS = read('scryfall-set-objects.json');
const prints = code => read(`scryfall-${code}-prints.json`);
const derive = code => M.deriveSetData(prints(code), SET_OBJECTS[code]);

const DSK = derive('dsk');
const BLB = derive('blb');
const TLA = derive('tla');
const FIN = derive('fin');
const TMT = derive('tmt');

const ids = data => data.treatments.map(t => t.id);
const has = (data, id) => ids(data).includes(id);

/* ── The dropdown ────────────────────────────────────────────────────── */
{
  /* Frozen so the horizon test below is not a time bomb: with a real clock
     this suite would start failing the day the fixture's newest set aged
     past its release date. */
  const NOW = Date.parse('2026-09-16T00:00:00Z');
  const all = read('scryfall-sets.json').data;
  const sets = M.derivePlayableSets(all, NOW);

  ok('the fixture is the whole set list', all.length > 1000);
  ok('most of it is filtered out', sets.length < all.length / 4);

  const types = [...new Set(sets.map(s => s.setType))].sort();
  check('only set types that ship in boosters survive', types,
    ['core', 'draft_innovation', 'expansion', 'funny', 'masters']);

  /* These four are the categories that make the list unusable: 298 promo
     sets, 213 token sets and 99 memorabilia sets would bury the twenty
     sets anyone would actually open. */
  for (const bad of ['promo', 'token', 'memorabilia', 'commander']) {
    check(`no ${bad} sets`, sets.filter(s => s.setType === bad).length, 0);
  }

  check('nothing digital-only', sets.filter(s => s.digital).length, 0);

  /* A sub-set is a slice of another set — Timeshifts, Jumpstart
     exclusives, foreign black border. It is not a box you can buy. */
  const codes = new Set(sets.map(s => s.code));
  ok('sub-sets are gone (tsb, Time Spiral Timeshifted)', !codes.has('tsb'));
  ok('sub-sets are gone (j25, Foundations Jumpstart)', !codes.has('j25'));

  /* Welcome decks and gift packs carry a playable set_type and a dozen
     cards. The real guard is the pool count, but they have no business in
     a dropdown either. */
  ok('welcome decks are gone (w16, 16 cards)', !codes.has('w16'));

  for (const c of ['dsk', 'blb', 'tla', 'fin', 'dft', 'mh3', 'fdn']) {
    ok(`${c} is offered`, codes.has(c));
  }

  /* Newest first — the set being opened tonight is almost always the one
     that came out this month, and a moderator should not scroll for it. */
  const dates = sets.map(s => s.releasedAt);
  check('sorted newest first', dates.slice().sort().reverse(), dates);

  /* Spoiler season is not pack data. A set six weeks out has a partial,
     wrong pool; one inside the grace window has boxes in hand. */
  const future = sets.filter(s => Date.parse(s.releasedAt) > NOW);
  ok('near-future sets are listed (prerelease)', future.length > 0);
  ok('far-future sets are not', sets.every(
    s => Date.parse(s.releasedAt) <= NOW + 31 * 86400000));

  const dsk = sets.find(s => s.code === 'dsk');
  check('label is CODE — Set Name', dsk.label, 'DSK — Duskmourn: House of Horror');
  check('code is lowercase for the API', dsk.code, 'dsk');
  ok('and the icon comes along for the dropdown', dsk.icon.length > 0);

  check('no duplicate codes', sets.length, new Set(sets.map(s => s.code)).size);
}

/* ── The pool ────────────────────────────────────────────────────────── */
{
  /* 60 rare + 20 mythic is the standard modern set, and it is what the
     plan's odds table assumes. Three sets built by three different design
     teams landing on exactly that is the check that `booster: true` is
     selecting the base set and nothing else. */
  for (const [name, d] of [['dsk', DSK], ['blb', BLB], ['tla', TLA]]) {
    check(`${name}: 60 rare, 20 mythic`,
      { rare: d.counts.rare, mythic: d.counts.mythic }, { rare: 60, mythic: 20 });
    check(`${name}: 80 squares to draw from`, d.cards.length, 80);
  }

  check('a card name appears once however many printings it has',
    BLB.cards.length, new Set(BLB.cards.map(c => c.name)).size);

  /* BLOOMBURROW IS THE REASON THE POOL AND THE TREATMENTS COME FROM
     DIFFERENT PLACES. All 87 of its Booster Fun prints — borderless,
     showcase, extended art, the ones people actually cheer for — are
     flagged `booster: false`. If the pool trusted that flag it would still
     be right, because those are variants of names already in it; if the
     treatment table trusted it, the entire table would be empty. */
  const raw = prints('blb');
  const bf = raw.filter(c => (c.promo_types || []).includes('boosterfun'));
  check('blb: 87 Booster Fun prints', bf.length, 87);
  check('and Scryfall flags every one of them as not-in-booster',
    bf.filter(c => c.booster).length, 0);
  ok('yet blb has a treatment table', BLB.treatments.length > 3);
  ok('including borderless', has(BLB, 'borderless'));
  ok('and showcase', has(BLB, 'showcase'));

  /* The other half of the same flag: six Bloomburrow rares exist only in
     starter decks. They are real cards in the set and cannot come out of a
     pack, so putting one on a bingo square would make that square
     permanently unmarkable. */
  const names = new Set(BLB.cards.map(c => c.name));
  for (const n of ['Bria, Riptide Rogue', 'Serra Redeemer', 'Sword of Vengeance']) {
    ok(`starter-deck-only card is not on the card: ${n}`, !names.has(n));
  }

  /* Avatar uses the opposite convention — variants ARE flagged
     `booster: true` — and must collapse to the same 80 names anyway. */
  check('tla: variants flagged in-booster still collapse to 80 names',
    TLA.cards.length, 80);
  check('tla: 174 prints behind those 80 names', TLA.counts.prints, 174);

  /* The pool feeds buildCard directly, so the two modules have to agree on
     the shape: a flat array of distinct ids. */
  const pool = DSK.cards.map(c => c.name);
  const card = buildCard(pool, 'ROOM:viewer-1');
  check('buildCard fills a grid from the pool', card.length, SQUARES);
  check('with 25 distinct names', new Set(card).size, SQUARES);
  ok('all drawn from the pool', card.every(n => pool.includes(n)));
  check('and the same seed draws the same card',
    buildCard(pool, 'ROOM:viewer-1'), card);
  ok('a different player gets a different one',
    JSON.stringify(buildCard(pool, 'ROOM:viewer-2')) !== JSON.stringify(card));
}

/* ── Images ──────────────────────────────────────────────────────────── */
{
  /* A square with no image is a blank tile on sixty players' screens. */
  for (const [name, d] of [['dsk', DSK], ['blb', BLB], ['tla', TLA], ['fin', FIN]]) {
    check(`${name}: every card has a grid image`,
      d.cards.filter(c => !c.image).map(c => c.name), []);
    check(`${name}: every card has a large image for the pull alert`,
      d.cards.filter(c => !c.art).map(c => c.name), []);
    check(`${name}: every card links back to Scryfall`,
      d.cards.filter(c => !c.url).map(c => c.name), []);
  }

  /* Double-faced cards carry NO top-level image_uris — the images live in
     card_faces[0]. Reading the wrong one gives every transforming card in
     the set an empty tile, which in a set like Avatar is a quarter of the
     mythics. */
  const dfc = TLA.cards.find(c => c.name === 'The Legend of Yangchen // Avatar Yangchen');
  ok('the double-faced card is in the pool', !!dfc);
  ok('and got its image from the front face', dfc.image.includes('cards.scryfall.io'));

  ok('the grid image is the small one', DSK.cards[0].image.includes('/small/'));
  ok('the pull image is the larger one', DSK.cards[0].art.includes('/normal/'));
}

/* ── Treatments: what must NOT be one ────────────────────────────────── */
{
  /* frame_effects is mostly mechanical frame markers, and they sit on
     ordinary black-bordered cards. `legendary` alone is on 75 Avatar
     prints. Offering it as a chip would pay a point for every legendary
     creature in the box — which is most of the mythics. */
  for (const [name, d] of [['dsk', DSK], ['blb', BLB], ['tla', TLA], ['fin', FIN]]) {
    for (const junk of ['legendary', 'enchantment', 'devoid', 'lesson', 'spree']) {
      ok(`${name}: ${junk} is a frame, not a treatment`, !has(d, junk));
    }
  }

  /* Every card in Avatar and Final Fantasy is a Universes Beyond card, so
     it distinguishes nothing. */
  ok('tla: universesbeyond is not a treatment', !has(TLA, 'universesbeyond'));
  ok('fin: universesbeyond is not a treatment', !has(FIN, 'universesbeyond'));

  /* SIXTEEN of them, one per Final Fantasy title, sitting on plain cards.
     This is the case that decided the design: a hardcoded ignore list would
     have to be edited every time a crossover set invents new tags, so the
     baseline is derived from the set's own plain printings instead and
     these vanish without being named. */
  const ffTags = [...new Set(prints('fin').flatMap(c => c.promo_types || []))]
    .filter(p => /^ff[ivx]+$/.test(p));
  check('fin: sixteen ffN tags exist in the data', ffTags.length, 16);
  check('and none of them became a treatment',
    ids(FIN).filter(id => /^ff[ivx]+$/.test(id)), []);

  /* An umbrella marker sitting on every borderless, showcase and
     extended-art print. Scoring it would pay twice for one treatment. */
  for (const [name, d] of [['dsk', DSK], ['blb', BLB], ['tla', TLA]]) {
    ok(`${name}: boosterfun is not itself a treatment`, !has(d, 'boosterfun'));
  }

  /* The plan is explicit: serialized cards are not in Play Boosters, so
     the chip must not exist to be misticked. */
  ok('fin has a serialized print in the data',
    prints('fin').some(c => (c.promo_types || []).includes('serialized')));
  ok('and serialized is still not offered', !has(FIN, 'serialized'));

  /* Products that are not packs. Their names are already out of the pool;
     their treatments must be out of the table too. */
  for (const junk of ['starterdeck', 'bundle', 'buyabox', 'prerelease', 'boxtopper']) {
    ok(`blb: ${junk} is not a treatment`, !has(BLB, junk));
    ok(`dsk: ${junk} is not a treatment`, !has(DSK, junk));
  }

  ok('nonfoil is not a treatment — it is the default', !has(DSK, 'nonfoil'));
}

/* ── Treatments: what must be one ────────────────────────────────────── */
{
  /* Foil is the one treatment every set has and the one most often
     ticked. It comes from `finishes`, not from a variant printing, because
     any card can come out foil. */
  for (const [name, d] of [['dsk', DSK], ['blb', BLB], ['tla', TLA], ['fin', FIN]]) {
    ok(`${name}: foil is offered`, has(d, 'foil'));
    ok(`${name}: borderless is offered`, has(d, 'borderless'));
    ok(`${name}: extended art is offered`, has(d, 'extendedart'));
    ok(`${name}: the table is not empty`, d.treatments.length >= 4);
  }

  ok('dsk: double exposure', has(DSK, 'doubleexposure'));
  ok('dsk: japanese showcase', has(DSK, 'japanshowcase'));
  ok('dsk: full art', has(DSK, 'fullart'));
  ok('tla: textless', has(TLA, 'textless'));
  ok('tla: neon ink', has(TLA, 'neonink'));
  ok('blb: raised foil', has(BLB, 'raisedfoil'));

  /* Every chip is worth one point, flat — the plan considered a
     frequency-ranked ladder and rejected it, because treatments stack and
     a ladder would let one lucky pack outweigh a completed line. So there
     is deliberately no `points` field here for a room to freeze. */
  check('no treatment carries its own point value',
    DSK.treatments.filter(t => 'points' in t || 'value' in t).length, 0);

  /* Read live, on camera, at the pace of a pack every twenty seconds.
     `surgefoil` is not a thing anyone can scan at that speed. */
  check('labels are human-readable, not Scryfall enums',
    DSK.treatments.filter(t => t.label === t.id).map(t => t.id), []);
  check('foil reads as Foil',
    DSK.treatments.find(t => t.id === 'foil').label, 'Foil');
  check('japanshowcase reads as Japanese Showcase',
    DSK.treatments.find(t => t.id === 'japanshowcase').label, 'Japanese Showcase');

  /* Play Booster treatments first, then by how many printings carry them:
     the chips reached for most sit nearest the front of the panel. */
  const order = DSK.treatments.map(t => t.collectorOnly);
  check('collector-only chips sort to the back',
    order.slice().sort((a, b) => (a === b ? 0 : a ? 1 : -1)), order);
  ok('fracture foil is marked collector-only',
    DSK.treatments.find(t => t.id === 'fracturefoil').collectorOnly);
  ok('borderless is not',
    !DSK.treatments.find(t => t.id === 'borderless').collectorOnly);

  ok('every treatment says how many printings carry it',
    DSK.treatments.every(t => Number.isInteger(t.prints) && t.prints > 0));
  check('no treatment is listed twice',
    DSK.treatments.length, new Set(ids(DSK)).size);
}

/* ── Labels for things that do not exist yet ─────────────────────────── */
{
  check('a known enum', M.treatmentLabel('extendedart'), 'Extended Art');
  check('another', M.treatmentLabel('stepandcompleat'), 'Step-and-Compleat Foil');

  /* A set invented next spring will carry a promo type nobody has written
     a label for. Dropping it would silently cost a player a point they
     earned; showing `zanyfoil` would cost the moderator a second they do
     not have. */
  check('an unknown enum still splits into words', M.treatmentLabel('zanyfoil'), 'Zany Foil');
  check('and another', M.treatmentLabel('spookyframe'), 'Spooky Frame');
  check('a wholly unrecognisable one is at least capitalised',
    M.treatmentLabel('wibble'), 'Wibble');
  check('and nothing throws on nonsense', M.treatmentLabel(''), '');
}

/* ── The under-25 guard ──────────────────────────────────────────────── */
{
  /* TMT is a real set whose pack data Scryfall has not published: 158
     prints in the set, zero flagged as in-booster. Without this guard the
     room would open, buildCard would throw on the first join, and the
     moderator would find out with the stream live. */
  check('a set with no booster data has no pool', TMT.cards.length, 0);
  check('and is not playable', TMT.playable, false);
  ok('and the refusal says why, not just "too small"',
    /unreleased/i.test(M.unplayableReason(TMT)));

  check('the threshold is a full grid', M.MIN_POOL, SQUARES);
  ok('a real set clears it', DSK.playable);

  /* A set one card short is still refused. The failure it prevents is a
     grid with a hole in it, discovered after sixty people have joined. */
  const short = M.deriveSetData(
    prints('dsk').filter((c, i) => i < 3 || !c.booster), SET_OBJECTS.dsk);
  ok('a pool below 25 is refused', !short.playable);
  ok('and the reason names the shortfall',
    M.unplayableReason(short).includes(String(short.counts.total)));

  let threw = false;
  try { buildCard(TMT.cards.map(c => c.name), 'ROOM:viewer'); } catch { threw = true; }
  ok('and the scoring module refuses it too', threw);
}

/* ── Storage: the prefix trap ────────────────────────────────────────── */
{
  /* `mtgbbb_set_` lives inside `mtgbbb_`. Longest prefix wins, and if it
     did not, every cached set pool would be filed as a game room — and
     then expired out from under itself, because rooms have a real TTL and
     a set pool is permanent. This is the item_code_queue-inside-item_code_
     shape, and it is tested rather than commented. */
  check('a set pool resolves to its own table',
    resolveKey('mtgbbb_set_DSK'), { table: 'mtgbbb_sets', expiry: 'none' });
  check('a room resolves to its own table',
    resolveKey('mtgbbb_ABCD'), { table: 'mtgbbb_rooms', expiry: 'real' });

  /* Same shape one level up: the dropdown cache is an exact key that
     begins with `mtgbbb_`, and exact keys are resolved before prefixes. */
  check('the set index is a singleton, not a room',
    resolveKey('mtgbbb_sets_index'), { table: 'singletons', expiry: 'real' });

  check('and the cache key is the one the plan specifies',
    M.setCacheKey('dsk'), 'mtgbbb_set_DSK');
  ok('which is inside the set family, not the room family',
    resolveKey(M.setCacheKey('dsk')).table === 'mtgbbb_sets');

  ok('MTGBBB does not touch Commander Bingo',
    resolveKey('bingo_ABCD').table === 'bingo_rooms');
}

/* ── Report ──────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n  MTGBBB set data: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`  MTGBBB set data: ${passed} assertions passed`);
