import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';

const room='battle-gen9championsvgc2026regmcbo3-7', parent='game-bestof3-gen9championsvgc2026regmcbo3-7';
function fixture({autoReady=true,authorizedSets=1,packed='Species|item|ability|move',...replayOptions}={}) {
  let time=1000;const sent=[];
  const client=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex'),now:()=>time});
  client.connected=true;client.authenticated=true;client.epoch=1;
  client.ws={send:text=>sent.push(text),close:()=>{client.connected=false;client.authenticated=false;client.emit('disconnected');}};
  client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';
  const session=new AgentSession(client,{username:'FixturePlayer',packed,authorizedSets,autoReady,now:()=>time,controllerRequired:false,...replayOptions});
  const request=(extra={})=>client.receive(`>${room}\n|request|${JSON.stringify({rqid:1,active:[{moves:[{move:'Protect',pp:10,target:'self'}]},{moves:[{move:'Protect',pp:10,target:'self'}]}],side:{id:'p2',name:'FixturePlayer',pokemon:[{ident:'p2: A',details:'Politoed, L50',active:true,condition:'100/100'},{ident:'p2: B',details:'Kommo-o, L50',active:true,condition:'100/100'}]},...extra})}`);
  return {client,session,sent,request,tick:value=>{time=value;},start:async()=>{
    const result=await session.execute({id:'start',op:'start',confirmed:true});
    client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'FixturePlayer vs Opponent'}})}`);
    client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);return result;
  }};
}

function previewRequest(f,rqid=1){f.request({rqid,teamPreview:true,maxChosenTeamSize:4,active:undefined,side:{id:'p2',name:'FixturePlayer',pokemon:Array.from({length:6},(_,i)=>({ident:`p2: Preview ${i+1}`,details:'Politoed, L50',condition:'100/100',active:false}))}});}
const previewIntent=()=>({objective:'Use the explicitly selected opening.',risk:'If control is contested retain independent progress.',preserveIds:['selected-reserve'],nextTurnCondition:'Convert into the reserve first useful action.',unverified:['Opposing selected four.']});

// Actual A8 chronology/error and retained side conditions; the discarded raw
// active menus are declared fixtures, not claimed byte-exact historical packets.
async function rejectedClockFixture(){
  const f=fixture({autoReady:false});f.client.receive('|updatesearch|{"searching":[],"games":null}');
  const policy=await f.session.execute({id:'clock-lineage-policy',op:'set-control-policy',confirmed:true,enabled:true,forfeitIfStuck:false,emergencyDefaultChoice:false,planningMs:45000,previewPlanningMs:60000,unknownClockMs:20000,safetyMarginMs:5000});assert.equal(policy.ok,true,policy.error);await f.start();
  const origin=1793184223877;
  const request={rqid:10,active:[{maybeTrapped:true,moves:[{move:'Protect',pp:10,target:'self'}]},{maybeTrapped:true,moves:[{move:'Flash Cannon',pp:10,target:'normal'}]}],side:{id:'p2',name:'FixturePlayer',pokemon:[{ident:'p2: Rillaboom',details:'Rillaboom, L50',active:true,condition:'200/200'},{ident:'p2: Archaludon',details:'Archaludon, L50',active:true,condition:'165/165'},{ident:'p2: Politoed',details:'Politoed, L50',active:false,condition:'197/197'},{ident:'p2: Golisopod',details:'Golisopod, L50',active:false,condition:'182/182'}]}};
  f.tick(origin);f.client.receive(`>${room}\n|turn|3`);f.request(request);
  f.tick(origin+1);f.client.receive(`>${room}\n|inactive|Time left: 55 sec this turn | 400 sec total`);
  const corrected=structuredClone(request);corrected.rqid=12;corrected.update=true;delete corrected.active[1].maybeTrapped;corrected.active[1].trapped=true;
  const send=async()=>{f.tick(origin+14666);const action=f.session.actions()[0];const reply=await f.session.execute({id:'clock-lineage-choice',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'switch',slot:3}]});assert.equal(reply.ok,true,reply.error);};
  const reject=()=>{f.tick(origin+14742);f.client.receive(`>${room}\n|error|[Unavailable choice] Can't switch: The active Pokémon is trapped`);};
  return {...f,origin,initial:request,corrected,send,reject,reissue(request=corrected){f.tick(origin+14745);f.request(request);}};
}

test('A8 explicit trapped reissue carries the original turn clock and planning age through native supervision',async()=>{
  const f=await rejectedClockFixture();try{
    await f.send();const original=f.session.supervisor.status().pending[0];f.reject();f.reissue();
    const action=f.session.actions()[0],pending=f.session.supervisor.status().pending[0];
    assert.equal(f.client.state(room).receivedAt,f.origin+14745,'Physical packet arrival is retained');assert.equal(action.receivedAt,f.origin);assert.equal(action.requestPacketReceivedAt,f.origin+14745);
    assert.equal(action.requestClockContinuity.originRqid,10);assert.equal(action.requestClockContinuity.source,'explicit-trapped-choice-replacement');
    assert.equal(action.clock.deadlineAt,f.origin+55001);assert.equal(action.clock.source,'server-timer-observation');
    assert.equal(pending.receivedAt,f.origin);assert.equal(pending.planningDeadlineAt,original.planningDeadlineAt);assert.equal(pending.cutoffAt,original.cutoffAt);assert.equal(pending.hardDeadlineAt,original.hardDeadlineAt);
    assert.equal(pending.cutoffAt,f.origin+45000);assert.equal(pending.clockFreshForRequest,true);
    const trace=f.session.controlTrace.findLast(e=>e.type==='watchdog-deadline-armed');assert.equal(trace.clockContinuityOriginRqid,10);assert.equal(trace.requestPacketReceivedAt,f.origin+14745);assert.equal(trace.decisionWindowStartedAt,f.origin);
    f.tick(f.origin+24996);f.client.receive(`>${room}\n|inactive|Time left: 30 sec this turn`);assert.equal(f.session.supervisor.status().pending[0].hardDeadlineAt,f.origin+54996,'A later shorter clock still wins');
    f.tick(f.origin+25000);f.client.receive(`>${room}\n|inactive|Time left: 90 sec this turn`);assert.equal(f.session.supervisor.status().pending[0].hardDeadlineAt,f.origin+54996,'A later longer clock cannot reset the carried deadline');
  }finally{f.session.dispose();}
});

for(const [name,alter]of [
  ['no explicit rejection',()=>{}],
  ['unknown rejection',f=>f.client.receive(`>${room}\n|error|[Unavailable choice] Unknown reason`)],
  ['accepted choice',f=>{f.client.receive(`>${room}\n|sentchoice|move protect, switch 3`);f.reject();}],
  ['uncertain choice',f=>{f.client.state(room).lastAction.status='uncertain';f.reject();}],
  ['new server turn',f=>{f.reject();f.client.receive(`>${room}\n|turn|4`);}],
  ['gameplay between error and reissue',f=>{f.reject();f.client.receive(`>${room}\n|move|p2a: Rillaboom|Protect|p2a: Rillaboom`);}],
  ['connection epoch changed',f=>{f.reject();f.client.epoch++;}],
  ['disconnected client',f=>{f.reject();f.client.close();}],
  ['no retained numerical clock',f=>{f.client.state(room).timers=[];f.reject();}],
  ['expired retained numerical clock',f=>{f.client.state(room).timers[0].text='Time left: 1 sec this turn';f.reject();}],
  ['possibly truncated timer history',f=>{const r=f.client.state(room),timer=r.timers[0];r.timers=Array.from({length:20},(_,i)=>({...timer,sequence:timer.sequence+i}));f.reject();}],
  ['timer disabled',f=>{f.reject();f.client.receive(`>${room}\n|inactiveoff|Battle timer is OFF.`);}],
  ['owner changed',f=>{f.reject();f.session.recordControllerTransition('controller-claimed');}],
  ['second unmatched error',f=>{f.reject();f.client.receive(`>${room}\n|error|[Unavailable choice] Can't switch: The active Pokémon is trapped`);}],
])test(`rejected-clock continuity refuses ${name}`,async()=>{
  const f=await rejectedClockFixture();try{await f.send();alter(f);f.reissue();const action=f.session.actions()[0];assert.equal(action?.requestClockContinuity,undefined);assert.equal(f.client.state(room).rejectedClockWindow,null);if(action)assert.equal(action.receivedAt,f.origin+14745);}finally{f.session.dispose();}
});

for(const [name,alter]of [
  ['changed HP',q=>q.side.pokemon[1].condition='164/165'],
  ['changed side',q=>q.side.id='p1'],
  ['changed active roster',q=>q.side.pokemon[1].details='Politoed, L50'],
  ['changed moves',q=>q.active[1].moves[0].pp=9],
  ['replacement phase',q=>q.forceSwitch=[false,true]],
  ['waiting phase',q=>q.wait=true],
  ['nonincreasing request ID',q=>q.rqid=10],
  ['missing authoritative update flag',q=>delete q.update],
  ['false authoritative update flag',q=>q.update=false],
])test(`rejected-clock continuity refuses ${name} in the replacement packet`,async()=>{
  const f=await rejectedClockFixture();try{await f.send();f.reject();const q=structuredClone(f.corrected);alter(q);f.reissue(q);assert.equal(f.client.state(room).rejectedClockWindow,null);}finally{f.session.dispose();}
});

test('a second independently rejected trap update preserves the earliest clock window',async()=>{
  const f=await rejectedClockFixture();try{await f.send();f.reject();f.reissue();f.tick(f.origin+16000);const a=f.session.actions()[0];const reply=await f.session.execute({id:'second-trap-choice',op:'choose',confirmed:true,token:a.token,actions:[{type:'switch',slot:3},{type:'move',slot:1,target:1}]});assert.equal(reply.ok,true,reply.error);
    f.tick(f.origin+16001);f.client.receive(`>${room}\n|error|[Unavailable choice] Can't switch: The active Pokémon is trapped`);const q=structuredClone(f.corrected);q.rqid=14;delete q.active[0].maybeTrapped;q.active[0].trapped=true;f.tick(f.origin+16002);f.request(q);
    assert.equal(f.session.actions()[0].receivedAt,f.origin);assert.equal(f.session.actions()[0].requestClockContinuity.originRqid,10);assert.equal(f.session.supervisor.status().pending[0].cutoffAt,f.origin+45000);
  }finally{f.session.dispose();}
});

test('atomic preview intent is captured before socket publication and cannot be backdated by a later note',async()=>{
  const notes=[],f=fixture({decisionNoteWriter:async value=>{notes.push(structuredClone(value));}});
  try{
    await f.start();previewRequest(f);const action=f.session.actions()[0],actions=[{type:'team',order:[6,2,4,1]}],intent=previewIntent();
    const originalSend=f.client.ws.send;let atPublication;
    f.client.ws.send=text=>{if(text.includes('/choose team '))atPublication=f.session.turnPlans.history();originalSend(text);};
    const reply=await f.session.execute({id:'atomic-preview',op:'choose',confirmed:true,token:action.token,actions,previewPlan:intent});
    assert.equal(reply.ok,true,reply.error);assert.equal(atPublication.length,1);assert.deepEqual(atPublication[0].previewPlan,{...intent,chosenTeamOrder:actions[0].order});assert.equal(atPublication[0].intentStatus,'selected');assert.equal(atPublication[0].recordedAt,1000);
    await Promise.all([...f.session.turnPlanWrites]);assert.equal(notes.length,1);assert.deepEqual(notes[0].note.previewPlan,atPublication[0].previewPlan);assert.equal(notes[0].note.previewPlanCapture.capturedAt,1000);assert.equal(notes[0].note.previewPlanCapture.intentStatus,'selected');assert(!Object.hasOwn(notes[0].note,'turnPlan'));
    const late=await f.session.execute({id:'late-preview',op:'note-decision',token:action.token,previewPlan:intent});assert.equal(late.ok,false);assert.match(late.error,/cannot backdate/);assert.equal(notes.length,1);
    const repeated=await f.session.execute({id:'after-choice-preview',op:'choose',confirmed:true,token:action.token,actions,previewPlan:{...intent,objective:'Later prose'}});assert.equal(repeated.ok,false);assert.equal(notes.length,1);
  }finally{f.session.dispose();}
});

