import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {simulateNativeTurn} from './turn-simulator.mjs';
import {buildObservedPosition} from './observed-position.mjs';
import {currentFixture} from './observed-position.fixtures.mjs';
const {Battle}=createRequire(import.meta.url)('pokemon-showdown');
const mon=(id,species,nature,ability,item,moves,points)=>({id,species,nature,ability,item,moves,statPoints:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...points}});
function fixture(){
  const p1=[mon('gol','Golisopod','Brave','Emergency Exit','Golisopite',['Sucker Punch','Iron Head','Leech Life','Protect'],{hp:32,atk:32,spd:2}),mon('toed','Politoed','Modest','Drizzle','Leftovers',['Weather Ball','Muddy Water','Ice Beam','Protect'],{hp:32,def:2,spa:32}),mon('fari','Farigiraf','Sassy','Armor Tail','Grassy Seed',['Psychic','Helping Hand','Trick Room','Protect'],{hp:32,def:16,spd:18}),mon('arch','Archaludon','Timid','Stamina','Choice Scarf',['Dragon Pulse','Flash Cannon','Aura Sphere','Electro Shot'],{spa:32,spd:2,spe:32})];
  const p2=[mon('chomp','Garchomp','Jolly','Rough Skin','Garchompite Z',['Dragon Claw','Rock Slide','Draco Meteor','Protect'],{hp:32,atk:2,spe:32}),mon('foefari','Farigiraf','Sassy','Armor Tail','Sitrus Berry',['Psychic','Helping Hand','Trick Room','Protect'],{hp:32,def:16,spd:18}),mon('rilla','Rillaboom','Adamant','Grassy Surge','Miracle Seed',['Wood Hammer','High Horsepower','Grassy Glide','Fake Out'],{hp:32,atk:32,spd:2}),mon('volc','Volcarona','Modest','Flame Body','Expert Belt',['Heat Wave','Quiver Dance','Giga Drain','Protect'],{hp:32,spa:32,spd:2})];
  const sets={p1,p2},native=party=>party.map(p=>({name:p.id,species:p.species,nature:p.nature,ability:p.ability,item:p.item,moves:p.moves,evs:p.statPoints,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},level:50}));
  const battle=new Battle({formatid:'gen9championsvgc2026regmc',seed:[1,2,3,4],p1:{name:'Reference p1',team:native(p1)},p2:{name:'Reference p2',team:native(p2)}});
  const choose=(a,b)=>{assert.equal(battle.choose('p1',a),true,battle.p1.choice.error);assert.equal(battle.choose('p2',b),true,battle.p2.choice.error);};
  choose('team 1234','team 1234');choose('move 4, move 4','move 1 1, move 2 -1');
  const capture=()=>({mode:'current',ownSide:'p1',turn:battle.turn,field:{weather:{id:battle.field.weather,remainingTurns:battle.field.weatherState.duration}},sides:battle.sides.map(side=>({id:side.id,active:side.active.map(p=>p.name),megaUsed:false,conditions:{},pokemon:side.pokemon.map(p=>({...structuredClone(sets[side.id].find(s=>s.id===p.name)),ability:p.getAbility().name,item:p.item,hp:p.hp,status:p.status,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp),lifecycle:{activeTurns:p.activeTurns,activeMoveActions:p.activeMoveActions,protectCounter:p.volatiles.stall?.counter??0,choiceLock:false,lastMove:p.lastMove?.name??false},volatiles:{}}))}))});
  return {battle,choose,capture};
}
for(const kind of ['contact','noncontact','blocked'])test(`CURRENT Rough Skin ${kind} continuation agrees with an independently played native history`,()=>{
  const f=fixture();try{
    const position=f.capture(),own=kind==='noncontact'?[{type:'move',slot:4},{type:'move',slot:3,target:1}]:[{type:'move',slot:2,target:1},{type:'move',slot:4}],foe=[{type:'move',slot:kind==='blocked'?4:3,...(kind==='blocked'?{}:{target:2})},{type:'move',slot:2,target:-1}];
    const seed=[5,6,7,8],input={position,branches:[{id:kind,ourActions:own,opposingActions:foe,gate:{kind:'delivery',requiredActionsBy:[kind==='noncontact'?'toed':'gol']}}],seeds:[seed],hypotheses:['Synthetic native CURRENT parity, not a live opposing investment or tactical guarantee.']};
    const sample=simulateNativeTurn(input).samples[0];
    const seedTeams=Object.fromEntries(position.sides.map(side=>[side.id,{name:'Seed '+side.id,team:side.pokemon.map(p=>({name:p.id,species:p.species,nature:p.nature,ability:p.ability,item:p.item,moves:p.moves,evs:p.statPoints,level:50,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31}}))}]));
    const seedSource=new Battle({formatid:'gen9championsvgc2026regmc',seed,...seedTeams});
    f.battle.prng.setSeed(seedSource.prng.getSeed());seedSource.destroy();
    const text=actions=>actions.map(a=>`move ${a.slot}${a.target===undefined?'':' '+a.target}`).join(', ');
    f.choose(text(own),text(foe));
    for(const side of f.battle.sides)for(const p of side.pokemon){const actual=sample.final.sides.find(s=>s.id===side.id).pokemon.find(q=>q.id===p.name);assert.equal(actual.hp,p.hp,p.name);assert.deepEqual(actual.pp,p.moveSlots.map(m=>m.pp),p.name);assert.deepEqual(actual.boosts,p.boosts,p.name);}
    const events=sample.events.filter(e=>e.type==='-damage'&&e.raw.includes('Rough Skin'));
    assert.equal(events.length,kind==='contact'?1:0);
  }finally{f.battle.destroy();}
});
test('observed CURRENT Rough Skin keeps exact supplied state and still refuses unknown lifecycle',()=>{
  const f=currentFixture(),actor=f.observed.boards[0].sides[1].pokemon[0],set={species:'Garchomp',ability:'Rough Skin',item:'Garchompite Z',nature:'Jolly',level:50,moves:['Dragon Claw','Rock Slide','Draco Meteor','Protect']};
  f.opposingSheet[f.opposingSheet.findIndex(p=>p.species===actor.species)]=set;Object.assign(actor,{species:set.species,ability:set.ability,item:set.item,hp:{current:100,max:100,precision:'server-display'},mega:null});
  f.observed.opponentSheets={p2:structuredClone(f.opposingSheet)};
  const h=f.hypotheses.opposing[actor.id];Object.assign(h,{ability:set.ability,item:set.item,hp:'observed-high',pp:[24,16,8,16]});
  const built=buildObservedPosition(f);assert.equal(built.position.sides[1].pokemon.find(p=>p.id===actor.id).ability,'Rough Skin');
  delete h.lifecycle;assert.throws(()=>buildObservedPosition(f),/lifecycle/);
});
