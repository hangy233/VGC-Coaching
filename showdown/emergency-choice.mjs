import {createRequire} from 'node:module';
import {legalReplacementPairs, replacementOptions, validateChoice} from './choice-validation.mjs';

const {Dex}=createRequire(import.meta.url)('pokemon-showdown');
const champions=Dex.mod('champions');
const fainted=pokemon=>/ fnt$/.test(pokemon?.condition||'');
const CONDITIONAL=new Set([
  'suckerpunch','counter','mirrorcoat','metalburst','comeuppance','focuspunch',
  'fakeout','firstimpression','lastresort','belch','dreameater','snore','fling',
  'naturalgift','spitup','synchronoise','burnup','doubleshock','steelroller','upperhand',
]);
const SACRIFICE=new Set(['explosion','selfdestruct','mistyexplosion','finalgambit']);
const TARGETED=new Set(['normal','any','adjacentAlly','adjacentAllyOrSelf','adjacentFoe']);

function canonical(request,actions){
  try{return validateChoice(request,actions).actions;}catch{return null;}
}

function moveCandidates(request,index,foeSlots){
  if(fainted(request.side?.pokemon?.[index]))return [{action:{type:'pass'},rank:0}];
  const candidates=[];
  for(const [moveIndex,move] of (request.active?.[index]?.moves||[]).entries()){
    if(!move||move.disabled||move.pp===0)continue;
    const data=champions.moves.get(move.id||move.move||''),target=move.target;
    const damage=data.exists&&['Physical','Special'].includes(data.category);
    const friendly=target==='self'||target==='adjacentAlly'||target==='adjacentAllyOrSelf'||target==='allySide'||target==='allyTeam';
    const collateral=damage&&['allAdjacent','all','adjacentAlly','adjacentAllyOrSelf','self','allySide','allyTeam'].includes(target);
    // This ordering uses no power, damage, survival or Speed estimate. Last
    // resort moves remain available: a legal default can still be ineffective.
    const rank=!data.exists?7:collateral||data.selfdestruct||SACRIFICE.has(data.id)?6:
      damage&&CONDITIONAL.has(data.id)?3:damage?0:friendly?1:2;
    let targets=[undefined];
    if(TARGETED.has(target)){
      if(target==='adjacentAlly')targets=[-(2-index)];
      else if(target==='adjacentAllyOrSelf')targets=[-(index+1),-(2-index)];
      else targets=foeSlots;
    }
    for(const chosenTarget of targets){
      const allyIndex=chosenTarget<0?-chosenTarget-1:null;
      const absentAlly=allyIndex!==null&&allyIndex!==index&&(!request.side?.pokemon?.[allyIndex]||fainted(request.side.pokemon[allyIndex]));
      if(absentAlly)continue;
      candidates.push({action:{type:'move',slot:moveIndex+1,...(chosenTarget===undefined?{}:{target:chosenTarget})},rank});
    }
  }
  // A switch can rescue a request with no usable moves. Its recipient is not
  // claimed safe against either opponent; trapped and duplicate checks remain
  // the existing validator's responsibility.
  for(const replacement of replacementOptions(request).filter(option=>option.forSlots.includes(index+1))){
    candidates.push({action:{type:'switch',...(replacement.pokemonId?{pokemonId:replacement.pokemonId}:{slot:replacement.slot})},rank:4});
  }
  return candidates.sort((a,b)=>a.rank-b.rank);
}

/**
 * Produce a deterministic legal default, never a strategic or numerical claim.
 * The caller supplies occupied opposing slots only when verified; omitted
 * context conservatively retains both possible slots. No I/O, Mega or mutation.
 * The current request is revalidated by the caller again at eventual send time.
 */
export function selectEmergencyActions(request,{foeSlots=[1,2]}={}){
  if(!request||request.wait)return null;
  if(request.teamPreview){
    const count=request.maxChosenTeamSize||request.maxTeamSize||4;
    if(!Number.isInteger(count)||count<1||count>(request.side?.pokemon?.length||0))return null;
    return canonical(request,[{type:'team',order:Array.from({length:count},(_,index)=>index+1)}]);
  }
  if(request.forceSwitch){
    for(const pair of legalReplacementPairs(request)){
      const result=canonical(request,pair);if(result)return result;
    }
    return null;
  }
  if(!Array.isArray(request.active)||request.active.length!==2)return null;
  if(!Array.isArray(foeSlots))return null;
  const foes=[...new Set(foeSlots.filter(slot=>slot===1||slot===2))];
  const slots=[0,1].map(index=>moveCandidates(request,index,foes));
  // Compare both slots' preference classes before request-order tie breaking,
  // so a first-slot tie cannot force an avoidable risky second-slot action.
  const pairs=[];
  for(const first of slots[0])for(const second of slots[1])pairs.push({actions:[first.action,second.action],worst:Math.max(first.rank,second.rank),total:first.rank+second.rank});
  pairs.sort((a,b)=>a.worst-b.worst||a.total-b.total);
  for(const pair of pairs){const result=canonical(request,pair.actions);if(result)return result;}
  return null;
}
