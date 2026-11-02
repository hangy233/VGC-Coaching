import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createResearchService,researchPrepareSchema} from './research-service.mjs';
import {currentFixture} from '../simulation/observed-position.fixtures.mjs';
import {publishedSheetDigest,buildObservedPosition} from '../simulation/observed-position.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {digest} from './identity.mjs';
import {registerPlanningTools} from './mcp-tools.mjs';
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');

// Orchestration fixtures only. No real numerical result, live client or model
// decision is represented by this handler or its deliberately synthetic reply.
function fixture(){
  const native=currentFixture(),request={kind:'observed',sessionId:native.observed.sessionId,...native.expected};
  const board=native.observed.boards[0];board.opponentSheets={p2:structuredClone(native.opposingSheet)};
  const state={...native.observed,teamSha256:request.teamId,connected:true,authenticated:true,stopped:false,controlPolicy:{pending:[]}};
  const calls=[],cache=new Map(),ourActions=[{type:'move',slot:1,target:1},{type:'move',slot:4}];
  const plan={id:'authored-turn',label:'Synthetic explicit branches; no opponent prediction',ourActions,
    branches:[{id:'first',opposingActions:[{type:'move',slot:4},{type:'move',slot:4}],gate:{kind:'delivery',requiredActionsBy:['own1']}},
      {id:'second',opposingActions:[{type:'move',slot:1,target:1},{type:'move',slot:4}],gate:{kind:'delivery',requiredActionsBy:['own1']}}],seeds:[[1,2,3,4],[5,6,7,8]]};
  const options={workspace:process.cwd(),researchCache:cache,
    call:async(_descriptor,{op})=>({ok:true,result:op==='status'?{sessionId:request.sessionId,teamSha256:request.teamId,rooms:[]} : structuredClone(state)}),
    loadTeam:async()=>({teamId:request.teamId,team:Teams.import(native.teamText)}),
    callTool:Object.assign(async(name,args)=>{calls.push({name,args:structuredClone(args)});return {structuredContent:{kind:'synthetic-orchestration-reply',noNumericalClaim:true}};},{runtimeVersion:'observed-preparation-fixture-1'})};
  const input={request,reconstructionHypotheses:structuredClone(native.hypotheses),observedSimulations:[plan],focus:[{authoredId:plan.id}],budgetMs:3500};
  return {native,request,state,board,calls,cache,options,input,plan};
}

test('observed shorthand compiles exact native inputs into the existing catalog without dispatch',async()=>{
  const f=fixture(),service=createResearchService(f.options),before=structuredClone(f.input),menu=await service.prepare(f.input);
  assert.deepEqual(f.input,before);assert.equal(menu.kind,'champions-research-menu');assert.equal(menu.focusReady,true);
  assert.equal(menu.reconstructionReadiness.ready,true);assert.equal(f.calls.length,0);assert.equal(f.cache.size,1);
  assert.equal(menu.observedPreparation.receipts.length,1);assert.equal(menu.observedPreparation.dispatches,0);
  const entry=f.cache.get(menu.catalogId),ticket=entry.catalog.tickets.find(row=>row.name==='simulate_turn');
  assert.equal(ticket.args.request.kind,'observed');assert.equal(ticket.args.request.source.sessionId,f.request.sessionId);
  assert.equal(ticket.args.request.source.opposingSheetSha256,publishedSheetDigest(f.native.opposingSheet));
  assert.equal(entry.catalog.binding.source.publishedOpposingSheetSha256,ticket.args.request.source.opposingSheetSha256);
  assert.notEqual(entry.catalog.binding.source.opposingSheetSha256,entry.catalog.binding.source.publishedOpposingSheetSha256);
  assert.deepEqual(ticket.args.request.hypotheses,f.input.reconstructionHypotheses);
  assert.deepEqual(ticket.args.request.seeds,f.plan.seeds);
  assert(ticket.args.request.branches.every((row,index)=>{
    assert.deepEqual(row.ourActions,f.plan.ourActions);assert.deepEqual(row.opposingActions,f.plan.branches[index].opposingActions);return true;
  }));
  assert.deepEqual(ticket.args.evidenceContext,{teamId:f.request.teamId,roomId:canonicalEvidenceRoom(f.request.room),turn:f.board.turn});
  const selection={catalogId:menu.catalogId,ids:menu.selectedIds,actions:f.plan.ourActions};
  assert.equal((await service.resolve(selection)).status,'resolved');assert.equal(f.calls.length,0);
  const result=await service.run({catalogId:menu.catalogId,ids:menu.selectedIds});assert.equal(result.status,'complete');
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0],{name:'simulate_turn',args:ticket.args});
});

