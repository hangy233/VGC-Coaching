import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {registerPlanningNumericCache,planningNumericCacheGeneration,invalidatePlanningTeamCaches} from './numeric-cache.mjs';
import {analyzeNumerics} from './numerics.mjs';
import {buildTurnFacts} from './board.mjs';
import {planningFixture} from './fixtures.mjs';
import {registerMetricsTeam,getMetricsTeamDeletion,acquireMetricsBattleLock} from '../metrics/catalog.mjs';
import {deleteTeamReport} from '../metrics/team-cleanup.mjs';
const teamId='a'.repeat(64),other='b'.repeat(64);

test('registration caches stay bounded and workspace-scoped; deleting one owner preserves other ready entries',()=>{
  const cache=registerPlanningNumericCache({workspace:process.cwd()}),elsewhere=registerPlanningNumericCache({workspace:join(tmpdir(),'other-cache-workspace')});
  cache.set('owned',{ownerTeamId:teamId});cache.set('other',{ownerTeamId:other});elsewhere.set('owned',{ownerTeamId:teamId});
  const generation=planningNumericCacheGeneration(cache);assert.equal(invalidatePlanningTeamCaches({workspace:process.cwd(),teamId}).removed,1);assert.equal(cache.has('owned'),false);assert.equal(cache.has('other'),true);assert.equal(elsewhere.has('owned'),true);assert(planningNumericCacheGeneration(cache)>generation);
  for(let i=0;i<300;i++)cache.set(`extra-${i}`,{});assert.equal(registerPlanningNumericCache({workspace:process.cwd(),cache}),cache);assert.equal(cache.size,256);
});

test('an actual team deletion invalidates owned cache and prevents in-flight reinsertion; a dry run retains it',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'planning-cache-deletion-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  await registerMetricsTeam({workspace,teamId,name:'Cache owner'});const cache=registerPlanningNumericCache({workspace});cache.set('ready',{ownerTeamId:teamId});cache.set('other',{ownerTeamId:other});
  assert.equal((await deleteTeamReport({workspace,teamId})).dryRun,true);assert.equal(cache.has('ready'),true);
  const ctx=buildTurnFacts(planningFixture());ctx.calculationCacheOwnerTeamId=teamId;let finish;
  const callTool=Object.assign(async()=>new Promise(resolve=>{finish=()=>resolve({structuredContent:{gen:0,pokemon:[],order:[]}});}),{runtimeVersion:'late-cache-writer'});
  const pending=analyzeNumerics(ctx,{callTool,cache,maxCalls:1,budgetMs:2000});await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof finish,'function');
  const deleted=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true});assert.equal(deleted.complete,true);assert.equal(cache.has('ready'),false);assert.equal(cache.has('other'),true);
  finish();await pending;assert.equal(cache.size,1,'A calculation begun before deletion cannot repopulate the cache');
});

test('LRU capacity deletion also invalidates the evicted owner cache',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'planning-cache-lru-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const cache=registerPlanningNumericCache({workspace}),first=(1).toString(16).padStart(64,'0');cache.set('first',{ownerTeamId:first});cache.set('other',{ownerTeamId:other});
  for(let i=1;i<=11;i++)await registerMetricsTeam({workspace,teamId:i.toString(16).padStart(64,'0'),name:'LRU cache fixture'});
  assert.equal((await getMetricsTeamDeletion({workspace,teamId:first})).state,'deleted');assert.equal(cache.has('first'),false);assert.equal(cache.has('other'),true);
});

test('a blocked active-writer deletion preserves the owner cache and generation until an actual deletion begins',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'planning-cache-busy-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  await registerMetricsTeam({workspace,teamId,name:'Busy cache owner'});const cache=registerPlanningNumericCache({workspace});cache.set('ready',{ownerTeamId:teamId});
  const before=planningNumericCacheGeneration(cache),release=await acquireMetricsBattleLock({workspace,teamId,roomId:'cache-writer'});
  try{await assert.rejects(deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true}),/active local writer/);assert.equal(cache.has('ready'),true);assert.equal(planningNumericCacheGeneration(cache),before);}finally{await release();}
  assert.equal((await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true})).complete,true);assert.equal(cache.has('ready'),false);
});
