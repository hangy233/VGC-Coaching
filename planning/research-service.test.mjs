import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {createResearchService,researchPrepareSchema,researchRunSchema,researchResolveSchema,researchPreparationOptionsSchema,validateResearchPairCalls} from './research-service.mjs';
import {planningFixture} from './fixtures.mjs';
import {invalidatePlanningTeamCaches} from './numeric-cache.mjs';
import {registerPlanningTools} from './mcp-tools.mjs';
import {openingFixture} from '../simulation/fixtures.mjs';
import {digest} from './identity.mjs';
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const points={hp:0,atk:0,def:0,spa:0,spd:0,spe:0},teamId='a'.repeat(64),token='b'.repeat(64);
function fixture(label='default'){
  const data=planningFixture();data.ownTeam[2].item='Miracle Seed';data.ownTeam[3].item='Grassy Seed';data.opponentSheet[2].item='Grassy Seed';
  const request={kind:'observed',sessionId:'research-session',teamId,room:'battle-gen9championsvgc2026regmc-123456',rqid:9,token};
  const board={...data.board,room:request.room,request:{rqid:9},opponentSheets:{p2:data.opponentSheet}},state={sessionId:request.sessionId,teamSha256:teamId,
    actions:[{room:request.room,rqid:9,token,legalActions:data.legalActions}],boards:[board],controlPolicy:{pending:[]}};
  const calls=[],researchCache=new Map(),workspace=join(process.cwd(),'cache',`research-test-${label}`);
  const call=async(_path,{op})=>({ok:true,result:op==='status'?{sessionId:request.sessionId,teamSha256:teamId,rooms:[]}:structuredClone(state)});
  const callTool=Object.assign(async(name,args,options)=>{
    calls.push({name,args:structuredClone(args),options});
    return {structuredContent:name==='calculate_speed'?{gen:0,pokemon:args.pokemon.map(value=>({label:value.label,effectiveSpeed:100,actionSpeed:100,rawStats:{hp:100}})),
      order:[{rank:1,labels:args.pokemon.map(value=>value.label),tie:true}],limitations:['Synthetic orchestration fixture; no competitive numerical claim'],assumptions:['Exact supplied snapshots only']}
      :{gen:0,range:[1,2],damage:[1,2],description:'Synthetic orchestration fixture',attackerHP:{current:100,max:100},defenderHP:{current:100,max:100}}};
  },{runtimeVersion:'research-runtime-1'});
  const hypotheses=[{id:'named',label:'Named opposing spreads, not facts',pokemon:{
    'p2-chomp':{nature:'Jolly',statPoints:{...points,hp:2,atk:32,spe:32}},
    'p2-wash':{nature:'Modest',statPoints:{...points,hp:32,spa:32,spd:2}},
  }}];
  const focus=[{kind:'move-order',scenarioId:'named'},{kind:'damage-range',scenarioId:'named',attackerId:'p1-cat',defenderId:'p2-chomp',move:'Flare Blitz',route:'active'},
    {kind:'damage-range',scenarioId:'named',attackerId:'p2-chomp',defenderId:'p1-cat',move:'Dragon Claw',route:'active'}];
  const options={workspace,researchCache,call,loadTeam:async()=>({teamId,team:data.ownTeam}),callTool};
  return {data,request,board,state,calls,options,input:{request,hypotheses,focus,budgetMs:2000}};
}

