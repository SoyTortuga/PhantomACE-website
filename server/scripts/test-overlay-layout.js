#!/usr/bin/env node
/* ══════════════════════════════════════════════
   OVERLAY LAYOUT — the persistence behind the drag editor

     node server/scripts/test-overlay-layout.js

   The layout is data every OBS source reads to place its panels, so the
   route's job is: only staff may write it, only known panels are stored,
   and every coordinate is clamped inside the canvas — a save can never
   push a panel off-screen or invent a panel the overlay does not have. GET
   is public because the overlay reads it without a session; that is the
   design, not an oversight, so it is asserted too.

   The apply/edit halves are pinned by source check: the live overlay and
   the editor must position panels through the SAME applyOne, or "what you
   drag is what airs" quietly stops being true.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet, onRequestPost, validatePanels } from '../../functions/api/overlay/layout.js';

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

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list() { return { keys: [] }; },
  };
}
const env = (seed = {}) => ({
  MARKETPLACE: fakeKV({ site_moderators: { entries: [{ userId: '222' }] }, ...seed }),
  TWITCH_BROADCASTER_ID: '111',
});
const as = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) });
const GET = (e, h) => onRequestGet({ env: e, request: new Request('https://x/api/overlay/layout', { headers: h }) });
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/overlay/layout', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });

const good = { ovScramble: { x: 5, y: 70 }, ovMaze: { x: 60, y: 12 } };

/* ══ Who may write ═════════════════════════════════════════════════════ */
{
  const e = env();
  check('anonymous cannot save', (await POST(e, { action: 'save', panels: good })).status, 401);
  check('a viewer cannot save', (await POST(e, { action: 'save', panels: good }, as('999'))).status, 403);
  check('a moderator can', (await POST(e, { action: 'save', panels: good }, as('222'))).status, 200);
  check('and the broadcaster can', (await POST(e, { action: 'save', panels: good }, as('111'))).status, 200);
}

/* ══ GET is public, and flags staff for the editor ═════════════════════ */
{
  const e = env({ overlay_layout: { panels: good } });
  const anon = await (await GET(e)).json();
  check('anyone can read the layout', anon.panels, good);
  check('an anonymous reader is not staff', anon.staff, false);
  check('a moderator is', (await (await GET(e, as('222'))).json()).staff, true);
}

/* ══ Validation: known panels, clamped coords ══════════════════════════ */
{
  /* Unknown panel ids are dropped, not stored — a save cannot invent a
     panel the overlay has no element for. */
  const mixed = validatePanels({ ovMaze: { x: 10, y: 20 }, ovGhost: { x: 5, y: 5 } });
  check('a known panel survives, with a default scale', mixed.panels.ovMaze, { x: 10, y: 20, s: 1 });
  ok('an unknown panel is dropped', !('ovGhost' in mixed.panels));

  /* Off-canvas coordinates are clamped to the 0–96 band, not rejected —
     a fat-fingered drag past the edge should land at the edge, not fail. */
  const far = validatePanels({ ovMaze: { x: 200, y: -40 } });
  check('x past the edge clamps', far.panels.ovMaze.x, 96);
  check('y before the edge clamps', far.panels.ovMaze.y, 0);

  /* Non-numbers are skipped rather than stored as NaN. */
  const junk = validatePanels({ ovMaze: { x: 'left', y: 10 }, ovMtg: { x: 3, y: 4 } });
  ok('a non-numeric coord drops that panel', !('ovMaze' in junk.panels));
  check('while a valid sibling stays', junk.panels.ovMtg, { x: 3, y: 4, s: 1 });

  check('an empty map is refused', 'error' in validatePanels({}), true);
}

/* ══ Scale: stored, defaulted, clamped ═════════════════════════════════ */
{
  /* Absent scale means 1 — the layout is scale-optional per panel. */
  const plain = validatePanels({ ovMaze: { x: 10, y: 20 } });
  check('a panel with no scale defaults to 1', plain.panels.ovMaze.s, 1);

  const scaled = validatePanels({ ovMaze: { x: 10, y: 20, s: 1.5 } });
  check('a given scale is kept', scaled.panels.ovMaze.s, 1.5);

  /* Bounded 0.3–3 so a fat-fingered corner drag cannot make a panel
     unrecoverably tiny or swallow the screen. */
  check('a huge scale clamps to 3', validatePanels({ ovMaze: { x: 1, y: 1, s: 99 } }).panels.ovMaze.s, 3);
  check('a tiny scale clamps to 0.3', validatePanels({ ovMaze: { x: 1, y: 1, s: 0.01 } }).panels.ovMaze.s, 0.3);
  check('a non-numeric scale falls back to 1', validatePanels({ ovMaze: { x: 1, y: 1, s: 'big' } }).panels.ovMaze.s, 1);
}