test('public mixed preparation retains the original three-question limit and eligibility never rejects a valid catalog',async()=>{
  const f=fixture(),service=createResearchService(f.options),initial=await service.prepare(f.input);
  const originalArgs=structuredClone(f.cache.get(initial.catalogId).catalog.tickets.find(row=>row.name==='simulate_turn').args);
  const fullyAuthored=[0,1].map(index=>{const args=structuredClone(originalArgs);args.request.seeds=[[9+index,10+index,11+index,12+index]];return {id:'full-'+index,label:'Fully authored native question '+index,name:'simulate_turn',args};});
  const input={...structuredClone(f.input),simulationRequests:fullyAuthored,focus:[{authoredId:f.plan.id},...fullyAuthored.map(row=>({authoredId:row.id}))]},before=structuredClone(input),handlers=new Map();
  registerPlanningTools({registerTool:(name,config,handler)=>handlers.set(name,{config,handler})},f.options);
  const tool=handlers.get('battle_prepare_checks'),reply=await tool.handler(tool.config.inputSchema.parse(input));assert.equal(reply.isError,undefined);assert.deepEqual(input,before);
  const menu=reply.structuredContent,tickets=f.cache.get(menu.catalogId).catalog.tickets;assert.equal(menu.focusReady,true);assert.equal(menu.selectedIds.length,3);assert.equal(tickets.length,3);assert.equal(f.calls.length,0);
  for(const authored of fullyAuthored){const ticket=tickets.find(row=>row.questions.some(question=>question.authoredId===authored.id));assert.deepEqual(ticket.args,authored.args);}
  const card=menu.simulationCaseEligibility;assert.equal(card.coverage.checks,3);assert(Buffer.byteLength(JSON.stringify(card))<=4096);assert.equal(card.coverage.calculationsRun,0);
  if(card.complete){assert.equal(card.checks.length,3);assert.deepEqual(new Set(card.checks.map(row=>row.checkId)),new Set(menu.selectedIds));}else{assert.equal(card.status,'over-budget');assert.deepEqual(card.checks,[]);assert.equal(card.coverage.omittedChecks,3);}
  const six={...structuredClone(input),observedSimulations:[0,1,2].map(index=>({...structuredClone(f.plan),id:'observed-'+index})),simulationRequests:[...structuredClone(fullyAuthored),{...structuredClone(fullyAuthored[0]),id:'full-third'}]};
  assert.equal(researchPrepareSchema.safeParse(six).success,true,'Both arrays independently allow three; the existing combined guard remains authoritative');
  const cacheBefore=f.cache.size,refused=await tool.handler(tool.config.inputSchema.parse(six));assert.equal(refused.isError,true);assert.match(refused.content[0].text,/at most three total authored simulation questions/);assert.equal(f.cache.size,cacheBefore);assert.equal(f.calls.length,0);
});

test('unsupported eligibility remains advisory unavailable while exact native preparation stays available',async()=>{
  const f=fixture(),service=createResearchService(f.options),initial=await service.prepare(f.input),args=structuredClone(f.cache.get(initial.catalogId).catalog.tickets.find(row=>row.name==='simulate_turn').args);
  args.request.branches[0].ourActions[0]={type:'switch',pokemonId:'unknown-control-identity'};
  const input={request:f.input.request,simulationRequests:[{id:'unresolved-control-identity',label:'Authored input still requires native acceptance',name:'simulate_turn',args}],focus:[{authoredId:'unresolved-control-identity'}]},before=structuredClone(args);
  const menu=await service.prepare(input);assert.equal(menu.focusReady,true);assert.equal(f.calls.length,0);assert.deepEqual(args,before);assert.deepEqual(f.cache.get(menu.catalogId).catalog.tickets[0].args,args);
  const card=menu.simulationCaseEligibility;assert.equal(card.complete,false);assert.equal(card.status,'incomplete');assert.equal(card.checks[0].status,'unavailable');assert.deepEqual(card.checks[0].cases,[]);assert.equal(card.coverage.calculationsRun,0);
});