test('preview intent mismatches, turnPlan misuse and oversize claims refuse before socket or memory mutation',async()=>{
  const f=fixture();try{
    await f.start();previewRequest(f);const action=f.session.actions()[0],actions=[{type:'team',order:[6,2,4,1]}],before=f.sent.length;
    for(const [id,extra]of [['wrong-order',{previewPlan:{...previewIntent(),chosenTeamOrder:[1,2,4,6]}}],['wrong-field',{turnPlan:{objective:'Preview still cannot use turnPlan.'}}],['oversize',{previewPlan:{objective:'界'.repeat(180),risk:'界'.repeat(180),preserveIds:Array(6).fill('界'.repeat(80)),nextTurnCondition:'界'.repeat(180),unverified:Array(4).fill('界'.repeat(100))}}]]){
      const reply=await f.session.execute({id,op:'choose',confirmed:true,token:action.token,actions,...extra});assert.equal(reply.ok,false);assert.equal(f.sent.length,before);assert.equal(f.session.turnPlans.history().length,0);
    }
    f.request();const turn=f.session.actions()[0],reply=await f.session.execute({id:'nonpreview-plan',op:'choose',confirmed:true,token:turn.token,actions:[{type:'move',slot:1},{type:'move',slot:1}],previewPlan:previewIntent()});assert.equal(reply.ok,false);assert.match(reply.error,/preview request/);
  }finally{f.session.dispose();}
});

async function durablePreviewSessionFixture(){
  const [{mkdtemp,mkdir,rm},{join,resolve,dirname},{registerMetricsTeam},{saveDecisionNote,readDecisionNotes}]=await Promise.all([
    import('node:fs/promises'),import('node:path'),import('../metrics/catalog.mjs'),import('./decision-notes.mjs')]);
  const base=resolve('cache');await mkdir(base,{recursive:true});const workspace=await mkdtemp(join(base,'preview-session-regression-'));
  const {Teams}=createRequire(import.meta.url)('pokemon-showdown'),sets=['Golisopod','Kommo-o','Rillaboom','Politoed','Farigiraf','Sylveon'].map(species=>({species,moves:['Protect']})),packed=Teams.pack(sets),teamId=createHash('sha256').update(packed).digest('hex');
  const writes=[],timers=new Map();let time=1000,sequence=0;
  const f=fixture({packed,controlTimers:{setTimer:(callback,delay)=>{const id=++sequence;timers.set(id,{at:time+delay,callback});return id;},clearTimer:id=>timers.delete(id)},
    decisionNoteWriter:async value=>{writes.push(structuredClone(value));return saveDecisionNote({workspace,...value});}});
  try{await registerMetricsTeam({workspace,teamId,name:'Preview session regression',format:'gen9championsvgc2026regmc',roster:sets.map(set=>set.species)});}
  catch(error){f.session.dispose();assert.equal(dirname(workspace),base);await rm(workspace,{recursive:true,force:true});throw error;}
  return {...f,writes,setTime(value){time=value;f.tick(value);},advance(ms){
    const end=time+ms;let ticks=0;while(true){const next=[...timers.entries()].filter(([,value])=>value.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
      assert(++ticks<50,'Preview watchdog must not spin');time=next[1].at;f.tick(time);timers.delete(next[0]);next[1].callback();}
    time=end;f.tick(time);
  },readNotes:()=>readDecisionNotes({workspace,teamId,room}),async cleanup(){
    f.session.dispose();await Promise.all([...f.session.turnPlanWrites]);assert.equal(dirname(workspace),base);await rm(workspace,{recursive:true,force:true});
  }};
}

test('atomic preview watchdog sends the staged plan with original capture and durable intent unchanged',async()=>{
  const f=await durablePreviewSessionFixture();
  try{
    f.client.receive('|updatesearch|{"searching":[],"games":null}');
    const policy=await f.session.execute({id:'preview-watchdog-policy',op:'set-control-policy',confirmed:true,enabled:true,forfeitIfStuck:false,planningMs:1000,previewPlanningMs:1000,unknownClockMs:2000,safetyMarginMs:1000});
    assert.equal(policy.ok,true,policy.error);await f.start();previewRequest(f);
    const action=f.session.actions()[0],actions=[{type:'team',order:[6,2,4,1]}],intent=previewIntent(),expected=structuredClone({...intent,chosenTeamOrder:actions[0].order});
    f.setTime(1100);const staged=await f.session.execute({id:'preview-watchdog-stage',op:'stage-fallback',confirmed:true,token:action.token,actions,previewPlan:intent});
    assert.equal(staged.ok,true,staged.error);const original=f.session.turnPlans.history()[0];
    assert.deepEqual(original.previewPlan,expected);assert.equal(original.recordedAt,1100);assert.equal(original.intentStatus,'staged');assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,0);
    await Promise.all([...f.session.turnPlanWrites]);assert.equal(f.writes.length,1);assert.equal(f.writes[0].note.previewPlanCapture.capturedAt,1100);
    const send=f.client.ws.send,publications=[];f.client.ws.send=text=>{if(text.includes('/choose team '))publications.push(structuredClone(f.session.turnPlans.history()[0]));send(text);};
    intent.objective='Caller mutation after staging';actions[0].order.reverse();f.advance(900);
    assert.equal(f.sent.filter(line=>line.includes('/choose team ')).length,1);assert(f.sent.some(line=>line.includes('/choose team 6241')));
    assert.equal(publications.length,1);assert.deepEqual(publications[0].previewPlan,expected);assert.equal(publications[0].recordedAt,1100);assert.equal(publications[0].planHash,original.planHash);assert.equal(publications[0].intentStatus,'staged');
    const retained=f.session.turnPlans.history()[0];assert.deepEqual(retained.previewPlan,expected);assert.equal(retained.recordedAt,1100);assert.equal(retained.planHash,original.planHash);
    const status=f.session.supervisor.status().pending[0];assert.equal(status.attempted,true);assert.equal(status.state,'sent-awaiting-server');
    assert(f.session.controlTrace.some(value=>value.type==='selected'&&value.source==='fallback'));assert(f.session.controlTrace.some(value=>value.type==='watchdog-fallback-send-returned'&&value.source==='fallback'));
    assert(f.session.supervisor.history.some(value=>value.type==='fallback-send-returned'&&value.serverAcceptanceConfirmed===false),'Local watchdog return must not claim server acceptance');
    await Promise.all([...f.session.turnPlanWrites]);assert.equal(f.writes.length,1);const saved=await f.readNotes();assert.equal(saved.notes.length,1);
    assert.deepEqual(saved.notes[0].previewPlan,expected);assert.deepEqual(saved.notes[0].previewPlanCapture,{capturedAt:1100,intentStatus:'staged',planHash:original.planHash});assert.notEqual(saved.notes[0].recordedAt,1100);
    f.advance(1000);assert.equal(f.sent.filter(line=>line.includes('/choose team ')).length,1,'Watchdog must not resend after a local send returns');
  }finally{await f.cleanup();}
});

test('atomic preview stale token refuses stage and choose without intent recording or socket send',async()=>{
  const f=await durablePreviewSessionFixture();
  try{
    await f.start();previewRequest(f);const old=f.session.actions()[0];f.setTime(1100);previewRequest(f,2);
    const current=f.session.actions()[0];assert.notEqual(current.token,old.token);assert.equal(current.kind,'preview');const sentBefore=f.sent.length;
    for(const op of ['stage-fallback','choose']){
      const refused=await f.session.execute({id:'stale-preview-'+op,op,confirmed:true,token:old.token,actions:[{type:'team',order:[6,2,4,1]}],previewPlan:previewIntent()});
      assert.equal(refused.ok,false);assert.match(refused.error,/stale|unavailable|current/);assert.equal(f.sent.length,sentBefore);assert.deepEqual(f.session.turnPlans.history(),[]);
    }
    await Promise.all([...f.session.turnPlanWrites]);assert.deepEqual(f.writes,[]);assert.deepEqual((await f.readNotes()).notes,[]);assert.equal(f.session.actions()[0].token,current.token);
    assert.equal(f.session.controlTrace.filter(value=>value.type==='selected').length,0);
  }finally{await f.cleanup();}
});

test('actual MCP preview schema and handler preserve the distinct atomic plan and reject mismatches before forwarding',async()=>{
  const {registerBattleTools}=await import('./mcp-tools.mjs'),registered=new Map(),calls=[];
  registerBattleTools({registerTool:(name,config,handler)=>registered.set(name,{config,handler})},{workspace:'fixture-workspace',call:async(_path,command)=>{calls.push(command);return {ok:true,result:command};}});
  const actions=[{type:'team',order:[6,2,4,1]}],base={confirmed:true,commandId:'mcp-preview',controllerLease:'a'.repeat(64),token:'b'.repeat(64),actions,previewPlan:previewIntent()};
  for(const name of ['battle_stage_fallback','battle_choose']){
    const {config,handler}=registered.get(name),input=config.inputSchema.parse(base),reply=await handler(input);assert.equal(reply.isError,false);assert.deepEqual(calls.at(-1).previewPlan,{...base.previewPlan,chosenTeamOrder:actions[0].order});
    const before=calls.length,bad=await handler({...input,previewPlan:{...input.previewPlan,chosenTeamOrder:[1,2,4,6]}});assert.equal(bad.isError,true);assert.equal(calls.length,before);
  }
  assert.equal(registered.get('battle_note_decision').config.inputSchema.safeParse({commandId:'late',token:base.token,previewPlan:base.previewPlan}).success,false);
});

