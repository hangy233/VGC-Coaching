import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {gzipSync} from 'node:zlib';
import {deleteTeamReport,planTeamCleanup,cleanupEvictedTeams} from './team-cleanup.mjs';
import {registerTeamFromText,rememberMetricsSource,refreshMetricsSources} from './import.mjs';
import {saveBattle,getTeamReport,listBattles,listTeams,registerMetricsTeam} from './store.mjs';
import {updateTeamReport} from './live-reports.mjs';
import {exportReport} from './dashboard.mjs';
import {saveGameEvidence} from './retention.mjs';
import {attachVerifiedReplay} from './replay-evidence.mjs';
import {getMetricsTeamDeletion,listMetricsTeamDeletions,acquireMetricsBattleLock} from './catalog.mjs';

const FORMAT='gen9championsvgc2026regmcbo3';
const ROOM=`battle-${FORMAT}-101`,SECOND_ROOM=`battle-${FORMAT}-102`,PARENT=`game-bestof3-${FORMAT}-100`;
const TEAM=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']].map(([name,ability])=>`${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
const OTHER='b'.repeat(64);
const hash=value=>createHash('sha256').update(value).digest('hex');
const replayCache=room=>`cache/team-metrics/replays/${hash(room.replace(/^battle-/u,''))}.json`;
const LOG='|gametype|doubles\n|tier|[Gen 9] Champions VGC 2026 Reg M-C\n|player|p1|Fixture\n|player|p2|Opponent\n|start\n|turn|1\n|move|p1a: Golisopod|Protect|p1a: Golisopod\n|win|Fixture\n';
const protocol=room=>`>${room}\n${LOG}`;
const events=room=>LOG.trimEnd().split('\n').map(line=>{const [,type,...data]=line.split('|');return {room,event:'battle-event',type,data};});
const record=(teamId,{roomId=ROOM,parentId=PARENT,sources=[]}={})=>({schemaVersion:1,roomId,parentId,teamId,username:'Fixture',ownSide:'p1',players:{p1:'Fixture',p2:'Opponent'},outcome:'win',completed:true,turns:1,opponentRoster:['Charizard'],selected:['Golisopod'],selectionKnown:true,leads:['Golisopod'],pokemon:[{key:'golisopod',species:'Golisopod',forms:[],selected:true,lead:true,moves:[{move:'Protect',uses:1}]}],quality:{complete:true,operational:false,warnings:[]},team:{name:'Disposable fixture',format:'gen9championsvgc2026regmc',roster:['Golisopod','Kommo-o','Rillaboom','Politoed','Farigiraf','Sylveon']},metadata:{sources,setResult:{outcome:'win',completed:true}}});
async function fixture(t){const workspace=await mkdtemp(join(tmpdir(),'vgcm-cleanup-'));t.after(()=>rm(workspace,{recursive:true,force:true}));return workspace;}
async function put(workspace,file,content){const path=join(workspace,file);await mkdir(dirname(path),{recursive:true});await writeFile(path,content);return path;}
async function absent(workspace,files){for(const file of files)await assert.rejects(readFile(join(workspace,file)),{code:'ENOENT'},file);}
async function cacheReplay(workspace,room){const file=replayCache(room);await put(workspace,file,JSON.stringify({schemaVersion:1,kind:'official-showdown-replay',id:room.slice(7),formatid:FORMAT,log:LOG}));return file;}

