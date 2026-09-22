#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PHAM CHECK-IN OVERLAY REMINDER — wiring

     node server/scripts/test-overlay-checkin.js

   A small corner nudge on the overlay telling viewers to redeem their
   check-in — NOT a stage alert. Two ways to fire it:
     • the bot-control "Show Now" button, WITH sound (a moderator meant it);
     • the rig's minute-tick timer while live, SILENT (a periodic nudge must
       not loop audio).
   No network here — this pins the pieces of that chain together (and the
   sprite strip's frame maths) so a rename on any side fails loudly.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
const ok = (label, cond) => { if (cond) passed++; else failures.push(label); };

/* ── The assets exist ─────────────────────────────────────────────────── */
ok('the sprite strip is in a tracked asset folder', fs.existsSync(path.join(REPO, 'assets/overlay/pham-checkin.png')));
ok('the sound is in place', fs.existsSync(path.join(REPO, 'assets/audio/phamCheckIn.mp3')));

/* ── The overlay shows it as a corner reminder, off the alert queue ────── */
{
  const ov = read('js/pages/overlay.js');
  ok('the check-in is a corner reminder, not a stage card', /function showCheckinReminder/.test(ov) && !/buildCheckinCard/.test(ov));
  ok('and it bypasses the alert queue', /ev\.type === 'pham-checkin'\) \{ showCheckinReminder\(ev\); continue; \}/.test(ov));
  ok('it drives the movable #ovCheckin panel', /getElementById\('ovCheckin'\)/.test(ov) && /getElementById\('ovCheckinSprite'\)/.test(ov));
  /* Sound only when the event asks for it (the manual button); the timer
     nudge is silent. */
  ok('sound is gated on ev.sound', /if \(ev && ev\.sound\)/.test(ov) && /new Audio\(CHECKIN_AUDIO\)/.test(ov));
  ok('the raise animation stops on the last frame', /frame >= CHECKIN_FRAMES - 1\) clearInterval/.test(ov));
  /* ONE reused audio element, restarted — not a fresh Audio() per fire, which
     layered a sound per rapid press. */
  ok('the check-in sound is a single reused element, restarted', /if \(!checkinAudio\) checkinAudio = new Audio/.test(ov) && /checkinAudio\.currentTime = 0/.test(ov));
  ok('and it obeys the alert volume', /checkinAudio\.volume = alertVolume/.test(ov) && /data\.alertVolume/.test(ov));

  /* The panel markup lives in overlay.html — just the reaper and the words,
     no subtext line. */
  const html = read('overlay.html');
  ok('the panel is in the overlay markup', /id="ovCheckin"/.test(html) && /id="ovCheckinSprite"/.test(html));
  ok('it shows only the Pham Check-In text', /ov-checkin-label">Pham Check-In</.test(html) && !/Redeem to check in/.test(html));

  const css = read('css/pages/overlay.css');
  ok('the panel is absolutely positioned (movable by the layout editor)', /\.ov-checkin \{[\s\S]*?position: absolute/.test(css) && /\.ov-checkin\.is-in/.test(css));
  ok('the strip image and crisp pixels are in the sprite CSS', /\.ov-checkin-sprite[\s\S]*?pham-checkin\.png/.test(css) && /image-rendering: pixelated/.test(css));
  /* No box: the label sits over the scene on its own, in the GodOfWar face. */
  const labelBlock = (css.match(/\.ov-checkin-label \{([^}]*)\}/) || ['', ''])[1];
  ok('the label uses the GodOfWar font', /GodOfWar/.test(labelBlock));
  const checkinBlock = (css.match(/\.ov-checkin \{([^}]*)\}/) || ['', ''])[1];
  ok('there is no panel background behind it', !/background:/.test(checkinBlock));

  /* Registered as a movable panel the layout editor lists. */
  const samples = read('js/pages/overlay-samples.js');
  ok('the layout editor lists the Check-In panel', /id: 'ovCheckin'/.test(samples) && /function checkin\(/.test(samples));
}

