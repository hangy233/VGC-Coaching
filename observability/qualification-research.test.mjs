import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {createQualificationResearchAuthority,QUALIFICATION_SETUP_TOOL} from './qualification-research.mjs';
import {createResearchBudgetToolClient} from '../planning/research-budget.mjs';
import {createPlanningToolClient} from '../planning/tool-client.mjs';
import {MODEL_TOOL_NAMES} from '../showdown/model-owned-tools.mjs';

const source={sessionId:'saved-fixture',teamId:'a'.repeat(64),room:'battle-gen9championsvgc2026regmcbo3-9900011',rqid:4,token:'b'.repeat(64)};
const current={source,analysis:'current'},frozen={source,analysis:'frozen',freezeId:'00000000-0000-4000-8000-000000000001'};
const scalar=z.strictObject({gen:z.literal(0),value:z.number().optional()});
const simulation=z.strictObject({request:z.strictObject({kind:z.literal('explicit'),branches:z.array(z.unknown()),seeds:z.array(z.array(z.number()))})});
const simArgs={request:{kind:'explicit',branches:[{id:'primary'}],seeds:[[1,2,3,4]]},researchContext:current};
function fixture({kind='turn',turn=1,contexts=[current,frozen]}={}){
  let time=10000;const authority=createQualificationResearchAuthority({now:()=>time}),spec={caseId:randomUUID(),contexts:structuredClone(contexts),turn,kind,sourceSha256:'c'.repeat(64),factsSha256:'d'.repeat(64),deadlineAt:50000};
  const registration=authority.register(spec),commands=[];
  const client=createResearchBudgetToolClient(createPlanningToolClient({registerTool(){},tool(){}}),{workspace:'unused-live-workspace',descriptorExists:authority.descriptorExists,
    call:async(...args)=>{commands.push(structuredClone(args[1]));return authority.call(...args);}});
  return {authority,client,spec,registration,commands,clock:value=>{time=value;}};
}
test('qualification uses its local registered source, while the ordinary wrapper still reaches the live authority',async()=>{
  const f=fixture();let backend=0,liveBridge=0;
  f.client.registerTool('calculate_speed',{inputSchema:scalar},async args=>{backend++;assert.deepEqual(args,{gen:0,value:1});return {structuredContent:{actualHandler:true}};});
  const normal=createResearchBudgetToolClient(createPlanningToolClient({registerTool(){},tool(){}}),{workspace:'same-live-workspace',descriptorExists:()=>true,call:async()=>{liveBridge++;return {ok:false,error:'Historical source differs from existing idle live session'};}});
  normal.registerTool('calculate_speed',{inputSchema:scalar},async()=>{assert.fail('Live source guard must refuse');});
  assert.equal((await normal.callTool('calculate_speed',{gen:0,researchContext:current})).isError,true);assert.equal(liveBridge,1);
  const result=await f.client.callTool('calculate_speed',{gen:0,value:1,researchContext:current});
  assert.equal(result.structuredContent.actualHandler,true);assert.equal(result.researchBudget.status,'completed');assert.equal(backend,1);assert.equal(liveBridge,1);
  assert.deepEqual(f.commands.map(c=>c.op),['research-reserve','research-settle']);assert.equal(f.registration.liveDescriptorAccessed,false);assert.equal(f.registration.liveQuotaExercised,false);
  assert.equal(MODEL_TOOL_NAMES.includes(QUALIFICATION_SETUP_TOOL),false);
});
test('nested range work and direct current/frozen questions share exactly three reserved callbacks',async()=>{
  const f=fixture();let damage=0;
  f.client.registerTool('calculate_damage',{inputSchema:scalar},async()=>{damage++;return {structuredContent:{range:[1,2]}};});
  f.client.registerTool('calculate_damage_range',{inputSchema:scalar},async()=>{
    const results=[];for(let i=0;i<4;i++)results.push(await f.client.callTool('calculate_damage',{gen:0,value:i}));
    return {structuredContent:{completed:results.filter(x=>!x.isError).length,unavailable:results.filter(x=>x.isError).length,exhaustive:false}};
  });
  const result=await f.client.callTool('calculate_damage_range',{gen:0,researchContext:current});
  assert.deepEqual(result.structuredContent,{completed:2,unavailable:2,exhaustive:false});assert.equal(damage,2);assert.equal(result.researchBudget.budget.calculatorsUsed,3);
  assert.equal((await f.client.callTool('calculate_damage',{gen:0,value:8,researchContext:frozen})).structuredContent.status,'budget-used');assert.equal(damage,2);
});
test('identical completed work reuses exact results; a second changed trajectory never dispatches',async()=>{
  const f=fixture();let numeric=0,simulations=0;
  f.client.registerTool('calculate_speed',{inputSchema:scalar},async args=>{numeric++;return {structuredContent:{value:args.value}};});
  f.client.registerTool('simulate_turn',{inputSchema:simulation},async()=>{simulations++;return {structuredContent:{samples:[{turnComplete:false,pendingMoves:['fixture']} ]}};});
  const a=await f.client.callTool('calculate_speed',{gen:0,value:1,researchContext:current}),b=await f.client.callTool('calculate_speed',{gen:0,value:1,researchContext:current});
  assert.deepEqual(a.structuredContent,b.structuredContent);assert.equal(b.researchBudget.status,'reused');assert.equal(numeric,1);
  const first=await f.client.callTool('simulate_turn',simArgs),same=await f.client.callTool('simulate_turn',simArgs);
  assert.deepEqual(first.structuredContent,same.structuredContent);assert.equal(same.researchBudget.status,'reused');assert.equal(simulations,1);
  assert.equal((await f.client.callTool('simulate_turn',{...simArgs,request:{...simArgs.request,branches:[{id:'different'}]}})).structuredContent.status,'budget-used');assert.equal(simulations,1);
});
test('pending identical dispatch is explicit and cannot start a duplicate or refresh its source',async()=>{
  const f=fixture();let release,started=0;
  f.client.registerTool('simulate_turn',{inputSchema:simulation},async()=>{started++;await new Promise(resolve=>{release=resolve;});return {structuredContent:{samples:[{}]}};});
  const first=f.client.callTool('simulate_turn',simArgs);while(!release)await new Promise(resolve=>setImmediate(resolve));
  const pending=await f.client.callTool('simulate_turn',simArgs);assert.equal(pending.structuredContent.status,'pending');assert.equal(started,1);
  assert.throws(()=>f.authority.register({...f.spec,caseId:randomUUID()}),/unsettled/u);
  release();await first;assert.equal((await f.client.callTool('simulate_turn',simArgs)).researchBudget.status,'reused');
});
test('missing, changed and wrong frozen bindings fail before any handler; schema failure also costs no quota',async()=>{
  const f=fixture();let backend=0;f.client.registerTool('calculate_speed',{inputSchema:scalar},async()=>{backend++;return {structuredContent:{}};});
  for(const context of [undefined,{...current,source:{...source,rqid:5}},{...current,source:{...source,token:'e'.repeat(64)}},{...frozen,freezeId:randomUUID()}]){
    const result=await f.client.callTool('calculate_speed',{gen:0,...(context?{researchContext:context}:{})});assert.equal(result.isError,true);
  }
  await assert.rejects(f.client.callTool('calculate_speed',{gen:0,unknown:true,researchContext:current}));assert.equal(backend,0);
  const result=await f.client.callTool('calculate_speed',{gen:0,researchContext:frozen});assert.equal(result.researchBudget.budget.calculatorsUsed,1);
});
test('failed and cancelled dispatched work is spent; neither can become a cached successful trajectory',async()=>{
  for(const cancel of [false,true]){
    const f=fixture(),controller=new AbortController();let backend=0;
    f.client.registerTool('simulate_turn',{inputSchema:simulation},async()=>{backend++;if(cancel){controller.abort();return {structuredContent:{uncertainAfterAbort:true}};}throw Error('native fixture failed after dispatch');});
    if(cancel){const result=await f.client.callTool('simulate_turn',simArgs,{signal:controller.signal});assert.equal(result.researchBudget.status,'failed');}
    else await assert.rejects(f.client.callTool('simulate_turn',simArgs),/native fixture failed/u);
    const second=await f.client.callTool('simulate_turn',simArgs);assert.equal(second.structuredContent.status,'budget-used');assert.equal(backend,1);
  }
});
test('original cutoff is immutable; late successful work is not reusable and predispatch cancellation costs nothing',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();let backend=0;
  f.client.registerTool('calculate_speed',{inputSchema:scalar},async()=>{backend++;f.clock(50000);return {structuredContent:{late:true}};});
  await assert.rejects(f.client.callTool('calculate_speed',{gen:0,researchContext:current},{signal:abort.signal}));assert.equal(backend,0);
  assert.throws(()=>f.authority.register({...f.spec,deadlineAt:49999}),/cannot change/u);
  const late=await f.client.callTool('calculate_speed',{gen:0,researchContext:current});assert.equal(late.researchBudget.status,'failed');
  assert.equal((await f.client.callTool('calculate_speed',{gen:0,researchContext:current})).isError,true);assert.equal(backend,1);
});
test('preview uses its own turn-zero budget; batch and multi-branch bypasses never dispatch',async()=>{
  const f=fixture({kind:'preview',turn:0});let backend=0;
  f.client.registerTool('calculate_speed',{inputSchema:scalar},async()=>{backend++;return {structuredContent:{}};});
  f.client.registerTool('simulate_turn',{inputSchema:simulation},async()=>{assert.fail('Preview cannot simulate');});
  f.client.registerTool('simulate_turn_batch',{inputSchema:simulation},async()=>{assert.fail('Batch cannot bypass');});
  assert.equal((await f.client.callTool('calculate_speed',{gen:0,researchContext:current})).researchBudget.budget.calculatorsUsed,1);
  for(const name of ['simulate_turn','simulate_turn_batch'])assert.equal((await f.client.callTool(name,simArgs)).isError,true);
  assert.equal((await f.client.callTool('simulate_turn',{...simArgs,request:{...simArgs.request,branches:[{},{}]}})).isError,true);assert.equal(backend,1);
});
