import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createTurnBrief,createDecisionBriefFromSnapshot} from './service.mjs';
import {projectDecisionView} from './decision-view.mjs';
import {boardDigest,digest,requestDigest} from './identity.mjs';
import {planningFixture} from './fixtures.mjs';
import {currentFixture} from '../simulation/observed-position.fixtures.mjs';
import {publishedSheetDigest} from '../simulation/observed-position.mjs';
const {Teams} = createRequire(import.meta.url)('pokemon-showdown');
function fixture() {
  const data = planningFixture();data.ownTeam[2].item = 'Miracle Seed';data.ownTeam[3].item = 'Grassy Seed';data.opponentSheet[2].item = 'Grassy Seed';
  data.board.recentEvents = {lines:['|turn|2','|move|p1a: Incineroar|Flare Blitz|p2a: Garchomp'],omitted:0,truncated:false,scope:'latest-two-observed-turns'};
  return {data,input:{request:{kind:'explicit',label:'Offline service fixture',board:data.board,legalActions:data.legalActions,ownTeam:Teams.export(data.ownTeam),opponentSheet:data.opponentSheet},maxCalls:0,view:'full'}};
}

test('qualitative service makes zero numerical or control calls and retains opposing unknowns and source hash',async() => {
  const {input,data} = fixture(), calls = [];
  const report = await createTurnBrief(input,{callTool:async(name) => {calls.push(name);throw new Error('No tool call expected');}});
  assert.deepEqual(calls,[]);assert.equal(report.status,'advisory');assert.equal(report.source.liveFreshness,false);
  assert.equal(report.source.boardHash,boardDigest(data.board,data.legalActions));assert(report.candidates.length > 0);
  const foe = report.actors.find(actor => actor.id === 'p2-chomp');assert.equal(foe.nature,null);assert.equal(foe.statPoints,null);
  assert.equal(report.actors.find(actor => actor.species === 'Farigiraf').selected,'unknown');
  assert.equal(report.numericChecks.damage.filter(row => row.status === 'complete').length,0);
  assert.equal(report.coverage.numerics.attemptedCalls,0);assert.equal(report.coverage.sourceRevalidated,true);
  assert(report.limitations.some(value => value.includes('never stages, sends')));
});

test('qualitative report retains competing-control dependency without numerical or control calls',async()=>{
  const {input}=fixture(),foe=input.request.board.sides[1].pokemon[0];
  Object.assign(foe,{species:'Raichu',ability:'Lightning Rod'});
  input.request.opponentSheet[0]={species:'Raichu',ability:'Lightning Rod',item:'Raichunite X',moves:['Fake Out','Protect']};
  let calls=0;const report=await createTurnBrief(input,{callTool:async()=>{calls++;throw new Error('No numerical call');}});
  assert.equal(calls,0);assert.equal(report.controlDeliveryWarnings[0].code,'COMPETING_FAKE_OUT');
  assert.equal(report.controlDeliveryWarnings[0].actorId,'p1-cat');assert.equal(report.controlDeliveryWarnings[0].opposing[0].actorId,'p2-chomp');
  assert.equal(report.coverage.numerics.attemptedCalls,0);
});

test('initial brief retains candidate-bound material exposure cards without treating every heuristic attack as required',async()=>{
  const {input,data}=fixture();let calls=0;
  const report=await createTurnBrief(input,{callTool:async()=>{calls++;throw new Error('No numerical call');}});
  assert.equal(calls,0);assert(report.pairDependencies.length>0);
  const pressure=report.candidates.find(candidate=>candidate.purpose==='attack-pressure');
  const pressureQuestions=report.pairDependencies.find(row=>row.candidateId===pressure.id);
  assert(pressureQuestions.warnings.some(row=>row.roles.includes('paired-progress')),'two attacks expose optional delivery questions');
  assert(pressureQuestions.warnings.every(row=>!row.roles.includes('required-actor')),'the questions do not make heuristic actors necessary');
  for(const row of report.pairDependencies){
    const candidate=report.candidates.find(candidate=>candidate.id===row.candidateId);
    assert.deepEqual(row.actions,candidate.actions);assert(row.warnings.every(warning=>!warning.roles.includes('required-actor')));
  }
  const protectedProgress=report.candidates.find(candidate=>candidate.purpose==='protect-plus-progress');
  assert(report.pairDependencies.find(row=>row.candidateId===protectedProgress.id).warnings.some(warning=>warning.roles.includes('sole-progress')));
  const source={kind:'bound-observed-turn',sessionId:'test',teamId:'a'.repeat(64),room:'battle-gen9championsvgc2026regmcbo3-701',rqid:2,boardHash:boardDigest(data.board,data.legalActions),requestDigest:'b'.repeat(64)};
  const pure=createDecisionBriefFromSnapshot({...data,source,objective:{}});
  assert(pure.pairDependencies.length>0);assert.equal(pure.coverage.numerics.attemptedCalls,0);
  const authored=await createTurnBrief({...input,candidates:[{id:'authored-required',purpose:'A specifically required actor',actions:pressure.actions,requiredActors:['p1-dragon']}]});
  assert(authored.pairDependencies[0].warnings.some(warning=>warning.actorId==='p1-dragon'&&warning.roles.includes('required-actor')));
});

