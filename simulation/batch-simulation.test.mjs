import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {openingFixture,currentFixture} from './fixtures.mjs';
import {simulateNativeTurn,simulateNativeTurnBatch,runTurnSimulationBatch,simulationBatchCoreSchema} from './turn-simulator.mjs';

function fixture(current=false){
  const f=current?currentFixture():openingFixture(),protect=structuredClone(f.branches[0]);
  protect.id='protect';protect.ourActions=[{type:'switch',slot:3},{type:'move',slot:4}];
  return {position:f.position,hypotheses:f.hypotheses,cases:[{id:'attack',branches:f.branches,seeds:[[1,2,3,4],[3,2,3,4]]},{id:'protect',branches:[protect],seeds:[[1,2,3,4]]}]};
}
// Native wall-clock log markers are telemetry, not seeded mechanics.
const mechanics=value=>JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='string'&&/^\|t:\|\d+$/.test(item)?'|t:|CLOCK':item));
test('batch native samples exactly match independent opening and current cases without state leaking',()=>{
  for(const current of [false,true]){
    const f=fixture(current),before=structuredClone(f),batch=simulateNativeTurnBatch(f);
    assert.deepEqual(f,before);assert.equal(batch.batch.samples,3);assert.equal(batch.batch.normalizedPositions,1);
    for(const entry of f.cases){const standalone=simulateNativeTurn({branches:entry.branches,seeds:entry.seeds,position:f.position,hypotheses:f.hypotheses});assert.deepEqual(mechanics(batch.cases.find(result=>result.id===entry.id).result),mechanics(standalone));}
    assert.deepEqual(batch.cases.map(entry=>entry.id),['attack','protect']);
  }
});
test('one native worker and bounded two-worker execution preserve case order and exact native evidence',async()=>{
  const f=fixture(),expected=simulateNativeTurnBatch(f),serial=await runTurnSimulationBatch(f),parallel=await runTurnSimulationBatch(f,{concurrency:2});
  assert.deepEqual(mechanics(serial.cases),mechanics(expected.cases));assert.deepEqual(mechanics(parallel.cases),mechanics(expected.cases));
  assert.equal(serial.batch.workerConcurrency,1);assert.equal(parallel.batch.workerConcurrency,2);assert.equal(parallel.batch.normalizedPositions,2);
});
test('batch bounds, duplicate identities and unsupported state refuse instead of inventing coverage',async()=>{
  const duplicate=fixture();duplicate.cases[1].id=duplicate.cases[0].id;assert.throws(()=>simulateNativeTurnBatch(duplicate),/case IDs/);
  const big=fixture();big.cases.push({...big.cases[0],id:'three'},{...big.cases[0],id:'four'});assert.equal(simulationBatchCoreSchema.safeParse(big).success,false);
  const unsupported=fixture(true);delete unsupported.position.sides[0].pokemon[0].lifecycle;assert.throws(()=>simulateNativeTurnBatch(unsupported),/exact HP/);
  await assert.rejects(runTurnSimulationBatch(fixture(),{concurrency:3}),/concurrency/);
});
test('batch cancellation and shared deadline terminate every actual worker and publish no partial result',async()=>{
  let created=0,terminated=0;const workerFactory=()=>{created++;return Object.assign(new EventEmitter(),{terminate(){terminated++;}});};
  const abort=new AbortController();abort.abort();await assert.rejects(runTurnSimulationBatch(fixture(),{signal:abort.signal,workerFactory,concurrency:2}),/cancelled/);assert.equal(created,0);
  await assert.rejects(runTurnSimulationBatch(fixture(),{timeoutMs:15,workerFactory,concurrency:2}),/deadline/);assert.equal(created,2);assert.equal(terminated,2);
  const inflight=new AbortController(),running=runTurnSimulationBatch(fixture(),{workerFactory,signal:inflight.signal,concurrency:2});inflight.abort();await assert.rejects(running,/cancelled/);assert.equal(created,4);assert.equal(terminated,4);
});
