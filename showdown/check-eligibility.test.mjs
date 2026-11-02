import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCheckEligibility} from './check-eligibility.mjs';
import {checkInputSha256} from './check-eligibility.mjs';
import {requestDigest} from '../planning/identity.mjs';
import {openingFixture} from '../simulation/fixtures.mjs';
const copy=structuredClone;
function fixture(){
  const native=openingFixture(),positive=copy(native.branches[0].ourActions),other=[{type:'move',slot:2,target:2},{type:'move',slot:4}];
  const branch=(id,ourActions,gate=copy(native.branches[0].gate))=>({...copy(native.branches[0]),id,ourActions:copy(ourActions),gate});
  const args={request:{kind:'explicit',position:native.position,hypotheses:native.hypotheses,cases:[
    {id:'removal',branches:[branch('pressure',positive)],seeds:copy(native.seeds)},
    {id:'delivery',branches:[branch('material-delivery',other,{kind:'delivery',requiredActionsBy:['arch']})],seeds:[[5,6,7,8]]},
    {id:'mixed',branches:[branch('one',positive),branch('two',other)],seeds:copy(native.seeds)},
  ]}};
  const own=native.position.sides[0],legalActions={active:own.active.map(id=>({canMegaEvo:'Explicit fixture form',moves:own.pokemon.find(p=>p.id===id).moves.map(move=>({move,pp:10,target:move==='Protect'?'self':move==='Helping Hand'?'adjacentAlly':move==='Trick Room'?'all':'normal'}))})),pokemon:own.pokemon.map(p=>({ident:'p1: '+p.species,details:p.species+', L50',condition:'100/100',active:own.active.includes(p.id),pokemonId:p.id}))};
  const calls=[{name:'calculate_speed',args:{gen:0,pokemon:[{species:'Archaludon'}]}},{name:'simulate_turn_batch',args}];
  return {calls,args,legalActions,positive,other};
}

test('public eligibility preserves exact checks and distinguishes removal delivery and mixed pairs without selection',()=>{
  const f=fixture(),before=copy(f),card=projectCheckEligibility(f.calls,{legalActions:f.legalActions,maxBytes:16384});
  assert.equal(card.kind,'simulation-case-eligibility-v1');assert.equal(card.complete,true);assert.equal(card.coverage.calculationsRun,0);assert.equal(card.indexScope,'supplied-checks-array');
  assert.equal(card.checks[0].role,'supporting-numerical-only');const row=card.checks[1],[removal,delivery,mixed]=row.cases;
  assert.equal(row.checkIndex,1);assert.equal(row.inputSha256,checkInputSha256(f.args));assert.equal(row.sourceKind,'explicit');assert.equal(row.requestSource,undefined);
  assert.deepEqual(removal.simulationCheck,{index:1,caseId:'removal'});assert.deepEqual(removal.falseBranchCheck,{index:1,caseId:'removal',inputSha256:row.inputSha256});assert.deepEqual(removal.canonicalPositivePair.actions,f.positive);
  assert.equal(delivery.role,'supporting-delivery-only');assert.equal(delivery.simulationCheck,undefined);assert.equal(delivery.canonicalPositivePair,null);assert.deepEqual(delivery.canonicalPair.actions,f.other);assert.deepEqual(delivery.falseBranchCheck,{index:1,caseId:'delivery',inputSha256:row.inputSha256});
  assert.equal(mixed.role,'ineligible-mixed-pairs');assert.equal(mixed.simulationCheck,undefined);assert.equal(mixed.falseBranchCheck,undefined);assert.equal(mixed.canonicalPositivePair,null);assert.equal(mixed.branchPairs.length,2);
  assert.deepEqual(f,before);assert(Buffer.byteLength(JSON.stringify(card))<=16384);assert.match(card.sourceFreshness,/Not established/);
});

test('catalog eligibility uses exact ticket and case IDs without advertising a checks-array index',()=>{
  const f=fixture(),catalogId='catalog-'+'a'.repeat(24),checkIds=['research-'+'b'.repeat(24)];
  const card=projectCheckEligibility([f.calls[1]],{legalActions:f.legalActions,catalogId,checkIds,maxBytes:16384});
  assert.equal(card.indexScope,'catalog-ticket-ids');assert.equal(card.checks[0].checkIndex,undefined);assert.equal(card.checks[0].checkId,checkIds[0]);
  for(const [index,row] of card.checks[0].cases.entries()){
    assert.deepEqual(row.catalogCaseRef,{catalogId,checkId:checkIds[0],caseId:f.args.request.cases[index].id});assert.equal(row.simulationCheck,undefined);assert.equal(row.falseBranchCheck,undefined);
  }
  assert.deepEqual(card.checks[0].cases.map(c=>c.allowedUses),[{removalPredicate:true,falseMaterialCase:true},{removalPredicate:false,falseMaterialCase:true},{removalPredicate:false,falseMaterialCase:false}]);
  assert.throws(()=>projectCheckEligibility([f.calls[1]],{legalActions:f.legalActions,catalogId}),/actual catalog and ticket IDs/);
});

