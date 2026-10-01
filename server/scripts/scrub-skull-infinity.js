#!/usr/bin/env node
/* Heal Skull Clicker values that overflowed to Infinity / past the ceiling.
   node server/scripts/scrub-skull-infinity.js --service phantomace-web
   node server/scripts/scrub-skull-infinity.js --service phantomace-web --confirm
   Heals by VALUE (>= ceiling / non-finite) only — a player who already reset and
   re-climbed a legit score is never touched.
   Optional: --name <display> (ALSO drop/scrub this exact name)  --user-id 123456 (also that save)

   Two modes:
     (default)  CLAMP — pin non-finite / over-cap numbers to the finite ceiling.
                Safe + idempotent, but corrupted lifetime totals all land on the SAME
                cap (1e300), so they tie at the top of the all-time board forever
                ("1.00 da" x N). Use this to stop "Infinity" showing; it does NOT
                un-tie the wall.
     --reset    DROP the corrupt entries from sc_leaderboard + sc_season and wipe the
                run + the corrupted all-time total on their saves (KEEPING legacy:
                ascensions, epitaphs, metaLevels, highestPrestige, wisps, grave blooms,
                garden/season unlocks). Bumps seasonEpoch to next month so the player's
                cached corrupt local save can't re-clobber the heal on next load. This
                is the real fix for the "1.00 da" tie — the overflowed lifetime values
                are unrecoverable, so the corrupted players re-climb from a clean run.
   Dry-run unless --confirm. Idempotent. */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });
import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';

const CAP = 1e300;
const finite = (v) => { const n = Number(v); if (Number.isFinite(n)) return n < 0 ? 0 : (n > CAP ? CAP : n); return n === Infinity ? CAP : 0; };
const bad = (v) => typeof v === 'number' && (!Number.isFinite(v) || v > CAP);
/* At OR over the ceiling. A prior clamp run pins corrupt values to exactly CAP,
   which `bad` (strictly > CAP) no longer sees — so --reset must flag >= CAP to
   catch already-clamped entries, not only still-overflowing ones. */
const over = (v) => typeof v === 'number' && (!Number.isFinite(v) || v >= CAP);
const NUM = ['skulls','totalSkulls','lifetimeSkulls','prestige','totalClicks','clickBonus','cpsClickPct','boneShards','cursedPopped','seasonBaseline','ascensions','epitaphs','highestPrestige','graveBlooms','petLevel','essence','spellsCast','spellsBackfired','gardenTier','gardenPlanted','gardenHarvests','wisps','startTime','bloomStart','seasonEndsAt','apocStart','apocPacifiedUntil','savedAt'];
function sanitizeState(s){ if(!s||typeof s!=='object')return {s,changed:false}; let c=false;
  for(const k of NUM) if(typeof s[k]==='number'&&s[k]!==finite(s[k])){s[k]=finite(s[k]);c=true;}
  for(const key of ['owned','metaLevels','buildingLevels','perkLevels']){const m=s[key]; if(m&&typeof m==='object')for(const k in m)if(typeof m[k]==='number'&&m[k]!==finite(m[k])){m[k]=finite(m[k]);c=true;}}
  if(!(finite(s.clickMulti)>0)){s.clickMulti=1;c=true;} if(!(finite(s.globalCpsMult)>0)){s.globalCpsMult=1;c=true;}
  return {s,changed:c}; }

/* 'YYYY-MM' for the month AFTER now (UTC) — set as the save's seasonEpoch so the
   server heal strictly out-ranks any cached corrupt local save (serverOutranks
   ranks season epoch first). The player's next real monthly reset is a no-op. */
