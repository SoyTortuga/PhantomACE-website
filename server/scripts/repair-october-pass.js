#!/usr/bin/env node
/* ══════════════════════════════════════════════
   REPAIR THE OCTOBER 2026 PHAMILY TIME PASS

     node server/scripts/repair-october-pass.js --service phantomace-web
     node server/scripts/repair-october-pass.js --service phantomace-web --confirm
     node server/scripts/repair-october-pass.js --service phantomace-web --confirm --include-unattributed
     (--verbose prints every user's plan)

   Two bugs went live with the October theme:

   (a) CARD BACKS / EMOTE PACKS SILENTLY NOT GRANTED. They were granted with
       the reward KEY as their id. The key is the same every month, so
       October's Cobweb Card Back carried September's Basic Card Back's id
       and grantItem deduped it into nothing. Anyone whose October row claims
       one of those keys but whose inventory has no item of that type and
       NAME (Memory Match resolves them by name) is owed it. The claim is in
       October's row, so it was made in October and October's content is
       what it should have paid — whatever the cause. The same rule is
       applied to every themed slot (skull skin, click effect, dice), which
       also covers a server that kept serving September's table into
       October after a restart-free month boundary.

   (b) GRACE CLAIMS PAID OCTOBER CONTENT. claim-prev looked a September key
       up in October's table, so from 2026-10-01 PT a September reward paid
       its October counterpart. Detection is per (user, September key) whose
       September item differs from its October one and is NOT in the
       inventory:

         skull-skin / click-effect / dice — the inventory holds the October
           item (type + October cosmeticId), granted on/after 2026-10-01 PT
           by phamily-time, AND the October row has NOT claimed that key.
           Nothing but a grace claim of the September key could have put it
           there, so this is CONFIRMED.
           If October's row HAS claimed the key, that October claim explains
           the October item on its own, and nothing records WHEN the
           September claim was made (claimedRewards carries no timestamp).
           The September item is still owed by the claim record, but the
           misgrant itself cannot be proven: UNATTRIBUTED, granted only with
           --include-unattributed.

         cardback / emote — the inventory holds an item whose id is the
           reward KEY and whose name is October's. Before this fix the first
           grant ever made under a key created that id-K item, and a
           September claim made IN September would have created it with
           September's name (or found one from an earlier base month, also
           September's name). So an id-K item bearing October's name, with
           September's item absent, proves the September claim was made in
           October: CONFIRMED regardless of October's row.

         room-piece — never themed: September's and October's pieces are
           the same item, so a grace claim paid the right thing. Nothing to
           repair; the plan says so rather than staying silent.

       Anything else (September's item missing with no October evidence) is
       not this bug and is left alone.

   (c) MILESTONES, same bug. A September milestone grace-claimed in October
       was granted with October's title. Its items carry the MONTH in their
       id (ms_<level>_title_2026-09), so a 2026-09 item bearing an October
       title is unambiguous: its name is corrected in place. A September
       bonus dice set (Crimson at 60, Obsidian at 135) that came out as
       October's (Bloodletter / Wraithsilk) follows the skull-skin rule
       above, with October's claimedMilestones as the explanation check.
       Banners / name effects stamped with October's Halloween theme on a
       2026-09 id are REPORTED, not changed — that strips a cosmetic the
       viewer is using, and is for a person to decide.

   October items paid by a misgranted grace claim are REPORTED and kept.

   Dry run unless --confirm. SAFE TO RUN TWICE: every grant is re-checked
   inside the inventory's lock and skipped if already owned.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';
import { rewardTablesFor, findMilestone, nameKeyedItemId, NAME_KEYED_ITEM_TYPES } from '../../functions/api/phamily-rewards.js';
import { monthEndsAt } from '../../functions/api/season-time.js';

export const SEP = '2026-09';
export const OCT = '2026-10';
/** 2026-10-01 00:00 America/Los_Angeles, as UTC ms. */
export const OCT_START = monthEndsAt(new Date(Date.UTC(2026, 8, 15, 12)));

/* Sources that could have carried October content onto a September claim:
   the claim itself, and repair-cosmetic-grants.js, which resolves keys
   against the CURRENT month's table and so did the same thing if run in
   October. */
