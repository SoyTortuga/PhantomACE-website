#!/usr/bin/env node
/* Clamp any non-finite / over-cap Skull Clicker value to a finite ceiling.
   node server/scripts/scrub-skull-infinity.js --service phantomace-web
   node server/scripts/scrub-skull-infinity.js --service phantomace-web --confirm
   Optional: --name mvgfamous (match by display name)  --user-id 123456 (scrub that save too)
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
const NUM = ['skulls','totalSkulls','lifetimeSkulls','prestige','totalClicks','clickBonus','cpsClickPct','boneShards','cursedPopped','seasonBaseline','ascensions','epitaphs','highestPrestige','graveBlooms','petLevel','essence','spellsCast','spellsBackfired','gardenTier','gardenPlanted','gardenHarvests','wisps','startTime','bloomStart','seasonEndsAt','apocStart','apocPacifiedUntil','savedAt'];
function sanitizeState(s){ if(!s||typeof s!=='object')return {s,changed:false}; let c=false;
  for(const k of NUM) if(typeof s[k]==='number'&&s[k]!==finite(s[k])){s[k]=finite(s[k]);c=true;}
  for(const key of ['owned','metaLevels','buildingLevels','perkLevels']){const m=s[key]; if(m&&typeof m==='object')for(const k in m)if(typeof m[k]==='number'&&m[k]!==finite(m[k])){m[k]=finite(m[k]);c=true;}}
  if(!(finite(s.clickMulti)>0)){s.clickMulti=1;c=true;} if(!(finite(s.globalCpsMult)>0)){s.globalCpsMult=1;c=true;}
  return {s,changed:c}; }
const arg=(n)=>{const h=process.argv.find(a=>a.startsWith(`--${n}=`)); if(h)return h.slice(n.length+3); const i=process.argv.indexOf(`--${n}`); if(i!==-1&&process.argv[i+1]&&!process.argv[i+1].startsWith('--'))return process.argv[i+1]; return process.argv.includes(`--${n}`)||false;};

async function main(){
  const service=arg('service'), confirm=arg('confirm')===true, name=(arg('name')||'mvgfamous').toString().toLowerCase(), userId=arg('user-id');
  const url=resolveDatabaseUrl({service, fallback:arg('database-url')});
  if(!url){console.error('No DATABASE_URL. Use --service phantomace-web.');process.exit(2);}
  const pool=createPool(url); const info=await waitForDatabase(); console.log('Database:',info.db);
  const kv=createKVStore(pool);
  const ids=new Set(); if(userId)ids.add(String(userId));
  let edits=0;
  for(const key of ['sc_leaderboard','sc_season']){
    const raw=await kv.get(key,'json'); if(!raw)continue;
    const entries=Array.isArray(raw)?raw:(Array.isArray(raw.entries)?raw.entries:null); if(!entries)continue;
    let changed=false;
    for(const e of entries){
      const hit=bad(e.score)||bad(e.prestige)||bad(e.ascensions)||(e.name||'').toLowerCase()===name;
      if(hit&&e.id)ids.add(String(e.id));
      if(bad(e.score)||(e.name||'').toLowerCase()===name){ console.log(`${key}: ${e.name} score ${e.score} -> ${finite(e.score)}`); e.score=finite(e.score); changed=true; }
      if(bad(e.prestige)){e.prestige=Math.min(9999,Math.floor(finite(e.prestige)));changed=true;}
      if(bad(e.ascensions)){e.ascensions=Math.min(99999,Math.floor(finite(e.ascensions)));changed=true;}
    }
    if(changed){ edits++; if(confirm){ if(Array.isArray(raw))entries.sort((a,b)=>b.score-a.score); await kv.put(key,raw); console.log(`  ${key} rewritten`);} }
  }
  for(const id of ids){
    const k=`sc_save_${id}`; const st=await kv.get(k,'json'); if(!st)continue;
    const {changed}=sanitizeState(st);
    if(changed){ edits++; console.log(`${k}: numeric fields clamped`); if(confirm){ await kv.put(k,st); console.log(`  ${k} rewritten`);} }
  }
  console.log(''); console.log(confirm?`Done. ${edits} record(s) rewritten.`:`DRY RUN — ${edits} record(s) would change. Re-run with --confirm.`);
  await pool.end();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){ main().catch(e=>{console.error(e.message);process.exit(1);}); }
