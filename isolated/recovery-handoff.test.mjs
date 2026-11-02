import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareRecoveryHandoff} from './recovery-handoff.mjs';

const TEAM='a'.repeat(64),TOKEN='b'.repeat(64),SESSION='offline-recovery-session';
const PARENT='game-bestof3-gen9championsvgc2026regmcbo3-781';
const ROOM='battle-gen9championsvgc2026regmcbo3-782';
const IDENTITY={sessionId:SESSION,teamId:TEAM,account:'Fixture'};
const INITIAL=1000000;

function nativeTurn() {
  const sheet=['Corviknight','Rotom-Wash','Salamence','Volcarona','Tyranitar','Gastrodon'].map((species,index)=>({species,item:index===0?'Sitrus Berry':'',ability:'Fixture ability',nature:null,level:50,moves:['Protect','Tackle','Rest','Substitute']}));
  const pokemon=(side,index)=>({id:`${side}-${index}`,species:sheet[index].species,nickname:`Actor ${side} ${index}`,
    activeSlot:index<2?index+1:null,requestIndex:side==='p1'?index+1:null,hp:{current:index?91:137,max:151,precision:'server-own-exact'},
    boosts:{atk:index===0?1:0},status:index===1?'par':null,item:sheet[index].item,itemKnown:true,ability:'Fixture ability',moves:[],volatiles:{}});
  const sides=['p1','p2'].map(id=>({id,active:[{slot:1,pokemon:`${id}-0`},{slot:2,pokemon:`${id}-1`}],reserves:[`${id}-2`,`${id}-3`],pokemon:[0,1,2,3].map(index=>pokemon(id,index)),conditions:{reflect:{turns:2}}}));
  const legalActions={active:[
    {moves:[{move:'Tackle',target:'normal',pp:20},{move:'Protect',target:'self',pp:8},{move:'Tailwind',target:'allySide',pp:10}]},
    {moves:[{move:'Thunderbolt',target:'normal',pp:15},{move:'Will-O-Wisp',target:'normal',pp:15},{move:'Protect',target:'self',pp:8}]},
  ],pokemon:[0,1,2,3].map(index=>({ident:`p1: Actor p1 ${index}`,details:`${sheet[index].species}, L50`,condition:'137/151',active:index<2})),
    replacements:[{slot:3,species:sheet[2].species},{slot:4,species:sheet[3].species}],forceSwitch:null,targetConvention:'Positive 1/2 = opposing slots; negative -1/-2 = own slots.'};
  const clock={source:'server-timer-observation',observedAt:INITIAL-1000,text:'Time left: 42 sec this turn | 180 sec total',deadlineAt:INITIAL+41000,remainingMs:41000,bankDeadlineAt:INITIAL+179000,bankRemainingMs:179000};
  const action={kind:'turn',room:ROOM,parentId:PARENT,rqid:8,revision:11,token:TOKEN,receivedAt:INITIAL-3000,actionable:true,clock,legalActions};
  const pending={room:ROOM,parentId:PARENT,rqid:8,revision:11,token:TOKEN,receivedAt:INITIAL-3000,planningDeadlineAt:INITIAL+17000,cutoffAt:INITIAL+17000,hardDeadlineAt:INITIAL+41000,
    deadlineBasis:'verified-server-turn',state:'planning',hasFallback:false,fallbackSource:null,attempted:false};
  return {sessionId:SESSION,teamId:TEAM,teamSha256:TEAM,username:'Fixture',revision:11,observedAt:INITIAL,connected:true,authenticated:true,stopped:false,autoReady:false,actions:[action],
    controller:{required:true,owner:'Isolated fixture',generation:3,claimedAt:INITIAL-10000},
    controlPolicy:{enabled:true,halted:false,observationFault:false,disposed:false,pending:[pending]},
    timing:{observedAt:INITIAL,requests:[{...pending,requestAgeMs:3000,cutoffRemainingMs:17000,hardRemainingMs:41000,submissionStatus:'unsent'}]},
    boards:[{room:ROOM,parentId:PARENT,turn:4,ownSide:'p1',request:{rqid:8},field:{weather:{id:'sandstorm',turns:3},terrain:null,conditions:{trickroom:{turns:1}}},sides,
      recentEvents:{lines:['|move|p2a: Foe|Protect|p2a: Foe','|turn|4']},opponentSheets:{p2:sheet},actionPlan:{objective:'Preserve a late-game answer',nextTurnCondition:'Observe incoming pressure'}}],
    rooms:[{id:ROOM,parentId:PARENT,teamId:TEAM,ended:false},{id:PARENT,teamId:TEAM,ended:false}],search:{searching:[],games:{[ROOM]:true}},choices:[]};
}