test('authored complete pairs are preferred unchanged and declared actors require selected current identities',async() => {
  const {input} = fixture();input.candidates = [{id:'authored',purpose:'Split pressure',actions:[{type:'move',slot:2,target:1},{type:'move',slot:1,target:2}],requiredActors:['p1-cat','p1-dragon']}];
  const report = await createTurnBrief(input);assert.equal(report.candidates.length,1);assert.equal(report.candidates[0].heuristic,false);
  assert.deepEqual(report.candidates[0].actions,input.candidates[0].actions);assert.equal(report.coverage.candidates.source,'model-authored');
  await assert.rejects(createTurnBrief({...input,objective:{preserve:['unknown-own-reserve']}}),/selected own Pokemon/);
  const bad = structuredClone(input);bad.candidates[0].actions[0] = {type:'move',slot:3,target:1};
  await assert.rejects(createTurnBrief(bad),/chosen target/);
  await assert.rejects(createTurnBrief({...input,retainEvidence:true}),/bound observed source/);
});

test('observed source becoming stale after analysis empties candidate output and preserves the refusal',async() => {
  const {input,data} = fixture(), teamId = 'a'.repeat(64), token = 'b'.repeat(64), room = 'battle-gen9championsvgc2026regmcbo3-702';
  const source = {kind:'observed',sessionId:'offline-service',teamId,room,rqid:2,token};let reads = 0;const commands = [];
  const board = {...data.board,room,request:{rqid:2},opponentSheets:{p2:data.opponentSheet}};
  const state = {sessionId:source.sessionId,teamSha256:teamId,actions:[{room,rqid:2,token,legalActions:data.legalActions}],boards:[board],controlPolicy:{pending:[]}};
  const report = await createTurnBrief({...input,request:source},{workspace:process.cwd(),loadTeam:async() => ({teamId,team:data.ownTeam}),call:async(path,command) => {
    commands.push(command.op);
    if(command.op === 'status') return {ok:true,result:{sessionId:source.sessionId,teamSha256:teamId,rooms:[]}};
    reads++;return {ok:true,result:reads === 1 ? state : {...state,actions:[]}};
  }});
  assert.equal(report.status,'stale-source');assert.deepEqual(report.candidates,[]);assert.equal(report.coverage.sourceRevalidated,false);
  assert(report.warnings.some(warning => warning.code === 'STALE_SOURCE'));assert.deepEqual(commands,['turn-status','status','turn-status']);
});

test('compact view counts omitted unchecked rows and carries retained bounded order evidence',async() => {
  const {input,data} = fixture();const report = await createTurnBrief({...input,view:'compact'});
  assert.equal(report.viewCoverage.mode,'compact');assert(report.viewCoverage.uncheckedRowsOmitted > 0);
  assert.equal(report.numericChecks.damage.length,0);assert(report.numericChecks.unavailableCount > 0);
  assert.equal(report.orderEvidence.sourceLines,undefined);
  assert.equal(report.orderEvidence.observations[0].currentReuse,false);
  assert(report.answerRoutes.some(row=>row.uncheckedIncomingCount>0));
  assert(report.answerRoutes.every(row=>row.incomingChecks.every(check=>check.status==='complete')));
  assert(report.order.every(row=>row.observedConstraints===undefined&&row.observedConstraintsRef==='orderEvidence.observations'));
  const full = await createTurnBrief(input);assert.deepEqual(full.orderEvidence.sourceLines,data.board.recentEvents.lines);
});

