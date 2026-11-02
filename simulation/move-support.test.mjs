import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {currentMoveSupport,nativeHistoryRequirements,nativeHistoryRequirementDetails} from './move-support.mjs';
const {Dex}=createRequire(import.meta.url)('pokemon-showdown');
const dex=Dex.forFormat('gen9championsvgc2026regmc');

test('every existing pinned native move is admitted regardless of callback or effect',()=>{
  for(const move of dex.moves.all())if(move.exists)assert.equal(currentMoveSupport(move).supported,true,move.id);
  for(const id of ['lastrespects','ragefist','batonpass','shedtail','outrage','petaldance','thrash','solarbeam','hyperbeam','futuresight','bide','metronome','copycat','mimic','sketch','instruct','teeterdance','hurricane','uturn'])assert.equal(currentMoveSupport(dex.moves.get(id)).supported,true,id);
});

test('unknown native IDs are refused without treating a supplied exists flag as proof',()=>{
  for(const move of [null,{},dex.moves.get('not-a-native-move'),{id:'not-a-native-move',exists:true},{id:'tackle',exists:false}])assert.equal(currentMoveSupport(move).supported,false);
});

test('actual native callbacks diagnose stable scalar history fields without executing them',()=>{
  for(const [id,field]of [['lastrespects','side.totalFainted'],['ragefist','pokemon.timesAttacked'],['stompingtantrum','pokemon.moveLastTurnResult'],['instruct','pokemon.lastMoveTargetLoc'],['copycat','battle.lastMove']]){
    const move=dex.moves.get(id),before=Function.prototype.toString.call(move.basePowerCallback??move.onHit),fields=nativeHistoryRequirements(move),details=nativeHistoryRequirementDetails(move);
    assert(fields.includes(field),id);assert(fields.includes('native.callback-history'),id);
    assert(details.some(row=>row.kind==='native-callback'&&row.fields.includes(field)&&/^[a-f0-9]{64}$/u.test(row.sourceSha256)),id);
    assert.equal(Function.prototype.toString.call(move.basePowerCallback??move.onHit),before);assert.equal(currentMoveSupport(move).supported,true);
  }
});

test('callback paths recurse through native conditions and arbitrary unclassified callbacks never block',()=>{
  const move={...dex.moves.get('tackle'),condition:{onStart(){throw Error('Must not execute diagnostics');},nested:{onEnd(){return this.lastMove;}}},onHit(){throw Error('Must not execute diagnostics');}};
  assert.equal(currentMoveSupport(move).supported,true);
  const details=nativeHistoryRequirementDetails(move);
  assert.deepEqual(details.filter(row=>row.kind==='native-callback').map(row=>row.path),['condition.nested.onEnd','condition.onStart','onHit']);
  assert(details.find(row=>row.path==='condition.nested.onEnd').fields.includes('battle.lastMove'));
  assert(nativeHistoryRequirements(move).includes('native.callback-history'));
});

test('charge, lock, pivot and confusion references report uncertainty instead of admission failures',()=>{
  for(const id of ['solarbeam','outrage','batonpass','hurricane','uturn']){
    const move=dex.moves.get(id);assert.equal(currentMoveSupport(move).supported,true,id);
    assert(nativeHistoryRequirements(move).includes('native.callback-history'),id);
    assert(nativeHistoryRequirementDetails(move).length>0,id);
  }
  assert.deepEqual(nativeHistoryRequirements(dex.moves.get('tackle')),[]);
  assert.deepEqual(nativeHistoryRequirements(dex.moves.get('not-a-native-move')),[]);
});
