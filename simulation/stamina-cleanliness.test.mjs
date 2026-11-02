import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPotentialSecondaryEvents} from './turn-simulator.mjs';

const event=(type,actorId,index,tail)=>({type,actorId,index,targetId:null,raw:`|${type}|p1a: ${actorId}|${tail}`});
const activation=()=>event('-ability','arch',10,'Stamina|boost'),boost=()=>event('-boost','arch',11,'def|1');

test('exact adjacent native Stamina activation excludes only its same-actor one-stage defense boost',()=>{
  const start=activation(),effect=boost(),secondary=event('-unboost','foe',12,'spd|1');
  assert.deepEqual(collectPotentialSecondaryEvents([start,effect]),[]);
  assert.deepEqual(collectPotentialSecondaryEvents([start,effect,secondary]),[secondary]);
  const tagged=event('-boost','arch',11,'def|1|[from] ability: Stamina');assert.deepEqual(collectPotentialSecondaryEvents([tagged]),[]);
});

test('missing, stale, different-actor, changed-stat or malformed Stamina provenance stays conservatively dirty',()=>{
  for(const change of [value=>{value[0].actorId='other';},value=>{value[0].raw='|-ability|p1b: other|Stamina|boost';},value=>{value[0].index=9;},value=>{value[0].type='-activate';},value=>{value[0].raw='|-ability|p1a: arch|Stamina';},value=>{value[0].raw='|-ability|p1a: arch|Stamina|unboost';},value=>{value[0].raw='|-ability|p1a: arch|Stamina|boost|[silent]';},value=>{value[1].actorId=null;},value=>{value[1].raw='|-boost|p1a: arch|atk|1';},value=>{value[1].raw='|-boost|p1a: arch|def|2';},value=>{value[1].raw='|-boost|p1a: arch|def|1|[from] move: Ancient Power';},value=>{delete value[1].index;}]){
    const values=[activation(),boost()];change(values);assert.deepEqual(collectPotentialSecondaryEvents(values),[values[1]],JSON.stringify(values));
  }
  const interrupted=[activation(),event('move','foe',11,'Flash Cannon|p1a: arch'),{...boost(),index:12}];assert.deepEqual(collectPotentialSecondaryEvents(interrupted),[interrupted[2]]);
  assert.deepEqual(collectPotentialSecondaryEvents([boost()]),[boost()]);
});

test('other abilities, ordinary boosts, unboosts, status and random secondary markers remain dirty',()=>{
  const chance=event('-ability','arch',10,'Moody|boost'),raise=boost(),unboost=event('-unboost','arch',12,'def|1|[from] ability: Stamina'),status=event('-status','foe',13,'par'),cure=event('-curestatus','arch',14,'par'),flinch=event('-start','foe',15,'flinch');
  assert.deepEqual(collectPotentialSecondaryEvents([chance,raise,unboost,status,cure,flinch]),[raise,unboost,status,cure,flinch]);
  const extra=event('-boost','arch',12,'def|1');assert.deepEqual(collectPotentialSecondaryEvents([activation(),boost(),extra]),[extra]);
});
