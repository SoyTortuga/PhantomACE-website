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
import vm from 'node:vm';
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
const GET = (e, h, qs) => onRequestGet({ env: e, request: new Request('https://x/api/overlay/layout' + (qs || ''), { headers: h }) });
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

  /* Hidden panels — removed from a preset — are kept with the flag, position
     optional (a hidden panel needs none). */
  const hid = validatePanels({ ovMaze: { x: 10, y: 20 }, ovMtg: { hidden: true } });
  check('a hidden panel is stored flag-only', hid.panels.ovMtg, { hidden: true });
  check('while its sibling positions normally', hid.panels.ovMaze, { x: 10, y: 20, s: 1 });
  check('a positioned+hidden panel keeps both', validatePanels({ ovMaze: { x: 5, y: 5, s: 2, hidden: true } }).panels.ovMaze,
        { x: 5, y: 5, s: 2, hidden: true });
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

/* ══ Save creates a preset, which becomes live and round-trips ═════════ */
{
  const e = env();
  const r = await (await POST(e, { action: 'save', panels: good }, as('222'))).json();
  check('the first save becomes the live preset', r.active, 'Default');
  const stored = e.MARKETPLACE.read('overlay_layout');
  check('the preset persisted the panels with default scale', stored.presets.Default.panels,
        { ovScramble: { x: 5, y: 70, s: 1 }, ovMaze: { x: 60, y: 12, s: 1 } });
  check('and recorded the author', stored.presets.Default.updatedBy, 'U222');
  check('GET serves the active preset panels', (await (await GET(e)).json()).panels, stored.presets.Default.panels);
}

/* ══ Reset clears the live preset but keeps it selectable ══════════════ */
{
  const e = env();
  await POST(e, { action: 'save', panels: good }, as('222'));
  await POST(e, { action: 'reset' }, as('222'));
  check('reset empties the active preset', (await (await GET(e)).json()).panels, {});
  check('but the preset still exists', (await (await GET(e)).json()).presets, ['Default']);
}

/* ══ A removed (hidden) panel round-trips and is served to the overlay ══ */
{
  const e = env();
  await POST(e, { action: 'save', panels: { ovMaze: { x: 1, y: 1 }, ovMtg: { hidden: true } } }, as('222'));
  const g = await (await GET(e)).json();
  check('the hidden panel is served with its flag', g.panels.ovMtg, { hidden: true });
  check('and the shown one with its position', g.panels.ovMaze, { x: 1, y: 1, s: 1 });
}

/* ══ Multiple presets: save, list, activate to swap, delete ════════════ */
{
  const e = env();
  await POST(e, { action: 'save', name: 'Chatting', panels: { ovScramble: { x: 1, y: 1 } } }, as('222'));
  await POST(e, { action: 'save', name: 'Gaming',   panels: { ovMaze: { x: 2, y: 2 } } }, as('111'));

  let g = await (await GET(e)).json();
  check('the first-saved preset is live', g.active, 'Chatting');
  check('both presets are listed', g.presets.slice().sort(), ['Chatting', 'Gaming']);

  const act = await (await POST(e, { action: 'activate', name: 'Gaming' }, as('222'))).json();
  check('activate reports the new live preset', act.active, 'Gaming');
  g = await (await GET(e)).json();
  check('GET now serves the newly-live preset', g.panels, { ovMaze: { x: 2, y: 2, s: 1 } });
  check('activating a preset that does not exist 404s', (await POST(e, { action: 'activate', name: 'Nope' }, as('222'))).status, 404);

  const full = await (await GET(e, as('222'), '?full=1')).json();
  ok('the editor full view carries every preset', full.presets.Chatting && full.presets.Gaming);
  check('and names the active one', full.active, 'Gaming');
  ok('a non-staff full request gets only the active panels', !(await (await GET(e, as('999'), '?full=1')).json()).full);

  await POST(e, { action: 'delete', name: 'Gaming' }, as('222'));
  g = await (await GET(e)).json();
  check('delete removes the preset', g.presets, ['Chatting']);
  check('and the live one falls back', g.active, 'Chatting');
}