const EVIDENCE_SOURCES = new Set(['phamily-time', 'repair-cosmetic-grants']);

/* The item each reward type becomes. MUST match REWARD_ITEM_MAP in
   functions/api/phamily-time.js (a route module, so not importable here). */
const ITEM_FOR = {
  'skull-skin': (r) => ({ id: r.cosmeticId, game: 'skull-clicker', type: 'skull-skin' }),
  'click-effect': (r) => ({ id: r.cosmeticId, game: 'skull-clicker', type: 'click-effect' }),
  dice: (r) => ({ id: r.cosmeticId, game: 'mana-clash', type: 'dice' }),
  cardback: (r) => ({ id: nameKeyedItemId('cardback', r.name), game: 'memory-match', type: 'cardback' }),
  emote: (r) => ({ id: nameKeyedItemId('emote-pack', r.name), game: 'memory-match', type: 'emote-pack' }),
  'room-piece': (r) => ({ id: `room-piece-${r.cosmeticId}`, game: 'profile', type: 'room-piece', meta: { piece: r.cosmeticId } }),
};

export function itemFor(reward) {
  const make = reward && ITEM_FOR[reward.type];
  if (!make) return null;
  return { ...make(reward), name: reward.name, rarity: reward.rarity, consumable: false };
}

const nameKeyed = (item) => NAME_KEYED_ITEM_TYPES.includes(item.type);

/** Same identity grantItem uses: type + id, or type + name for name-keyed types. */
export function owns(items, item) {
  return items.some(i => i && i.type === item.type
    && (i.id === item.id || (nameKeyed(item) && !!item.name && i.name === item.name)));
}

const sameItem = (a, b) => !!a && !!b && a.type === b.type && a.id === b.id && a.name === b.name;
const grantedSinceOct = (i) => Number(i.grantedAt) >= OCT_START && EVIDENCE_SOURCES.has(i.source);

/**
 * What one user is owed. Pure: rows in, plan out.
 * @param {{sep: object|null, oct: object|null, items: object[]}} u
 */