test('deleting a zero-game team removes its snapshot, stable reports, custom exports and orphaned generated files',async t=>{
  const workspace=await fixture(t),registration=await registerTeamFromText({workspace,teamText:TEAM,name:'Empty fixture'}),teamId=registration.teamId;
  const report=await getTeamReport({workspace,teamId,touch:false}),files=[registration.savedTeamFile];
  for(const suffix of ['.html','.agent.json','.agent.md'])files.push(`cache/team-metrics/reports/teams/${teamId}${suffix}`);
  for(const format of ['html','json','csv']){
    await exportReport({workspace,report,format,output:'custom-name-without-fingerprint.'+format});
    files.push('cache/team-metrics/reports/custom-name-without-fingerprint.'+format);
  }
  for(const directory of ['','teams','reports/teams','evidence','replays']){
    const file=`cache/team-metrics/${directory?directory+'/':''}.pending-${teamId}-${randomUUID()}.tmp`;
    await put(workspace,file,'Abandoned generated temporary file');files.push(file);
  }
  const orphan=`cache/team-metrics/evidence/${SECOND_ROOM}--${teamId}.events.json.gz`;
  await put(workspace,orphan,gzipSync('Orphaned team evidence'));files.push(orphan,await cacheReplay(workspace,SECOND_ROOM));
  const historical=`cache/team-metrics/evidence/${SECOND_ROOM}--${teamId}.owned-status.json.gz`;
  await put(workspace,historical,gzipSync('Original synthetic historical status bytes'));files.push(historical);
  const authored=await put(workspace,'teams/original.txt',TEAM),unrelated=await put(workspace,'cache/unrelated-notes.txt','Unrelated notebook');
  const before=(await listTeams({workspace}))[0].usageOrder;
  const plan=await deleteTeamReport({workspace,teamId});
  assert.equal(plan.dryRun,true);assert.equal(plan.ready,true);assert.equal(plan.removed.length,0);
  assert(files.every(file=>plan.files.some(entry=>entry.path===file)));
  assert.equal((await listTeams({workspace}))[0].usageOrder,before);
  assert.equal(await readFile(authored,'utf8'),TEAM);
  await assert.rejects(deleteTeamReport({workspace,teamId,dryRun:false}),/confirmed:true/);
  const deleted=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true});
  assert.equal(deleted.complete,true);assert.equal(deleted.pending,false);assert.equal(deleted.retained.length,0);
  await absent(workspace,files);assert.deepEqual(await listTeams({workspace,includeArchived:true}),[]);
  assert.equal((await getMetricsTeamDeletion({workspace,teamId})).state,'deleted');
  assert.equal(await readFile(authored,'utf8'),TEAM);assert.equal(await readFile(unrelated,'utf8'),'Unrelated notebook');
  assert.equal((await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true})).complete,true);
});

test('team deletion cascades through real game evidence, replay cache, sources, set logs and reviews without touching another team',async t=>{
  const workspace=await fixture(t),registration=await registerTeamFromText({workspace,teamText:TEAM}),teamId=registration.teamId;
  const raw='cache/fixture-events.log',ledger='cache/fixture-results.json',review='cache/champions-mc-reviews/fixture.json',run=`cache/bo3-runs/${PARENT}/events.jsonl`,temporary=`cache/bo3-runs/${PARENT}/work.tmp`;
  await put(workspace,raw,protocol(ROOM));
  await put(workspace,ledger,JSON.stringify({sets:[{parentId:PARENT,children:[{id:ROOM}]}]}));
  const saved=await saveBattle({workspace,record:record(teamId,{sources:[raw,ledger]})});
  const evidence=await saveGameEvidence({workspace,teamId,roomId:ROOM,events:events(ROOM)});
  const replay=await attachVerifiedReplay({workspace,teamId,roomId:ROOM,url:`https://replay.pokemonshowdown.com/${ROOM.slice(7)}`,fetchImpl:async()=>new Response(JSON.stringify({id:ROOM.slice(7),formatid:FORMAT,log:LOG}),{status:200})});
  const cache=await cacheReplay(workspace,ROOM);
  await put(workspace,review,JSON.stringify({teamSha256:teamId,parentId:PARENT,decisionReview:{note:'Fixture review'}}));
  await put(workspace,run,events(ROOM).map(value=>JSON.stringify(value)).join('\n')+'\n');
  await put(workspace,temporary,'Discardable work');
  await rememberMetricsSource({workspace,source:{files:[raw],ledgerFile:ledger,username:'Fixture',teamFile:registration.savedTeamFile,expectedTeamId:teamId}});
  await saveBattle({workspace,record:record(OTHER,{roomId:SECOND_ROOM,parentId:null})});
  const other=await updateTeamReport({workspace,teamId:OTHER}),otherBefore=await readFile(other.path,'utf8');
  await updateTeamReport({workspace,teamId});
  const deleted=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true});
  assert.equal(deleted.complete,true,JSON.stringify(deleted.retained));
  await absent(workspace,[saved.path,evidence.evidence.path,replay.replay.evidencePath,cache,raw,ledger,review,run,temporary,registration.savedTeamFile]);
  assert.equal(await readFile(other.path,'utf8'),otherBefore);
  assert.deepEqual((await listBattles({workspace,includeArchived:true})).map(value=>value.teamId),[OTHER]);
  await assert.rejects(readFile(join(workspace,'cache/team-metrics/sources/registry.json')),{code:'ENOENT'});
  assert.equal((await refreshMetricsSources({workspace})).refreshed,0);
  await assert.rejects(getTeamReport({workspace,teamId}),/unknown|deleted/);
});

