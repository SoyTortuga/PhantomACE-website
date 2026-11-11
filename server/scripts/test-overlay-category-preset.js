#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CATEGORY-BOUND OVERLAY PRESETS

     node server/scripts/test-overlay-category-preset.js

   A layout preset can be bound to a Twitch category (Music -> "Drumstream").
   When channel.update moves the category, that preset goes live, and the
   overlay re-applies it WITHOUT reloading the OBS source.

   THE THREE THINGS THAT BREAK THIS, pinned below:
     1. A save/reset rewrites a preset wholesale — it must not quietly drop
        the binding, or the auto-switch stops working with nothing to show why.
     2. Two presets bound to one category would make the swap a coin toss.
     3. A live swap must CLEAR the previous preset's inline styles. applyAll
        only touches panels it is given, so a panel the old preset placed or
        hid and the new one never mentions would stay stuck there forever.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  onRequestGet, onRequestPost, activateForCategory, layoutVersion,
} from '../../functions/api/overlay/layout.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

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
  };
}
const env = (seed = {}) => ({
  MARKETPLACE: fakeKV({ site_moderators: { entries: [{ userId: '222' }] }, ...seed }),
  TWITCH_BROADCASTER_ID: '111',
});
const as = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) });
const GET = (e, h, qs) => onRequestGet({ env: e, request: new Request('https://x/api/overlay/layout' + (qs || ''), { headers: h }) });
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/overlay/layout', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });

/* Two saved presets to bind between. */
async function seeded() {
  const e = env();
  await POST(e, { action: 'save', name: 'Default', panels: { ovScramble: { x: 5, y: 70 } } }, as('111'));
  await POST(e, { action: 'save', name: 'Drumstream', panels: { ovMaze: { x: 60, y: 12 } } }, as('111'));
  await POST(e, { action: 'activate', name: 'Default' }, as('111'));
  return e;
}

/* ══ 1. BINDING ═════════════════════════════════ */
{
  const e = await seeded();
  check('a viewer cannot bind', (await POST(e, { action: 'bind', name: 'Drumstream', category: 'Music' }, as('999'))).status, 403);

  const r = await POST(e, { action: 'bind', name: 'Drumstream', category: 'Music' }, as('111'));
  check('staff can bind a preset to a category', r.status, 200);
  check('the binding is stored on the preset', e.MARKETPLACE.read('overlay_layout').presets.Drumstream.category, 'Music');

  check('binding an unknown preset is 404',
    (await POST(e, { action: 'bind', name: 'Nope', category: 'Chess' }, as('111'))).status, 404);

  /* One category, one preset — otherwise the swap is a coin toss. */
  const dup = await POST(e, { action: 'bind', name: 'Default', category: 'music' }, as('111'));
  check('a second preset cannot take the same category', dup.status, 400);

  const un = await POST(e, { action: 'bind', name: 'Drumstream', category: '' }, as('111'));
  check('an empty category unbinds', un.status, 200);
  check('and the binding is gone', e.MARKETPLACE.read('overlay_layout').presets.Drumstream.category, '');
}

/* ══ 2. THE SWAP ════════════════════════════════ */
{
  const e = await seeded();
  await POST(e, { action: 'bind', name: 'Drumstream', category: 'Music' }, as('111'));

  const hit = await activateForCategory(e, 'Music');
  check('entering the bound category makes it live', [hit.changed, hit.active], [true, 'Drumstream']);
  check('and it is what the overlay is served', (await (await GET(e)).json()).active, 'Drumstream');

  /* Twitch capitalises inconsistently and pads; the binding must not care. */
  const e2 = await seeded();
  await POST(e2, { action: 'bind', name: 'Drumstream', category: 'Music' }, as('111'));
  check('matching ignores case and whitespace', (await activateForCategory(e2, '  mUsIc ')).active, 'Drumstream');

  /* Already live: no write, so the version does not churn and the overlay
     does not re-apply for nothing. */
  const before = (await layoutVersion(e)).ver;
  const again = await activateForCategory(e, 'Music');
  check('re-entering the same category is a no-op', again.changed, false);
  check('and the version does not move', (await layoutVersion(e)).ver, before);
}