export function planUser({ sep, oct, items }) {
  const SEPT = rewardTablesFor(SEP);
  const OCTT = rewardTablesFor(OCT);
  const sepClaims = (sep && Array.isArray(sep.claimedRewards)) ? sep.claimedRewards.map(String) : [];
  const octClaims = new Set((oct && Array.isArray(oct.claimedRewards)) ? oct.claimedRewards.map(String) : []);
  const sepMs = (sep && Array.isArray(sep.claimedMilestones)) ? sep.claimedMilestones.map(Number) : [];
  const octMs = new Set((oct && Array.isArray(oct.claimedMilestones)) ? oct.claimedMilestones.map(Number) : []);

  const plan = { grants: [], unattributed: [], renames: [], misgranted: [], misthemed: [], roomGraceOk: 0 };

  /* (a) October claims missing October's item. */
  for (const key of octClaims) {
    const O = OCTT.byKey.get(key);
    const oItem = itemFor(O);
    if (!oItem) continue;
    if (sameItem(oItem, itemFor(SEPT.byKey.get(key)))) continue;
    if (owns(items, oItem)) continue;
    plan.grants.push({ part: 'a', key, item: oItem });
  }

  /* (b) September claims paid with October's item. */
  for (const key of sepClaims) {
    const S = SEPT.byKey.get(key);
    const O = OCTT.byKey.get(key);
    const sItem = itemFor(S);
    const oItem = itemFor(O);
    if (!sItem || !oItem) continue;
    if (sameItem(sItem, oItem)) { if (S.type === 'room-piece') plan.roomGraceOk++; continue; }
    if (owns(items, sItem)) continue;

    const evidence = items.filter(i => i && i.type === oItem.type && grantedSinceOct(i)
      && (nameKeyed(oItem) ? i.name === oItem.name : i.id === oItem.id));
    let confirmed;
    if (nameKeyed(oItem)) {
      confirmed = items.some(i => i && i.type === oItem.type && i.id === key && i.name === oItem.name);
    } else {
      confirmed = evidence.length > 0 && !octClaims.has(key);
    }
    if (confirmed) {
      plan.grants.push({ part: 'b', key, item: sItem });
      if (!octClaims.has(key)) plan.misgranted.push({ key, item: oItem });
    } else if (evidence.length > 0) {
      plan.unattributed.push({ part: 'b', key, item: sItem, why: 'October claimed the same key, so the October item does not prove a grace claim' });
    }
  }

  /* (c) September milestones grace-claimed with October's table. */
  for (const level of sepMs) {
    const sm = findMilestone(level, SEP);
    const om = findMilestone(level, OCT);
    if (!sm || !om) continue;

    if (sm.title !== om.title) {
      for (const [suffix, type, from, to] of [
        ['title', 'title', om.title, sm.title],
        ['badge', 'badge', `${om.title} Badge`, `${sm.title} Badge`],
      ]) {
        const id = `ms_${level}_${suffix}_${SEP}`;
        const it = items.find(i => i && i.id === id && i.type === type);
        if (it && it.name === from) plan.renames.push({ id, type, from, to, rank: type === 'badge' ? sm.title : undefined });
      }
    }

    const sDice = (sm.bonusItems || []).find(b => b.type === 'dice');
    const oDice = (om.bonusItems || []).find(b => b.type === 'dice');
    if (sDice && oDice && sDice.cosmeticId !== oDice.cosmeticId) {
      const sItem = { ...ITEM_FOR.dice(sDice), name: sDice.name, rarity: sDice.rarity, consumable: false };
      if (!owns(items, sItem)) {
        const ev = items.some(i => i && i.type === 'dice' && i.id === oDice.cosmeticId && grantedSinceOct(i));
        if (ev && !octMs.has(level)) {
          plan.grants.push({ part: 'c', key: `milestone ${level}`, item: sItem });
          plan.misgranted.push({ key: `milestone ${level}`, item: { type: 'dice', id: oDice.cosmeticId, name: oDice.name } });
        } else if (ev) {
          plan.unattributed.push({ part: 'c', key: `milestone ${level}`, item: sItem, why: 'October claimed the same milestone' });
        }
      }
    }

    for (const t of ['banner', 'nameeffect']) {
      const it = items.find(i => i && i.id === `ms_${level}_${t}_${SEP}`);
      if (it && it.meta && it.meta.theme) plan.misthemed.push({ id: it.id, theme: it.meta.theme });
    }
  }

  return plan;
}

/** Apply a plan to an inventory value. Returns the new value, or undefined for no change. */
export function applyPlan(inv, plan, { includeUnattributed = false, now = Date.now() } = {}) {
  if (!inv || !Array.isArray(inv.items)) inv = { ...(inv || {}), items: [], equips: (inv && inv.equips) || {} };
  let changed = 0;
  const grants = includeUnattributed ? [...plan.grants, ...plan.unattributed] : plan.grants;
  for (const g of grants) {
    if (owns(inv.items, g.item)) continue;
    inv.items.push({ ...g.item, grantedAt: now, source: 'repair-october-pass' });
    changed++;
  }
  for (const r of plan.renames) {
    const it = inv.items.find(i => i && i.id === r.id && i.type === r.type);
    if (!it || it.name !== r.from) continue;
    it.name = r.to;
    if (r.rank) it.meta = { ...(it.meta || {}), rank: r.rank };
    changed++;
  }
  return changed ? inv : undefined;
}

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}
const line = (s = '') => console.log(s);
const label = (it) => `${it.type}:${it.id}${it.name ? ` "${it.name}"` : ''}`;