test('shared raw logs and replay caches remain pending across retries until the final owning team is cleaned',async t=>{
  const workspace=await fixture(t),first='a'.repeat(64),second=OTHER,raw='cache/shared-events.log';
  await put(workspace,raw,protocol(ROOM));const cache=await cacheReplay(workspace,ROOM);
  await saveBattle({workspace,record:record(first,{sources:[raw,cache]})});
  await saveBattle({workspace,record:record(second,{sources:[raw,cache]})});
  const run=()=>deleteTeamReport({workspace,teamId:first,dryRun:false,confirmed:true});
  for(let attempt=0;attempt<3;attempt++){
    const result=await run();assert.equal(result.complete,false);assert.equal(result.pending,true);
    for(const file of [raw,cache])assert(result.retained.some(entry=>entry.path===file),file);
    assert.equal(await readFile(join(workspace,raw),'utf8'),protocol(ROOM));
  }
  assert.equal((await listMetricsTeamDeletions({workspace})).some(value=>value.teamId===first),true);
  const lastOwner=await deleteTeamReport({workspace,teamId:second,dryRun:false,confirmed:true});
  assert.equal(lastOwner.complete,true);await absent(workspace,[raw,cache]);
  const finished=await run();assert.equal(finished.complete,true);assert.equal(finished.pending,false);
  assert.deepEqual(await listMetricsTeamDeletions({workspace}),[]);
});

test('an open matching client blocks removal and only read-only status is requested',async t=>{
  const workspace=await fixture(t),teamId='a'.repeat(64);
  await registerMetricsTeam({workspace,teamId,name:'Active fixture',roster:['Golisopod']});
  const stable=await updateTeamReport({workspace,teamId}),before=await readFile(stable.path,'utf8');
  await put(workspace,'cache/showdown-session.json',JSON.stringify({version:1,pid:process.pid,sessionId:'fixture'}));
  const calls=[],sessionCall=async(_descriptor,command)=>{calls.push(command);return {ok:true,result:{teamSha256:teamId,stopped:false}};};
  const result=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true,sessionCall});
  assert.equal(result.complete,false);assert.equal(result.pending,true);assert.equal(result.removed.length,0);assert.equal(result.ready,false);
  assert(result.blockers.some(value=>value.includes('open battle session')));assert(calls.length>0);assert(calls.every(value=>value.op==='status'));
  assert.equal(await readFile(stable.path,'utf8'),before);assert.equal(await getMetricsTeamDeletion({workspace,teamId}),null);
  const unavailable=await planTeamCleanup({workspace,teamId,sessionCall:async()=>{throw new Error('Unavailable fixture');}});
  assert.equal(unavailable.ready,false);assert(unavailable.blockers.some(value=>value.includes('could not be verified')));
});