async function recipientFixture({sheet=true,firstMove='Psychic Noise',secondMove='Protect',opponent2='Rillaboom',onlyAttack=false,emergencyDefaultChoice=false}={}){
  const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
  const packed=Teams.pack([{species:'Farigiraf',ability:'Armor Tail',moves:[firstMove,...(onlyAttack?[]:['Protect'])],nature:'Sassy'},
    {species:'Politoed',ability:'Drizzle',moves:[secondMove],nature:'Modest'}]);
  let now=1000,sequence=0;const timers=new Map();
  const f=fixture({packed,controlTimers:{setTimer:(callback,delay)=>{const id=++sequence;timers.set(id,{at:now+delay,callback});return id;},clearTimer:id=>timers.delete(id)}});
  f.client.receive('|updatesearch|{"searching":[],"games":null}');
  const policy=await f.session.execute({id:'recipient-policy',op:'set-control-policy',confirmed:true,enabled:true,forfeitIfStuck:false,planningMs:1000,unknownClockMs:2000,safetyMarginMs:1000,emergencyDefaultChoice});
  assert.equal(policy.ok,true,policy.error);
  await f.start();
  f.client.receive(`>${room}\n|switch|p1a: Cat|Incineroar, L50|100/100\n|switch|p1b: Grass|${opponent2}, L50|100/100`);
  if(sheet)f.client.receive(`>${room}\n|showteam|p1|${Teams.pack([{species:'Incineroar',ability:'Intimidate',moves:['Flare Blitz']},
    {species:opponent2,ability:opponent2==='Rillaboom'?'Grassy Surge':'Pressure',moves:['Protect']},{species:'Politoed',ability:'Drizzle',moves:['Protect']}])}`);
  f.request({active:[{moves:[{move:firstMove,pp:10,target:'normal'},...(onlyAttack?[]:[{move:'Protect',pp:10,target:'self'}])]},
    {moves:[{move:secondMove,pp:10,target:secondMove==='Protect'?'self':'normal'}]}],side:{id:'p2',name:'FixturePlayer',pokemon:[
    {ident:'p2: Fari',details:'Farigiraf, L50',active:true,condition:'100/100'},{ident:'p2: Poli',details:'Politoed, L50',active:true,condition:'100/100'}]}});
  const action=f.session.actions()[0],{context,source}=f.session.recipientContext(action),actor=context.actors.find(a=>a.own&&a.slot===1),target=context.actors.find(a=>!a.own&&a.slot===1),reserve=context.actors.find(a=>!a.own&&!a.slot&&a.species==='Politoed');
  const pair=[{type:'move',slot:1,target:1},{type:'move',slot:1}],read={actorId:actor.id,moveSlot:1,targetSlot:1,currentTargetId:target.id,
    expected:{kind:'switch',recipientId:reserve?.id||'missing'},source:Object.fromEntries(['boardHash','requestDigest','opposingSheetSha256'].map(k=>[k,source[k]||'0'.repeat(64)])),acknowledgeCurrentImmunity:true};
  const acknowledgement={actorId:actor.id,moveSlot:1,targetSlot:1,currentTargetId:target.id,source:structuredClone(read.source),acknowledgeNoCurrentEffect:true,independentActorId:context.actors.find(a=>a.own&&a.slot===2).id,purpose:'Accept this move’s lack of current effect while the partner acts.'};
  return {...f,action,pair,read,acknowledgement,context,source,advance(ms){const end=now+ms;let ticks=0;while(true){const next=[...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;assert(++ticks<50);now=next[1].at;f.tick(now);timers.delete(next[0]);next[1].callback();}now=end;f.tick(now);}};
}

async function publicRecipientAcknowledgement(f,id){
  const reply=await f.session.execute({id,op:'turn-status'});assert.equal(reply.ok,true,reply.error);
  const status=reply.result,action=status.actions.find(value=>value.kind==='turn'),board=status.boards.find(value=>value.room===action.room),own=board.sides.find(side=>side.id===board.ownSide),foe=board.sides.find(side=>side.id!==board.ownSide);
  const actorId=own.active.find(value=>value.slot==='a').pokemon,independentActorId=own.active.find(value=>value.slot==='b').pokemon,currentTargetId=foe.active.find(value=>value.slot==='a').pokemon;
  assert(action.recipientEffectSource);assert.match(action.recipientEffectSource.boardHash,/^[a-f0-9]{64}$/);assert.match(action.recipientEffectSource.requestDigest,/^[a-f0-9]{64}$/);
  return {action,acknowledgement:{actorId,moveSlot:1,targetSlot:1,currentTargetId,source:action.recipientEffectSource,acknowledgeNoCurrentEffect:true,independentActorId,purpose:'Accept no current effect while the partner protects.'}};
}

test('session refuses known immune recipients before manual choice or fallback mutation without requiring a sheet',async()=>{
  const f=await recipientFixture({sheet:false});
  try{
    const before=f.sent.length;
    const reply=await f.session.execute({id:'immune-choice',op:'choose',confirmed:true,token:f.action.token,actions:f.pair});
    assert.equal(reply.ok,false);assert.match(reply.error,/type-immune/);
    const stage=await f.session.execute({id:'immune-stage',op:'stage-fallback',confirmed:true,token:f.action.token,actions:f.pair});
    assert.equal(stage.ok,false);assert.match(stage.error,/type-immune/);
    const forged=await f.session.execute({id:'missing-sheet-read',op:'choose',confirmed:true,token:f.action.token,actions:f.pair,turnPlan:{objective:'An unavailable sheet cannot authorize this read.',recipientReads:[f.read]}});
    assert.equal(forged.ok,false);assert.match(forged.error,/source changed/);
    assert.equal(f.session.supervisor.status().pending[0].hasFallback,false);assert.equal(f.sent.length,before);
    assert.equal(f.session.turnPlans.snapshot({teamId:f.client.expectedTeamHash,room,rqid:1,revision:f.action.revision}),null);
  }finally{f.session.dispose();}
});

test('explicit recipient read binds the current source and full actions for direct choice',async()=>{
  const f=await recipientFixture();
  try{
    const plan={objective:'Read a Politoed switch; the current Incineroar is immune.',recipientReads:[f.read]};
    const stale=structuredClone(plan);stale.recipientReads[0].source.boardHash='0'.repeat(64);
    const rejected=await f.session.execute({id:'stale-recipient-read',op:'choose',confirmed:true,token:f.action.token,actions:f.pair,turnPlan:stale});
    assert.equal(rejected.ok,false);assert.match(rejected.error,/source changed/);
    const wrong=structuredClone(plan);wrong.recipientReads[0].moveSlot=2;
    assert.equal((await f.session.execute({id:'wrong-recipient-action',op:'choose',confirmed:true,token:f.action.token,actions:f.pair,turnPlan:wrong})).ok,false);
    const chosen=await f.session.execute({id:'read-choice',op:'choose',confirmed:true,token:f.action.token,actions:f.pair,turnPlan:plan});
    assert.equal(chosen.ok,true,chosen.error);assert(f.sent.some(line=>line.includes('/choose move 1 1, move 1')));
  }finally{f.session.dispose();}
});

test('recipient read survives staged fallback and is revalidated at the actual cutoff',async()=>{
  const f=await recipientFixture();
  try{
    const plan={objective:'Read the registered Politoed switch.',recipientReads:[f.read]},reply=await f.session.execute({id:'read-fallback',op:'stage-fallback',confirmed:true,token:f.action.token,actions:f.pair,turnPlan:plan});
    assert.equal(reply.ok,true,reply.error);plan.recipientReads[0].source.boardHash='0'.repeat(64);
    f.advance(1000);
    assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);
    assert(f.sent.some(line=>line.includes('/choose move 1 1, move 1')));
    assert(f.session.controlTrace.some(e=>e.source==='fallback'&&e.type==='selected'));
  }finally{f.session.dispose();}
});

test('changed recipient source invalidates a staged read without retargeting or sending',async()=>{
  const f=await recipientFixture();
  try{
    const staged=await f.session.execute({id:'stale-fallback-stage',op:'stage-fallback',confirmed:true,token:f.action.token,actions:f.pair,turnPlan:{objective:'Read the registered Politoed switch.',recipientReads:[f.read]}});
    assert.equal(staged.ok,true,staged.error);
    f.client.receive(`>${room}\n|-damage|p1a: Cat|90/100`);f.advance(1000);
    assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,0);
    assert.equal(f.session.supervisor.status().pending[0].hasFallback,false);
    assert(f.session.supervisor.status().pending[0].recovering);
  }finally{f.session.dispose();}
});

test('ordinary nonimmune targets remain available without optional plan metadata',async()=>{
  const f=await recipientFixture();
  try{
    const pair=[{type:'move',slot:1,target:2},{type:'move',slot:1}],chosen=await f.session.execute({id:'normal-recipient',op:'choose',confirmed:true,token:f.action.token,actions:pair});
    assert.equal(chosen.ok,true,chosen.error);assert(f.sent.some(line=>line.includes('/choose move 1 2, move 1')));
  }finally{f.session.dispose();}
});

for(const firstMove of ['Psychic Noise','Dark Pulse'])test(`authorized emergency default preserves native control for ${firstMove}`,async()=>{
  const f=await recipientFixture({firstMove,emergencyDefaultChoice:true});
  try{
    f.advance(1000);
    assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);
    assert(f.sent.some(line=>line.includes('/choose move 1 1, move 1')));
    const status=f.session.supervisor.status();
    assert.equal(status.haltReason,'emergency-default-used');
    assert.equal(status.pending[0].state,'sent-awaiting-server');assert.equal(status.pending[0].attempted,true);
    assert(f.session.controlTrace.some(entry=>entry.source==='emergency-default'&&entry.controlFailure===true));
    assert.equal(f.session.turnPlans.snapshot({teamId:f.client.expectedTeamHash,room,rqid:1,revision:f.action.revision}),null);
  }finally{f.session.dispose();}
});

test('command and metadata source spoofing cannot bypass authored recipient validation',async()=>{
  const f=await recipientFixture({emergencyDefaultChoice:true});
  try{
    for(const op of ['choose','stage-fallback']){
      const reply=await f.session.execute({id:`source-spoof-${op}`,op,confirmed:true,token:f.action.token,actions:f.pair,
        source:'emergency-default',metadata:{source:'emergency-default'},turnPlan:{objective:'A metadata source string is not supervisor authority.'}});
      assert.equal(reply.ok,false);assert.match(reply.error,/type-immune/);
    }
    assert.throws(()=>f.session.supervisor.stage(f.action.token,f.pair,{source:'emergency-default'}),/type-immune/);
    assert.throws(()=>f.session.validateAction(f.action,f.pair,{source:'emergency-default'},'emergency-default'),/type-immune/);
    assert.throws(()=>f.session.submitChoice(f.action,f.pair,'emergency-default'),/type-immune/);
    assert.equal(f.session.supervisor.status().pending[0].hasFallback,false);
    assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,0);
  }finally{f.session.dispose();}
});

for(const op of ['choose','stage-fallback'])test(`explicit no-effect acknowledgement supports ${op} without claiming usefulness`,async()=>{
  const f=await recipientFixture({onlyAttack:true});
  try{
    const plan={objective:'Accept the unavailable target effect while the partner protects.',ineffectiveActions:[f.acknowledgement]};
    for(const [label,mutate]of [
      ['source',ack=>{ack.source.boardHash='0'.repeat(64);}],
      ['actor',ack=>{ack.actorId=f.acknowledgement.independentActorId;}],
      ['action',ack=>{ack.targetSlot=2;}],
      ['partner',ack=>{ack.independentActorId=ack.actorId;}],
    ]){
      const wrong=structuredClone(plan);mutate(wrong.ineffectiveActions[0]);
      const reply=await f.session.execute({id:`ack-${op}-${label}`,op,confirmed:true,token:f.action.token,actions:f.pair,turnPlan:wrong});
      assert.equal(reply.ok,false,`${label} must refuse`);
      assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,0);
      assert.equal(f.session.supervisor.status().pending[0].hasFallback,false);
    }
    const reply=await f.session.execute({id:`ack-${op}-valid`,op,confirmed:true,token:f.action.token,actions:f.pair,turnPlan:plan});
    assert.equal(reply.ok,true,reply.error);
    const audit=reply.result.recipientEffectAudit,ack=audit.ineffectiveActions[0];
    assert.equal(audit.validationScope,'session-current-snapshot');assert.equal(audit.futureEffectsVerified,false);
    assert.equal(ack.status,'acknowledged-no-current-effect');assert.deepEqual(ack.independentAction,f.pair[1]);
    for(const key of ['independentEffectVerified','usefulnessVerified','forcednessVerified'])assert.equal(ack[key],false);
    assert.deepEqual(plan.ineffectiveActions,[f.acknowledgement]);
    if(op==='stage-fallback'){plan.ineffectiveActions[0].source.boardHash='0'.repeat(64);f.advance(1000);}
    assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);
    assert(f.sent.some(line=>line.includes('/choose move 1 1, move 1')));
  }finally{f.session.dispose();}
});

test('both ineffective selected attacks may be explicitly acknowledged without a strategy gate',async()=>{
  const f=await recipientFixture({secondMove:'Mud Shot',opponent2:'Corviknight',onlyAttack:true});
  try{
    const other=f.context.actors.find(a=>a.own&&a.slot===2),target=f.context.actors.find(a=>!a.own&&a.slot===2),pair=[f.pair[0],{type:'move',slot:1,target:2}];
    const second={...structuredClone(f.acknowledgement),actorId:other.id,targetSlot:2,currentTargetId:target.id,independentActorId:f.acknowledgement.actorId};
    const reply=await f.session.execute({id:'both-acknowledged',op:'choose',confirmed:true,token:f.action.token,actions:pair,
      turnPlan:{objective:'Explicitly accept both current no-effect costs without claiming a useful outcome.',ineffectiveActions:[f.acknowledgement,second]}});
    assert.equal(reply.ok,true,reply.error);assert.equal(reply.result.recipientEffectAudit.ineffectiveActions.length,2);
    assert(reply.result.recipientEffectAudit.ineffectiveActions.every(ack=>ack.usefulnessVerified===false&&ack.forcednessVerified===false));
    assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);
  }finally{f.session.dispose();}
});

test('current source is revalidated for no-effect fallback acknowledgements at cutoff',async()=>{
  const f=await recipientFixture({onlyAttack:true});
  try{
    const staged=await f.session.execute({id:'ack-before-board-change',op:'stage-fallback',confirmed:true,token:f.action.token,actions:f.pair,
      turnPlan:{objective:'Accept the lack of current effect for this exact board only.',ineffectiveActions:[f.acknowledgement]}});
    assert.equal(staged.ok,true,staged.error);
    f.client.receive(`>${room}\n|-damage|p1a: Cat|90/100`);f.advance(1000);
    assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,0);
    assert.equal(f.session.supervisor.status().pending[0].hasFallback,false);
    assert.equal(f.session.supervisor.status().pending[0].recovering,true);
  }finally{f.session.dispose();}
});

for(const op of ['choose','stage-fallback'])test(`public no-sheet recipient source permits an honest no-effect ${op}`,async()=>{
  const f=await recipientFixture({sheet:false,onlyAttack:true});
  try{
    const before=f.sent.length,{action,acknowledgement}=await publicRecipientAcknowledgement(f,`no-sheet-source-${op}`);
    assert.equal(f.sent.length,before);assert.equal(Object.hasOwn(acknowledgement.source,'opposingSheetSha256'),false);
    const forged=structuredClone(acknowledgement);forged.source.opposingSheetSha256='0'.repeat(64);
    const refused=await f.session.execute({id:`no-sheet-forged-${op}`,op,confirmed:true,token:action.token,actions:f.pair,turnPlan:{objective:'An invented sheet digest must refuse.',ineffectiveActions:[forged]}});
    assert.equal(refused.ok,false);assert.match(refused.error,/source changed/);assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,0);
    const reply=await f.session.execute({id:`no-sheet-valid-${op}`,op,confirmed:true,token:action.token,actions:f.pair,turnPlan:{objective:'Acknowledge current immunity using only available public source bindings.',ineffectiveActions:[acknowledgement]}});
    assert.equal(reply.ok,true,reply.error);assert.equal(reply.result.recipientEffectAudit.validationScope,'session-current-snapshot');
    assert.equal(Object.hasOwn(reply.result.recipientEffectAudit.ineffectiveActions[0].source,'opposingSheetSha256'),false);
    assert.equal(reply.result.recipientEffectAudit.ineffectiveActions[0].usefulnessVerified,false);
    if(op==='stage-fallback')f.advance(1000);
    assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);
  }finally{f.session.dispose();}
});

