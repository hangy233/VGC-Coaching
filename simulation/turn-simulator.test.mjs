import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateNativeTurn,runTurnSimulation,collectRandomOrderEvents} from './turn-simulator.mjs';

import {openingFixture,currentFixture} from './fixtures.mjs';
export {openingFixture,currentFixture};
test('native opening resolves attack order and rejects aggregate post-retaliation damage as a delivery gate',()=>{
  const result=simulateNativeTurn(openingFixture()),sample=result.samples[0];
  const moves=sample.events.filter(event=>event.type==='move').map(event=>({id:event.actorId,move:event.move}));
  assert.deepEqual(moves.map(entry=>entry.id),['arch','raichu','rilla','fari']);
  assert.equal(sample.final.sides[0].pokemon.find(pokemon=>pokemon.id==='arch').fainted,true);
  assert.equal(sample.gate.targetKOBeforeRetaliation,false);assert.equal(sample.gate.passed,false);
  assert.equal(sample.start.sides[0].pokemon.find(pokemon=>pokemon.id==='fari').item,'');
  assert.equal(sample.start.sides[0].pokemon.find(pokemon=>pokemon.id==='fari').boosts.def,1);
  assert.equal(sample.final.sides[1].pokemon.find(pokemon=>pokemon.id==='raichu').ability,'No Guard');
});

test('bounded worker performs the same native one-turn engine without any control connection',async()=>{
  const result=await runTurnSimulation(openingFixture());assert.equal(result.engine.gen,0);assert.equal(result.samples.length,1);
});


test('current request preserves consumed Seed/boosts and native prior-action Fake Out restriction',()=>{
  const input=currentFixture();const sample=simulateNativeTurn(input).samples[0],fari=sample.start.sides[0].pokemon.find(p=>p.id==='fari');
  assert.equal(fari.item,'');assert.equal(fari.boosts.def,1);assert.equal(sample.openingEvents.length,0);
  input.branches[0].opposingActions[0]={type:'move',slot:3,target:1};assert.throws(()=>simulateNativeTurn(input),/Move unavailable/);
});
test('native Choice lock and Mega legality remain while missing move history is explicit uncertainty',()=>{
  let input=currentFixture(),arch=input.position.sides[0].pokemon[0];arch.lifecycle.choiceLock='Dragon Pulse';arch.lifecycle.lastMove='Dragon Pulse';input.branches[0].ourActions[0]={type:'move',slot:2,target:1};assert.throws(()=>simulateNativeTurn(input),/Move unavailable/);
  input=currentFixture();input.position.sides[1].megaUsed=true;assert.throws(()=>simulateNativeTurn(input),/Mega unavailable/);
  input=currentFixture();input.position.sides[1].pokemon[1].moves[0]='Stomping Tantrum';input.position.sides[1].pokemon[1].pp[0]=1;const sample=simulateNativeTurn(input).samples[0];assert(sample.stateCoverage.assumptions.some(row=>row.path.endsWith('moveLastTurnResult')));assert.equal(sample.gate.passed,false);
  input=currentFixture();delete input.position.sides[0].megaUsed;assert.throws(()=>simulateNativeTurn(input),/Mega-use history/);
});
test('required failed Protect is an attempt and cannot pass delivered-action gate',()=>{
  const input=currentFixture();input.position.sides[0].pokemon[1].hp=1;input.position.sides[0].pokemon[1].lifecycle.protectCounter=729;input.position.sides[1].pokemon[0].hp=1;
  input.branches[0].ourActions[1]={type:'move',slot:4};input.branches[0].opposingActions[0].mega=false;input.branches[0].gate.requiredActionsBy=['fari'];
  const sample=simulateNativeTurn(input).samples[0];assert.ok(sample.events.some(e=>e.type==='-fail'&&e.actorId==='fari'));assert.equal(sample.gate.targetKOBeforeRetaliation,true);assert.equal(sample.gate.passed,false);assert.equal(sample.gate.requiredMoveAttempts[0].observedWithoutDenial,false);
  input.position.sides[0].pokemon[1].lifecycle.protectCounter=0;const normal=simulateNativeTurn(input).samples[0];assert.equal(normal.gate.requiredMoveAttempts[0].observedWithoutDenial,true);
});
test('gate rejects own target and current state with missing lifecycle or unsupported volatile',()=>{
  let input=openingFixture();input.branches[0].gate.targetId='arch';assert.throws(()=>simulateNativeTurn(input),/must be opposing/);
  input=currentFixture();delete input.position.sides[0].pokemon[0].lifecycle;assert.throws(()=>simulateNativeTurn(input),/require exact/);
  input=currentFixture();input.position.sides[0].pokemon[0].volatiles.confusion={remainingTurns:2};assert.throws(()=>simulateNativeTurn(input),/Unrecognized/);
});
test('native switch targeting, Protect and Trick Room are resolved in the authored pair',()=>{
  const input=openingFixture();input.branches[0].ourActions=[{type:'switch',pokemonId:'sylv'},{type:'move',slot:3}];
  const sample=simulateNativeTurn(input).samples[0];assert.ok(sample.events.some(e=>e.type==='switch'&&e.actorId==='sylv'));assert.ok(sample.events.some(e=>e.type==='move'&&e.actorId==='raichu'&&e.targetId==='sylv'));assert.equal(sample.gate.cleanSample,false,'Native critical KO before Room is explicit sample risk');
  input.branches[0].opposingActions[1]={type:'move',slot:4,target:2};assert.ok(simulateNativeTurn(input).samples[0].final.field.pseudoWeather.trickroom);
  input.branches[0].opposingActions[0]={type:'move',slot:4,mega:true};const protectedSample=simulateNativeTurn(input).samples[0];assert.ok(protectedSample.events.some(e=>e.type==='move'&&e.move==='Protect'));assert.equal(protectedSample.gate.passed,false);
});
test('bounded worker timeout and pre-abort refuse without external calls',async()=>{
  const {EventEmitter}=await import('node:events');let terminated=0;const workerFactory=()=>Object.assign(new EventEmitter(),{terminate(){terminated++;}});
  await assert.rejects(runTurnSimulation(openingFixture(),{timeoutMs:1,workerFactory}),/deadline exhausted/);assert.equal(terminated,1);
  const abort=new AbortController();abort.abort();await assert.rejects(runTurnSimulation(openingFixture(),{signal:abort.signal,workerFactory}),/cancelled/);assert.equal(terminated,1);
});