test('unrecognized notes in a raw protocol source are retained through repeated cleanup attempts',async t=>{
  const workspace=await fixture(t),teamId='a'.repeat(64),raw='cache/partly-unrelated.log',content=protocol(ROOM)+'Private unrelated planning notes\n';
  await put(workspace,raw,content);await saveBattle({workspace,record:record(teamId,{sources:[raw]})});
  for(let attempt=0;attempt<2;attempt++){
    const result=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true});
    assert.equal(result.complete,false);assert.equal(result.pending,true);
    assert(result.retained.some(value=>value.path===raw&&value.reason.includes('unrecognized')));
    assert.equal(await readFile(join(workspace,raw),'utf8'),content);
  }
});

test('team deletion rejects a junction escaping the cache before deleting any owned file',async t=>{
  const workspace=await fixture(t),outside=await mkdtemp(join(tmpdir(),'vgcm-cleanup-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  const teamId='a'.repeat(64);await registerMetricsTeam({workspace,teamId,name:'Linked fixture',roster:['Golisopod']});
  const stable=await updateTeamReport({workspace,teamId});await writeFile(join(outside,'private.txt'),'Outside data stays intact');
  try{await symlink(outside,join(workspace,'cache/team-metrics/evidence'),process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Symbolic links are unavailable');return;}throw error;}
  await assert.rejects(deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true}),/linked|unsafe/);
  assert.match(await readFile(stable.path,'utf8'),/report-data/);
  assert.equal(await readFile(join(outside,'private.txt'),'utf8'),'Outside data stays intact');
  assert.equal(await getMetricsTeamDeletion({workspace,teamId}),null);
});

test('a live team writer lease prevents cascade deletion until the writer releases it',async t=>{
  const workspace=await fixture(t),teamId='a'.repeat(64);await saveBattle({workspace,record:record(teamId)});
  const release=await acquireMetricsBattleLock({workspace,teamId,roomId:ROOM});
  try{await assert.rejects(deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true}),/active local writer/);assert.equal((await listBattles({workspace})).length,1);}
  finally{await release();}
  assert.equal((await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true})).complete,true);
});

test('registering an eleventh legal team permanently removes the oldest report and all owned artifacts',async t=>{
  const workspace=await fixture(t),registered=[];
  const first=await registerTeamFromText({workspace,teamText:TEAM.replace('32 HP / 32 SpA / 2 SpD','1 HP / 32 SpA / 2 SpD'),name:'Version 1'});registered.push(first);
  const raw='cache/oldest-version.log';await put(workspace,raw,protocol(ROOM));
  const saved=await saveBattle({workspace,record:record(first.teamId,{sources:[raw]})});
  const evidence=await saveGameEvidence({workspace,teamId:first.teamId,roomId:ROOM,events:events(ROOM)});
  const pilot=await pilotArtifacts(workspace,first.teamId);
  await updateTeamReport({workspace,teamId:first.teamId});
  const exported=await exportReport({workspace,report:await getTeamReport({workspace,teamId:first.teamId,touch:false}),format:'json',output:'oldest-team-export.json'});
  for(let index=2;index<=11;index++)registered.push(await registerTeamFromText({workspace,teamText:TEAM.replace('32 HP / 32 SpA / 2 SpD',`${index} HP / 32 SpA / 2 SpD`),name:'Version '+index}));
  assert.equal(new Set(registered.map(value=>value.teamId)).size,11);
  assert.equal((await listTeams({workspace})).length,10);assert.equal((await listTeams({workspace,includeArchived:true})).length,10);
  await absent(workspace,[first.savedTeamFile,saved.path,evidence.evidence.path,raw,'cache/team-metrics/reports/oldest-team-export.json',`cache/team-metrics/reports/teams/${first.teamId}.html`,`cache/team-metrics/reports/teams/${first.teamId}.agent.json`,`cache/team-metrics/reports/teams/${first.teamId}.agent.md`]);
  await absent(workspace,pilot.files);
  assert.equal((await getMetricsTeamDeletion({workspace,teamId:first.teamId})).state,'deleted');
  assert.equal((await listBattles({workspace,includeArchived:true})).length,0);
  assert.equal((await cleanupEvictedTeams({workspace,teamIds:[]})).complete,true);
  assert.equal((await readdir(join(workspace,'cache/team-metrics/reports'))).includes('oldest-team-export.json'),false);
  await assert.rejects(readFile(exported.path),{code:'ENOENT'});
  for(const team of registered.slice(1))assert.match(await readFile(team.stableReport.path,'utf8'),/report-data/);
});