test('public sheet-present acknowledgement refuses an omitted or mismatched sheet digest',async()=>{
  const f=await recipientFixture({onlyAttack:true});
  try{
    const {action,acknowledgement}=await publicRecipientAcknowledgement(f,'present-sheet-source');assert.match(acknowledgement.source.opposingSheetSha256,/^[a-f0-9]{64}$/);
    for(const variant of ['omitted','mismatched']){
      const wrong=structuredClone(acknowledgement);
      if(variant==='omitted')delete wrong.source.opposingSheetSha256;else wrong.source.opposingSheetSha256='0'.repeat(64);
      const reply=await f.session.execute({id:`present-sheet-${variant}`,op:'choose',confirmed:true,token:action.token,actions:f.pair,turnPlan:{objective:'The available published sheet binding must match exactly.',ineffectiveActions:[wrong]}});
      assert.equal(reply.ok,false);assert.match(reply.error,/source changed/);
    }
    assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,0);
  }finally{f.session.dispose();}
});

test('public no-sheet acknowledgement cannot be rebound to a new request',async()=>{
  const f=await recipientFixture({sheet:false,onlyAttack:true});
  try{
    const {acknowledgement}=await publicRecipientAcknowledgement(f,'old-request-source'),request=structuredClone(f.client.rooms.get(room).request);request.rqid++;f.request(request);
    const action=f.session.actions()[0],reply=await f.session.execute({id:'stale-public-request-ack',op:'choose',confirmed:true,token:action.token,actions:f.pair,turnPlan:{objective:'An old public request digest is not fresh evidence.',ineffectiveActions:[acknowledgement]}});
    assert.equal(reply.ok,false);assert.match(reply.error,/source changed/);assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,0);
  }finally{f.session.dispose();}
});

test('ordinary no-sheet effective choices remain legal and unavailable descriptors are explicit',async()=>{
  const f=await recipientFixture({sheet:false,firstMove:'Dark Pulse'});
  try{
    const source=await publicRecipientAcknowledgement(f,'ordinary-no-sheet-source');assert.equal(Object.hasOwn(source.action.recipientEffectSource,'opposingSheetSha256'),false);
    const original=f.session.recipientContext;f.session.recipientContext=()=>{throw new Error('simulated current context unavailable');};
    const unavailable=await f.session.execute({id:'unavailable-source',op:'turn-status'}),action=unavailable.result.actions.find(value=>value.kind==='turn');
    assert.equal(action.recipientEffectSourceStatus,'unavailable');assert.equal(Object.hasOwn(action,'recipientEffectSource'),false);
    f.session.recipientContext=original;
    const chosen=await f.session.execute({id:'ordinary-no-sheet-choice',op:'choose',confirmed:true,token:f.action.token,actions:f.pair});
    assert.equal(chosen.ok,true,chosen.error);assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);
  }finally{f.session.dispose();}
});

test('staged plan preserves named-switch intent while the supervisor retains canonical actions',async()=>{
  const f=await recipientFixture();
  try{
    const request=structuredClone(f.client.rooms.get(room).request);request.rqid++;
    request.side.pokemon.push({ident:'p2: Sylv',details:'Sylveon, L50',active:false,condition:'100/100'});f.request(request);
    const action=f.session.actions()[0],pokemonId=action.legalActions.replacements.find(r=>r.slot===3).pokemonId,pair=[{type:'switch',pokemonId},{type:'move',slot:1}];
    const reply=await f.session.execute({id:'named-recipient-fallback',op:'stage-fallback',confirmed:true,token:action.token,actions:pair,turnPlan:{objective:'Preserve the first slot with its named reserve.'}});
    assert.equal(reply.ok,true,reply.error);f.advance(1000);
    assert(f.sent.some(line=>line.includes('/choose switch 3, move 1')));
    assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);
  }finally{f.session.dispose();}
});

test('metrics IPC exposes safe status and flushes local observations without blocking battle actions',async()=>{
  const f=fixture();let finishSync,flushes=0;
  const state={enabled:true,teamId:f.client.expectedTeamHash,state:'pending',pending:1,lastSavedAt:null,lastError:null,stableReport:null};
  const recorder={status:()=>({...state}),flush:async options=>{
    assert.deepEqual(options,{savePending:true});flushes++;
    await new Promise(resolve=>{finishSync=resolve;});
    return {...state,state:'ready',pending:0,stableReport:{teamId:state.teamId,path:'synthetic-report.html'}};
  }};
  try{
    assert.equal(f.session.snapshot().metrics.enabled,false);
    assert.match((await f.session.execute({id:'disabled-sync',op:'metrics-sync'})).error,/unavailable/);
    f.session.attachMetricsRecorder(recorder);
    const syncing=f.session.execute({id:'flush-once',op:'metrics-sync'});await Promise.resolve();await Promise.resolve();
    assert.equal(f.session.snapshot().metrics.state,'pending');
    const status=await f.session.execute({id:'read-metrics',op:'metrics-status'});
    assert.equal(status.ok,true);assert.equal(status.result.teamId,state.teamId);
    // A slow derived report never serializes deadline-sensitive commands.
    assert.equal((await f.start()).ok,true);f.request();
    const action=f.session.snapshot().actions[0];
    assert.equal((await f.session.execute({id:'choose-during-sync',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]})).ok,true);
    finishSync();const reply=await syncing;
    assert.equal(reply.ok,true);assert.equal(reply.result.state,'ready');
    assert.deepEqual(await f.session.execute({id:'flush-once',op:'metrics-sync'}),reply);assert.equal(flushes,1);
    assert(!f.sent.some(line=>/metrics|report/.test(line)));
  }finally{finishSync?.();f.session.dispose();}
});

