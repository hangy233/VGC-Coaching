import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DeadlineSupervisor} from './deadline-supervisor.mjs';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';
import {registerBattleTools} from './mcp-tools.mjs';

const pair=[{type:'move',slot:1},{type:'move',slot:1}],other=[{type:'move',slot:2},{type:'move',slot:1}],copy=structuredClone;
const room='battle-gen9championsvgc2026regmcbo3-7',parent='game-bestof3-gen9championsvgc2026regmcbo3-7';
function supervisorFixture(options={}){
  let time=1000,actions=[{kind:'turn',room,rqid:1,token:'token',receivedAt:1000,parentId:parent}],sequence=0;
  const sent=[],timers=new Map(),supervisor=new DeadlineSupervisor({now:()=>time,getActions:()=>actions,setTimer:(callback,delay)=>{timers.set(++sequence,{callback,at:time+delay});return sequence;},clearTimer:id=>timers.delete(id),validate:(_a,p)=>p,submit:(_a,p)=>sent.push(copy(p)),forfeit:()=>assert.fail('No forfeit'),...options});
  supervisor.configure({enabled:true});
  return {supervisor,sent,setTime:value=>{time=value;},setActions:value=>{actions=value;},get actions(){return actions;},withdraw:(actions=pair,fields={})=>supervisor.withdraw({room,rqid:1,token:'token',actions,...fields}),cutoff:()=>{time=21000;supervisor.handleCutoff(supervisor.records.get('token'));}};
}

test('exact fallback withdrawal clears metadata without resetting deadlines or sending at cutoff',()=>{
  const f=supervisorFixture();try{
    f.supervisor.stage('token',pair,{turnPlan:{objective:'Old intent'}});const before=f.supervisor.status().pending[0];f.setTime(5000);
    const r=f.withdraw();assert.equal(r.withdrawn,true);assert.equal(r.outcome,'withdrawn');assert.equal(r.cutoffAt,before.cutoffAt);assert.equal(r.planningDeadlineAt,before.planningDeadlineAt);
    assert.equal(f.supervisor.records.get('token').stagedMetadata,undefined);assert.equal(f.supervisor.status().pending[0].hasFallback,false);f.cutoff();assert.deepEqual(f.sent,[]);
  }finally{f.supervisor.dispose();}
});

test('exact fallback withdrawal preserves different pair, stale token and no-stage outcomes',()=>{
  const f=supervisorFixture();try{
    assert.equal(f.withdraw().outcome,'no-stage');f.supervisor.stage('token',other);
    assert.equal(f.withdraw().outcome,'different-pair');assert.deepEqual(f.supervisor.records.get('token').staged,other);
    for(const fields of [{token:'old'},{rqid:2},{room:room+'-privatepw'}])assert.equal(f.withdraw(pair,fields).outcome,'stale');
    f.cutoff();assert.deepEqual(f.sent,[other]);
  }finally{f.supervisor.dispose();}
});

test('exact fallback withdrawal preserves returned and uncertain submission reservations',()=>{
  for(const uncertain of [false,true]){
    const f=supervisorFixture({submit:()=>{if(uncertain)throw new Error('uncertain socket');}});try{
      f.supervisor.stage('token',pair);f.cutoff();const record=f.supervisor.records.get('token'),before=record.sendOutcome;
      const r=f.withdraw();assert.equal(r.outcome,'submission-reserved');assert.equal(r.withdrawn,false);assert.equal(record.attempted,true);assert.equal(record.sendOutcome,before);assert.equal(before,uncertain?'uncertain':'returned');
    }finally{f.supervisor.dispose();}
  }
});

test('exact fallback withdrawal wins synchronous validation race and preserves a new replacement',()=>{
  for(const replace of [false,true]){
    let f,armed=false;f=supervisorFixture({validate:(_a,p)=>{if(armed){armed=false;assert.equal(f.withdraw().withdrawn,true);if(replace)f.supervisor.stage('token',other);}return p;}});
    try{f.supervisor.stage('token',pair);armed=true;f.cutoff();assert.deepEqual(f.sent,[]);assert.deepEqual(f.supervisor.records.get('token').staged,replace?other:null);if(replace){f.cutoff();assert.deepEqual(f.sent,[other]);}}
    finally{f.supervisor.dispose();}
  }
});