function fixture(change=()=>{}) {
  const state=nativeTurn();change(state);let at=INITIAL;
  const calls=[];
  const operator={async dispatch(command,options){calls.push({command:structuredClone(command),options:structuredClone(options)});return {result:{ok:true,result:structuredClone(state)},elapsedMs:0};}};
  return {state,calls,operator,identity:IDENTITY,parentId:PARENT,now:()=>at,commandId:'offline_recovery',setTime:value=>{at=value;}};
}

test('halted protection preserves same-owner current-parent context without resetting halt or selecting',async()=>{
  const f=fixture(state=>{state.controlPolicy.halted=true;state.controlPolicy.haltReason='emergency-default';}),before=structuredClone(f.state);
  const r=await prepareRecoveryHandoff(f);
  assert.equal(r.disposition,'actionable');assert.equal(r.reason,'exact-current-request');
  assert.deepEqual(r.recoveryScope,{kind:'already-authorized-current-parent-only',parentId:PARENT,haltPreserved:true,futureSearchAuthorized:false,policyReset:false});
  assert.equal(r.nextOperation.template.op,'stage-next');assert.deepEqual(r.nextOperation.template.actions,[]);
  assert.deepEqual(f.state,before);assert.equal(f.calls.length,1);assert.equal(f.calls[0].command.op,'turn');
});

test('halted recovery still preserves send reservations, expired deadlines and unhealthy policy barriers',async()=>{
  const reserved=fixture(state=>{state.controlPolicy.halted=true;state.controlPolicy.pending[0].attempted=true;});
  const r=await prepareRecoveryHandoff(reserved);assert.equal(r.disposition,'wait');assert.equal(r.reason,'submission-reserved');assert.equal(r.nextOperation.template,undefined);
  const expired=fixture(state=>{state.controlPolicy.halted=true;state.controlPolicy.pending[0].cutoffAt=INITIAL;});
  assert.equal((await prepareRecoveryHandoff(expired)).reason,'native-cutoff-expired');
  for(const change of [s=>s.controlPolicy.enabled=false,s=>s.controlPolicy.observationFault=true,s=>s.controlPolicy.disposed=true,s=>s.actions[0].parentId=PARENT+'1']){
    const f=fixture(state=>{state.controlPolicy.halted=true;change(state);}),out=await prepareRecoveryHandoff(f);
    assert.equal(out.disposition,'unavailable');assert.equal(out.response,undefined);assert.equal(f.calls.length,1);
  }
});

test('one native full turn preserves a novel two-active board, sheets, all moves and legal targets without selecting',async()=>{
  const f=fixture(),original=structuredClone(f.state),result=await prepareRecoveryHandoff(f);
  assert.equal(result.disposition,'actionable');assert.equal(result.reason,'exact-current-request');
  assert.deepEqual(f.calls,[{command:{id:'offline_recovery',op:'turn',full:true},options:{inputReceivedAt:INITIAL}}]);
  assert.deepEqual(f.state,original,'reading cannot mutate source state');
  const read=result.response.result.result;
  const {sessionId,...withoutSession}=original;assert.deepEqual(read,withoutSession);
  assert.equal(read.boards[0].sides[0].active.length,2);
  assert.equal(read.actions[0].legalActions.active[0].moves.length,3);
  assert.equal(read.actions[0].legalActions.active[1].moves.length,3);
  assert.equal(read.boards[0].opponentSheets.p2.length,6);
  assert.equal(result.contextCompleteness.opponentSheet,'complete-registered-six');assert.equal(result.contextCompleteness.scope,'control-only');
  assert.equal(read.actions[0].legalActions.targetConvention,original.actions[0].legalActions.targetConvention);
  assert.deepEqual(result.nextOperation.template.actions,[],'template is intentionally unauthored');
  assert.equal(result.actionsSelected,false);assert.equal(result.protection.qualityEstablished,false);
  assert.equal(result.binding.token,TOKEN);assert.equal(result.binding.rqid,8);
  assert.deepEqual(result.expectedRequest,{room:ROOM,rqid:8,token:TOKEN});
  assert.match(result.binding.boardHash,/^[a-f0-9]{64}$/u);assert.match(result.binding.requestDigest,/^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(result).includes(SESSION),false);assert.equal(Object.hasOwn(result.binding,'sessionId'),false);
});

