import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTurnFacts} from './board.mjs';
import {buildOrderEvidence} from './order-evidence.mjs';
import {planningFixture} from './fixtures.mjs';

const observed = (lines,change) => {
  const input = planningFixture();input.board.recentEvents = {lines,omitted:0,truncated:false,scope:'latest-two-observed-turns'};
  change?.(input);return {input,ctx:buildTurnFacts(input)};
};
const ordinary = ['|start','|turn|1','|move|p1a: Incineroar|Flare Blitz|p2a: Garchomp','|move|p2a: Garchomp|Dragon Claw|p1a: Incineroar'];

test('native same-priority observations require baseline evidence and retain possible Speed ties',() => {
  const {input,ctx} = observed(ordinary), evidence = ctx.orderEvidence, order = ctx.observedOrderConstraints[0];
  assert.equal(order.samePriority,true);assert.equal(order.forcedOrder,false);assert.equal(order.informative,true);
  assert.equal(order.identityVerified,true);assert.equal(order.bothExecuted,true);assert.equal(order.tiesPossible,true);
  assert.equal(order.direction,'at-least-as-fast');assert.equal(order.currentReuse,true);assert.equal(order.numericalInference,'unverified');
  assert.deepEqual(evidence.sourceLines,ordinary);assert.deepEqual(evidence.sourceLines,input.board.recentEvents.lines);
  evidence.sourceLines[0] = 'changed';assert.equal(input.board.recentEvents.lines[0],'|start');
  const noBaseline = observed(ordinary.slice(1)).ctx.observedOrderConstraints[0];
  assert.equal(noBaseline.informative,false);assert.equal(noBaseline.currentReuse,false);assert.equal(noBaseline.originalConditions.baseline,'unknown');
});

test('different priorities, unknown or forcing items, and priority-changing abilities are not Speed evidence',() => {
  const different = observed(ordinary.map(line => line.includes('Flare Blitz') ? line.replace('Flare Blitz','Fake Out') : line)).ctx.observedOrderConstraints[0];
  assert.equal(different.samePriority,false);assert.equal(different.informative,false);
  for (const change of [
    input => {delete input.opponentSheet[0].item;},
    input => {input.opponentSheet[0].item = 'Quick Claw';},
    input => {input.board.sides[0].pokemon[0].ability = 'Stall';},
  ]) assert.equal(observed(ordinary,change).ctx.observedOrderConstraints[0].informative,false);
});

test('nickname identity is unique across side and never guessed from an occupied slot',() => {
  const wrongName = observed(ordinary.map(line => line.replace('p2a: Garchomp','p2a: Unknown'))).ctx.observedOrderConstraints[0];
  assert.equal(wrongName.identityVerified,false);assert.equal(wrongName.second,null);
  const duplicate = observed(ordinary,input => {
    input.board.sides[1].pokemon.push({...structuredClone(input.board.sides[1].pokemon[0]),id:'duplicate',activeSlot:null});
  }).ctx.observedOrderConstraints[0];
  assert.equal(duplicate.identityVerified,false);assert.equal(duplicate.informative,false);
});

test('interrupted and called actions remain observations but cannot establish both move executions',() => {
  const interrupted = [...ordinary.slice(0,3),'|cant|p2a: Garchomp|flinch|Dragon Claw','|faint|p2a: Garchomp'];
  const result = observed(interrupted).ctx.orderEvidence, order = result.observations[0];
  assert.equal(order.bothExecuted,false);assert.equal(order.informative,false);assert.deepEqual(result.sourceLines,interrupted);
  assert(order.events.some(line => line.startsWith('|cant|')));
  const called = observed([...ordinary.slice(0,3),'|move|p2a: Garchomp|Dragon Claw|p1a: Incineroar|[from] move: Instruct']).ctx.observedOrderConstraints[0];
  assert.equal(called.bothExecuted,false);assert.equal(called.currentReuse,false);
});

const priorityBlockActors=[
  {id:'own-farigiraf',side:'p1',slot:2,ability:'Armor Tail',item:null,itemKnown:true,raw:{nickname:'Farigiraf',identityConfidence:'confirmed'}},
  {id:'foe-luxray',side:'p2',slot:1,ability:'Intimidate',item:'Expert Belt',itemKnown:true,raw:{nickname:'Luxray',identityConfidence:'confirmed'}},
  {id:'own-golisopod',side:'p1',slot:1,ability:'Emergency Exit',item:'Golisopite',itemKnown:true,raw:{nickname:'Golisopod',identityConfidence:'confirmed'}},
];
const priorityOrder=lines=>buildOrderEvidence({board:{recentEvents:{lines,omitted:0,truncated:false},field:{conditions:{}}},actors:priorityBlockActors});

