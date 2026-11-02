// Synthetic native legality diagnostics only; no model, IPC or live authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {choiceFixtureTeams} from './choice-fixture.mjs';
import {simulateNativeTurn} from './turn-simulator.mjs';
const {Battle,Dex}=createRequire(import.meta.url)('pokemon-showdown');
const FORMAT='gen9championsvgc2026regmc',seed=[1,2,3,4],dex=Dex.forFormat(FORMAT);
const move=(slot,target)=>({type:'move',slot,...(target===undefined?{}:{target})});
function fixture(){const teams=choiceFixtureTeams(),sides=['p1','p2'].map(id=>({id,active:teams[id].slice(0,2).map(p=>p.name),pokemon:teams[id].slice(0,4).map(p=>({id:p.name,species:p.species,ability:p.ability,item:p.item,moves:p.moves,nature:p.nature,statPoints:p.evs}))}));return{teams,input:{position:{mode:'opening',turn:1,ownSide:'p1',sides},branches:[{id:'native-menu-diagnostic',ourActions:[move(4),move(4)],opposingActions:[move(4),move(4)],gate:{kind:'delivery',requiredActionsBy:['fari']}}],seeds:[seed],hypotheses:['Synthetic actual-native-menu legality fixture, not a historical position or material qualification.']}};}
const rejected=(input,prefix,parts)=>{const before=structuredClone(input);assert.throws(()=>simulateNativeTurn(input),error=>{assert(error.message.startsWith(prefix));for(const part of parts)assert(error.message.includes(part),part+': '+error.message);assert(error.message.length<650);return true;});assert.deepEqual(input,before,'diagnostics do not rewrite or repair the authored actions');};

test('a target supplied to native Protect reports canonical species, actual menu slot and self target without leaking IDs',()=>{
  const {input}=fixture();input.position.sides[0].pokemon[0].id='PRIVATE_ACTOR_NICKNAME';input.position.sides[0].active[0]='PRIVATE_ACTOR_NICKNAME';input.branches[0].ourActions[0]=move(4,1);
  assert.equal(dex.moves.get('Protect').target,'self');rejected(input,'Move does not accept a chosen target',['p1a Politoed move[4]=Protect menuTarget=self providedTarget=1','p1b Farigiraf move[4]=Protect']);
  assert.throws(()=>simulateNativeTurn(input),error=>{assert(!error.message.includes('PRIVATE_ACTOR_NICKNAME'));assert(!error.message.includes('sim-p1-0'));return true;});
});

test('native automatic Trick Room target rejection identifies the opposing actor rather than its legal partner move',()=>{
  const {input}=fixture();input.branches[0].opposingActions=[move(1,1),move(3,1)];assert.equal(dex.moves.get('Trick Room').target,'all');
  rejected(input,'Move does not accept a chosen target',['p2a Raichu move[1]=Zap Cannon menuTarget=normal providedTarget=1','p2b Farigiraf move[3]=Trick Room menuTarget=all providedTarget=1']);
});

test('legal normal targeting remains an exact native choice with no substituted action',()=>{
  const {input,teams}=fixture();input.branches[0].ourActions=[move(3,1),move(4)];const sample=simulateNativeTurn(input).samples[0];assert.deepEqual(sample.accepted.p1.actions,input.branches[0].ourActions);assert.equal(sample.accepted.p1.canonical,'move 3 1, move 4');assert(sample.events.some(e=>e.actorId==='toed'&&e.type==='move'&&e.move==='Ice Beam'));
  const b=new Battle({formatid:FORMAT,seed,p1:{name:'Native p1',team:structuredClone(teams.p1.slice(0,4))},p2:{name:'Native p2',team:structuredClone(teams.p2.slice(0,4))}});try{assert.equal(b.choose('p1','team 1234'),true);assert.equal(b.choose('p2','team 1234'),true);assert.equal(b.p1.activeRequest.active[0].moves[2].target,'normal');assert.equal(b.choose('p1',sample.accepted.p1.canonical),true);assert.equal(b.choose('p2','move 4, move 4'),true);for(const side of sample.final.sides)for(const p of side.pokemon){const native=b[side.id].pokemon.find(n=>n.name===p.id);assert.equal(p.hp,native.hp);assert.deepEqual(p.pp,native.moveSlots.map(m=>m.pp));}}finally{b.destroy();}
});

test('missing required target and invalid active-slot switching stay refused with the original error prefixes',()=>{
  const missing=fixture().input;missing.branches[0].ourActions[0]=move(3);rejected(missing,'Explicit target required',['p1a Politoed move[3]=Ice Beam menuTarget=normal providedTarget=unset']);
  const invalid=fixture().input;invalid.branches[0].ourActions[0]={type:'switch',slot:1};rejected(invalid,'Invalid switch',['p1a Politoed switch[1]','p1b Farigiraf move[4]=Protect']);
});
