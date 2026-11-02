import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {projectDecisionView} from './operator-view.mjs';

const clone = value => structuredClone(value);
const stages = () => ({atk:0,def:0,spa:0,spd:0,spe:0,accuracy:0,evasion:0});
const event = (index, type, actorId, raw, extra = {}) => ({index,type,actorId,targetId:null,raw,...extra});
const mon = (id, extra = {}) => ({id,species:'Example',ability:'Example Ability',item:'exampleitem',hp:100,maxhp:100,
  status:'',boosts:stages(),fainted:false,active:true,canMegaEvo:false,pp:[4,8,12,16],
  lifecycle:{activeTurns:1,activeMoveActions:1,protectCounter:0,choiceLock:false,lastMove:false},volatiles:{},...extra});
const snapshot = () => ({turn:2,ended:false,winner:null,requestState:'move',midTurn:false,
  field:{weather:'raindance',weatherRemaining:2,terrain:'grassyterrain',terrainRemaining:1,pseudoWeather:{trickroom:{remainingTurns:1}}},
  sides:[{id:'p1',active:['a'],conditions:{reflect:{remainingTurns:2}},pokemon:[mon('a')]},
    {id:'p2',active:['b'],conditions:{},pokemon:[mon('b')]}]});
function fixture() {
  const move = event(4,'move','a','|move|p1a: sim-p1-0|Example Move|p2a: sim-p2-0',{targetId:'b',move:'Example Move'});
  const damage = event(5,'-damage','b','|-damage|p2a: sim-p2-0|0 fnt');
  const denied = event(0,'cant','a','|cant|p1a: sim-p1-0|par');
  const sample = {branchId:'pressure',seed:[1,2,3,4],accepted:{p1:{accepted:true},p2:{accepted:true}},
    start:snapshot(),openingEvents:[],events:[event(0,'','', '|'),move,damage,event(6,'faint','b','|faint|p2a: sim-p2-0')],
    eventView:'native omniscient exact HP',final:snapshot(),boundary:'forced-replacement',pendingActions:[{pokemonId:'b',choice:'move'}],
    pendingPhases:['residual'],noPendingContinuation:false,stochastic:{criticalEvents:[],missEvents:[],actionDenialEvents:[denied],
      potentialSecondaryEvents:[],randomOrderEvents:[],possibleMoveOrderTies:[{a:'a',b:'b'}],sampleOnly:true},
    hpHypotheses:[{id:'b',selectedHp:100,limitation:'Exact opposing HP remains a hypothesis.'}],
    actionOutcomes:[{id:'a',authored:{type:'move',slot:1,target:1},attemptedMove:'Example Move',denied:[],faintedBeforeAction:false,
      pendingAtBoundary:false,resolution:{id:'a',kind:'move',nativeMoveResult:true,events:[{...move,index:0},{...damage,index:1}],denials:[]}}],
    gate:{targetId:'b',beforeActionsOf:['b'],requiredActionsBy:['a'],beforeActions:[{id:'b',actionIndex:3,faintIndex:6}],
      targetKOBeforeRetaliation:false,requiredMoveAttempts:[],unresolved:true,passed:false,cleanSample:false}};
  sample.final.sides[1].pokemon[0] = mon('b',{hp:0,status:'fnt',fainted:true,active:false});
  return {engine:{gen:0,format:'gen9championsvgc2026regmc',moduleSha256:'recorded-runtime'},
    source:{kind:'explicit-offline-snapshot',liveFreshness:false},hypotheses:['Explicit opposing pair/stat hypothesis.'],
    submittedBranches:[{id:'pressure',ourActions:[{type:'move',slot:1}],opposingActions:[{type:'move',slot:2}]}],
    testedBranches:[{id:'pressure',ourActions:[{type:'move',slot:1}],opposingActions:[{type:'move',slot:2}]}],
    samples:[sample],summary:{allGatesPassed:false,samples:1},limitations:['One-turn samples are not guarantees.']};
}
const render = value => projectDecisionView(value,{now:0});

