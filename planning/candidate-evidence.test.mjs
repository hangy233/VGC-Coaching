import assert from 'node:assert/strict';
import {test} from 'node:test';
import {analyzeNumerics} from './numerics.mjs';
import {requestDigest} from './identity.mjs';
import {projectCandidateEvidence,projectCandidateEvidenceRows,projectCandidateCommandEvidence} from './candidate-evidence.mjs';

const points={hp:0,atk:0,def:0,spa:0,spd:0,spe:0};
const source={kind:'bound-observed-turn',sessionId:'fixture-session',teamId:'a'.repeat(64),room:'battle-gen9championsvgc2026regmc-1',rqid:2,
  boardHash:'c'.repeat(64),opposingSheetSha256:'d'.repeat(64)};
const requestSource={sessionId:source.sessionId,teamId:source.teamId,room:source.room,rqid:source.rqid,token:'b'.repeat(64)};
source.requestDigest=requestDigest({...requestSource,boardHash:source.boardHash});
function actor(id,species,own,slot,moves){return {id,species,own,side:own?'p1':'p2',slot,selected:'selected',nature:'Serious',statPoints:{...points},
  ability:'Pressure',item:'',itemKnown:true,hp:{current:100,max:100,precision:'exact'},status:null,boosts:{},moves,pp:null,lifecycle:null,volatiles:{},capabilities:[],raw:{fainted:false}};}
function context(){return {ownSide:'p1',foeSide:'p2',turn:2,field:{weather:null,terrain:null,conditions:{}},sides:[{id:'p1',conditions:{}},{id:'p2',conditions:{}}],
  actors:[actor('our-a','Mew',true,1,['Protect','Psychic']),actor('our-b','Mewtwo',true,2,['Protect']),actor('reserve-a','Suicune',true,null,['Protect']),
    actor('reserve-b','Raikou',true,null,['Protect']),actor('foe-a','Mew',false,1,['Psychic']),actor('foe-b','Mewtwo',false,2,['Protect'])]};}
