import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {loadRestoredSetProof} from './restored-set.mjs';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';
import {parseSessionArgs} from './session.mjs';
import {analyzeBattle} from '../metrics/parser.mjs';
import {saveBattle,listBattles} from '../metrics/store.mjs';
import {saveMetricsTeamSnapshot} from '../metrics/import.mjs';
import {saveGameEvidence,readGameEvidence} from '../metrics/retention.mjs';
import {attachMetricsRecorder} from '../metrics/recorder.mjs';
import {attachVerifiedReplay} from '../metrics/replay-evidence.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const TEAM=[
  {species:'Golisopod',item:'Golisopite',ability:'Emergency Exit',moves:['Protect']},
  {species:'Politoed',item:'Leftovers',ability:'Drizzle',moves:['Weather Ball','Protect']},
  {species:'Farigiraf',item:'Grassy Seed',ability:'Armor Tail',moves:['Trick Room','Protect']},
  {species:'Blaziken',item:'Blazikenite',ability:'Speed Boost',moves:['Protect']},
  {species:'Archaludon',item:'Choice Scarf',ability:'Stamina',moves:['Flash Cannon']},
  {species:'Rillaboom',item:'Miracle Seed',ability:'Grassy Surge',moves:['Fake Out']},
].map(set=>({...set,level:50,nature:'Serious',evs:{hp:32,atk:32,spd:2}}));
const packed=Teams.pack(TEAM),teamId=createHash('sha256').update(packed).digest('hex');
const parent='game-bestof3-gen9championsvgc2026regmcbo3-101',child='battle-gen9championsvgc2026regmcbo3-102',child2='battle-gen9championsvgc2026regmcbo3-103';
const own='FixturePlayer',opponent='Fixture Opponent';
const protocol=[
  ['gametype','doubles'],['player','p1',own],['player','p2',opponent],['gen','9'],['tier','[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)'],
  ...TEAM.map(set=>['poke','p1',set.species+', L50','']),
  ['poke','p2','Garchomp, L50',''],['teampreview','4'],['start'],['switch','p1a: Politoed','Politoed, L50','100/100'],['switch','p2a: Garchomp','Garchomp, L50','100/100'],['turn','1'],['move','p1a: Politoed','Weather Ball','p2a: Garchomp'],['-damage','p2a: Garchomp','60/100'],
];
const request={rqid:2,teamPreview:true,side:{id:'p1',name:own,pokemon:TEAM.map(set=>({ident:'p1: '+set.species,details:set.species+', L50',condition:'100/100',active:false}))}};
const send=(client,room,rows)=>client.receive('>'+room+'\n'+rows.map(row=>'|'+row.join('|')).join('\n'));
const cleanupDirectory=async path=>{const target=resolve(path);assert.equal(dirname(target),resolve(tmpdir()));assert.match(basename(target),/^vgc-restored-[A-Za-z0-9]+$/u);await rm(target,{recursive:true,force:true});};