test('metrics sync cannot claim success for failed recording or a mismatched team',async()=>{
  const f=fixture();
  try{
    assert.throws(()=>f.session.attachMetricsRecorder({status:()=>({teamId:'a'.repeat(64)}),flush(){}}),/differs from the approved/);
    f.session.attachMetricsRecorder({status:()=>({enabled:true,teamId:f.client.expectedTeamHash,state:'error'}),flush:async()=>({state:'error'})});
    const reply=await f.session.execute({id:'failed-sync',op:'metrics-sync'});
    assert.equal(reply.ok,false);assert.match(reply.error,/persistence is not confirmed/);
    assert.equal(f.sent.length,0);
  }finally{f.session.dispose();}
});
test('one authorized search, fixed team, explicit control and idempotent commands',async()=>{
  const f=fixture();assert.equal((await f.session.execute({id:'no',op:'start'})).ok,false);
  assert((await f.start()).ok);assert((await f.start()).ok);
  f.client.receive('|updatesearch|{"searching":["gen9championsvgc2026regmcbo3"],"games":{}}');
  f.client.receive('|updatesearch|{"searching":[],"games":null}');
  assert.match((await f.session.execute({id:'again',op:'start',confirmed:true})).error,/set limit/);
  assert.equal(f.sent.filter(text=>text.includes('/search ')).length,1);f.session.dispose();
});
test('longer turn and optional preview budgets retain idle confirmation and current-controller guards', async () => {
  const f = fixture({controllerRequired: true});
  let sequence = 0;
  const configure = extra => f.session.execute({id: `budget-${++sequence}`, op: 'set-control-policy', confirmed: true,
    enabled: true, forfeitIfStuck: false, planningMs: 45000, previewPlanningMs: 60000, ...extra});
  try {
    const loaded = f.session.capabilities();
    assert.equal(loaded.features.previewPlanningBudget, true);
    assert.equal(loaded.features.currentRecipientTypeImmunityGate,true);assert.equal(loaded.features.stagedTurnPlanMetadata,true);assert.equal(loaded.features.sourceBoundIneffectiveActions,true);
    for(const file of ['planning/recipient-effects.mjs','planning/board.mjs','planning/identity.mjs','planning/source.mjs','showdown/battle-state.mjs'])assert.match(loaded.modules[file],/^[a-f0-9]{64}$/);
    assert.equal(loaded.modules['showdown/battle-state.mjs'],createHash('sha256').update(readFileSync(new URL('./battle-state.mjs',import.meta.url))).digest('hex'));
    assert.equal(loaded.modules['showdown/agent-session.mjs'], loaded.buildRevision);
    assert.match(loaded.modules['showdown/deadline-supervisor.mjs'], /^[a-f0-9]{64}$/);
    loaded.modules['showdown/deadline-supervisor.mjs'] = 'caller-edit';
    assert.notEqual(f.session.capabilities().modules['showdown/deadline-supervisor.mjs'], 'caller-edit');
    assert.match((await configure({})).error, /controller lease/);
    const lease = (await f.session.execute({id: 'budget-owner', op: 'control-claim', confirmed: true, controllerId: 'budget-fixture'})).result.controllerLease;
    assert.match((await configure({controllerLease: lease})).error, /confirm idle/);
    f.client.receive('|updatesearch|{"searching":[],"games":null}');
    assert.match((await configure({controllerLease: lease, confirmed: false})).error, /confirmation/);
    assert.match((await configure({controllerLease: '0'.repeat(64)})).error, /controller lease/);
    const result = await configure({controllerLease: lease});
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.planningMs, 45000); assert.equal(result.result.previewPlanningMs, 60000);
    assert.equal(result.result.unknownClockMs, 20000); assert.equal(result.result.emergencyDefaultChoice, false);
    const inherited = await configure({controllerLease: lease, planningMs: 120000, previewPlanningMs: undefined});
    assert.equal(inherited.ok, true, inherited.error); assert.equal(inherited.result.previewPlanningMs, 120000);
    const defaults = await configure({controllerLease: lease, planningMs: undefined, previewPlanningMs: undefined});
    assert.equal(defaults.result.planningMs, 20000); assert.equal(defaults.result.previewPlanningMs, 20000);
    for (const key of ['planningMs', 'previewPlanningMs']) for (const value of [99, 120001, 45000.5, '45000']) {
      assert.match((await configure({controllerLease: lease, [key]: value})).error, /100–120000/);
    }
    for (const value of [99, 30001, 20000.5, '20000']) {
      assert.match((await configure({controllerLease: lease, unknownClockMs: value})).error, /100–30000/);
    }
    f.client.searchPending = true;
    assert.match((await configure({controllerLease: lease})).error, /confirm idle/);
    f.client.searchPending = false;
    assert.equal(f.sent.length, 0);
  } finally { f.session.dispose(); }
});
test('MCP deadline schema forwards longer phase budgets and preserves unknown-clock defaults and bounds', async () => {
  const {registerBattleTools} = await import('./mcp-tools.mjs');
  const registered = new Map(), calls = [];
  registerBattleTools({registerTool: (name, config, handler) => registered.set(name, {config, handler})}, {
    workspace: 'fixture-workspace', call: async (_path, command) => {calls.push(command); return {ok: true, result: command};},
  });
  const {config, handler} = registered.get('battle_set_control_policy');
  const base = {confirmed: true, commandId: 'longer-phase-policy', controllerLease: 'a'.repeat(64), enabled: true, forfeitIfStuck: false};
  const defaults = config.inputSchema.parse(base);
  assert.equal(defaults.planningMs, 20000); assert.equal(defaults.previewPlanningMs, undefined);
  assert.equal(defaults.unknownClockMs, 20000); assert.equal(defaults.emergencyDefaultChoice, false);
  const policy = config.inputSchema.parse({...base, planningMs: 45000, previewPlanningMs: 60000});
  await handler(policy);
  assert.equal(calls.length, 1); assert.equal(calls[0].op, 'set-control-policy');
  assert.equal(calls[0].planningMs, 45000); assert.equal(calls[0].previewPlanningMs, 60000); assert.equal(calls[0].unknownClockMs, 20000);
  for (const key of ['planningMs', 'previewPlanningMs']) {
    assert.equal(config.inputSchema.safeParse({...base, [key]: 120000}).success, true);
    for (const value of [99, 120001, 45000.5, '45000', null]) assert.equal(config.inputSchema.safeParse({...base, [key]: value}).success, false);
  }
  for (const value of [99, 30001, 20000.5, '20000']) assert.equal(config.inputSchema.safeParse({...base, unknownClockMs: value}).success, false);
  assert.equal(config.inputSchema.safeParse({...base, confirmed: false}).success, false);
  assert.equal(config.inputSchema.safeParse({...base, controllerLease: undefined}).success, false);
});
test('an exhausted idle session can explicitly authorize another set without queuing or signing in again',async()=>{
  const f=fixture();await f.start();
  f.client.receive(`>${parent}\n|win|FixturePlayer`);
  f.client.receive('|updatesearch|{"searching":[],"games":null}');
  assert.equal((await f.session.execute({id:'exhausted',op:'start',confirmed:true})).ok,false);
  const before=f.session.snapshot(),sent=f.sent.length;
  const grant={id:'extend-once',op:'authorize-sets',confirmed:true,additionalSets:1};
  const result=await f.session.execute(grant);
  assert.deepEqual(result.result,{authorizedSets:2,searchesSent:1,remainingSets:1,queued:false});
  assert.deepEqual(await f.session.execute(grant),result);
  const after=f.session.snapshot();
  assert.equal(after.authorizedSets,2);assert.equal(f.sent.length,sent);
  assert.equal(after.sessionId,before.sessionId);assert.equal(after.username,before.username);
  assert.equal(after.teamSha256,before.teamSha256);assert.equal(after.authenticated,true);
  assert((await f.session.execute({id:'next-set',op:'start',confirmed:true})).ok);
  assert.equal(f.sent.filter(text=>text.includes('/search ')).length,2);
  assert.equal(f.sent.filter(text=>text.includes('/utm ')).length,1);f.session.dispose();
});
test('additional set authorization rejects missing confirmation, invalid counts, active/pending matches and disconnects',async()=>{
  const f=fixture();
  const grant={op:'authorize-sets',confirmed:true,additionalSets:1};let number=0;
  const execute=extra=>f.session.execute({id:'grant-'+(++number),...grant,...extra});
  assert.equal((await execute({confirmed:false})).ok,false);
  assert.match((await execute({})).error,/confirm an idle session/);
  f.client.receive('|updatesearch|{"searching":[],"games":null}');
  for(const additionalSets of [0,-1,1.5,101,'1',undefined])assert.match((await execute({additionalSets})).error,/Additional sets/);
  await f.start();assert.match((await execute({})).error,/confirm an idle session/);
  f.client.ws.close();assert.match((await execute({})).error,/disconnected or stopped/);
  assert.equal(f.session.authorizedSets,1);f.session.dispose();
  const pending=fixture();await pending.session.execute({id:'pending-start',op:'start',confirmed:true});
  pending.client.receive('|updatesearch|{"searching":["gen9championsvgc2026regmcbo3"],"games":null}');
  pending.client.receive('|updatesearch|{"searching":[],"games":null}');
  assert.equal(pending.client.searchPending,false);assert.equal(pending.session.awaitingSet,true);
  assert.match((await pending.session.execute({id:'pending-grant',...grant})).error,/confirm an idle session/);
  assert.equal(pending.session.authorizedSets,1);pending.session.dispose();
});
test('additional authorization respects the cumulative 100-set maximum and wakes state waits',async()=>{
  const f=fixture({authorizedSets:99});f.client.receive('|updatesearch|{"searching":[],"games":null}');
  const waiting=f.session.wait({afterRevision:f.session.revision,timeoutMs:1000});
  assert((await f.session.execute({id:'reach-max',op:'authorize-sets',confirmed:true,additionalSets:1})).ok);
  assert.equal((await waiting).authorizedSets,100);
  assert.match((await f.session.execute({id:'over-max',op:'authorize-sets',confirmed:true,additionalSets:1})).error,/cannot exceed 100/);
  assert.equal(f.sent.length,0);f.session.dispose();
});
test('current token selects paired actions; stale/duplicate and post-result tokens fail',async()=>{
  const f=fixture();await f.start();f.request();const action=f.session.snapshot().actions[0];
  const command={id:'choose',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]};
  assert((await f.session.execute(command)).ok);assert((await f.session.execute(command)).ok);
  assert.equal(f.session.snapshot().actions.length,0);
  assert.equal((await f.session.execute({...command,id:'duplicate'})).ok,false);
  f.request({rqid:2});const next=f.session.snapshot().actions[0];assert.notEqual(next.token,action.token);
  f.client.receive(`>${room}\n|win|Other`);
  assert.equal((await f.session.execute({...command,id:'ended',token:next.token})).ok,false);
  assert.equal(f.sent.filter(text=>text.includes('/choose ')).length,1);f.session.dispose();
});
test('observed own clock limits decisions; opponent countdown is not ours',async()=>{
  const f=fixture();await f.start();f.request();
  f.client.receive(`>${room}\n|inactive|Opponent has 5 seconds left.`);
  assert.equal(f.session.snapshot().actions[0].clock.source,'unavailable');
  f.client.receive(`>${room}\n|inactive|Time left: 10 sec this turn | 420 sec total`);
  const action=f.session.snapshot().actions[0];assert.equal(action.clock.deadlineAt,11000);
  f.tick(10500);
  assert.match((await f.session.execute({id:'late',op:'choose',confirmed:true,token:action.token,actions:[]})).error,/countdown/);
  f.session.dispose();
});
test('server acknowledgments and actual resolution evidence stay distinct',async()=>{
  const f=fixture();await f.start();f.request();const action=f.session.snapshot().actions[0];
  await f.session.execute({id:'choice',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]});
  assert.equal(f.client.state(room).lastAction.status,'sent');
  f.client.receive(`>${room}\n|sentchoice|move 1, move 1`);assert.equal(f.client.state(room).lastAction.status,'accepted');
  f.client.receive(`>${room}\n|move|p1a: Foe|Protect|p1a: Foe`);assert.equal(f.client.state(room).lastAction.evidence.length,0);
  f.client.receive(`>${room}\n|move|p2a: A|Protect|p2a: A`);assert.equal(f.client.state(room).lastAction.evidence.length,1);
  f.client.receive(`>${room}\n|win|FixturePlayer`);const decision=f.client.state(room).lastAction;
  assert.equal(decision.status,'execution-observed');assert.equal(decision.evidence.length,1);assert.equal(decision.boundary,'battle-ended');f.session.dispose();
});
test('automatic ready is scoped, prompt driven, idempotent, and never searches again',async()=>{
  const f=fixture();
  const prompt=()=>f.client.receive(`>${room}\n|c|~|/uhtml controls,<button value="/msgroom ${parent},/confirmready">Ready</button>`);
  prompt();assert.equal(f.sent.length,0);await f.start();
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'FixturePlayer vs Opponent',[room]:'FixturePlayer vs Opponent'}})}`);
  prompt();prompt();assert.equal(f.sent.filter(text=>text.includes('/confirmready')).length,1);
  f.client.receive(`>${room}\n|c|~|/uhtml controls,<button disabled>Ready</button>`);
  prompt();assert.equal(f.sent.filter(text=>text.includes('/confirmready')).length,2);
  assert.equal(f.sent.filter(text=>text.includes('/search ')).length,1);f.session.dispose();
});
test('manual readiness returns urgent token, waits wake on updates and clean listeners',async()=>{
  const f=fixture({autoReady:false});await f.start();f.request();
  const revision=f.session.revision,pending=f.session.wait({afterRevision:revision,timeoutMs:1000});
  f.client.receive(`>${room}\n|turn|2`);assert((await pending).revision>revision);
  assert.equal(f.session.listenerCount('change'),0);
  const abort=new AbortController();const wait=f.session.wait({afterRevision:f.session.revision,timeoutMs:1000,signal:abort.signal});abort.abort();await wait;assert.equal(f.session.listenerCount('change'),0);f.session.dispose();
});

test('ready clocks use the current prompt boundary and repeated prompts never extend a countdown',async()=>{
  const f=fixture({autoReady:false});
  try{
    await f.start();
    const prompt=()=>f.client.receive(`>${parent}\n|html|<button value="/msgroom ${parent},/confirmready">Ready</button>`);
    // An old parent countdown, including one at the same millisecond, is not
    // evidence of time available for the new child readiness prompt.
    f.client.receive(`>${parent}\n|inactive|FixturePlayer has 5 seconds to confirm battle start!`);
    prompt();
    assert.equal(f.session.actions().find(a=>a.kind==='ready').clock.source,'unavailable');
    f.client.receive(`>${parent}\n|inactive|FixturePlayer has 20 seconds to confirm battle start!`);
    const ready=f.session.actions().find(a=>a.kind==='ready');
    assert.equal(ready.clock.deadlineAt,21000);
    const boundary={...f.client.state(parent).readyPrompt};
    f.tick(2000);prompt();
    assert.deepEqual(f.client.state(parent).readyPrompt,boundary);
    assert.equal(f.session.actions().find(a=>a.kind==='ready').clock.deadlineAt,21000);
    f.client.receive(`>${parent}\n|inactiveoff|Timer disabled`);
    assert.equal(f.session.actions().find(a=>a.kind==='ready').clock.source,'server-timer-disabled');
    // Starting the child clears readiness. Its timer-off/countdown must not be
    // inherited by the next identical prompt, even without a clock tick.
    f.request();f.client.receive(`>${room}\n|win|FixturePlayer`);prompt();
    const next=f.session.actions().find(a=>a.kind==='ready');
    assert(next);assert.notEqual(next.token,ready.token);assert.equal(next.clock.source,'unavailable');
    f.client.receive(`>${parent}\n|inactive|Opponent has 30 seconds to confirm battle start!`);
    assert.equal(f.session.actions().find(a=>a.kind==='ready').clock.source,'unavailable');
    f.client.receive(`>${parent}\n|inactive|FixturePlayer has 30 seconds to confirm battle start!`);
    assert.equal(f.session.actions().find(a=>a.kind==='ready').clock.deadlineAt,32000);
  }finally{f.session.dispose();}
});
test('disconnect wakes waits and blocks action reuse',async()=>{
  const f=fixture();await f.start();f.request();const action=f.session.snapshot().actions[0];
  const pending=f.session.wait({afterRevision:f.session.revision,timeoutMs:1000});f.client.ws.close();
  assert((await pending).stopped);assert.equal(f.session.snapshot().actions.length,0);
  assert.equal((await f.session.execute({id:'x',op:'choose',confirmed:true,token:action.token,actions:[]})).ok,false);f.session.dispose();
});
test('clock follows equal-timestamp timer receipt order through a trusted alias merge',async()=>{
  const privateRoom=`${room}-fixturetimerpw`;
  for(const latest of ['inactive','inactiveoff']){
    const f=fixture({autoReady:false});
    try{
      await f.start();f.request();
      const countdown='|inactive|Time left: 30 sec this turn | 300 sec total',off='|inactiveoff|Battle timer is now OFF.';
      f.client.receive(`>${privateRoom}\n${latest==='inactive'?off:countdown}`);
      f.client.receive(`>${room}\n${latest==='inactive'?countdown:off}`);
      f.client.receive(`>${room}\n|noinit|rename|${privateRoom}|Private battle`);
      const clock=f.session.snapshot().rooms.find(entry=>entry.id===privateRoom).clock;
      assert.equal(clock.source,latest==='inactive'?'server-timer-observation':'server-timer-disabled');
      assert.equal(clock.deadlineAt,latest==='inactive'?31000:null);
      assert.equal(clock.bankDeadlineAt,latest==='inactive'?301000:null);
    }finally{f.session.dispose();}
  }
});

test('clock keeps timestamp fallback for timer observations without receipt metadata',()=>{
  const f=fixture({autoReady:false});
  try{
    const state={receivedAt:1000,timers:[{at:1000,type:'inactiveoff',text:'Timer off'},{at:1001,type:'inactive',text:'Time left: 30 sec this turn'}]};
    assert.equal(f.session.clock(state,'turn').source,'server-timer-observation');
    state.timers[0].at=1001;
    assert.equal(f.session.clock(state,'turn').source,'server-timer-disabled');
  }finally{f.session.dispose();}
});

test('one authorized parent grants no control or readiness to unrelated battles',async()=>{
  const f=fixture();await f.start();f.request();
  const other='battle-gen9ou-99',another='game-bestof3-gen9championsvgc2026regmcbo3-99';
  f.client.receive(`>${other}\n|request|${JSON.stringify({rqid:1,teamPreview:true,side:{name:'FixturePlayer',id:'p2',pokemon:[]}})}`);
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'owned',[another]:'unrelated',[other]:'unrelated'}})}`);
  f.client.receive(`>${another}\n|html|<button value="/msgroom ${another},/confirmready">Ready</button>`);
  const snapshot=f.session.snapshot();assert.equal(snapshot.actions.length,1);assert.equal(snapshot.actions[0].room,room);
  assert(!snapshot.rooms.some(entry=>entry.id===other || entry.id===another));assert(!f.sent.some(line=>line.includes('/confirmready')));f.session.dispose();
});
test('a uniquely acquired private parent is joined once and its linked preview becomes actionable',async()=>{
  const f=fixture({autoReady:false});
  const privateParent='game-bestof3-gen9championsvgc2026regmcbo3-42-fixtureprivatepw';
  const privateChild='battle-gen9championsvgc2026regmcbo3-43-fixturechildpw';
  assert((await f.session.execute({id:'private-start',op:'start',confirmed:true})).ok);
  // The request can arrive before parent history; it alone must not grant scope.
  f.client.receive(`>${privateChild}\n|request|${JSON.stringify({rqid:5,teamPreview:true,side:{id:'p2',name:'FixturePlayer',pokemon:[]}})}`);
  assert.equal(f.session.snapshot().actions.length,0);
  const searchUpdate=`|updatesearch|${JSON.stringify({searching:[],games:{[privateParent]:'FixturePlayer vs Opponent',[privateChild]:'FixturePlayer vs Opponent'}})}`;
  f.client.receive(searchUpdate);f.client.receive(searchUpdate);f.session.snapshot();
  assert.deepEqual(f.sent.filter(line=>line.startsWith('|/join ')),[`|/join ${privateParent}`]);
  assert.equal(f.session.snapshot().actions.length,0);
  f.client.receive(`>${privateParent}\n|uhtml|game1|<a href="/${privateChild}">Game 1</a>`);
  const action=f.session.snapshot().actions[0];
  assert.equal(action.room,privateChild);assert.equal(action.kind,'preview');
  assert.equal(f.session.roomParents.get(privateChild),privateParent);
  assert.equal(f.sent.filter(line=>line.includes('/search ')).length,1);f.session.dispose();
});
test('an acquired public parent follows a trusted private rename with racing history, preview and search updates',async()=>{
  for(const updateBeforeRename of [false,true]){
    const f=fixture({autoReady:false});await f.start();f.request();
    const oldToken=f.session.snapshot().actions[0].token;
    const privateParent=`${parent}-fixtureparentpw`,privateChild='battle-gen9championsvgc2026regmcbo3-8-fixturechildpw';
    const update=`|updatesearch|${JSON.stringify({searching:[],games:{[privateParent]:'FixturePlayer vs Opponent',[privateChild]:'FixturePlayer vs Opponent'}})}`;
    f.client.receive(`>${privateParent}\n|uhtml|game1|<a href="/${privateChild}">Game 1</a>`);
    f.client.receive(`>${privateChild}\n|request|${JSON.stringify({rqid:5,teamPreview:true,side:{id:'p2',name:'FixturePlayer',pokemon:[]}})}`);
    assert(!f.session.snapshot().actions.some(action=>action.room===privateChild));
    if(updateBeforeRename)f.client.receive(update);
    f.client.receive(`>${parent}\n|noinit|rename|${privateParent}|Private best of three`);
    if(!updateBeforeRename)f.client.receive(update);
    const state=f.session.snapshot();
    assert(f.session.ownedParents.has(privateParent));assert(!f.session.ownedParents.has(parent));
    assert.equal(f.session.roomParents.get(privateChild),privateParent);
    assert(state.actions.some(action=>action.room===privateChild && action.kind==='preview'));
    assert(state.rooms.some(entry=>entry.id===privateParent && entry.children.includes(privateChild)));
    assert.deepEqual(Object.keys(state.search.games).sort(),[privateParent,privateChild].sort());
    assert.equal((await f.session.execute({id:'stale-parent-token',op:'choose',confirmed:true,token:oldToken,actions:[]})).ok,false);
    // The server moves existing connections; a rename does not trigger a second join.
    assert.deepEqual(f.sent.filter(line=>line.startsWith('|/join ')),[`|/join ${parent}`]);
    f.client.receive(`>${privateParent}\n|noinit|rename|${parent}|Public best of three`);
    assert(f.session.ownedParents.has(parent));assert.equal(f.session.roomParents.get(privateChild),parent);
    f.session.dispose();
  }
});
test('renamed child tokens expire and already sent choices never become actionable again',async()=>{
  const f=fixture({autoReady:false});await f.start();f.request();
  const old=f.session.snapshot().actions[0],privateChild=`${room}-fixturechildpw`;
  f.client.receive(`>${room}\n|noinit|rename|${privateChild}|Private battle`);
  const current=f.session.snapshot().actions[0];assert.equal(current.room,privateChild);assert.notEqual(current.token,old.token);
  const command={op:'choose',confirmed:true,actions:[{type:'move',slot:1},{type:'move',slot:1}]};
  assert.equal((await f.session.execute({id:'old-token',...command,token:old.token})).ok,false);
  assert((await f.session.execute({id:'current-token',...command,token:current.token})).ok);
  f.client.receive(`>${privateChild}\n|noinit|rename|${room}|Public battle`);
  f.request();assert.equal(f.session.snapshot().actions.length,0);
  assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);f.session.dispose();
});
test('parent readiness is not resubmitted after privacy renames or repeated aliased prompts',async()=>{
  const f=fixture();await f.start();const privateParent=`${parent}-fixtureparentpw`;
  const prompt=id=>f.client.receive(`>${room}\n|c|~|/uhtml controls,<button value="/msgroom ${id},/confirmready">Ready</button>`);
  prompt(parent);f.client.receive(`>${parent}\n|noinit|rename|${privateParent}|Private set`);prompt(privateParent);prompt(parent);
  assert.equal(f.sent.filter(line=>line.includes('/confirmready')).length,1);f.session.dispose();
});
test('untrusted aliases and a different numeric or format identity cannot move session ownership',async()=>{
  const f=fixture({autoReady:false});await f.start();f.request();const before=f.session.snapshot().actions[0];
  for(const target of ['game-bestof3-gen9championsvgc2026regmcbo3-99-privatepw','game-bestof3-gen9ou-7-privatepw'])f.client.receive(`>${parent}\n|noinit|rename|${target}|Unrelated`);
  f.client.receive(`>${parent}\n|c|Opponent|noinit|rename|${parent}-fakepw|Fake`);
  assert.deepEqual([...f.session.ownedParents],[parent]);assert.equal(f.session.snapshot().actions[0].token,before.token);f.session.dispose();
});
test('parent observation never joins ambiguous/unrelated sets and recovers acquired unjoined parents',async()=>{
  const f=fixture({autoReady:false});
  await f.session.execute({id:'ambiguous-start',op:'start',confirmed:true});
  const other='game-bestof3-gen9championsvgc2026regmcbo3-99-unrelatedpw';
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'first',[other]:'second','battle-gen9ou-3':'unrelated'}})}`);
  assert.equal(f.sent.filter(line=>line.startsWith('|/join ')).length,0);
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'unique'}})}`);
  assert.deepEqual(f.sent.filter(line=>line.startsWith('|/join ')),[`|/join ${parent}`]);
  // Model a prior implementation that acquired the parent without observing it.
  f.client.sent.delete(`join:${f.client.epoch}:${parent}`);f.sent.length=0;
  f.session.captureRooms();f.session.captureRooms();
  assert.deepEqual(f.sent,[`|/join ${parent}`]);
  f.client.state(parent).ended=true;f.client.sent.delete(`join:${f.client.epoch}:${parent}`);f.sent.length=0;
  f.session.captureRooms();assert.equal(f.sent.length,0);f.session.dispose();
});
test('incidental called moves do not count as the submitted choice; cant is not execution',async()=>{
  const f=fixture();await f.start();f.request();const action=f.session.snapshot().actions[0];
  await f.session.execute({id:'protect',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]});
  f.client.receive(`>${room}\n|move|p2a: A|Quiver Dance|p2a: A|[from] ability: Dancer\n|move|p2a: A|Protect|p2a: A|[from] move: Instruct`);
  assert.equal(f.client.state(room).lastAction.evidence.length,0);
  f.client.receive(`>${room}\n|cant|p2a: A|frz|Protect`);
  const decision=f.client.state(room).lastAction;assert.equal(decision.status,'resolution-observed');assert.equal(decision.evidence[0].executed,false);f.session.dispose();
});
test('parent-set completion invalidates child choices even before the child result arrives',async()=>{
  const f=fixture();await f.start();f.request();const action=f.session.snapshot().actions[0];
  f.client.receive(`>${parent}\n|win|FixturePlayer`);
  assert.equal(f.session.snapshot().actions.length,0);
  assert.equal((await f.session.execute({id:'after-set',op:'choose',confirmed:true,token:action.token,actions:[]})).ok,false);f.session.dispose();
});