test('prepare exposes exact focused IDs without calls; run reloads facts and overlaps independent actual handlers',async()=>{
  const f=fixture('normal'),service=createResearchService(f.options),menu=await service.prepare(f.input);
  assert.equal(f.calls.length,0);assert.equal(menu.kind,'champions-research-menu');assert.equal(menu.selectedIds.length,3);assert.equal(menu.focusReady,true);
  assert(menu.focus.every(value=>value.status==='ready'));assert(Buffer.byteLength(JSON.stringify(menu))<=4096);
  let active=0,peak=0;const releases=[],base=f.options.callTool;
  const callTool=Object.assign(async(...args)=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>releases.push(resolve));active--;return base(...args);},{runtimeVersion:base.runtimeVersion});
  f.options.callTool=callTool;
  const pending=service.run({catalogId:menu.catalogId,ids:menu.selectedIds,budgetMs:2000});
  for(let count=0;count<100&&releases.length<3;count++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(releases.length,3);assert.equal(peak,3);releases.forEach(release=>release());
  const result=await pending;assert.equal(result.status,'complete');assert.equal(result.coverage.completed,3);assert.equal(f.calls.length,3);
  assert(result.entries.every(value=>value.status==='complete'));assert.deepEqual(result.entries[0].result.limitations,['Synthetic orchestration fixture; no competitive numerical claim']);
  assert(result.entries[0].result.projection.omittedPokemonKeys.includes('rawStats'));
  assert(result.entries.slice(1).every(value=>value.result.projection.omittedKeys.includes('damage')));
  assert(f.calls.every(value=>value.options.signal instanceof AbortSignal&&value.options.timeoutMs>0&&value.args.gen===0));
});

test('read-only resolution binds exact selected native inputs without numerical calls and run returns the same binding',async()=>{
  const f=fixture('resolve-native-inputs'),service=createResearchService(f.options),menu=await service.prepare({...f.input,retainEvidence:true});
  const actions=[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}],selection={catalogId:menu.catalogId,ids:menu.selectedIds};
  const before=structuredClone(f.options.researchCache.get(menu.catalogId).catalog);
  const resolved=await service.resolve({...selection,actions});
  assert.equal(resolved.kind,'champions-check-resolution');assert.equal(resolved.status,'resolved');assert.equal(f.calls.length,0);
  assert.equal(resolved.coverage.calculationsRun,0);assert.equal(resolved.coverage.completed,0);assert.equal(resolved.coverage.sourceRevalidated,true);
  assert.deepEqual(resolved.ids,selection.ids);assert.match(resolved.inputBinding.sha256,/^[a-f0-9]{64}$/u);
  assert.equal(resolved.inputBinding.source.kind,'bound-observed-turn');assert.equal(resolved.inputBinding.source.sessionId,f.request.sessionId);
  assert.equal(resolved.inputBinding.source.teamId,teamId);assert.equal(resolved.inputBinding.source.room,f.request.room);assert.equal(resolved.inputBinding.source.rqid,9);
  assert.match(resolved.inputBinding.source.boardHash,/^[a-f0-9]{64}$/u);assert.match(resolved.inputBinding.source.requestDigest,/^[a-f0-9]{64}$/u);
  assert.deepEqual(f.options.researchCache.get(menu.catalogId).catalog,before);
  const result=await service.run(selection);assert.equal(result.status,'complete');assert.deepEqual(result.ids,selection.ids);assert.deepEqual(result.inputBinding,resolved.inputBinding);
  assert(f.calls.every(call=>call.args.evidenceContext?.teamId===teamId));
  const reversed=await service.resolve({...selection,ids:[...selection.ids].reverse(),actions});
  assert.equal(reversed.status,'resolved');assert.notEqual(reversed.inputBinding.sha256,resolved.inputBinding.sha256);
});