test('blocked reconstruction retains its refusal and exposes only separately selected independent inputs',async()=>{
  for(const hypotheses of [undefined,{mode:'current'}]){
    const f=fixture();if(hypotheses===undefined)delete f.input.reconstructionHypotheses;else f.input.reconstructionHypotheses=hypotheses;
    const menu=await createResearchService(f.options).prepare(f.input);
    assert.equal(menu.status,'blocked');assert.equal(menu.reconstructionReadiness.ready,false);assert.equal(menu.focusReady,false);
    assert.equal(menu.catalogId,undefined);assert.equal(menu.selectedIds,undefined);assert.equal(f.calls.length,0);
    const independent=menu.independentChecks;assert.equal(independent.requestedSimulationStatus,'blocked');assert.equal(independent.requiresExplicitSelection,true);
    assert(Buffer.byteLength(JSON.stringify(independent))<=4096,'the independent menu including routing metadata keeps its byte bound');
    assert(Buffer.byteLength(JSON.stringify(menu))<=9216,'two bounded cards and fixed refusal metadata bound the blocked response');
    assert.equal(independent.focusReady,false);assert.equal(independent.selectedIds,undefined);assert.equal(independent.stored,true);assert.equal(f.cache.size,1);
    assert(independent.tickets.every(row=>['calculate_damage','calculate_speed'].includes(row.name)));
    const entry=f.cache.get(independent.catalogId);assert.deepEqual(entry.input.observedSimulations,[]);assert.deepEqual(entry.input.simulationRequests,[]);
    assert.equal(entry.input.hypotheses.length,0,'reconstruction assumptions cannot become numerical investments');
    assert(entry.catalog.tickets.filter(row=>row.name==='calculate_speed').every(row=>row.args.pokemon.every(actor=>actor.label.startsWith('own'))));
    assert(independent.unavailable.some(row=>row.kind==='damage-range'),'missing opposing investments remain unavailable');
    assert(menu.reconstructionReadiness.counts.blockers[0]>0);
  }
});

function namedNumericalHypothesis(){
  const points=value=>({hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...value});
  return {id:'explicit-active-investments',label:'Synthetic named active allocations; no reserve or lifecycle assumption',pokemon:{
    foe0:{statPoints:points({spa:32,spd:2,spe:32})},foe1:{statPoints:points({hp:32,atk:32,def:2})}}};
}

test('named independent damage/order inputs resolve despite missing PP/reserve reconstruction, without becoming a simulation',async()=>{
  const f=fixture();delete f.input.reconstructionHypotheses;f.input.hypotheses=[namedNumericalHypothesis()];
  f.input.focus.push({kind:'damage-range',scenarioId:'explicit-active-investments',attackerId:'foe1',defenderId:'own0',move:'High Horsepower',route:'active'},
    {kind:'move-order',scenarioId:'explicit-active-investments'});
  const before=structuredClone(f.input),service=createResearchService(f.options),menu=await service.prepare(f.input),independent=menu.independentChecks;
  assert.deepEqual(f.input,before);assert.equal(menu.status,'blocked');assert.equal(menu.focusReady,false);assert.equal(menu.selectedIds,undefined);
  assert.equal(independent.status,'prepared-independent');assert.equal(independent.stored,true);assert.equal(independent.focusReady,true);
  const entry=f.cache.get(independent.catalogId),damage=entry.catalog.tickets.find(row=>row.name==='calculate_damage'&&row.questions.some(question=>
    question.scenarioId==='explicit-active-investments'&&question.attackerId==='foe1'&&question.defenderId==='own0'&&question.move==='High Horsepower'));
  const order=entry.catalog.tickets.find(row=>row.name==='calculate_speed'&&row.questions.some(question=>question.scenarioId==='explicit-active-investments'));
  assert(damage);assert(order);assert(order.args.pokemon.some(actor=>actor.label==='foe0'));assert(order.args.pokemon.some(actor=>actor.label==='foe1'));
  assert(independent.tickets.some(row=>row.id===damage.id),'the supported incoming question is actually selectable from the public route');
  assert(independent.tickets.some(row=>row.id===order.id),'the named order question is actually selectable from the public route');
  assert(damage.questions.every(question=>question.scope.includes('no joint removal or delivery guarantee')));
  assert.equal(damage.args.attacker,'Rillaboom');assert.equal(damage.args.defender,'Archaludon');
  const selection={catalogId:independent.catalogId,ids:[damage.id,order.id],actions:f.plan.ourActions,includeNativeInputs:true};
  const resolved=await service.resolve(selection);assert.equal(resolved.status,'resolved');assert.deepEqual(resolved.calls.map(row=>row.name),['calculate_damage','calculate_speed']);
  assert.deepEqual(resolved.calls[0].args,damage.args);assert.deepEqual(resolved.calls[1].args,order.args);assert.equal(f.calls.length,0);
  assert(entry.catalog.tickets.every(row=>!row.name.startsWith('simulate_')));
  assert.equal(entry.input.reconstructionHypotheses,undefined,'resolving a narrow check does not complete absent reconstruction facts');
  // Deliberately synthetic refused handler: only an explicit selected ID
  // dispatches, and refusal contributes no numerical result or paired proof.
  f.options.callTool=Object.assign(async(name,args)=>{f.calls.push({name,args:structuredClone(args)});return {isError:true,content:[{type:'text',text:'Synthetic dispatch-only refusal'}]};},
    {runtimeVersion:'observed-preparation-fixture-1'});
  const result=await service.run({catalogId:independent.catalogId,ids:[damage.id]});
  assert.equal(result.status,'partial');assert.equal(result.coverage.completed,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'calculate_damage');
});