test('compact cards preserve native replacement choices, unfinished-turn markers and confusion without falling back to full repeated state',()=>{
  const raw=fixture(),sample=raw.samples[0];sample.turnComplete=false;
  sample.replacementRequest={kind:'native-replacement-required',sides:[{sideId:'p2',forceSwitch:[true,false],options:[{pokemonId:'reserve',slot:3,forSlots:[1]}]}]};
  sample.replacementDecisions=[{index:0,request:{kind:'native-replacement-required'},accepted:{p1:{accepted:true,canonical:'switch 3, pass'}}}];sample.unusedContinuations=1;
  sample.final.sides[0].pokemon[0].volatiles={confusion:{remainingTurns:null,remainingActions:2}};
  sample.final.sides[0].pokemon[0].lifecycle={activeTurns:2,activeMoveActions:1,protectCounter:0,choiceLock:false,lastMove:false,unburdenVolatile:false};
  const before=clone(raw),view=render(raw),card=view.samples[0];
  assert.equal(view.decisionViewSimulation.mode,'outcome-cards');assert.equal(card.turnComplete,false);
  for(const key of ['replacementRequest','replacementDecisions','unusedContinuations'])assert.deepEqual(card[key],sample[key]);
  assert.deepEqual(card.final.sides[0].pokemon[0].volatiles,sample.final.sides[0].pokemon[0].volatiles);assert.deepEqual(raw,before);
});
const restoreFinal = (batch, sample) => ({...sample.final,sides:sample.final.sides.map(side=>({...side,pokemon:side.pokemon.map(p=>{
  const base=batch.commonFinalPokemonProperties?.[p.id];assert.ok(!base||base.side===side.id);
  const result={...(base?.properties??{}),...p};if(result.boosts==='all-neutral')result.boosts=stages();return result;
})}))});

test('outcome cards preserve failed gates, incoming denial, native order, state, boundary and uncertainty without mutating native receipts',()=>{
  const raw=fixture(),before=clone(raw),view=render(raw),sample=view.samples[0];
  assert.deepEqual(raw,before);assert.deepEqual(sample.gate,raw.samples[0].gate);
  assert.equal(sample.gate.passed,false);assert.equal(sample.gate.targetKOBeforeRetaliation,false);
  assert.deepEqual(sample.actionOutcomes[0].eventsInTimeline,[4,5]);
  assert.equal(sample.actionOutcomes[0].nativeMoveResult,true);
  assert.deepEqual(sample.orderedEvents.map(e=>e.index),[4,5,6]);
  assert.equal(sample.orderedEvents[1].native,'|-damage|p2a: sim-p2-0|0 fnt');
  for(const key of ['accepted','boundary','pendingActions','pendingPhases','noPendingContinuation','stochastic','hpHypotheses'])assert.deepEqual(sample[key],raw.samples[0][key],key);
  assert.deepEqual(sample.final.field,raw.samples[0].final.field);assert.deepEqual(sample.final.sides[0].conditions,raw.samples[0].final.sides[0].conditions);
  assert.equal(sample.final.sides[1].pokemon[0].hp,0);assert.equal(sample.final.sides[1].pokemon[0].status,'fnt');
  assert.equal(view.decisionViewSimulation.nativeResultSha256,createHash('sha256').update(JSON.stringify(raw)).digest('hex'));
  assert.match(view.decisionViewSimulation.reading,/each exactly 0/);assert.match(view.decisionViewSimulation.omitted,/PP\/lifecycle/);
});