test('full native input and result return flags are explicit and preserve exact catalog arguments and replies',async()=>{
  const f=fixture('full-native-return'),service=createResearchService(f.options),menu=await service.prepare({...f.input,retainEvidence:true}),selection={catalogId:menu.catalogId,ids:menu.selectedIds};
  const actions=[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}],brief=await service.resolve({...selection,actions});
  assert.equal(Object.hasOwn(brief,'calls'),false);assert.equal(f.calls.length,0);
  const handlers=new Map();registerPlanningTools({registerTool:(name,config,handler)=>handlers.set(name,{config,handler})},f.options);
  const invoke=async(name,input)=>{const {config,handler}=handlers.get(name),reply=await handler(config.inputSchema.parse(input));assert.notEqual(reply.isError,true);return reply.structuredContent;};
  const full=await invoke('battle_resolve_checks',{...selection,actions,includeNativeInputs:true});assert.equal(full.status,'resolved');assert.equal(f.calls.length,0);
  assert.equal(full.inputBinding.callsSha256,digest(full.calls));assert.deepEqual(full.inputBinding,brief.inputBinding);
  const nativeReplies=[];const actual=f.options.callTool;f.options.callTool=Object.assign(async(...args)=>{const r=await actual(...args);r.structuredContent.futureNativeField={retained:true};nativeReplies.push(structuredClone(r.structuredContent));return r;},{runtimeVersion:actual.runtimeVersion});
  const result=await invoke('battle_run_checks',{...selection,includeNativeResults:true});assert.equal(result.status,'complete');assert.deepEqual(result.inputBinding,full.inputBinding);
  assert.deepEqual(f.calls.map(({name,args})=>({name,args})),full.calls);assert.deepEqual(result.entries.map(row=>row.result),nativeReplies);
  const advisory=await service.run(selection);assert.equal(advisory.status,'complete');assert.equal(advisory.entries.find(row=>row.name==='calculate_damage').result.damage,undefined);
  assert.equal(researchResolveSchema.safeParse({...selection,actions,includeNativeInputs:false}).success,false);assert.equal(researchRunSchema.safeParse({...selection,includeNativeResults:false}).success,false);
});

test('resolution refuses a final synchronous revalidation overrun and retains the within-budget countercase',async()=>{
  for(const advanceMs of [99,101]){
    const f=fixture('resolve-final-clock-'+advanceMs);let clock=Date.now(),resolving=false,reads=0;
    const base=f.options.call;f.options.now=()=>clock;
    f.options.call=async(...args)=>{const result=await base(...args);if(resolving&&args[1].op==='turn-status'&&++reads===2)clock+=advanceMs;return result;};
    const service=createResearchService(f.options),menu=await service.prepare(f.input);resolving=true;
    const result=await service.resolve({catalogId:menu.catalogId,ids:menu.selectedIds,actions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}],budgetMs:100});
    assert.equal(f.calls.length,0);assert.equal(result.coverage.calculationsRun,0);
    if(advanceMs<100){assert.equal(result.status,'resolved');assert(result.inputBinding);}
    else{assert.notEqual(result.status,'resolved');assert.equal(result.inputBinding,undefined);assert.match(result.entries[0].reason,/deadline elapsed/);}
  }
});

test('execution final source revalidation cannot endorse complete evidence after the shared deadline',async()=>{
  for(const advanceMs of [999,1001]){
    const f=fixture('run-final-clock-'+advanceMs);let clock=Date.now();const base=f.options.call;f.options.now=()=>clock;
    f.options.call=async(...args)=>{const result=await base(...args);if(args[1].op==='turn-status'&&f.calls.length)clock+=advanceMs;return result;};
    const service=createResearchService(f.options),menu=await service.prepare(f.input),result=await service.run({catalogId:menu.catalogId,ids:menu.selectedIds,budgetMs:1000,includeNativeResults:true});
    assert.equal(f.calls.length,3);assert.equal(result.coverage.calculationsRun,3);assert(result.entries.every(row=>row.result));
    if(advanceMs<1000){assert.equal(result.status,'complete');assert.equal(result.coverage.sourceRevalidated,true);assert.equal(result.coverage.completed,3);}
    else{assert.equal(result.status,'partial');assert.equal(result.coverage.sourceRevalidated,false);assert.equal(result.coverage.completed,0);assert(result.entries.every(row=>row.status==='unverified'));}
  }
});

