import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';
import {parseSessionArgs} from './session.mjs';
import {registerBattleTools} from './mcp-tools.mjs';

const parent='game-bestof3-gen9championsvgc2026regmcbo3-8800';
const first='battle-gen9championsvgc2026regmcbo3-8801',second='battle-gen9championsvgc2026regmcbo3-8802';
const protect=[{type:'move',slot:1},{type:'move',slot:1}];

// Real session/choice/timer code, synthetic socket and server observations only.
// No descriptor, broker, authentication, network connection or search is used.
function fixture(options={}){
  let time=1000,id=0;const packed='Species|item|ability|move',wire=[];
  const client=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex'),now:()=>time});
  client.connected=true;client.authenticated=true;client.epoch=1;client.searchState={searching:[],games:null};
  client.ws={send:line=>wire.push(line),close:()=>{client.connected=false;client.authenticated=false;client.emit('disconnected');}};
  const session=new AgentSession(client,{username:'Fixture',packed,autoReady:false,controllerRequired:false,now:()=>time,
    controlTimers:{setTimer:()=>({unref(){}}),clearTimer:()=>{}},...options});
  const call=fields=>session.execute({id:'fixture-'+(++id),confirmed:true,...fields});
  const open=(room=first)=>{
    session.searchesSent=1;session.ownedParents.add(parent);session.ownedRooms.add(parent);session.roomParents.set(parent,parent);
    client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'Fixture vs Opponent'}})}`);
    client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game</a>`);
  };
  const request=(room=first,extra={})=>{
    const replacement=!!extra.forceSwitch;
    const pokemon=[
      {ident:'p2: A',details:'Politoed, L50',active:true,condition:replacement?'0 fnt':'100/100'},
      {ident:'p2: B',details:'Kommo-o, L50',active:true,condition:'100/100'},
      {ident:'p2: C',details:'Rillaboom, L50',active:false,condition:'100/100'},
      {ident:'p2: D',details:'Golisopod, L50',active:false,condition:'100/100'},
    ];
    const q={rqid:1,active:[{moves:[{move:'Protect',pp:10,target:'self'}]},{moves:[{move:'Protect',pp:10,target:'self'}]}],side:{id:'p2',name:'Fixture',pokemon},...extra};
    client.receive(`>${room}\n|request|${JSON.stringify(q)}`);
  };
  const choose=(room=first,actions=protect,extra={})=>{
    const action=session.actions().find(a=>a.room===client.resolveRoom(room));assert(action,'Fixture request must be actionable');
    return call({op:'choose',token:action.token,actions,...extra});
  };
  return {client,session,wire,open,request,choose,call,tick:t=>{time=t;},timers:()=>wire.filter(line=>line.endsWith('|/timer on')),close:()=>session.dispose()};
}

test('timer policy is explicitly opt-in, lease-checked, idle-only, idempotent and does not queue',async()=>{
  const f=fixture({controllerRequired:true});
  try{
    assert.equal(f.session.snapshot().timerPolicy.enabled,false);
    assert.equal(f.session.capabilities().features.ownedBattleTimerPolicy,true);
    assert(f.session.capabilities().operations.includes('set-timer-policy'));
    assert.equal((await f.call({op:'set-timer-policy',enabled:true})).ok,false);
    const claimed=await f.call({op:'control-claim',controllerId:'fixture-owner'}),lease=claimed.result.controllerLease;
    const command={id:'policy-on',op:'set-timer-policy',confirmed:true,controllerLease:lease,enabled:true};
    const result=await f.session.execute(command);assert.equal(result.ok,true);
    assert.equal(result.result.enabled,true);assert.equal(result.result.queued,false);assert.equal(result.result.timerSent,false);
    assert.equal(result.result.searchesSent,0);assert.equal(result.result.authorizedSets,1);assert.equal(f.wire.length,0);
    assert.deepEqual(await f.session.execute(command),result);
    f.open();f.request();
    assert.equal((await f.call({op:'set-timer-policy',controllerLease:lease,enabled:false})).ok,false);
    assert.equal(f.session.snapshot().timerPolicy.enabled,true);assert.equal(f.timers().length,0);
  }finally{f.close();}
});

test('disabled policy never enables a timer after an otherwise successful choice',async()=>{
  const f=fixture();try{f.open();f.request();assert.equal((await f.choose()).ok,true);assert.equal(f.timers().length,0);assert.equal(f.wire.filter(line=>line.includes('|/choose ')).length,1);}finally{f.close();}
});