test('bad Protect branch retains actual null native result and every incoming denial rather than crediting an attempted move',()=>{
  const raw=fixture(),sample=raw.samples[0],block=event(5,'-activate','b','|-activate|p2a: sim-p2-0|move: Protect');
  sample.events[2]=block;sample.actionOutcomes[0].denied=[{...block,index:1}];
  Object.assign(sample.actionOutcomes[0].resolution,{nativeMoveResult:null,events:[{...sample.events[1],index:0},{...block,index:1}],denials:[{...block,index:1}]});
  sample.gate.requiredMoveAttempts=[{id:'a',moveAttemptObserved:true,eventIndex:4,denials:[block],observedWithoutDenial:false}];
  const view=render(raw),card=view.samples[0].actionOutcomes[0];
  assert.equal(card.nativeMoveResult,null);assert.deepEqual(card.denied,sample.actionOutcomes[0].denied);
  assert.deepEqual(view.samples[0].gate,sample.gate);assert.equal(view.samples[0].gate.requiredMoveAttempts[0].observedWithoutDenial,false);
});

test('local events deduplicate only with a unique complete semantic match; repeated lines and changed effects stay inline',()=>{
  const ambiguous=fixture();ambiguous.samples[0].events.push(...ambiguous.samples[0].events.slice(1,3).map(e=>({...e,index:e.index+10})));
  const changed=fixture();changed.samples[0].actionOutcomes[0].resolution.events[1].sourceId='different-source';
  const order=fixture();order.samples[0].actionOutcomes[0].resolution.events.reverse();
  for(const raw of [ambiguous,changed,order]){
    const action=render(raw).samples[0].actionOutcomes[0];
    assert.equal(action.eventsInTimeline,undefined);assert.deepEqual(action.resolutionEvents,raw.samples[0].actionOutcomes[0].resolution.events);
  }
});

test('future/contradictory transformed schemas fall back to the complete native result with no duplicate original subtree',()=>{
  const changes=[v=>v.future={effect:'unknown'},v=>v.samples[0].future=1,v=>v.samples[0].final.future=1,
    v=>v.samples[0].final.sides[0].pokemon[0].future=1,v=>v.samples[0].start.sides[0].pokemon[0].lifecycle.future=1,
    v=>v.samples[0].actionOutcomes[0].future=1,v=>v.samples[0].actionOutcomes[0].resolution.future=1,
    v=>v.samples[0].events[1].future=1,v=>{v.samples[0].events[1].type='future-event';v.samples[0].events[1].raw='|future-event|a';},
    v=>v.samples[0].openingEvents.push(event(0,'future-entry','a','|future-entry|a')),
    v=>v.samples[0].events[1].raw='|cant|a|par',v=>v.samples[0].events[1].move='Contradictory Move',
    v=>v.samples[0].events[2].index=4];
  for(const change of changes){const raw=fixture();change(raw);const before=clone(raw),view=render(raw),{decisionViewSimulation,...retained}=view;
    assert.equal(decisionViewSimulation.mode,'full-fallback');assert.deepEqual(retained,raw);assert.deepEqual(raw,before);assert.equal(decisionViewSimulation.original,undefined);
  }
});

test('all-neutral is limited to exactly seven known zero stages; partial, nonzero and future axes remain explicit',()=>{
  for(const boosts of [{},{atk:0},{...stages(),atk:1},{...stages(),future:0}]){
    const raw=fixture();raw.samples[0].final.sides[0].pokemon[0].boosts=boosts;
    assert.deepEqual(render(raw).samples[0].final.sides[0].pokemon[0].boosts,boosts);
  }
  assert.equal(render(fixture()).samples[0].final.sides[0].pokemon[0].boosts,'all-neutral');
});

test('malformed native boosts cannot masquerade as the readable all-neutral marker',()=>{
  for(const boosts of ['all-neutral',null,[],0]){
    const raw=fixture();raw.samples[0].final.sides[0].pokemon[0].boosts=boosts;
    const before=clone(raw),view=render(raw),{decisionViewSimulation,...retained}=view;
    assert.equal(decisionViewSimulation.mode,'full-fallback');
    assert.equal(decisionViewSimulation.reason,'malformed boost state');
    assert.deepEqual(retained,raw);assert.deepEqual(raw,before);
  }
});