const pair=[{type:'move',slot:1,target:1},{type:'move',slot:1}];
async function fixture({numerics=true,hypotheses=[],field}={}){
  const ctx=context();if(field)ctx.field=field;
  const numbers=numerics?await analyzeNumerics(ctx,{hypotheses,maxCalls:128,budgetMs:5000,callTool:Object.assign(async(tool,input)=>({structuredContent:tool==='calculate_speed'?
    {gen:0,pokemon:input.pokemon.map(row=>({label:row.label,effectiveSpeed:100,rawSpeed:100})),order:[{rank:1,labels:input.pokemon.map(row=>row.label),tie:true}],limitations:[],calculationRef:{id:'speed-fixture'}}:
    {gen:0,range:[20,30],damage:[20,30],attackerHP:{current:input.attackerOptions.curHP??100,max:100,unit:'actual-hp'},
      defenderHP:{current:input.defenderOptions.curHP??100,max:100,unit:'actual-hp'},percent:null,calculationRef:{id:'damage-fixture'}}}),{runtimeVersion:'fixture-only'})}):{damage:[],checks:[],order:[]};
  return {status:'advisory',source:structuredClone(source),objective:{requiredActors:['our-a'],preserve:['our-a'],targets:['foe-a']},actors:ctx.actors,
    legalActions:{active:[{moves:[{id:'psychic',move:'Psychic',target:'normal'},{id:'protect',move:'Protect',target:'self'}]},
      {moves:[{id:'protect',move:'Protect',target:'self'}]}]},
    candidates:[{id:'attack',purpose:'Author-declared pressure on foe-a',actions:structuredClone(pair),requiredActors:['our-a']}],
    pairDependencies:[{candidateId:'attack',actions:structuredClone(pair),warnings:[{code:'PAIR_ACTOR_EXPOSURE',actorId:'our-a',roles:['required-actor','preserved-actor','sole-progress'],
      selectedMove:'Psychic',partnerAction:'protect',opposing:[{actorId:'foe-a',damageMoves:['Psychic'],denialMoves:[]}],pairedSupport:[],goals:{requiredActionsBy:['our-a'],survive:['our-a']}}]}],
    field:ctx.field,numericContext:{sides:ctx.sides,hypotheses},order:numbers.order,numericChecks:{damage:numbers.damage,checks:numbers.checks},coverage:{sourceRevalidated:true},fieldTransitions:[]};
}
const full=report=>projectCandidateEvidence(report,{maxBytes:32768});
function deliveryEnvelope(report,{failed=false,survive=true,pending=false}={}){
  const ownRequestOrder=report.actors.filter(row=>row.own).map((row,index)=>({controlPokemonId:row.id,snapshotId:row.id,requestIndex:index+1}));
  const candidate=report.candidates[0],nativeSource={...requestSource,ownRequestOrder},hypotheses={label:'Authored complete paired scenario'},seed=[1,2,3,4];
  const authored=candidate.actions.map(action=>action.type==='switch'?{type:'switch',pokemonId:action.pokemonId??ownRequestOrder.find(row=>row.requestIndex===action.slot)?.controlPokemonId}:structuredClone(action));
  const entrantId=authored[0].type==='switch'?authored[0].pokemonId:null;
  const required={id:'our-a',authored:structuredClone(authored[0]),attemptedMove:entrantId?null:'Psychic',status:failed?'failed':'passed',nativeMoveResult:entrantId?null:!failed,pendingAtBoundary:pending,
    ...(entrantId?{entrantId}:{}),
    denials:failed?[{type:'cant',raw:'|cant|our-a|flinch'}]:[]};
  const sampled={seed,passed:!failed&&survive&&!pending,cleanSample:true,requiredActions:[required],
    actionAttempts:[{id:'our-a',authored:structuredClone(authored[0]),attemptedMove:entrantId?null:'Psychic',nativeMoveResult:entrantId?null:!failed,faintedBeforeAction:false,pendingAtBoundary:pending,
      ...(entrantId?{entrantId}:{}),denials:required.denials},
      {id:'our-b',authored:structuredClone(authored[1]),attemptedMove:'Protect',nativeMoveResult:true,faintedBeforeAction:false,pendingAtBoundary:false,denials:[]}],
    surviveGoals:[{id:'our-a',status:survive?'passed':'failed',aliveAtBoundary:survive}],fieldGoals:[],boundary:pending?'forced-replacement':'next-turn',
    pendingActions:pending?['foe-a']:[],noPendingContinuation:!pending,hpHypotheses:[],sampleOnly:true};
  return {source:structuredClone(report.source),candidateId:candidate.id,actions:structuredClone(candidate.actions),result:{source:structuredClone(requestSource),hypotheses,seeds:[seed],
    coverage:{sampleOnly:true,suppliedOpposingBranchesOnly:true,checkedCandidates:1},checkedCandidates:[{id:candidate.id,ourActions:structuredClone(candidate.actions),checked:true,
      status:failed?'sampled-failure':'sampled-pass',source:nativeSource,hypotheses,seeds:[seed],branches:[{id:'paired-branch',opposingActions:[{type:'move',slot:1,target:1},{type:'move',slot:1}],
        objective:{requiredActionsBy:['our-a'],survive:['our-a']},samples:[sampled]}]}]}};
}

test('joins actual-shaped MCP parent checks and authoritative move slots without inventing a payoff',async()=>{
  const report=await fixture(),before=structuredClone(report),card=full(report),row=card.candidates[0];
  assert.equal(row.objectiveFit.requiredSelected[0],'our-a');assert.deepEqual(row.objectiveFit.targeted,['foe-a']);
  assert.ok(row.payoff.mechanical.some(value=>value.status==='supported'&&value.move==='Psychic'&&value.attackerId==='our-a'));
  assert.ok(row.payoff.mechanical.filter(value=>value.status==='supported').every(value=>value.scope==='snapshot-range-only'&&value.delivery==='unavailable'));
  assert.ok(row.order.some(value=>value.status==='supported'&&value.scope==='listed-equal-priority-only'));
  assert.equal(row.payoff.status,'unavailable');assert.equal(row.payoff.actionDelivery[0].status,'unavailable');assert.equal(row.payoff.targetRemoval[0].status,'unavailable');
  assert.equal(row.currentExposure.status,'supported');assert.equal(row.currentExposure.ref.candidateId,'attack');
  assert.equal(card.coverage.ranking,'none');assert.equal(card.selectedCandidate,undefined);assert.deepEqual(report,before);
});