/* ══ Save round-trips; reset clears ════════════════════════════════════ */
{
  const e = env();
  await POST(e, { action: 'save', panels: good }, as('222'));
  const stored = e.MARKETPLACE.read('overlay_layout');
  check('the save persisted the panels with default scale', stored.panels,
        { ovScramble: { x: 5, y: 70, s: 1 }, ovMaze: { x: 60, y: 12, s: 1 } });
  check('and recorded the author', stored.updatedBy, 'U222');

  await POST(e, { action: 'reset' }, as('222'));
  check('reset clears the layout', e.MARKETPLACE.read('overlay_layout'), null);
  check('and GET then returns empty', (await (await GET(e)).json()).panels, {});
}

/* ══ Wiring: one applyOne, shared samples, live read on boot ═══════════ */
{
  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('overlay_layout is registered', /overlay_layout:\s*\{ table: 'singletons', expiry: 'none' \}/.test(reg));

  const apply = fs.readFileSync(path.join(REPO, 'js/pages/overlay-apply-layout.js'), 'utf8');
  ok('apply normalises to top-left', /el\.style\.left = x \+ '%'/.test(apply) && /el\.style\.right = 'auto'/.test(apply));
  ok('and clears centring transforms when unscaled', /scale === 1 \? 'none'/.test(apply));
  ok('the live overlay reads the layout on boot', /fetch\('\/api\/overlay\/layout'/.test(apply));
  ok('and stands down when the editor manages it', /__ovLayoutManaged/.test(apply));

  const editor = fs.readFileSync(path.join(REPO, 'js/pages/overlay-editor.js'), 'utf8');
  ok('the editor drags via the overlay\'s own applyOne',
     /win\.OverlayLayout && win\.OverlayLayout\.applyOne/.test(editor));
  ok('and tells the iframe not to double-fetch', /__ovLayoutManaged = true/.test(editor));
  ok('coordinates are stored as canvas percentages', /CANVAS_W = 1920, CANVAS_H = 1080/.test(editor));
  ok('the editor resizes via a corner handle', /addResizeHandle/.test(editor));
  ok('and collects each panel scale', /s: Number\(el\.dataset\.ps\) \|\| 1/.test(editor));

  ok('apply scales from the top-left so the pin holds',
     /transformOrigin = 'top left'/.test(apply) && /scale\(' \+ scale \+ '\)/.test(apply));

  const ov = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay loads the samples and applier', /overlay-samples\.js/.test(ov) && /overlay-apply-layout\.js/.test(ov));

  /* The legend is drawn from the same PANELS list the editor drags and the
     route stores, so it cannot document a panel that does not exist or miss
     one that does. And it must name the thing the broadcaster caught: an
     MTGBBB pull surfaces in the ALERTS window, not the MTGBBB panel. */
  const samples = fs.readFileSync(path.join(REPO, 'js/pages/overlay-samples.js'), 'utf8');
  ok('every panel declares what it holds',
     (samples.match(/holds: \[/g) || []).length === 5);
  ok('the alerts entry documents MTGBBB pulls landing there',
     /PULLS show here/.test(samples));
  ok('and drops, subs, raids, hype and bingo', /gift subs/.test(samples) && /Hype train/.test(samples) && /bingo & blackout/i.test(samples));

  const eEd = fs.readFileSync(path.join(REPO, 'js/pages/overlay-editor.js'), 'utf8');
  ok('the editor renders the legend from PANELS', /function renderLegend/.test(eEd) && /window\.OverlaySamples && window\.OverlaySamples\.PANELS/.test(eEd));
  const eHtml = fs.readFileSync(path.join(REPO, 'overlay-editor.html'), 'utf8');
  ok('the editor page has a legend column', /id="legendBody"/.test(eHtml));
  ok('and loads the shared samples for it', /overlay-samples\.js/.test(eHtml));

  const ids = [...samples.matchAll(/id: '(ov\w+)'/g)].map(m => m[1]).sort();
  /* The panel list the editor drags must match the ids the route stores,
     or a panel can be arranged and then silently not saved. */
  ok('the sample panel ids are exactly the stored ones',
     JSON.stringify(ids) === JSON.stringify(['ovMaze', 'ovMc', 'ovMtg', 'ovScramble', 'ovStage']));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[overlay-layout] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[overlay-layout] ${passed} assertions passed.`);
console.log('');