test('compact turn team omission relies explicitly on the same retained armed identity, while every supplied identity must agree',async()=>{
  const f=fixture(state=>{delete state.teamId;delete state.teamSha256;delete state.username;for(const room of state.rooms)delete room.teamId;});
  const result=await prepareRecoveryHandoff(f);assert.equal(result.disposition,'actionable');
  assert.equal(result.identityVerification.team,'retained-same-owner-approved-identity');
  f.state.rooms.push({id:PARENT+'5',teamId:'c'.repeat(64),ended:true,result:{type:'tie'}});
  const history=await prepareRecoveryHandoff(f);assert.equal(history.disposition,'actionable');
  assert.equal(history.response.result.result.rooms.at(-1).teamId,'c'.repeat(64),'ended historical team attribution is retained');
  for(const change of [state=>{state.teamId='c'.repeat(64);},state=>{state.teamSha256='c'.repeat(64);},state=>{state.sessionId='different-session';},
    state=>{state.boards[0].opponentSheetObservation={sessionId:SESSION,teamId:'c'.repeat(64)};},state=>{state.rooms[0].teamId='c'.repeat(64);},state=>{state.username='Other fixture';}]) {
    const bad=fixture(change),reply=await prepareRecoveryHandoff(bad);assert.equal(reply.disposition,'unavailable');assert.equal(reply.response,undefined);assert.equal(bad.calls.length,1);
  }
});

test('missing tactical sheets stay explicit without any additional native fetch or invented facts',async()=>{
  const f=fixture(state=>{state.boards[0].opponentSheets={};});
  const result=await prepareRecoveryHandoff(f);assert.equal(result.disposition,'actionable');assert.equal(f.calls.length,1);
  assert.equal(result.contextCompleteness.opponentSheet,'unknown');assert(result.contextCompleteness.missing.includes('complete registered opposing six'));
  assert.deepEqual(result.response.result.result.boards[0].opponentSheets,{});assert.equal(result.protection.qualityEstablished,false);
});

test('native staged fallback remains distinct from sent, reserved, uncertain and unverified provenance',async()=>{
  const staged=fixture(state=>{Object.assign(state.controlPolicy.pending[0],{hasFallback:true,fallbackSource:'fallback',attempted:false});state.timing.requests[0].hasFallback=true;});
  const result=await prepareRecoveryHandoff(staged);
  assert.equal(result.disposition,'actionable');assert.equal(result.protection.state,'staged');assert.equal(result.protection.sentOrAccepted,false);
  assert.equal(result.nextOperation.template.op,'commit-next');assert.equal(Object.hasOwn(result.nextOperation.template,'actions'),false);
  assert.match(result.nextOperation.cue,/neither tactical quality nor sending/u);
  for(const status of ['sent','reserved','uncertain','accepted','submitting','execution-observed']) {
    const f=fixture(state=>{state.timing.requests[0].submissionStatus=status;});
    const reply=await prepareRecoveryHandoff(f);assert.equal(reply.disposition,'wait',status);assert.equal(reply.reason,'submission-reserved');assert.equal(reply.nextOperation.template,undefined);
    assert.equal(reply.response.result.result.timing.requests[0].submissionStatus,status);
    assert.equal(reply.protection.state,status==='submitting'?'reserved':status);
  }
  const attempted=fixture(state=>{state.controlPolicy.pending[0].attempted=true;});
  assert.equal((await prepareRecoveryHandoff(attempted)).disposition,'wait');
  const unknown=fixture(state=>{state.controlPolicy.pending[0].hasFallback=true;});
  const unverified=await prepareRecoveryHandoff(unknown);assert.equal(unverified.protection.state,'fallback-provenance-unverified');assert.equal(unverified.nextOperation.requiresAuthoring,true);
});