test('single simulation selectors omit case ID and mixed gate types never advertise a removal predicate',()=>{
  const f=fixture(),entry=f.args.request.cases[0],args={request:{kind:'explicit',position:f.args.request.position,hypotheses:f.args.request.hypotheses,branches:entry.branches,seeds:entry.seeds}};
  const single=projectCheckEligibility([{name:'simulate_turn',args}],{legalActions:f.legalActions});assert.equal(single.complete,true);assert.deepEqual(single.checks[0].cases[0].simulationCheck,{index:0});assert.equal(single.checks[0].cases[0].caseId,undefined);
  const changed=copy(entry.branches[0]);changed.id='delivery';changed.gate={kind:'delivery',requiredActionsBy:['arch']};args.request.branches.push(changed);
  const mixed=projectCheckEligibility([{name:'simulate_turn',args}],{legalActions:f.legalActions});const row=mixed.checks[0].cases[0];assert.equal(row.role,'ineligible-mixed-gates');assert.equal(row.simulationCheck,undefined);assert.equal(row.falseBranchCheck,undefined);assert.equal(row.canonicalPositivePair,null);
});

test('eligibility binds exact source token sheet actions target and Mega without inferring current context',()=>{
  const f=fixture(),source={sessionId:'fixture',teamId:'a'.repeat(64),room:'battle-gen9championsvgc2026regmcbo3-42',rqid:4,token:'b'.repeat(64),opposingSheetSha256:'c'.repeat(64)};
  const args={request:{kind:'observed',source:copy(source),hypotheses:{mode:'opening',label:'Authored unknown investments.',opposing:{},reserves:[]},cases:[copy(f.args.request.cases[0])]}};
  const binding={kind:'bound-observed-turn',...source,boardHash:'d'.repeat(64)};binding.requestDigest=requestDigest(binding);
  const call={name:'simulate_turn_batch',args},normal=projectCheckEligibility([call],{legalActions:f.legalActions,source:binding});assert.equal(normal.complete,true);assert.deepEqual(normal.source,binding);assert.equal(normal.checks[0].sourceSha256,checkInputSha256({kind:'observed',source}));
  for(const mutate of [v=>{v.request.source.token='e'.repeat(64);},v=>{v.request.source.opposingSheetSha256='e'.repeat(64);},v=>{v.request.source.rqid++;},v=>{v.request.cases[0].branches[0].ourActions[0].slot=99;},v=>{v.request.cases[0].branches[0].ourActions.forEach(a=>{a.mega=true;});}]){
    const changed=copy(args);mutate(changed);const card=projectCheckEligibility([{name:call.name,args:changed}],{legalActions:f.legalActions,source:binding});assert.equal(card.complete,false);assert.equal(card.checks[0].status,'unavailable');assert.deepEqual(card.checks[0].cases,[]);
  }
  for(const change of [a=>{a.target=2;},a=>{a.mega=true;}]){const changed=copy(args);change(changed.request.cases[0].branches[0].ourActions[0]);const card=projectCheckEligibility([{name:call.name,args:changed}],{legalActions:f.legalActions,source:binding});assert.equal(card.complete,true);assert.notEqual(card.checks[0].inputSha256,normal.checks[0].inputSha256);assert.notDeepEqual(card.checks[0].cases[0].canonicalPositivePair,normal.checks[0].cases[0].canonicalPositivePair);}
});

test('future native fields and unknown control switch identities remain unavailable rather than silently projected away',()=>{
  const f=fixture(),original=checkInputSha256(f.args);f.args.request.futureNativeField={mustNotDisappear:true};const before=copy(f.calls);
  const future=projectCheckEligibility(f.calls,{legalActions:f.legalActions});assert.equal(future.complete,false);assert.equal(future.checks[1].status,'unavailable');assert.notEqual(future.checks[1].inputSha256,original);assert.deepEqual(f.calls,before);
  delete f.args.request.futureNativeField;f.args.request.cases[0].branches[0].ourActions[0]={type:'switch',pokemonId:'unbound-snapshot-identity'};
  const unknown=projectCheckEligibility(f.calls,{legalActions:f.legalActions});assert.equal(unknown.complete,false);assert.deepEqual(unknown.checks[1].cases,[]);
});

test('over-budget and oversized eligibility expose omissions and never advertise partial selectors',()=>{
  const f=fixture(),full=projectCheckEligibility(f.calls,{legalActions:f.legalActions,maxBytes:16384}),small=projectCheckEligibility(f.calls,{legalActions:f.legalActions,maxBytes:1024});
  assert.equal(full.complete,true);assert.equal(small.status,'over-budget');assert.equal(small.complete,false);assert.deepEqual(small.checks,[]);assert.equal(small.coverage.omittedChecks,2);assert.equal(small.fullProjectionSha256,checkInputSha256(full));assert(Buffer.byteLength(JSON.stringify(small))<=1024);
  const huge=projectCheckEligibility([{name:'calculate_speed',args:{gen:0,label:'x'.repeat(512*1024)}}],{legalActions:f.legalActions});assert.equal(huge.status,'input-too-large');assert.equal(huge.complete,false);assert.deepEqual(huge.checks,[]);
});