test('readable common final properties reconstruct exact final states across all cases; changed HP/status/item/form/boosts stay in their cards',()=>{
  const first=fixture(),second=fixture();second.samples[0].branchId='alternative';
  const b=second.samples[0].final.sides[1].pokemon[0];Object.assign(b,{hp:37,status:'par',fainted:false,active:true,item:'differentitem',species:'Changed Form',boosts:{...stages(),spe:1}});
  const raw={cases:[{id:'one',result:first},{id:'two',result:second}],batch:{samples:2},source:{kind:'explicit'}};
  const before=clone(raw),view=render(raw);
  assert.deepEqual(raw,before);assert.deepEqual(view.commonToEveryCase.hypotheses,first.hypotheses);
  for(let index=0;index<2;index++){
    const expected=clone(raw.cases[index].result.samples[0].final);expected.sides.forEach(s=>s.pokemon.forEach(p=>{delete p.pp;delete p.lifecycle;}));
    assert.deepEqual(restoreFinal(view,view.cases[index].result.samples[0]),expected);
  }
  assert.equal(view.cases[1].result.samples[0].final.sides[1].pokemon[0].hp,37);
  assert.equal(view.cases[1].result.samples[0].final.sides[1].pokemon[0].item,'differentitem');
  assert.equal(view.cases[1].result.samples[0].gate.passed,false);
  assert.equal(view.cases[0].result.samples[0].start,undefined);
});

function observedEvidenceBatch(){
  const calculationRef={id:'1409ebd0-7239-4254-a923-3c716c0de927',teamId:'a'.repeat(64),roomId:'battle-gen9championsvgc2026regmcbo3-42',turn:2,tool:'simulate_turn_batch',path:'cache/calculation-evidence/fixture.json',sha256:'c'.repeat(64)};
  const source={kind:'bound-observed-native-turn-position',sessionId:'observed-simulation-view-fixture',teamId:calculationRef.teamId,room:calculationRef.roomId+'-private123pw',rqid:7,token:'b'.repeat(64),revision:9,observedAt:1000,opposingSheetSha256:'d'.repeat(64),ownRequestOrder:[],hpObservations:{},sourceSha256:'e'.repeat(64),limitations:['A retained matching observation is not proof of current server freshness.']};
  return {cases:['removal','delivery-support'].map(id=>({id,result:{...fixture(),source:clone(source),calculationRef:{...calculationRef,caseId:id}}})),batch:{cases:2,samples:2,nativeSampleIsolation:true},source,calculationRef};
}

test('observed native batch cards preserve top-level and case-specific calculation evidence identities exactly',()=>{
  // executeNativeRequest in simulation/mcp-tools.mjs records one batch receipt
  // and copies it into each case with that case's exact ID. Rendering does not
  // validate or manufacture this evidence; it must retain the native identities.
  const raw=observedEvidenceBatch(),before=clone(raw),view=render(raw);
  assert.equal(view.decisionViewSimulation.mode,'outcome-cards');assert.deepEqual(raw,before);
  assert.deepEqual(view.calculationRef,raw.calculationRef);assert.equal(view.calculationRef.caseId,undefined);
  assert.deepEqual(view.source,raw.source);assert.deepEqual(view.commonToEveryCase.source,raw.source);
  assert.equal(view.commonToEveryCase.calculationRef,undefined);
  for(const [index,entry] of view.cases.entries()){
    assert.equal(entry.id,raw.cases[index].id);assert.deepEqual(entry.result.calculationRef,raw.cases[index].result.calculationRef);
    assert.equal(entry.result.calculationRef.caseId,entry.id);
    assert.equal(entry.result.nativeResultSha256,createHash('sha256').update(JSON.stringify(raw.cases[index].result)).digest('hex'));
  }
  assert.deepEqual(render(view),view);
});