test('native redirection changes attack recipient before any aggregate knockout inference',()=>{
  const input=openingFixture(),reserve={...input.position.sides[1].pokemon[1],id:'rilla-reserve'};input.position.sides[1].pokemon[1]={id:'powder',species:'Volcarona',nature:'Modest',ability:'Flame Body',item:'Grassy Seed',moves:['Rage Powder','Heat Wave','Giga Drain','Protect'],statPoints:{hp:32,def:32,spd:2}};input.position.sides[1].pokemon[2]=reserve;input.position.sides[1].active[1]='powder';input.branches[0].opposingActions[1]={type:'move',slot:1};
  const sample=simulateNativeTurn(input).samples[0];assert.equal(sample.events.find(e=>e.type==='move'&&e.actorId==='arch').targetId,'powder');assert.equal(sample.gate.passed,false);
});
test('Emergency Exit stops native resolution with pending partner actions and supplies no replacement/default',()=>{
  const input=openingFixture();input.position.sides[0].pokemon[0]={id:'gol',species:'Golisopod',nature:'Brave',ability:'Emergency Exit',item:'Golisopite',moves:['Sucker Punch','Iron Head','Leech Life','Protect'],statPoints:{hp:32,atk:32,spd:2}};input.position.sides[0].active[0]='gol';input.branches[0].ourActions=[{type:'move',slot:3,target:2},{type:'move',slot:1,target:1}];input.branches[0].opposingActions=[{type:'move',slot:4,mega:true},{type:'move',slot:1,target:1}];input.branches[0].gate.requiredActionsBy=['gol'];
  const sample=simulateNativeTurn(input).samples[0];assert.equal(sample.boundary,'forced-replacement');assert.equal(sample.noPendingContinuation,false);assert.deepEqual(sample.pendingActions.map(a=>a.pokemonId),['fari','gol']);assert.ok(sample.pendingPhases.includes('move'));assert.ok(!sample.events.some(e=>e.type==='switch'));assert.ok(!sample.events.some(e=>e.type==='move'&&['fari','gol'].includes(e.actorId)));assert.equal(sample.gate.passed,false);
});
test('normal completed actions with KO replacement boundary may establish only the explicit removal gate',()=>{
  const input=currentFixture();input.position.sides[1].pokemon[0].hp=1;input.branches[0].ourActions[1]={type:'move',slot:2,target:-1};
  const result=simulateNativeTurn(input),sample=result.samples[0];assert.equal(sample.boundary,'forced-replacement');assert.equal(sample.turnComplete,false);assert.equal(sample.noPendingContinuation,false);assert.equal(sample.pendingActions.length,0);assert.equal(sample.gate.passed,true);assert.ok(sample.actionOutcomes.find(a=>a.id==='raichu').faintedBeforeAction);assert.match(result.limitations.join(' '),/pending actions, residuals/);
});
test('native full paralysis can permit a later knockout sample but never a clean positive gate',()=>{
  const input=currentFixture();input.seeds=[[123,234,345,456]];input.position.sides[1].pokemon[0].hp=1;input.position.sides[1].pokemon[0].status='par';input.position.sides[0].pokemon[0].boosts.spe=-6;input.position.sides[1].pokemon[1].lifecycle.activeMoveActions=0;input.branches[0].ourActions[0]={type:'move',slot:1,target:2};input.branches[0].opposingActions[1]={type:'move',slot:4,target:2};input.branches[0].gate.requiredActionsBy=['fari'];
  const result=simulateNativeTurn(input),sample=result.samples[0];assert.ok(sample.stochastic.actionDenialEvents.some(e=>e.raw.endsWith('|par')));assert.equal(sample.gate.targetKOBeforeRetaliation,true);assert.equal(sample.gate.cleanSample,false);assert.equal(result.summary.allCleanSampleGatesPassed,false);
});
function removalOrderFixture(item='Quick Claw'){
  const input=currentFixture();
  if(item==='Quick Claw')Object.assign(input.position.sides[0].pokemon[0],{item,nature:'Quiet',statPoints:{spa:32,spd:2}});
  input.position.sides[1].pokemon[0].hp=1;input.seeds=[[3,2,3,4]];
  input.branches[0]={id:'order-dependent-removal',ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:4}],opposingActions:[{type:'move',slot:2,target:1,mega:true},{type:'move',slot:1,target:2}],gate:{targetId:'raichu',beforeActionsOf:['raichu'],requiredActionsBy:['arch']}};
  return input;
}
test('native Quick Claw removal retains the activation and cannot pass a clean positive gate',()=>{
  const input=removalOrderFixture(),result=simulateNativeTurn(input),sample=result.samples[0];
  assert.ok(sample.events.some(e=>e.raw.endsWith('|item: Quick Claw')));
  assert.equal(sample.gate.passed,true,'The sampled removal still happened; its random ordering must remain separate');
  assert.equal(sample.gate.cleanSample,false);assert.equal(result.summary.allCleanSampleGatesPassed,false);
  assert.deepEqual(sample.stochastic.randomOrderEvents,sample.events.filter(e=>e.raw.endsWith('|item: Quick Claw')));
  input.seeds=[[1,2,3,4]];const ordinary=simulateNativeTurn(input).samples[0];
  assert.equal(ordinary.gate.passed,false);assert.deepEqual(ordinary.stochastic.randomOrderEvents,[]);
});
test('native Quick Draw activation is retained as random order without widening current-state support',()=>{
  const input=openingFixture();
  Object.assign(input.position.sides[0].pokemon[0],{species:'Slowbro-Galar',nature:'Quiet',ability:'Quick Draw',item:'Expert Belt',moves:['Psychic','Sludge Bomb','Flamethrower','Protect'],statPoints:{hp:32,spa:32,spd:2}});
  input.seeds=[[3,2,3,4]];input.branches[0].ourActions=[{type:'move',slot:1,target:1},{type:'move',slot:4}];
  input.branches[0].opposingActions=[{type:'move',slot:2,target:1,mega:true},{type:'move',slot:1,target:2}];input.branches[0].gate.requiredActionsBy=['arch'];
  const result=simulateNativeTurn(input),sample=result.samples[0];assert.ok(sample.events.some(e=>e.raw.endsWith('|ability: Quick Draw')));
  assert.equal(sample.gate.cleanSample,false);assert.equal(result.summary.allCleanSampleGatesPassed,false);
  assert.deepEqual(sample.stochastic.randomOrderEvents,sample.events.filter(e=>e.raw.endsWith('|ability: Quick Draw')));
});
test('ordinary Scarf order and Protect retain a clean removal fact without claiming the paused turn finished',()=>{
  const result=simulateNativeTurn(removalOrderFixture('Choice Scarf')),sample=result.samples[0];
  assert.ok(sample.events.some(e=>e.type==='move'&&e.move==='Protect'));
  assert.deepEqual(sample.stochastic.randomOrderEvents,[]);
  assert.equal(sample.gate.passed,true);assert.equal(sample.gate.cleanSample,true);assert.equal(sample.turnComplete,false);assert.equal(result.summary.allCleanSampleGatesPassed,false);
});
test('random order collector preserves native effects while leaving deterministic activations alone',()=>{
  const event=(effect,index)=>({index,type:'-activate',actorId:'actor',targetId:null,raw:`|-activate|p1a: actor|${effect}`});
  const deterministic=[event('item: Custap Berry|[consumed]',0),event('move: Protect',1),event('move: Quick Attack',2)];
  const claw=event('item: Quick Claw',3),draw=event('ability: Quick Draw',4);
  assert.deepEqual(collectRandomOrderEvents(deterministic),[]);
  assert.deepEqual(collectRandomOrderEvents([...deterministic,claw,draw]),[claw,draw]);
});
test('current Trick Room uses native ordering and denies a slower queued attack after an earlier knockout',()=>{
  const input=currentFixture();input.position.field.trickRoom={remainingTurns:3};const sample=simulateNativeTurn(input).samples[0];assert.equal(sample.events.find(e=>e.type==='move').actorId,'fari');assert.ok(sample.final.field.pseudoWeather.trickroom);assert.equal(sample.actionOutcomes.find(a=>a.id==='arch').faintedBeforeAction,true);
});
test('current native Mega ability and applied weather/Seed/Intimidate state mount without duplicate entry effects',()=>{
  const input=currentFixture(),foe=input.position.sides[1];foe.pokemon[0].species='Raichu-Mega-Y';foe.pokemon[0].ability='No Guard';foe.megaUsed=true;foe.active[1]='incin';input.position.field.weather={id:'raindance',remainingTurns:3};input.branches[0].opposingActions=[{type:'move',slot:2,target:1},{type:'move',slot:1,target:1}];
  const sample=simulateNativeTurn(input).samples[0],arch=sample.start.sides[0].pokemon.find(p=>p.id==='arch'),fari=sample.start.sides[0].pokemon.find(p=>p.id==='fari');assert.equal(sample.start.sides[1].pokemon.find(p=>p.id==='raichu').ability,'No Guard');assert.equal(sample.start.field.weatherRemaining,3);assert.equal(arch.boosts.atk,0);assert.equal(fari.boosts.def,1);assert.equal(fari.item,'');assert.equal(sample.openingEvents.length,0);assert.ok(!sample.events.some(e=>e.type==='-mega'));
});
test('observed-high uses native public HP rendering and retains upper compatible candidate as hypothesis',()=>{
  const input=currentFixture(),foe=input.position.sides[1].pokemon[0];foe.hp='observed-high';foe.observedHp={current:11,max:100,precision:'server-display'};
  const sample=simulateNativeTurn(input).samples[0],resolved=sample.hpHypotheses[0];assert.equal(resolved.id,'raichu');assert.ok(resolved.compatibleCount>=1);assert.ok(resolved.minCompatibleHp<=resolved.maxCompatibleHp);assert.equal(resolved.selectedHp,resolved.maxCompatibleHp);assert.equal(sample.start.sides[1].pokemon.find(p=>p.id==='raichu').hp,resolved.selectedHp);assert.match(resolved.limitation,/not globally conservative or safe/);
  foe.hp=resolved.selectedHp;assert.doesNotThrow(()=>simulateNativeTurn(input));foe.hp=resolved.selectedHp+1;assert.throws(()=>simulateNativeTurn(input),/contradicts/);
  for(const change of [x=>{const p=x.position.sides[0].pokemon[0];p.hp='observed-high';p.observedHp={current:11,max:100,precision:'server-display'};},x=>{delete x.position.sides[1].pokemon[0].observedHp;},x=>{x.position.sides[1].pokemon[0].observedHp.precision='server-own-exact';},x=>{x.position.sides[1].pokemon[2].hp='observed-high';}]){const x=currentFixture();x.position.sides[1].pokemon[0].hp='observed-high';x.position.sides[1].pokemon[0].observedHp={current:11,max:100,precision:'server-display'};change(x);assert.throws(()=>simulateNativeTurn(x),/actual observed opposing/);}
});