async function stored(){
  const workspace=await mkdtemp(join(tmpdir(),'vgc-restored-'));
  await saveMetricsTeamSnapshot({workspace,teamId,team:TEAM});
  const events=protocol.map(([type,...data],index)=>({event:'battle-event',type,data,room:child,at:1000+index}));
  events.splice(12,0,{event:'request',type:'request',request,room:child,at:1011});
  events.push({event:'decision',status:'selected',phase:'preview',turn:0,actions:[{type:'team',order:[2,1,3,5]}],room:child,at:1012});
  events.push({event:'control-trace',type:'selected',source:'operator',controllerId:'previous-owner',seq:1,generation:1,room:child,at:1012});
  const record=analyzeBattle({roomId:child,parentId:parent,username:own,teamId,team:TEAM,events:events.filter(value=>value.event==='battle-event'||value.event==='request').map(value=>value.event==='request'?{type:'request',request:value.request,at:value.at}:value)});
  record.metadata={sources:['live-client']};record.team={name:'Fixture',format:'gen9championsvgc2026regmc',roster:TEAM.map(set=>set.species)};
  await saveBattle({workspace,record});await saveGameEvidence({workspace,teamId,roomId:child,events,sheets:{p1:packed}});
  const proof=await loadRestoredSetProof({workspace,parentId:parent,teamId,username:own});
  return {workspace,proof,cleanup:()=>cleanupDirectory(workspace)};
}
async function fixture({replayPolicy=false,replayAttacher}={}){
  const f=await stored(),sent=[];let throwForfeit=false;
  const client=new ShowdownClient({expectedTeamHash:teamId});client.connected=true;client.authenticated=true;client.expectedUser='fixtureplayer';client.epoch=1;client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';
  client.ws={send:line=>{sent.push(line);if(throwForfeit&&line.endsWith('|/forfeit'))throw new Error('Synthetic uncertain I/O');},close:()=>{client.connected=false;}};
  const session=new AgentSession(client,{username:own,packed,authorizedSets:2,autoReady:false,restoredSetProof:f.proof,controllerRequired:false,replayPolicy});
  const recorder=attachMetricsRecorder(client,{workspace:f.workspace,username:own,teamId,team:TEAM,session,replayAttacher});session.attachMetricsRecorder(recorder);await recorder.flush();session.enableRestoredSetObservation();
  const establish=(active=true)=>{
    client.receive('|updatesearch|'+JSON.stringify({searching:[],games:active?{[parent]:'M-C BO3'}:{}}));
    send(client,parent,[['uhtml','game',`<a href="/${child}">Game 1</a><a href="/${child2}">Game 2</a>`]]);
    send(client,child,protocol);
    send(client,child2,protocol.slice(0,5));
  };
  return {...f,client,session,recorder,sent,establish,uncertain:()=>{throwForfeit=true;},cleanup:async()=>{session.dispose();await recorder.close();await f.cleanup();}};
}

test('recovery CLI requires one canonical parent and explicit manual readiness',()=>{
  const base=[own,'--team','fixture.txt'];
  assert.equal(parseSessionArgs([...base,'--manual-ready','--recover-set',parent]).recoverSet,parent);
  for(const args of [[...base,'--recover-set',parent],[...base,'--manual-ready','--recover-set',parent+'-abc123pw'],[...base,'--manual-ready','--recover-set',parent,'--recover-set',parent]])assert.throws(()=>parseSessionArgs(args));
});

test('proof admission rejects unknown parent, account or exact team mismatch and forged objects',async()=>{
  const f=await stored();try{
    for(const change of [{parentId:parent+'9'},{username:'AnotherPlayer'},{teamId:'b'.repeat(64)}])await assert.rejects(loadRestoredSetProof({workspace:f.workspace,parentId:parent,teamId,username:own,...change}));
    const client=new ShowdownClient({expectedTeamHash:teamId});
    assert.throws(()=>new AgentSession(client,{username:own,packed,restoredSetProof:{...f.proof}}),/Unverified/);
  }finally{await f.cleanup();}
});

test('restored parent has only forfeit/preservation authority and does not consume or create searches',async()=>{
  const f=await fixture();try{
    f.establish();
    send(f.client,parent,[['uhtml','ready',`<button value="/msgroom ${parent},/confirmready">Ready</button>`]]);
    send(f.client,child2,[['request',JSON.stringify(request)]]);
    assert.equal(f.session.ownedParents.has(parent),true);assert.equal(f.session.ownedRooms.has(child2),true);
    assert.deepEqual(f.session.actions(),[]);assert.equal(f.session.searchesSent,0);assert.equal(f.session.authorizedSets,2);
    assert.equal(f.sent.some(line=>line.includes('/search ')||line.includes('/confirmready')||line.includes('/choose ')),false);
    assert.equal((await f.session.execute({id:'cannot-timer',op:'set-timer',room:child2,confirmed:true})).ok,false);
    assert.equal((await f.session.execute({id:'cannot-start',op:'start',confirmed:true})).ok,false);
    assert.equal((await f.session.execute({id:'forfeit-once',op:'forfeit',room:parent,confirmed:true})).ok,true);
    assert.equal(f.sent.filter(line=>line.endsWith('|/forfeit')).length,1);
    assert.equal((await f.session.execute({id:'duplicate-forfeit',op:'forfeit',room:parent,confirmed:true})).ok,false);
  }finally{await f.cleanup();}
});

