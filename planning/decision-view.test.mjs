import test from 'node:test';
import assert from 'node:assert/strict';
import {projectDecisionView,projectPairDependencies} from './decision-view.mjs';
import {currentFixture} from '../simulation/observed-position.fixtures.mjs';
import {inspectObservedPositionReadiness} from '../simulation/observed-position-readiness.mjs';
import {projectObservedReadinessCard} from '../simulation/observed-position-preparation.mjs';

function report(){return {briefId:'receipt',status:'advisory',source:{kind:'bound-observed-turn',sessionId:'session',teamId:'a'.repeat(64),room:'battle-gen9championsvgc2026regmcbo3-701',rqid:2,boardHash:'b'.repeat(64),requestDigest:'c'.repeat(64),opposingSheetSha256:'d'.repeat(64)},
  objective:{description:'x'.repeat(1000),requiredActors:['own-a'],preserve:['own-a'],targets:['foe-a']},candidates:Array.from({length:6},(_,i)=>({id:`candidate-${i}`,purpose:'A conditional route '.repeat(25),actions:[{type:'move',slot:1,target:1,mega:true},{type:'switch',slot:4}],heuristic:true,warnings:['Delivery remains unchecked.']})),
  actors:Array.from({length:12},(_,i)=>({id:`actor-${i}`})),priorities:Array.from({length:16},()=>({tier:1,actorId:'foe-a',targetId:'own-a',evidence:'conditional-calculation',reason:'Relevant threat '.repeat(30)})),threats:[],order:[],fieldTransitions:[{}],
  numericChecks:{damage:[{status:'unavailable'}]},coverage:{sourceRevalidated:true,candidates:{knownBlockedOptions:[{actorId:'own-a',move:'Fake Out',reason:'Armor Tail currently blocks this priority move'}]},numerics:{attemptedCalls:0,budgetExhausted:true,callLimitReached:true}},warnings:[{code:'DENIAL_UNRESOLVED',message:'Long evidence '.repeat(1000)},{code:'NUMERICAL_LIMIT',message:'Call budget exhausted'}]};}

test('decision projection is bounded, retains complete explicitly selectable pairs and binding, and counts omissions',()=>{
  const full=report(),before=structuredClone(full),view=projectDecisionView(full);
  assert(Buffer.byteLength(JSON.stringify(view))<=4096);assert.equal(view.kind,'champions-turn-decision');assert(view.candidates.length>0&&view.candidates.length<=3);
  assert.deepEqual(view.source,full.source);assert.deepEqual(view.candidates[0].actions,full.candidates[0].actions);assert.equal(view.candidates[0].id,full.candidates[0].id);
  assert.equal(view.candidates[0].delivery,'unchecked');assert.equal(view.criticalUnknowns.unavailableDamage,1);assert(view.criticalUnknowns.warningCodes.includes('DENIAL_UNRESOLVED'));
  assert.equal(view.knownBlockedOptions[0].move,'Fake Out');assert.match(view.knownBlockedOptions[0].reason,/Armor Tail/);
  assert.equal(view.coverage.budgetExhausted,true);assert.equal(view.viewCoverage.omitted.candidates,6-view.candidates.length);assert.equal(view.viewCoverage.omitted.warningMessages,2);
  assert.equal(view.viewCoverage.fullViewAvailable,true);assert.deepEqual(full,before);
});

test('stale reports expose no selectable candidate and long bound identities are preserved rather than truncated',()=>{
  const full=report();full.status='stale-source';const stale=projectDecisionView(full);assert.deepEqual(stale.candidates,[]);assert.equal(stale.criticalUnknowns.sourceRevalidated,true);
  full.status='advisory';full.source.sessionId='s'.repeat(200);full.candidates.forEach(candidate=>candidate.id='i'.repeat(200));full.objective.preserve=Array(6).fill('p'.repeat(200));
  const small=projectDecisionView(full,{maxBytes:3000});assert(Buffer.byteLength(JSON.stringify(small))<=3000);assert.equal(small.source.sessionId,full.source.sessionId);
  assert(small.candidates.every(candidate=>candidate.id===full.candidates[0].id&&candidate.actions.length===2));assert(small.viewCoverage.omitted.candidates>0);
});

test('untrusted warning volume cannot inflate the display beyond its byte budget',()=>{
  const full=report();full.warnings.push(...Array.from({length:200},(_,i)=>({code:`UNKNOWN-${i}-${'x'.repeat(200)}`,message:'Large raw detail'})));
  const view=projectDecisionView(full);assert(Buffer.byteLength(JSON.stringify(view))<=4096);assert(view.viewCoverage.omitted.warningCodes>0);
  assert(view.criticalUnknowns.warningCodes.includes('DENIAL_UNRESOLVED'));assert(view.criticalUnknowns.actionDelivery.includes('Unchecked'));
});

