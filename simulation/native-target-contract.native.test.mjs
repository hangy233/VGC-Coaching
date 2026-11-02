// Independent pinned-engine target contracts. The Snarl/Draco pairing reconstructs
// the predicate in retained ledger 5721136f-dd7a-464d-9cbb-ffdd54592b4b
// (0ab6d02414564255a8be5ffe4a4f6d3f17908376f5d68f219afea7070084e714).
// These are synthetic legal native fixtures, not exact historical normalized
// worlds, model qualification, live research or numerical tactical guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {simulateNativeTurn} from './turn-simulator.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';

const require=createRequire(import.meta.url),{Battle,Dex,TeamValidator}=require('pokemon-showdown');
const {extractChannelMessages}=require('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',seed=[123,234,345,456],dex=Dex.forFormat(FORMAT),copy=structuredClone;
const move=(slot,target)=>({type:'move',slot,...(target===undefined?{}:{target})});
const mon=(id,species,ability,item,moves,points={hp:32,def:2,spd:32},nature='Calm')=>({id,species,ability,item,moves,nature,statPoints:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...points}});
const nativeSet=p=>({name:p.id,species:p.species,ability:p.ability,item:p.item,moves:p.moves,nature:p.nature,evs:p.statPoints,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},level:50});
const benches=prefix=>[mon(prefix+'bench','Rillaboom','Grassy Surge','Miracle Seed',['Wood Hammer','Grassy Glide','High Horsepower','Protect']),mon(prefix+'last','Archaludon','Stamina','Choice Scarf',['Dragon Pulse','Flash Cannon','Aura Sphere','Electro Shot'])];
function sourceFor(actor,{pair=false}={}){
  return {
    p1:pair?[mon('incin','Incineroar','Intimidate','Sitrus Berry',['Fake Out','Flare Blitz','Parting Shot','Snarl']),mon('chomp','Garchomp','Rough Skin','Garchompite Z',['Draco Meteor','Earth Power','Protect','Power Gem'],{hp:32,spa:32,spd:2},'Modest'),...benches('p1')]
      :[actor,mon('ally','Raichu','Lightning Rod','Focus Sash',['Helping Hand','Thunderbolt','Fake Out','Protect']),...benches('p1')],
    p2:[mon('toed','Politoed','Drizzle','Leftovers',['Rain Dance','Helping Hand','Weather Ball','Protect']),mon('fari','Farigiraf','Armor Tail','Mental Herb',['Helping Hand','Psychic','Trick Room','Protect']),mon('garde','Gardevoir','Synchronize','Gardevoirite',['Psychic','Helping Hand','Life Dew','Protect']),mon('arc','Arcanine','Intimidate','Charcoal',['Snarl','Flare Blitz','Will-O-Wisp','Protect'])],
  };
}
function choose(battle,p1,p2){assert.equal(battle.choose('p1',p1),true,battle.p1.choice.error);assert.equal(battle.choose('p2',p2),true,battle.p2.choice.error);}
function reference(actor,options={}){
  const source=sourceFor(actor,options);
  if(options.partner)source.p1[1]=options.partner;
  for(const party of Object.values(source))for(const p of party)assert.equal(new TeamValidator(FORMAT).validateSet(nativeSet(p)),null,`${p.species}: actual pinned native registration`);
  const battle=new Battle({formatid:FORMAT,seed,p1:{name:'Independent p1',team:source.p1.map(nativeSet)},p2:{name:'Independent p2',team:source.p2.map(nativeSet)}});
  choose(battle,'team 1234','team 1234');
  if(options.pair){choose(battle,'move 1 1, move 3 mega','move 4, move 4');assert.equal(battle.p1.active[1].species.name,'Garchomp-Mega-Z');}
  return {source,battle};
}
function capture(ref,ownSide='p1'){
  const {battle,source}=ref,field={};
  for(const key of ['weather','terrain'])if(battle.field[key])field[key]={id:battle.field[key],remainingTurns:battle.field[key+'State'].duration};
  return {mode:'current',turn:battle.turn,ownSide,field,sides:battle.sides.map(side=>({id:side.id,active:side.active.map(p=>p.name),megaUsed:side.pokemon.some(p=>p.species.isMega),conditions:Object.fromEntries(Object.entries(side.sideConditions).map(([id,value])=>[id,{remainingTurns:value.duration}])),pokemon:side.pokemon.map(p=>{
    for(const id of Object.keys(p.volatiles))assert(['stall','choicelock'].includes(id),`unexpected initial reference volatile ${id}`);
    return {...copy(source[side.id].find(set=>set.id===p.name)),species:p.species.name,ability:p.getAbility().name,item:p.item,hp:p.hp,status:p.status,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp),volatiles:{},lifecycle:{activeTurns:p.activeTurns,activeMoveActions:p.activeMoveActions,protectCounter:p.volatiles.stall?.counter??0,choiceLock:p.volatiles.choicelock?.move??false,lastMove:p.lastMove?.name??false}};
  })}))};
}
const quiet=[move(1),move(1,-1)]; // native Rain Dance and Helping Hand
function input(ref,p1,p2=quiet,ownSide='p1'){
  return {position:capture(ref,ownSide),branches:[{id:'native-target-contract',ourActions:copy(ownSide==='p1'?p1:p2),opposingActions:copy(ownSide==='p1'?p2:p1),gate:{kind:'delivery',requiredActionsBy:ownSide==='p1'?['ally']:['fari']}}],seeds:[seed],hypotheses:['Independent synthetic native current-state target-contract parity; not an exact historical replay or a guarantee about hidden opposing state.']};
}
const nativeVolatiles=p=>Object.fromEntries(Object.entries(p.volatiles).filter(([key])=>!['stall','choicelock'].includes(key)).map(([key,v])=>[key,{remainingTurns:v.duration??null,...(key==='confusion'?{remainingActions:v.time}:{})}]));
function normalize(lines,names=new Map()){
  return extractChannelMessages(lines.join('\n'),[-1])[-1].map(line=>line.replace(/\|t:\|\d+/gu,'|t:|<native-epoch>').replace(/(p[12][ab]?: )([^|]+)/gu,(_all,prefix,name)=>prefix+(names.get(name)??name)).replace(/\|(p[12]): (?:Sim|Independent) p[12](?=\|)/gu,'|$1: <side>'));
}
function parity(ref,request){
  const before=copy(request),sample=simulateNativeTurn(request).samples[0];assert.deepEqual(request,before,'simulation preserves every authored action and state field');
  const own=request.position.ownSide,branch=request.branches[0],pairs={p1:own==='p1'?branch.ourActions:branch.opposingActions,p2:own==='p2'?branch.ourActions:branch.opposingActions};
  for(const side of ['p1','p2'])assert.deepEqual(sample.accepted[side].actions,pairs[side],'no target is inserted, removed or reassigned during native admission');
  const constructor=new Battle({formatid:FORMAT,seed,...Object.fromEntries(request.position.sides.map(side=>[side.id,{name:'Seed '+side.id,team:side.pokemon.map(nativeSet)}]))});
  ref.battle.prng.setSeed(constructor.prng.getSeed());constructor.destroy();
  const logStart=ref.battle.log.length;
  choose(ref.battle,validateChoice(ref.battle.p1.activeRequest,pairs.p1).choice,validateChoice(ref.battle.p2.activeRequest,pairs.p2).choice);
  const names=new Map(sample.start.sides.flatMap(side=>side.pokemon.map((p,index)=>[`sim-${side.id}-${index}`,p.id])));
  assert.deepEqual(normalize(sample.events.map(e=>e.raw),names),normalize(ref.battle.log.slice(logStart)),'all ordered native effects match the independently played continuation');
  for(const side of sample.final.sides)for(const p of side.pokemon){
    const native=ref.battle[side.id].pokemon.find(n=>n.name===p.id);assert(native);
    assert.equal(p.species,native.species.name);assert.equal(p.ability,native.getAbility().name);assert.equal(p.item,native.item);assert.equal(p.hp,native.hp,p.id+' HP');
    assert.equal(p.status,native.status);assert.deepEqual(p.pp,native.moveSlots.map(m=>m.pp));assert.deepEqual(p.boosts,native.boosts);
    assert.deepEqual(Object.fromEntries(Object.entries(p.volatiles).filter(([key])=>!['stall','choicelock'].includes(key))),nativeVolatiles(native));
  }
  return sample;
}
function refused(request,prefix,detail){
  const before=copy(request);assert.throws(()=>simulateNativeTurn(request),error=>{assert(error.message.startsWith(prefix),error.message);assert(error.message.includes(detail),error.message);return true;});
  assert.deepEqual(request,before,'refusal does not silently repair the supplied target');
}