/* ── The strip's real width matches the declared frame count ──────────── */
{
  const ov = read('js/pages/overlay.js');
  const frames = Number((ov.match(/CHECKIN_FRAMES = (\d+)/) || [])[1]);
  const fw = Number((ov.match(/CHECKIN_FW = (\d+)/) || [])[1]);
  ok('CHECKIN_FRAMES and CHECKIN_FW are declared', frames > 0 && fw > 0);
  const buf = fs.readFileSync(path.join(REPO, 'assets/overlay/pham-checkin.png'));
  const stripW = buf.readUInt32BE(16);   // IHDR width
  ok(`the strip is exactly ${frames} frames wide (${stripW} = ${frames} x ${fw})`, stripW === frames * fw);
}

/* ── Manual trigger: with sound, overlay only ─────────────────────────── */
{
  const trig = read('functions/api/bot/trigger.js');
  ok('the button action fires a pham-checkin event WITH sound',
     /body\.action === 'checkin-alert'/.test(trig) && /type: 'pham-checkin', sound: true/.test(trig));
  const block = (trig.match(/checkin-alert'[\s\S]*?\n  \}/) || [''])[0];
  ok('the button posts nothing to chat', !/sendChatMessage|announceAction/.test(block));

  ok('there is a config action for the timer', /body\.action === 'checkin-reminder-config'/.test(trig));
  ok('the GET returns the reminder config for the panel', /checkinReminder/.test(trig));
}

/* ── Alert volume ─────────────────────────────────────────────────────── */
{
  const trig = read('functions/api/bot/trigger.js');
  ok('the panel can set alert volume', /body\.action === 'alert-volume'/.test(trig) && /overlay_alert_volume/.test(trig));
  ok('and the GET returns the current volume', /alertVolume/.test(trig));

  const ev = read('functions/api/overlay/events.js');
  ok('the overlay feed carries the volume to the overlay', /overlay_alert_volume/.test(ev) && /alertVolume: alertVolume/.test(ev));

  const reg = read('server/lib/registry.js');
  ok('the volume is a registered singleton', /overlay_alert_volume:\s*\{ table: 'singletons'/.test(reg));

  const js = read('js/pages/bot-control.js');
  ok('the panel has a volume slider that saves on release', /action: 'alert-volume'/.test(js) && /getElementById\('ovAlertVolume'\)/.test(js));
  const html = read('bot-control.html');
  ok('the volume slider is in the markup', /id="ovAlertVolume"/.test(html));
}

/* ── Timer: server-side, silent, while live ───────────────────────────── */
{
  const idx = read('server/index.js');
  ok('the rig tick fires the reminder while live', /if \(s\.live\) await fireCheckinReminder/.test(idx));
  ok('the timer nudge is silent', /pushOverlayEvent\(env, \{ type: 'pham-checkin', sound: false \}\)/.test(idx));
  ok('it honours the configured interval', /intervalMin[\s\S]*60 \* 1000/.test(idx) && /lastFiredAt/.test(idx));

  const reg = read('server/lib/registry.js');
  ok('the reminder config is a registered singleton', /checkin_reminder:\s*\{ table: 'singletons'/.test(reg));
}

/* ── The bot-control card ─────────────────────────────────────────────── */
{
  const html = read('bot-control.html');
  ok('the panel has the reminder card', /id="ovCheckinSection"/.test(html));
  ok('with Show Now, a timer toggle, an interval and Save',
     /id="ovCheckinBtn"/.test(html) && /id="ovCheckinToggleBtn"/.test(html) &&
     /id="ovCheckinInterval"/.test(html) && /id="ovCheckinSaveBtn"/.test(html));

  const js = read('js/pages/bot-control.js');
  ok('Show Now fires the manual action', /action: 'checkin-alert'/.test(js));
  ok('the timer settings post the config action', /action: 'checkin-reminder-config'/.test(js));
  ok('and the panel loads the current config', /d\.checkinReminder/.test(js));
}

/* ── Report ───────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[overlay-checkin] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[overlay-checkin] ${passed} assertions passed.`);
console.log('');