test('timing-only reservations and genuinely empty requests wait without inventing action authority',async()=>{
  for(const status of ['sent','uncertain','reserved']) {
    const f=fixture(state=>{state.actions=[];state.timing.requests[0].submissionStatus=status;state.controlPolicy.pending[0].attempted=true;});
    const result=await prepareRecoveryHandoff(f);assert.equal(result.disposition,'wait');assert.equal(result.binding,undefined);assert.equal(result.nextOperation.template,undefined);
    assert.equal(result.protection.state,status);assert.equal(f.calls.length,1);
  }
  const none=fixture(state=>{state.actions=[];state.timing.requests=[];state.controlPolicy.pending=[];});
  const result=await prepareRecoveryHandoff(none);assert.equal(result.disposition,'wait');assert.equal(result.reason,'no-current-action');
  const duplicated=fixture(state=>{state.actions.push({...structuredClone(state.actions[0]),actionable:false,submissionStatus:'uncertain'});});
  assert.equal((await prepareRecoveryHandoff(duplicated)).disposition,'wait','an action-level reservation cannot be hidden by an actionable duplicate');
});

test('original receivedAt, cutoff and native server clock survive rereading, with conservative matching cutoffs',async()=>{
  const f=fixture(state=>{state.controlPolicy.pending[0].cutoffAt=INITIAL+15000;});
  f.setTime(INITIAL+1000);f.state.observedAt=INITIAL+1000;
  const result=await prepareRecoveryHandoff(f);
  assert.equal(result.timing.receivedAt,INITIAL-3000);assert.equal(result.timing.requestAgeMs,4000);
  assert.equal(result.timing.cutoffAt,INITIAL+15000);assert.equal(result.timing.cutoffRemainingMs,14000);
  assert.equal(result.timing.hardDeadlineAt,INITIAL+41000);assert.equal(result.timing.hardRemainingMs,40000);
  assert.deepEqual(result.timing.clock,f.state.actions[0].clock);assert.equal(result.timing.deadlineBasis,'verified-server-turn');
  assert.deepEqual(result.response.result.result.timing.requests,f.state.timing.requests,'reader does not overwrite native timing');
  const unknown=fixture(state=>{state.actions[0].clock={source:'unavailable',deadlineAt:null,remainingMs:null,bankDeadlineAt:null,bankRemainingMs:null};
    state.timing.requests[0].hardDeadlineAt=null;state.controlPolicy.pending[0].hardDeadlineAt=null;});
  const unavailableClock=await prepareRecoveryHandoff(unknown);assert.equal(unavailableClock.disposition,'actionable');assert.equal(unavailableClock.timing.hardDeadlineAt,null);
});

test('stale timing, expired cutoff, backward clock and late local processing cannot yield a usable stale bundle',async()=>{
  for(const change of [state=>{state.timing.requests[0].token='c'.repeat(64);},state=>{state.controlPolicy.pending[0].revision=10;},
    state=>{state.actions[0].receivedAt=INITIAL+1;},state=>{state.timing.requests[0].receivedAt=INITIAL-4000;},
    state=>{state.observedAt=INITIAL-1;},state=>{state.observedAt=INITIAL+1;},
    state=>{state.controlPolicy.pending[0].cutoffAt=INITIAL;},state=>{state.controlPolicy.pending[0].cutoffAt=INITIAL-4000;},
    state=>{state.controlPolicy.pending[0].hardDeadlineAt=INITIAL;},state=>{state.actions[0].clock.deadlineAt=INITIAL;},
    state=>{state.actions[0].clock.observedAt=INITIAL-4000;}]) {
    const result=await prepareRecoveryHandoff(fixture(change));assert.equal(result.disposition,'unavailable');assert.equal(result.nextOperation?.template,undefined);
  }
  const backward=fixture();let count=0;backward.now=()=>++count===1?INITIAL:INITIAL-1;
  assert.equal((await prepareRecoveryHandoff(backward)).reason,'recovery-clock-invalid');
  const late=fixture();count=0;late.now=()=>++count<3?INITIAL:INITIAL+18000;
  const result=await prepareRecoveryHandoff(late);assert.equal(result.disposition,'unavailable');assert.equal(result.response,undefined);
  const finalExpiry=fixture(state=>{state.controlPolicy.pending[0].cutoffAt=INITIAL+20;});count=0;finalExpiry.now=()=>++count<4?INITIAL:INITIAL+20;
  const expired=await prepareRecoveryHandoff(finalExpiry);assert.equal(expired.reason,'native-cutoff-expired');assert.equal(expired.response,undefined);
});