test('partial and mixed calculator rows do not borrow success from another check',async()=>{
  for(const mutate of [
    report=>{report.numericChecks.checks=[];},
    report=>{report.numericChecks.checks.push(structuredClone(report.numericChecks.checks.find(row=>row.tool==='calculate_damage')));},
    report=>{for(const row of report.numericChecks.damage)row.source={...source,rqid:99};},
    report=>{for(const check of report.numericChecks.checks)check.status='late';},
    report=>{for(const check of report.numericChecks.checks)if(check.tool==='calculate_damage')check.input.attacker='Charizard-Mega-Y';},
    report=>{for(const row of report.numericChecks.damage)if(row.attackerId==='our-a')row.range=[999,999];},
  ]){
    const report=await fixture();mutate(report);const rows=full(report).candidates[0].payoff.mechanical.filter(row=>row.attackerId==='our-a');
    assert.ok(rows.length);assert.ok(rows.every(row=>row.status==='unavailable'));
  }
});

test('stale source removes candidate authority and an unvalidated snapshot credits no numbers',async()=>{
  const report=await fixture();report.status='stale-source';assert.deepEqual(full(report).candidates,[]);
  report.status='advisory';report.coverage.sourceRevalidated=false;
  const row=full(report).candidates[0];assert.ok(row.payoff.mechanical.every(value=>value.status==='unavailable'));assert.ok(row.order.every(value=>value.status==='unavailable'));
  report.candidates[0].source={...source,boardHash:'e'.repeat(64)};assert.deepEqual(full(report).candidates,[]);
});

test('Mega and switched recipients cannot inherit current-form numerical evidence',async()=>{
  const report=await fixture();report.candidates[0].actions[0].mega=true;
  const row=full(report).candidates[0];assert.ok(row.payoff.mechanical.every(value=>value.status==='unavailable'));assert.ok(row.order.every(value=>value.status==='unavailable'));
  assert.ok(row.payoff.mechanical.some(value=>/Mega/.test(value.reason)));
  const switched=await fixture();switched.candidates[0].actions[0]={type:'switch',pokemonId:'reserve-a'};
  assert.ok(full(switched).candidates[0].payoff.mechanical.every(value=>value.status==='unavailable'));
});

test('missing assumptions, scenarios and move slot evidence remain unavailable',async()=>{
  for(const mutate of [report=>{for(const row of report.numericChecks.damage)delete row.assumptions;},
    report=>{report.order=[];},report=>{delete report.legalActions;},report=>{report.legalActions.active[0].moves[0]={move:'Protect',target:'self'};}]){
    const report=await fixture();mutate(report);const row=full(report).candidates[0];
    assert.ok(row.payoff.mechanical.filter(value=>value.attackerId==='our-a').every(value=>value.status==='unavailable'));
  }
});

test('named assumptions remain conditional and cannot import current-form or known-set conflicts',async()=>{
  const report=await fixture({hypotheses:[{id:'named-spread',label:'Named investment scenario',pokemon:{}}]});
  report.numericChecks.damage.sort((a,b)=>(a.scenarioId==='named-spread'?-1:1)-(b.scenarioId==='named-spread'?-1:1));
  const card=full(report);assert.ok(card.candidates[0].payoff.mechanical.some(row=>row.status==='supported'&&row.scenarioId==='named-spread'&&row.assumptions===1));
  for(const row of report.numericChecks.damage)row.assumptions=[];
  assert.ok(full(report).candidates[0].payoff.mechanical.filter(row=>row.scenarioId==='named-spread').every(row=>row.status==='unavailable'));
});