test('critical candidate cautions survive routine warning ordering and every omitted/truncated warning is counted',()=>{
  const full=report();full.priorities=[];
  full.candidates[0].warnings=['Known routine metadata','PP unknown','Conditional first-turn eligibility is unverified. '+ 'Detail '.repeat(40),'Plausible redirection changes the recipient.'];
  const view=projectDecisionView(full),candidate=view.candidates.find(value=>value.id===full.candidates[0].id);
  assert(candidate.warnings.some(value=>value.includes('Conditional first-turn')));assert(candidate.warnings.some(value=>value.includes('redirection')));
  assert.equal(view.viewCoverage.omitted.candidateWarnings,full.candidates.reduce((sum,value)=>sum+value.warnings.length,0)-view.candidates.reduce((sum,value)=>sum+(value.warnings?.length??0),0));
  assert(view.viewCoverage.omitted.warningTextTruncations>0);assert(Buffer.byteLength(JSON.stringify(view))<=4096);
});

function dependencyReport(){
  const full=report(),candidate=full.candidates[0];
  candidate.actions=[{type:'move',slot:1,target:1,mega:true},{type:'move',slot:1}];
  full.pairDependencies=[{candidateId:candidate.id,actions:structuredClone(candidate.actions),warnings:[{code:'PAIR_ACTOR_EXPOSURE',actorId:'own-a',roles:['sole-progress'],selectedMove:'Leech Life',partnerAction:'protect',
    opposing:[{actorId:'foe-a',damageMoves:['Flare Blitz'],denialMoves:[]}],pairedSupport:[{actorId:'foe-b',move:'Helping Hand',partnerActorId:'foe-a'}],goals:{requiredActionsBy:['own-a']}}]}];
  return full;
}

test('essential dependency projection retains exact pair, named exposure and conditional goals independently of optional advice',()=>{
  const full=dependencyReport(),before=structuredClone(full),card=projectPairDependencies(full);
  assert.equal(card.kind,'pair-dependencies');assert.equal(card.status,'possible-unchecked');assert.equal(card.researchRequired,false);assert.equal(card.materiality,'author-assessment-required');
  assert.equal(card.source.boardHash,full.source.boardHash);assert.equal(card.source.requestDigest,full.source.requestDigest);assert.equal(card.source.room,full.source.room);assert.deepEqual(card.candidates,full.pairDependencies);
  assert.match(card.check,/Ordinary chip, intentional trades and necessary gambles do not require numerical research/);
  assert.match(card.limits,/no opposing choice, targeting, order, damage, survival or usefulness/);
  full.candidates[0].warnings=[];full.priorities=[];delete full.numericChecks;
  assert.deepEqual(projectPairDependencies(full),card,'optional advice and numerical presentation do not erase the essential card');
  assert.deepEqual(before.pairDependencies,full.pairDependencies);
  card.candidates[0].warnings[0].goals.requiredActionsBy.push('mutated');assert.deepEqual(full.pairDependencies,before.pairDependencies);
});

test('dependency projection refuses stale or mismatched candidates and malformed sources instead of rebinding them',()=>{
  for(const change of [
    full=>{full.status='stale-source';},full=>{full.source.boardHash='changed';},full=>{full.source.requestDigest='changed';},
    full=>{full.source.sessionId='x'.repeat(201);},full=>{full.source.teamId='not-a-hash';},full=>{full.source.opposingSheetSha256={unbounded:'x'.repeat(100000)};},
    full=>{full.pairDependencies[0].candidateId='missing';},full=>{full.pairDependencies[0].actions[0].target=2;},
    full=>{full.pairDependencies[0].warnings[0].goals={guessed:true};},
    full=>{full.pairDependencies[0].warnings[0].pairedSupport[0].partnerActorId='missing';},
  ]){const full=dependencyReport();change(full);assert.equal(projectPairDependencies(full),undefined);}
  const full=dependencyReport();full.pairDependencies=[];assert.equal(projectPairDependencies(full),undefined,'absence is not an all-clear card');
});

test('dependency projection bounds known fields and does not copy arbitrary warning metadata',()=>{
  const full=dependencyReport();full.pairDependencies[0].warnings[0].untrusted='x'.repeat(100000);
  const card=projectPairDependencies(full);assert.equal(card.candidates[0].warnings[0].untrusted,undefined);assert(Buffer.byteLength(JSON.stringify(card))<4000);
  const action=full.pairDependencies[0].actions[0];action.untrusted='x'.repeat(100000);full.candidates[0].actions=structuredClone(full.pairDependencies[0].actions);
  assert.equal(projectPairDependencies(full),undefined,'unknown action fields cannot inflate the essential path');
});

