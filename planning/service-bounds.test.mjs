import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolvePlanningSource,boundAction} from './source.mjs';
import {createTurnBrief,turnBriefSchema} from './service.mjs';
import {planningFixture} from './fixtures.mjs';

function observedFixture() {
  const data=planningFixture();
  const request={kind:'observed',sessionId:'offline-review-session',teamId:'a'.repeat(64),room:'battle-gen9championsvgc2026regmc-81',rqid:12,token:'b'.repeat(64)};
  Object.assign(data.board,{room:request.room,request:{rqid:request.rqid,teamPreview:false},opponentSheets:{p2:data.opponentSheet}});
  const state={sessionId:request.sessionId,teamSha256:request.teamId,boards:[data.board],
    actions:[{room:request.room,rqid:request.rqid,token:request.token,kind:'turn',actionable:true,submissionStatus:null,legalActions:data.legalActions}],
    controlPolicy:{pending:[{token:request.token,cutoffAt:Date.now()+60000,attempted:false}]}};
  const calls=[];
  const call=async(_descriptor,command,options)=>{
    calls.push({command,options});
    return command.op==='turn-status'?structuredClone(state):{sessionId:request.sessionId,teamSha256:request.teamId,rooms:[]};
  };
  const loadTeam=async()=>({teamId:request.teamId,team:data.ownTeam});
  return {request,data,state,call,calls,loadTeam};
}

test('expired cutoff and send reservations fail before planning can claim an actionable source',async()=>{
  const fixture=observedFixture();fixture.state.controlPolicy.pending[0].cutoffAt=Date.now()-1;
  assert.throws(()=>boundAction(fixture.state,fixture.request),/cutoff expired/);
  await assert.rejects(resolvePlanningSource(fixture.request,{workspace:process.cwd(),call:fixture.call,loadTeam:fixture.loadTeam}),/cutoff expired/);
  assert.deepEqual(fixture.calls.map(call=>call.command.op),['turn-status','status']);
  fixture.state.controlPolicy.pending[0]={token:fixture.request.token,cutoffAt:Date.now()+60000,attempted:true};
  assert.throws(()=>boundAction(fixture.state,fixture.request),/send reservation/);
});

test('observed source forwards bounded cancellation to reads and rejects a stalled team load',async()=>{
  const fixture=observedFixture();let loaded=0;
  const started=performance.now();
  await assert.rejects(resolvePlanningSource(fixture.request,{workspace:process.cwd(),call:fixture.call,deadline:Date.now()+60,
    loadTeam:async()=>{loaded++;return new Promise(()=>{});}}),/locked-team read expired/);
  assert.equal(loaded,1);
  assert.ok(performance.now()-started<500,'No unbounded wait for a stalled team read');
  assert.ok(fixture.calls.every(call=>call.options.timeoutMs>0&&call.options.timeoutMs<=750&&call.options.signal instanceof AbortSignal));
});

test('stalled independent source reads both abort at the shared bounded deadline without a revalidation read',async()=>{
  const fixture=observedFixture();const options=[];let calls=0;
  await assert.rejects(resolvePlanningSource(fixture.request,{workspace:process.cwd(),deadline:Date.now()+30,loadTeam:fixture.loadTeam,
    call:async(_descriptor,_command,received)=>{calls++;options.push(received);return new Promise(()=>{});}}),/source read expired/);
  assert.equal(calls,2);assert(options.every(value=>value.signal.aborted));
});

test('final observed revalidation rejects an elapsed cutoff despite an unchanged board and token',async()=>{
  const fixture=observedFixture();let turnReads=0;
  const call=async(descriptor,command,options)=>{
    if(command.op==='turn-status'&&++turnReads===2)fixture.state.controlPolicy.pending[0].cutoffAt=Date.now()-1;
    return fixture.call(descriptor,command,options);
  };
  const result=await createTurnBrief({request:fixture.request,maxCalls:0,budgetMs:2000,view:'full'},
    {workspace:process.cwd(),call,loadTeam:fixture.loadTeam});
  assert.equal(result.status,'stale-source');assert.equal(result.coverage.sourceRevalidated,false);assert.deepEqual(result.candidates,[]);
  assert.ok(result.warnings.some(warning=>warning.code==='STALE_SOURCE'));
  assert.deepEqual(fixture.calls.map(call=>call.command.op),['turn-status','status','turn-status']);
});