test('old field, side conditions, hypotheses and changed exact inputs cannot inherit numerical provenance',async()=>{
  for(const mutate of [
    report=>{report.field.weather='raindance';},
    report=>{report.numericContext.sides[0].conditions.reflect={};},
    report=>{report.numericContext.hypotheses=[{id:'other',pokemon:{}}];},
    report=>{delete report.numericContext;},
    report=>{for(const check of report.numericChecks.checks)delete check.inputContext;},
    report=>{for(const check of report.numericChecks.checks)check.inputContext.scenarioId='old-scenario';},
  ]){
    const report=await fixture({field:{weather:'sunnyday',terrain:null,conditions:{}}});mutate(report);const row=full(report).candidates[0];
    assert.ok(row.payoff.mechanical.length);assert.ok(row.payoff.mechanical.every(value=>value.status==='unavailable'));assert.ok(row.order.every(value=>value.status==='unavailable'));
  }
});

test('a checked denied action stays denied despite an unrelated positive numerical range',async()=>{
  const report=await fixture();report.deliveryEvidence=[deliveryEnvelope(report,{failed:true})];
  const row=full(report).candidates[0];assert.equal(row.payoff.actionDelivery[0].status,'denied');assert.equal(row.payoff.status,'denied');
  assert.equal(row.preservation[0].status,'supported');assert.equal(row.payoff.targetRemoval[0].status,'unavailable');
  assert.equal(row.payoff.actionDelivery[0].samples[0].ref.branchId,'paired-branch');
});

test('sampled delivery, large range and survival never establish target removal or later continuation',async()=>{
  const report=await fixture();
  for(const row of report.numericChecks.damage){row.range=[110,130];const check=report.numericChecks.checks.find(check=>check.id===row.checkId);if(check)check.result.range=[110,130];}
  report.deliveryEvidence=[deliveryEnvelope(report)];const row=full(report).candidates[0];
  assert.equal(row.payoff.actionDelivery[0].status,'supported');assert.equal(row.payoff.targetRemoval[0].status,'unavailable');
  assert.equal(row.payoff.status,'unavailable');assert.equal(row.continuation.status,'unavailable');
  assert.equal(row.preservation[0].scope,'supplied-samples-only');
});

test('field payoff requires the exact checked goal and establishment, not a matching preexisting field',async()=>{
  const report=await fixture({numerics:false});report.candidates[0].actions[0]={type:'move',slot:1};
  report.legalActions.active[0].moves[0]={id:'raindance',move:'Rain Dance',target:'all'};
  const envelope=deliveryEnvelope(report),branch=envelope.result.checkedCandidates[0].branches[0],sample=branch.samples[0];
  for(const goal of [sample.requiredActions[0],sample.actionAttempts[0]]){goal.authored={type:'move',slot:1};goal.attemptedMove='Rain Dance';}
  branch.objective.field={weather:'raindance'};
  sample.fieldGoals=[{name:'weather',expected:'raindance',actual:'raindance',initial:'',matchedAtBoundary:true,establishedByRequiredAction:true,
    status:'passed',evidence:[{type:'-weather',raw:'|-weather|RainDance'}]}];
  report.deliveryEvidence=[envelope];assert.equal(full(report).candidates[0].payoff.fieldState[0].status,'supported');
  sample.fieldGoals[0].initial='raindance';sample.fieldGoals[0].establishedByRequiredAction=false;sample.fieldGoals[0].evidence=[];
  assert.equal(full(report).candidates[0].payoff.fieldState[0].status,'unavailable');
});

test('delivery envelopes need exact candidate/actions, request digest and checked samples',async()=>{
  for(const mutate of [envelope=>{envelope.actions[0].target=2;},envelope=>{envelope.source.rqid=3;},
    envelope=>{envelope.result.source.token='f'.repeat(64);},envelope=>{envelope.result.checkedCandidates[0].checked=false;},
    envelope=>{envelope.result.checkedCandidates[0].branches[0].samples[0].requiredActions[0].authored.target=2;},
    envelope=>{envelope.result.checkedCandidates[0].hypotheses={label:'Different assumptions'};}]){
    const report=await fixture(),envelope=deliveryEnvelope(report);mutate(envelope);report.deliveryEvidence=[envelope];
    assert.equal(full(report).candidates[0].payoff.actionDelivery[0].status,'unavailable');
  }
});