test('resolution preserves every simulation branch, opposing action and explicit seed and rejects a mismatched batch branch',async()=>{
  const f=fixture('resolve-simulations'),service=createResearchService(f.options),native=openingFixture();native.position.turn=f.data.board.turn;
  const actions=structuredClone(native.branches[0].ourActions),second={...structuredClone(native.branches[0]),id:'alternate-foe',opposingActions:[{type:'move',slot:4},{type:'move',slot:2,target:1}]};
  const seeds=[[1,2,3,4],[5,6,7,8]],request={kind:'explicit',label:'Prepared hypothetical simulation inputs',board:f.data.board,legalActions:f.data.legalActions,ownTeam:Teams.export(f.data.ownTeam),opponentSheet:f.data.opponentSheet};
  const args={request:{kind:'explicit',position:native.position,hypotheses:native.hypotheses,cases:[
    {id:'first',branches:[native.branches[0],second],seeds},{id:'second',branches:[{...structuredClone(second),id:'second-case'}],seeds:[seeds[1]]},
  ]}};
  const input={...f.input,request,simulationRequests:[{id:'batch',label:'Every authored case',name:'simulate_turn_batch',args}],focus:[{authoredId:'batch'}]};
  const menu=await service.prepare(input),selection={catalogId:menu.catalogId,ids:menu.selectedIds},original=structuredClone(args);
  const eligibility=menu.simulationCaseEligibility;assert.equal(eligibility.kind,'simulation-case-eligibility-v1');assert.equal(eligibility.complete,true);assert.equal(eligibility.indexScope,'catalog-ticket-ids');assert.equal(eligibility.catalogId,menu.catalogId);assert.deepEqual(eligibility.checks.map(row=>row.checkId),menu.selectedIds);assert.deepEqual(eligibility.checks[0].cases.map(row=>row.caseId),['first','second']);assert(eligibility.checks[0].cases.every(row=>row.removalPredicateEligible&&row.canonicalPositivePair&&row.simulationCheck===undefined));assert.equal(eligibility.coverage.calculationsRun,0);
  const resolved=await service.resolve({...selection,actions});assert.equal(resolved.status,'resolved');assert.equal(f.calls.length,0);assert.deepEqual(args,original);
  assert.equal(resolved.simulationCaseEligibility.complete,true);assert.equal(resolved.simulationCaseEligibility.checks[0].inputSha256,eligibility.checks[0].inputSha256);assert.deepEqual(resolved.simulationCaseEligibility.source,resolved.inputBinding.source);assert.deepEqual(resolved.simulationCaseEligibility.source,eligibility.source);assert.equal(resolved.simulationCaseEligibility.sourceBindingSha256,eligibility.sourceBindingSha256);
  const handlers=new Map();registerPlanningTools({registerTool:(name,config,handler)=>handlers.set(name,{config,handler})},f.options);
  const resolver=handlers.get('battle_resolve_checks'),publicReply=await resolver.handler(resolver.config.inputSchema.parse({...selection,actions}));assert.equal(publicReply.isError,undefined);assert.deepEqual(publicReply.structuredContent.simulationCaseEligibility,resolved.simulationCaseEligibility);assert.equal(f.calls.length,0);
  assert.equal(resolved.inputBinding.source.kind,'explicit-hypothetical-snapshot');assert.equal(resolved.inputBinding.source.requestDigest,undefined);
  const result=await service.run(selection);assert.equal(result.status,'complete');assert.deepEqual(result.inputBinding,resolved.inputBinding);assert.deepEqual(f.calls[0].args,original);
  const changed=structuredClone(input);changed.simulationRequests[0].args.request.cases[1].branches[0].ourActions[1]={type:'move',slot:4};
  const mismatched=await service.prepare(changed),before=f.calls.length;
  const refused=await service.resolve({catalogId:mismatched.catalogId,ids:mismatched.selectedIds,actions});
  assert.equal(refused.status,'refused');assert.match(refused.entries[0].reason,/case 2 branch 1.*exact supplied complete pair/);
  assert.equal(refused.coverage.calculationsRun,0);assert.equal(refused.inputBinding,undefined);assert.equal(f.calls.length,before);
});