test('each child gets its timer immediately after its own sent preview, never before the next unprotected request',async()=>{
  const f=fixture({timerPolicy:true});
  try{
    for(const room of [first,second]){
      if(room===second)f.client.receive(`>${first}\n|win|Fixture`);
      f.open(room);f.request(room,{teamPreview:true,maxChosenTeamSize:4});
      assert.equal(f.timers().length,room===first?0:1);
      assert.equal((await f.choose(room,[{type:'team',order:[1,2,3,4]}])).ok,true);
      assert(f.wire.at(-2).startsWith(`${room}|/choose team `));assert.equal(f.wire.at(-1),`${room}|/timer on`);
      f.request(room,{rqid:2});
      assert.equal(f.session.actions().find(a=>a.room===room).rqid,2);
      assert.equal(f.timers().length,room===first?1:2);
      assert.equal((await f.choose(room)).ok,true);assert.equal(f.timers().length,room===first?1:2);
    }
    assert.equal(f.session.turnSnapshot().timerPolicy.requestAttempts,2);
    assert.equal(f.session.snapshot().timerPolicy.children.length,2);
    assert(!f.wire.some(line=>/\/search |\/trn |\/forfeit/.test(line)));
  }finally{f.close();}
});

test('a successful forced replacement is protected before the first automatic timer request',async()=>{
  const f=fixture({timerPolicy:true});
  try{
    f.open();f.request(first,{forceSwitch:[true,false]});
    const result=await f.choose(first,[{type:'switch',slot:3},{type:'pass'}]);assert.equal(result.ok,true);
    assert.match(f.wire.at(-2),/\|\/choose switch 3, pass\|1$/);assert.equal(f.wire.at(-1),`${first}|/timer on`);
  }finally{f.close();}
});

test('authorized staged and emergency watchdog sends use the same post-choice timer hook',()=>{
  for(const staged of [true,false]){
    const f=fixture({timerPolicy:true});
    try{
      f.session.supervisor.configure({enabled:true,forfeitIfStuck:false,emergencyDefaultChoice:!staged,planningMs:20000,unknownClockMs:20000});
      f.open();f.request();const action=f.session.actions()[0];
      if(staged)f.session.supervisor.stage(action.token,protect);
      f.tick(21001);f.session.supervisor.onTimer();
      assert(f.wire.at(-2).includes('|/choose '));assert.equal(f.wire.at(-1),`${first}|/timer on`);
      assert(f.session.controlTrace.some(e=>e.type===(staged?'fallback-sent':'emergency-default-sent')));
      assert.equal(f.session.controlTrace.some(e=>e.controlFailure),!staged);
    }finally{f.close();}
  }
});

test('uncertain timer I/O does not taint a sent choice or duplicate through turns, aliases and takeover',async()=>{
  const f=fixture({timerPolicy:true,controllerRequired:true});
  try{
    const firstClaim=await f.call({op:'control-claim',controllerId:'first-owner'}),lease=firstClaim.result.controllerLease;
    f.open();f.request();
    const send=f.client.ws.send;f.client.ws.send=line=>{send(line);if(line.endsWith('|/timer on'))throw Error('Synthetic uncertain write');};
    const chosen=await f.choose(first,protect,{controllerLease:lease});assert.equal(chosen.ok,true);
    assert.equal(f.client.timerStatus(first).request.status,'send-uncertain');assert.equal(f.timers().length,1);
    assert.equal(f.session.snapshot().timerPolicy.lastChild.status,'send-uncertain');
    const alias=first+'-fixturetimerpw';f.client.receive(`>${first}\n|noinit|rename|${alias}|Private battle`);
    const secondClaim=await f.call({op:'control-claim',controllerId:'second-owner',takeover:true,expectedGeneration:1});
    f.request(alias,{rqid:2});
    assert.equal((await f.choose(alias,protect,{controllerLease:lease})).ok,false);
    assert.equal((await f.choose(alias,protect,{controllerLease:secondClaim.result.controllerLease})).ok,true);
    assert.equal(f.timers().length,1);assert.equal(f.session.snapshot().timerPolicy.requestAttempts,1);
    f.client.receive(`>${alias}\n|inactiveoff|Battle timer is now OFF.`);f.request(alias,{rqid:3});
    assert.equal((await f.choose(alias,protect,{controllerLease:secondClaim.result.controllerLease})).ok,true);
    assert.equal(f.timers().length,1);
  }finally{f.close();}
});

