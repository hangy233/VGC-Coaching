// Actual local MCP subprocesses and registered calculators only. No model,
// battle client startup, authentication, descriptor mutation or battle action.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connectOfflineNumericClient} from './numeric-client.mjs';
import {QUALIFICATION_SETUP_TOOL} from './qualification-research.mjs';
import {MODEL_TOOL_NAMES,modelToolDefinition} from '../showdown/model-owned-tools.mjs';
import {openingFixture} from '../simulation/fixtures.mjs';

const source={sessionId:'offline-sdk-fixture',teamId:'a'.repeat(64),room:'battle-gen9championsvgc2026regmcbo3-9900021',rqid:4,token:'b'.repeat(64)};
const current={source,analysis:'current'},freezeId='00000000-0000-4000-8000-000000000002',frozen={source,analysis:'frozen',freezeId};
const spec=()=>({caseId:randomUUID(),contexts:[current,frozen],turn:1,kind:'turn',sourceSha256:'c'.repeat(64),factsSha256:'d'.repeat(64),deadlineAt:Date.now()+40000});
const speed=label=>({gen:0,pokemon:[{species:'Pikachu',label,nature:'Timid',ability:'Static',statPoints:{spe:32}}]});
const points={hp:0,atk:0,def:0,spa:0,spd:0,spe:0};
const range=()=>({gen:0,attacker:'Blastoise',attackerOptions:{ability:'Torrent',item:''},defender:'Venusaur',defenderOptions:{ability:'Overgrow',item:''},move:'Ice Beam',field:{gameType:'Doubles'},
  attackerDomain:{kind:'candidates',label:'Two synthetic allocations; no battle claim',candidates:[{nature:'Modest',statPoints:{...points,spa:31}},{nature:'Modest',statPoints:{...points,spa:32}}]},
  defenderDomain:{kind:'candidates',label:'One synthetic allocation; no battle claim',candidates:[{nature:'Serious',statPoints:{...points,hp:32}}]},work:{maxCalculations:2,requireExhaustive:true}});

test('ordinary numeric connector retains its default catalog; explicit qualification child exposes no live controls',{timeout:20000},async()=>{
  const ordinary=await connectOfflineNumericClient();
  try{const catalog=await ordinary.client.listTools();assert(catalog.tools.some(t=>t.name==='battle_status'));assert(!catalog.tools.some(t=>t.name===QUALIFICATION_SETUP_TOOL));assert.equal(ordinary.registerQualificationCase,undefined);}
  finally{await ordinary.close();}
  const isolated=await connectOfflineNumericClient({qualificationOnly:true});
  try{
    const catalog=await isolated.client.listTools();assert(catalog.tools.some(t=>t.name===QUALIFICATION_SETUP_TOOL));
    assert(!catalog.tools.some(t=>/^battle_(?:start|stop|status|forfeit|control_)/u.test(t.name)));
    const author=catalog.tools.filter(t=>MODEL_TOOL_NAMES.includes(t.name)&&!['simulate_turn','battle_check_plan'].includes(t.name)).map(modelToolDefinition);
    assert.equal(author.length,8);assert(!author.some(t=>t.name===QUALIFICATION_SETUP_TOOL));
    const refused=await isolated.client.callTool({name:'calculate_speed',arguments:{...speed('unregistered'),researchContext:current}});assert.equal(refused.isError,true);
    const registration=await isolated.registerQualificationCase(spec());assert.equal(registration.liveDescriptorAccessed,false);assert.equal(registration.liveQuotaExercised,false);
    const first=await isolated.client.callTool({name:'calculate_speed',arguments:{...speed('first'),researchContext:current}});
    assert.equal(first.isError,undefined);assert.equal(JSON.parse(first.content[0].text).gen,0);assert.equal(first.researchBudget.status,'completed');
    const cached=await isolated.client.callTool({name:'calculate_speed',arguments:{...speed('first'),researchContext:current}});assert.equal(cached.researchBudget.status,'reused');assert.deepEqual(cached.content,first.content);
    for(const [label,context]of [['second',frozen],['third',current]])assert.equal((await isolated.client.callTool({name:'calculate_speed',arguments:{...speed(label),researchContext:context}})).researchBudget.status,'completed');
    const fourth=await isolated.client.callTool({name:'calculate_speed',arguments:{...speed('fourth'),researchContext:frozen}});assert.equal(fourth.isError,true);assert.equal(fourth.structuredContent.status,'budget-used');assert.equal(fourth.structuredContent.budget.calculatorsUsed,3);
  }finally{await isolated.close();}
});

test('actual saved-source range and nested native damage calls consume the same three callback units',{timeout:20000},async()=>{
  const sdk=await connectOfflineNumericClient({qualificationOnly:true});
  try{
    await sdk.registerQualificationCase(spec());
    const result=await sdk.client.callTool({name:'calculate_damage_range',arguments:{...range(),researchContext:frozen}});
    assert.equal(result.isError,undefined,JSON.stringify(result));assert.equal(result.structuredContent.coverage.completed,2);assert.equal(result.structuredContent.coverage.exhaustive,true);
    assert.equal(result.researchBudget.budget.calculatorsUsed,3);assert.equal(result.researchBudget.budget.calculatorsRemaining,0);
    const refused=await sdk.client.callTool({name:'calculate_speed',arguments:{...speed('after-range'),researchContext:current}});assert.equal(refused.isError,true);assert.equal(refused.structuredContent.status,'budget-used');
    const changed=await sdk.client.callTool({name:'calculate_speed',arguments:{...speed('wrong-source'),researchContext:{...current,source:{...source,rqid:5}}}});assert.equal(changed.isError,true);assert.equal(changed.structuredContent.kind,'research-budget-unavailable');
  }finally{await sdk.close();}
});

test('actual isolated native simulation dispatches one trajectory, reuses it, and refuses a changed second input',{timeout:20000},async()=>{
  const sdk=await connectOfflineNumericClient({qualificationOnly:true});
  try{
    await sdk.registerQualificationCase(spec());
    const request={kind:'explicit',...openingFixture()},arguments_={request,researchContext:current};
    const first=await sdk.client.callTool({name:'simulate_turn',arguments:arguments_});
    assert.equal(first.isError,undefined,JSON.stringify(first));assert.equal(first.structuredContent.engine.gen,0);assert.equal(first.structuredContent.samples.length,1);assert.equal(first.researchBudget.status,'completed');
    const reused=await sdk.client.callTool({name:'simulate_turn',arguments:arguments_});assert.equal(reused.researchBudget.status,'reused');assert.deepEqual(reused.structuredContent,first.structuredContent);
    const changed=structuredClone(arguments_);changed.request.seeds=[[5,6,7,8]];
    const refused=await sdk.client.callTool({name:'simulate_turn',arguments:changed});assert.equal(refused.isError,true);assert.equal(refused.structuredContent.status,'budget-used');assert.equal(refused.structuredContent.budget.simulationsUsed,1);
  }finally{await sdk.close();}
});
