import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {registeredSpeciesKey} from './registered-identity.mjs';
import {buildObservedPosition} from './observed-position.mjs';
import {buildApproximateObservedPosition} from './approximate-position.mjs';
import {currentFixture} from './observed-position.fixtures.mjs';
const {Dex}=createRequire(import.meta.url)('pokemon-showdown'),dex=Dex.mod('champions');

test('Mega identity follows the native registered predecessor while ordinary formes stay distinct',()=>{
  assert.equal(registeredSpeciesKey('Floette-Mega',dex),'floetteeternal');
  assert.equal(registeredSpeciesKey('Floette-Eternal',dex),'floetteeternal');
  assert.notEqual(registeredSpeciesKey('Floette',dex),registeredSpeciesKey('Floette-Eternal',dex));
  assert.equal(registeredSpeciesKey('Ampharos-Mega',dex),registeredSpeciesKey('Ampharos',dex));
  assert.equal(registeredSpeciesKey('Raichu-Mega-Y',dex),registeredSpeciesKey('Raichu',dex));
  assert.notEqual(registeredSpeciesKey('Rotom-Wash',dex),registeredSpeciesKey('Rotom-Heat',dex));
  assert.notEqual(registeredSpeciesKey('Giratina-Origin',dex),registeredSpeciesKey('Giratina',dex));
  assert.throws(()=>registeredSpeciesKey('not-a-native-species',dex),/Unknown registered species/u);
});

function floetteFixture(){
  const f=currentFixture(),index=f.opposingSheet.findIndex(p=>p.species==='Raichu');
  f.opposingSheet[index]={species:'Floette-Eternal',nature:'Modest',ability:'Flower Veil',item:'Floettite',moves:['Moonblast','Calm Mind','Protect','Energy Ball']};
  f.observed.opponentSheets.p2=structuredClone(f.opposingSheet);
  const actor=f.observed.boards[0].sides[1].pokemon[0];actor.species='Floette-Mega';actor.ability='Fairy Aura';actor.mega=true;
  Object.assign(f.hypotheses.opposing.foe0,{ability:'Fairy Aura',item:'Floettite'});f.hypotheses.sideMegaUsed.p2=true;
  return f;
}
for(const [name,build]of [['strict',buildObservedPosition],['approximate',buildApproximateObservedPosition]]){
  test(`${name} current builder matches Mega Floette to its unchanged Eternal registration`,()=>{
    const f=floetteFixture(),before=structuredClone(f),out=build(f),actor=out.position.sides[1].pokemon.find(p=>p.id==='foe0');
    assert.deepEqual(f,before);
    assert.equal(actor.species,'Floette-Mega');assert.equal(actor.ability,'Fairy Aura');assert.equal(actor.item,'Floettite');
    assert.deepEqual(actor.moves,['Moonblast','Calm Mind','Protect','Energy Ball']);
    assert.equal(out.position.sides[1].megaUsed,true);
  });
  test(`${name} current builder rejects absent, duplicate or a different registered Floette forme`,()=>{
    for(const variant of ['missing','duplicate','regular']){
      const f=floetteFixture(),index=f.opposingSheet.findIndex(p=>p.species==='Floette-Eternal');
      if(variant==='missing')f.opposingSheet[index]={...f.opposingSheet[index],species:'Florges'};
      if(variant==='regular')f.opposingSheet[index]={...f.opposingSheet[index],species:'Floette'};
      if(variant==='duplicate')f.opposingSheet[2]=structuredClone(f.opposingSheet[index]);
      f.observed.opponentSheets.p2=structuredClone(f.opposingSheet);
      assert.throws(()=>build(f),/registered (?:set|identity) is missing or ambiguous/u,variant);
    }
  });
}