test('holder-first priority-block cant attributes the attempted move to its denied user, never the holder',()=>{
  for(const ability of ['Armor Tail','Dazzling','Queenly Majesty']){
    const cant=`|cant|p1b: Farigiraf|ability: ${ability}|Baby-Doll Eyes|[of] p2a: Luxray`;
    const lines=['|start','|turn|1','|move|p2a: Luxray|Baby-Doll Eyes||[still]',cant,
      '|move|p1b: Farigiraf|Psychic|p2a: Luxray','|move|p1a: Golisopod|Leech Life|p2a: Luxray'];
    const before=structuredClone(lines),result=priorityOrder(lines),denials=result.observations.filter(row=>row.events.includes(cant));
    assert(denials.length);
    for(const row of denials){
      const member=row.events.indexOf(cant);
      assert.equal(row.attemptedActors[member],'p2a: Luxray');assert.equal(row.moves[member],'Baby-Doll Eyes');
      assert.equal(member===0?row.first:row.second,'foe-luxray');
      assert.equal(row.bothExecuted,false);assert.equal(row.informative,false);assert.equal(row.currentReuse,false);
    }
    assert(!result.observations.some(row=>row.attemptedActors.some((actor,index)=>actor==='p1b: Farigiraf'&&row.moves[index]==='Baby-Doll Eyes')));
    assert(result.observations.some(row=>row.attemptedActors.some((actor,index)=>actor==='p1b: Farigiraf'&&row.moves[index]==='Psychic')));
    assert.deepEqual(result.sourceLines,before);assert.deepEqual(lines,before);
  }
  const cant='|cant|p2b: Opposing Holder|ability: Armor Tail|Sucker Punch|[of] p1a: Golisopod';
  const reverse=priorityOrder(['|start','|turn|1','|move|p1a: Golisopod|Sucker Punch||[still]',cant,'|move|p1b: Farigiraf|Psychic|p2a: Luxray']);
  for(const row of reverse.observations.filter(row=>row.events.includes(cant))){
    const member=row.events.indexOf(cant);assert.equal(row.attemptedActors[member],'p1a: Golisopod');assert.equal(member===0?row.first:row.second,'own-golisopod');
    assert.equal(row.bothExecuted,false);assert.equal(row.informative,false);
  }
});

test('a still move announcement is not ordinary execution evidence even without a following denial',()=>{
  const lines=['|start','|turn|1','|move|p2a: Luxray|Tackle|p1a: Golisopod|[still]','|move|p1a: Golisopod|Tackle|p2a: Luxray'];
  const order=priorityOrder(lines).observations[0];
  assert.equal(order.samePriority,true);assert.equal(order.bothExecuted,false);assert.equal(order.informative,false);assert.equal(order.currentReuse,false);
});

test('unknown and malformed ability cant preserve raw evidence without guessing an attempted actor',()=>{
  for(const cant of [
    '|cant|p1b: Farigiraf|ability: Unknown Ability|Baby-Doll Eyes|[of] p2a: Luxray',
    '|cant|p1b: Farigiraf|ability: Unknown Ability|Baby-Doll Eyes',
    '|cant|p1b: Farigiraf|ability: Armor Tail|Baby-Doll Eyes',
    '|cant|p1b: Farigiraf|ability: Armor Tail|Baby-Doll Eyes|[of] invalid',
    '|cant|p1b: Farigiraf|ability: Armor Tail|Baby-Doll Eyes|[of] p2a: Luxray|[of] p2b: Other',
    '|cant|p1b: Farigiraf|ability: Armor Tail|Baby-Doll Eyes|[of] p1a: Golisopod',
  ]){
    const lines=['|start','|turn|1',cant,'|move|p1a: Golisopod|Leech Life|p2a: Luxray'],result=priorityOrder(lines),order=result.observations[0];
    assert.equal(order.attemptedActors[0],null,cant);assert.equal(order.first,null,cant);assert.equal(order.identityVerified,false,cant);
    assert.equal(order.informative,false,cant);assert.equal(order.currentReuse,false,cant);assert.deepEqual(result.sourceLines,lines);
  }
  const cant='|cant|p2a: Luxray|flinch|Tackle|[of] p1b: Farigiraf';
  const ordinaryFailure=priorityOrder(['|start','|turn|1',cant,'|move|p1a: Golisopod|Tackle|p2a: Luxray']).observations[0];
  assert.equal(ordinaryFailure.attemptedActors[0],'p2a: Luxray');assert.equal(ordinaryFailure.first,'foe-luxray');assert.equal(ordinaryFailure.moves[0],'Tackle');
});

