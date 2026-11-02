import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {createPlanningToolClient} from './tool-client.mjs';
import {createResearchBudgetToolClient} from './research-budget.mjs';
import {createOwnedSimulationFixture} from '../simulation/owned-choice-fixture.mjs';
import {registerSimulationTools} from '../simulation/mcp-tools.mjs';
import {simulateNativeTurn} from '../simulation/turn-simulator.mjs';
import {executeSimulationChoices} from '../simulation/choice-simulation.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {createRequire} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unpackCalculationPayload} from '../workflow/calculation-archive.mjs';

const context={source:{sessionId:'test-session',teamId:'a'.repeat(64),room:'battle-gen9championsvgc2026regmcbo3-1',rqid:5,token:'b'.repeat(64)},analysis:'current'};
function fixture({exists=true,idle=false,boundContext=context}={}){
  const registrations=new Map(),calls=[],settled=[],cache=new Map();let numeric=0,simulation=0,id=0;
  const client=createResearchBudgetToolClient(createPlanningToolClient({registerTool:(name,config,handler)=>registrations.set(name,{config,handler}),tool:(name,shape,handler)=>registrations.set(name,{shape,handler})}),{
    workspace:'unused',descriptorExists:()=>exists,
    call:async(_file,command)=>{
      calls.push(structuredClone(command));
      const {category,requestSha256}=command,researchContext={source:command.source,analysis:command.analysis,...(command.freezeId?{freezeId:command.freezeId}:{})};
      const budget=()=>({calculatorsUsed:numeric,calculatorsRemaining:3-numeric,simulationsUsed:simulation,simulationsRemaining:1-simulation});
      if(command.op==='status')return {ok:true,result:{awaitingSet:!idle,searchPending:!idle,search:{searching:[],games:idle?{}:{parent:'battle'}},rooms:[]}};
      assert.deepEqual(researchContext,boundContext);
      if(command.op==='research-reserve'){
        if(cache.has(requestSha256))return {ok:true,result:{status:'reused',result:cache.get(requestSha256),budget:budget()}};
        if(category==='calculator'?numeric>=3:simulation>=1)return {ok:true,result:{status:'budget-used',budget:budget()}};
        category==='calculator'?numeric++:simulation++;
        return {ok:true,result:{status:'reserved',reservationId:`ticket-${++id}`,budget:budget()}};
      }
      assert.equal(command.op,'research-settle');settled.push(command);
      if(!command.failed){assert(command.result);cache.set(requestSha256,structuredClone(command.result));}
      return {ok:true,result:{status:command.failed?'failed':'completed',budget:budget()}};
    },
  });
  return {client,registrations,calls,settled,counts:()=>({numeric,simulation})};
}
const scalar=z.strictObject({gen:z.literal(0),value:z.number().optional()});
test('three combined registered numerical calls charge once each; fourth never invokes backend',async()=>{
  const f=fixture();let backend=0;
  for(const name of ['calculate_speed','calculate_damage','calculate_damage_range'])f.client.registerTool(name,{inputSchema:scalar},async input=>{backend++;assert(!Object.hasOwn(input,'researchContext'));return {structuredContent:{ok:true}};});
  for(const [i,name]of ['calculate_speed','calculate_damage','calculate_speed'].entries())assert.equal((await f.client.callTool(name,{gen:0,value:i,researchContext:context})).researchBudget.status,'completed');
  const refused=await f.client.callTool('calculate_damage',{gen:0,value:4,researchContext:context});assert.equal(refused.isError,true);assert.equal(backend,3);assert.equal(f.settled.length,3);
  const again=await f.client.callTool('calculate_speed',{gen:0,value:0,researchContext:context});assert.equal(again.researchBudget.status,'reused');assert.equal(again.researchBudget.budget.calculatorsRemaining,0);assert.equal(backend,3);
});
test('range outer and nested numerical callbacks share context and the same three-call cap',async()=>{
  const f=fixture();let damage=0;
  f.client.registerTool('calculate_damage',{inputSchema:scalar},async()=>{damage++;return {structuredContent:{range:[1,2]}};});
  f.client.registerTool('calculate_damage_range',{inputSchema:scalar},async()=>{
    const results=[];for(let i=0;i<4;i++)results.push(await f.client.callTool('calculate_damage',{gen:0,value:i}));
    return {structuredContent:{requested:4,completed:results.filter(r=>!r.isError).length,unavailable:results.filter(r=>r.isError).length,exhaustive:false}};
  });
  const result=await f.client.callTool('calculate_damage_range',{gen:0,researchContext:context});
  assert.deepEqual(result.structuredContent,{requested:4,completed:2,unavailable:2,exhaustive:false});assert.equal(damage,2);assert.equal(f.counts().numeric,3);
});
test('schema rejection and predispatch cancellation do not reserve; dispatched errors remain spent',async()=>{
  const f=fixture();let backend=0;f.client.registerTool('calculate_speed',{inputSchema:scalar},async()=>{backend++;return {isError:true,content:[{type:'text',text:'native error'}]};});
  await assert.rejects(f.client.callTool('calculate_speed',{gen:0,unknown:true,researchContext:context}));assert.equal(f.calls.length,0);
  const controller=new AbortController();controller.abort();await assert.rejects(f.client.callTool('calculate_speed',{gen:0,researchContext:context},{signal:controller.signal}));assert.equal(f.calls.length,0);
  const result=await f.client.callTool('calculate_speed',{gen:0,researchContext:context});assert.equal(result.isError,true);assert.equal(backend,1);assert.equal(f.settled[0].failed,true);assert.equal(f.counts().numeric,1);
});
test('active unbound callbacks refuse; absent descriptor and official idle explicit offline calls work',async()=>{
  for(const settings of [{exists:true,idle:false},{exists:false},{exists:true,idle:true}]){
    const f=fixture(settings);let backend=0;f.client.registerTool('calculate_damage',{inputSchema:scalar},async()=>{backend++;return {structuredContent:{ok:true}};});
    const result=await f.client.callTool('calculate_damage',{gen:0});
    assert.equal(backend,settings.exists===true&&!settings.idle?0:1);assert.equal(result.isError===true,backend===0);assert.equal(f.counts().numeric,0);
  }
});
test('an active direct SDK nonnative generation refuses before charging while explicit offline legacy stays usable',async()=>{
  for(const exists of [true,false]){
    const f=fixture({exists});let backend=0;f.client.registerTool('calculate_damage',{inputSchema:z.strictObject({gen:z.number()})},async()=>{backend++;return {structuredContent:{gen:9}};});
    const registered=f.registrations.get('calculate_damage'),result=await registered.handler(registered.config.inputSchema.parse({gen:9,researchContext:context}));
    assert.equal(backend,exists?0:1);assert.equal(result.isError===true,exists);assert.equal(f.calls.length,0);
  }
});
test('native SDK simulation cannot bypass one branch/seed quota and exact completed input is reused',async()=>{
  const f=fixture();let backend=0;
  const schema=z.strictObject({request:z.strictObject({kind:z.literal('explicit'),branches:z.array(z.unknown()),seeds:z.array(z.array(z.number()))})});
  for(const name of ['simulate_turn','simulate_turn_batch'])f.client.registerTool(name,{inputSchema:schema},async()=>{backend++;return {structuredContent:{samples:[{final:'board'}]}};});
  const args={request:{kind:'explicit',branches:[{id:'primary'}],seeds:[[1,2,3,4]]},researchContext:context};
  assert.equal((await f.client.callTool('simulate_turn',{...args,request:{...args.request,branches:[{},{}]}})).isError,true);
  assert.equal((await f.client.callTool('simulate_turn',{...args,request:{...args.request,seeds:[[1],[2]]}})).isError,true);
  assert.equal((await f.client.callTool('simulate_turn_batch',args)).isError,true);assert.equal(backend,0);assert.equal(f.calls.length,0);
  const first=await f.client.callTool('simulate_turn',args),again=await f.client.callTool('simulate_turn',args);assert.deepEqual(again.structuredContent,first.structuredContent);assert.equal(again.researchBudget.status,'reused');assert.equal(backend,1);
  const changed=await f.client.callTool('simulate_turn',{...args,request:{...args.request,branches:[{id:'changed'}]}});assert.equal(changed.isError,true);assert.equal(backend,1);assert.equal(f.counts().simulation,1);
});
test('source validation failure or uncertain settlement cannot return a successful research claim',async()=>{
  const f=fixture();let backend=0;f.client.registerTool('calculate_speed',{inputSchema:scalar},async()=>{backend++;throw Error('native dispatched failure');});
  await assert.rejects(f.client.callTool('calculate_speed',{gen:0,researchContext:context}),/native dispatched failure/u);assert.equal(f.settled[0].failed,true);assert.equal(backend,1);
});