test('a recognized batch receipt does not hide unknown batch or case fields from full fallback',()=>{
  for(const change of [raw=>{raw.futureEvidence={unknown:true};},raw=>{raw.cases[0].futureEvidence={unknown:true};},raw=>{raw.cases[0].result.futureEvidence={unknown:true};}]){
    const raw=observedEvidenceBatch();change(raw);const before=clone(raw),view=render(raw),{decisionViewSimulation,...retained}=view;
    assert.equal(decisionViewSimulation.mode,'full-fallback');assert.deepEqual(retained,raw);assert.deepEqual(raw,before);
    assert.deepEqual(retained.calculationRef,raw.calculationRef);
    assert.equal(decisionViewSimulation.nativeResultSha256,createHash('sha256').update(JSON.stringify(raw)).digest('hex'));
  }
});

test('different hypotheses, missing/reowned actors and unknown batch fields never borrow common properties from another scenario',()=>{
  for(const change of [v=>v.cases[1].result.hypotheses=['Different hypothesis'],
    v=>v.cases[1].result.samples[0].final.sides[0].pokemon.pop(),
    v=>{const sides=v.cases[1].result.samples[0].final.sides;[sides[0].pokemon,sides[1].pokemon]=[sides[1].pokemon,sides[0].pokemon];}]){
    const raw={cases:[{id:'one',result:fixture()},{id:'two',result:fixture()}],batch:{samples:2},source:{kind:'explicit'}};change(raw);const view=render(raw);
    if(raw.cases[0].result.hypotheses[0]!==raw.cases[1].result.hypotheses[0])assert.equal(view.commonToEveryCase.hypotheses,undefined);
    else assert.equal(view.commonFinalPokemonProperties,undefined);
  }
  const raw={cases:[{id:'one',result:fixture()}],batch:{samples:1},source:{kind:'explicit'},future:{unknown:true}},view=render(raw);
  const {decisionViewSimulation,...retained}=view;assert.equal(decisionViewSimulation.mode,'full-fallback');assert.deepEqual(retained,raw);
});

test('arbitrary actor IDs remain own dictionary entries and duplicate identities use complete fallback',()=>{
  for(const id of ['__proto__','constructor']){
    const raw={cases:[{id:'one',result:fixture()},{id:'two',result:fixture()}],batch:{samples:2},source:{kind:'explicit'}};
    raw.cases.forEach(c=>{c.result.samples[0].final.sides[0].pokemon[0].id=id;});
    const before=clone(raw),view=render(raw);assert.deepEqual(raw,before);
    assert.ok(Object.hasOwn(view.commonFinalPokemonProperties,id));
    assert.equal(view.commonFinalPokemonProperties[id].properties.hp,100);
    assert.equal(restoreFinal(view,view.cases[0].result.samples[0]).sides[0].pokemon[0].id,id);
  }
  const raw={cases:[{id:'one',result:fixture()},{id:'two',result:fixture()}],batch:{samples:2},source:{kind:'explicit'}};
  raw.cases[1].result.samples[0].final.sides[1].pokemon[0].id='a';
  const {decisionViewSimulation,...retained}=render(raw);
  assert.equal(decisionViewSimulation.mode,'full-fallback');assert.deepEqual(retained,raw);
});

test('own cards and full fallbacks are idempotent and never hash an already rendered card as a new native receipt',()=>{
  const unknown=fixture();unknown.samples[0].future='unrecognized';
  const batch={cases:[{id:'one',result:fixture()},{id:'two',result:fixture()}],batch:{samples:2},source:{kind:'explicit'}};
  batch.cases[1].result.engine.moduleSha256='different-runtime';
  const badBatch=clone(batch);badBatch.future='unrecognized';
  for(const raw of [fixture(),unknown,batch,badBatch]){
    const first=render(raw),before=clone(first),second=render(first);
    assert.deepEqual(second,first);assert.deepEqual(first,before);
    assert.equal(second.decisionViewSimulation.nativeResultSha256,first.decisionViewSimulation.nativeResultSha256);
  }
});