async function main() {
  const confirm = arg('confirm') === true;
  const includeUnattributed = arg('include-unattributed') === true;
  const verbose = arg('verbose') === true;

  const databaseUrl = resolveDatabaseUrl({ service: arg('service'), fallback: arg('database-url') });
  if (!databaseUrl) { console.error('[repair] No DATABASE_URL. Use --service phantomace-web.'); process.exit(2); }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  line(`Database: ${info.db}`);
  line(`October starts (PT): ${new Date(OCT_START).toISOString()}`);
  line('');

  const kv = createKVStore(pool);
  const rows = await kv.listValues({ prefix: 'pt_' });
  const users = new Map();
  for (const row of rows) {
    const m = /^pt_(.+)_(\d{4}-\d{2})$/.exec(String(row.name || ''));
    if (!m || (m[2] !== SEP && m[2] !== OCT)) continue;
    const u = users.get(m[1]) || { sep: null, oct: null };
    if (m[2] === SEP) u.sep = row.value; else u.oct = row.value;
    users.set(m[1], u);
  }
  line(`Users with a September or October pass row: ${users.size}`);

  const plans = [];
  const tally = { a: 0, b: 0, c: 0, unattributed: 0, renames: 0, misgranted: 0, misthemed: 0, roomGraceOk: 0 };
  const byType = new Map();
  for (const [userId, u] of users) {
    let inv;
    try { inv = await kv.get(`inv_${userId}`, 'json'); } catch { inv = null; }
    const items = inv && Array.isArray(inv.items) ? inv.items : [];
    const plan = planUser({ sep: u.sep, oct: u.oct, items });
    for (const g of plan.grants) {
      tally[g.part]++;
      const k = `${g.part} ${g.item.type}`;
      byType.set(k, (byType.get(k) || 0) + 1);
    }
    tally.unattributed += plan.unattributed.length;
    tally.renames += plan.renames.length;
    tally.misgranted += plan.misgranted.length;
    tally.misthemed += plan.misthemed.length;
    tally.roomGraceOk += plan.roomGraceOk;
    const acts = plan.grants.length + plan.renames.length + plan.unattributed.length + plan.misthemed.length;
    if (!acts) continue;
    plans.push({ userId, plan });
    if (verbose) {
      line(`  user ${userId}`);
      for (const g of plan.grants) line(`    grant (${g.part})  ${g.key} -> ${label(g.item)}`);
      for (const g of plan.unattributed) line(`    UNATTRIBUTED (${g.part})  ${g.key} -> ${label(g.item)}  [${g.why}]`);
      for (const r of plan.renames) line(`    rename  ${r.id}: "${r.from}" -> "${r.to}"`);
      for (const x of plan.misgranted) line(`    kept misgrant  ${x.key}: ${label(x.item)}`);
      for (const x of plan.misthemed) line(`    misthemed (reported only)  ${x.id} theme=${x.theme}`);
    }
  }

  line('');
  line(`(a) October card backs / emote packs / themed cosmetics to grant: ${tally.a}`);
  line(`(b) September grace claims paid October content, confirmed:        ${tally.b}`);
  line(`(c) September milestone bonus dice, confirmed:                     ${tally.c}`);
  line(`    September milestone titles/badges to rename:                   ${tally.renames}`);
  for (const [k, n] of [...byType].sort()) line(`      ${k.padEnd(20)} ${String(n).padStart(4)}`);
  line(`UNATTRIBUTED (owed by the claim record, misgrant not provable):     ${tally.unattributed}${includeUnattributed ? '  [will grant]' : '  [skipped; --include-unattributed]'}`);
  line(`October items paid by misgranted grace claims (kept):               ${tally.misgranted}`);
  line(`2026-09 banners/name effects carrying an October theme (reported):  ${tally.misthemed}`);
  line(`September room-piece grace claims (identical item, nothing to fix): ${tally.roomGraceOk}`);
  line('');

  if (!plans.length) { line('Nothing to do.'); await pool.end(); return; }
  if (!confirm) { line('DRY RUN — nothing written. Re-run with --confirm (add --verbose for per-user detail).'); await pool.end(); return; }

  let touched = 0;
  for (const { userId, plan } of plans) {
    /* Re-checked inside the lock: a claim landing now must not be erased by
       the copy read above, and an item granted since must not be doubled. */
    let wrote = false;
    await kv.mutate(`inv_${userId}`, (inv) => {
      const next = applyPlan(inv, plan, { includeUnattributed });
      wrote = next !== undefined;
      return next;
    });
    if (wrote) touched++;
  }
  line(`Applied across ${touched} inventories.`);
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[repair]', err.message); process.exit(1); });
}