test('resolution refuses unknown, mixed-catalog and stale selections without dispatching numerical calls',async()=>{
  const actions=[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}];
  for(const [label,mutate] of [['resolve-hp',f=>f.board.sides[0].pokemon[0].hp.current--],['resolve-token',f=>f.state.actions[0].token='c'.repeat(64)],['resolve-runtime',f=>f.options.callTool.runtimeVersion='research-runtime-2']]){
    const f=fixture(label),service=createResearchService(f.options),menu=await service.prepare(f.input);mutate(f);
    const result=await service.resolve({catalogId:menu.catalogId,ids:menu.selectedIds,actions});assert.equal(result.status,'refused');assert.equal(f.calls.length,0);assert.equal(result.inputBinding,undefined);
  }
  const f=fixture('resolve-identities'),service=createResearchService(f.options),first=await service.prepare({...f.input,focus:[f.input.focus[0]]}),second=await service.prepare({...f.input,focus:[f.input.focus[1]]});
  for(const ids of [['research-'+'0'.repeat(24)],[second.selectedIds[0],first.selectedIds[0]]]){
    const result=await service.resolve({catalogId:second.catalogId,ids,actions});assert.equal(result.status,'refused');assert.match(result.entries[0].reason,/unknown research ID/);assert.equal(f.calls.length,0);
  }
});

test('pair association checks every native simulation and delivery candidate without transforming authored inputs',()=>{
  const native=openingFixture(),actions=structuredClone(native.branches[0].ourActions),request={kind:'explicit',...native};
  const calls=[{name:'simulate_turn',args:{request}},{name:'battle_check_plan',args:{request,candidates:[{id:'same',ourActions:actions}]}},{name:'calculate_speed',args:{gen:0}}];
  const before=structuredClone(calls);validateResearchPairCalls(calls,actions);assert.deepEqual(calls,before);
  for(const mutate of [value=>value[0].args.request.branches[0].ourActions.pop(),value=>value[1].args.candidates.push({id:'different',ourActions:[{type:'pass'},{type:'pass'}]})]){
    const changed=structuredClone(calls);mutate(changed);assert.throws(()=>validateResearchPairCalls(changed,actions),/exact supplied complete pair/);
  }
});

test('missing and ambiguous exact focus requests stay unverified rather than selecting guesses or calculators',async()=>{
  const f=fixture('focus'),service=createResearchService(f.options);
  const unknown=await service.prepare({...f.input,hypotheses:[],focus:[f.input.focus[1]]});
  assert.equal(unknown.selectedIds,undefined);assert.equal(unknown.focusReady,false);assert.equal(unknown.focus[0].status,'missing');
  const unavailable=await service.prepare({...f.input,hypotheses:[],focus:[{...f.input.focus[1],scenarioId:'observed'}]});
  assert.equal(unavailable.focus[0].status,'unavailable');assert(unavailable.focus[0].reasons.some(index=>/allocation unknown/.test(unavailable.notes[index])));
  const ambiguous=await service.prepare({...f.input,focus:[{kind:'damage-range',scenarioId:'named'}]});
  assert.equal(ambiguous.selectedIds,undefined);assert.equal(ambiguous.focusReady,false);assert.equal(ambiguous.focus[0].status,'ambiguous');assert.equal(f.calls.length,0);
});

test('stale HP, source tokens and runtime refuse before any calculation and unavailable IDs are not substituted',async()=>{
  for(const [label,mutate] of [['hp',f=>f.board.sides[0].pokemon[0].hp.current--],['token',f=>f.state.actions[0].token='c'.repeat(64)],['runtime',f=>f.options.callTool.runtimeVersion='research-runtime-2']]){
    const f=fixture(label),service=createResearchService(f.options),menu=await service.prepare(f.input);mutate(f);
    const result=await service.run({catalogId:menu.catalogId,ids:menu.selectedIds});assert.equal(result.status,'refused');assert.equal(f.calls.length,0);
  }
  const f=fixture('unknown-id'),service=createResearchService(f.options),menu=await service.prepare(f.input);
  const result=await service.run({catalogId:menu.catalogId,ids:['research-'+'0'.repeat(24)]});assert.equal(result.status,'refused');assert.equal(f.calls.length,0);
});