test('decision view changes presentation only and pure inline preparation requires matching mechanical binding',async()=>{
  const {input,data}=fixture(),view=await createTurnBrief({...input,view:'decision'});
  assert.equal(view.viewCoverage.mode,'decision');assert(Buffer.byteLength(JSON.stringify(view))<=4096);assert.equal(view.criticalUnknowns.sourceRevalidated,true);
  const source={kind:'bound-observed-turn',sessionId:'test',teamId:'a'.repeat(64),boardHash:boardDigest(data.board,data.legalActions)};
  const full=createDecisionBriefFromSnapshot({...data,source,objective:{}});assert(full.candidates.length>0);assert.equal(full.coverage.sourceRevalidated,false);
  assert(full.warnings.some(row=>row.code==='INLINE_REVALIDATION_REQUIRED'));assert(full.warnings.some(row=>row.code==='NUMERICS_NOT_REQUESTED'));
  const projected=projectDecisionView(full);assert.equal(projected.criticalUnknowns.sourceRevalidated,false);assert.equal(projected.coverage.numericCalls,0);
  data.board.sides[0].pokemon[0].hp.current--;assert.throws(()=>createDecisionBriefFromSnapshot({...data,source,objective:{}}),/binding mismatch/);
});

test('caller-owned reusable numeric cache retains native receipts and invalidates changed runtime inputs',async()=>{
  const {input}=fixture(),numericCache=new Map();let calls=0;
  const callTool=Object.assign(async()=>{calls++;return {structuredContent:{gen:0,pokemon:[],order:[],calculationRef:{id:`native-receipt-${calls}`}}};},{runtimeVersion:'cache-runtime-1'});
  const first=await createTurnBrief({...input,maxCalls:1},{callTool,numericCache});
  const second=await createTurnBrief({...input,maxCalls:1},{callTool,numericCache});
  assert.equal(calls,1);assert.equal(second.coverage.numerics.cachedCalls,first.coverage.numerics.completedCalls);
  assert.deepEqual(second.numericChecks.checks[0].receipt.calculationRef,first.numericChecks.checks[0].receipt.calculationRef);
  callTool.runtimeVersion='cache-runtime-2';await createTurnBrief({...input,maxCalls:1},{callTool,numericCache});assert.equal(calls,2);
});

test('reusable mechanics never skip newly requested evidence or reuse a retained receipt across rooms or turns',async()=>{
  const {input,data}=fixture(),teamId='a'.repeat(64),token='b'.repeat(64),numericCache=new Map(),calls=[];
  const request={kind:'observed',sessionId:'evidence-cache-session',teamId,room:'battle-gen9championsvgc2026regmcbo3-701',rqid:2,token};
  const board={...data.board,room:request.room,request:{rqid:2},opponentSheets:{p2:data.opponentSheet}};
  const state={sessionId:request.sessionId,teamSha256:teamId,actions:[{room:request.room,rqid:2,token,legalActions:data.legalActions}],boards:[board],controlPolicy:{pending:[]}};
  const options={workspace:process.cwd(),numericCache,loadTeam:async()=>({teamId,team:data.ownTeam}),
    call:async(_path,{op})=>({ok:true,result:op==='status'?{sessionId:request.sessionId,teamSha256:teamId,rooms:[]}:structuredClone(state)}),
    callTool:Object.assign(async(name,args)=>{calls.push({name,args});return {structuredContent:{gen:0,pokemon:[],order:[],...(args.evidenceContext?{calculationRef:{id:`retained-${calls.length}`,context:args.evidenceContext}}:{})}};},{runtimeVersion:'evidence-runtime'})};
  await createTurnBrief({...input,request,maxCalls:1},options);assert.equal(calls.length,1);assert.equal(calls[0].args.evidenceContext,undefined);
  const retained=await createTurnBrief({...input,request,maxCalls:1,retainEvidence:true},options);assert.equal(calls.length,2);assert.equal(calls[1].args.evidenceContext.turn,2);
  const same=await createTurnBrief({...input,request,maxCalls:1,retainEvidence:true},options);assert.equal(calls.length,2);assert.deepEqual(same.numericChecks.checks[0].receipt.calculationRef,retained.numericChecks.checks[0].receipt.calculationRef);
  board.turn=3;const next=await createTurnBrief({...input,request,maxCalls:1,retainEvidence:true},options);assert.equal(calls.length,3);assert.equal(next.numericChecks.checks[0].receipt.calculationRef.context.turn,3);
  request.room='battle-gen9championsvgc2026regmcbo3-702';board.room=request.room;state.actions[0].room=request.room;
  const other=await createTurnBrief({...input,request,maxCalls:1,retainEvidence:true},options);assert.equal(calls.length,4);assert.equal(other.numericChecks.checks[0].receipt.calculationRef.context.roomId,request.room);
});