test('uncertain forfeit remains reserved and cannot be repeated with another command id',async()=>{
  const f=await fixture();try{
    f.establish();f.uncertain();
    assert.equal((await f.session.execute({id:'uncertain',op:'forfeit',room:parent,confirmed:true})).ok,false);
    assert.equal((await f.session.execute({id:'do-not-retry',op:'forfeit',room:parent,confirmed:true})).ok,false);
    assert.equal(f.sent.filter(line=>line.endsWith('|/forfeit')).length,1);
  }finally{await f.cleanup();}
});

test('a server-advertised privacy alias preserves the exact stored parent scope',async()=>{
  const f=await fixture({replayPolicy:true});try{
    const privateParent=parent+'-abcd1234pw',privateChild=child2+'-efgh5678pw';
    f.client.receive('|updatesearch|'+JSON.stringify({searching:[],games:{[privateParent]:'M-C BO3'}}));
    send(f.client,privateParent,[['uhtml','game',`<a href="/${privateChild}">Game 2</a>`]]);
    send(f.client,privateChild,protocol.slice(0,5));
    assert.equal(f.session.ownedParents.has(privateParent),true);assert.equal(f.session.ownedRooms.has(privateChild),true);assert.deepEqual(f.session.actions(),[]);
    assert.equal(f.session.ownedParents.has(parent),false);assert.equal(f.session.replayPreservation.has(parent),false);assert.equal(f.session.replayPreservation.get(privateParent).required,true);
    assert.equal((await f.session.execute({id:'alias-forfeit',op:'forfeit',room:privateParent,confirmed:true})).ok,true);
    assert.equal(f.sent.filter(line=>line.endsWith('|/forfeit')).length,1);
  }finally{await f.cleanup();}
});

test('changed authenticated account and wrong-format child are refused',async()=>{
  const f=await fixture();try{
    f.client.expectedUser='anotherplayer';assert.throws(()=>f.session.snapshot(),/Authenticated account differs/);
    f.client.expectedUser='fixtureplayer';
    send(f.client,parent,[['uhtml','game',`<a href="/${child2}">Game 2</a>`]]);
    send(f.client,child2,[['gametype','doubles'],['player','p1',own],['player','p2',opponent],['tier','[Gen 9] Doubles OU']]);
    f.session.snapshot();assert.equal(f.session.ownedRooms.has(child2),false);
  }finally{await f.cleanup();}
});

test('unrelated server parents and child participants grant no recovered authority',async()=>{
  const f=await fixture();try{
    const unrelated='game-bestof3-gen9championsvgc2026regmcbo3-999';
    f.client.receive('|updatesearch|'+JSON.stringify({searching:[],games:{[unrelated]:'Other BO3'}}));
    send(f.client,parent,[['uhtml','game',`<a href="/${child2}">Game 2</a>`]]);
    send(f.client,child2,[['gametype','doubles'],['player','p1','Other'],['player','p2','Unrelated'],['tier','[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)']]);
    f.session.snapshot();assert.equal(f.session.ownedParents.has(unrelated),false);assert.equal(f.session.ownedRooms.has(child2),false);
    assert.equal((await f.session.execute({id:'unrelated-forfeit',op:'forfeit',room:unrelated,confirmed:true})).ok,false);
    assert.equal((await f.session.execute({id:'not-live-forfeit',op:'forfeit',room:parent,confirmed:true})).ok,false);
    assert.equal(f.sent.some(line=>line.endsWith('|/forfeit')),false);
  }finally{await f.cleanup();}
});