test('opposing Light Screen omits its side target while its Hurricane companion retains the chosen target',()=>{
  const actor=mon('screen','Grimmsnarl','Prankster','Light Clay',['Light Screen','Reflect','Spirit Break','Protect']);
  const partner=mon('ally','Charizard','Blaze','Focus Sash',['Hurricane','Heat Wave','Weather Ball','Protect']);
  const ref=reference(actor,{partner});try{
    assert.equal(ref.battle.p1.activeRequest.active[0].moves[0].target,'allySide');
    assert.equal(ref.battle.p1.activeRequest.active[1].moves[0].target,'any');
    const bad=[move(1,1),move(1,2)];
    refused(input(ref,bad,quiet,'p2'),'Move does not accept a chosen target','move[1]=Light Screen menuTarget=allySide providedTarget=1');
    const good=[move(1),move(1,2)],sample=parity(ref,input(ref,good,quiet,'p2'));
    assert.equal(sample.accepted.p1.canonical,'move 1, move 1 2');
    assert(ref.battle.p1.sideConditions.lightscreen);
    assert(sample.events.some(e=>e.type==='move'&&e.actorId==='ally'&&e.move==='Hurricane'));
  }finally{ref.battle.destroy();}
});

test('native opposing Snarl omits a chosen target while paired Mega-Z Draco Meteor retains its explicit normal target',()=>{
  const ref=reference(null,{pair:true});try{
    assert.equal(dex.moves.get('Snarl').target,'allAdjacentFoes');assert.equal(ref.battle.p1.activeRequest.active[0].moves[3].target,'allAdjacentFoes');
    assert.equal(ref.battle.p1.activeRequest.active[1].moves[0].target,'normal');
    const p1=[move(4),move(1,1)],request=input(ref,p1,quiet,'p2');assert.doesNotThrow(()=>validateChoice(ref.battle.p1.activeRequest,p1));
    const sample=parity(ref,request);assert.equal(sample.accepted.p1.canonical,'move 4, move 1 1');
    assert.equal(sample.events.filter(e=>e.type==='-unboost'&&e.raw.includes('|spa|1')).length,2,'Snarl actually reaches both native opposing slots');
    assert(sample.events.some(e=>e.type==='move'&&e.actorId==='chomp'&&e.move==='Draco Meteor'));
    assert(sample.events.some(e=>e.type==='-unboost'&&e.actorId==='chomp'&&e.raw.includes('|spa|2')),'fixed native sample exercises Draco Meteor delivery and its self-drop');
  }finally{ref.battle.destroy();}
});

