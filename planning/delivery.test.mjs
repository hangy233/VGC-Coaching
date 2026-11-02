import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {checkDelivery,deliveryCheckSchema} from './delivery.mjs';
import {executeSimulation,executeSimulationBatch} from '../simulation/mcp-tools.mjs';
import {openingFixture,currentFixture} from '../simulation/fixtures.mjs';
import {fixture as observedFixture} from '../simulation/observed-position.fixtures.mjs';
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const nativeTool=async(name,args)=>{assert.ok(['simulate_turn','simulate_turn_batch'].includes(name));return {structuredContent:await (name==='simulate_turn_batch'?executeSimulationBatch:executeSimulation)(args)};};
function requestFixture(){
  const f=openingFixture();f.position.sides[0].pokemon[1].ability='Sap Sipper';f.position.sides[1].pokemon[1].moves[3]='Protect';
  Object.assign(f.branches[0],{ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:4}],opposingActions:[{type:'move',slot:3,target:1},{type:'move',slot:4}]});
  return {kind:'explicit',...f};
}
test('delivery batches explicitly distinct candidate pairs through one injected simulation tool',async()=>{
  const request=requestFixture(),calls=[],before=structuredClone(request);
  const candidates=[{id:'attack',label:'Explicit attack hypothesis',ourActions:request.branches[0].ourActions},{id:'switch',ourActions:[{type:'switch',pokemonId:'toed'},{type:'move',slot:4}]}];
  const result=await checkDelivery({request,candidates,objective:{requiredActionsBy:['arch']}},{callTool:async(...args)=>{calls.push(args);return nativeTool(...args);}});
  assert.deepEqual(request,before);assert.equal(calls.length,1);assert.equal(calls[0][0],'simulate_turn_batch');
  assert.deepEqual(calls[0][1].request.cases.map(entry=>entry.branches[0].ourActions),candidates.map(candidate=>candidate.ourActions));
  assert.equal(result.coverage.batched,true);
  assert.deepEqual(result.checkedCandidates.map(candidate=>candidate.status),['sampled-failure','sampled-pass']);
  assert.ok(result.uncoveredRequiredActors.some(warning=>warning.actorId==='arch'&&warning.reason.includes('Protect by fari')));
  assert.ok(result.sampledAdverseBranches.some(branch=>branch.candidateId==='attack'&&branch.denials.some(event=>event.type==='cant')));
  assert.deepEqual(result.hypotheses,request.hypotheses);assert.deepEqual(result.seeds,request.seeds);assert.equal(result.selectedCandidate,undefined);
});
test('delivery rejects same branch/seed evidence from another own pair',async()=>{
  const request=requestFixture();
  const result=await checkDelivery({request,objective:{requiredActionsBy:['arch']}},{callTool:async(name,args)=>{
    const reply=structuredClone(await nativeTool(name,args));reply.structuredContent.testedBranches=structuredClone(reply.structuredContent.testedBranches);reply.structuredContent.testedBranches[0].ourActions[0]={type:'switch',pokemonId:'toed'};return reply;
  }});
  assert.equal(result.checkedCandidates[0].checked,false);assert.equal(result.checkedCandidates[0].status,'refused');assert.match(result.unknowns[0].reason,/different own pair/);
});
test('delivery preserves unsupported current state and tool refusal as unknown coverage',async()=>{
  const f=currentFixture();delete f.position.sides[0].pokemon[0].lifecycle;
  const result=await checkDelivery({request:{kind:'explicit',...f},objective:{requiredActionsBy:['arch']}},{callTool:nativeTool});
  assert.equal(result.coverage.checkedCandidates,0);assert.match(result.unknowns[0].reason,/require exact/);
  const refused=await checkDelivery({request:requestFixture(),objective:{requiredActionsBy:['arch']}},{callTool:async()=>({isError:true,content:[{type:'text',text:'passed'}]})});
  assert.equal(refused.coverage.checkedCandidates,0);assert.equal(refused.checkedCandidates[0].status,'refused');
});
test('delivery aggregate budget bounds research without invoking another candidate or any control tool',async()=>{
  const request=requestFixture(),calls=[];
  const result=await checkDelivery({request,candidates:[{id:'first',ourActions:request.branches[0].ourActions},{id:'second',ourActions:request.branches[0].ourActions}],objective:{requiredActionsBy:['arch']},budgetMs:20},{callTool:async(name,_args,options)=>{calls.push(name);return await new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve({isError:true}),{once:true}));}});
  assert.deepEqual(calls,['simulate_turn_batch']);assert.equal(result.coverage.checkedCandidates,0);assert.equal(result.unknowns.length,2);
});
test('a synchronous late tool result remains late/unknown even when its sampled native gate passed',async()=>{
  const request=requestFixture();request.position.sides[0].pokemon[1].ability='Armor Tail';request.branches[0].gate={kind:'delivery',requiredActionsBy:['arch']};
  const response=await nativeTool('simulate_turn',{request});assert.equal(response.structuredContent.samples[0].gate.passed,true);
  const result=await checkDelivery({request,budgetMs:5},{callTool:()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);return response;}});
  const candidate=result.checkedCandidates[0];assert.equal(candidate.status,'unknown');assert.equal(candidate.checked,false);assert.equal(candidate.lateEvidence.credited,false);assert.equal(candidate.lateEvidence.reportedSamples[0].reportedGatePassed,true);assert.equal(result.coverage.checkedCandidates,0);
});
test('delivery validates complete candidates and requires an injected actual tool',async()=>{
  assert.throws(()=>deliveryCheckSchema.parse({request:requestFixture(),candidates:[{id:'half',ourActions:[{type:'move',slot:1,target:1}]}]}));
  await assert.rejects(checkDelivery({request:requestFixture()}),/injected MCP/);
  const source=readFileSync(new URL('./delivery.mjs',import.meta.url),'utf8');
  assert.ok(!source.includes('simulateNativeTurn('));assert.ok(!source.includes('runTurnSimulation('));assert.ok(!source.includes("callTool('calculate_"));
});
test('delivery observed source binds switch candidate to actual normalized own identity',async()=>{
  const f=observedFixture(),source={...f.expected,sessionId:f.observed.sessionId},full={sessionId:source.sessionId,teamSha256:source.teamId,rooms:[{id:source.room,sheets:{}}]};
  f.observed.boards[0].opponentSheets=f.observed.opponentSheets;
  const request={kind:'observed',source,hypotheses:f.hypotheses,seeds:[[1,2,3,4]],branches:[{id:'observed-switch',ourActions:[{type:'switch',slot:3},{type:'move',slot:4}],opposingActions:[{type:'move',slot:4},{type:'move',slot:4,target:2}],gate:{kind:'delivery',requiredActionsBy:['own0'],survive:['own2']}}]};
  const reads=[];
  const result=await checkDelivery({request},{callTool:async(name,args)=>{assert.equal(name,'simulate_turn');assert.equal(args.evidenceContext.teamId,source.teamId);return {structuredContent:await executeSimulation(args,{workspace:'offline-delivery-fixture',loadTeam:async()=>({team:Teams.import(f.teamText)}),call:async(_path,command)=>{reads.push(command.op);return {ok:true,result:structuredClone(command.op==='status'?full:f.observed)};},recordEvidence:async entry=>({id:'offline-delivery',...entry.context,tool:'simulate_turn'})})};}});
  assert.equal(result.checkedCandidates[0].checked,true,JSON.stringify(result.unknowns));assert.deepEqual(result.checkedCandidates[0].ourActions,request.branches[0].ourActions);assert.equal(result.checkedCandidates[0].source.sessionId,source.sessionId);assert.deepEqual(reads,['turn-status','status','turn-status']);
});