function reconstructionFixture(){
  const input=currentFixture(),state=structuredClone(input.observed),request={kind:'observed',sessionId:state.sessionId,...input.expected};
  state.teamSha256=request.teamId;state.boards[0].opponentSheets={p2:structuredClone(input.opposingSheet)};
  const full={sessionId:state.sessionId,teamSha256:request.teamId,rooms:[]},calls=[];
  const options={workspace:process.cwd(),loadTeam:async()=>({teamId:request.teamId,team:Teams.import(input.teamText)}),
    call:async(_path,{op})=>{calls.push(op);return {ok:true,result:structuredClone(op==='status'?full:state)};},
    callTool:async()=>{throw new Error('No numerical dispatch expected');}};
  return {input,state,request,options,calls};
}

test('observed readiness uses separate explicit reconstruction hypotheses and exposes only a source-bound bounded card',async()=>{
  const {input,request,options,calls}=reconstructionFixture(),before=structuredClone(input.hypotheses);
  const report=await createTurnBrief({request,reconstructionHypotheses:input.hypotheses,maxCalls:0,view:'full'},options);
  const card=report.reconstructionReadiness;
  assert.equal(card.ready,true);assert.equal(card.status,'reconstruction-ready');assert.equal(card.sourceRevalidated,true);assert.deepEqual(card.source,report.source);
  assert.equal(card.hashes.opposingSheetSha256,publishedSheetDigest(input.opposingSheet));assert.equal(report.source.publishedOpposingSheetSha256,card.hashes.opposingSheetSha256);
  assert.equal(report.coverage.numerics.attemptedCalls,0);assert.deepEqual(calls,['turn-status','status','turn-status']);
  assert.equal(report.observedPositionInput,undefined);assert.equal(card.reconstruction,undefined);assert.equal(card.teamText,undefined);assert.equal(card.observed,undefined);
  assert.equal(report.reconstructionHypotheses,undefined);assert.deepEqual(input.hypotheses,before);assert(Buffer.byteLength(JSON.stringify(card))<6000);
});

test('missing and partial reconstruction hypotheses yield diagnostics without defaulting mode or numerical hypotheses',async()=>{
  const {request,options}=reconstructionFixture();
  for(const reconstructionHypotheses of [undefined,{}, {mode:'current'}]){
    const report=await createTurnBrief({request,...(reconstructionHypotheses!==undefined?{reconstructionHypotheses}:{}),maxCalls:0,view:'full'},options);
    const card=report.reconstructionReadiness;assert.equal(card.ready,false);assert(['blocked','over-budget'].includes(card.status));
    assert(card.counts.blockers[0]>0);assert.equal(card.coverage.semantic,'unevaluated');assert.equal(report.coverage.numerics.attemptedCalls,0);
    assert(card.missingAuthored.some(row=>row.path.join('.')==='hypotheses.mode')||card.counts.missingAuthored[2]>0||reconstructionHypotheses?.mode==='current');
  }
});

test('a supported observed current ability retains source-revalidated readiness without numerical dispatch',async()=>{
  const {input,state,request,options,calls}=reconstructionFixture();
  state.boards[0].sides[1].pokemon[0].ability='Static';input.hypotheses.opposing.foe0.ability='Static';
  const before=structuredClone(input.hypotheses),report=await createTurnBrief({request,reconstructionHypotheses:input.hypotheses,maxCalls:0,view:'full'},options),card=report.reconstructionReadiness;
  assert.equal(report.status,'advisory');assert.equal(card.ready,true);assert.equal(card.status,'reconstruction-ready');
  assert.equal(card.firstSemanticRefusal,undefined);assert.equal(card.sourceRevalidated,true);assert.deepEqual(card.source,report.source);
  assert.equal(report.actors.find(actor=>actor.id==='foe0').ability,'Static');
  assert.equal(report.coverage.numerics.attemptedCalls,0);assert.deepEqual(calls,['turn-status','status','turn-status']);
  assert.deepEqual(input.hypotheses,before);
});