test('malformed dependency rows and nested capabilities stay unavailable instead of throwing or supplying clearance',()=>{
  for(const change of [
    full=>{full.pairDependencies=[null];},
    full=>{full.pairDependencies.push(null);},
    full=>{full.pairDependencies[0].warnings=[null];},
    full=>{full.pairDependencies[0].warnings[0].opposing=[null];},
    full=>{full.pairDependencies[0].warnings[0].pairedSupport=[null];},
    full=>{full.pairDependencies[0].actions=[null,null];},
    full=>{full.candidates=[null];},
    full=>{full.candidates={};},
    full=>{delete full.candidates;},
  ]){
    const full=dependencyReport();change(full);const before=structuredClone(full);
    assert.equal(projectPairDependencies(full),undefined);assert.deepEqual(full,before);
  }
  const full=dependencyReport();full.candidates.push(null);
  assert.deepEqual(projectPairDependencies(full).candidates,full.pairDependencies,'an unrelated malformed candidate cannot erase an exact valid match');
  assert.equal(projectPairDependencies({status:'advisory',source:{room:'null-row-reproduction',rqid:2,boardHash:'a'.repeat(64)},pairDependencies:[null]}),undefined);
});

function readinessReport(mutate=()=>{}){
  const full=report(),input=currentFixture();mutate(input);
  full.source.publishedOpposingSheetSha256='e'.repeat(64);
  full.reconstructionReadiness={...projectObservedReadinessCard(inspectObservedPositionReadiness(input)),source:structuredClone(full.source),
    sourceRevalidated:true,sourceScope:'read-and-revalidated-planning-source'};
  return full;
}

test('decision readiness projection retains source/hash/status and the original byte bound without copying private reconstruction',()=>{
  const full=readinessReport(),before=structuredClone(full);full.reconstructionReadiness.reconstruction={private:'not copied'};
  full.reconstructionReadiness.untrusted='x'.repeat(100000);
  const view=projectDecisionView(full),card=view.reconstructionReadiness;
  assert(Buffer.byteLength(JSON.stringify(view))<=4096);assert.equal(card.kind,'observed-readiness-card-v1');assert.equal(card.ready,true);
  assert.equal(card.status,'reconstruction-ready');assert.deepEqual(card.hashes,full.reconstructionReadiness.hashes);
  assert.deepEqual(card.source,view.source,'The card remains source-bound when lifted outside optional brief advice');
  assert.equal(view.source.publishedOpposingSheetSha256,full.source.publishedOpposingSheetSha256);
  assert.equal(card.reconstruction,undefined);assert.equal(card.untrusted,undefined);assert.equal(card.sourceRevalidated,true);
  assert.deepEqual(full.reconstructionReadiness.hashes,before.reconstructionReadiness.hashes);
});

test('decision readiness preserves blocked conditional diagnostics and counts omitted paths within the existing budget',()=>{
  const full=readinessReport(input=>{delete input.hypotheses.mode;delete input.hypotheses.own;input.observed.boards[0].sides[1].pokemon[0].ability='Static';});
  const view=projectDecisionView(full),card=view.reconstructionReadiness;
  assert(Buffer.byteLength(JSON.stringify(view))<=4096);assert.equal(card.ready,false);
  assert.equal(card.currentAbilityApplicability.applicability,'conditional-mode-not-authored');assert.equal(card.currentAbilityApplicability.noModeInferred,true);
  assert(card.fullCardCounts.blockers[0]>0);assert(card.projection.missingAuthoredOmitted>=0);
  assert.equal(view.viewCoverage.omitted.reconstructionReadinessRows,card.projection.missingAuthoredOmitted+card.projection.currentAbilityFactsOmitted);
});

test('stale and mismatched readiness cards cannot endorse this brief or silently rebind canonical sheet/source',()=>{
  const stale=readinessReport();stale.status='stale-source';assert.equal(projectDecisionView(stale).reconstructionReadiness.ready,false);
  assert.equal(projectDecisionView(stale).reconstructionReadiness.status,'stale-source');
  for(const key of ['boardHash','requestDigest','opposingSheetSha256','publishedOpposingSheetSha256']){
    const full=readinessReport();full.reconstructionReadiness.source[key]='f'.repeat(64);
    const card=projectDecisionView(full).reconstructionReadiness;assert.equal(card.ready,false);assert.equal(card.status,'unavailable');
  }
});