test('wrong or ambiguous parent, board, action and unhealthy policy fail closed without a second read',async()=>{
  for(const change of [state=>{state.actions[0].parentId=PARENT+'1';},state=>{state.rooms[0].parentId=PARENT+'1';},
    state=>{state.boards[0].parentId=PARENT+'1';},state=>{state.rooms.push(structuredClone(state.rooms[1]));},
    state=>{state.rooms[1].id=PARENT+'1';},state=>{state.actions.push({...structuredClone(state.actions[0]),token:'c'.repeat(64)});},
    state=>{state.boards.push(structuredClone(state.boards[0]));},state=>{state.boards[0].request.rqid=6;},
    state=>{state.rooms[0].ended=true;},state=>{state.connected=false;},state=>{state.authenticated=false;},state=>{state.stopped=true;},
    state=>{state.controlPolicy.enabled=false;},state=>{state.controlPolicy.observationFault=true;},state=>{state.controlPolicy.disposed=true;},
    state=>{state.controller.owner=null;},state=>{state.actions[0].token='not-a-token';},state=>{state.actions[0].kind='unknown';}]) {
    const f=fixture(change),result=await prepareRecoveryHandoff(f);assert.equal(result.disposition,'unavailable');assert.equal(result.response,undefined);assert.equal(f.calls.length,1);
  }
  const badParent=fixture();badParent.parentId=undefined;
  assert.equal((await prepareRecoveryHandoff(badParent)).reason,'affected-parent-unavailable');assert.equal(badParent.calls.length,0);
});

test('canonical affected parent matches native access suffix without rebinding the exact child or request token',async()=>{
  const f=fixture(state=>{state.rooms[1].id=PARENT+'-abc123pw';state.actions[0].parentId=state.rooms[1].id;state.rooms[0].parentId=state.rooms[1].id;state.boards[0].parentId=state.rooms[1].id;});
  f.parentId=PARENT+'-abc123pw';const result=await prepareRecoveryHandoff(f);
  assert.equal(result.disposition,'actionable');assert.equal(result.binding.parentId,PARENT);
  assert.equal(result.binding.room,ROOM);assert.equal(result.binding.token,TOKEN);assert.equal(result.nextOperation.template.token,TOKEN);
});

test('official completed parent requires review only after authoritative idle and never opens another preview',async()=>{
  const completed=fixture(state=>{for(const room of state.rooms)room.ended=true;state.rooms[1].result={type:'win',winner:'Fixture'};state.actions=[];state.search={searching:[],games:null};});
  const result=await prepareRecoveryHandoff(completed);assert.equal(result.disposition,'review-required');assert.equal(result.nextOperation.template,undefined);assert.equal(completed.calls.length,1);
  completed.state.savingReplays=true;assert.equal((await prepareRecoveryHandoff(completed)).disposition,'wait');
  const noResult=fixture(state=>{state.rooms[1].ended=true;});assert.equal((await prepareRecoveryHandoff(noResult)).disposition,'unavailable');
});

