import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {beginMetricsTeamDeletion} from './catalog.mjs';
import {mutateMetricsSources,registerTeamFromText,rememberMetricsSource,saveMetricsTeamSnapshot} from './import.mjs';
import {teamReportPath,updateTeamReport} from './live-reports.mjs';
import {exportReport} from './dashboard.mjs';
import {attachVerifiedReplay} from './replay-evidence.mjs';
import {importReplayUrls} from './replays.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const TEAM=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']]
  .map(([name,ability])=>`${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
const ROOM='battle-gen9championsvgc2026regmcbo3-123',URL='https://replay.pokemonshowdown.com/'+ROOM.slice(7);
const LOG='|gametype|doubles\n|player|p1|Fixture\n|player|p2|Opponent\n|start\n|turn|1\n|win|Fixture\n';
async function fixture(t){
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-artifact-writers-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  await mkdir(join(workspace,'teams'));await writeFile(join(workspace,'teams/team.txt'),TEAM);
  const registration=await registerTeamFromText({workspace,teamText:TEAM,name:'Fixture team'});
  return {workspace,...registration};
}
async function artifactNames(directory,prefix=''){
  const names=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(entry.name.startsWith('catalog.sqlite'))continue;
    const name=prefix+entry.name;
    if(entry.isDirectory())names.push(...await artifactNames(join(directory,entry.name),name+'/'));
    else names.push(name);
  }
  return names.sort();
}

test('deleted team guards every generated artifact writer before files or source references reappear',async t=>{
  const {workspace,teamId}=await fixture(t),team=Teams.import(TEAM);
  await beginMetricsTeamDeletion({workspace,teamId});
  const before=await artifactNames(join(workspace,'cache','team-metrics'));
  const operations=[
    ()=>saveMetricsTeamSnapshot({workspace,teamId,team}),
    ()=>updateTeamReport({workspace,teamId}),
    ()=>teamReportPath({workspace,teamId,create:true}),
    ()=>exportReport({workspace,report:{team:{teamId}},format:'json',output:'must-not-exist.json'}),
    ()=>rememberMetricsSource({workspace,source:{expectedTeamId:teamId,username:'Fixture',teamFile:'teams/team.txt',files:['cache/battle.log']}}),
    ()=>attachVerifiedReplay({workspace,teamId,roomId:ROOM,url:URL,fetchImpl:()=>{throw new Error('Unexpected network request');}}),
    ()=>importReplayUrls({workspace,teamFile:'teams/team.txt',username:'Fixture',urls:[URL],fetchImpl:()=>{throw new Error('Unexpected network request');}}),
  ];
  for(const operation of operations)await assert.rejects(operation,{code:'METRICS_TEAM_DELETED'});
  assert.deepEqual(await artifactNames(join(workspace,'cache','team-metrics')),before);
});

test('a team deleted while a replay is downloading cannot recreate a replay cache',async t=>{
  const {workspace,teamId}=await fixture(t);
  let started,release;
  const fetching=new Promise(resolve=>{started=resolve;}),download=new Promise(resolve=>{release=resolve;});
  const importing=importReplayUrls({workspace,teamFile:'teams/team.txt',username:'Fixture',urls:[URL],fetchImpl:async()=>{
    started();await download;return new Response(JSON.stringify({id:ROOM.slice(7),log:LOG}));
  }});
  await fetching;await beginMetricsTeamDeletion({workspace,teamId});release();
  await assert.rejects(importing,{code:'METRICS_TEAM_DELETED'});
  await assert.rejects(readdir(join(workspace,'cache','team-metrics','replays')),{code:'ENOENT'});
});

test('source mutations serialize additions and deletion and remove an empty registry',async t=>{
  const {workspace,teamId}=await fixture(t);
  const source={expectedTeamId:teamId,username:'Fixture',teamFile:'teams/team.txt',files:['cache/battle.log']};
  await rememberMetricsSource({workspace,source});
  await Promise.all([
    mutateMetricsSources({workspace,update:async sources=>{await new Promise(resolve=>setImmediate(resolve));return [...sources,{key:'unrelated',expectedTeamId:'b'.repeat(64)}];}}),
    mutateMetricsSources({workspace,update:sources=>sources.filter(value=>value.expectedTeamId!==teamId)}),
  ]);
  const registry=join(workspace,'cache','team-metrics','sources','registry.json');
  assert.deepEqual(JSON.parse(await readFile(registry,'utf8')),[{key:'unrelated',expectedTeamId:'b'.repeat(64)}]);
  await mutateMetricsSources({workspace,update:()=>[]});
  await assert.rejects(readFile(registry),{code:'ENOENT'});
});