test('ended-parent recovery retains private evidence, official child manifest and single-count moves',async()=>{
  const f=await fixture();try{
    f.establish(false);
    send(f.client,child,[['win',opponent]]);send(f.client,child2,[['win',own]]);send(f.client,parent,[['win',own]]);
    await f.recorder.flush({savePending:true});
    const rows=await listBattles({workspace:f.workspace,includeArchived:true}),old=rows.find(row=>row.roomId===child),newer=rows.find(row=>row.roomId===child2);
    assert.equal(old.pokemon.find(p=>p.species==='Politoed').moves.find(m=>m.move==='Weather Ball').uses,1);
    assert.equal(old.metadata.setResult.completed,true);assert.equal(old.metadata.setResult.outcome,'win');assert.deepEqual(old.metadata.setResult.expectedChildIds,[child,child2]);
    assert.equal(newer.metadata.setResult.completed,true);assert.equal(newer.quality.operational,true);
    const evidence=await readGameEvidence({workspace:f.workspace,teamId,roomId:child});
    assert.equal(evidence.decisions.some(value=>value.phase==='preview'&&value.selected===undefined&&value.actions?.[0]?.order?.join(',')==='2,1,3,5'),true);
    assert.equal(evidence.controlTrace.some(value=>value.controllerId==='previous-owner'),true);
    assert.equal(evidence.events.filter(value=>value.type==='move'&&value.data[1]==='Weather Ball').length,1);
    assert.equal(evidence.complete,true);assert.deepEqual(f.session.actions(),[]);assert.equal(f.session.searchesSent,0);assert.equal(f.session.authorizedSets,2);
    const repeated=await loadRestoredSetProof({workspace:f.workspace,parentId:parent,teamId,username:own});
    assert.deepEqual([...repeated.childIds].sort(),[child,child2]);
    assert.doesNotThrow(()=>f.session.assertRestoredSetSettled());
  }finally{await f.cleanup();}
});

for(const validReader of [true,false])test(`restored public-only preview replay ${validReader?'completes with the recorder current-session reader':'refuses a mismatched session without inventing private requests'}`,async()=>{
  let readerSeen=false,fetches=0;
  const preview=[...protocol.slice(0,5),...TEAM.map(set=>['poke','p1',set.species+', L50','']),...TEAM.map(set=>['poke','p2',set.species+', L50','']),['teampreview','4'],['win',own]];
  const replayLog=preview.map(line=>'|'+line.join('|')).join('\n');
  const f=await fixture({replayAttacher:async args=>{
    readerSeen=typeof args.sessionReader==='function';
    return attachVerifiedReplay({...args,...(!validReader?{sessionReader:async()=>({...await args.sessionReader(),authenticated:false})}:{}),fetchImpl:async()=>{fetches++;return new Response(JSON.stringify({id:child2.slice(7),formatid:'gen9championsvgc2026regmcbo3',log:replayLog}));}});
  }});
  try{
    f.establish(false);send(f.client,child,[['win',opponent]]);send(f.client,child2,preview.slice(5));send(f.client,parent,[['win',own]]);
    await f.recorder.flush({savePending:true});
    const before=await readGameEvidence({workspace:f.workspace,teamId,roomId:child2});assert.equal(before.complete,false);assert.equal(before.events.some(value=>value.type==='request'),false);
    f.client.emit('replay-verified',{roomId:child2,url:'https://replay.pokemonshowdown.com/'+child2.slice(7)});
    const result=await f.recorder.flush();assert.equal(readerSeen,true);
    const after=await readGameEvidence({workspace:f.workspace,teamId,roomId:child2});
    assert.equal(after.complete,validReader);assert.equal(after.events.some(value=>value.type==='request'),false);
    if(validReader){assert.equal(result.state,'ready');assert.equal(fetches,1);assert.equal(after.previewObservation.kind,'owned-parent-preview-terminal');}
    else{assert.equal(result.state,'error');assert.equal(fetches,0);assert.equal(after.previewObservation,null);}
  }finally{await f.cleanup();}
});
