#!/usr/bin/env node
/* ══════════════════════════════════════════════
   BACKGROUND-TAB POLLING — the games must stop hammering the rig when hidden

     node server/scripts/test-game-background-poll.js

   Every multiplayer/shared-state game page polls the rig every 1.5–4s. On a
   home rig a dozen backgrounded tabs each polling is pure waste: a hidden tab
   can show nothing and the player can act on nothing. So each poll loop must
   pause (or back off hard) while document.hidden, and catch up the instant the
   tab is shown again via a visibilitychange handler.

   This reads the game HTML and asserts the guard is present, so a future edit
   that re-introduces an always-on poll trips the test instead of the rig's CPU
   graph on a marathon stream.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const game = (p) => fs.readFileSync(path.join(REPO, 'games', p), 'utf8');

let passed = 0;
const failures = [];
const ok = (label, cond) => { if (cond) passed++; else failures.push(label); };

/* ── Mana Clash: the room poll backs off while hidden ─────────────────── */
{
  const src = game('mana-clash/index.html');
  ok('mana-clash: poll interval depends on document.hidden',
     /document\.hidden\s*\?\s*\d{4,}\s*:\s*1500/.test(src));
  ok('mana-clash: a visibilitychange handler re-schedules the poll',
     /addEventListener\(\s*['"]visibilitychange['"]/.test(src) && /schedulePoll\(\)/.test(src));
  ok('mana-clash: it polls immediately on return to foreground',
     /if\s*\(\s*!document\.hidden\s*\)\s*poll\(\)/.test(src));
}

/* ── MTGBBB: the 2s board poll skips while hidden ─────────────────────── */
{
  const src = game('mtgbbb/index.html');
  ok('mtgbbb: the periodic poll tick is guarded by document.hidden',
     /setInterval\(\s*\(\)\s*=>\s*\{\s*if\s*\(\s*!document\.hidden\s*\)\s*pollState\(\)/.test(src));
  ok('mtgbbb: a visibilitychange handler catches the board up',
     /addEventListener\(\s*['"]visibilitychange['"][\s\S]{0,120}pollState\(\)/.test(src));
}

/* ── Skull Clicker: the raid/event/reward pollers back off ────────────── */
{
  const src = game('skull-clicker/index.html');
  ok('skull-clicker: the 4s raid poll is guarded by document.hidden',
     /if\s*\(\s*!document\.hidden\s*\)\s*pollRaid\(\)/.test(src));
  ok('skull-clicker: the event poll is guarded too',
     /if\s*\(\s*!document\.hidden\s*\)\s*pollSkullEvent\(\)/.test(src));
  ok('skull-clicker: the reward poll is guarded too',
     /if\s*\(\s*!document\.hidden\s*\)\s*fetchRaidReward\(\)/.test(src));
  ok('skull-clicker: a visibilitychange handler catches all three up on return',
     /addEventListener\(\s*['"]visibilitychange['"][\s\S]{0,200}pollRaid\(\)[\s\S]{0,120}pollSkullEvent\(\)/.test(src));
  /* The queued raid damage must still flush — it only fires when there IS
     damage, so leaving it running is cheap and keeps a backgrounded
     autoclicker contributing to the shared boss. */
  ok('skull-clicker: the raid-damage flush is NOT gated on visibility',
     /setInterval\(flushRaidDamage,\s*RAID_FLUSH_MS\)/.test(src));
}

/* ── Memory Match: a one-shot game, so it must NOT grow a poll loop ────── */
{
  const src = game('memory-match/index.html');
  ok('memory-match: no setInterval poll loop (it fetches per action only)',
     !/setInterval\s*\(/.test(src));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[game-background-poll] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[game-background-poll] ${passed} assertions passed.`);
console.log('');