/* ══ A pre-preset layout migrates to a Default preset ══════════════════ */
{
  const e = env({ overlay_layout: { panels: good, updatedBy: 'old' } });
  const g = await (await GET(e)).json();
  check('an old single layout is served as the active Default', g.active, 'Default');
  check('and its panels still read', g.panels, good);
  const full = await (await GET(e, as('222'), '?full=1')).json();
  ok('the migrated layout appears as a Default preset', !!full.presets.Default);
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
     (samples.match(/holds: \[/g) || []).length === (samples.match(/id: '(ov\w+)'/g) || []).length);
  ok('the alerts entry documents MTGBBB pulls landing there',
     /PULLS show here/.test(samples));
  ok('and drops, subs, raids, hype and bingo', /gift subs/.test(samples) && /Hype train/.test(samples) && /bingo & blackout/i.test(samples));

  const eEd = fs.readFileSync(path.join(REPO, 'js/pages/overlay-editor.js'), 'utf8');
  ok('the editor renders the legend from PANELS', /function renderLegend/.test(eEd) && /window\.OverlaySamples && window\.OverlaySamples\.PANELS/.test(eEd));

  /* The editor now lives INSIDE the Overlay Dashboard (one overlay iframe, not a
     nested editor iframe), so its markup and scripts are on that page. */
  const dashHtml = fs.readFileSync(path.join(REPO, 'overlay-dashboard.html'), 'utf8');
  ok('the dashboard hosts the editor legend column', /id="legendBody"/.test(dashHtml));
  ok('and the single overlay preview iframe', /id="ovFrame"[^>]*src="\/overlay\?layout=1"/.test(dashHtml));
  ok('and loads the shared samples + the editor script', /overlay-samples\.js/.test(dashHtml) && /overlay-editor\.js/.test(dashHtml));
  ok('the dashboard has a Layout section anchor', /id="odLayoutSection"/.test(dashHtml));

  /* Multi-preset editing: the editor reads every preset and can switch,
     create, make-live and delete. */
  ok('the dashboard has the preset controls',
     /id="presetSelect"/.test(dashHtml) && /id="newBtn"/.test(dashHtml) && /id="activateBtn"/.test(dashHtml) && /id="deleteBtn"/.test(dashHtml));

  /* Back-compat: the old standalone editor URL must not 404 — it redirects to
     the dashboard's Layout section. */
  const oldEd = fs.readFileSync(path.join(REPO, 'overlay-editor.html'), 'utf8');
  ok('the old editor page redirects to the dashboard Layout section',
     /overlay-dashboard\.html#odLayoutSection/.test(oldEd));

  /* Every panel is fully customizable: moved (makeDraggable) AND resized
     (addResizeHandle), for the SAME PANELS list — the editor wires both onto
     each panel it iterates. */
  ok('every panel is made draggable and resizable',
     /samples\.forEach\(function \(spec\)/.test(eEd) && /makeDraggable\(el, apply\)/.test(eEd) && /addResizeHandle\(el, apply\)/.test(eEd));

  /* SNAP TO GRID: a snap step in canvas pixels, snapping the drag position, a
     toggle, and gridlines — all resolution-independent (stored as %). */
  ok('the editor snaps the drag to a grid', /function snap\(/.test(eEd) && /SNAP_PX/.test(eEd) && /if \(snapOn\)/.test(eEd));
  ok('the snap grid step is in canvas pixels', /SNAP_PX = \d+/.test(eEd));
  ok('the dashboard has the snap toggle and gridlines',
     /id="snapToggle"/.test(dashHtml) && /id="snapGrid"/.test(dashHtml));

  /* MOBILE: the drag tool is usable on a phone — pointer events (not mouse-
     only), touch-action:none so a finger drags instead of scrolling, a finger-
     sized handle on coarse pointers, and a recompute on orientation change. */
  ok('drag/resize use pointer events', /addEventListener\('pointerdown'/.test(eEd) && /addEventListener\('pointermove'/.test(eEd));
  ok('panels and the handle opt out of touch scrolling', /touchAction = 'none'/.test(eEd) && /touch-action:none/.test(eEd));
  ok('the resize handle is finger-sized on touch', /pointer: coarse/.test(eEd) && /coarse \? 28 : 16/.test(eEd));
  ok('the canvas recomputes on orientation change', /orientationchange/.test(eEd));
  const dashCss = fs.readFileSync(path.join(REPO, 'css/pages/overlay-dashboard.css'), 'utf8');
  ok('the dashboard stacks the editor on small screens', /@media \(max-width: 600px\)/.test(dashCss) && /\.od-layout/.test(dashCss));
  ok('the editor loads every preset (full)', /API \+ '\?full=1'/.test(eEd));
  ok('and switches, activates and pins from the chosen preset',
     /function selectPreset/.test(eEd) && /action: 'activate'/.test(eEd) && /function currentPanels/.test(eEd));
  ok('the editor can hide (remove) a panel from a preset',
     /function togglePanel/.test(eEd) && /dataset\.hidden/.test(eEd) && /out\[spec\.id\]\.hidden = true/.test(eEd));
  ok('the live overlay removes a hidden panel', /p\.hidden/.test(apply) && /display = 'none'/.test(apply));
  ok('the legend cards carry a show/hide toggle', /class="lg-toggle"/.test(eEd) && /function updateLegendToggle/.test(eEd));

  /* The live-preset switcher moved to the Overlay Dashboard (it sits with the
     layout editor). It still activates via the same endpoint. */
  const dash = fs.readFileSync(path.join(REPO, 'js/pages/overlay-dashboard.js'), 'utf8');
  ok('the dashboard can swap the live preset', /function initOvPreset/.test(dash) && /action: 'activate'/.test(dash));

  const ids = [...samples.matchAll(/id: '(ov\w+)'/g)].map(m => m[1]).sort();
  /* The panel list the editor drags must match the ids the ROUTE stores, or a
     panel can be arranged and then silently not saved (validatePanels drops any
     id not in PANEL_IDS). Read PANEL_IDS from the route dynamically so this
     catches real drift, not a stale hardcoded copy. */
  const layoutSrc = fs.readFileSync(path.join(REPO, 'functions/api/overlay/layout.js'), 'utf8');
  const idsMatch = layoutSrc.match(/const PANEL_IDS = \[([^\]]*)\]/);
  const storedIds = idsMatch ? [...idsMatch[1].matchAll(/'(ov\w+)'/g)].map(m => m[1]).sort() : [];
  ok('the sample panel ids are exactly the ids the route stores',
     ids.length > 0 && JSON.stringify(ids) === JSON.stringify(storedIds));

  /* BOTH LISTS AGREEING IS NOT ENOUGH IF BOTH ARE MISSING THE SAME PANEL.
     That is how the hype bar and the ad countdown stayed unplaceable: real
     top-level panels on the overlay, tracked by the idle check, draggable by
     nobody, and a saved layout naming either was dropped on the way in with
     nothing anywhere to say so. The MARKUP is the source of truth here. */
  const markup = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  const topLevel = [...markup.matchAll(/^  <\w+[^>]*\sid="(ov[A-Za-z]+)"/gm)].map(m => m[1]);
  ok('the overlay markup yields its top-level panels', topLevel.length > 10);

  /* The two that are deliberately not placeable, each with its reason. */
  const NOT_PLACEABLE = {
    ovFault: 'the disconnected indicator — a fixed corner warning, not scenery',
    ovEggVideo: 'a full-bleed video cue with its own fixed placement',
  };
  const unplaceable = topLevel.filter(id => !ids.includes(id) && !(id in NOT_PLACEABLE));
  check('every top-level panel is either placeable or declared unplaceable', unplaceable, []);

  const staleExemptions = Object.keys(NOT_PLACEABLE).filter(id => !topLevel.includes(id));
  check('and nothing is exempted that no longer exists', staleExemptions, []);

  /* A panel the editor can drag but cannot DRAW is an invisible box to
     position against. So fillAll is RUN, against a fake DOM, and every
     placeable panel has to come out revealed.

     Running it rather than matching names on purpose: the filler for ovRaid
     is raidBoss(), for ovMc it is manaClash(), for ovVote it is chatVote(),
     and some reveal their panel with show(id) while others set hidden
     directly. Any naming rule is wrong for three of them today and wrong
     again for the next panel named sensibly rather than mechanically. */
  {
    /* Each panel starts as the MARKUP has it. ovStage carries no `hidden`
       attribute -- it is always present and alertCard injects a card into it
       -- so defaulting everything to hidden would fail it for being correct. */
    const startsHidden = new Set(
      [...markup.matchAll(/^  <\w+[^>]*\sid="(ov[A-Za-z]+)"[^>]*>/gm)]
        .filter(m => /\shidden[\s>]/.test(m[0]))
        .map(m => m[1])
    );
    ok('most panels start hidden in the markup', startsHidden.size > 10);
    ok('and the alert stage does not', !startsHidden.has('ovStage'));

    const nodes = new Map();
    const el = (id) => {
      if (nodes.has(id)) return nodes.get(id);
      const n = {
        id, hidden: startsHidden.has(id), textContent: '', innerHTML: '', src: '', value: '',
        style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
        appendChild() {}, replaceChildren() {}, addEventListener() {},
        querySelector: () => null, querySelectorAll: () => [],
      };
      nodes.set(id, n);
      return n;
    };
    const sandbox = {
      document: {
        getElementById: el,
        createElement: (t) => el('new-' + t + '-' + nodes.size),
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, body: el('body'),
      },
      console: { log() {}, warn() {}, error() {} },
      Date, Math, JSON, Number, String, Array, Object, isNaN,
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(samples, sandbox, { filename: 'js/pages/overlay-samples.js' });

    ok('overlay-samples publishes its API', !!(sandbox.window.OverlaySamples &&
      typeof sandbox.window.OverlaySamples.fillAll === 'function'));
    sandbox.window.OverlaySamples.fillAll();

    const notDrawn = ids.filter(id => el(id).hidden);
    check('fillAll reveals every panel the editor can place', notDrawn, []);

    /* Whether each panel also has CONTENT is deliberately not checked here:
       the fillers write into child elements (ovHypeLevel, ovPredTitle,
       ovMcBar) and this fake DOM has no parent/child link, so a panel node
       always reads empty however well it was drawn. Revealing is the part
       that actually breaks and the part this can state honestly. */
  }
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