test('a forged loaded team remains a reconstruction refusal rather than current readiness',async()=>{
  const {input,request,options}=reconstructionFixture(),original=options.loadTeam;
  options.loadTeam=async()=>{const loaded=await original();loaded.team[0].evs.hp=1;return loaded;};
  const report=await createTurnBrief({request,reconstructionHypotheses:input.hypotheses,maxCalls:0,view:'full'},options),card=report.reconstructionReadiness;
  assert.equal(report.status,'advisory');assert.equal(card.ready,false);assert(card.firstSemanticRefusal);
  assert.match(card.firstSemanticRefusal.message.text,/packed hash/);assert.equal(report.coverage.numerics.attemptedCalls,0);
});

test('readiness inspected on a captured input is revoked after actual source or sheet changes',async()=>{
  for(const sheetOnly of [false,true]){
    const {input,state,request,options}=reconstructionFixture();let reads=0;
    const read=options.call;options.call=async(path,command)=>{
      if(command.op==='turn-status'&&++reads===2){if(sheetOnly)state.boards[0].opponentSheets.p2[0].item='Sitrus Berry';else state.boards[0].sides[0].pokemon[0].hp.current--;}
      return read(path,command);
    };
    const report=await createTurnBrief({request,reconstructionHypotheses:input.hypotheses,maxCalls:0,view:'full'},options);
    assert.equal(report.status,'stale-source');assert.equal(report.reconstructionReadiness.ready,false);assert.equal(report.reconstructionReadiness.status,'stale-source');
    assert.equal(report.reconstructionReadiness.sourceRevalidated,false);assert.deepEqual(report.candidates,[]);
  }
});

test('explicit planning remains available with truthful unavailable observed readiness',async()=>{
  const {input}=fixture(),report=await createTurnBrief({...input,reconstructionHypotheses:{mode:'current'}});
  assert.equal(report.status,'advisory');assert(report.candidates.length>0);assert.equal(report.reconstructionReadiness.ready,false);
  assert.equal(report.reconstructionReadiness.status,'unavailable');assert.equal(report.reconstructionReadiness.sourceScope,'explicit-hypothetical-planning');
});

test('pure snapshot readiness requires exact observed input/team/sheet/request and carries no independent freshness claim',()=>{
  const input=currentFixture(),board=input.observed.boards[0],legalActions=input.observed.actions[0].legalActions,ownTeam=Teams.import(input.teamText),opponentSheet=input.opposingSheet;
  const source={kind:'bound-observed-turn',sessionId:input.observed.sessionId,teamId:input.expected.teamId,room:input.expected.room,rqid:input.expected.rqid,
    boardHash:boardDigest(board,legalActions),opposingSheetSha256:digest(opponentSheet),publishedOpposingSheetSha256:publishedSheetDigest(opponentSheet)};
  source.requestDigest=requestDigest({...input.expected,sessionId:source.sessionId,boardHash:source.boardHash});
  const context={board,legalActions,ownTeam,opponentSheet,source,observedPositionInput:input,reconstructionHypotheses:input.hypotheses};
  const report=createDecisionBriefFromSnapshot(context);assert.equal(report.reconstructionReadiness.ready,true);
  assert.equal(report.reconstructionReadiness.sourceRevalidated,false);assert.equal(report.reconstructionReadiness.sourceScope,'caller-owned-exact-snapshot');
  assert.equal(report.coverage.sourceRevalidated,false);
  for(const change of [value=>{value.observedPositionInput.expected.token='c'.repeat(64);},value=>{value.observedPositionInput.opposingSheet[0].item='Sitrus Berry';},
    value=>{value.observedPositionInput.observed.sessionId='other';},value=>{value.source.publishedOpposingSheetSha256='f'.repeat(64);},
    value=>{value.observedPositionInput.teamText=value.observedPositionInput.teamText.replace('32 HP','31 HP');}]){
    const changed=structuredClone(context);change(changed);const refused=createDecisionBriefFromSnapshot(changed);
    assert.equal(refused.reconstructionReadiness.ready,false);assert.equal(refused.reconstructionReadiness.status,'unavailable');
  }
  delete context.observedPositionInput;assert.equal(createDecisionBriefFromSnapshot(context).reconstructionReadiness.status,'unavailable');
});
