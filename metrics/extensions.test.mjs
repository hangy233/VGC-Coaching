import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {saveBattle,getTeamReport,listBattles,listTeams} from './store.mjs';
import {annotateGame,getGameAnnotations} from './annotations.mjs';
import {getMetricsHealth} from './health.mjs';
import {compareTeamReports} from './compare.mjs';
import {getAgentTeamReport} from './agent-service.mjs';
import {renderCsv,renderDashboard,aggregateFilteredGames} from './dashboard.mjs';
import {deleteTeamReport} from './team-cleanup.mjs';
import {startMetricsViewer} from './viewer.mjs';
import {getMetricsViewerStatus,ensureMetricsViewer} from './viewer-service.mjs';
import {registerTeamFromText} from './import.mjs';
const TEAM='a'.repeat(64),OTHER='b'.repeat(64),ROOM='battle-fixture-1',PARENT='game-bestof3-fixture-1';
const record=(overrides={})=>({schemaVersion:1,roomId:ROOM,parentId:PARENT,teamId:TEAM,username:'Fixture',ownSide:'p1',players:{p1:'Fixture',p2:'Other'},outcome:'win',completed:true,turns:1,opponentRoster:['Charizard'],selected:['Golisopod'],selectionKnown:true,leads:['Golisopod'],pokemon:[{key:'golisopod',species:'Golisopod',forms:[],selected:true,lead:true,moves:[{move:'Protect',uses:1}]}],quality:{complete:true,operational:false,warnings:[]},team:{name:'Fixture',format:'gen9championsvgc2026regmc',roster:['Golisopod']},metadata:{setResult:{outcome:'win',completed:true}},...overrides});
async function fixture(t){const workspace=await mkdtemp(join(tmpdir(),'metrics-extensions-'));t.after(()=>rm(workspace,{recursive:true,force:true}));return workspace;}
test('audited exclusion applies equally to report, agent, CSV, dashboard and comparison, without replacing protocol facts',async t=>{
  const workspace=await fixture(t);await saveBattle({workspace,record:record()});await saveBattle({workspace,record:record({roomId:'battle-fixture-2',outcome:'loss'})});await saveBattle({workspace,record:record({roomId:'battle-fixture-3',teamId:OTHER})});
  const annotationId=randomUUID(),args={workspace,teamId:TEAM,roomId:ROOM,annotationId,action:'exclude',reason:'Technical disconnect reviewed from turns.'};
  assert.equal((await annotateGame(args)).status,'appended');assert.equal((await annotateGame(args)).status,'unchanged');
  await assert.rejects(annotateGame({...args,reason:'Rewrite'}),/cannot be rewritten/);
  const report=await getTeamReport({workspace,teamId:TEAM,touch:false});assert.equal(report.totals.games,1);assert.equal(report.totals.wins,0);assert.equal(report.totals.sets.played,0);assert.equal(report.totals.sets.excludedManual,1);assert.equal(report.quality.excludedManual,1);assert.equal(report.reviewAnnotations[0].reason,args.reason);
  assert.equal((await getAgentTeamReport({workspace,teamId:TEAM,touch:false})).quality.excludedManual,1);
  assert.match(renderCsv(report),/excludedManual,1,/);assert.match(renderDashboard(report),/manually excluded/);
  const filtered=aggregateFilteredGames(report,report.games);assert.equal(filtered.totals.sets.played,0);assert.equal(filtered.totals.sets.excludedManual,1);
  const comparison=await compareTeamReports({workspace,teamA:TEAM,teamB:OTHER});assert.equal(comparison.teamA.totals.games,1);assert.equal(comparison.teamB.totals.games,1);assert.equal(comparison.setChanges,null);
  const opted=await getTeamReport({workspace,teamId:TEAM,includeManuallyExcluded:true,touch:false});assert.equal(opted.totals.games,2);assert.equal(opted.totals.sets.played,1);assert.equal(opted.games.find(game=>game.roomId===ROOM).outcome,'win');
  await saveBattle({workspace,record:record()});assert.equal((await getGameAnnotations({workspace,teamId:TEAM,roomId:ROOM})).excluded,true);
  await annotateGame({workspace,teamId:TEAM,roomId:ROOM,action:'include',reason:'Connection confirmed healthy.'});assert.equal((await getTeamReport({workspace,teamId:TEAM,touch:false})).totals.games,2);
});
test('concurrent distinct annotations retain audit history and deletion removes annotations and all new private artifacts',async t=>{
  const workspace=await fixture(t);await saveBattle({workspace,record:record()});
  await Promise.all(['First note','Second note'].map(reason=>annotateGame({workspace,teamId:TEAM,roomId:ROOM,reason})));
  assert.equal((await getGameAnnotations({workspace,teamId:TEAM,roomId:ROOM})).history.length,2);
  const paths=[`cache/team-metrics/decision-notes/${TEAM}--${ROOM}.json`,`cache/team-metrics/calculations/${TEAM}--${randomUUID()}.json`,`cache/team-metrics/decision-notes/.pending-${TEAM}-${randomUUID()}.tmp`];
  for(const path of paths){await mkdir(join(workspace,path,'..'),{recursive:true});await writeFile(join(workspace,path),'Private fixture');}
  const deleted=await deleteTeamReport({workspace,teamId:TEAM,dryRun:false,confirmed:true});assert.equal(deleted.complete,true);for(const path of paths)await assert.rejects(readFile(join(workspace,path)),{code:'ENOENT'});
  assert.equal((await listBattles({workspace,includeArchived:true})).length,0);await assert.rejects(annotateGame({workspace,teamId:TEAM,roomId:ROOM,reason:'Stale'}),/not found/);
});
test('health is read only and exposes per-source missing data, invalid snapshots and pending cleanup without touching LRU',async t=>{
  const workspace=await fixture(t);await saveBattle({workspace,record:record()});
  await mkdir(join(workspace,'cache/team-metrics/sources'),{recursive:true});await writeFile(join(workspace,'cache/team-metrics/sources/registry.json'),JSON.stringify([{expectedTeamId:TEAM,files:['cache/missing.log']} ]));
  const order=(await listTeams({workspace}))[0].usageOrder;const health=await getMetricsHealth({workspace,teamId:TEAM});assert.equal(health.teams[0].snapshot.status,'missing-or-invalid');assert.deepEqual(health.teams[0].missingReplays,[ROOM]);assert.deepEqual(health.teams[0].missingOrInvalidEvidence,[ROOM]);assert.equal(health.teams[0].sourceDiagnostics[0].status,'missing');assert.equal((await listTeams({workspace}))[0].usageOrder,order);
});
test('viewer status proves exact workspace and ensure reuses the verified independent helper',async t=>{
  const workspace=await fixture(t),viewer=await startMetricsViewer({workspace,port:0});t.after(()=>viewer.close());const port=new URL(viewer.url).port*1;
  const status=await getMetricsViewerStatus({workspace,port,teamId:TEAM});assert.equal(status.verified,true);assert.equal(status.version,2);assert.equal(status.url,viewer.url+'?team='+TEAM);
  const reused=await ensureMetricsViewer({workspace,port,spawnViewer:()=>{throw new Error('Should reuse');}});assert.equal(reused.reused,true);assert.equal(reused.independentOfMcpTransport,true);
  const foreign=await getMetricsViewerStatus({workspace:join(workspace,'another'),port});assert.equal(foreign.occupied,true);assert.equal(foreign.verified,false);
  await assert.rejects(ensureMetricsViewer({workspace:join(workspace,'another'),port}),/unverified service/);
  assert.equal((await fetch(viewer.url+'api/viewer-status',{method:'POST'})).status,405);
});
test('viewer startup uses fixed executable/module arguments, hides window and does not stop existing services',async()=>{
  let attempts=0,spawned;const child={exitCode:null,once(){},unref(){this.unrefed=true;}};
  const status=async()=>++attempts===1?{running:false,occupied:false}:{running:true,verified:true,url:'http://127.0.0.1:52615/'};
  const result=await ensureMetricsViewer({workspace:process.cwd(),status,spawnViewer:(...args)=>{spawned=args;return child;}});assert.equal(result.reused,false);assert.equal(spawned[0],process.execPath);assert(spawned[1][0].endsWith('metrics\\viewer.mjs')||spawned[1][0].endsWith('metrics/viewer.mjs'));assert.equal(spawned[2].windowsHide,true);assert.equal(spawned[2].detached,true);assert.equal(child.unrefed,true);
});
test('comparison validates both immutable native-point sheets and exposes exact moves/items/spread changes without recency changes',async t=>{
  const workspace=await fixture(t),text=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']].map(([name,ability])=>`${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
  const a=await registerTeamFromText({workspace,teamText:text}),b=await registerTeamFromText({workspace,teamText:text.replace('Sylveon\n','Sylveon @ Fairy Feather\n').replaceAll('32 HP / 32 SpA / 2 SpD','30 HP / 32 SpA / 4 SpD')});
  const before=(await listTeams({workspace})).map(team=>[team.teamId,team.usageOrder]);
  const compared=await compareTeamReports({workspace,teamA:a.teamId,teamB:b.teamId,includeManuallyExcluded:true});assert.equal(compared.teamA.snapshot.status,'verified');assert.equal(compared.teamB.snapshot.status,'verified');assert.equal(compared.teamA.snapshot.sets[0].evs.hp,32);assert.equal(compared.teamB.snapshot.sets[0].evs.hp,30);assert.equal(compared.setChanges.length,6);assert(compared.setChanges.find(set=>set.species==='Sylveon').changes.some(change=>change.field==='item'&&change.after==='Fairy Feather'));assert.equal(compared.comparison.winRateDifferencePercentagePoints,null);assert.deepEqual((await listTeams({workspace})).map(team=>[team.teamId,team.usageOrder]),before);
});
test('new MCP tools have strict schemas and honest mutation annotations',async()=>{
  const {registerMetricsTools}=await import('./mcp-tools.mjs'),tools=new Map();registerMetricsTools({registerTool(name,settings,handler){tools.set(name,{settings,handler});}},{workspace:process.cwd()});
  for(const name of ['team_metrics_health','team_metrics_compare','team_metrics_game_annotations','team_metrics_viewer_status'])assert.equal(tools.get(name).settings.annotations.readOnlyHint,true);
  for(const name of ['team_metrics_annotate_game','team_metrics_open_viewer'])assert.equal(tools.get(name).settings.annotations.readOnlyHint,false);
  assert.equal(tools.get('team_metrics_compare').settings.inputSchema.safeParse({teamA:TEAM,teamB:OTHER,includeManuallyExcluded:true}).success,true);
  for(const args of [{teamA:TEAM,teamB:OTHER,apply:true},{teamA:'latest',teamB:OTHER}])assert.equal(tools.get('team_metrics_compare').settings.inputSchema.safeParse(args).success,false);
  const schema=tools.get('team_metrics_annotate_game').settings.inputSchema;assert.equal(schema.safeParse({teamId:TEAM,roomId:ROOM,action:'exclude',reason:'Reviewed disconnect',annotationId:randomUUID()}).success,true);for(const args of [{teamId:TEAM,roomId:ROOM,action:'win',reason:'False override'},{teamId:TEAM,roomId:ROOM,action:'exclude'},{teamId:TEAM,roomId:ROOM,reason:'x',outcome:'win'}])assert.equal(schema.safeParse(args).success,false);
  for(const args of [{host:'evil.example'},{command:'node arbitrary.js'},{port:0}])assert.equal(tools.get('team_metrics_open_viewer').settings.inputSchema.safeParse(args).success,false);
});
test('viewer startup failure cleans only its own child and concurrent verified winners are reused',async()=>{
  const child=()=>({pid:9876,exitCode:null,killed:0,once(){},unref(){},kill(){this.killed++;}});
  for(const winner of [false,true]){let checks=0;const own=child();const status=async()=>++checks===1?{running:false,occupied:false}:winner?{running:true,occupied:true,verified:true,pid:5432,url:'http://127.0.0.1:52615/'}:{running:false,occupied:true,verified:false};const operation=ensureMetricsViewer({workspace:process.cwd(),status,spawnViewer:()=>own});if(winner)assert.equal((await operation).reused,true);else await assert.rejects(operation,/unverified service/);assert.equal(own.killed,1);}
});
test('manual parent exclusions remain separately counted when operational games are explicitly included',async t=>{
  const workspace=await fixture(t);await saveBattle({workspace,record:record({quality:{complete:true,operational:true,warnings:[]}})});await saveBattle({workspace,record:record({roomId:'battle-fixture-2',outcome:'loss'})});await annotateGame({workspace,teamId:TEAM,roomId:ROOM,action:'exclude',reason:'Reviewed technical exclusion'});
  const report=await getTeamReport({workspace,teamId:TEAM,includeOperational:true,touch:false}),filtered=aggregateFilteredGames(report,report.games);assert.equal(report.totals.sets.excludedOperational,0);assert.equal(report.totals.sets.excludedManual,1);assert.equal(filtered.totals.sets.excludedOperational,0);assert.equal(filtered.totals.sets.excludedManual,1);
});
test('CLI manual-exclusion flag reaches reports and is restricted to report/review/export commands',async t=>{
  const {parseArguments,runCli}=await import('./cli.mjs');
  for(const command of ['report','review','export'])assert.equal(parseArguments([command,'--team',TEAM,'--include-manually-excluded']).values.includeManuallyExcluded,true);
  for(const command of ['list','register','import','delete'])assert.throws(()=>parseArguments([command,'--include-manually-excluded']),/not supported/);
  assert.throws(()=>parseArguments(['report','--include-manually-excluded','--include-manually-excluded']),/Duplicate option/);
  const workspace=await fixture(t);await saveBattle({workspace,record:record()});await annotateGame({workspace,teamId:TEAM,roomId:ROOM,action:'exclude',reason:'Reviewed technical disconnect'});
  const output=[];const included=await runCli(['report','--workspace',workspace,'--team',TEAM,'--include-manually-excluded'],{write:value=>output.push(value)});assert.equal(included.totals.games,1);assert.equal(included.filters.includeManuallyExcluded,true);assert.equal(JSON.parse(output[0]).reviewAnnotations[0].excluded,true);
  const omitted=await runCli(['report','--workspace',workspace,'--team',TEAM],{write:()=>{}});assert.equal(omitted.totals.games,0);assert.equal(omitted.quality.excludedManual,1);
});