test('the source Snarl target:1 error is refused at p1a without repairing the legal Draco Meteor companion',()=>{
  const ref=reference(null,{pair:true});try{
    const actions=[move(4,1),move(1,1)];assert.throws(()=>validateChoice(ref.battle.p1.activeRequest,actions),/^Error: Move does not accept a chosen target/u);
    assert.equal(ref.battle.choose('p1','move 4 1, move 1 1'),false,'the independent native choice also refuses a chosen Snarl target');ref.battle.p1.clearChoice();
    refused(input(ref,actions,quiet,'p2'),'Move does not accept a chosen target','p1a Incineroar move[4]=Snarl menuTarget=allAdjacentFoes providedTarget=1');
  }finally{ref.battle.destroy();}
});

test('normal Draco Meteor requires a chosen target rather than inheriting the Snarl spread contract',()=>{
  const ref=reference(null,{pair:true});try{
    assert.equal(dex.moves.get('Draco Meteor').target,'normal');
    const actions=[move(4),move(1)];assert.throws(()=>validateChoice(ref.battle.p1.activeRequest,actions),/Explicit target required/u);
    assert.equal(ref.battle.choose('p1','move 4, move 1'),false,'the independent native normal-target choice also needs its target');ref.battle.p1.clearChoice();
    refused(input(ref,actions,quiet,'p2'),'Explicit target required','p1b Garchomp-Mega-Z move[1]=Draco Meteor menuTarget=normal providedTarget=unset');
  }finally{ref.battle.destroy();}
});

