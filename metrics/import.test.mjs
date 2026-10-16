import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importBattleFiles,refreshMetricsSources,readWorkspaceFile,collectBattleEvents,loadMetricsTeam,saveMetricsTeamSnapshot} from './import.mjs';
import {getTeamReport,listBattles} from './store.mjs';

const TEAM=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']].map(([name,ability])=>`${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
const ROOM='battle-gen9championsvgc2026regmcbo3-123-secretpw';
const e=(type,...data)=>({event:'battle-event',room:ROOM,type,data,at:Date.parse('2026-10-15T20:00:00Z')});
const EVENTS=[e('gametype','doubles'),e('player','p1','Opponent'),e('player','p2','Fixture'),e('poke','p1','Charizard, L50'),e('start'),e('switch','p2a: Shell','Golisopod, L50','182/182'),e('switch','p2b: Longneck','Farigiraf, L50','227/227'),e('switch','p1a: Charizard','Charizard, L50','100/100'),e('turn','1'),{event:'request',room:ROOM,request:{rqid:3,active:[],side:{id:'p2',name:'Fixture',pokemon:[{ident:'p2: Shell',details:'Golisopod, L50',active:true},{ident:'p2: Longneck',details:'Farigiraf, L50',active:true},{ident:'p2: Fish',details:'Politoed, L50',active:false},{ident:'p2: Ribbon',details:'Sylveon, L50',active:false}]}}},e('move','p2a: Shell','Protect','p2a: Shell'),e('win','Fixture')];
const jsonl=values=>values.map(v=>JSON.stringify(v)).join('\n')+'\n';

test('resent history keeps observed player identities without repeating earlier turns',()=>{
  const values=[e('player','p1','Opponent'),e('player','p2','Fixture'),e('gametype','doubles'),e('start'),e('turn','1'),e('move','p2a: Shell','Protect','p2a: Shell'),e('gametype','doubles'),e('start'),e('turn','1'),e('move','p2a: Shell','Protect','p2a: Shell'),e('win','Fixture')];
  const data=collectBattleEvents(values).get(ROOM.replace('-secretpw',''));
  assert.deepEqual(data.events.filter(value=>value.type==='player').map(value=>value.data.slice(0,2)),[['p1','Opponent'],['p2','Fixture']]);
  assert.equal(data.events.filter(value=>value.type==='move').length,1);
  const renewed=collectBattleEvents([...values,e('player','p1','Updated Opponent')]).get(ROOM.replace('-secretpw',''));
  assert.equal(renewed.events.filter(value=>value.type==='player'&&value.data[0]==='p1').length,1);
  assert.equal(renewed.events.find(value=>value.type==='player'&&value.data[0]==='p1').data[1],'Updated Opponent');
});
test('collector preserves prior start and progress facts across truncated preview-only history resets',()=>{
  const preview=[e('gametype','doubles'),e('player','p1','Opponent'),e('player','p2','Fixture'),e('teampreview','4')],canonical=ROOM.replace('-secretpw','');
  for(const [observed,started]of [[e('start'),true],[e('turn','1'),false],[e('move','p2a: Shell','Protect','p2a: Shell'),false],[e('-damage','p2a: Shell','100/182'),false],[{event:'request',room:ROOM,request:{active:[],side:{id:'p2',name:'Fixture',pokemon:[]}}},false],[{event:'request',room:ROOM,request:{forceSwitch:[true,false],side:{id:'p2',name:'Fixture',pokemon:[]}}},false],[{event:'request',room:ROOM,request:{wait:true,side:{id:'p2',name:'Fixture',pokemon:Array.from({length:4},()=>({active:false}))}}},false]]){
    const data=collectBattleEvents([...preview,observed,...preview,...preview,e('win','Fixture')]).get(canonical);
    assert.equal(data.startedObserved,started);assert.equal(data.progressObserved,true);
    assert.equal(data.events.some(value=>value.type==='start'||value.type==='turn'||value.type==='move'||value.type==='-damage'||value.type==='request'),false);
  }
  const clean=collectBattleEvents([...preview,{event:'request',room:ROOM,request:{teamPreview:true,side:{id:'p2',name:'Fixture',pokemon:Array.from({length:6},(_,index)=>({active:index<2}))}}},...preview,e('win','Fixture')]).get(canonical);
  assert.equal(clean.startedObserved,false);assert.equal(clean.progressObserved,false);
  const concession=collectBattleEvents([...preview,e('-message','Fixture forfeited the series.'),e('win','Opponent')]).get(canonical);
  assert.equal(concession.startedObserved,false);assert.equal(concession.progressObserved,false);
  const playedConcession=collectBattleEvents([...preview,e('-damage','p2a: Shell','100/182'),...preview,e('-message','Fixture forfeited the series.'),e('win','Opponent')]).get(canonical);
  assert.equal(playedConcession.progressObserved,true);
  const foreign=e('start');foreign.room=ROOM.replace('-123-','-124-');
  const isolated=collectBattleEvents([...preview,foreign,...preview,e('win','Fixture')]);
  assert.equal(isolated.get(canonical).progressObserved,false);assert.equal(isolated.get(foreign.room.replace('-secretpw','')).startedObserved,true);
});
async function setup(){const workspace=await mkdtemp(join(tmpdir(),'vgcm-import-'));await mkdir(join(workspace,'teams'));await mkdir(join(workspace,'cache'));await writeFile(join(workspace,'teams/team.txt'),TEAM);await writeFile(join(workspace,'cache/battles.jsonl'),jsonl(EVENTS));return workspace;}

