import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {registerTeamFromText} from './import.mjs';
import {saveBattle,listBattles,updateBattleMetadata} from './store.mjs';
import {saveGameEvidence,readGameEvidence} from './retention.mjs';
import {attachVerifiedReplay,fetchRegisteredReplay,fetchVerifiedReplay,recoverPreviewFromHistoricalStatus} from './replay-evidence.mjs';
import {CAPTURE_ATTESTATION} from './preview-terminal.mjs';
import {importReplayUrls} from './replays.mjs';
import {verifySetReplayPreservation} from '../showdown/replay-preservation.mjs';

const ROOM='battle-gen9championsvgc2026regmcbo3-123',PARENT='game-bestof3-gen9championsvgc2026regmcbo3-122';
const URL='https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-123-privatepw';
const TEAM=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']].map(([species,ability])=>`${species}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
const events=()=>[
  {type:'gametype',data:['doubles']},{type:'tier',data:['[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)']},
  {type:'player',data:['p1','Fixture']},{type:'player',data:['p2','Opponent']},{type:'teampreview',data:['4']},
  {type:'request',request:{teamPreview:true,rqid:2,side:{id:'p1',name:'Fixture',pokemon:Array.from({length:6},(_,i)=>({ident:`p1: Mon${i}`,details:'Golisopod, L50',active:i<2,condition:'100/100'}))}}},
  {type:'win',data:['Opponent']},
];
const replayLog=()=>events().filter(e=>e.type!=='request').map(e=>`|${[e.type,...e.data].join('|')}`).join('\n');
const fetcher=log=>async()=>new Response(JSON.stringify({id:ROOM.slice(7),formatid:'gen9championsvgc2026regmcbo3',log:log??replayLog()}));
async function fixture(t){
  const workspace=await mkdtemp(join(tmpdir(),'vgc-preview-replay-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const registered=await registerTeamFromText({workspace,teamText:TEAM});const teamId=registered.teamId;
  await saveBattle({workspace,record:{schemaVersion:1,roomId:ROOM,parentId:PARENT,teamId,username:'Fixture',ownSide:'p1',players:{p1:'Fixture',p2:'Opponent'},completed:true,outcome:'loss',turns:0,opponentRoster:['Incineroar'],selected:[],selectionKnown:false,leads:[],pokemon:[],quality:{complete:false,operational:true,warnings:['Preview ended before selection; no played turns.']},team:registered.team,metadata:{setResult:{completed:true,outcome:'loss',expectedChildIds:[ROOM]}}}});
  return {workspace,teamId,roomId:ROOM,url:URL,fetchImpl:fetcher()};
}
const row=async args=>(await listBattles({workspace:args.workspace,includeArchived:true})).find(r=>r.teamId===args.teamId&&r.roomId===ROOM);
function snapshot(teamId){return {sessionId:'fixture-session',username:'Fixture',connected:true,authenticated:true,rooms:[{id:ROOM+'-watchpw',teamId,ended:true,result:{type:'win',winner:'Opponent'},state:{ended:true,result:{type:'win',winner:'Opponent'},turn:0,lastMove:null,gameType:'doubles',tier:'[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)',ownSide:'p1',request:{teamPreview:true,forceSwitch:null},sides:[{id:'p1',name:'Fixture',active:[{slot:'a'},{slot:'b'}],pokemon:Array.from({length:6},()=>({selection:'unknown',previousAppearances:[]}))},{id:'p2',name:'Opponent',active:[],pokemon:[]}]}}]};}
async function legacy(args){
  const file=`cache/team-metrics/evidence/${ROOM}--${args.teamId}.events.json.gz`;
  const doc={schemaVersion:1,kind:'sanitized-events',teamId:args.teamId,roomId:ROOM,parentId:PARENT,complete:false,events:events(),sheets:{},decisions:[],decisionEvidenceIncluded:false};
  const bytes=Buffer.from(JSON.stringify(doc)+'\n');await mkdir(join(args.workspace,'cache/team-metrics/evidence'),{recursive:true});await writeFile(join(args.workspace,file),gzipSync(bytes));
  await updateBattleMetadata({...args,metadata:{evidence:{path:file,kind:'sanitized-events',version:1,sha256:createHash('sha256').update(bytes).digest('hex'),complete:false}}});
}

test('new canonical preview terminals attach exact saved replays without inventing selected four or a played game',async t=>{
  const args=await fixture(t),concession=events();concession.splice(-1,0,{type:'-message',data:['Fixture forfeited the series.']});
  await saveGameEvidence({...args,events:concession});const before=await row(args);
  const proof=await fetchRegisteredReplay(args);assert.equal(proof.completionKind,'preview-terminal');
  await assert.rejects(fetchVerifiedReplay({...args,username:'Fixture',ownSide:'p1',outcome:'loss',previewProof:true}),/could not be verified/);
  const saved=await attachVerifiedReplay(args),after=await row(args);
  assert.equal(saved.replay.url,URL);assert.deepEqual(after.selected,[]);assert.equal(after.selectionKnown,false);assert.deepEqual(after.quality,before.quality);assert.equal(after.turns,0);
  const evidence=await readGameEvidence(args);assert.equal(evidence.complete,true);assert.equal(evidence.completionKind,'preview-terminal');assert.deepEqual(evidence.observedHistory,{started:false,progress:false});
  assert.equal((await attachVerifiedReplay(args)).status,'unchanged');
});

test('legacy partial preview requires independent owned live reducer corroboration and upgrades only after replay agreement',async t=>{
  const args=await fixture(t);await legacy(args);const before=await row(args);
  await assert.rejects(fetchRegisteredReplay(args),/could not be verified/);
  for(const mutate of [s=>{s.rooms[0].teamId='a'.repeat(64);},s=>{s.rooms[0].state.turn=1;},s=>{s.rooms[0].state.lastMove={move:'Protect'};},s=>{s.rooms[0].state.sides[1].pokemon=[{}];},s=>{s.rooms[0].result.winner='Fixture';}]){
    const state=snapshot(args.teamId);mutate(state);await assert.rejects(fetchRegisteredReplay({...args,sessionReader:async()=>state}),/could not be verified/);
  }
  const sessionReader=async()=>snapshot(args.teamId);
  for(const log of [replayLog().replace('Opponent','Other'),replayLog().replace('|win|Opponent','|win|Fixture'),replayLog().replace('|teampreview|4',''),replayLog()+'\n|turn|1',replayLog()+'\n|-damage|p1a: A|50/100',replayLog()+'\n|start'])await assert.rejects(attachVerifiedReplay({...args,sessionReader,fetchImpl:fetcher(log)}),/could not be verified/);
  assert.equal((await row(args)).metadata.evidence.sha256,before.metadata.evidence.sha256);
  await attachVerifiedReplay({...args,sessionReader});const after=await readGameEvidence(args);assert.equal(after.complete,true);assert.deepEqual(after.observedHistory,{started:null,progress:null});assert.equal(after.previewCorroboration.earlierStartObservation,'unavailable');assert.match(after.completionLimitation,/earlier-start observation remains unavailable/);
  await fetchRegisteredReplay(args); // durable upgrade no longer depends on the live session
});

test('replay import verifies legacy preview once and preserves private row facts without redundant replay cache',async t=>{
  const args=await fixture(t);await legacy(args);const before=await row(args);let reads=0,fetches=0;
  const imported=await importReplayUrls({workspace:args.workspace,teamId:args.teamId,username:'Fixture',urls:[URL],fetchImpl:async(...a)=>{fetches++;return fetcher()(...a);},sessionReader:async()=>{reads++;return snapshot(args.teamId);}});
  assert.equal(imported.imported,1);assert.equal(imported.replays.length,1);assert.equal(fetches,1);assert.equal(reads,1);
  const after=await row(args);for(const key of ['players','selected','selectionKnown','leads','pokemon','quality','turns','outcome'])assert.deepEqual(after[key],before[key],key);
  assert.deepEqual(await readdir(join(args.workspace,'cache/team-metrics/replays')),[]);
  assert.equal((await readGameEvidence(args)).complete,true);
});

test('URL-only preview endings and partial canonical history that ever reached gameplay remain rejected',async t=>{
  const args=await fixture(t);
  await assert.rejects(importReplayUrls({workspace:args.workspace,teamId:args.teamId,username:'Fixture',urls:[URL],fetchImpl:fetcher()}),/could not be fetched or validated/);
  const prefix=events().slice(0,-1),started=[...prefix,{type:'start',data:[]}];
  await assert.rejects(saveGameEvidence({...args,events:[...started,...events()]}),/earlier observed battle progress/);
  await saveGameEvidence({...args,events:started});
  await saveGameEvidence({...args,events:prefix});
  assert.deepEqual((await readGameEvidence(args)).observedHistory,{started:true,progress:true});
  await assert.rejects(saveGameEvidence({...args,events:events()}),/earlier observed battle progress/);
  await assert.rejects(fetchRegisteredReplay({...args,sessionReader:async()=>snapshot(args.teamId)}),/could not be verified/);
});

test('missing recorder archive recovers only actual replay protocol plus a separate owned preview observation',async t=>{
  const args=await fixture(t),before=await row(args);let reads=0,fetches=0;
  const state=snapshot(args.teamId);state.rooms[0].state.request.rqid=2;
  state.rooms[0].choice={rqid:2,status:'sent',sentAt:1234,acceptedAt:null,actions:[{type:'team',order:[6,5,4,2]}],evidence:[]};
  const imported=await importReplayUrls({workspace:args.workspace,teamId:args.teamId,username:'Fixture',urls:[URL],fetchImpl:async(...a)=>{fetches++;return fetcher(replayLog().replace('|win|Opponent','|-message|Fixture forfeited the series.\n|win|Opponent'))(...a);},sessionReader:async()=>{reads++;return state;}});
  assert.equal(imported.imported,1);assert.equal(fetches,1);assert.equal(reads,1);
  const evidence=await readGameEvidence(args);
  assert.equal(evidence.complete,true);assert.equal(evidence.completionKind,'preview-terminal');
  assert.equal(evidence.events.some(event=>event.type==='request'),false);
  assert.equal(evidence.previewObservation.kind,'owned-session-preview-state');
  assert.equal(evidence.previewObservation.rooms[0].id,ROOM);
  assert.deepEqual(evidence.observedHistory,{started:null,progress:null});
  assert.match(evidence.completionLimitation,/no protocol request was reconstructed/);
  assert.deepEqual(evidence.decisions.map(value=>value.status),['sent']);
  assert.deepEqual(evidence.decisions[0].actions[0].order,[6,5,4,2]);
  assert.equal(evidence.decisions[0].accepted,undefined);assert.equal(evidence.decisions[0].executed,undefined);assert.equal(evidence.decisions[0].serverDefaulted,undefined);
  const after=await row(args);for(const key of ['players','selected','selectionKnown','leads','pokemon','quality','turns','outcome'])assert.deepEqual(after[key],before[key],key);
  assert.equal((await fetchRegisteredReplay(args)).completionKind,'preview-terminal');
  assert.equal((await attachVerifiedReplay(args)).status,'unchanged');
});

test('missing recorder archive cannot use unrelated or progressed live state, and writes nothing before replay agreement',async t=>{
  const args=await fixture(t),before=await row(args);
  for(const mutate of [s=>{s.connected=false;},s=>{s.authenticated=false;},s=>{s.rooms[0].teamId='a'.repeat(64);},s=>{s.rooms[0].state.turn=1;},s=>{s.rooms[0].state.lastMove={move:'Protect'};},s=>{s.rooms[0].state.sides[0].pokemon[0].previousAppearances=[{}];},s=>{s.rooms[0].state.sides[1].pokemon=[{}];},s=>{s.rooms[0].result.winner='Fixture';},s=>{s.rooms[0].state.request.teamPreview=false;},s=>{s.rooms=[];}]){
    const state=snapshot(args.teamId);mutate(state);
    await assert.rejects(attachVerifiedReplay({...args,sessionReader:async()=>state}),/could not be verified/);
  }
  for(const log of [replayLog().replace('Opponent','Other'),replayLog().replace('|win|Opponent','|win|Fixture'),replayLog().replace('|teampreview|4',''),replayLog().replace('|win|Opponent','|start\n|win|Opponent'),replayLog().replace('|win|Opponent','|move|p1a: A|Protect|p1a: A\n|win|Opponent'),replayLog().replace('|win|Opponent','|-damage|p1a: A|50/100\n|win|Opponent')]){
    await assert.rejects(attachVerifiedReplay({...args,fetchImpl:fetcher(log),sessionReader:async()=>snapshot(args.teamId)}),/could not be verified/);
  }
  assert.equal((await row(args)).metadata.evidence,before.metadata.evidence);
  assert.equal((await row(args)).metadata.replay,undefined);
});

const OTHER='battle-gen9championsvgc2026regmcbo3-124';
function rejoinedSnapshot(teamId) {
  const result={type:'win',winner:'Opponent'},state={ended:true,result};
  return {sessionId:'rejoined-fixture',revision:7,username:'Fixture',connected:true,authenticated:true,stopped:false,teamSha256:teamId,rooms:[
    {id:PARENT,teamId,ended:true,result,children:[OTHER,ROOM],state},
    {id:OTHER,teamId,ended:true,result,state},
    {id:ROOM,teamId,ended:true,result,state:{...state,turn:0,lastMove:null,gameType:'doubles',tier:'[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)',ownSide:null,request:null,
      sides:['p1','p2'].map(id=>({id,name:id==='p1'?'Fixture':null,active:[],reserves:[],pokemon:[],preview:Array.from({length:6},()=>({species:'Fixture species'}))}))}},
  ]};
}
async function rejoinedFixture(t) {
  const args=await fixture(t),setResult={completed:true,outcome:'loss',expectedChildIds:[OTHER,ROOM]};
  await updateBattleMetadata({...args,metadata:{setResult}});
  const existing=await row(args);
  await saveBattle({workspace:args.workspace,record:{...existing,roomId:OTHER,turns:1,metadata:{setResult}}});
  const first=events().filter(event=>!['request','win'].includes(event.type));
  first.push({type:'start',data:[]},{type:'turn',data:['1']},{type:'win',data:['Opponent']});
  await saveGameEvidence({...args,roomId:OTHER,events:first});
  await attachVerifiedReplay({...args,roomId:OTHER,url:URL.replace('-123-','-124-'),fetchImpl:async()=>new Response(JSON.stringify({id:OTHER.slice(7),log:first.map(event=>`|${[event.type,...event.data].join('|')}`).join('\n')}))});
  await saveGameEvidence({...args,events:events().filter(event=>event.type!=='request')});
  assert.equal((await readGameEvidence(args)).complete,false);
  return args;
}

test('crash-rejoined preview loss uses owned parent plus canonical and server evidence without recovering a request or selection',async t=>{
  const args=await rejoinedFixture(t),before=await row(args),original=await readGameEvidence(args);let reads=0,fetches=0;
  const imported=await importReplayUrls({workspace:args.workspace,teamId:args.teamId,username:'Fixture',urls:[URL],fetchImpl:async(...values)=>{fetches++;return fetcher()(...values);},sessionReader:async()=>{reads++;return rejoinedSnapshot(args.teamId);}});
  assert.equal(imported.imported,1);assert.equal(reads,1);assert.equal(fetches,1);
  const evidence=await readGameEvidence(args),after=await row(args);
  assert.equal(evidence.complete,true);assert.equal(evidence.completionKind,'preview-terminal');
  assert.deepEqual(evidence.events,original.events);assert.equal(evidence.events.some(event=>event.type==='request'),false);
  assert.equal(evidence.previewObservation.kind,'owned-parent-preview-terminal');
  assert.equal(evidence.previewObservation.canonicalHistory.sha256,before.metadata.evidence.sha256);
  assert.equal(evidence.previewObservation.replayLogSha256,after.metadata.replay.logSha256);
  assert.deepEqual(evidence.observedHistory,{started:false,progress:false});
  assert.match(evidence.completionLimitation,/private preview request was lost on reconnect/);
  assert.match(evidence.completionLimitation,/No request or selection was reconstructed/);
  for(const key of ['players','selected','selectionKnown','leads','pokemon','quality','turns','outcome'])assert.deepEqual(after[key],before[key],key);
  const preservation=()=>verifySetReplayPreservation({workspace:args.workspace,teamId:args.teamId,parentId:PARENT,roomIds:[OTHER,ROOM],officialOutcome:'loss'});
  assert.equal((await preservation()).complete,true);
  assert.equal((await fetchRegisteredReplay(args)).completionKind,'preview-terminal');
  assert.equal((await attachVerifiedReplay(args)).status,'unchanged');
  const completedBytes=await readFile(join(args.workspace,after.metadata.evidence.path));
  const changedObservation={...evidence.previewObservation,sessionId:'different-fixture-session'};
  await assert.rejects(saveGameEvidence({...args,events:evidence.events,previewObservation:changedObservation}),/completed evidence differs/);
  await saveGameEvidence({...args,events:original.events});
  assert.deepEqual(await readFile(join(args.workspace,after.metadata.evidence.path)),completedBytes);
  await writeFile(join(args.workspace,after.metadata.replay.evidencePath),gzipSync('changed server replay'));
  await assert.rejects(readGameEvidence(args),/replay hash verification/);
  assert.equal((await preservation()).complete,false);
});

test('rejoined recovery rejects missing ownership, mismatched manifests, team, account, results and progressed state before writes',async t=>{
  const args=await rejoinedFixture(t),before=await row(args),bytes=await readFile(join(args.workspace,before.metadata.evidence.path));
  await assert.rejects(attachVerifiedReplay(args),/could not be verified/);
  const mutations=[
    s=>{s.connected=false;},s=>{s.authenticated=false;},s=>{s.stopped=true;},s=>{s.sessionId='';},s=>{s.username='Other owner';},
    s=>{delete s.teamSha256;},s=>{s.teamSha256='a'.repeat(64);},s=>{s.rooms[0].teamId='a'.repeat(64);},s=>{s.rooms[2].teamId='a'.repeat(64);},
    s=>{s.rooms.shift();},s=>{s.rooms.pop();},s=>{s.rooms[0].id=PARENT+'9';},s=>{s.rooms[0].children=[ROOM];},
    s=>{s.rooms[0].children=[ROOM,ROOM];},s=>{s.rooms[0].children=[OTHER,ROOM+'9'];},s=>{s.rooms[1].ended=false;},
    s=>{s.rooms[0].result={type:'win',winner:'Fixture'};},s=>{s.rooms[2].result={type:'win',winner:'Fixture'};},s=>{s.rooms[2].state.result={type:'win',winner:'Fixture'};},
    s=>{s.rooms[2].state.turn=1;},s=>{s.rooms[2].state.lastMove={move:'Protect'};},s=>{s.rooms[2].state.sides[0].pokemon=[{}];},
    s=>{s.rooms[2].state.sides[0].active=[{}];},s=>{s.rooms[2].state.sides[1].name='Other opponent';},s=>{s.rooms[2].state.tier='[Gen 9] OU';},
  ];
  for(const mutate of mutations){const state=structuredClone(rejoinedSnapshot(args.teamId));mutate(state);await assert.rejects(attachVerifiedReplay({...args,sessionReader:async()=>state}),/could not be verified/);}
  const reader=async()=>rejoinedSnapshot(args.teamId);
  for(const log of [replayLog().replace('Opponent','Other'),replayLog().replace('|win|Opponent','|win|Fixture'),replayLog().replace('|gametype|doubles','|gametype|singles'),replayLog().replace('|tier|[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)','|tier|[Gen 9] OU'),replayLog().replace('|teampreview|4',''),replayLog()+'\n|start',replayLog()+'\n|turn|1',replayLog()+'\n|move|p1a: A|Protect|p1a: A',replayLog()+'\n|-damage|p1a: A|50/100'])await assert.rejects(attachVerifiedReplay({...args,sessionReader:reader,fetchImpl:fetcher(log)}),/could not be verified/);
  assert.deepEqual(await readFile(join(args.workspace,before.metadata.evidence.path)),bytes);
  assert.deepEqual((await row(args)).metadata,before.metadata);
});

test('rejoined recovery rejects earlier progress even when a later zero-turn server history replaced it',async t=>{
  const args=await rejoinedFixture(t),prefix=events().filter(event=>!['request','win'].includes(event.type));
  await saveGameEvidence({...args,events:[...prefix,{type:'start',data:[]},{type:'turn',data:['1']}]});
  await saveGameEvidence({...args,events:events().filter(event=>event.type!=='request')});
  assert.deepEqual((await readGameEvidence(args)).observedHistory,{started:true,progress:true});
  await assert.rejects(attachVerifiedReplay({...args,sessionReader:async()=>rejoinedSnapshot(args.teamId)}),/could not be verified/);
  assert.equal((await row(args)).metadata.replay,undefined);
});

const attestation=()=>({statement:CAPTURE_ATTESTATION,operator:'Synthetic fixture operator',capturedAt:'2026-01-01T00:00:00.000Z',provenance:'Synthetic owned MCP status response captured in fixture command capture-1.',reason:'The ended parent expired after the client was reloaded; preserve the historical observations truthfully.'});
async function historicalFixture(t,{envelope=false}={}){
  const args=await rejoinedFixture(t),status=rejoinedSnapshot(args.teamId),value=envelope?{id:'capture-1',ok:true,result:status}:status;
  const bytes=Buffer.from('\uFEFF'+JSON.stringify(value,null,2).replaceAll('\n','\r\n'));
  const statusFile='cache/fixture-owned-status.json';await writeFile(join(args.workspace,statusFile),bytes);
  return {...args,statusFile,statusSha256:createHash('sha256').update(bytes).digest('hex'),confirmed:true,captureAttestation:attestation(),captureBytes:bytes};
}

test('explicit historical recovery preserves direct/enveloped original bytes and labels operator provenance without a current reader',async t=>{
  for(const envelope of [false,true]){
    const args=await historicalFixture(t,{envelope}),before=await row(args),original=await readGameEvidence(args);
    const saved=await recoverPreviewFromHistoricalStatus(args),evidence=await readGameEvidence(args),after=await row(args);
    assert.equal(saved.complete,true);assert.equal(saved.provenance.source,'historical_mcp_battle_status');
    assert.equal(saved.provenance.sessionId,'rejoined-fixture');assert.equal(saved.provenance.revision,7);
    assert.equal(saved.provenance.capturedAt,args.captureAttestation.capturedAt);assert.notEqual(saved.provenance.adoptedAt,saved.provenance.capturedAt);
    assert.match(saved.provenance.originLimitation,/operator, not independently or cryptographically verified/);
    assert.match(saved.completionLimitation,/not current IPC ownership/);
    assert.equal(evidence.previewObservation.observedAt,undefined);assert.equal(evidence.previewObservation.source,'historical_mcp_battle_status');
    assert.deepEqual(gunzipSync(await readFile(join(args.workspace,saved.snapshotEvidence.path))),args.captureBytes);
    assert.deepEqual(await readFile(join(args.workspace,args.statusFile)),args.captureBytes);
    assert.equal(saved.snapshotEvidence.envelope,envelope?'ipc-response':'raw-status');
    assert.deepEqual(evidence.events,original.events);assert.deepEqual(evidence.decisions,[]);
    assert.equal(evidence.events.some(event=>event.type==='request'),false);
    for(const key of ['players','selected','selectionKnown','leads','pokemon','quality','turns','outcome','parentId','username'])assert.deepEqual(after[key],before[key],key);
    assert.equal((await recoverPreviewFromHistoricalStatus(args)).status,'unchanged');
    const completedBytes=await readFile(join(args.workspace,after.metadata.evidence.path));
    await assert.rejects(recoverPreviewFromHistoricalStatus({...args,captureAttestation:{...args.captureAttestation,reason:'A different reason cannot rewrite an already completed evidence record.'}}),/Completed evidence cannot be replaced/);
    await saveGameEvidence({...args,events:original.events});
    assert.deepEqual(await readFile(join(args.workspace,after.metadata.evidence.path)),completedBytes);
    await rm(join(args.workspace,args.statusFile));
    assert.equal((await readGameEvidence(args)).complete,true);
    assert.equal((await fetchRegisteredReplay(args)).completionKind,'preview-terminal');
    assert.equal((await verifySetReplayPreservation({workspace:args.workspace,teamId:args.teamId,parentId:PARENT,roomIds:[OTHER,ROOM],officialOutcome:'loss'})).complete,true);
    await writeFile(join(args.workspace,saved.snapshotEvidence.path),gzipSync(Buffer.concat([args.captureBytes,Buffer.from(' ')])));
    await assert.rejects(readGameEvidence(args),/Historical status capture could not be verified/);
    assert.equal((await verifySetReplayPreservation({workspace:args.workspace,teamId:args.teamId,parentId:PARENT,roomIds:[OTHER,ROOM],officialOutcome:'loss'})).complete,false);
  }
});

test('historical recovery rejects hash/path/attestation/ownership and server replay conflicts before evidence writes',async t=>{
  const args=await historicalFixture(t),before=await row(args),originalBytes=await readFile(join(args.workspace,before.metadata.evidence.path));
  for(const patch of [{confirmed:false},{captureAttestation:undefined},{captureAttestation:{...attestation(),statement:'Verified by a hash'}},{captureAttestation:{...attestation(),independentlyVerified:true}},{captureAttestation:{...attestation(),capturedAt:'2999-01-01T00:00:00.000Z'}},{statusSha256:'a'.repeat(64)},{statusFile:'cache/showdown-session-status.json'},{statusFile:'../fixture-owned-status.json'}])await assert.rejects(recoverPreviewFromHistoricalStatus({...args,...patch}));
  const mutations=[s=>{s.connected=false;},s=>{s.username='Other owner';},s=>{s.teamSha256='a'.repeat(64);},s=>{s.revision=-1;},s=>{s.rooms[0].teamId='a'.repeat(64);},s=>{s.rooms[2].teamId='a'.repeat(64);},s=>{s.rooms.shift();},s=>{s.rooms[0].children=[ROOM];},s=>{s.rooms[0].children=[ROOM,ROOM];},s=>{s.rooms[0].result={type:'win',winner:'Fixture'};},s=>{s.rooms[2].state.turn=1;},s=>{s.rooms[2].state.lastMove={move:'Protect'};},s=>{s.rooms[2].state.sides[0].active=[{}];},s=>{s.rooms[2].state.sides[1].name='Another opponent';}];
  for(const mutate of mutations){const status=structuredClone(rejoinedSnapshot(args.teamId));mutate(status);const bytes=Buffer.from(JSON.stringify(status));await writeFile(join(args.workspace,args.statusFile),bytes);await assert.rejects(recoverPreviewFromHistoricalStatus({...args,statusSha256:createHash('sha256').update(bytes).digest('hex')}));}
  await writeFile(join(args.workspace,args.statusFile),args.captureBytes);
  for(const log of [replayLog().replace('Opponent','Other'),replayLog().replace('|win|Opponent','|win|Fixture'),replayLog().replace('|tier|[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)','|tier|[Gen 9] OU'),replayLog().replace('|teampreview|4',''),replayLog()+'\n|start',replayLog()+'\n|turn|1',replayLog()+'\n|move|p1a: A|Protect|p1a: A',replayLog()+'\n|-damage|p1a: A|50/100'])await assert.rejects(recoverPreviewFromHistoricalStatus({...args,fetchImpl:fetcher(log)}),/could not be verified/);
  assert.deepEqual(await readFile(join(args.workspace,before.metadata.evidence.path)),originalBytes);
  assert.deepEqual((await row(args)).metadata,before.metadata);
  assert.equal((await readdir(join(args.workspace,'cache/team-metrics/evidence'))).some(name=>name.endsWith('.owned-status.json.gz')),false);
});

test('historical recovery cannot erase earlier progress, use a corrupt canonical archive or create another game',async t=>{
  const args=await historicalFixture(t),before=await row(args);
  await assert.rejects(recoverPreviewFromHistoricalStatus({...args,roomId:ROOM+'9',url:URL.replace('-123-','-1239-')}),/existing registered terminal/);
  const prefix=events().filter(event=>!['request','win'].includes(event.type));
  await saveGameEvidence({...args,events:[...prefix,{type:'start',data:[]},{type:'turn',data:['1']}]});
  await saveGameEvidence({...args,events:events().filter(event=>event.type!=='request')});
  await assert.rejects(recoverPreviewFromHistoricalStatus(args),/does not corroborate/);
  assert.equal((await row(args)).metadata.replay,undefined);
  const path=join(args.workspace,before.metadata.evidence.path);await writeFile(path,gzipSync('corrupt canonical history'));
  await assert.rejects(recoverPreviewFromHistoricalStatus(args),/evidence hash verification/);
});