/* ══ 3. LEAVING: FALLBACK OR LEAVE ALONE ════════ */
{
  const e = await seeded();
  await POST(e, { action: 'bind', name: 'Drumstream', category: 'Music' }, as('111'));
  await activateForCategory(e, 'Music');

  /* With no fallback set, an unbound category leaves the live preset alone
     rather than blanking the overlay. */
  const stay = await activateForCategory(e, 'Just Chatting');
  check('no fallback: the live preset is left alone', [stay.changed, stay.matched], [false, false]);
  check('still showing the game preset', e.MARKETPLACE.read('overlay_layout').active, 'Drumstream');

  const fb = await POST(e, { action: 'fallback', name: 'Default' }, as('111'));
  check('staff can set a fallback', fb.status, 200);
  const left = await activateForCategory(e, 'Just Chatting');
  check('with a fallback, leaving reverts to it', [left.changed, left.active], [true, 'Default']);

  check('an unknown fallback is 404', (await POST(e, { action: 'fallback', name: 'Nope' }, as('111'))).status, 404);
  check('an empty fallback clears it', (await POST(e, { action: 'fallback', name: '' }, as('111'))).status, 200);
  check('and it is cleared', e.MARKETPLACE.read('overlay_layout').fallback, '');
}

/* ══ 4. A SAVE MUST NOT DROP THE BINDING ════════ */
{
  const e = await seeded();
  await POST(e, { action: 'bind', name: 'Drumstream', category: 'Music' }, as('111'));

  await POST(e, { action: 'save', name: 'Drumstream', panels: { ovMaze: { x: 10, y: 10 } } }, as('111'));
  check('re-saving a preset keeps its binding', e.MARKETPLACE.read('overlay_layout').presets.Drumstream.category, 'Music');

  await POST(e, { action: 'reset', name: 'Drumstream' }, as('111'));
  check('resetting a preset keeps its binding too', e.MARKETPLACE.read('overlay_layout').presets.Drumstream.category, 'Music');

  /* A deleted preset must not leave the fallback pointing at a ghost. */
  await POST(e, { action: 'fallback', name: 'Default' }, as('111'));
  await POST(e, { action: 'delete', name: 'Default' }, as('111'));
  check('deleting the fallback preset clears the fallback', e.MARKETPLACE.read('overlay_layout').fallback || '', '');
}

/* ══ 5. THE VERSION THE OVERLAY WATCHES ═════════ */
{
  const e = await seeded();
  const v0 = (await layoutVersion(e)).ver;
  ok('the public GET carries a version', typeof (await (await GET(e)).json()).ver === 'number');
  await POST(e, { action: 'activate', name: 'Drumstream' }, as('111'));
  ok('a plain activate bumps the version', (await layoutVersion(e)).ver > v0);

  const full = await (await GET(e, as('111'), '?full=1')).json();
  ok('the editor is told the fallback', Object.prototype.hasOwnProperty.call(full, 'fallback'));
}

/* ══ 6. WIRING ══════════════════════════════════ */
{
  const ev = read('functions/api/overlay/events.js');
  ok('the poll carries layoutVer', /layoutVer/.test(ev) && /layoutVersion/.test(ev));

  const cu = read('functions/api/channel-update.js');
  ok('channel.update switches the bound preset', /activateForCategory/.test(cu));
  ok('and only when it actually wrote', /if \(wrote && rec\)[\s\S]{0,400}activateForCategory/.test(cu));

  const ap = read('js/pages/overlay-apply-layout.js');
  ok('the applier clears panels the new preset drops', /function clearOne/.test(ap) && /applied/.test(ap));
  ok('and exposes refresh() for a live swap', /refresh:\s*refresh/.test(ap));
  ok('with a concurrency guard so polls cannot stack fetches', /inFlight/.test(ap));

  const ov = read('js/pages/overlay.js');
  ok('the overlay re-applies when the version moves', /applyLayoutVer/.test(ov));
  ok('driven from the poll', /applyLayoutVer\(data\.layoutVer\)/.test(ov));

  const dash = read('overlay-dashboard.html');
  ok('the editor has a bind control', /id="bindCategory"/.test(dash) && /id="bindBtn"/.test(dash));
  ok('and a fallback picker', /id="fallbackSelect"/.test(dash));
}

console.log('');
if (failures.length) {
  console.log(`[overlay-category-preset] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[overlay-category-preset] ${passed} assertions passed.`);
