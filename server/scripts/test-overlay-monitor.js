#!/usr/bin/env node
/* ══════════════════════════════════════════════
   OVERLAY AUDIO MONITOR — test suite

     node server/scripts/test-overlay-monitor.js

   The overlay's audio is captured by OBS into the stream, so chat hears every
   alert/chime/hatch/egg clip but the streamer at the desk does not. The monitor
   mode (overlay.html?monitor=1) is a copy the streamer keeps open in a NORMAL
   browser window purely so THEY hear it — it:

     • always plays audio locally (isAudioLeader forced true; the server's
       election never overrides it);
     • stays OUT of the stream's leader election (never sends &iid), so the OBS
       source stays the one true audio leader and the stream mix is unchanged;
     • uses its OWN volume + mute, persisted in localStorage, independent of the
       control panel's master alertVolume.

   Every monitor change must be gated behind the flag — the normal overlay/stream
   audio path must be unchanged. Like the other overlay tests, the page's audio
   logic can't run under node, so it is read out of source and the two branches
   (monitor vs not) are mirrored and exercised directly.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const overlay = read('js/pages/overlay.js');
const overlayHtml = read('overlay.html');
const dashHtml = read('overlay-dashboard.html');

/* ── 1. The monitor flag is detected ────────────────────────────────────── */
{
  ok('overlay.js declares an isMonitor flag', /var\s+isMonitor\s*=/.test(overlay));
  ok("the flag reads the ?monitor=1 query param",
    /get\(\s*['"]monitor['"]\s*\)\s*===\s*['"]1['"]/.test(overlay));
}

/* ── 2. Monitor forces the audio leader and skips the poll-driven override ── */
{
  /* The init block forces isAudioLeader true in monitor mode. */
  const initBlock = overlay.slice(overlay.indexOf('if (isMonitor) {'));
  ok('monitor init forces isAudioLeader = true',
    /if\s*\(isMonitor\)\s*\{[\s\S]*?isAudioLeader\s*=\s*true/.test(overlay));

  /* The poll's election assignment is guarded so monitor never yields. */
  ok('the poll only applies data.audioLeader when NOT in monitor mode',
    /if\s*\(!isMonitor\s*&&\s*typeof\s+data\.audioLeader\s*===\s*['"]string['"]\)/.test(overlay));
  ok('data.audioLeader is still read in non-monitor mode',
    /isAudioLeader\s*=\s*\(data\.audioLeader\s*===\s*overlayIid\)/.test(overlay));
  ok('an isMonitor init block exists', initBlock.length > 0);
}

/* ── 3. The monitor stays out of the election (no iid on its poll) ───────── */
{
  ok('the poll URL omits the iid when muted OR in monitor mode',
    /\(\s*\(\s*audioMuted\s*\|\|\s*isMonitor\s*\)\s*\?\s*['"]['"]\s*:\s*['"]&iid=['"]/.test(overlay));

  /* Mirror the poll-URL iid clause for both branches and assert the behaviour. */
  function iidClause({ audioMuted, isMonitor }) {
    return (audioMuted || isMonitor) ? '' : '&iid=X';
  }
  check('monitor (unmuted) sends NO iid', iidClause({ audioMuted: false, isMonitor: true }), '');
  check('a normal unmuted overlay DOES send its iid', iidClause({ audioMuted: false, isMonitor: false }), '&iid=X');
  check('a normal muted overlay sends no iid (unchanged)', iidClause({ audioMuted: true, isMonitor: false }), '');
}

/* ── 4. Playback volume uses a local/localStorage value in monitor mode ──── */
{
  ok('monitor volume has its own localStorage key',
    /MONITOR_VOL_KEY\s*=\s*['"]ov_monitor_vol['"]/.test(overlay));
  ok('monitor mute has its own localStorage key',
    /MONITOR_MUTE_KEY\s*=\s*['"]ov_monitor_mute['"]/.test(overlay));
  ok('a monitorVolume variable exists', /var\s+monitorVolume\s*=/.test(overlay));
  ok('monitor init loads the volume from localStorage',
    /localStorage\.getItem\(MONITOR_VOL_KEY\)/.test(overlay));
  ok('monitor init drives alertVolume from the local monitor volume',
    /alertVolume\s*=\s*monitorVolume/.test(overlay));

  /* The poll's server-volume assignment is guarded so the master slider never
     touches the monitor. */
  ok('the poll only applies data.alertVolume when NOT in monitor mode',
    /if\s*\(!isMonitor\s*&&\s*typeof\s+data\.alertVolume\s*===\s*['"]number['"]\)/.test(overlay));

  /* Mirror: a monitor poll leaves its local volume alone; a normal one adopts
     the server's master volume. */
  function applyServerVolume({ isMonitor, local, serverVolume }) {
    let alertVolume = local;
    if (!isMonitor && typeof serverVolume === 'number') {
      alertVolume = Math.max(0, Math.min(1, serverVolume / 100));
    }
    return alertVolume;
  }
  check('monitor keeps its local volume despite the server master slider',
    applyServerVolume({ isMonitor: true, local: 0.7, serverVolume: 35 }), 0.7);
  check('a normal overlay adopts the server master volume (unchanged)',
    applyServerVolume({ isMonitor: false, local: 0.35, serverVolume: 80 }), 0.8);
}

/* ── 5. Non-monitor audio path is unchanged ─────────────────────────────── */
{
  /* Every audio sink still gates on isAudioLeader && !audioMuted. */
  const gates = overlay.match(/audioMuted\s*\|\|\s*!isAudioLeader/g) || [];
  ok('audio sinks still gate on (audioMuted || !isAudioLeader)', gates.length >= 3);
  ok('the check-in chime still gates on (!audioMuted && isAudioLeader)',
    /!audioMuted\s*&&\s*isAudioLeader/.test(overlay));
  ok('the normal overlay still builds its iid from overlayIid',
    /&iid=['"]\s*\+\s*encodeURIComponent\(overlayIid\)/.test(overlay));

  /* The default (non-monitor) starting state is untouched. */
  ok('alertVolume still defaults to 0.35', /var\s+alertVolume\s*=\s*0\.35/.test(overlay));
  ok('isAudioLeader still starts true', /var\s+isAudioLeader\s*=\s*true/.test(overlay));
  ok('audioMuted is still derived from ?muted / ?sound=off',
    /get\(\s*['"]muted['"]\s*\)\s*===\s*['"]1['"]/.test(overlay) &&
    /get\(\s*['"]sound['"]\s*\)\s*===\s*['"]off['"]/.test(overlay));

  /* Mirror the shared audio gate — monitor plays, a non-leader stream source
     stays silent, a muted source stays silent. */
  function plays({ audioMuted, isAudioLeader }) { return !(audioMuted || !isAudioLeader); }
  check('monitor (leader, unmuted) plays', plays({ audioMuted: false, isAudioLeader: true }), true);
  check('a non-leader stream source stays silent', plays({ audioMuted: false, isAudioLeader: false }), false);
  check('a muted source stays silent', plays({ audioMuted: true, isAudioLeader: true }), false);
}

/* ── 6. The control bar is monitor-only, and the dashboard links to it ───── */
{
  ok('the monitor control bar is built only when isMonitor',
    /if\s*\(isMonitor\)\s*\{?\s*buildMonitorBar\(\)/.test(overlay));
  ok('overlay.html does NOT ship the monitor bar markup (built in JS, never captured)',
    !/ovMonitorBar/.test(overlayHtml));
  ok('the control bar carries a volume slider', /type\s*=\s*['"]range['"]/.test(overlay) &&
    /buildMonitorBar/.test(overlay));

  /* No box-shadow / side-border rail / blur in the injected monitor styles
     (CLAUDE.md design identity). */
  const barStyle = overlay.slice(overlay.indexOf('function buildMonitorBar'));
  ok('the monitor bar uses no box-shadow', !/box-shadow/.test(barStyle));
  ok('the monitor bar uses no backdrop-filter / blur', !/backdrop-filter|blur\(/.test(barStyle));
  ok('the monitor bar uses no border-left/right colour rail', !/border-left|border-right/.test(barStyle));

  ok('the dashboard links to /overlay.html?monitor=1',
    /href\s*=\s*['"]\/overlay\.html\?monitor=1['"]/.test(dashHtml));
  ok('the dashboard link opens in a new tab', /\/overlay\.html\?monitor=1['"][^>]*target\s*=\s*['"]_blank['"]/.test(dashHtml));
  ok("the dashboard explains it won't affect stream audio",
    /won't affect stream audio|plays locally only/i.test(dashHtml));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[overlay-monitor] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[overlay-monitor] ${passed} assertions passed.`);
console.log('');