test('original Trick Room order reverses the relation and expiry prevents current reuse',() => {
  const lines = ['|start','|-fieldstart|move: Trick Room',...ordinary.slice(1)];
  let order = observed(lines,input => {input.board.field.conditions.trickroom = {name:'Trick Room'};}).ctx.observedOrderConstraints[0];
  assert.equal(order.informative,true);assert.equal(order.direction,'at-most-as-fast');assert.equal(order.currentReuse,true);
  order = observed([...lines,'|-fieldend|move: Trick Room']).ctx.observedOrderConstraints[0];
  assert.equal(order.informative,true);assert.equal(order.currentReuse,false);assert.equal(order.originalConditions.trickRoom,'active');
  const unknown = observed(ordinary.slice(1)).ctx.observedOrderConstraints[0];assert.equal(unknown.direction,'unknown');
});

test('weather, terrain, Mega, boosts, status, item and ability changes retain original observations without current reuse',() => {
  for (const line of ['|-weather|RainDance','|-fieldstart|move: Grassy Terrain','|-mega|p1a: Incineroar|Incineroar|Stone',
    '|-boost|p1a: Incineroar|spe|1','|-status|p1a: Incineroar|par','|-enditem|p1a: Incineroar|Sitrus Berry','|-ability|p1a: Incineroar|Quick Draw']) {
    const result = observed([...ordinary,line]).ctx.orderEvidence;
    assert.equal(result.observations.length,1);assert.equal(result.observations[0].currentReuse,false);
    assert.deepEqual(result.sourceLines,[...ordinary,line]);assert.deepEqual(result.observations[0].events,ordinary.slice(2));
  }
  const between = observed([...ordinary.slice(0,3),'|-unboost|p2a: Garchomp|spe|1',ordinary[3]]).ctx.observedOrderConstraints[0];
  assert.equal(between.informative,false);assert.equal(between.forcedOrder,null);
});

test('a uniquely named actor that later switches to reserve keeps identity and original constraint',() => {
  const lines = [...ordinary,'|turn|2','|switch|p1a: Rillaboom|Rillaboom, L50|100/100'];
  const {ctx} = observed(lines,input => {
    input.board.sides[0].pokemon[0].activeSlot = null;input.board.sides[0].pokemon[2].activeSlot = 'a';
    input.board.sides[0].active[0].pokemon = 'p1-boom';
  });
  const order = ctx.observedOrderConstraints[0];
  assert.equal(order.first,'p1-cat');assert.equal(order.informative,true);assert.equal(order.currentReuse,false);
  assert(order.currentReuseReasons.some(reason => reason.includes('reserve')));
});

test('omissions and source scope are preserved and forbid reconstructing a clean baseline',() => {
  const {input,ctx} = observed(ordinary);input.board.recentEvents.omitted = 12;input.board.recentEvents.truncated = true;
  const result = buildOrderEvidence({board:input.board,actors:ctx.actors});
  assert.equal(result.omitted,12);assert.equal(result.truncated,true);assert.equal(result.scope,'latest-two-observed-turns');
  assert.equal(result.observations[0].informative,false);assert.deepEqual(result.sourceLines,ordinary);
});

test('dense event inputs keep bounded recent comparisons and shared provenance without quadratic output',()=>{
  const lines=['|start','|turn|1',...Array.from({length:76},(_,i)=>i%2?ordinary[3]:ordinary[2])];
  const result=observed(lines).ctx.orderEvidence;
  assert.equal(result.observations.length,24);assert(result.omittedObservations>0);
  assert.deepEqual(result.sourceLines,lines);
  assert(result.observations.every(row=>row.originalConditions.events===undefined&&row.originalConditions.source==='orderEvidence.sourceLines'));
  assert(Buffer.byteLength(JSON.stringify(result))<80000);
});