function nextMonthEpoch(){ const d=new Date(); const y=d.getUTCFullYear(), m=d.getUTCMonth()+1; return m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`; }

/* Mirror the game's applySeasonReset() + additionally zero the OVERFLOWED all-time
   total (which a normal season reset keeps — but here it is corrupt, not earned).
   KEEP legacy: ascensions, epitaphs, metaLevels, highestPrestige, wisps, graveBlooms,
   garden/season unlocks + discoveries. Returns true if anything changed. */
function resetState(s){ if(!s||typeof s!=='object')return false;
  s.skulls=0; s.totalSkulls=0; s.lifetimeSkulls=0; s.prestige=0; s.boneShards=0;
  s.clickBonus=0; s.clickMulti=1; s.cpsClickPct=0; s.globalCpsMult=1;
  s.owned={}; s.buildingLevels={}; s.perkLevels={}; s.metaPerks=[];
  s.boughtUpgrades=[]; s.boughtGhouls=[]; s.hitMilestones=[];
  s.seasonBaseline=0; s.startTime=Date.now(); s.seasonEpoch=nextMonthEpoch();
  for(const k of NUM) if(typeof s[k]==='number'&&s[k]!==finite(s[k])) s[k]=finite(s[k]);
  if(typeof s.highestPrestige==='number'&&s.highestPrestige!==finite(s.highestPrestige)) s.highestPrestige=Math.min(9999,Math.floor(finite(s.highestPrestige)));
  return true; }
const arg=(n)=>{const h=process.argv.find(a=>a.startsWith(`--${n}=`)); if(h)return h.slice(n.length+3); const i=process.argv.indexOf(`--${n}`); if(i!==-1&&process.argv[i+1]&&!process.argv[i+1].startsWith('--'))return process.argv[i+1]; return process.argv.includes(`--${n}`)||false;};

async function main(){
  const service=arg('service'), confirm=arg('confirm')===true, reset=arg('reset')===true, userId=arg('user-id');
  /* Opt-in only. By default we heal purely by VALUE (>= ceiling / non-finite) so a
     player who already reset and re-climbed a legit score is never dropped by name. */
  const nameArg=arg('name'); const name=(typeof nameArg==='string'?nameArg:'').toLowerCase();
  const url=resolveDatabaseUrl({service, fallback:arg('database-url')});
  if(!url){console.error('No DATABASE_URL. Use --service phantomace-web.');process.exit(2);}
  const pool=createPool(url); const info=await waitForDatabase(); console.log('Database:',info.db);
  console.log('Mode:', reset?'RESET (drop corrupt entries + wipe run, keep legacy)':'CLAMP (pin to ceiling)');
  const kv=createKVStore(pool);
  const ids=new Set(); if(userId)ids.add(String(userId));

  /* Ground truth: show what is actually stored on each board right now. */
  for(const key of ['sc_leaderboard','sc_season']){
    const raw=await kv.get(key,'json');
    const entries=Array.isArray(raw)?raw:(raw&&Array.isArray(raw.entries)?raw.entries:null);
    console.log(`\n${key}: ${entries?entries.length+' entries':'(empty/missing)'}`);
    if(entries) for(const e of entries.slice(0,5)) console.log(`   ${e.name}  score=${e.score}  (>=cap: ${over(e.score)})`);
  }
  console.log('');
  let edits=0;
  for(const key of ['sc_leaderboard','sc_season']){
    const raw=await kv.get(key,'json'); if(!raw)continue;
    const entries=Array.isArray(raw)?raw:(Array.isArray(raw.entries)?raw.entries:null); if(!entries)continue;
    const corrupt=(e)=>over(e.score)||over(e.prestige)||over(e.ascensions)||(e.name||'').toLowerCase()===name;
    for(const e of entries) if(corrupt(e)&&e.id)ids.add(String(e.id));

    if(reset){
      const kept=entries.filter(e=>!corrupt(e));
      const dropped=entries.length-kept.length;
      if(dropped>0){ edits++;
        for(const e of entries) if(corrupt(e)) console.log(`${key}: DROP ${e.name} (score ${e.score})`);
        if(confirm){ if(Array.isArray(raw)){kept.sort((a,b)=>b.score-a.score); await kv.put(key,kept);} else {raw.entries=kept; await kv.put(key,raw);} console.log(`  ${key} rewritten (${dropped} dropped)`);}
      }
      continue;
    }

    let changed=false;
    for(const e of entries){
      if(bad(e.score)||(e.name||'').toLowerCase()===name){ console.log(`${key}: ${e.name} score ${e.score} -> ${finite(e.score)}`); e.score=finite(e.score); changed=true; }
      if(bad(e.prestige)){e.prestige=Math.min(9999,Math.floor(finite(e.prestige)));changed=true;}
      if(bad(e.ascensions)){e.ascensions=Math.min(99999,Math.floor(finite(e.ascensions)));changed=true;}
    }
    if(changed){ edits++; if(confirm){ if(Array.isArray(raw))entries.sort((a,b)=>b.score-a.score); await kv.put(key,raw); console.log(`  ${key} rewritten`);} }
  }
  for(const id of ids){
    const k=`sc_save_${id}`; const st=await kv.get(k,'json'); if(!st)continue;
    /* Read-only peek at what the corrupt save actually holds, so we can judge
       whether any real number survives or it's all overflowed. */
    console.log(`\n${k} fields:`);
    for(const f of ['lifetimeSkulls','totalSkulls','skulls','prestige','highestPrestige','ascensions','epitaphs']) console.log(`   ${f} = ${st[f]}`);
    const changed = reset ? resetState(st) : sanitizeState(st).changed;
    if(changed){ edits++; console.log(`${k}: ${reset?'run wiped (legacy kept), seasonEpoch -> '+st.seasonEpoch:'numeric fields clamped'}`); if(confirm){ await kv.put(k,st); console.log(`  ${k} rewritten`);} }
  }
  console.log(''); console.log(confirm?`Done. ${edits} record(s) rewritten.`:`DRY RUN — ${edits} record(s) would change. Re-run with --confirm.`);
  await pool.end();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){ main().catch(e=>{console.error(e.message);process.exit(1);}); }