test('readiness stays an explicit unauthored same-owner operation and does not fabricate a turn cutoff',async()=>{
  const f=fixture(state=>{state.actions=[{kind:'ready',room:PARENT,token:TOKEN,clock:{source:'unavailable',deadlineAt:null,remainingMs:null}}];state.boards=[];state.controlPolicy.pending=[];state.timing.requests=[];});
  const result=await prepareRecoveryHandoff(f);assert.equal(result.disposition,'actionable');assert.equal(result.binding.kind,'ready');assert.equal(result.timing.cutoffAt,undefined);
  assert.equal(result.nextOperation.template.name,'battle_ready');assert.equal(result.nextOperation.requiresAuthoring,true);assert.equal(f.calls.length,1);
  f.state.actions[0].clock={source:'server-timer-observation',observedAt:INITIAL-5000,deadlineAt:INITIAL};
  assert.equal((await prepareRecoveryHandoff(f)).disposition,'unavailable','expired native ready clock is never actionable');
  f.state.actions[0].clock={source:'unavailable',deadlineAt:null};
  f.state.autoReady=true;assert.equal((await prepareRecoveryHandoff(f)).reason,'manual-ready-mode-unavailable');
});

test('all private fields and echoed session/credential values are removed, including embedded native JSON strings',async()=>{
  const secret='offline-private-controller-capability';
  const f=fixture(state=>{state.controllerLease=secret;state.apiKey='sk-offline-only-secret';state.readReceipt='receipt-private-value';
    state.watchUrl='https://fixture.invalid/private-access';state.note=`Observed ${SESSION} and ${secret}`;
    state.future={password:'private-fixture-password',echo:'private-fixture-password',nested:JSON.stringify({sessionId:SESSION,authorization:'auth-fixture-value',note:'auth-fixture-value'})};
    state.actions[0].clock.future={sessionId:SESSION,secret:'clock-private-value',note:'clock-private-value',echoController:secret};});
  const result=await prepareRecoveryHandoff(f);assert.equal(result.disposition,'actionable');const text=JSON.stringify(result);
  for(const value of [SESSION,secret,'sk-offline-only-secret','receipt-private-value','https://fixture.invalid/private-access','private-fixture-password','auth-fixture-value','clock-private-value'])assert.equal(text.includes(value),false,value);
  assert.equal(result.binding.token,TOKEN,'request authority is preserved, never invented');
});

test('response size, hostile JSON structure and invalid input return bounded unavailability instead of a partial board',async()=>{
  const huge=fixture(state=>{state.boards[0].futureFact='x'.repeat(240001);});
  const large=await prepareRecoveryHandoff(huge);assert.equal(large.disposition,'unavailable');assert.equal(large.reason,'response-too-large');assert.equal(large.response,undefined);
  const cycle=fixture();cycle.operator={async dispatch(){const value=nativeTurn();value.cycle=value;return value;}};
  assert.equal((await prepareRecoveryHandoff(cycle)).reason,'response-structure-unavailable');
  let getterCalls=0;const access=fixture();access.operator={async dispatch(){const value=nativeTurn();Object.defineProperty(value,'secret',{enumerable:true,get(){getterCalls++;return 'private';}});return value;}};
  assert.equal((await prepareRecoveryHandoff(access)).reason,'response-structure-unavailable');assert.equal(getterCalls,0);
  const invalid=fixture();invalid.timeoutMs=1501;
  assert.equal((await prepareRecoveryHandoff(invalid)).reason,'recovery-input-invalid');assert.equal(invalid.calls.length,0);
});

test('bounded timeout emits no actionable context when the single native read completes late, with no unhandled rejection or mutation',async()=>{
  let release,mutations=0,calls=0;const state=nativeTurn();
  const operator={dispatch(command){calls++;assert.equal(command.op,'turn');if(command.op!=='turn')mutations++;return new Promise(resolve=>{release=resolve;});}};
  const result=await prepareRecoveryHandoff({operator,identity:IDENTITY,parentId:PARENT,now:()=>INITIAL,timeoutMs:5,commandId:'timeout_fixture'});
  assert.equal(result.disposition,'unavailable');assert.equal(result.reason,'native-read-timeout');assert.equal(result.response,undefined);
  release({result:state});await delay(10);
  assert.equal(calls,1);assert.equal(mutations,0);assert.equal(result.response,undefined);
  const rejected={dispatch(){return Promise.reject(new Error('Failure with private arbitrary content'));}};
  const failure=await prepareRecoveryHandoff({operator:rejected,identity:IDENTITY,parentId:PARENT,now:()=>INITIAL});
  assert.equal(failure.reason,'native-read-unavailable');assert.equal(JSON.stringify(failure).includes('private arbitrary'),false);
});