test('already active or already requested timers are not sent again',async()=>{
  for(const existing of ['active','requested']){
    const f=fixture({timerPolicy:true});
    try{
      f.open();f.request();
      if(existing==='active')f.client.receive(`>${first}\n|inactive|Battle timer is ON.`);
      else {assert.equal((await f.call({op:'set-timer',room:first,enabled:true})).ok,true);}
      const count=f.timers().length;assert.equal((await f.choose()).ok,true);assert.equal(f.timers().length,count);
      assert.equal(f.session.snapshot().timerPolicy.requestAttempts,0);
    }finally{f.close();}
  }
});

test('a reentrant fresh request defers activation until that request has its own sent choice',async()=>{
  const f=fixture({timerPolicy:true});
  try{
    f.open();f.request();let injected=false;const send=f.client.ws.send;
    f.client.ws.send=line=>{send(line);if(!injected&&line.includes('|/choose ')){injected=true;f.request(first,{rqid:2});}};
    assert.equal((await f.choose()).ok,true);assert.equal(f.timers().length,0);
    assert.equal(f.session.snapshot().timerPolicy.lastDeferred.reason,'fresh-request-not-protected');
    assert.equal(f.session.actions()[0].rqid,2);
    assert.equal((await f.choose()).ok,true);assert.equal(f.timers().length,1);
    assert(f.wire.at(-2).endsWith('|2'));assert.equal(f.wire.at(-1),`${first}|/timer on`);
  }finally{f.close();}
});

test('an uncertain choice send never starts the timer, and disconnect never silently restores policy work',async()=>{
  const f=fixture({timerPolicy:true});
  try{
    f.open();f.request();const send=f.client.ws.send;
    f.client.ws.send=line=>{send(line);if(line.includes('|/choose '))throw Error('Synthetic uncertain choice');};
    assert.equal((await f.choose()).ok,false);assert.equal(f.timers().length,0);
    f.client.close();f.client.connected=true;f.client.authenticated=true;f.client.epoch=2;
    f.session.ensureTimerAfterChoice({room:first,rqid:1,revision:1},{status:'sent-not-acknowledged'});
    assert.equal(f.timers().length,0);assert.equal(f.session.stopped,true);
  }finally{f.close();}
});

test('policy disablement stops future children without sending timer-off or changing allowance',async()=>{
  const f=fixture({timerPolicy:true});
  try{
    f.open();f.request();await f.choose();assert.equal(f.timers().length,1);
    f.client.receive(`>${first}\n|win|Fixture`);f.client.receive(`>${parent}\n|win|Fixture`);f.client.receive('|updatesearch|{"searching":[],"games":null}');
    const result=await f.call({op:'set-timer-policy',enabled:false});assert.equal(result.ok,true);
    assert.equal(result.result.authorizedSets,1);assert.equal(result.result.searchesSent,1);assert.equal(result.result.enabled,false);
    assert(!f.wire.some(line=>/\/timer off|\/search |\/trn /.test(line)));
  }finally{f.close();}
});

test('timer policy MCP schema dispatches the exact opt-in operation with lease and stable command ID',async()=>{
  const tools=new Map(),calls=[];
  registerBattleTools({registerTool:(name,definition,handler)=>tools.set(name,{definition,handler})},{workspace:'synthetic-workspace',call:async(_path,command)=>{calls.push(command);return {id:command.id,ok:true,result:{enabled:command.enabled}};}});
  const tool=tools.get('battle_set_timer_policy'),args={confirmed:true,commandId:'owned-timer-policy',controllerLease:'a'.repeat(64),enabled:true};
  const parsed=tool.definition.inputSchema.parse(args);assert.equal((await tool.handler(parsed)).isError,false);
  assert.deepEqual(calls,[{id:'owned-timer-policy',op:'set-timer-policy',confirmed:true,controllerLease:'a'.repeat(64),enabled:true}]);
  assert.throws(()=>tool.definition.inputSchema.parse({...args,enabled:'yes'}));
  assert.equal(tool.definition.inputSchema.parse({...args,enabled:false}).enabled,false);
});

test('CLI timer opt-in is explicit and independent of login, replay and battle count',()=>{
  const args=['Fixture','--team','synthetic-team.txt'];
  const off=parseSessionArgs(args),on=parseSessionArgs([...args,'--battle-timer']);
  assert.equal(off.battleTimer,false);assert.deepEqual(on,{...off,battleTimer:true});
});