test('concurrent snapshot publishers retain one validated immutable team file',async()=>{
  const workspace=await setup();try{
    const registered=await loadMetricsTeam({workspace,teamFile:'teams/team.txt'});
    const paths=await Promise.all(Array.from({length:8},()=>saveMetricsTeamSnapshot({workspace,...registered})));
    assert.equal(new Set(paths).size,1);
    assert.equal((await loadMetricsTeam({workspace,teamId:registered.teamId})).teamId,registered.teamId);
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('imports p2 private selections, reimports idempotently, remembers and refreshes local sources',async()=>{
  const workspace=await setup();
  try{
    const args={workspace,files:['cache/battles.jsonl'],username:'Fixture',teamFile:'teams/team.txt',remember:true};
    const imported=await importBattleFiles(args);assert.equal(imported.imported,1);
    let report=await getTeamReport({workspace,teamId:imported.teamId});assert.equal(report.totals.games,1);assert.equal(report.pokemon.find(p=>p.species==='Golisopod').moves.find(m=>m.move==='Protect').uses,1);
    assert.equal(report.pokemon.find(p=>p.species==='Kommo-o').observedGames,0);
    assert.equal(report.selection.gamesWithSelection,1);assert.equal(report.pokemon.find(p=>p.species==='Politoed').selectedGames,1);
    await importBattleFiles(args);assert.equal((await getTeamReport({workspace})).totals.games,1);
    const second=EVENTS.map(v=>({...v,room:ROOM.replace('-123-','-124-')}));await writeFile(join(workspace,'cache/battles.jsonl'),jsonl([...EVENTS,...second]));
    assert.equal((await refreshMetricsSources({workspace})).refreshed,1);
    report=await getTeamReport({workspace});assert.equal(report.totals.games,2);
    const records=await listBattles({workspace});assert(!JSON.stringify(records).includes('secretpw'));assert(!JSON.stringify(records).includes('request'));
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('ledger assigns official sets and excludes known operational games without calling actions choices',async()=>{
  const workspace=await setup();
  try{
    const missing='battle-gen9championsvgc2026regmcbo3-124';
    await writeFile(join(workspace,'cache/ledger.json'),JSON.stringify({sets:[{completedPlayedIndex:1,parentId:'game-bestof3-gen9championsvgc2026regmcbo3-122-secretpw',parentResult:{ownResult:'win'},children:[{id:ROOM,selection:{lead:['Golisopod','Farigiraf'],reserves:['Politoed','Sylveon'],mcpTeamChoice:'team 1546'},operationalErrors:[{kind:'server-default-turn'}],finishAttribution:'played-out'},{id:missing+'-privatepw'}]}]}));
    await importBattleFiles({workspace,files:['cache/battles.jsonl'],username:'Fixture',teamFile:'teams/team.txt',ledgerFile:'cache/ledger.json'});
    assert.equal((await getTeamReport({workspace})).totals.games,0);
    const all=await getTeamReport({workspace,includeOperational:true});assert.equal(all.totals.games,1);assert.equal(all.totals.sets.wins,1);
    assert.deepEqual((await listBattles({workspace}))[0].metadata.setResult.expectedChildIds,[ROOM.replace('-secretpw',''),missing]);
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('replayed complete server history is counted once and incomplete rereads cannot erase it',async()=>{
  const workspace=await setup();
  try{
    await writeFile(join(workspace,'cache/battles.jsonl'),jsonl([...EVENTS,...EVENTS]));
    await importBattleFiles({workspace,files:['cache/battles.jsonl'],username:'Fixture',teamFile:'teams/team.txt'});
    let report=await getTeamReport({workspace});assert.equal(report.pokemon.find(p=>p.species==='Golisopod').moves.find(m=>m.move==='Protect').uses,1);
    await writeFile(join(workspace,'cache/battles.jsonl'),jsonl(EVENTS.slice(0,6)));
    await importBattleFiles({workspace,files:['cache/battles.jsonl'],username:'Fixture',teamFile:'teams/team.txt'});
    report=await getTeamReport({workspace});assert.equal(report.totals.games,1);
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('reads local replay JSON and rejects outside paths and unsafe input without leaking contents',async()=>{
  const workspace=await setup(),outside=join(tmpdir(),'vgcm-outside-'+Date.now()+'.txt');
  try{
    const log=EVENTS.filter(v=>v.event==='battle-event').map(v=>'|'+v.type+'|'+v.data.join('|')).join('\n');
    await writeFile(join(workspace,'cache/replay.json'),JSON.stringify({id:ROOM.replace(/^battle-/,''),log}));
    const imported=await importBattleFiles({workspace,files:['cache/replay.json'],username:'Fixture',teamFile:'teams/team.txt'});assert.equal(imported.imported,1);
    await writeFile(outside,'private-data-do-not-print');await assert.rejects(readWorkspaceFile(workspace,outside),/within the workspace/);
    await writeFile(join(workspace,'cache/bad.jsonl'),'not-json-private-data');await assert.rejects(importBattleFiles({workspace,files:['cache/bad.jsonl'],username:'Fixture',teamFile:'teams/team.txt'}),/Invalid metrics JSONL at line 1/);
    assert.equal((await readFile(join(workspace,'cache/bad.jsonl'),'utf8')),'not-json-private-data');
  }finally{await rm(workspace,{recursive:true,force:true});await rm(outside,{force:true});}
});

test('remembered imports pin the exact training version when a team file changes',async()=>{
  const workspace=await setup();
  try{
    const first=await importBattleFiles({workspace,files:['cache/battles.jsonl'],username:'Fixture',teamFile:'teams/team.txt',remember:true});
    await writeFile(join(workspace,'teams/team.txt'),TEAM.replace('32 HP / 32 SpA / 2 SpD','31 HP / 32 SpA / 3 SpD'));
    const refresh=await refreshMetricsSources({workspace});assert.equal(refresh.refreshed,0);assert.equal(refresh.warnings.length,1);
    const records=await listBattles({workspace});assert.equal(records.length,1);assert.equal(records[0].teamId,first.teamId);
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('raw replay showteam evidence prevents importing a different registered team',async()=>{
  const workspace=await setup();
  try{
    const log=EVENTS.filter(v=>v.event==='battle-event').map(v=>'|'+v.type+'|'+v.data.join('|')).join('\n')+'\n|showteam|p2|Pikachu||||protect';
    await writeFile(join(workspace,'cache/replay.json'),JSON.stringify({id:ROOM.replace(/^battle-/,''),log}));
    const result=await importBattleFiles({workspace,files:['cache/replay.json'],username:'Fixture',teamFile:'teams/team.txt'});
    assert.equal(result.imported,0);assert.equal(result.skipped[0].reason,'Observed team sheet differs from supplied team version');
  }finally{await rm(workspace,{recursive:true,force:true});}
});