test('selected reserves keep entry and continuation unknown even when another actor survives',async()=>{
  const report=await fixture();report.actors.push({...actor('registered-foe','Zapdos',false,null,['Thunderbolt']),selected:'unknown'});
  report.deliveryEvidence=[deliveryEnvelope(report)];let row=full(report).candidates[0];
  assert.deepEqual(row.continuation.selectedReserves.map(value=>value.actorId),['reserve-a','reserve-b']);
  assert.ok(row.continuation.selectedReserves.every(value=>value.entrySurvival.status==='unavailable'&&value.continuation==='unavailable'));
  const sample=report.deliveryEvidence[0].result.checkedCandidates[0].branches[0];sample.objective.survive.push('reserve-a');sample.samples[0].surviveGoals.push({id:'reserve-a',status:'passed',aliveAtBoundary:true});
  row=full(report).candidates[0];assert.equal(row.continuation.selectedReserves[0].entrySurvival.status,'unavailable');
  assert.equal(row.continuation.selectedReserves[0].boundarySurvival.status,'supported');
  assert.equal(row.continuation.selectedReserves[0].continuation,'unavailable');
});

test('entry survival requires the selected native switch entrant alive and active at a completed boundary',async()=>{
  for(const action of [{type:'switch',pokemonId:'reserve-a'},{type:'switch',slot:3}]){
    const report=await fixture({numerics:false});report.candidates[0].actions[0]=action;
    const envelope=deliveryEnvelope(report),branch=envelope.result.checkedCandidates[0].branches[0],sample=branch.samples[0];
    branch.objective.survive.push('reserve-a');sample.surviveGoals.push({id:'reserve-a',status:'passed',aliveAtBoundary:true,activeAtBoundary:true});
    report.deliveryEvidence=[envelope];let row=full(report).candidates[0];
    assert.equal(row.payoff.actionDelivery[0].status,'supported');assert.equal(row.continuation.selectedReserves[0].entrySurvival.status,'supported');
    assert.equal(row.continuation.selectedReserves[0].continuation,'unavailable');
    sample.requiredActions[0].entrantId='reserve-b';sample.actionAttempts[0].entrantId='reserve-b';
    row=full(report).candidates[0];assert.equal(row.continuation.selectedReserves[0].entrySurvival.status,'unavailable');
    sample.requiredActions[0].entrantId='reserve-a';sample.actionAttempts[0].entrantId='reserve-a';sample.surviveGoals[1].activeAtBoundary=false;
    assert.equal(full(report).candidates[0].continuation.selectedReserves[0].entrySurvival.status,'unavailable');
    sample.surviveGoals[1].activeAtBoundary=true;sample.boundary='forced-replacement';
    assert.equal(full(report).candidates[0].continuation.selectedReserves[0].entrySurvival.status,'unavailable');
  }
});

