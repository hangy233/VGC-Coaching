import test from 'node:test';
import assert from 'node:assert/strict';
import {applyKnownNativeHistory} from './history-state.mjs';
import {currentFixture} from './fixtures.mjs';
const copy=structuredClone;
function fixture(){
  const position=currentFixture().position,binding={sourceSha256:'a'.repeat(64),historySha256:'b'.repeat(64),sequence:34,teamId:'c'.repeat(64),room:'battle-gen9championsvgc2026regmcbo3-1',rqid:7};
  const assembly={binding,facts:{nativeHistory:{kind:'source-bound-native-history-v1',schemaVersion:1,binding:copy(binding),completeHistory:true,sides:{p2:{totalFainted:2}},pokemon:{arch:{timesAttacked:3,lastMoveTargetLoc:2,moveLastTurnResult:false}},battle:{lastMove:'protect'},unknowns:[{path:'p2.unknown',reason:'Called move ambiguity'}]}}};
  return {built:{position,provenance:{}},assembly};
}
test('script-proved native fields enter the exact core without mutating the stored source',()=>{
  const f=fixture(),before=copy(f),out=applyKnownNativeHistory(f.built,f.assembly);
  assert.deepEqual(out.position.sides[0].pokemon.find(p=>p.id==='arch').nativeState,{timesAttacked:3,lastMoveTargetLoc:2,moveLastTurnResult:false});
  assert.equal(out.position.sides[1].nativeState.totalFainted,2);assert.equal(out.position.nativeState.lastMove,'protect');assert.equal(out.provenance.nativeHistory.known.length,5);assert.deepEqual(f,before);
});
test('proved fields replace disclosed fallback defaults while unrelated uncertainty remains',()=>{
  const f=fixture();f.built.provenance.approximate=true;const p=f.built.position.sides[0].pokemon.find(p=>p.id==='arch');p.nativeState={timesAttacked:0};
  f.built.position.stateAssumptions=[{path:'p1.arch.nativeState.timesAttacked',reason:'Unknown default',selected:0},{path:'p1.arch.pp',reason:'Uncertain PP'}];
  const out=applyKnownNativeHistory(f.built,f.assembly);assert.equal(out.position.sides[0].pokemon[0].nativeState.timesAttacked,3);assert.deepEqual(out.position.stateAssumptions,[{path:'p1.arch.pp',reason:'Uncertain PP'}]);
});
test('foreign source receipts, invalid counts and conflicts with an exact supplied state cannot borrow script proof',()=>{
  for(const mutate of [f=>f.assembly.facts.nativeHistory.binding.rqid++,f=>f.assembly.facts.nativeHistory.sides.p2.totalFainted=-1,f=>f.built.position.sides[0].pokemon[0].nativeState={timesAttacked:1}]){
    const f=fixture();mutate(f);assert.throws(()=>applyKnownNativeHistory(f.built,f.assembly),/Native history/u);
  }
});
test('old saved positions without a tracker receipt remain explicitly unenhanced',()=>{const f=fixture();delete f.assembly.facts.nativeHistory;assert.equal(applyKnownNativeHistory(f.built,f.assembly),f.built);});

test('an approximate world cannot replace a contradictory exact field using unrelated assumptions',()=>{
  const f=fixture();f.built.provenance.approximate=true;
  f.built.position.sides[0].pokemon[0].nativeState={timesAttacked:1};
  f.built.position.stateAssumptions=[{path:'p1.arch.pp',reason:'Uncertain PP'}];
  assert.throws(()=>applyKnownNativeHistory(f.built,f.assembly),/conflicts with proved history/u);
});
