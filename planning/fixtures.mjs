// Offline observations only; no client, account, or live battle dependency.
export function planningFixture() {
  const set = (species,nature,ability,item,moves) => ({species,nature,ability,item,moves,evs:{hp:32,atk:0,def:0,spa:0,spd:2,spe:32}});
  const ownTeam = [
    set('Incineroar','Careful','Intimidate','Sitrus Berry',['Fake Out','Flare Blitz','Protect','Parting Shot']),
    set('Hydreigon','Modest','Levitate','Life Orb',['Dark Pulse','Draco Meteor','Protect','Tailwind']),
    set('Rillaboom','Adamant','Grassy Surge','Assault Vest',['Wood Hammer','Fake Out','U-turn','High Horsepower']),
    set('Farigiraf','Quiet','Armor Tail','Safety Goggles',['Psychic Noise','Trick Room','Helping Hand','Protect']),
  ];
  const opponentSheet = [
    {species:'Garchomp',item:'Clear Amulet',ability:'Rough Skin',moves:['Earthquake','Dragon Claw','Swords Dance','Protect'],nature:null},
    {species:'Rotom-Wash',item:'Sitrus Berry',ability:'Levitate',moves:['Hydro Pump','Thunderbolt','Will-O-Wisp','Protect'],nature:null},
    {species:'Farigiraf',item:'Safety Goggles',ability:'Armor Tail',moves:['Psychic Noise','Trick Room','Helping Hand','Protect'],nature:null},
  ];
  const mon = (id,species,slot,requestIndex = null) => ({id,species,nickname:species,activeSlot:slot,requestIndex,identityConfidence:'observed',
    hp:{current:100,max:100,precision:id.startsWith('p1') ? 'server-own-exact' : 'server-display'},status:null,fainted:false,
    boosts:{atk:0,def:0,spa:0,spd:0,spe:0,accuracy:0,evasion:0},ability:null,abilitySuppressed:false,item:null,itemKnown:false,
    itemHistory:[],mega:null,moves:[],volatiles:{},selection:requestIndex ? 'selected' : 'unknown'});
  const own = [mon('p1-cat','Incineroar','a',1),mon('p1-dragon','Hydreigon','b',2),mon('p1-boom','Rillaboom',null,3)];
  const foe = [mon('p2-chomp','Garchomp','a'),mon('p2-wash','Rotom-Wash','b')];
  const board = {turn:2,ownSide:'p1',field:{weather:null,terrain:null,conditions:{}},request:{teamPreview:false},
    sides:[{id:'p1',selectionKnowledge:'current-own-request',selectedTeamSize:3,unrevealedSelected:0,active:[{slot:'a',pokemon:'p1-cat'},{slot:'b',pokemon:'p1-dragon'}],reserves:['p1-boom'],pokemon:own,conditions:{}},
      {id:'p2',selectionKnowledge:'observed-opponents-only',selectedTeamSize:4,unrevealedSelected:2,active:[{slot:'a',pokemon:'p2-chomp'},{slot:'b',pokemon:'p2-wash'}],reserves:[],pokemon:foe,conditions:{}}],warnings:[]};
  const legalMove = (move,target,pp = 10) => ({move,id:move.toLowerCase().replace(/[^a-z0-9]/g,''),target,pp,maxpp:pp,disabled:false});
  const legalActions = {teamPreview:false,forceSwitch:null,
    active:[{moves:[legalMove('Fake Out','normal'),legalMove('Flare Blitz','normal'),legalMove('Protect','self'),legalMove('Parting Shot','normal')]},
      {moves:[legalMove('Dark Pulse','normal'),legalMove('Draco Meteor','normal'),legalMove('Protect','self'),legalMove('Tailwind','allySide')]}],
    pokemon:own.map((pokemon,index) => ({ident:`p1: ${pokemon.nickname}`,details:`${pokemon.species}, L50`,condition:'100/100',active:index < 2}))};
  return {board,legalActions,ownTeam,opponentSheet,objective:{winCondition:'Preserve Hydreigon until its remaining obstacles can be removed.'}};
}