test('explicit independent focus bypasses unselected full reconstruction without silently answering a simulation',async()=>{
  const f=fixture();delete f.input.reconstructionHypotheses;f.input.hypotheses=[namedNumericalHypothesis()];
  f.input.focus=[{kind:'damage-range',scenarioId:'explicit-active-investments',attackerId:'foe1',defenderId:'own0',move:'High Horsepower',route:'active'},
    {kind:'move-order',scenarioId:'explicit-active-investments'}];
  const service=createResearchService(f.options),menu=await service.prepare(f.input);
  assert.equal(menu.focusReady,true);assert.equal(menu.status,undefined);assert.equal(menu.reconstructionReadiness,undefined);
  assert.deepEqual(menu.selectionScope,{kind:'independent-numerical-focus',unselectedObservedSimulations:1,wholeTurnReconstruction:'not-requested-by-focus'});
  assert.equal(f.calls.length,0);assert.equal(menu.selectedIds.length,2);assert(Buffer.byteLength(JSON.stringify(menu))<=4096);
  assert(menu.tickets.every(row=>['calculate_damage','calculate_speed'].includes(row.name)));
  const entry=f.cache.get(menu.catalogId);assert.equal(entry.input.observedSimulations.length,1,'authored inputs remain unchanged rather than being rewritten as absent');
  assert.equal(entry.input.reconstructionHypotheses,undefined);
  assert.equal((await service.resolve({catalogId:menu.catalogId,ids:menu.selectedIds,actions:f.plan.ourActions})).status,'resolved');
  assert.equal(f.calls.length,0);
});

test('blocked routing invents no future form and keeps source/runtime revalidation for narrow IDs',async()=>{
  for(const changed of ['source','runtime']){
    const f=fixture();delete f.input.reconstructionHypotheses;f.input.hypotheses=[namedNumericalHypothesis()];f.plan.ourActions[0].mega=true;
    const service=createResearchService(f.options),menu=await service.prepare(f.input),independent=menu.independentChecks;
    assert.equal(menu.status,'blocked');assert.equal(menu.reconstructionReadiness.ready,false);
    const entry=f.cache.get(independent.catalogId),damage=entry.catalog.tickets.find(row=>row.name==='calculate_damage');assert(damage);
    assert(entry.catalog.tickets.filter(row=>row.name==='calculate_damage').every(row=>!row.args.attacker.includes('-Mega')&&!row.args.defender.includes('-Mega')));
    if(changed==='source')f.board.sides[0].pokemon[0].hp.current--;else f.options.callTool.runtimeVersion='changed-runtime';
    const refused=await service.resolve({catalogId:independent.catalogId,ids:[damage.id],actions:f.plan.ourActions});
    assert.equal(refused.status,'refused');assert.equal(f.calls.length,0);
  }
  const f=fixture();f.input.hypotheses=[namedNumericalHypothesis()];f.input.hypotheses[0].pokemon.foe0.species='Raichu-Mega-Y';
  assert.equal(researchPrepareSchema.safeParse(f.input).success,false,'numeric hypotheses cannot supply a prospective form override');
});