test('owned server-error diagnostics retain safe typed reasons and observed terminal context without inferring acceptance',async()=>{
  const f=fixture({autoReady:false});try{
    await f.start();f.request();const action=f.session.snapshot().actions[0];
    await f.session.execute({id:'diagnostic-pair',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]});
    f.client.receive(`>${room}\n|error|[Invalid choice] Sorry, too late to make a different move; the next turn has already started`);
    let trace=f.session.controlTrace.filter(value=>value.type==='server-error').at(-1);
    assert.equal(trace.serverErrorCategory,'invalid-choice');assert.equal(trace.serverErrorReason,'too-late');
    assert.equal(trace.stateEndedAtError,false);assert.equal(trace.requestPresentAtError,true);assert.equal(trace.serverErrorTextRetained,false);
    assert(f.session.controlTrace.some(value=>value.type==='rejected'));
    f.client.receive(`>${room}\n|win|FixturePlayer\n|error|[Invalid choice] Can't do anything: The game is over`);
    trace=f.session.controlTrace.filter(value=>value.type==='server-error').at(-1);
    assert.equal(trace.serverErrorReason,'game-over');assert.equal(trace.stateEndedAtError,true);assert.equal(trace.requestPresentAtError,false);
    assert.equal(f.client.state(room).result.type,'win');assert.equal(trace.accepted,undefined);assert.equal(trace.executed,undefined);
    f.client.receive(`>${room}\n|error|Unexpected unclassified fixture server response`);
    trace=f.session.controlTrace.filter(value=>value.type==='server-error').at(-1);
    assert.equal(trace.serverErrorCategory,'unclassified');assert.equal(trace.serverErrorReason,'unclassified');assert.equal(trace.stateEndedAtError,true);
    assert.equal(f.session.capabilities().features.ownedBattleServerErrorDiagnostics,true);
  }finally{f.session.dispose();}
});

test('owned server-error diagnostics exclude global login chat foreign and parent rooms and never retain raw secrets',async()=>{
  const f=fixture({autoReady:false});try{
    await f.start();f.request();
    const count=()=>f.session.controlTrace.filter(value=>value.type==='server-error').length,before=count();
    f.client.receive('|error|[Invalid choice] Global diagnostic must stay a notice');
    f.client.receive('>battle-gen9championsvgc2026regmcbo3-999\n|error|[Invalid choice] Foreign fixture');
    f.client.receive(`>${parent}\n|error|[Invalid choice] Parent fixture`);
    f.client.receive(`>${room}\n|c|Opponent|[Invalid choice] Chat fixture`);
    f.client.authenticated=false;f.client.emit('server-error',{room,text:'[Invalid choice] Login fixture'});f.client.authenticated=true;
    assert.equal(count(),before);
    for(const entry of [{type:'server-error'},{type:'server-error',room:false},{type:'server-error',room:parent}])assert.equal(f.session.recordControlTrace(entry),null);
    const lease=f.session.controller.claim({controllerId:'fixture-diagnostic'}).controllerLease;
    const secrets=[f.session.id,lease,'fixture-private-receipt','fixture-credential-value','fixture-privateaccesspw'];
    for(const text of [
      '[Invalid choice] password='+secrets.join(' ')+' https://example.test/'+secrets.at(-1),
      `[Unavailable choice] Can't move: ${secrets[0]}'s ${secrets[1]} is disabled`,
      '[Unavailable choice] '+String.fromCharCode(27)+'[31m'+secrets.join(' ')+'<script>foreign</script>',
      '[Invalid choice] '+secrets.join(' ')+'x'.repeat(10000),
    ])f.client.emit('server-error',{room,text,controllerLease:lease,readReceipt:secrets[2],sessionId:secrets[0]});
    const entries=f.session.controlTrace.filter(value=>value.type==='server-error'),serialized=JSON.stringify(entries);
    assert.equal(entries.length,before+4);assert(entries.every(value=>value.serverErrorTextRetained===false));
    assert.equal(entries[1].serverErrorReason,'move-disabled');assert.equal(entries.at(-1).serverErrorReason,'unclassified');
    for(const secret of [...secrets,'https:','<script>','password=','\u001b'])assert.equal(serialized.includes(secret),false);
    assert(entries.every(value=>['invalid-choice','unavailable-choice','unclassified'].includes(value.serverErrorCategory)));
    const forged=f.session.recordControlTrace({type:'server-error',room,serverErrorCategory:lease,serverErrorReason:secrets[2],serverErrorTextRetained:true,text:secrets[3]});
    assert.equal(forged.serverErrorCategory,undefined);assert.equal(forged.serverErrorReason,undefined);assert.notEqual(forged.serverErrorTextRetained,true);
  }finally{f.session.dispose();}
});

