import {simulateNativeTurn} from './turn-simulator.mjs';
const pokemon=(id,species,nature,ability,item,moves,statPoints)=>({id,species,nature,ability,item,moves,statPoints});
export function openingFixture(){return {position:{mode:'opening',turn:1,ownSide:'p1',sides:[
  {id:'p1',active:['arch','fari'],pokemon:[
    pokemon('arch','Archaludon','Timid','Stamina','Choice Scarf',['Dragon Pulse','Flash Cannon','Aura Sphere','Electro Shot'],{spa:32,spd:2,spe:32}),
    pokemon('fari','Farigiraf','Sassy','Armor Tail','Grassy Seed',['Psychic Noise','Helping Hand','Trick Room','Protect'],{hp:32,def:16,spd:18}),
    pokemon('toed','Politoed','Modest','Drizzle','Leftovers',['Weather Ball','Muddy Water','Icy Wind','Protect'],{hp:32,def:2,spa:32}),
    pokemon('sylv','Sylveon','Quiet','Pixilate','Fairy Feather',['Hyper Voice','Quick Attack','Mystical Fire','Protect'],{hp:32,def:2,spa:32}),
  ]},
  {id:'p2',active:['raichu','rilla'],pokemon:[
    pokemon('raichu','Raichu','Timid','Lightning Rod','Raichunite Y',['Zap Cannon','Focus Blast','Fake Out','Protect'],{spa:32,spd:2,spe:32}),
    pokemon('rilla','Rillaboom','Adamant','Grassy Surge','Miracle Seed',['Wood Hammer','High Horsepower','Grassy Glide','Fake Out'],{hp:32,atk:32,def:2}),
    pokemon('volc','Volcarona','Modest','Flame Body','Grassy Seed',['Heat Wave','Quiver Dance','Giga Drain','Protect'],{hp:32,spa:32,spd:2}),
    pokemon('incin','Incineroar','Careful','Intimidate','Sitrus Berry',['Flare Blitz','Throat Chop','Parting Shot','Fake Out'],{hp:32,atk:2,spd:32}),
  ]},
]},branches:[{id:'pressure',ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}],opposingActions:[{type:'move',slot:2,target:1,mega:true},{type:'move',slot:1,target:2}],gate:{targetId:'raichu',beforeActionsOf:['raichu'],requiredActionsBy:['arch','fari']}}],seeds:[[1,2,3,4]],hypotheses:['Foe stat points and selected reserves are explicit legal candidates, not revealed investments or exact replay reconstruction.']};}

export function currentFixture(){
  const input=openingFixture(),start=simulateNativeTurn(input).samples[0].start;
  input.position.mode='current';input.position.turn=2;input.position.field={terrain:{id:'grassyterrain',remainingTurns:5}};
  for(const side of input.position.sides){side.megaUsed=false;for(const p of side.pokemon){const native=start.sides.find(s=>s.id===side.id).pokemon.find(n=>n.id===p.id);Object.assign(p,{hp:native.hp,status:native.status,item:native.item,ability:native.ability,boosts:native.boosts,pp:native.pp,lifecycle:{activeTurns:side.active.includes(p.id)?1:0,activeMoveActions:side.active.includes(p.id)?1:0,protectCounter:0,choiceLock:false,lastMove:false},volatiles:{}});}}
  return input;
}
