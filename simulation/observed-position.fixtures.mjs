// Pure test fixtures; imports do not register tests or access live battle state.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {Teams,TeamValidator,Dex}=require('pokemon-showdown');
const requestDex=Dex.forFormat('gen9championsvgc2026regmc');
const zero={atk:0,def:0,spa:0,spd:0,spe:0,accuracy:0,evasion:0};
const points=(value={})=>({hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...value});
const life={activeTurns:0,activeMoveActions:0,protectCounter:0,choiceLock:false,lastMove:false};
// The unselected bench is synthetic; this is not a saved user's six or hash.
const teamText=`Incineroar @ Sitrus Berry
Ability: Intimidate
EVs: 32 HP / 2 Def / 32 SpD
Careful Nature
- Flare Blitz
- Throat Chop
- Parting Shot
- Fake Out

Rillaboom @ Miracle Seed
Ability: Grassy Surge
EVs: 25 HP / 32 Atk / 1 Def / 6 SpD / 2 Spe
Adamant Nature
- Wood Hammer
- Grassy Glide
- High Horsepower
- Fake Out

Politoed @ Leftovers
Ability: Drizzle
EVs: 32 HP / 2 Def / 32 SpA
Modest Nature
- Weather Ball
- Muddy Water
- Icy Wind
- Protect

Farigiraf @ Grassy Seed
Ability: Armor Tail
EVs: 32 HP / 16 Def / 18 SpD
Sassy Nature
- Psychic Noise
- Helping Hand
- Trick Room
- Protect

Sylveon @ Fairy Feather
Ability: Pixilate
EVs: 32 HP / 2 Def / 32 SpA
Quiet Nature
- Hyper Voice
- Quick Attack
- Mystical Fire
- Protect

Archaludon @ Choice Scarf
Ability: Stamina
EVs: 32 SpA / 2 SpD / 32 Spe
Timid Nature
- Dragon Pulse
- Flash Cannon
- Aura Sphere
- Electro Shot
`;
const imported=Teams.import(teamText);new TeamValidator('gen9championsvgc2026regmc').validateTeam(imported);
const teamId=createHash('sha256').update(Teams.pack(imported)).digest('hex');
const opposingSheet=[
  {species:'Rillaboom',nature:'Adamant',ability:'Grassy Surge',item:'Miracle Seed',moves:['Wood Hammer','High Horsepower','Grassy Glide','Fake Out']},
  {species:'Incineroar',nature:'Careful',ability:'Intimidate',item:'Sitrus Berry',moves:['Flare Blitz','Throat Chop','Parting Shot','Fake Out']},
  {species:'Volcarona',nature:'Modest',ability:'Flame Body',item:'Grassy Seed',moves:['Heat Wave','Quiver Dance','Giga Drain','Protect']},
  {species:'Basculegion',nature:'Jolly',ability:'Adaptability',item:'Choice Scarf',moves:['Wave Crash','Last Respects','Flip Turn','Soak']},
  {species:'Raichu',nature:'Timid',ability:'Lightning Rod',item:'Raichunite Y',moves:['Zap Cannon','Focus Blast','Fake Out','Protect']},
  {species:'Staraptor',nature:'Jolly',ability:'Intimidate',item:'Staraptite',moves:['Close Combat','Brave Bird','Roost','Protect']},
];
function fixture(){
  const room='battle-gen9championsvgc2026regmcbo3-123-privatepw',token='a'.repeat(64),rqid=4;
  const names=['Archaludon','Farigiraf','Politoed','Sylveon'],hp=[165,227,197,202];
  const pokemon=names.map((species,index)=>({id:`own${index}`,species,requestIndex:index+1,activeSlot:index<2?'ab'[index]:null,
    hp:{current:hp[index],max:hp[index],precision:'server-own-exact'},status:null,fainted:false,mega:null,
    boosts:index===1?{...zero,def:1}:index<2?{...zero}:Object.fromEntries(Object.keys(zero).map(key=>[key,null])),
    abilitySuppressed:false,ability:['Stamina','Armor Tail','Drizzle','Pixilate'][index],volatiles:{}}));
  const requestPokemon=names.map((species,index)=>{
    const set=imported.find(value=>value.species===species);
    return {ident:`p1: ${species}`,details:`${species}, L50, M`,condition:`${hp[index]}/${hp[index]}`,active:index<2,
      moves:set.moves.map(value=>value.toLowerCase().replace(/[^a-z0-9]/g,'')),ability:set.ability,item:index===1?'':set.item};
  });
  const foes=['Raichu','Rillaboom'].map((species,index)=>({id:`foe${index}`,species,hp:{current:100,max:100,precision:'server-display'},status:null,fainted:false,mega:null,boosts:{...zero},abilitySuppressed:null,ability:index===1?'Grassy Surge':null,itemKnown:false,item:null,volatiles:{}}));
  const legal={teamPreview:false,forceSwitch:null,pokemon:requestPokemon,active:names.slice(0,2).map(species=>({moves:imported.find(set=>set.species===species).moves.map(move=>({move,pp:12,target:requestDex.moves.get(move).target,disabled:false}))}))};
  const board={room,turn:1,ownSide:'p1',observedAt:1,request:{rqid,wait:false,forceSwitch:null},field:{weather:null,terrain:{name:'Grassy Terrain',remainingTurns:{min:5,max:8}},conditions:{}},
    sides:[{id:'p1',active:[{slot:'a',pokemon:'own0'},{slot:'b',pokemon:'own1'}],pokemon,unrevealedSelected:0,conditions:{}},{id:'p2',active:[{slot:'a',pokemon:'foe0'},{slot:'b',pokemon:'foe1'}],pokemon:foes,unrevealedSelected:2,conditions:{}}],recentEvents:{lines:['|turn|1']}};
  return {teamText,opposingSheet:structuredClone(opposingSheet),observed:{sessionId:'fixture',revision:1,actions:[{kind:'turn',room,rqid,token,legalActions:legal}],boards:[board],opponentSheets:{p2:structuredClone(opposingSheet)}},expected:{teamId,room,rqid,token},
    hypotheses:{mode:'opening',label:'Explicit benchmark only; opposing investments/reserves unknown',opposing:{foe0:{label:'hypothetical max special Speed',statPoints:points({spa:32,spd:2,spe:32}),hp:'full'},foe1:{label:'hypothetical bulky physical',statPoints:points({hp:32,atk:32,def:2}),hp:'full'}},reserves:[{id:'foe2',species:'Volcarona',label:'hypothetical selected reserve',statPoints:points({hp:2,spa:32,spe:32}),hp:'full'},{id:'foe3',species:'Incineroar',label:'hypothetical selected reserve',statPoints:points({hp:32,def:2,spd:32}),hp:'full'}]}};
}
function currentFixture(){
  const input=fixture();input.hypotheses.mode='current';input.hypotheses.field={terrain:{id:'grassyterrain',remainingTurns:5}};input.hypotheses.sideMegaUsed={p1:false,p2:false};
  for(const p of input.observed.boards[0].sides[0].pokemon)input.hypotheses.own??={},input.hypotheses.own[p.id]={label:'explicit carried lifecycle and reserve PP hypothesis',lifecycle:{...life},pp:[12,12,12,12],boosts:{...zero,...(p.id==='own1'?{def:1}:{})}};
  for(const h of Object.values(input.hypotheses.opposing))Object.assign(h,{abilitySuppressed:false,pp:[12,12,12,12],lifecycle:{...life},item:'Miracle Seed'});
  Object.assign(input.hypotheses.opposing.foe0,{ability:'Lightning Rod',item:'Raichunite Y'});
  for(const reserve of input.hypotheses.reserves)Object.assign(reserve,{status:'',boosts:{...zero},pp:[12,12,12,12],lifecycle:{...life},volatiles:{}});
  return input;
}

export {fixture,currentFixture,points};