test('owned server-error diagnostics survive actual recorder retention and read-only MCP retrieval after disposable source cleanup',async t=>{
  const {mkdtemp,mkdir,writeFile,unlink,rm}=await import('node:fs/promises');
  const {join,resolve,dirname,basename}=await import('node:path');
  const {tmpdir}=await import('node:os');
  const {attachMetricsRecorder}=await import('../metrics/recorder.mjs');
  const {registerMetricsTools}=await import('../metrics/mcp-tools.mjs');
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-owned-error-')),f=fixture({autoReady:false});let recorder;
  try{
    recorder=attachMetricsRecorder(f.client,{workspace,username:f.session.username,teamId:f.client.expectedTeamHash,
      team:[{species:'Politoed',moves:['Protect']},{species:'Kommo-o',moves:['Protect']}],session:f.session});
    f.session.attachMetricsRecorder(recorder);await f.start();
    f.client.receive(`>${room}\n|gametype|doubles\n|player|p1|Opponent\n|player|p2|FixturePlayer\n|start\n|switch|p2a: A|Politoed, L50|100/100\n|switch|p2b: B|Kommo-o, L50|100/100\n|turn|1`);f.request();
    f.client.receive(`>${room}\n|error|[Unavailable choice] Can't switch: The active Pokémon is trapped`);
    f.client.receive(`>${room}\n|win|FixturePlayer\n|error|[Invalid choice] Can't do anything: The game is over`);
    f.client.emit('server-error',{room,text:'[Invalid choice] credential=fixture-roundtrip-secret https://example.test/fixture-accesspw'});
    const receipt=f.session.controlTrace.filter(value=>value.type==='server-error');assert.equal(receipt.length,3);
    await mkdir(join(workspace,'cache'),{recursive:true});const source=join(workspace,'cache','disposable-owned-error.jsonl');
    await writeFile(source,receipt.map(value=>JSON.stringify({event:'control-trace',...value})).join('\n')+'\n');
    const flushed=await recorder.flush({savePending:true});assert.equal(flushed.state,'ready',JSON.stringify(flushed.lastError));await recorder.close();recorder=null;
    f.session.dispose();f.session.controlTrace.length=0;f.client.rooms.clear();await unlink(source);
    const registrations=new Map();let liveCalls=0;
    registerMetricsTools({registerTool(name,settings,handler){registrations.set(name,{settings,handler});}},{workspace,call:async()=>{liveCalls++;throw Error('Saved evidence must not call a live session');}});
    const registered=registrations.get('team_metrics_game_evidence');assert.equal(registered.settings.annotations.readOnlyHint,true);
    const result=await registered.handler({teamId:f.client.expectedTeamHash,roomId:room});assert.notEqual(result.isError,true);
    const evidence=JSON.parse(result.content[0].text),errors=evidence.controlTrace.filter(value=>value.type==='server-error');
    assert.deepEqual(errors.map(value=>value.serverErrorReason),['trapped','game-over','unclassified']);
    assert.deepEqual(errors.map(value=>value.stateEndedAtError),[false,true,true]);assert.equal(evidence.complete,true);assert.equal(evidence.sourceKind,'sanitized-events');
    assert(errors.every(value=>value.serverErrorTextRetained===false));assert.equal(JSON.stringify(evidence).includes('NEVER-RETAIN'),false);assert.equal(liveCalls,0);
    for(const secret of ['fixture-roundtrip-secret','fixture-accesspw',f.session.id])assert.equal(JSON.stringify(evidence).includes(secret),false);
    assert.equal(evidence.events.filter(value=>value.type==='win').length,1);
    t.diagnostic(JSON.stringify({kind:'owned-error-retained-MCP-roundtrip',sourceDeleted:true,memoryCleared:true,liveCalls,
      complete:evidence.complete,sourceKind:evidence.sourceKind,errors:errors.map(value=>({category:value.serverErrorCategory,reason:value.serverErrorReason,
        stateEndedAtError:value.stateEndedAtError,requestPresentAtError:value.requestPresentAtError,textRetained:value.serverErrorTextRetained})),
      officialWinCount:evidence.events.filter(value=>value.type==='win').length,privateTextAbsent:true,limitation:'Synthetic in-process fixture only; no original S5 error reason is recovered.'}));
  }finally{
    await recorder?.close();f.session.dispose();assert.equal(dirname(resolve(workspace)),resolve(tmpdir()));assert.match(basename(workspace),/^vgcm-owned-error-/u);
    await rm(workspace,{recursive:true,force:true});
  }
});
test('confirmed whole-BO3 forfeit needs no turn token, suppresses actions/readiness and awaits official completion',async()=>{
  const f=fixture({authorizedSets:2});await f.start();f.request();const action=f.session.snapshot().actions[0];
  const command={id:'forfeit-once',op:'forfeit',confirmed:true,room:parent};
  assert.equal((await f.session.execute({...command,id:'unconfirmed',confirmed:false})).ok,false);
  const revision=f.session.revision,waiting=f.session.wait({afterRevision:revision,timeoutMs:1000});
  const reply=await f.session.execute(command);assert.deepEqual(reply.result,{room:parent,status:'sent-not-acknowledged'});
  assert((await waiting).revision>revision);assert.deepEqual(await f.session.execute(command),reply);
  assert.equal((await f.session.execute({...command,id:'duplicate-forfeit'})).ok,false);
  assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,1);
  assert.equal(f.client.connected,true);assert.equal(f.client.authenticated,true);
  assert.equal(f.session.snapshot().actions.length,0);
  assert.equal((await f.session.execute({id:'stale-after-forfeit',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]})).ok,false);
  f.request({rqid:2});f.client.receive(`>${room}\n|html|<button value="/msgroom ${parent},/confirmready">Ready</button>`);
  assert.equal(f.session.snapshot().actions.length,0);assert.equal(f.sent.filter(line=>line.includes('/confirmready')).length,0);
  f.client.receive(`>${room}\n|win|Opponent`);let state=f.session.snapshot();
  assert.equal(state.rooms.find(r=>r.id===parent).ended,false);assert.equal(state.search.games[parent],'FixturePlayer vs Opponent');
  f.client.receive(`>${parent}\n|win|Opponent`);f.client.receive('|updatesearch|{"searching":[],"games":null}');
  state=f.session.snapshot();assert.equal(state.rooms.find(r=>r.id===parent).result.winner,'Opponent');assert.equal(state.search.games,null);
  assert.equal(state.authenticated,true);assert.equal(f.sent.filter(line=>line.includes('/search ')).length,1);
  assert((await f.session.execute({id:'explicit-after-forfeit',op:'start',confirmed:true})).ok);
  assert.equal(f.sent.filter(line=>line.includes('/search ')).length,2);f.session.dispose();
});
test('forfeit rejects unowned, child, ended, inactive, disconnected and untrusted-alias targets',async()=>{
  const f=fixture({autoReady:false}),other='game-bestof3-gen9championsvgc2026regmcbo3-99';let id=0;
  const attempt=(target=parent,extra={})=>f.session.execute({id:'forfeit-guard-'+(++id),op:'forfeit',confirmed:true,room:target,...extra});
  assert.match((await attempt()).error,/not owned/);await f.start();
  assert.match((await attempt(room)).error,/parent room/);
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'owned',[other]:'unrelated'}})}`);
  assert.match((await attempt(other)).error,/not owned/);
  f.client.receive(`>${parent}\n|c|Opponent|noinit|rename|${parent}-fakepw|Fake`);
  assert.match((await attempt(`${parent}-fakepw`)).error,/not owned/);
  f.client.state(parent).ended=true;assert.match((await attempt()).error,/not live/);f.client.state(parent).ended=false;
  f.client.receive('|updatesearch|{"searching":[],"games":null}');assert.match((await attempt()).error,/not live/);
  f.client.ws.close();assert.match((await attempt()).error,/disconnected/);
  assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);f.session.dispose();
});

test('enable timer uses the current owned child while active or waiting and never emits battle choices',async()=>{
  for(const waiting of [false,true]){
    const f=fixture({autoReady:false});
    try{
      await f.start();f.request(waiting?{wait:true}:{});
      const before=f.sent.length,command={id:'enable-owned-timer',op:'set-timer',room,confirmed:true};
      const result=await f.session.execute(command);
      assert.equal(result.ok,true,result.error);assert.equal(result.result.status,'sent-not-acknowledged');
      assert.equal(result.result.serverObservation,null);
      assert.deepEqual(f.sent.slice(before),[`${room}|/timer on`]);
      assert.deepEqual(await f.session.execute(command),result);
      assert.equal((await f.session.execute({...command,id:'different-timer-request'})).ok,false);
      assert.match((await f.session.execute({...command,room:parent})).error,/different arguments/);
      assert.equal(f.session.searchesSent,1);assert.equal(f.session.authorizedSets,1);
      assert(f.session.capabilities().operations.includes('set-timer'));assert.equal(f.session.capabilities().features.ownedBattleTimer,true);
      f.client.receive(`>${room}\n|inactive|Battle timer is ON.`);
      for(const state of [f.session.snapshot().rooms.find(r=>r.id===room),f.session.turnSnapshot().boards.find(r=>r.room===room)]){
        assert.equal(state.timer.request.status,'sent-not-acknowledged');
        assert.equal(state.timer.serverObservation.type,'inactive');assert.equal(state.timer.serverObservation.afterRequest,true);
      }
    }finally{f.session.dispose();}
  }
});

test('timer operation rejects unowned, unlinked, stale, ambiguous, ended, inactive and disconnected targets',async()=>{
  const f=fixture({autoReady:false}),other='battle-gen9championsvgc2026regmcbo3-99';let id=0;
  const attempt=(target=room,extra={})=>f.session.execute({id:'timer-guard-'+(++id),op:'set-timer',confirmed:true,room:target,...extra});
  try{
    assert.match((await attempt()).error,/not linked/);await f.start();f.request();
    assert.match((await attempt(parent)).error,/child battle room/);
    assert.match((await attempt(other)).error,/not linked/);assert(!f.client.rooms.has(other));
    assert.match((await attempt(room,{confirmed:false})).error,/confirmation/);
    assert.match((await attempt(room,{enabled:false})).error,/Only enabling/);
    f.client.receive(`>${room}\n|c|Opponent|noinit|rename|${room}-fakepw|Fake`);
    assert.match((await attempt(`${room}-fakepw`)).error,/not linked/);
    f.client.state(parent).children=[];assert.match((await attempt()).error,/not linked/);f.client.state(parent).children=[room];
    f.client.state(room).epoch=0;assert.match((await attempt()).error,/current live/);f.client.state(room).epoch=1;
    f.request({side:{name:'AnotherPlayer'}});assert.match((await attempt()).error,/another player/);f.request();
    f.client.receive(`>${parent}\n|uhtml|game2|<a href="/${other}">Game 2</a>`);
    f.client.receive(`>${other}\n|request|${JSON.stringify({wait:true})}`);
    assert.match((await attempt()).error,/unambiguous/);f.client.state(other).ended=true;
    f.client.state(room).ended=true;assert.match((await attempt()).error,/current live/);f.client.state(room).ended=false;
    f.client.state(parent).ended=true;assert.match((await attempt()).error,/not live/);f.client.state(parent).ended=false;
    f.client.receive('|updatesearch|{"searching":[],"games":null}');assert.match((await attempt()).error,/not live/);
    f.client.ws.close();assert.match((await attempt()).error,/disconnected/);
    assert.equal(f.sent.filter(line=>line.includes('/timer')).length,0);
  }finally{f.session.dispose();}
});

test('timer requires the current lease and preserves staged fallback, safety halt and search allowance',async()=>{
  const f=fixture({autoReady:false,controlTimers:{setTimer:()=>1,clearTimer:()=>{}}});
  try{
    await f.start();f.request();
    const claim=await f.session.execute({id:'claim-for-timer',op:'control-claim',confirmed:true,controllerId:'timer-fixture'});
    const controllerLease=claim.result.controllerLease;
    f.session.supervisor.configure({enabled:true});
    f.session.supervisor.stage(f.session.actions()[0].token,[{type:'move',slot:1},{type:'move',slot:1}]);
    f.session.supervisor.halt('fixture-safety-halt');
    const before=f.session.supervisor.status(),sent=f.sent.length;
    const command={id:'leased-timer',op:'set-timer',confirmed:true,room,controllerLease};
    assert.match((await f.session.execute({...command,id:'missing-timer-lease',controllerLease:undefined})).error,/controller lease/);
    assert.equal((await f.session.execute(command)).ok,true);
    assert.deepEqual(f.session.supervisor.status(),before);assert.deepEqual(f.sent.slice(sent),[`${room}|/timer on`]);
    assert.equal(f.session.searchesSent,1);assert.equal(f.session.authorizedSets,1);
    await f.session.execute({id:'takeover-timer',op:'control-claim',confirmed:true,controllerId:'new-controller',takeover:true,expectedGeneration:1});
    assert.match((await f.session.execute(command)).error,/controller lease/);
  }finally{f.session.dispose();}
});

test('trusted timer aliases and uncertain sends stay reserved without suppressing owned choices',async()=>{
  const f=fixture({autoReady:false}),privateChild=`${room}-fixturetimerpw`;
  try{
    await f.start();f.request();
    f.client.receive(`>${room}\n|noinit|rename|${privateChild}|Private battle`);
    const write=f.client.ws.send;f.client.ws.send=line=>{write(line);if(line.endsWith('|/timer on'))throw new Error('Synthetic uncertain timer write');};
    const command={id:'uncertain-owned-timer',op:'set-timer',confirmed:true,room};
    const result=await f.session.execute(command);assert.equal(result.ok,false);
    assert.deepEqual(await f.session.execute(command),result);
    assert.equal(f.session.snapshot().rooms.find(r=>r.id===privateChild).timer.request.status,'send-uncertain');
    assert.equal(f.session.actions().length,1);
    f.client.receive(`>${privateChild}\n|noinit|rename|${room}|Public battle`);
    assert.match((await f.session.execute({...command,id:'timer-no-retry',room:privateChild})).error,/Duplicate or uncertain/);
    assert.deepEqual(f.sent.filter(line=>line.includes('/timer')),[`${privateChild}|/timer on`]);
    const forfeited=await f.session.execute({id:'forfeit-after-timer',op:'forfeit',confirmed:true,room:parent});assert.equal(forfeited.ok,true);
    assert.match((await f.session.execute({...command,id:'timer-after-forfeit'})).error,/BO3 forfeit/);
  }finally{f.session.dispose();}
});
test('forfeit follows only trusted owned parent aliases and stays reserved through rename or uncertain I/O',async()=>{
  const f=fixture({autoReady:false});await f.start();f.request();const privateParent=`${parent}-fixtureparentpw`;
  f.client.receive(`>${parent}\n|noinit|rename|${privateParent}|Private set`);
  const reply=await f.session.execute({id:'trusted-alias-forfeit',op:'forfeit',room:parent,confirmed:true});
  assert.equal(reply.result.room,privateParent);assert(f.sent.includes(`${privateParent}|/forfeit`));
  f.client.receive(`>${privateParent}\n|noinit|rename|${parent}|Public set`);
  assert.equal(f.session.snapshot().actions.length,0);
  assert.equal((await f.session.execute({id:'after-forfeit-rename',op:'forfeit',room:privateParent,confirmed:true})).ok,false);
  assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,1);f.session.dispose();
  const uncertain=fixture();await uncertain.start();uncertain.request();
  const send=uncertain.client.ws.send;uncertain.client.ws.send=line=>{send(line);if(line.endsWith('|/forfeit'))throw new Error('Synthetic uncertain socket write');};
  assert.equal((await uncertain.session.execute({id:'uncertain-forfeit',op:'forfeit',room:parent,confirmed:true})).ok,false);
  assert.equal(uncertain.client.state(parent).forfeitPending.status,'sent-not-acknowledged');assert.equal(uncertain.session.snapshot().actions.length,0);
  uncertain.client.receive(`>${room}\n|html|<button value="/msgroom ${parent},/confirmready">Ready</button>`);
  assert.equal(uncertain.sent.filter(line=>line.includes('/confirmready')).length,0);
  assert.equal((await uncertain.session.execute({id:'never-retry-forfeit',op:'forfeit',room:parent,confirmed:true})).ok,false);
  assert.equal(uncertain.sent.filter(line=>line.includes('/forfeit')).length,1);assert.equal(uncertain.client.connected,true);uncertain.session.dispose();
});
test('a match racing cancellation remains controllable after a transient idle update',async()=>{
  const f=fixture();assert((await f.session.execute({id:'search',op:'start',confirmed:true})).ok);
  f.client.receive('|updatesearch|{"searching":["gen9championsvgc2026regmcbo3"],"games":null}');
  assert((await f.session.execute({id:'cancel',op:'cancel-search',confirmed:true})).ok);
  assert(f.sent.some(line=>line==='|/cancelsearch gen9championsvgc2026regmcbo3'));
  f.client.receive('|updatesearch|{"searching":[],"games":null}');assert.equal(f.session.snapshot().cancellation.status,'idle-observed');
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'FixturePlayer vs Opponent'}})}`);
  f.client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);f.request();
  const snapshot=f.session.snapshot();assert.equal(snapshot.actions[0].room,room);assert.equal(snapshot.cancellation.status,'match-observed');f.session.dispose();
});