test('complete input size is bounded before schema/source work, including authored action extras',async()=>{
  const fixture=observedFixture();let calls=0;
  const input={request:fixture.request,candidates:[{id:'huge',purpose:'Bounded input regression',actions:[{type:'move',slot:1,extra:'x'.repeat(513*1024)}]}]};
  await assert.rejects(createTurnBrief(input,{workspace:process.cwd(),call:async()=>{calls++;throw new Error('must not read');}}),/Complete planning input exceeds bounded snapshot size/);
  assert.equal(calls,0);
});

test('scenario actor counts, field keys and HP objects have explicit structural bounds',()=>{
  const fixture=observedFixture(),base={request:fixture.request};
  const hypothesis={id:'bounded-scenario',label:'Named scenario',pokemon:{}};
  assert.throws(()=>turnBriefSchema.parse({...base,hypotheses:[{...hypothesis,pokemon:Object.fromEntries(Array.from({length:25},(_,index)=>[`actor-${index}`,{}]))}]}),/At most 24 actor hypotheses/);
  for(const hp of [0,{current:0},{current:1,precision:'guessed'},{current:1,max:0}]) {
    assert.throws(()=>turnBriefSchema.parse({...base,hypotheses:[{...hypothesis,pokemon:{'foe-a':{hp}}}]}));
  }
  assert.throws(()=>turnBriefSchema.parse({...base,hypotheses:[{...hypothesis,field:{weather:'Rain',unmodeledScreens:true}}]}));
  assert.doesNotThrow(()=>turnBriefSchema.parse({...base,hypotheses:[{...hypothesis,pokemon:{'foe-a':{hp:{current:50,max:100}}},field:{weather:'Rain',trickRoom:false}}]}));
});

test('retained observed calculator context stays on the exact bound team/game without extra control operations',async()=>{
  const fixture=observedFixture(),calculatorCalls=[];
  const callTool=Object.assign(async(name,args)=>{calculatorCalls.push({name,args});return {structuredContent:{gen:0,pokemon:[],order:[]}};},{runtimeVersion:'offline-context-test'});
  const result=await createTurnBrief({request:fixture.request,maxCalls:1,budgetMs:2000,retainEvidence:true,view:'full'},
    {workspace:process.cwd(),call:fixture.call,loadTeam:fixture.loadTeam,callTool});
  assert.equal(result.status,'advisory');assert.equal(calculatorCalls.length,1);
  assert.equal(calculatorCalls[0].name,'calculate_speed');
  assert.deepEqual(calculatorCalls[0].args.evidenceContext,{teamId:fixture.request.teamId,roomId:fixture.request.room,turn:2});
  assert.deepEqual(fixture.calls.map(call=>call.command.op),['turn-status','status','turn-status']);
});

test('native compact turn state may omit its team hash while full status and locked team bind it exactly',async()=>{
  const fixture=observedFixture(),compact=structuredClone(fixture.state);delete compact.teamSha256;
  const ops=[];
  const call=async(_descriptor,command)=>{ops.push(command.op);return command.op==='turn-status'?structuredClone(compact):
    {sessionId:fixture.request.sessionId,teamSha256:fixture.request.teamId,rooms:[]};};
  const loaded=await resolvePlanningSource(fixture.request,{workspace:process.cwd(),call,loadTeam:fixture.loadTeam});
  assert.equal(loaded.source.teamId,fixture.request.teamId);assert.equal(await loaded.revalidate(),true);
  assert.deepEqual(ops,['turn-status','status','turn-status']);
  assert.equal(Object.hasOwn(compact,'teamSha256'),false);
});

test('missing compact hash never permits a mismatched full-status or saved-team fingerprint',async()=>{
  const fixture=observedFixture(),compact=structuredClone(fixture.state);delete compact.teamSha256;
  const call=async(_descriptor,command)=>command.op==='turn-status'?structuredClone(compact):
    {sessionId:fixture.request.sessionId,teamSha256:'c'.repeat(64),rooms:[]};
  await assert.rejects(resolvePlanningSource(fixture.request,{workspace:process.cwd(),call,loadTeam:fixture.loadTeam}),/sheet source identity changed/);
  const exactStatus=async(_descriptor,command)=>command.op==='turn-status'?structuredClone(compact):
    {sessionId:fixture.request.sessionId,teamSha256:fixture.request.teamId,rooms:[]};
  await assert.rejects(resolvePlanningSource(fixture.request,{workspace:process.cwd(),call:exactStatus,
    loadTeam:async()=>({teamId:'d'.repeat(64),team:fixture.data.ownTeam})}),/locked team fingerprint changed/);
  compact.teamSha256='e'.repeat(64);
  assert.throws(()=>boundAction(compact,fixture.request),/session\/team changed/);
});