test('actual native history, facade, registered callback and native session quota join without double reservation',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const {Teams}=createRequire(import.meta.url)('pokemon-showdown'),nativeCall=async(_file,command)=>f.session.execute(command);
    const client=createResearchBudgetToolClient(createPlanningToolClient({registerTool(){},tool(){}}),{workspace:'unused',descriptorExists:()=>true,call:nativeCall});
    let nativeRuns=0;registerSimulationTools(client,{run:async input=>{nativeRuns++;return simulateNativeTurn(input);}});
    const source=f.source(),args={source,ourActions:[{type:'move',slot:4},{type:'move',slot:4}],opposingActions:[{type:'move',slot:4},{type:'move',slot:4}],evidenceContext:{teamId:source.teamId,roomId:canonicalEvidenceRoom(source.room),turn:f.battle.turn}};
    const options={workspace:'unused',now:()=>f.session.now(),call:nativeCall,loadTeam:async()=>({team:Teams.unpack(f.session.packed)}),callTool:(...args)=>client.callTool(...args),recordEvidence:async()=>({sha256:'d'.repeat(64)})};
    const first=await executeSimulationChoices(args,options);assert.equal(first.kind,'native-choice-outcome-v1',first.reason);assert.equal(nativeRuns,1);
    const again=await executeSimulationChoices(args,options);assert.equal(again.kind,'native-choice-outcome-v1',again.reason);assert.equal(nativeRuns,1);assert.deepEqual(again.outcome,first.outcome);
    const changed=await executeSimulationChoices({...args,ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:4}]},options);assert.equal(changed.kind,'simulation-choices-unavailable');assert.equal(nativeRuns,1);assert.match(changed.reason,/simulation-trajectory-used/u);
    const status=f.session.researchStatus({source,analysis:'current'});assert.equal(status.budget.simulationsUsed,1);assert.equal(status.budget.calculatorsUsed,0);
    assert.equal(f.sent.filter(line=>line.includes('|/choose')).length,0,'read-only qualification never sends native battle actions');
  }finally{f.close();}
});

