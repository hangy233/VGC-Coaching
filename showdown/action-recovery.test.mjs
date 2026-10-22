import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';
import {registerBattleTools} from './mcp-tools.mjs';
import {sanitizeResponse} from './operator-response.mjs';

const room='battle-gen9championsvgc2026regmcbo3-901',parent='game-bestof3-gen9championsvgc2026regmcbo3-900';
const pair=[{type:'move',slot:1},{type:'move',slot:1}];
async function fixture({emergencyDefaultChoice=false}={}){
  let time=1000,sequence=0;
  const packed='Species|item|ability|move',sent=[];
  const client=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex'),now:()=>time});
  client.connected=true;client.authenticated=true;client.epoch=1;
  client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';client.searchState={searching:[],games:{}};
  client.ws={send:value=>sent.push(value),close:()=>{client.connected=false;client.authenticated=false;client.emit('disconnected');}};
  const session=new AgentSession(client,{username:'Fixture',packed,autoReady:false,now:()=>time,monotonicNow:()=>time,
    controlTimers:{setTimer:()=>({unref(){}}),clearTimer:()=>{}}});
  const raw=command=>session.execute({id:`command-${++sequence}`,confirmed:true,...command});
  const claimed=await raw({op:'control-claim',controllerId:'operator'}),lease=claimed.result.controllerLease;
  const execute=command=>raw({controllerLease:lease,...command});
  assert.equal((await execute({op:'set-control-policy',enabled:true,forfeitIfStuck:false,emergencyDefaultChoice})).ok,true);
  assert.equal((await execute({op:'start'})).ok,true);
  client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'Fixture vs Opponent'}})}`);
  client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);
  const request=(extra={})=>client.receive(`>${room}\n|request|${JSON.stringify({rqid:1,
    active:[{moves:[{move:'Protect',pp:10,target:'self'}]},{moves:[{move:'Protect',pp:10,target:'self'}]}],
    side:{id:'p2',name:'Fixture',pokemon:[
      {ident:'p2: A',details:'Politoed, L50',active:true,condition:'100/100'},
      {ident:'p2: B',details:'Kommo-o, L50',active:true,condition:'100/100'},
      {ident:'p2: C',details:'Rillaboom, L50',active:false,condition:'100/100'},
      {ident:'p2: D',details:'Hydreigon, L50',active:false,condition:'100/100'}]},...extra})}`);
  request();
  return {session,client,sent,lease,raw,execute,request,tick:value=>{time=value;}};
}

test('stale stage after a default returns the current replacement request in the same failure',async()=>{
  const f=await fixture({emergencyDefaultChoice:true});
  try{
    const original=f.session.actions()[0];f.tick(21000);f.session.supervisor.onTimer();
    assert.equal(f.sent.filter(value=>value.includes('/choose ')).length,1);
    const next=structuredClone(f.client.state(room).request);delete next.active;next.rqid=2;next.forceSwitch=[true,false];next.side.pokemon[0].condition='0 fnt';
    f.tick(22000);f.request(next);f.tick(22300);
    f.client.receive(`>${room}\n|inactive|Time left: 10 sec this turn | 100 sec total`);
    const command={id:'stale-stage',op:'stage-fallback',token:original.token,actions:pair};
    const failure=await f.execute(command),recovery=failure.recovery;
    assert.equal(failure.ok,false);assert.equal(recovery.outcome,'submission-reserved');
    assert.equal(recovery.retry,false);assert.equal(recovery.rebind,false);assert.equal(recovery.requiresNewDecision,true);
    assert.equal(recovery.attempted.rqid,1);assert.equal(recovery.attempted.reservation,true);
    const fresh=recovery.state.actions[0];assert.equal(fresh.rqid,2);assert.equal(fresh.kind,'switch');assert.notEqual(fresh.token,original.token);
    assert(fresh.legalActions.replacementPairs.some(value=>value[0].type==='switch'&&value[1].type==='pass'));
    assert.equal(recovery.state.boards[0].requestAgeMs,300);assert.equal(fresh.clock.remainingMs,10000);
    assert.equal(recovery.state.observedAt,22300);assert.equal(recovery.state.timing.requests[0].requestAgeMs,300);
    assert.equal(f.sent.filter(value=>value.includes('/choose ')).length,1);
    f.request({...next,rqid:3});assert.deepEqual(await f.execute(command),failure);
    assert(!JSON.stringify(sanitizeResponse(failure)).includes(f.lease));
  }finally{f.session.dispose();}
});

test('validation rejection returns the still-fresh request and permits a newly authored correction',async()=>{
  const f=await fixture();
  try{
    const action=f.session.actions()[0],command={id:'invalid-pair',op:'choose',token:action.token,actions:[{type:'move',slot:4},{type:'move',slot:1}]};
    const failure=await f.execute(command);assert.equal(failure.ok,false);
    assert.equal(failure.recovery.outcome,'not-sent');assert.equal(failure.recovery.attempted.reservation,false);
    assert.equal(failure.recovery.state.actions[0].token,action.token);assert.equal(f.sent.filter(value=>value.includes('/choose ')).length,0);
    assert.equal((await f.execute({...command,actions:pair})).ok,false);
    assert.equal((await f.execute({...command,id:'corrected-pair',actions:pair})).ok,true);
    assert.equal(f.sent.filter(value=>value.includes('/choose ')).length,1);
  }finally{f.session.dispose();}
});

for(const uncertain of [false,true])test(`${uncertain?'uncertain':'returned'} sends retain their reservation through failed new staging or choose attempts`,async()=>{
  const f=await fixture();
  try{
    const action=f.session.actions()[0],write=f.client.ws.send;
    if(uncertain)f.client.ws.send=value=>{write(value);if(value.includes('/choose '))throw Error('Synthetic write failure');};
    const command={id:'send-once',op:'choose',token:action.token,actions:pair},first=await f.execute(command);
    assert.equal(first.ok,!uncertain);
    if(uncertain){assert.equal(first.recovery.outcome,'send-uncertain');assert.equal(first.recovery.attempted.reservation,true);}
    assert.deepEqual(await f.execute(command),first);
    for(const op of ['choose','stage-fallback']){
      const failure=await f.execute({op,token:action.token,actions:pair});assert.equal(failure.ok,false);
      assert.equal(failure.recovery.outcome,uncertain?'send-uncertain':'submission-reserved');
      assert.equal(failure.recovery.state.actions.length,0);assert.equal(failure.recovery.retry,false);
      assert.equal(failure.recovery.state.timing.requests[0].firstChoiceMissing,false);
    }
    f.tick(30000);f.session.supervisor.onTimer();assert.equal(f.sent.filter(value=>value.includes('/choose ')).length,1);
    assert.equal(f.sent.filter(value=>value.includes('/forfeit')).length,0);
  }finally{f.session.dispose();}
});

test('failed control confirmation and revoked leases return no recovery tokens',async()=>{
  const f=await fixture();
  try{
    const action=f.session.actions()[0];
    for(const fields of [{confirmed:false},{controllerLease:'a'.repeat(64)}]){
      const failure=await f.execute({op:'stage-fallback',token:action.token,actions:pair,...fields});assert.equal(failure.ok,false);assert.equal(failure.recovery,undefined);
      assert(!JSON.stringify(failure).includes(action.token));assert(!JSON.stringify(failure).includes(f.lease));
    }
    await f.raw({op:'control-claim',controllerId:'new-operator',takeover:true,expectedGeneration:f.session.controller.status().generation});
    assert.equal((await f.execute({op:'choose',token:action.token,actions:pair})).recovery,undefined);
    assert.equal(f.sent.filter(value=>value.includes('/choose ')).length,0);
  }finally{f.session.dispose();}
});

test('compact waits wake directly with current boards while default waits retain full observations',async()=>{
  const f=await fixture();
  try{
    const full=await f.session.wait({timeoutMs:0});assert(full.rooms[0]);assert.equal(full.boards,undefined);
    const snapshot=f.session.snapshot.bind(f.session);let fullReads=0;f.session.snapshot=()=>{fullReads++;return snapshot();};
    const waiting=f.session.execute({id:'compact-request',op:'wait',format:'compact',afterRevision:f.session.revision,timeoutMs:1000});
    f.request({rqid:2});const reply=await waiting;assert.equal(reply.ok,true);assert.equal(reply.result.actions[0].rqid,2);
    assert(Array.isArray(reply.result.boards));assert.equal(fullReads,0);
    const immediate=await f.session.wait({format:'compact',afterRevision:0,timeoutMs:1000});assert.equal(immediate.revision,f.session.revision);assert.equal(fullReads,0);
    const stopped=f.session.wait({format:'compact',afterRevision:f.session.revision,timeoutMs:1000});f.client.ws.close();
    assert.equal((await stopped).stopped,true);assert.equal(fullReads,0);
    assert.equal((await f.session.wait({format:'compact',timeoutMs:1000})).stopped,true);
    await assert.rejects(f.session.wait({format:'invalid',timeoutMs:0}),/format/);
  }finally{f.session.dispose();}
});

test('compact terminal state and timing preserve original request ages without inventing clock evidence',async()=>{
  const f=await fixture();
  try{
    f.tick(7000);let compact=f.session.turnSnapshot(),timing=compact.timing.requests[0];
    assert.equal(timing.requestAgeMs,6000);assert.equal(timing.planningRemainingMs,14000);assert.equal(timing.hardDeadlineAt,null);
    assert.equal(compact.actions[0].clock.source,'unavailable');
    f.tick(23000);compact=f.session.turnSnapshot();timing=compact.timing.requests[0];
    assert.equal(timing.requestAgeMs,22000);assert.equal(timing.urgency,'plan-overdue');assert.equal(timing.firstChoiceMissing,true);
    assert.equal(timing.hardRemainingMs,null);assert.equal(f.sent.filter(value=>value.includes('/forfeit')).length,0);
    assert.equal((await f.execute({op:'stage-fallback',token:compact.actions[0].token,actions:pair})).ok,true);
    assert.equal(f.session.turnSnapshot().timing.requests[0].firstChoiceMissing,false);
    f.client.receive(`>${room}\n|win|Fixture`);f.client.receive(`>${parent}\n|win|Fixture`);f.client.receive('|updatesearch|{"searching":[],"games":null}');
    compact=await f.session.wait({format:'compact',timeoutMs:0});
    assert(compact.rooms.some(value=>value.id===parent&&value.ended&&value.result.type==='win'));
    assert.deepEqual(compact.search,{searching:[],games:null});assert.equal(compact.awaitingSet,false);assert.equal(compact.searchPending,false);
  }finally{f.session.dispose();}
});

test('MCP wait schema maps both formats and preserves structured mutation failure replies',async()=>{
  const f=await fixture(),registered=new Map(),calls=[];
  try{
    registerBattleTools({registerTool:(name,config,handler)=>registered.set(name,{config,handler})},{workspace:'fixture-workspace',call:async(_path,command)=>{calls.push(command);return f.session.execute(command);}});
    const wait=registered.get('battle_wait');assert.equal(wait.config.inputSchema.parse({}).format,'full');
    assert.equal(wait.config.inputSchema.safeParse({format:'other'}).success,false);
    const decoded=value=>JSON.parse(value.content[0].text);
    const compact=decoded(await wait.handler(wait.config.inputSchema.parse({format:'compact',timeoutMs:0})));
    assert.equal(calls.at(-1).format,'compact');assert(Array.isArray(compact.result.boards));
    const action=f.session.actions()[0],choose=registered.get('battle_choose');
    const result=await choose.handler({confirmed:true,commandId:'mcp-invalid',controllerLease:f.lease,token:action.token,actions:[{type:'move',slot:4},{type:'move',slot:1}]});
    assert.equal(result.isError,true);assert.equal(decoded(result).recovery.state.actions[0].token,action.token);
    assert.equal(decoded(result).recovery.retry,false);assert(!JSON.stringify(result).includes(f.lease));
  }finally{f.session.dispose();}
});