for(const ghost of [false,true])test(`native Curse ${ghost?'Ghost normal':'non-Ghost self'} menu overrides any blanket base-target rule`,()=>{
  const actor=ghost?mon('actor','Gengar','Cursed Body','',['Curse','Shadow Ball','Sludge Bomb','Protect']):mon('actor','Umbreon','Synchronize','',['Curse','Foul Play','Helping Hand','Protect']);
  const ref=reference(actor);try{
    assert.equal(dex.moves.get('Curse').target,'normal');assert.equal(ref.battle.p1.active[0].hasType('Ghost'),ghost);
    assert.equal(ref.battle.p1.activeRequest.active[0].moves[0].target,ghost?'normal':'self');
    const valid=[move(1,ghost?1:undefined),move(1,-1)],invalid=[move(1,ghost?undefined:1),move(1,-1)];
    assert.throws(()=>validateChoice(ref.battle.p1.activeRequest,invalid),ghost?/Explicit target required/u:/Move does not accept a chosen target/u);
    assert.equal(ref.battle.choose('p1',ghost?'move 1, move 1 -1':'move 1 1, move 1 -1'),false,'the native conditional Curse menu rejects the wrong target shape');ref.battle.p1.clearChoice();
    refused(input(ref,invalid),ghost?'Explicit target required':'Move does not accept a chosen target',`move[1]=Curse menuTarget=${ghost?'normal':'self'}`);
    const sample=parity(ref,input(ref,valid));
    if(ghost){assert(sample.events.some(e=>e.type==='-start'&&e.actorId==='toed'&&e.raw.includes('Curse')));assert(sample.final.sides[1].pokemon.find(p=>p.id==='toed').volatiles.curse);}
    else{const native=ref.battle.p1.active[0];assert.equal(native.boosts.atk,1);assert.equal(native.boosts.def,1);assert.equal(native.boosts.spe,-1);assert(!sample.events.some(e=>e.type==='-start'&&e.raw.includes('Curse')));}
  }finally{ref.battle.destroy();}
});

for(const mode of ['grounded-psychic-terrain','airborne-psychic-terrain','grounded-no-terrain'])test(`Expanding Force preserves its normal menu target under ${mode} native recipient resolution`,()=>{
  const terrain=mode!=='grounded-no-terrain',grounded=mode!=='airborne-psychic-terrain';
  const actor=mon('actor','Indeedee',terrain?'Psychic Surge':'Inner Focus',grounded?'Expert Belt':'Air Balloon',['Expanding Force','Psychic','Protect','Helping Hand']);
  const ref=reference(actor);try{
    assert.equal(dex.moves.get('Expanding Force').target,'normal');assert.equal(ref.battle.p1.activeRequest.active[0].moves[0].target,'normal');
    assert.equal(ref.battle.field.terrain==='psychicterrain',terrain);assert.equal(!!ref.battle.p1.active[0].isGrounded(),grounded);
    const missing=[move(1),move(1,-1)];assert.throws(()=>validateChoice(ref.battle.p1.activeRequest,missing),/Explicit target required/u);
    assert.equal(ref.battle.choose('p1','move 1, move 1 -1'),false,'conditional spread resolution does not remove the native menu target requirement');ref.battle.p1.clearChoice();
    refused(input(ref,missing),'Explicit target required','move[1]=Expanding Force menuTarget=normal providedTarget=unset');
    const sample=parity(ref,input(ref,[move(1,1),move(1,-1)]));assert.equal(sample.accepted.p1.canonical,'move 1 1, move 1 -1');
    const damaged=[...new Set(sample.events.filter(e=>e.type==='-damage'&&['toed','fari'].includes(e.actorId)).map(e=>e.actorId))].sort();
    assert.deepEqual(damaged,terrain&&grounded?['fari','toed']:['toed'],'actual native effects distinguish terrain/grounding recipients from menu selection');
    assert(ref.battle.p2.active.every(p=>p.hp>0),'living targets keep a knockout floor from hiding target coverage');
  }finally{ref.battle.destroy();}
});