async function pilotArtifacts(workspace,teamId,{parentId=PARENT,marker={schemaVersion:1,kind:'private-offline-timing-pilot-artifacts',teamId,parentId}}={}){
  const directory=`cache/bo3-runs/${parentId}/offline-timing-pilot`;
  const files=[directory+'/ownership.json',directory+'/dataset.json',directory+'/locked-team.txt',directory+'/prepare-dataset.mjs',
    directory+'/trials/P01/low/repeat1/helper.response.json.responses/opaque-id.json',
    directory+'/trials/P01/low/repeat1/helper.response.json.responses/guidance/skill.txt',
    directory+'/trials/P01/low/repeat1/timing.jsonl',directory+'/trials/P01/low/repeat1/timing.json.gz'];
  for(const file of files)await put(workspace,file,file.endsWith('/ownership.json')?JSON.stringify(marker):'Private disposable offline fixture artifact');
  return {directory,files,markerFile:files[0]};
}

test('whole-team cleanup adopts only the marked offline pilot under a stored owned parent, including nested receipts and guidance',async t=>{
  const workspace=await fixture(t),teamId='a'.repeat(64);await saveBattle({workspace,record:record(teamId)});
  const pilot=await pilotArtifacts(workspace,teamId);
  const unrelated=`cache/bo3-runs/${PARENT}/unregistered-experiment/notes.json`;
  await put(workspace,unrelated,'Unrelated nested folder remains protected');
  const plan=await planTeamCleanup({workspace,teamId});
  assert.equal(plan.ready,true,JSON.stringify(plan.blockers));
  assert(pilot.files.every(file=>plan.files.some(entry=>entry.path===file)));
  assert.equal(plan.files.filter(entry=>entry.kind==='offline-pilot-ownership').length,1);
  const result=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true});
  assert.equal(result.complete,true,JSON.stringify(result.retained));
  await absent(workspace,pilot.files);assert.equal(await readFile(join(workspace,unrelated),'utf8'),'Unrelated nested folder remains protected');
  assert.equal((await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true})).complete,true,'empty nested directories are idempotent');
});

test('a pilot marker cannot establish a parent by itself or override malformed/cross-team ownership',async t=>{
  const workspace=await fixture(t),teamId='a'.repeat(64);
  await registerMetricsTeam({workspace,teamId,name:'No stored parent fixture',roster:['Golisopod']});
  const unowned=await pilotArtifacts(workspace,teamId);
  assert.equal((await planTeamCleanup({workspace,teamId})).files.some(entry=>entry.path.startsWith(unowned.directory+'/')),false);
  await saveBattle({workspace,record:record(teamId)});
  for(const marker of [
    {schemaVersion:1,kind:'private-offline-timing-pilot-artifacts',teamId:OTHER,parentId:PARENT},
    {schemaVersion:1,kind:'private-offline-timing-pilot-artifacts',teamId,parentId:PARENT,extra:'unsupported'},
    {schemaVersion:1,kind:'private-offline-timing-pilot-artifacts',teamId,parentId:'game-bestof3-'+FORMAT+'-999'},
  ]){
    await put(workspace,unowned.markerFile,JSON.stringify(marker));
    const result=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true});
    assert.equal(result.ready,false);assert.equal(result.removed.length,0);assert.equal(result.pending,true);
    assert(result.blockers.some(reason=>reason.includes('Offline pilot')));
    assert.equal(await getMetricsTeamDeletion({workspace,teamId}),null);
    assert.equal(await readFile(join(workspace,unowned.files[1]),'utf8'),'Private disposable offline fixture artifact');
  }
});