test('malformed, duplicate or missing declared branch/seed/goal coverage cannot promote the favorable subset',async()=>{
  const mutations=[
    branch=>{branch.samples[1].requiredActions[0].authored.target=2;},
    branch=>{branch.samples[1].seed=structuredClone(branch.samples[0].seed);},
    branch=>{branch.samples.pop();},
    branch=>{branch.samples[1].requiredActions=[];},
    branch=>{branch.samples[1].boundary='unknown';},
    branch=>{branch.samples[1].actionAttempts[1].authored.slot=2;},
    branch=>{branch.samples[1].surviveGoals=[];},
  ];
  for(const mutate of mutations){
    const report=await fixture({numerics:false}),envelope=deliveryEnvelope(report),entry=envelope.result.checkedCandidates[0],branch=entry.branches[0],seed=[4,3,2,1];
    entry.seeds.push(seed);envelope.result.seeds=structuredClone(entry.seeds);branch.samples.push({...structuredClone(branch.samples[0]),seed});
    mutate(branch);report.deliveryEvidence=[envelope];const row=full(report).candidates[0];
    assert.equal(row.payoff.actionDelivery[0].status,'unavailable');assert.equal(row.preservation[0].status,'unavailable');
    assert.equal(row.deliveryCoverage.expectedSamples,2);assert.equal(row.deliveryCoverage.validatedEnvelopes,0);assert.equal(row.deliveryCoverage.invalidEnvelopes,1);
  }
  const report=await fixture({numerics:false}),envelope=deliveryEnvelope(report),entry=envelope.result.checkedCandidates[0];
  entry.branches.push(structuredClone(entry.branches[0]));report.deliveryEvidence=[envelope];
  assert.equal(full(report).candidates[0].payoff.actionDelivery[0].status,'unavailable');
  entry.branches[1].id='second-authored-branch';
  for(const branch of entry.branches)branch.samples.push({...structuredClone(branch.samples[0]),seed:[4,3,2,1]});
  entry.seeds.push([4,3,2,1]);envelope.result.seeds=structuredClone(entry.seeds);
  const valid=full(report).candidates[0];assert.equal(valid.payoff.actionDelivery[0].status,'supported');assert.equal(valid.payoff.actionDelivery[0].samples.length,4);
  assert.equal(valid.deliveryCoverage.expectedSamples,4);assert.equal(valid.deliveryCoverage.validatedSamples,4);assert.equal(valid.deliveryCoverage.invalidEnvelopes,0);
});

test('an objective checked in only one otherwise valid branch remains unavailable across supplied samples',async()=>{
  const report=await fixture({numerics:false}),envelope=deliveryEnvelope(report),entry=envelope.result.checkedCandidates[0];
  const branch=structuredClone(entry.branches[0]);branch.id='partner-only';branch.objective.requiredActionsBy=['our-b'];
  branch.samples[0].requiredActions=[{...structuredClone(branch.samples[0].actionAttempts[1]),status:'passed'}];
  entry.branches.push(branch);report.deliveryEvidence=[envelope];
  const row=full(report).candidates[0];assert.equal(row.deliveryCoverage.validatedSamples,2);
  assert.equal(row.payoff.actionDelivery[0].status,'unavailable');assert.equal(row.payoff.actionDelivery[0].uncheckedSamples,1);
});

test('zero-numeric plans expose bounded exact questions without pretending preparation ran',async()=>{
  const report=await fixture({numerics:false}),card=full(report),row=card.candidates[0];
  assert.deepEqual(row.payoff.mechanical,[]);assert.equal(row.payoff.status,'unavailable');
  assert.ok(row.pendingQuestions.some(value=>value.kind==='damage-range'&&value.attackerId==='our-a'&&value.defenderId==='foe-a'&&value.move==='psychic'));
  assert.ok(row.pendingQuestions.some(value=>value.kind==='paired-delivery'&&value.authoredBranchesRequired));
  assert.deepEqual(projectCandidateEvidenceRows(report,{maxBytes:32768}),card.candidates);
  const command=projectCandidateCommandEvidence(row,{candidateIndex:0});assert.equal(command.actions,undefined);assert.equal(command.candidateId,undefined);
  assert.equal(command.payoff,row.payoff.status);assert.equal(command.ref.index,0);assert.ok(Buffer.byteLength(JSON.stringify(command))<850);
});

test('max3 projection obeys a byte budget with explicit omissions and intact source/actions',async()=>{
  const report=await fixture({numerics:false});report.candidates=Array.from({length:6},(_,index)=>({...structuredClone(report.candidates[0]),id:`plan-${index+1}`}));
  const card=projectCandidateEvidence(report);
  assert.ok(Buffer.byteLength(JSON.stringify(card))<=4096);assert.equal(card.coverage.ranking,'none');assert.equal(card.candidates.length,3);
  assert.equal(card.coverage.compared+card.coverage.omittedCandidates+card.coverage.rejectedCandidates,6);
  assert.deepEqual(card.source,source);assert.ok(card.candidates.every(row=>JSON.stringify(row.actions)===JSON.stringify(pair)));
  assert.throws(()=>projectCandidateEvidence(report,{maxCandidates:4}),RangeError);
  assert.throws(()=>projectCandidateEvidence(report,{maxBytes:1000}),RangeError);
});