test('the two-entry catalog store evicts old boards and uses existing team cleanup invalidation',async()=>{
  const f=fixture('cleanup'),service=createResearchService(f.options),first=await service.prepare(f.input);
  f.board.sides[0].pokemon[0].hp.current--;await service.prepare(f.input);f.board.sides[0].pokemon[0].hp.current--;
  const latest=await service.prepare(f.input);assert.equal(f.options.researchCache.size,2);
  assert.match((await service.run({catalogId:first.catalogId,ids:first.selectedIds})).entries[0].reason,/evicted/);
  assert.equal(invalidatePlanningTeamCaches({workspace:f.options.workspace,teamId}).removed,2);assert.equal(f.options.researchCache.size,0);
  assert.equal((await service.run({catalogId:latest.catalogId,ids:latest.selectedIds})).status,'refused');
  const other=fixture('other-registration'),separate=createResearchService(other.options);
  assert.equal((await separate.run({catalogId:latest.catalogId,ids:latest.selectedIds})).status,'refused');
});

test('cleanup during preparation prevents late catalog insertion',async()=>{
  const f=fixture('inflight-cleanup');let release,reads=0;
  const base=f.options.call;f.options.call=async(path,command)=>{
    if(command.op==='turn-status'&&++reads===2)await new Promise(resolve=>{release=resolve;});
    return base(path,command);
  };
  const service=createResearchService(f.options),pending=service.prepare(f.input);
  for(let count=0;count<100&&!release;count++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof release,'function');invalidatePlanningTeamCaches({workspace:f.options.workspace,teamId});release();
  await assert.rejects(pending,/cleanup or service reset invalidated/);assert.equal(f.options.researchCache.size,0);
});

test('a shared deadline leaves unfinished work unknown and late tails cannot alter published results',async()=>{
  const f=fixture('deadline'),service=createResearchService(f.options),menu=await service.prepare(f.input),base=f.options.callTool;
  let release,signal;
  f.options.callTool=Object.assign(async(name,args,options)=>{
    if(name==='calculate_speed')return base(name,args,options);
    signal=options.signal;await new Promise(resolve=>{release=resolve;});return base(name,args,options);
  },{runtimeVersion:base.runtimeVersion});
  const result=await service.run({catalogId:menu.catalogId,ids:menu.selectedIds.slice(0,2),budgetMs:1000});
  assert.equal(result.status,'partial');assert.equal(result.entries[1].status,'unknown');assert.equal(signal.aborted,true);
  assert.equal(result.entries[0].status,'complete');assert(result.entries[0].result,'reserved post-read time preserves the timely checked result');assert.equal(result.coverage.sourceRevalidated,true);
  const serialized=JSON.stringify(result);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(JSON.stringify(result),serialized);
});

test('native refusal is per-entry and synchronous deadline overrun is never adopted complete',async()=>{
  const f=fixture('refusal'),service=createResearchService(f.options),menu=await service.prepare(f.input),base=f.options.callTool;
  f.options.callTool=Object.assign(async(name,args,options)=>name==='calculate_speed'?base(name,args,options):{isError:true,content:[{type:'text',text:'Fixture native refusal'}]},{runtimeVersion:base.runtimeVersion});
  const result=await service.run({catalogId:menu.catalogId,ids:menu.selectedIds.slice(0,2)});
  assert.deepEqual(result.entries.map(value=>value.status),['complete','refused']);assert.match(result.entries[1].reason,/native refusal/);
  f.options.callTool=Object.assign(async(...args)=>{const until=performance.now()+300;while(performance.now()<until){}return base(...args);},{runtimeVersion:base.runtimeVersion});
  const late=await service.run({catalogId:menu.catalogId,ids:[menu.selectedIds[0]],budgetMs:1000});assert.equal(late.entries[0].status,'late');assert.equal(late.coverage.completed,0);
  const before=f.calls.length,multiple=await service.run({catalogId:menu.catalogId,ids:menu.selectedIds,budgetMs:1000});
  assert.equal(f.calls.length,before+1,'a synchronous overrun must prevent later queued native dispatch');
  assert.deepEqual(multiple.entries.map(value=>value.status),['late','unknown','unknown']);
});