const completedLog=(winner='FixturePlayer')=>'|player|p1|Opponent\n|player|p2|FixturePlayer\n|gametype|doubles\n|tier|[Gen 9] Champions VGC 2026 Reg M-C (Bo3)\n|start\n|turn|2\n|win|'+winner;
const finishSet=f=>{f.client.receive(`>${room}\n${completedLog()}\n>${parent}\n|win|FixturePlayer`);f.client.receive('|updatesearch|{"searching":[],"games":null}');};
const replayJSON=(id,log=completedLog())=>new Response(JSON.stringify({id,formatid:'gen9championsvgc2026regmcbo3',log}),{headers:{'content-type':'application/json'}});

test('completed owned BO3 saves sequential child replays once, verifies full identities and keeps login',async()=>{
  const downloads=[],f=fixture({authorizedSets:2,replayFetchImpl:async(url,options)=>{downloads.push({url,options});return replayJSON(new URL(url).pathname.slice(1).replace(/\.json$/,'').replace(/-accesspw$/,''));}});
  await f.start();
  const second='battle-gen9championsvgc2026regmcbo3-8-accesspw',third='battle-gen9championsvgc2026regmcbo3-9';
  f.client.receive(`>${parent}\n|uhtml|game|<a href="/${second}">Game 2</a><a href="/${third}">Game 3</a>`);
  for(const child of [second,third])f.client.receive(`>${child}\n${completedLog()}`);
  finishSet(f);
  const verified=[];f.client.on('replay-verified',event=>verified.push(event));
  const send=f.client.ws.send;f.client.ws.send=line=>{send(line);if(line.endsWith('|/savereplay'))queueMicrotask(()=>f.client.receive(`|popup||html|<a href="https://replay.pokemonshowdown.com/${line.split('|')[0].slice(7)}">Replay</a>`));};
  const command={id:'save-completed-set',op:'save-replays',confirmed:true,room:parent},reply=await f.session.execute(command);
  assert.equal(reply.ok,true);assert.equal(reply.result.complete,true);assert.equal(reply.result.parentId,parent);assert.equal(reply.result.replays.length,3);assert.deepEqual(reply.result.failures,[]);
  assert.equal(reply.result.replays[1].url,`https://replay.pokemonshowdown.com/${second.slice(7)}`);assert(reply.result.replays.every(record=>record.verified && record.verifiedAt));
  assert.equal(verified.length,3);assert.equal(downloads.length,3);assert(downloads.every(({options})=>options.method==='GET' && options.redirect==='error' && options.credentials==='omit'));
  assert.deepEqual(await f.session.execute(command),reply);assert.deepEqual((await f.session.execute({...command,id:'verify-existing-set'})).result,reply.result);
  assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,3);assert.equal(downloads.length,3);
  assert.equal(f.sent.filter(line=>line.includes('/search ')).length,1);assert(f.client.authenticated && f.client.connected);f.session.dispose();
});

test('save replay guards require confirmation, owned official completed parent and authoritative idle',async()=>{
  const f=fixture();let id=0;const attempt=(target=parent,extra={})=>f.session.execute({id:'save-guard-'+(++id),op:'save-replays',confirmed:true,room:target,...extra});
  assert.match((await attempt()).error,/not owned/);await f.start();
  assert.match((await attempt(room)).error,/parent room/);assert.match((await attempt(parent,{confirmed:false})).error,/confirmation/);
  assert.match((await attempt()).error,/result is not confirmed/);f.client.receive(`>${parent}\n|win|FixturePlayer`);
  assert.match((await attempt()).error,/idle session/);f.client.receive('|updatesearch|{"searching":[],"games":null}');
  const unfinished=await attempt();assert.equal(unfinished.ok,true);assert.equal(unfinished.result.complete,false);assert.match(unfinished.result.failures[0].error,/no official finished result/);
  assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,0);f.session.dispose();
});

test('late popup after timeout can be verified with a new command without resending an upload',async()=>{
  const f=fixture({replayBudgetMs:25,replayFetchImpl:async()=>replayJSON(room.slice(7))});await f.start();finishSet(f);
  const command={id:'save-timeout',op:'save-replays',confirmed:true,room:parent};
  const failed=await f.session.execute(command);assert.equal(failed.ok,true);assert.equal(failed.result.complete,false);assert.equal(f.client.pendingReplay,null);
  assert.deepEqual(await f.session.execute(command),failed);assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);
  f.client.receive(`|popup|https://replay.pokemonshowdown.com/${room.slice(7)}`);
  const recovered=await f.session.execute({...command,id:'verify-late-response'});assert.equal(recovered.result.complete,true);
  assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);assert.equal(f.client.listenerCount('replay-url'),1);f.session.dispose();
});

test('bounded verification tolerates uncooperative fetch and blocks another search while preserving',async()=>{
  const f=fixture({authorizedSets:2,replayBudgetMs:40,replayFetchImpl:()=>new Promise(()=>{})});await f.start();finishSet(f);
  const send=f.client.ws.send;f.client.ws.send=line=>{send(line);if(line.endsWith('|/savereplay'))queueMicrotask(()=>f.client.receive(`|popup|https://replay.pokemonshowdown.com/${room.slice(7)}`));};
  const started=Date.now(),saving=f.session.execute({id:'save-hanging-fetch',op:'save-replays',confirmed:true,room:parent});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.session.snapshot().savingReplays,true);
  assert.match((await f.session.execute({id:'no-concurrent-search',op:'start',confirmed:true})).error,/replay preservation/);
  const reply=await saving;assert.equal(reply.result.complete,false);assert(Date.now()-started<1000);assert.equal(f.session.snapshot().savingReplays,false);
  assert.equal(f.sent.filter(line=>line.includes('/search ')).length,1);f.session.dispose();
});

test('uncertain socket send stays reserved while remaining finished children can succeed',async()=>{
  const second='battle-gen9championsvgc2026regmcbo3-8',f=fixture({replayFetchImpl:async()=>replayJSON(second.slice(7))});await f.start();
  f.client.receive(`>${parent}\n|uhtml|game|<a href="/${second}">Game 2</a>\n>${second}\n${completedLog()}`);finishSet(f);
  const send=f.client.ws.send;f.client.ws.send=line=>{send(line);if(line===`${room}|/savereplay`)throw new Error('Synthetic uncertain socket write');if(line===`${second}|/savereplay`)queueMicrotask(()=>f.client.receive(`|popup|https://replay.pokemonshowdown.com/${second.slice(7)}`));};
  const reply=await f.session.execute({id:'save-uncertain',op:'save-replays',confirmed:true,room:parent});
  assert.equal(reply.result.complete,false);assert.equal(reply.result.replays[0].roomId,second);assert.equal(reply.result.failures[0].roomId,room);assert.equal(f.client.replayRequests.get(room).status,'send-uncertain');
  assert.equal(f.sent.filter(line=>line===`${room}|/savereplay`).length,1);f.session.dispose();
});