test('pilot links and excessive depth block the whole deletion before touching owned or outside files',async t=>{
  const workspace=await fixture(t),teamId='a'.repeat(64);await saveBattle({workspace,record:record(teamId)});
  const pilot=await pilotArtifacts(workspace,teamId),outside=await mkdtemp(join(tmpdir(),'vgcm-pilot-outside-'));
  t.after(()=>rm(outside,{recursive:true,force:true}));await writeFile(join(outside,'private.txt'),'Outside data stays intact');
  const link=join(workspace,pilot.directory,'linked');
  try{await symlink(outside,link,process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Symbolic links are unavailable');return;}throw error;}
  const blocked=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true});
  assert.equal(blocked.ready,false);assert.equal(blocked.removed.length,0);
  assert.equal(await readFile(join(outside,'private.txt'),'utf8'),'Outside data stays intact');
  await rm(link,{recursive:true,force:true});
  const deep=pilot.directory+'/'+Array.from({length:9},(_,i)=>'depth'+i).join('/')+'/fixture.json';
  await put(workspace,deep,'Depth bound fixture');
  assert.equal((await planTeamCleanup({workspace,teamId})).ready,false);
  await absent(workspace,[`cache/team-metrics/deletions/${teamId}.json`]);
});

test('pending pilot journal hashes retain changed children and ownership marker through retries',async t=>{
  const workspace=await fixture(t),teamId='a'.repeat(64);await saveBattle({workspace,record:record(teamId)});
  const pilot=await pilotArtifacts(workspace,teamId),before=await planTeamCleanup({workspace,teamId});
  const changed=pilot.files[1],original=await readFile(join(workspace,changed),'utf8');
  const journal={schemaVersion:1,kind:'team-cleanup',teamId,roomIds:before.roomIds,parentIds:before.parentIds,
    files:before.files,retained:[]};
  await put(workspace,`cache/team-metrics/deletions/${teamId}.json`,JSON.stringify(journal));
  await put(workspace,changed,'Modified after pending cleanup plan');
  for(let retry=0;retry<2;retry++){
    const result=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true});
    assert.equal(result.complete,false);assert.equal(result.pending,true);
    assert(result.retained.some(entry=>entry.path===changed&&entry.reason.includes('changed')));
    assert(result.retained.some(entry=>entry.path===pilot.markerFile));
    assert.equal(await readFile(join(workspace,changed),'utf8'),'Modified after pending cleanup plan');
    assert.match(await readFile(join(workspace,pilot.markerFile),'utf8'),/private-offline-timing-pilot-artifacts/);
  }
  // Restoring the exact planned bytes permits the already-authorized retry.
  await put(workspace,changed,original);
  const complete=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true});
  assert.equal(complete.complete,true,JSON.stringify(complete.retained));await absent(workspace,pilot.files);
});

test('pilot adoption preserves a child referenced by another retained team and retains its ownership marker',async t=>{
  const workspace=await fixture(t),teamId='a'.repeat(64);await saveBattle({workspace,record:record(teamId)});
  const pilot=await pilotArtifacts(workspace,teamId),shared=pilot.files[1];
  await saveBattle({workspace,record:record(OTHER,{roomId:SECOND_ROOM,parentId:null,sources:[shared]})});
  const result=await deleteTeamReport({workspace,teamId,dryRun:false,confirmed:true});
  assert.equal(result.complete,false);assert.equal(result.pending,true);
  assert(result.retained.some(entry=>entry.path===shared&&entry.reason.includes('Shared')));
  assert(result.retained.some(entry=>entry.path===pilot.markerFile));
  assert.equal(await readFile(join(workspace,shared),'utf8'),'Private disposable offline fixture artifact');
});