test('direct public service respects the observed cutoff and preserves existing commit and source-read reserves',async()=>{
  const f=fixture('observed-cutoff'),service=createResearchService(f.options),menu=await service.prepare(f.input);
  f.state.controlPolicy.pending=[{token,cutoffAt:Date.now()+4500}];
  await assert.rejects(service.prepare({...f.input,budgetMs:5000}),/five-second commit reserve/);assert.equal(f.calls.length,0);
  const inside=await service.run({catalogId:menu.catalogId,ids:menu.selectedIds,budgetMs:5000});assert.equal(inside.status,'refused');assert.equal(inside.coverage.calculationsRun,0);
  f.state.controlPolicy.pending[0].cutoffAt=Date.now()+5700;
  const tooShort=await service.run({catalogId:menu.catalogId,ids:menu.selectedIds,budgetMs:5000});assert.equal(tooShort.status,'refused');assert.match(tooShort.entries[0].reason,/source-revalidation reserve/);assert.equal(f.calls.length,0);
  f.state.controlPolicy.pending[0].cutoffAt=Date.now()+10000;
  const normal=await service.run({catalogId:menu.catalogId,ids:menu.selectedIds,budgetMs:2000});assert.equal(normal.status,'complete');assert.equal(f.calls.length,3);
  assert(normal.deadlines.effectiveDeadlineAt<=Date.now()+2000);assert.equal(normal.deadlines.calculationDeadlineAt,normal.deadlines.effectiveDeadlineAt-750);
  assert(f.calls.every(value=>value.options.timeoutMs<=1250&&value.options.signal instanceof AbortSignal));
});

test('an observed cutoff shortens the actual handler abort window while explicit minimum budgets retain pure revalidation',async()=>{
  const f=fixture('native-cutoff-window'),service=createResearchService(f.options),menu=await service.prepare(f.input);
  f.state.controlPolicy.pending=[{token,cutoffAt:Date.now()+6000}];
  let signal,timeoutMs;
  const base=f.options.callTool;f.options.callTool=Object.assign(async(_name,_args,options)=>{
    signal=options.signal;timeoutMs=options.timeoutMs;await new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Native handler observed cancellation')),{once:true}));
  },{runtimeVersion:base.runtimeVersion});
  const shortened=await service.run({catalogId:menu.catalogId,ids:[menu.selectedIds[0]],budgetMs:5000});
  assert.equal(shortened.entries[0].status,'unknown');assert.equal(signal.aborted,true);assert(timeoutMs>0&&timeoutMs<=250);
  assert.equal(shortened.deadlines.effectiveDeadlineAt,f.state.controlPolicy.pending[0].cutoffAt-5000);
  f.options.callTool=base;
  const request={kind:'explicit',label:'Pure revalidation minimum budget countercase',board:f.data.board,legalActions:f.data.legalActions,ownTeam:Teams.export(f.data.ownTeam),opponentSheet:f.data.opponentSheet};
  const explicit=await service.prepare({...f.input,request}),minimal=await service.run({catalogId:explicit.catalogId,ids:[explicit.selectedIds[0]],budgetMs:100});
  assert.equal(minimal.status,'complete');assert.equal(minimal.deadlines.sourceRevalidationReserveMs,0);
});

test('native HP output inconsistent with an exact bound source remains unverified instead of a removal answer',async()=>{
  const f=fixture('hp-reply'),service=createResearchService(f.options),menu=await service.prepare(f.input),base=f.options.callTool;
  f.options.callTool=Object.assign(async(...args)=>{
    const reply=await base(...args);if(args[0]==='calculate_damage')reply.structuredContent.attackerHP.max++;
    return reply;
  },{runtimeVersion:base.runtimeVersion});
  const result=await service.run({catalogId:menu.catalogId,ids:[menu.selectedIds[1]]});
  assert.equal(result.entries[0].status,'unverified');assert.match(result.entries[0].reason,/actual HP differs/);assert(result.entries[0].result);
});

