import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {simulateNativeTurn} from './turn-simulator.mjs';
const {Battle}=createRequire(import.meta.url)('pokemon-showdown');
const {extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',seed=[1,2,3,4],copy=structuredClone;
const mon=(id,species,nature,ability,item,moves,points)=>({id,species,nature,ability,item,moves,statPoints:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...points}});
const teams=sets=>Object.fromEntries(Object.entries(sets).map(([side,party])=>[side,party.map(p=>({name:p.id,species:p.species,nature:p.nature,ability:p.ability,item:p.item,moves:p.moves,evs:p.statPoints,level:50,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31}}))]));
const choose=(battle,a,b)=>{assert.equal(battle.choose('p1',a),true,battle.p1.choice.error);assert.equal(battle.choose('p2',b),true,battle.p2.choice.error);};
function fixture(){
  const sets={p1:[
    mon('toed','Politoed','Modest','Drizzle','Leftovers',['Weather Ball','Helping Hand','Rain Dance','Protect'],{hp:32,def:2,spa:32}),
    mon('fari','Farigiraf','Sassy','Armor Tail','Grassy Seed',['Psychic','Helping Hand','Trick Room','Protect'],{hp:32,def:16,spd:18}),
    mon('gol','Golisopod','Brave','Emergency Exit','Golisopite',['Sucker Punch','Iron Head','Leech Life','Protect'],{hp:32,atk:32,spd:2}),
    mon('arch','Archaludon','Timid','Stamina','Choice Scarf',['Dragon Pulse','Flash Cannon','Aura Sphere','Electro Shot'],{spa:32,spd:2,spe:32}),
  ],p2:[
    mon('mal','Malamar','Relaxed','Contrary','Roseli Berry',['Knock Off','Topsy-Turvy','Trick Room','Skill Swap'],{hp:32,def:32,spd:2}),
    mon('volc','Volcarona','Modest','Flame Body','Expert Belt',['Will-O-Wisp','Heat Wave','Giga Drain','Protect'],{hp:32,spa:32,spd:2}),
    mon('chomp','Garchomp','Timid','Rough Skin','Garchompite Z',['Protect','Power Gem','Draco Meteor','Flamethrower'],{hp:2,spa:32,spe:32}),
    mon('rilla','Rillaboom','Adamant','Grassy Surge','Miracle Seed',['Fake Out','Grassy Glide','Wood Hammer','High Horsepower'],{hp:32,atk:32,spd:2}),
  ]};
  const native=teams(sets),battle=new Battle({formatid:FORMAT,seed,p1:{name:'Reference p1',team:native.p1},p2:{name:'Reference p2',team:native.p2}});
  choose(battle,'team 1234','team 1234');
  // Native history, rather than fabricated status/field counters, establishes
  // burn, weather, Trick Room and the previous Protect/PP lifecycle.
  choose(battle,'move 3, move 4','move 3, move 1 1');
  assert.equal(battle.p1.active[0].status,'brn');assert.equal(battle.requestState,'move');
  // Let genuine residual turns expire Rain Dance. Gaining Drizzle during the
  // tested continuation must now establish weather through its native event.
  for(let turns=0;battle.field.weather&&turns<8;turns++)choose(battle,'move 2 -2, move 2 -1','move 3, move 4');
  assert.equal(battle.field.weather,'');
  return {battle,sets};
}
function capture(battle,sets){
  const field={};if(battle.field.weather)field.weather={id:battle.field.weather,remainingTurns:battle.field.weatherState.duration};if(battle.field.terrain)field.terrain={id:battle.field.terrain,remainingTurns:battle.field.terrainState.duration};if(battle.field.pseudoWeather.trickroom)field.trickRoom={remainingTurns:battle.field.pseudoWeather.trickroom.duration};
  return {mode:'current',ownSide:'p1',turn:battle.turn,field,sides:battle.sides.map(side=>({id:side.id,active:side.active.map(p=>p.name),megaUsed:false,conditions:{},pokemon:side.pokemon.map(p=>({...copy(sets[side.id].find(s=>s.id===p.name)),species:p.species.name,ability:p.getAbility().name,item:p.item,hp:p.hp,maxhp:p.maxhp,status:p.status,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp),lifecycle:{activeTurns:p.activeTurns,activeMoveActions:p.activeMoveActions,protectCounter:p.volatiles.stall?.counter??0,choiceLock:p.volatiles.choicelock?.move??false,lastMove:p.lastMove?.name??false},volatiles:{}}))}))};
}
const positionInput=value=>{const p=copy(value);for(const side of p.sides)for(const mon of side.pokemon)delete mon.maxhp;return p;};
const comparePokemon=p=>Object.fromEntries(['id','species','ability','item','hp','maxhp','status','boosts','pp','lifecycle'].map(key=>[key,p[key]]));
function projectReference(position){return {turn:position.turn,field:position.field,sides:position.sides.map(s=>({id:s.id,active:s.active,pokemon:s.pokemon.map(comparePokemon)}))};}
function projectSample(state){const field={};if(state.field.weather)field.weather={id:state.field.weather,remainingTurns:state.field.weatherRemaining};if(state.field.terrain)field.terrain={id:state.field.terrain,remainingTurns:state.field.terrainRemaining};if(state.field.pseudoWeather.trickroom)field.trickRoom=state.field.pseudoWeather.trickroom;return {turn:state.turn,field,sides:state.sides.map(s=>({id:s.id,active:s.active,pokemon:s.pokemon.map(comparePokemon)}))};}
function normalized(lines,names=new Map()){return extractChannelMessages(lines.join('\n'),[-1])[-1].map(line=>line.replace(/(p[12][ab]?: )([^|]+)/gu,(_all,prefix,name)=>prefix+(names.get(name)??name)));}
const text=actions=>actions.map(a=>`move ${a.slot}${a.target===undefined?'':' '+a.target}`).join(', ');
function parity(kind){
  const f=fixture();try{
    const exact=capture(f.battle,f.sets),position=positionInput(exact),ourActions=[{type:'move',slot:kind==='weather'?1:4,...(kind==='weather'?{target:2}:{})},{type:'move',slot:2,target:-1}],opposingActions=[{type:'move',slot:4,target:kind==='ally'?-2:1},{type:'move',slot:kind==='blocked'?4:2}],branch={id:kind,ourActions,opposingActions,gate:{kind:'delivery',requiredActionsBy:['toed','fari']}};
    const input={position,branches:[branch],seeds:[[5,6,7,8]],hypotheses:['Independent local native Skill Swap continuation; no live battle or opposing spread claim.']},sample=simulateNativeTurn(input).samples[0];
    assert.deepEqual(projectSample(sample.start),projectReference(exact));
    const native=teams(Object.fromEntries(position.sides.map(side=>[side.id,side.pokemon]))),seedSource=new Battle({formatid:FORMAT,seed:input.seeds[0],p1:{name:'Seed p1',team:native.p1},p2:{name:'Seed p2',team:native.p2}});
    f.battle.prng.setSeed(seedSource.prng.getSeed());seedSource.destroy();const before=f.battle.log.length;
    choose(f.battle,text(ourActions),text(opposingActions));
    const names=new Map(sample.start.sides.flatMap(s=>s.pokemon.map((p,index)=>[`sim-${s.id}-${index}`,p.id])));
    assert.deepEqual(normalized(sample.events.map(e=>e.raw),names),normalized(f.battle.log.slice(before)),'ordered native effects match played history');
    assert.deepEqual(projectSample(sample.final),projectReference(capture(f.battle,f.sets)),'abilities, status, HP, PP, lifecycle and field match');
    const actors=sample.final.sides.flatMap(s=>s.pokemon),mal=actors.find(p=>p.id==='mal');
    if(kind==='blocked'){assert.equal(mal.ability,'Contrary');assert(sample.events.some(e=>e.raw.includes('Protect')&&e.type==='-activate'));}
    else {assert.equal(mal.ability,kind==='ally'?'Flame Body':'Drizzle');assert.equal(actors.find(p=>p.id=== (kind==='ally'?'volc':'toed')).ability,'Contrary');}
    if(kind==='weather')assert(sample.events.some(e=>e.type==='-weather'&&e.raw.includes('Drizzle')),'newly acquired Drizzle is resolved by native callback');
    assert.equal(actors.find(p=>p.id==='toed').status,'brn');
    return {sample,next:positionInput(capture(f.battle,f.sets)),branch};
  }finally{f.battle.destroy();}
}
for(const kind of ['weather','ally','blocked'])test(`CURRENT Skill Swap ${kind} agrees with independently played native history`,()=>parity(kind));
test('later copied-ability current state executes with preserved abilities and explicit missing-base uncertainty',()=>{
  const f=parity('ally'),before=copy(f.next),sample=simulateNativeTurn({position:f.next,branches:[f.branch],seeds:[[1,2,3,4]],hypotheses:['Known copied abilities retained; unprovided original base-ability state remains conditional.']}).samples[0];
  assert.deepEqual(f.next,before);assert.deepEqual(sample.start.sides.flatMap(s=>s.pokemon).map(p=>[p.id,p.ability]),f.next.sides.flatMap(s=>s.pokemon).map(p=>[p.id,p.ability]));assert(sample.events.some(e=>e.type==='move'&&e.move==='Skill Swap'));assert(Object.values(sample.accepted).every(side=>side.accepted));assert.equal(sample.stateCoverage.complete,false);assert(sample.stateCoverage.assumptions.some(row=>row.path.includes('baseAbility')));assert.equal(sample.gate.passed,false);
});

const saved=process.env.VGC_SKILL_SWAP_CAPTURE;
test('exact previously authored qualification Skill Swap branches resolve without replacing or deleting a model pair',{skip:saved&&existsSync(saved)?false:'Optional saved model evidence not configured'},async()=>{
  const document=JSON.parse(await readFile(saved,'utf8')),rows=document.result?.nativeJournal??document.nativeJournal,native=rows.find(r=>r.name==='simulate_turn'&&r.input?.request?.kind==='explicit');assert(native,'genuine previous authored native input required');
  const {kind,...input}=copy(native.input.request),before=copy(input),result=simulateNativeTurn(input);
  assert.deepEqual(input,before);assert.equal(result.samples.length,input.branches.length*input.seeds.length);assert.equal(input.branches.length,3);
  assert(result.samples.some(s=>s.events.some(e=>e.move==='Skill Swap')));assert(result.samples.every(s=>Object.values(s.accepted).every(a=>a.accepted)));
});