const actualG3T4File=new URL('../cache/team-metrics/calculations/7ca4f5e27d98d9b4116c3b02bc1c6f23b0ff0ac2507b9b38f66d2bee05691d4b--4e659c22-d5c6-44ce-aeb0-8614b27a0815.json',import.meta.url);
test('retained G3T4 history no longer spends the model three-call budget before direct questions',{skip:!existsSync(actualG3T4File)},async()=>{
  const bytes=readFileSync(actualG3T4File);assert.equal(createHash('sha256').update(bytes).digest('hex'),'254def853ceee593720edf6df37ae73ce079c2fbc7042563989eb09c39d5bcd3');
  const row=JSON.parse(bytes),{input,result,payloadArchive}=row,saved=unpackCalculationPayload({tool:'simulate_choices',...(payloadArchive?{payloadArchive}:{input,result})});
  const oldTickets=new Set(Object.values(saved.input.candidatePools).flatMap(pool=>pool.records??[]).map(record=>record.nativeReply?.researchBudget).filter(b=>b?.status==='completed').map(b=>b.reservationId));
  assert.equal(oldTickets.size,3,'the genuine historical pattern consumed all three numeric slots inside automatic filtering');
  const contextCopy=structuredClone(saved.input.sourceCapture.context),args=structuredClone(saved.input.request),before=structuredClone(args),binding={source:args.source,analysis:'current'},f=fixture({boundContext:binding});
  const {Teams}=createRequire(import.meta.url)('pokemon-showdown');let nativeRuns=0,directCalls=0;
  registerSimulationTools(f.client,{run:async value=>{nativeRuns++;return simulateNativeTurn(value);}});
  for(const name of ['calculate_damage','calculate_speed'])f.client.registerTool(name,{inputSchema:scalar},async()=>{directCalls++;return {structuredContent:{fixtureOnly:true,noNumericalClaim:true}};});
  const current=await executeSimulationChoices(args,{workspace:'offline-retained-source-regression',now:()=>contextCopy.frozenAt,
    call:async(_file,command)=>{assert.equal(command.op,'simulation-context');return {ok:true,result:structuredClone(contextCopy)};},
    loadTeam:async()=>({team:Teams.import(saved.input.sourceCapture.ownTeamText)}),callTool:(...call)=>f.client.callTool(...call),recordEvidence:async()=>({fixtureOnly:true})});
  assert.equal(current.kind,'native-choice-outcome-v1',current.reason);assert.equal(nativeRuns,1);assert.equal(current.inference.policy,'cache-only');assert.equal(current.inference.newNumericCalls,0);assert(current.inference.deferredNumericChecks>0);
  assert(current.inference.actors.some(actor=>actor.status==='representative-pool-partially-or-not-filtered'&&actor.deferredNumericChecks>0));assert.equal(f.counts().numeric,0);assert.deepEqual(args,before,'the model-authored pair and exact source are not rewritten');
  for(const [i,name]of ['calculate_damage','calculate_speed','calculate_damage'].entries())assert.equal((await f.client.callTool(name,{gen:0,value:i,researchContext:binding})).researchBudget.status,'completed');
  assert.equal(directCalls,3);assert.equal(f.counts().numeric,3);assert.equal((await f.client.callTool('calculate_speed',{gen:0,value:4,researchContext:binding})).isError,true);assert.equal(directCalls,3);assert.equal(nativeRuns,1);
  const freezeId='40ba505b-55a1-4ca1-a0e2-3b5657318f13',frozenContext={...structuredClone(contextCopy),freezeId,liveFreshness:false},frozenArgs={...structuredClone(args),analysis:'frozen',freezeId},frozenBinding={source:args.source,analysis:'frozen',freezeId},frozen=fixture({boundContext:frozenBinding});let frozenRuns=0;
  registerSimulationTools(frozen.client,{run:async value=>{frozenRuns++;return simulateNativeTurn(value);}});
  const frozenResult=await executeSimulationChoices(frozenArgs,{workspace:'offline-retained-frozen-view-regression',now:()=>contextCopy.frozenAt,
    call:async(_file,command)=>{assert.equal(command.op,'simulation-context');assert.equal(command.mode,'frozen');return {ok:true,result:structuredClone(frozenContext)};},loadTeam:async()=>({team:Teams.import(saved.input.sourceCapture.ownTeamText)}),callTool:(...call)=>frozen.client.callTool(...call),recordEvidence:async()=>({fixtureOnly:true})});
  assert.equal(frozenResult.kind,'native-choice-outcome-v1',frozenResult.reason);assert.equal(frozenResult.source.liveFreshness,false);assert.equal(frozenResult.inference.newNumericCalls,0);assert(frozenResult.inference.deferredNumericChecks>0);assert.equal(frozen.counts().numeric,0);assert.equal(frozenRuns,1);
  // This replays retained source under a stationary historical test clock. It
  // is not current battle freshness or selected-model qualification evidence;
  // the frozen marker/view is an explicitly injected read-only test fixture.
});