test('unsupported narrow inputs or source drift publish no executable independent catalog',async()=>{
  {
    const f=fixture();delete f.input.reconstructionHypotheses;f.board.field.weather='unknown-weather';
    const menu=await createResearchService(f.options).prepare(f.input);
    assert.equal(menu.status,'blocked');assert.equal(menu.independentChecks.status,'unavailable');assert.equal(menu.independentChecks.stored,false);
    assert.equal(menu.independentChecks.tickets.length,0);assert.equal(f.cache.size,0);assert.equal(f.calls.length,0);
  }
  {
    const f=fixture();delete f.input.reconstructionHypotheses;const base=f.options.call;let reads=0;
    f.options.call=async(...args)=>{if(args[1].op==='turn-status'&&++reads===2)f.board.sides[0].pokemon[0].hp.current--;return base(...args);};
    await assert.rejects(createResearchService(f.options).prepare(f.input),/source changed during blocked preparation/);
    assert.equal(f.cache.size,0);assert.equal(f.calls.length,0);
  }
});

test('a supported observed current ability compiles without changing the authored pair or dispatching research',async()=>{
  const f=fixture();
  f.board.sides[1].pokemon[0].ability='Static';f.input.reconstructionHypotheses.opposing.foe0.ability='Static';
  const before=structuredClone(f.input),service=createResearchService(f.options),menu=await service.prepare(f.input);
  assert.equal(menu.focusReady,true);assert.equal(menu.reconstructionReadiness.ready,true);
  assert.equal(menu.reconstructionReadiness.firstSemanticRefusal,undefined);assert.equal(f.calls.length,0);
  const ticket=f.cache.get(menu.catalogId).catalog.tickets.find(row=>row.name==='simulate_turn');assert(ticket);
  assert.equal(ticket.args.request.hypotheses.opposing.foe0.ability,'Static');
  assert(ticket.args.request.branches.every(row=>JSON.stringify(row.ourActions)===JSON.stringify(f.plan.ourActions)));
  const native=buildObservedPosition({...f.native,hypotheses:f.input.reconstructionHypotheses}).position.sides[1].pokemon.find(row=>row.id==='foe0');
  assert.equal(native.ability,'Static');assert.equal(native.nativeState.baseAbility,'Lightning Rod');
  assert.equal((await service.resolve({catalogId:menu.catalogId,ids:menu.selectedIds,actions:f.plan.ourActions})).status,'resolved');
  assert.equal(f.calls.length,0);assert.deepEqual(f.input,before);
});

test('absent selected reserves remain a reconstruction refusal without an executable simulation',async()=>{
  const f=fixture();f.input.reconstructionHypotheses.reserves=[];
  const menu=await createResearchService(f.options).prepare(f.input);
  assert.equal(menu.status,'blocked');assert.equal(menu.reconstructionReadiness.ready,false);assert.equal(f.calls.length,0);
  assert.equal(menu.independentChecks.requestedSimulationStatus,'blocked');
  assert([...f.cache.values()].every(entry=>entry.catalog.tickets.every(row=>['calculate_damage','calculate_speed'].includes(row.name))));
  assert.match(menu.reconstructionReadiness.firstSemanticRefusal.message.text,/reserve count/);
});

test('a changed board during preparation prevents publication of a ready catalog',async()=>{
  const f=fixture(),base=f.options.call;let reads=0;
  f.options.call=async(...args)=>{if(args[1].op==='turn-status'&&++reads===2)f.board.sides[0].pokemon[0].hp.current--;return base(...args);};
  await assert.rejects(createResearchService(f.options).prepare(f.input),/source changed during preparation/);
  assert.equal(f.cache.size,0);assert.equal(f.calls.length,0);
});

test('changed actual sheet or runtime refuses prepared observed IDs before execution',async()=>{
  for(const change of ['sheet','runtime']){
    const f=fixture(),service=createResearchService(f.options),menu=await service.prepare(f.input);
    if(change==='sheet')f.board.opponentSheets.p2[0].nature='Jolly';else f.options.callTool.runtimeVersion='changed-build';
    const result=await service.run({catalogId:menu.catalogId,ids:menu.selectedIds});
    assert.equal(result.status,'refused');assert.equal(f.calls.length,0);
  }
});