test('retained numerical evidence is opt-in, bound to actual source, and differs in catalog identity',async()=>{
  const f=fixture('evidence'),service=createResearchService(f.options),ordinary=await service.prepare(f.input);
  await service.run({catalogId:ordinary.catalogId,ids:[ordinary.selectedIds[0]]});assert.equal(f.calls[0].args.evidenceContext,undefined);
  const retained=await service.prepare({...f.input,retainEvidence:true});assert.notEqual(retained.catalogId,ordinary.catalogId);
  await service.run({catalogId:retained.catalogId,ids:[retained.selectedIds[0]]});
  assert.deepEqual(f.calls.at(-1).args.evidenceContext,{teamId,roomId:f.request.room,turn:f.board.turn});
  const request={kind:'explicit',label:'Offline scenario',board:f.data.board,legalActions:f.data.legalActions,ownTeam:Teams.export(f.data.ownTeam),opponentSheet:f.data.opponentSheet};
  await assert.rejects(service.prepare({request,retainEvidence:true}),/actual observed source/);
});

test('schemas and public registration expose strict preparation before mutations and bounded ID execution',async()=>{
  assert(researchPreparationOptionsSchema.parse({focus:[{kind:'move-order'}]}));
  assert.throws(()=>researchPreparationOptionsSchema.parse({focus:[{}]}));assert.throws(()=>researchPreparationOptionsSchema.parse({focus:[{pokemon:'invented'}]}));
  const native=openingFixture(),simulation={id:'shape',label:'Native tool shape must match',name:'simulate_turn_batch',args:{request:{kind:'explicit',...native}}};
  assert.throws(()=>researchPreparationOptionsSchema.parse({simulationRequests:[simulation]}),/name and request shape/);
  assert.throws(()=>researchRunSchema.parse({catalogId:'catalog-'+'a'.repeat(24),ids:['research-'+'b'.repeat(24)],budgetMs:5001}));
  const selection={catalogId:'catalog-'+'a'.repeat(24),ids:['research-'+'b'.repeat(24)]};
  assert.throws(()=>researchResolveSchema.parse(selection));assert.throws(()=>researchResolveSchema.parse({...selection,actions:[{type:'pass'}]}));
  assert.throws(()=>researchResolveSchema.parse({...selection,actions:[{type:'pass'},{type:'pass'}],fallback:true}));
  const f=fixture('registration'),handlers=new Map();registerPlanningTools({registerTool:(name,config,handler)=>handlers.set(name,{config,handler})},f.options);
  for(const name of ['battle_prepare_checks','battle_resolve_checks','battle_run_checks']){assert(handlers.has(name));assert.equal(handlers.get(name).config.inputSchema._def.type,'object');}
  const prepared=handlers.get('battle_prepare_checks'),reply=await prepared.handler(prepared.config.inputSchema.parse(f.input));assert(!reply.isError);
  const menu=reply.structuredContent,resolver=handlers.get('battle_resolve_checks');assert.equal(resolver.config.annotations.readOnlyHint,true);
  const resolved=await resolver.handler(resolver.config.inputSchema.parse({catalogId:menu.catalogId,ids:menu.selectedIds,actions:[{type:'pass'},{type:'pass'}]}));
  assert.equal(resolved.structuredContent.status,'resolved');assert.equal(f.calls.length,0);
  const runner=handlers.get('battle_run_checks'),result=await runner.handler(runner.config.inputSchema.parse({catalogId:menu.catalogId,ids:menu.selectedIds}));
  assert.equal(result.structuredContent.status,'complete');assert.deepEqual(result.structuredContent.inputBinding,resolved.structuredContent.inputBinding);
  const unknown=fixture('unknown-runtime');delete unknown.options.callTool.runtimeVersion;
  await assert.rejects(createResearchService(unknown.options).prepare(unknown.input),/runtime\/build is unknown/);assert.equal(unknown.calls.length,0);
  assert.equal(researchPrepareSchema.parse(f.input).retainEvidence,false);
});
