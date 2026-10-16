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
import {attachVerifiedReplay,fetchRegisteredReplay,fetchVerifiedReplay} from './replay-evidence.mjs';
import {importReplayUrls} from './replays.mjs';

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