test('withdrawal leaves separately enabled emergency default policy explicit and unchanged',()=>{
  const f=supervisorFixture({selectDefault:()=>pair});try{
    f.supervisor.configure({emergencyDefaultChoice:true});f.supervisor.stage('token',pair);assert.equal(f.withdraw().withdrawn,true);f.cutoff();assert.deepEqual(f.sent,[pair]);
    const events=f.supervisor.status().recentEvents;assert(events.some(e=>e.type==='emergency-default-selected'&&e.controlFailure===true));
  }finally{f.supervisor.dispose();}
});

async function sessionFixture(){
  let time=1000;const packed='Species|item|ability|move',sent=[];
  const client=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex'),now:()=>time});
  client.connected=true;client.authenticated=true;client.epoch=1;client.ws={send:text=>sent.push(text),close(){}};client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';
  const session=new AgentSession(client,{username:'FixturePlayer',packed,authorizedSets:1,autoReady:false,controllerRequired:false,now:()=>time,controlTimers:{setTimer:()=>1,clearTimer:()=>{}}});
  await session.execute({id:'start',op:'start',confirmed:true});client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'FixturePlayer vs Opponent'}})}`);client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);
  const request=(rqid=1)=>client.receive(`>${room}\n|request|${JSON.stringify({rqid,active:[{moves:[{move:'Protect',target:'self',pp:10},{move:'Substitute',target:'self',pp:10}]},{moves:[{move:'Protect',target:'self',pp:10}]}],side:{id:'p2',name:'FixturePlayer',pokemon:[{ident:'p2: A',details:'Politoed, L50',active:true,condition:'100/100'},{ident:'p2: B',details:'Kommo-o, L50',active:true,condition:'100/100'}]}})}`);
  request();session.supervisor.configure({enabled:true});const claim=await session.execute({id:'claim',op:'control-claim',confirmed:true,controllerId:'Withdrawal test'});assert.equal(claim.ok,true,claim.error);
  const lease=claim.result.controllerLease,action=session.actions()[0];let count=0;
  const execute=(op,extra={})=>session.execute({id:'withdrawal-'+(++count),op,confirmed:true,controllerLease:lease,room,rqid:action.rqid,token:action.token,actions:copy(pair),...extra});
  return {session,client,sent,action,lease,request,execute,setTime:value=>{time=value;}};
}

test('session withdrawal requires actual exclusive lease and exact request and canonical pair',async()=>{
  const f=await sessionFixture();try{
    assert.equal((await f.execute('stage-fallback',{turnPlan:{objective:'Keep the explicitly selected pair.'}})).ok,true);const before=f.session.supervisor.status().pending[0];
    const binding={teamId:f.client.expectedTeamHash,room,rqid:f.action.rqid,revision:f.action.revision};
    const unrelated={...binding,room:'battle-gen9championsvgc2026regmcbo3-8'},nextRequest={...binding,rqid:binding.rqid+1};
    for(const source of [unrelated,nextRequest])f.session.turnPlans.record({...source,turn:0,plan:{objective:'Separate request.',chosenPair:pair},actions:pair,stage:'staged'});
    assert.equal(f.session.turnSnapshot().boards.find(b=>b.room===room).actionPlan.intentStatus,'staged');
    for(const extra of [{controllerLease:'f'.repeat(64)},{rqid:2},{token:'f'.repeat(64)},{room:room+'-privatepw'}]){const r=await f.execute('withdraw-fallback',extra);assert.equal(r.ok,false);assert.equal(f.session.supervisor.status().pending[0].hasFallback,true);}
    const different=await f.execute('withdraw-fallback',{actions:other});assert.equal(different.ok,true,different.error);assert.equal(different.result.outcome,'different-pair');
    const r=await f.execute('withdraw-fallback',{actions:[{...pair[0],mega:false},pair[1]]});assert.equal(r.ok,true,r.error);assert.equal(r.result.withdrawn,true);assert.equal(r.result.cutoffAt,before.cutoffAt);assert.equal(r.result.planningDeadlineAt,before.planningDeadlineAt);
    assert.equal(f.session.turnSnapshot().boards.find(b=>b.room===room).actionPlan.kind,'carried-intent');assert.equal(f.session.turnPlans.history().find(v=>v.room===room&&v.rqid===binding.rqid).intentStatus,'staged');assert.equal(f.session.turnPlans.history().find(v=>v.room===room&&v.rqid===binding.rqid).invalidated,true);for(const source of [unrelated,nextRequest])assert.equal(f.session.turnPlans.snapshot(source).intentStatus,'staged');
    assert.equal((await f.execute('withdraw-fallback')).result.outcome,'no-stage');assert(f.session.capabilities().features.exactFallbackWithdrawal);assert(!f.sent.some(text=>text.includes('/choose')));
  }finally{f.session.dispose();}
});

test('session withdrawal cannot reclaim a sent choice or a revoked controller stage',async()=>{
  const f=await sessionFixture();try{
    assert.equal((await f.execute('stage-fallback')).ok,true);
    const takeover=await f.session.execute({id:'takeover',op:'control-claim',confirmed:true,controllerId:'Replacement',takeover:true,expectedGeneration:f.session.controller.status().generation});assert.equal(takeover.ok,true,takeover.error);
    assert.equal((await f.execute('withdraw-fallback')).ok,false);
    assert.equal((await f.execute('stage-fallback',{controllerLease:takeover.result.controllerLease,actions:other})).ok,true);
    const replaced=await f.execute('withdraw-fallback',{controllerLease:takeover.result.controllerLease});assert.equal(replaced.result.outcome,'different-pair');
    const sent=await f.execute('choose',{controllerLease:takeover.result.controllerLease,actions:other});assert.equal(sent.ok,true,sent.error);
    const r=await f.execute('withdraw-fallback',{controllerLease:takeover.result.controllerLease,actions:other});assert.equal(r.ok,true,r.error);assert.equal(r.result.outcome,'submission-reserved');assert.equal(f.sent.filter(text=>text.includes('/choose')).length,1);
  }finally{f.session.dispose();}
});

test('registered withdrawal MCP forwards exact fields to actual session without SDK or source rebinding',async()=>{
  const f=await sessionFixture();try{
    await f.execute('stage-fallback');const tools=new Map();let forwarded;
    registerBattleTools({registerTool:(name,contract,handler)=>tools.set(name,{contract,handler})},{workspace:process.cwd(),call:async(_path,input)=>{forwarded=copy(input);return f.session.execute(input);}});
    const tool=tools.get('battle_withdraw_fallback'),args={confirmed:true,commandId:'registered-withdrawal',controllerLease:f.lease,room,rqid:f.action.rqid,token:f.action.token,actions:copy(pair)};
    assert.equal(tool.contract.annotations.readOnlyHint,false);const parsed=tool.contract.inputSchema.parse(args),r=await tool.handler(parsed),body=JSON.parse(r.content[0].text);
    assert.equal(body.ok,true,body.error);assert.equal(body.result.withdrawn,true);assert.deepEqual(forwarded,{id:args.commandId,op:'withdraw-fallback',confirmed:true,controllerLease:f.lease,room,rqid:1,token:f.action.token,actions:pair});
    assert.throws(()=>tool.contract.inputSchema.parse({...args,rqid:undefined}));assert.throws(()=>tool.contract.inputSchema.parse({...args,actions:pair,source:'spoof'}));assert(!f.sent.some(text=>text.includes('/choose')));
  }finally{f.session.dispose();}
});

test('session withdrawal retains a genuinely uncertain socket reservation and requires an actual owner',async()=>{
  const f=await sessionFixture();try{
    await f.execute('stage-fallback');const send=f.client.ws.send;f.client.ws.send=text=>{if(text.includes('/choose'))throw new Error('Socket outcome uncertain');send(text);};
    const selected=await f.execute('choose');assert.equal(selected.ok,false);
    const r=await f.execute('withdraw-fallback');assert.equal(r.ok,true,r.error);assert.equal(r.result.outcome,'submission-reserved');assert.equal(r.result.withdrawn,false);assert.equal(f.session.supervisor.status().pending[0].attempted,true);
    assert.equal((await f.execute('control-release')).ok,true);const noOwner=await f.execute('withdraw-fallback',{controllerLease:undefined});assert.equal(noOwner.ok,false);assert.match(noOwner.error,/exclusive controller lease/);
  }finally{f.session.dispose();}
});