test('batch case identity and complete coverage are required and an unavailable tool never silently falls back',async()=>{
  const request=requestFixture(),candidates=[{id:'one',ourActions:request.branches[0].ourActions},{id:'two',ourActions:[{type:'switch',pokemonId:'toed'},{type:'move',slot:4}]}];
  for(const mutate of [result=>{result.cases.pop();},result=>{result.cases[1].id=result.cases[0].id;}]){
    const result=await checkDelivery({request,candidates,objective:{requiredActionsBy:['arch']}},{callTool:async(name,args)=>{const reply=await nativeTool(name,args);mutate(reply.structuredContent);return reply;}});
    assert.equal(result.coverage.checkedCandidates,0);assert.ok(result.unknowns.every(entry=>/case coverage/.test(entry.reason)));
  }
  const calls=[],missing=await checkDelivery({request,candidates,objective:{requiredActionsBy:['arch']}},{callTool:async name=>{calls.push(name);throw new Error('Unknown tool simulate_turn_batch');}});
  assert.deepEqual(calls,['simulate_turn_batch']);assert.equal(missing.coverage.checkedCandidates,0);assert.ok(missing.unknowns.every(entry=>/Unknown tool/.test(entry.reason)));
});

test('late batch results cannot promote any candidate despite native sampled passes',async()=>{
  const request=requestFixture(),candidates=[{id:'one',ourActions:[{type:'switch',pokemonId:'toed'},{type:'move',slot:4}]},{id:'two',ourActions:[{type:'switch',pokemonId:'sylv'},{type:'move',slot:4}]}];
  const prepared=await checkDelivery({request,candidates,objective:{requiredActionsBy:['arch']}},{callTool:nativeTool});assert.equal(prepared.coverage.checkedCandidates,2);
  let response;
  await checkDelivery({request,candidates,objective:{requiredActionsBy:['arch']}},{callTool:async(name,args)=>{response=await nativeTool(name,args);return response;}});
  const late=await checkDelivery({request,candidates,objective:{requiredActionsBy:['arch']},budgetMs:5},{callTool:()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);return response;}});
  assert.equal(late.coverage.checkedCandidates,0);assert.ok(late.checkedCandidates.every(entry=>entry.status==='unknown'&&entry.lateEvidence.credited===false));
});