test('switch slots are mechanically bound to the same stable identity during preparation and pair resolution',async()=>{
  const f=fixture();f.plan.ourActions[0]={type:'switch',slot:3};
  const service=createResearchService(f.options),menu=await service.prepare(f.input),ticket=f.cache.get(menu.catalogId).catalog.tickets.find(row=>row.name==='simulate_turn');
  const expected=buildObservedPosition(f.native).provenance.ownRequestOrder.find(row=>row.snapshotId==='own2').controlPokemonId;
  assert.deepEqual(ticket.args.request.branches[0].ourActions[0],{type:'switch',pokemonId:expected});
  const result=await service.resolve({catalogId:menu.catalogId,ids:menu.selectedIds,actions:f.plan.ourActions});assert.equal(result.status,'resolved');
  const changed=structuredClone(f.plan.ourActions);changed[0].slot=4;
  const refused=await service.resolve({catalogId:menu.catalogId,ids:menu.selectedIds,actions:changed});
  assert.equal(refused.status,'refused');assert.match(refused.entries[0].reason,/exact supplied complete pair/);assert.equal(f.calls.length,0);
});

test('the shorthand accepts no caller-supplied source/defaults and cannot claim an explicit source as observed',async()=>{
  const f=fixture(),extra=structuredClone(f.input);extra.observedSimulations[0].source=f.request;
  assert.equal(researchPrepareSchema.safeParse(extra).success,false);
  const explicit={...f.input,request:{kind:'explicit',label:'Hypothetical only',board:f.board,legalActions:f.state.actions[0].legalActions,ownTeam:f.native.teamText,opponentSheet:f.native.opposingSheet}};
  await assert.rejects(createResearchService(f.options).prepare(explicit),/actual bound observed source/);assert.equal(f.calls.length,0);
});

test('explicit mega:false and its canonical omission associate without changing native authored inputs',async()=>{
  const f=fixture();f.plan.ourActions[0].mega=false;
  const service=createResearchService(f.options),menu=await service.prepare(f.input),ticket=f.cache.get(menu.catalogId).catalog.tickets.find(row=>row.name==='simulate_turn');
  assert.equal(ticket.args.request.branches[0].ourActions[0].mega,false);
  const canonical=structuredClone(f.plan.ourActions);delete canonical[0].mega;
  const selection={catalogId:menu.catalogId,ids:menu.selectedIds};
  assert.equal((await service.resolve({...selection,actions:canonical})).status,'resolved');
  assert.equal(ticket.args.request.branches[0].ourActions[0].mega,false);
  canonical[0].mega=true;assert.equal((await service.resolve({...selection,actions:canonical})).status,'refused');
  assert.equal(f.calls.length,0);
});

test('native schema defaults have distinct normalized hashes and do not overwrite the authored compiler input',async()=>{
  const f=fixture();
  for(const branch of f.plan.branches)branch.gate={targetId:'foe0',beforeActionsOf:['foe0']};
  const service=createResearchService(f.options),menu=await service.prepare(f.input),ticket=f.cache.get(menu.catalogId).catalog.tickets.find(row=>row.name==='simulate_turn');
  const compiled=f.cache.get(menu.catalogId).observedPreparationInputs[0].args;
  assert.equal(Object.hasOwn(compiled.request.branches[0].gate,'requiredActionsBy'),false);
  assert.deepEqual(compiled.request.branches.map(row=>row.gate),f.plan.branches.map(row=>row.gate));
  assert.deepEqual(ticket.args.request.branches[0].gate.requiredActionsBy,[]);
  const receipt=menu.observedPreparation.receipts[0];
  // The compiler uses exact JSON bytes; planning's digest is separately canonical.
  const {createHash}=await import('node:crypto');
  assert.equal(receipt.nativeArgumentsJsonSha256,createHash('sha256').update(JSON.stringify(compiled)).digest('hex'));
  assert.equal(receipt.catalogNativeArgumentsJsonSha256,createHash('sha256').update(JSON.stringify(ticket.args)).digest('hex'));
  assert.notEqual(receipt.nativeArgumentsJsonSha256,receipt.catalogNativeArgumentsJsonSha256);assert.equal(receipt.nativeNormalization.changed,true);
  assert.notEqual(receipt.catalogNativeArgumentsJsonSha256,digest(ticket.args));
});
