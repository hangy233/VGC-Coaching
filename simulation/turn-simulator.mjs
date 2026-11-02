// Isolated one-turn resolution by the pinned native Champions engine. No socket,
// authentication, control client, independent damage formula or default choice.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {simulationCoreSchema,simulationBatchCoreSchema} from './schemas.mjs';
import {nativeHistoryRequirements} from './move-support.mjs';
import {hydrateNativeExtras} from './native-state.mjs';
export {statPointsSchema,pokemonSnapshotSchema,positionSchema,deliveryObjectiveSchema,deliveryGateSchema,branchSchema,simulationCoreSchema,simulationCaseSchema,simulationBatchCoreSchema} from './schemas.mjs';
import {validateChoice,replacementOptions} from '../showdown/choice-validation.mjs';
import {timingSpan,timingEvent,currentTimingContext,timingImport} from '../observability/timing.mjs';
const require=createRequire(import.meta.url);
const {Battle,Dex,TeamValidator}=require('pokemon-showdown');
const {extractChannelMessages}=require('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',dex=Dex.forFormat(FORMAT),toID=value=>dex.toID(value);
const PIN='a5df8274e85b0889bf2a9b3422a08b39732374fc';
const MODULE_SHA=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const stats=['hp','atk','def','spa','spd','spe'],stages=['atk','def','spa','spd','spe','accuracy','evasion'];
const check=(ok,message)=>{if(!ok)throw new Error(message);};
function validatePosition(position){
  check(new Set(position.sides.map(side=>side.id)).size===2,'Exactly one p1 and p2 side are required');
  const ids=position.sides.flatMap(side=>side.pokemon.map(pokemon=>pokemon.id));check(new Set(ids).size===8,'Snapshot Pokemon IDs must be globally unique');
  for(const side of position.sides){
    check(new Set(side.active).size===2 && side.active.every(value=>side.pokemon.some(pokemon=>pokemon.id===value)),'Two explicit selected active identities required');
    const bases=new Set(),items=new Set();
    for(const pokemon of side.pokemon){
      const species=dex.species.get(pokemon.species),ability=dex.abilities.get(pokemon.ability),item=pokemon.item?dex.items.get(pokemon.item):null;
      check(species.exists && dex.natures.get(pokemon.nature).exists && ability.exists && (!item || item.exists),'Unknown native species/nature/ability/item');
      if(position.mode==='opening')check(Object.values(species.abilities).some(value=>toID(value)===ability.id),'Opening ability must match its registered species');
      if(position.mode==='opening'){check(!bases.has(species.baseSpecies),'Species Clause violation');bases.add(species.baseSpecies);if(item){check(!items.has(item.id),'Item Clause violation');items.add(item.id);}}
      check(pokemon.moves.every(move=>dex.moves.get(move).exists),'Known native moves required');
      const legal={name:'Simulation',species:species.isMega?species.baseSpecies:species.name,ability:species.isMega?Object.values(dex.species.get(species.baseSpecies).abilities)[0]:ability.name,item:pokemon.item,nature:pokemon.nature,moves:pokemon.moves,evs:pokemon.statPoints,ivs:Object.fromEntries(stats.map(stat=>[stat,31])),level:50};
      if(position.mode==='opening'){const problems=new TeamValidator(FORMAT).validateSet(legal,{});check(!problems?.length,'Native M-C set validation failed: '+problems?.join('; '));}
      if(position.mode==='opening'){
        check(!species.isMega,'Opening reconstruction requires the base form before authored Mega Evolution');
        check((pokemon.hp===undefined || pokemon.hp==='full') && (!pokemon.status) && (!pokemon.boosts || Object.values(pokemon.boosts).every(value=>value===0)) && pokemon.pp===undefined && pokemon.lifecycle===undefined && (!pokemon.volatiles || !Object.keys(pokemon.volatiles).length),'Opening reconstruction requires pristine pre-entry sets');
      }else{
        if(['observed-high','observed-low'].includes(pokemon.hp))check(side.id!==position.ownSide&&pokemon.observedHp?.precision==='server-display',`${pokemon.hp} HP requires an actual observed opposing server-display bucket`);
        check(pokemon.hp!==undefined && pokemon.status!==undefined && pokemon.boosts && pokemon.pp && pokemon.lifecycle && pokemon.volatiles,'Current snapshots require exact HP/status/boosts/PP/lifecycle/volatile state');
        check(pokemon.pp.length===pokemon.moves.length,'Current PP must match the native move-slot identities');
        // Presence is explicit history, not inferred from an empty item. A native
        // Unburden volatile may survive item reacquisition while its boost is off.
        if(Object.hasOwn(pokemon.lifecycle,'unburdenVolatile'))check(ability.id==='unburden'&&(!pokemon.lifecycle.unburdenVolatile||side.active.includes(pokemon.id)&&pokemon.hp!==0),'Unburden volatile requires its current native ability and a live active recipient');
        if(pokemon.volatiles.confusion)check(side.active.includes(pokemon.id)&&pokemon.hp!==0,'Current confusion requires a live active recipient');
        if(pokemon.lifecycle.choiceLock)check(pokemon.moves.some(move=>toID(move)===toID(pokemon.lifecycle.choiceLock)) && item?.isChoice,'Choice lock requires a matching move and current Choice item');
        if(pokemon.lifecycle.lastMove)check(dex.moves.get(pokemon.lifecycle.lastMove).exists,'Last move must be a known native historical move');
        if(pokemon.volatiles.healblock)check(ids.includes(pokemon.volatiles.healblock.sourceId),'Heal Block requires a modeled source identity');
        if(pokemon.volatiles.encore){const move=toID(pokemon.volatiles.encore.move),index=pokemon.moves.findIndex(value=>toID(value)===move);
          check(side.active.includes(pokemon.id)&&pokemon.hp!==0&&index>=0&&pokemon.pp[index]>0&&toID(pokemon.lifecycle.lastMove)===move&&!dex.moves.get(move).flags.failencore&&item?.id!=='mentalherb','Current Encore requires an active target, registered locked lastMove and positive exact PP; a held Mental Herb cannot retain this lock');}
      }
    }
    if(position.mode==='current'){
      check(typeof side.megaUsed==='boolean','Current snapshots require explicit per-side Mega-use history');
      const alive=pokemon=>pokemon.hp==='full'||['observed-high','observed-low'].includes(pokemon.hp)&&pokemon.observedHp.current>0||typeof pokemon.hp==='number'&&pokemon.hp>0;
      const active=side.active.map(id=>side.pokemon.find(p=>p.id===id)),empty=active.filter(p=>!alive(p));
      check(!empty.length||empty.length===1&&empty[0].hp===0&&active.some(alive)&&side.pokemon.filter(p=>!side.active.includes(p.id)).every(p=>p.hp===0),'Current fainted active requires a lone survivor and no healthy bench replacement');
    }
  }
  if(position.mode==='opening')check(position.turn===1 && !Object.keys(position.field??{}).length && position.sides.every(side=>!side.megaUsed&&!Object.keys(side.conditions??{}).length),'Opening field and unspent Mega resource must arise only from genuine entry effects');
}
function snapshot(battle,ids){
  return {turn:battle.turn,ended:battle.ended,winner:battle.winner||null,requestState:battle.requestState,midTurn:battle.midTurn,
    sides:battle.sides.map(side=>({id:side.id,active:side.active.map(pokemon=>pokemon?ids.get(pokemon):null),conditions:Object.fromEntries(Object.entries(side.sideConditions).map(([key,value])=>[key,key==='toxicspikes'?{layers:value.layers}:{remainingTurns:value.duration??null}])),pokemon:side.pokemon.map(pokemon=>({id:ids.get(pokemon),species:pokemon.species.name,ability:pokemon.getAbility().name,item:pokemon.item,hp:pokemon.hp,maxhp:pokemon.maxhp,status:pokemon.status,boosts:{...pokemon.boosts},fainted:pokemon.fainted,active:pokemon.isActive,canMegaEvo:!!pokemon.canMegaEvo,pp:pokemon.moveSlots.map(move=>move.pp),lifecycle:{activeTurns:pokemon.activeTurns,activeMoveActions:pokemon.activeMoveActions,protectCounter:pokemon.volatiles.stall?.counter??0,choiceLock:pokemon.volatiles.choicelock?.move??false,lastMove:pokemon.lastMove?.name??false,...(pokemon.getAbility().id==='unburden'?{unburdenVolatile:!!pokemon.volatiles.unburden}:{})},volatiles:Object.fromEntries(Object.entries(pokemon.volatiles).map(([key,value])=>[key,{remainingTurns:value.duration??null,...(['choicelock','encore'].includes(key)?{move:value.move}:{}),...(key==='stall'?{counter:value.counter}:{}),...(key==='confusion'?{remainingActions:value.time}:{})}]))}))})),
    field:{weather:battle.field.weather,weatherRemaining:battle.field.weatherState.duration??null,terrain:battle.field.terrain,terrainRemaining:battle.field.terrainState.duration??null,pseudoWeather:Object.fromEntries(Object.entries(battle.field.pseudoWeather).map(([key,value])=>[key,{remainingTurns:value.duration??null}]))}};
}
function mountCurrent(battle,position,ids){
  const hpHypotheses=[];
  battle.queue.clear();battle.clearRequest();battle.midTurn=false;battle.turn=position.turn;
  for(const sideInput of position.sides){const side=battle[sideInput.id];
    for(const pokemon of side.pokemon){pokemon.isActive=false;pokemon.isStarted=false;}
    const ordered=[...sideInput.active,...sideInput.pokemon.map(pokemon=>pokemon.id).filter(value=>!sideInput.active.includes(value))];
    side.pokemon=ordered.map(value=>side.pokemon.find(pokemon=>ids.get(pokemon)===value));
    side.active=[side.pokemon[0],side.pokemon[1]];
    for(const [index,pokemon] of side.pokemon.entries()){
      const input=sideInput.pokemon.find(entry=>entry.id===ids.get(pokemon));pokemon.position=index;pokemon.isActive=index<2;pokemon.isStarted=index<2;
      if(['observed-high','observed-low'].includes(input.hp)){
        const compatible=[];
        for(let candidate=0;candidate<=pokemon.maxhp;candidate++){pokemon.hp=candidate;const match=/^(\d+)(?:\/(\d+))?/.exec(pokemon.getHealth().shared);if(match&&Number(match[1])===input.observedHp.current&&(match[2]?Number(match[2])===input.observedHp.max:input.observedHp.current===0&&input.observedHp.max===null))compatible.push(candidate);}
        check(compatible.length>0,'No native HP candidate is compatible with the actual observed public bucket');pokemon.hp=input.hp==='observed-low'?compatible[0]:compatible.at(-1);
        hpHypotheses.push({id:input.id,directive:input.hp,observedHp:input.observedHp,minCompatibleHp:compatible[0],maxCompatibleHp:compatible.at(-1),compatibleCount:compatible.length,selectedHp:pokemon.hp,nativeMaxHp:pokemon.maxhp,limitation:`${input.hp==='observed-low'?'Lower':'Upper'} compatible public-display HP candidate under the supplied stat hypothesis. Hidden exact HP is unknown; this is not globally conservative or safe. Endpoints do not cover every threshold.`});
      }else pokemon.hp=input.hp==='full'?pokemon.maxhp:input.hp;
      check(pokemon.hp<=pokemon.maxhp,'Current HP exceeds native maxHP');pokemon.fainted=pokemon.hp===0;pokemon.faintQueued=false;
      pokemon.status=input.status;pokemon.statusState=battle.initEffectState({id:input.status,target:pokemon});pokemon.boosts={...input.boosts};
      if(input.observedHp){
        const rendered=pokemon.getHealth()[input.observedHp.precision==='server-own-exact'?'secret':'shared'],match=/^(\d+)(?:\/(\d+))?/.exec(rendered);
        check(match && Number(match[1])===input.observedHp.current && (match[2]?Number(match[2])===input.observedHp.max:input.observedHp.current===0&&input.observedHp.max===null),'Candidate native HP contradicts the observed native HP rendering');
      }
      pokemon.activeTurns=input.lifecycle.activeTurns;pokemon.activeMoveActions=input.lifecycle.activeMoveActions;pokemon.lastMove=input.lifecycle.lastMove?dex.moves.get(input.lifecycle.lastMove):null;pokemon.lastMoveEncore=pokemon.lastMove;pokemon.lastMoveUsed=pokemon.lastMove;
      // Native nextTurn clears this before every fresh move request. A fresh
      // constructor's entry flag must not let late Helping Hand succeed after
      // Encore rewrites its priority behind an already-completed partner.
      pokemon.newlySwitched=index>=2;
      pokemon.volatiles={};
      if(input.lifecycle.unburdenVolatile)pokemon.volatiles.unburden=battle.initEffectState({id:'unburden',target:pokemon});
      if(input.lifecycle.choiceLock)pokemon.volatiles.choicelock=battle.initEffectState({id:'choicelock',target:pokemon,move:toID(input.lifecycle.choiceLock)});
      if(input.lifecycle.protectCounter)pokemon.volatiles.stall=battle.initEffectState({id:'stall',target:pokemon,counter:input.lifecycle.protectCounter,duration:1});
      if(input.volatiles.healblock)pokemon.volatiles.healblock=battle.initEffectState({id:'healblock',target:pokemon,duration:input.volatiles.healblock.remainingTurns,source:battle.getAllPokemon().find(entry=>ids.get(entry)===input.volatiles.healblock.sourceId),sourceEffect:dex.moves.get('psychicnoise')});
      if(input.volatiles.encore)pokemon.volatiles.encore=battle.initEffectState({id:'encore',target:pokemon,duration:input.volatiles.encore.remainingTurns,move:toID(input.volatiles.encore.move)});
      if(input.volatiles.confusion)pokemon.volatiles.confusion=battle.initEffectState({id:'confusion',target:pokemon,time:input.volatiles.confusion.remainingActions});
      pokemon.moveSlots.forEach((move,index)=>{check(input.pp[index]<=move.maxpp,'Current PP exceeds native maxPP');move.pp=input.pp[index];});
      if(sideInput.megaUsed){pokemon.canMegaEvo=false;pokemon.canMegaEvoX=false;pokemon.canMegaEvoY=false;}
    }
    side.pokemonLeft=side.pokemon.filter(pokemon=>!pokemon.fainted).length;
    side.sideConditions={};for(const [key,value] of Object.entries(sideInput.conditions??{}))side.sideConditions[key]=battle.initEffectState({id:key,target:side,...(key==='toxicspikes'?{layers:value.layers}:{duration:value.remainingTurns})});
  }
  const field=position.field??{};
  battle.field.weather=field.weather?.id??'';battle.field.weatherState=battle.initEffectState({id:battle.field.weather,...(field.weather?{duration:field.weather.remainingTurns}:{})});
  battle.field.terrain=field.terrain?.id??'';battle.field.terrainState=battle.initEffectState({id:battle.field.terrain,...(field.terrain?{duration:field.terrain.remainingTurns}:{})});
  battle.field.pseudoWeather=field.trickRoom?{trickroom:battle.initEffectState({id:'trickroom',duration:field.trickRoom.remainingTurns})}:{};
  const state=hydrateNativeExtras({battle,position,ids,dex});
  // Native endTurn normally prepares these restrictions before makeRequest.
  // Mount only the request preparation, without advancing lifecycle or entry.
  for(const pokemon of battle.getAllActive()){
    pokemon.trapped=false;battle.runEvent('TrapPokemon',pokemon);
    battle.runEvent('DisableMove',pokemon);
    for(const moveSlot of pokemon.moveSlots)battle.singleEvent('DisableMove',dex.moves.get(moveSlot.id),null,pokemon);
  }
  battle.makeRequest('move');
  return {hpHypotheses,...state};
}
function prepareTeams(position){
  return Object.fromEntries(position.sides.map(side=>[side.id,side.pokemon.map((pokemon,index)=>({name:`sim-${side.id}-${index}`,species:pokemon.species,nature:pokemon.nature,ability:pokemon.ability,item:pokemon.item,moves:pokemon.moves,evs:pokemon.statPoints,ivs:Object.fromEntries(stats.map(stat=>[stat,31])),level:50}))]));
}
function prepareBattle(position,seed,preparedTeams){
  const sideInputs=Object.fromEntries(position.sides.map(side=>[side.id,side]));
  // Battle construction owns mutable sets; never reuse its mutated input team.
  const teams=structuredClone(preparedTeams??prepareTeams(position));
  const battle=new Battle({formatid:FORMAT,seed,p1:{name:'Sim p1',team:teams.p1},p2:{name:'Sim p2',team:teams.p2}});
  const ids=new Map();for(const side of battle.sides)side.pokemon.forEach((pokemon,index)=>ids.set(pokemon,sideInputs[side.id].pokemon[index].id));
  let hpHypotheses=[],stateAssumptions=structuredClone(position.stateAssumptions??[]),initializationEvents=[];if(position.mode==='opening'){
    for(const side of battle.sides){const input=sideInputs[side.id],order=[...input.active,...input.pokemon.map(pokemon=>pokemon.id).filter(value=>!input.active.includes(value))].map(value=>input.pokemon.findIndex(pokemon=>pokemon.id===value)+1);check(battle.choose(side.id,'team '+order.join('')),'Native opening selection rejected');}
  }else {const state=mountCurrent(battle,position,ids);hpHypotheses=state.hpHypotheses;stateAssumptions=state.assumptions;initializationEvents=eventsFrom(battle.log.slice(state.initializationLogStart),battle,ids);}
  check(battle.turn===position.turn && battle.requestState==='move','Expected a fresh native start-of-turn move request');
  return {battle,ids,hpHypotheses,stateAssumptions,initializationEvents};
}
function compiledChoice(battle,sideInput,actions,ids,{replacement=false}={}){
  const side=battle[sideInput.id],request=side.activeRequest;
  check(request&&!request.wait&&(replacement?!!request.forceSwitch:!request.forceSwitch),replacement?'No native replacement request':'No full start-of-turn native request');
  const translated=actions.map((action,index)=>{
    if(action.type==='move'&&action.sourceMoveId){
      const matches=(request.active?.[index]?.moves??[]).flatMap((move,slot)=>toID(move.id??move.move)===toID(action.sourceMoveId)?[slot+1]:[]);
      check(matches.length===1,'Source-clicked move identity is unavailable or ambiguous in this native world');
      const {sourceMoveId,...bound}=action;return {...bound,slot:matches[0]};
    }
    if(action.type!=='switch' || !action.pokemonId)return action;
    const matches=side.pokemon.flatMap((pokemon,index)=>{const input=sideInput.pokemon.find(entry=>entry.id===ids.get(pokemon));return input.id===action.pokemonId || input.controlPokemonId===action.pokemonId?[index+1]:[];});check(matches.length===1,'Unknown or ambiguous authored switch identity');return {type:'switch',slot:matches[0]};
  });
  try{return validateChoice(request,translated);}
  catch(error){
    if(!(error instanceof Error))throw error;
    // Describe the actual compiled native menu, never an input nickname,
    // source token or a guessed correction. Both slots remain visible because
    // validateChoice does not identify which member of the pair it rejected.
    const name=value=>String(value??'unavailable').replace(/[^\p{L}\p{N} .,'’():%-]/gu,'?').slice(0,48);
    const choices=translated.map((action,index)=>{
      const actor=side.active[index],species=actor?.species?.id?dex.species.get(actor.species.id).name:'unavailable';
      if(action.type!=='move')return `${side.id}${index===0?'a':'b'} ${name(species)} ${action.type}${action.slot===undefined?'':`[${action.slot}]`}`;
      const selected=request.active?.[index]?.moves?.[action.slot-1],move=selected?dex.moves.get(selected.id??selected.move).name:'unavailable',
        target=typeof selected?.target==='string'&&/^[A-Za-z]{1,32}$/u.test(selected.target)?selected.target:'unset';
      return `${side.id}${index===0?'a':'b'} ${name(species)} move[${action.slot}]=${name(move)} menuTarget=${target} providedTarget=${action.target??'unset'}`;
    });
    error.message=`${error.message.replace(/[\u0000-\u001f\u007f]/gu,' ').slice(0,200)} [native choices: ${choices.join('; ')}]`;
    throw error;
  }
}
function replacementRequest(battle,ids){
  if(battle.requestState!=='switch')return null;
  return {kind:'native-replacement-required',sides:battle.sides.filter(side=>side.activeRequest?.forceSwitch&&!side.activeRequest.wait).map(side=>({
    sideId:side.id,forceSwitch:[...side.activeRequest.forceSwitch],
    outgoing:side.active.map(pokemon=>({pokemonId:ids.get(pokemon),fainted:pokemon.fainted,hp:pokemon.hp})),
    options:replacementOptions(side.activeRequest).map(option=>({slot:option.slot,pokemonId:ids.get(side.pokemon[option.slot-1]),forSlots:option.forSlots})),
  }))};
}
function eventsFrom(lines,battle,ids){
  const names=new Map(battle.getAllPokemon().map(pokemon=>[pokemon.name,ids.get(pokemon)]));
  const actor=value=>names.get(String(value??'').replace(/^p[12][a-z]?:\s*/,''))??null;
  // Native omniscient channel selects one exact-HP line from every split pair;
  // private/public duplicate damage lines must never be counted as two hits.
  return extractChannelMessages(lines.join('\n'),[-1])[-1].map((line,index)=>{const parts=line.split('|'),source=parts.find(part=>part.startsWith('[of] '));return {index,type:parts[1]??'',actorId:actor(parts[2]),targetId:actor(parts[4]),...(source?{sourceId:actor(source.slice(5))}:{}),...(parts[1]==='move'?{move:parts[3]}:{}),raw:line};});
}
const isDenied=event=>['cant','-fail','-miss','-immune','-block'].includes(event.type)||event.type==='-damage'&&event.raw.split('|').includes('[from] confusion')||event.type==='-activate'&&/Protect|Wide Guard|Quick Guard|Mat Block|Crafty Shield|King.s Shield|Spiky Shield|Baneful Bunker|Obstruct|Silk Trap|Burning Bulwark/.test(event.raw);
function deliveryFacts(gate,{actionOutcomes,start,final,events,boundary,pendingActions}){
  const pokemon=id=>final.sides.flatMap(side=>side.pokemon).find(pokemon=>pokemon.id===id);
  const requiredActions=gate.requiredActionsBy.map(id=>{
    const outcome=actionOutcomes.find(outcome=>outcome.id===id),resolved=outcome?.resolution,actor=pokemon(id);
    let status='unknown',reason='No completed native action proves an effect';
    if(outcome?.pendingAtBoundary)reason='Required action remains pending at the first replacement boundary';
    else if(outcome?.faintedBeforeAction){status='failed';reason='Actor fainted before its authored action';}
    else if(outcome?.authored.type==='switch'){
      const entrant=pokemon(resolved?.entrantId),entry=events.find(event=>event.type==='switch'&&event.actorId===resolved?.entrantId);
      if(resolved&&entry&&!actor?.active&&!actor?.fainted&&entrant?.active&&!entrant?.fainted&&entrant.hp>0){status='passed';reason='Original actor departed and the authored entrant is alive on field';}
      else if(resolved&&(!actor||actor.fainted||!entrant||entrant.fainted)){status='failed';reason='Original actor or authored entrant did not survive the switch';}
    }else if(outcome?.authored.type==='move'){
      if(resolved?.denials.length||resolved?.nativeMoveResult===false){status='failed';reason='Native action was denied or failed';}
      else if(outcome.attemptedMove&&resolved?.nativeMoveResult===true){status='passed';reason='Native move resolved an effect without an observed denial';}
    }
    return {id,authored:outcome?.authored??null,attemptedMove:outcome?.attemptedMove??null,nativeMoveResult:resolved?.nativeMoveResult??null,denials:resolved?.denials??outcome?.denied??[],pendingAtBoundary:!!outcome?.pendingAtBoundary,aliveAtBoundary:!!actor&&!actor.fainted&&actor.hp>0,status,reason,...(resolved?.entrantId?{entrantId:resolved.entrantId}:{}),effectEvents:resolved?.events.filter(event=>!['move','debug','hint',''].includes(event.type))??[]};
  });
  const survive=(gate.survive??[]).map(id=>{const actor=pokemon(id),alive=!!actor&&!actor.fainted&&actor.hp>0;return {id,aliveAtBoundary:alive,activeAtBoundary:actor?.active??false,status:!alive?'failed':boundary==='next-turn'||boundary==='battle-ended'?'passed':'unknown',reason:!alive?'Actor is fainted at the native boundary':boundary==='forced-replacement'?'Alive now; the unauthored replacement boundary does not prove later residual survival':'Alive at the completed native turn boundary'};});
  const field=Object.entries(gate.field??{}).map(([name,expected])=>{
    const value=state=>name==='trickRoom'?!!state.field.pseudoWeather.trickroom:state.field[name],actual=value(final),initial=value(start),matched=actual===expected;
    const fieldEvent=event=>name==='trickRoom'?event.type===(expected?'-fieldstart':'-fieldend')&&event.raw.split('|')[2]==='move: Trick Room':name==='weather'?event.type==='-weather'&&toID(event.raw.split('|')[2])===expected&&!event.raw.includes('[upkeep]'):event.type==='-fieldstart'&&toID(event.raw.split('|')[2].replace(/^move: /,''))===expected;
    const supporting=requiredActions.filter(action=>action.status==='passed').flatMap(action=>{
      const outcome=actionOutcomes.find(outcome=>outcome.id===action.id);
      return [...(outcome?.resolution?.events??[]).filter(fieldEvent),...events.filter(event=>fieldEvent(event)&&event.sourceId===(action.entrantId??action.id))];
    });
    const status=!matched?'failed':!supporting.length?'unknown':boundary==='forced-replacement'?'unknown':'passed';
    return {name,expected,actual,initial,matchedAtBoundary:matched,establishedByRequiredAction:supporting.length>0,status,evidence:supporting,reason:!matched?'Requested field state is absent at the native boundary':!supporting.length?'Matching field state alone does not prove that a required action established it':boundary==='forced-replacement'?'Field is observed before an unauthored replacement; later expiry is unchecked':'Required action established the field state and it remains at the completed boundary'};
  });
  const unknown=requiredActions.some(goal=>goal.status==='unknown')||survive.some(goal=>goal.status==='unknown')||field.some(goal=>goal.status==='unknown');
  return {...gate,requiredActions,surviveGoals:survive,fieldGoals:field,unresolved:unknown,passed:pendingActions.length===0&&[...requiredActions,...survive,...field].every(goal=>goal.status==='passed'),sampleOnly:true};
}
export function collectRandomOrderEvents(events){
  // These native fractional-priority activations use randomChance. Other order
  // effects, such as Custap Berry at its HP threshold, are deterministic.
  return events.filter(event=>event.type==='-activate'&&['item: Quick Claw','ability: Quick Draw'].includes(String(event.raw??'').split('|')[3]));
}
function deterministicStaminaBoost(event,previous){
  if(event.type!=='-boost'||typeof event.actorId!=='string'||!event.actorId)return false;
  const parts=String(event.raw??'').split('|');
  if(parts[1]!=='-boost'||parts[3]!=='def'||parts[4]!=='1')return false;
  // The pinned native boost() emits Ability provenance on its own immediately
  // preceding line. Bind that exact activation to this actor and single boost;
  // never carry it across an intervening event, another stat, or another actor.
  const before=String(previous?.raw??'').split('|');
  return parts.length===6&&parts[5]==='[from] ability: Stamina'||parts.length===5&&previous?.type==='-ability'&&previous.actorId===event.actorId&&
    Number.isInteger(event.index)&&previous.index===event.index-1&&before.length===5&&before[1]==='-ability'&&before[2]===parts[2]&&before[3]==='Stamina'&&before[4]==='boost';
}
/** Conservative native effect flags, excluding only exactly sourced Stamina. */
export function collectPotentialSecondaryEvents(events){
  return events.filter((event,index)=>['-status','-curestatus'].includes(event.type)||event.type==='-start'&&!event.raw.includes('Heal Block')||
    event.type==='-activate'&&event.raw.split('|')[3]==='confusion'||
    ['-boost','-unboost'].includes(event.type)&&!deterministicStaminaBoost(event,events[index-1]));
}
function branchStateCoverage(position,branch,battle,ids,assumptions){
  const result=structuredClone(assumptions),diagnostics=[];
  const add=(path,reason,selected)=>{if(!result.some(row=>row.path===path))result.push({path,reason,selected:selected??null,origin:'unobserved-native-history'});};
  if(position.mode==='current')for(const side of position.sides){
    const actions=side.id===position.ownSide?branch.ourActions:branch.opposingActions;
    actions.forEach((action,index)=>{if(action.type!=='move')return;const input=side.pokemon.find(p=>p.id===side.active[index]),p=battle[side.id].pokemon.find(p=>ids.get(p)===input.id),nativeMenu=battle[side.id].activeRequest?.active?.[index]?.moves,selected=nativeMenu?.[action.slot-1],move=dex.moves.get(selected?.id??selected?.move??input.moves[action.slot-1]);
      for(const field of nativeHistoryRequirements(move)){
        if(field==='native.callback-history'){diagnostics.push({actorId:input.id,move:move.name,field,scope:'Native callback execution is allowed; dependency inspection is not exhaustive.'});continue;}
        if(field==='side.totalFainted'&&side.nativeState?.totalFainted===undefined)add(`${side.id}.totalFainted`,'Historical faint count is not supplied. Currently fainted selected members are only a lower-bound starting hypothesis; repeated faint/revival history may differ.',battle[side.id].totalFainted);
        if(field.startsWith('pokemon.')){const key=field.slice(8);if(input.nativeState?.[key]===undefined)add(`${side.id}.${input.id}.${key}`,'Native historical counter/result is not supplied; the mounted native value is a conditional hypothesis.',p[key]);}
        if(field==='battle.lastMove'&&position.nativeState?.lastMove===undefined)add('battle.lastMove','Global previous move history is not supplied; the native initialized value is a hypothesis.',battle.lastMove?.id??null);
      }
    });
  }
  return {complete:result.length===0,approximate:result.length>0,assumptions:result,diagnostics,scope:'Coverage of supplied current-state fields and explicit assumptions, not exhaustive proof of every native internal field or unknown opposing investment.'};
}
function runSample(position,branch,seed,preparedTeams){
  const {battle,ids,hpHypotheses,stateAssumptions,initializationEvents}=timingSpan('simulation.reconstruction',{stage:'native-battle',mode:position.mode}).run(()=>prepareBattle(position,seed,preparedTeams));
  try{
    const our=position.sides.find(side=>side.id===position.ownSide),foe=position.sides.find(side=>side.id!==position.ownSide);
    const choices=timingSpan('simulation.validation',{stage:'native-choices'}).run(()=>({[our.id]:compiledChoice(battle,our,branch.ourActions,ids),[foe.id]:compiledChoice(battle,foe,branch.opposingActions,ids)}));
    const stateCoverage=branchStateCoverage(position,{ourActions:choices[our.id].actions,opposingActions:choices[foe.id].actions},battle,ids,stateAssumptions);
    const start=snapshot(battle,ids),openingEvents=position.mode==='opening'?eventsFrom(battle.log,battle,ids):[];
    const before=battle.log.length,accepted={},possibleTies=new Set(),resolutions=[];
    const run=battle.runAction.bind(battle);
    battle.runAction=action=>{
      const logStart=battle.log.length,value=run(action),pending=battle.queue.list.filter(entry=>entry.choice==='move'&&entry.pokemon?.hp>0);
      if(['move','switch','instaswitch'].includes(action.choice)){
        const actionEvents=eventsFrom(battle.log.slice(logStart),battle,ids);
        resolutions.push({id:ids.get(action.pokemon),kind:action.choice,nativeMoveResult:action.choice==='move'?action.pokemon.moveThisTurnResult??null:null,...(action.target&&action.choice!=='move'?{entrantId:ids.get(action.target)}:{}),events:actionEvents,denials:actionEvents.filter(isDenied)});
      }
      for(let a=0;a<pending.length;a++)for(let b=a+1;b<pending.length;b++)if(pending[a].priority===pending[b].priority&&pending[a].speed===pending[b].speed)possibleTies.add([ids.get(pending[a].pokemon),ids.get(pending[b].pokemon)].sort().join('/'));
      return value;
    };
    const replacementDecisions=[];
    timingSpan('simulation.native_engine').run(()=>{
      for(const sideId of ['p1','p2']){const canonical=choices[sideId].choice;check(!/(?:^|,)\s*(?:default|auto)\b/.test(canonical),'Default choices forbidden');const ok=battle.choose(sideId,canonical);accepted[sideId]={accepted:ok,canonical,actions:choices[sideId].actions};check(ok,'Native paired choice rejected: '+battle[sideId].choice.error);}
      // Continue the same native battle/queue/RNG only with explicit authored
      // replacement pairs. No default entrant, tactical guess or replayed move.
      for(const [index,step]of (branch.continuations??[]).entries()){
        if(battle.ended||battle.requestState!=='switch'||battle.turn!==position.turn)break;
        const request=replacementRequest(battle,ids),provided={[our.id]:step.ourActions,[foe.id]:step.opposingActions},compiled={};
        for(const sideId of ['p1','p2']){
          const required=request.sides.some(side=>side.sideId===sideId);
          check(required===(provided[sideId]!==undefined),'Continuation must cover exactly the native requesting sides');
          if(required)compiled[sideId]=compiledChoice(battle,position.sides.find(side=>side.id===sideId),provided[sideId],ids,{replacement:true});
        }
        const decisions={index,request,accepted:{}};
        for(const sideId of ['p1','p2'])if(compiled[sideId]){
          const choice=compiled[sideId],ok=battle.choose(sideId,choice.choice);
          decisions.accepted[sideId]={accepted:ok,canonical:choice.choice,actions:choice.actions};
          check(ok,'Native continuation rejected: '+battle[sideId].choice.error);
        }
        replacementDecisions.push(decisions);
      }
    });
    return timingSpan('simulation.outcome_processing').run(()=>{
    const events=eventsFrom(battle.log.slice(before),battle,ids),final=snapshot(battle,ids),boundary=battle.requestState==='switch'?'forced-replacement':battle.ended?'battle-ended':battle.turn===position.turn+1?'next-turn':'unsupported-boundary';
    check(boundary!=='unsupported-boundary','Native one-turn simulation reached an unsupported continuation');
    const moveBy=id=>events.find(event=>event.type==='move' && event.actorId===id),faintBy=id=>events.find(event=>event.type==='faint' && event.actorId===id);
    const targetFaint=faintBy(branch.gate.targetId),beforeActions=(branch.gate.beforeActionsOf??[]).map(id=>({id,actionIndex:moveBy(id)?.index??null,faintIndex:faintBy(id)?.index??null}));
    // A move log establishes an attempt. Denial may follow that log (Protect
    // failure, miss, immunity); it must not establish delivered protection.
    const denied=isDenied;
    const required=branch.gate.requiredActionsBy.map(id=>{const move=moveBy(id),next=events.find(event=>event.type==='move'&&event.index>(move?.index??Infinity));const denials=move?events.filter(event=>event.index>move.index&&event.index<(next?.index??Infinity)&&denied(event)):[];return {id,moveAttemptObserved:!!move,eventIndex:move?.index??null,denials,observedWithoutDenial:!!move&&!denials.length};});
    const unresolved=beforeActions.some(entry=>entry.actionIndex===null && entry.faintIndex===null);
    const targetKOBeforeRetaliation=!!targetFaint && !unresolved && beforeActions.every(entry=>entry.actionIndex===null || targetFaint.index<entry.actionIndex);
    const pendingActions=battle.queue.list.filter(action=>['move','switch','instaswitch'].includes(action.choice)).map(action=>({kind:action.choice,pokemonId:ids.get(action.pokemon)??null,move:action.move?.id??action.moveid??null}));
    const stochastic={criticalEvents:events.filter(event=>event.type==='-crit'),missEvents:events.filter(event=>event.type==='-miss'),actionDenialEvents:events.filter(event=>event.type==='cant'),potentialSecondaryEvents:collectPotentialSecondaryEvents(events),randomOrderEvents:collectRandomOrderEvents(events),possibleMoveOrderTies:[...possibleTies],sampleOnly:true};
    const clean=!stochastic.criticalEvents.length&&!stochastic.missEvents.length&&!stochastic.actionDenialEvents.length&&!stochastic.potentialSecondaryEvents.length&&!stochastic.randomOrderEvents.length&&!possibleTies.size;
    const pendingPhases=battle.queue.list.map(action=>action.choice),turnComplete=boundary==='next-turn'||boundary==='battle-ended',noPendingContinuation=turnComplete&&pendingActions.length===0;
    const actionOutcomes=position.sides.flatMap(side=>side.active.map((id,index)=>{const authored=(side.id===position.ownSide?branch.ourActions:branch.opposingActions)[index],resolution=resolutions.find(entry=>entry.id===id&&entry.kind===(authored.type==='move'?'move':'switch'));return {id,authored,attemptedMove:moveBy(id)?.move??null,denied:resolution?.denials??events.filter(event=>denied(event)&&event.actorId===id),faintedBeforeAction:!moveBy(id)&&!!faintBy(id),pendingAtBoundary:pendingActions.some(action=>action.pokemonId===id),...(resolution?{resolution}:{})};}));
    const gate=branch.gate.kind==='delivery'?{...deliveryFacts(branch.gate,{actionOutcomes,start,final,events,boundary,pendingActions}),cleanSample:clean}:{...branch.gate,targetFaintIndex:targetFaint?.index??null,beforeActions,requiredMoveAttempts:required,targetKOBeforeRetaliation,unresolved,passed:targetKOBeforeRetaliation && required.every(entry=>entry.observedWithoutDenial),cleanSample:clean};
    if(!stateCoverage.complete){gate.conditionalPassed=gate.passed;gate.passed=false;gate.unresolved=true;gate.stateAssumptionsPreventUnqualifiedPass=true;}
    return {branchId:branch.id,seed,accepted,start,openingEvents,initializationEvents,stateCoverage,events,eventView:'native omniscient exact HP within this conditional world; split duplicates removed',final,boundary,turnComplete,replacementRequest:replacementRequest(battle,ids),replacementDecisions,unusedContinuations:(branch.continuations?.length??0)-replacementDecisions.length,pendingActions,pendingPhases,noPendingContinuation,stochastic,hpHypotheses,actionOutcomes,gate};
    });
  }finally{battle.destroy();}
}
function validateScenarios(parsed){
  check(new Set(parsed.seeds.map(seed=>JSON.stringify(seed))).size===parsed.seeds.length,'Seeds must be explicit unique samples');
  check(new Set(parsed.branches.map(branch=>branch.id)).size===parsed.branches.length,'Branch IDs must be unique');
  const ours=parsed.position.sides.find(side=>side.id===parsed.position.ownSide),foes=parsed.position.sides.find(side=>side.id!==parsed.position.ownSide),ourIds=ours.pokemon.map(pokemon=>pokemon.id),foeIds=foes.pokemon.map(pokemon=>pokemon.id);
  for(const branch of parsed.branches){
    if(branch.gate.kind==='delivery'){
      check(new Set(branch.gate.requiredActionsBy).size===branch.gate.requiredActionsBy.length&&branch.gate.requiredActionsBy.every(id=>ours.active.includes(id)),'Delivery required actors must be unique own initial active IDs');
      check(new Set(branch.gate.survive??[]).size===(branch.gate.survive??[]).length&&(branch.gate.survive??[]).every(id=>ourIds.includes(id)),'Delivery survival goals must be unique own selected IDs');
    }else check(foeIds.includes(branch.gate.targetId)&&branch.gate.beforeActionsOf.every(id=>foeIds.includes(id))&&branch.gate.requiredActionsBy.every(id=>ourIds.includes(id)),'Removal gate target/retaliation must be opposing and required move attempts must be ours');
    if(parsed.position.mode==='current')for(const side of parsed.position.sides){const actions=side.id===parsed.position.ownSide?branch.ourActions:branch.opposingActions;
      for(const [index,action] of actions.entries()){
        if(side.pokemon.find(p=>p.id===side.active[index]).hp===0)check(action.type==='pass','A fainted active slot requires an explicitly authored pass');
      }
    }
  }
  return parsed;
}
function simulatePreparedTurn(parsed,preparedTeams){
  const samples=parsed.branches.flatMap(branch=>parsed.seeds.map(seed=>runSample(parsed.position,branch,seed,preparedTeams)));
  return {engine:{name:'pokemon-showdown native Champions M-C',format:FORMAT,gen:0,pinnedCommit:PIN,moduleSha256:MODULE_SHA},hypotheses:parsed.hypotheses,samples,
    summary:{branches:parsed.branches.length,seeds:parsed.seeds.length,samples:samples.length,allGatesPassed:samples.every(sample=>sample.gate.passed),allCleanSampleGatesPassed:samples.every(sample=>sample.gate.passed&&sample.gate.cleanSample&&sample.noPendingContinuation),completeStateReconstruction:samples.every(sample=>sample.stateCoverage.complete),approximateSamples:samples.filter(sample=>sample.stateCoverage.approximate).length,allTurnsComplete:samples.every(sample=>sample.turnComplete),completedTurnSamples:samples.filter(sample=>sample.turnComplete).length,forcedReplacementSamples:samples.filter(sample=>sample.boundary==='forced-replacement').length},
    limitations:['Explicit seeds are samples, not KO probabilities or guarantees. Unknown opposing investments/HP/reserves and field/history candidates remain hypotheses.','Checks at most one turn. Native replacement requests pause unless the branch supplies an explicit continuation covering exactly the requesting sides. No automatic choices are supplied. A paused boundary may establish an observed removal but does not prove pending actions, residuals, field expiry or later survival.','Individual numerical damage ranges and effective Speed claims still require actual calculate_damage/calculate_speed tools. A one-turn result does not establish a later endgame.']};
}

export function simulateNativeTurn(input){
  const parsed=timingSpan('simulation.validation',{stage:'native-position'}).run(()=>{
    const parsed=simulationCoreSchema.parse(input);validatePosition(parsed.position);return validateScenarios(parsed);
  });
  return simulatePreparedTurn(parsed,prepareTeams(parsed.position));
}

/** Independent explicit cases share validation and immutable team preparation.
 * Each seed still constructs a genuine isolated battle, preserving entry RNG,
 * counters, action order and the first native replacement boundary. */
export function simulateNativeTurnBatch(input){
  const parsed=timingSpan('simulation.validation',{stage:'native-batch-position'}).run(()=>{
    const parsed=simulationBatchCoreSchema.parse(input);validatePosition(parsed.position);
    check(new Set(parsed.cases.map(entry=>entry.id)).size===parsed.cases.length,'Batch case IDs must be unique');
    for(const entry of parsed.cases)validateScenarios({...entry,position:parsed.position,hypotheses:parsed.hypotheses});
    return parsed;
  });
  const preparedTeams=prepareTeams(parsed.position);
  return {cases:parsed.cases.map(entry=>({id:entry.id,result:simulatePreparedTurn({...entry,position:parsed.position,hypotheses:parsed.hypotheses},preparedTeams)})),batch:{cases:parsed.cases.length,samples:parsed.cases.reduce((sum,entry)=>sum+entry.branches.length*entry.seeds.length,0),normalizedPositions:1,nativeSampleIsolation:true,workerConcurrency:1}};
}

async function runWorkerSimulation(input,{timeoutMs=3500,workerFactory,signal,batch=false}={}){
  try{timingSpan('simulation.validation',{stage:'worker-input'}).run(()=>{(batch?simulationBatchCoreSchema:simulationCoreSchema).parse(input);check(Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=3500,'Simulation budget must be1-3500ms');check(!signal?.aborted,'Simulation cancelled before execution');});}
  catch(error){timingEvent('simulation.outcome',{outcome:signal?.aborted?'cancelled-before-worker':'refused-before-worker',workerCreated:false});throw error;}
  const roundtrip=timingSpan('simulation.worker_roundtrip');
  return roundtrip.run(()=>{
    const startup=timingSpan('simulation.worker_startup'),context=currentTimingContext();let worker;
    try{worker=workerFactory?workerFactory():new Worker(new URL('./turn-worker.mjs',import.meta.url),{workerData:batch?{input,mode:'batch',...(context?.traceId?{timingContext:context}:{})}:context?.traceId?{input,timingContext:context}:input});}
    catch(error){startup.end('error');timingEvent('simulation.outcome',{outcome:'worker-creation-error',workerCreated:false});throw error;}
    let timer,done=false,ready=false,coreStarted=false;
    return new Promise((resolve,reject)=>{
      const finish=(error,value,status='ok')=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.removeListener('message',message);startup.end(status,{readyObserved:ready});roundtrip.end(status,{readyObserved:ready,coreStarted});timingEvent('simulation.worker_outcome',{outcome:error?status:'completed',workerCreated:true,readyObserved:ready,coreStarted});worker.terminate();error?reject(error):resolve(value);};
      const abort=()=>finish(new Error('Simulation cancelled; no battle action sent'),undefined,'cancelled');
      const message=value=>{
        if(value?.type==='vgc-timing'){
          if(value.phase==='ready'){ready=true;startup.end('ok',{readyObserved:true});}
          else if(value.phase==='core-begin'){coreStarted=true;timingEvent('simulation.worker_core_begin');}
          return;
        }
        if(Array.isArray(value?.timing))timingImport(value.timing);
        value?.ok?finish(null,value.result):finish(new Error(value?.error??'Native turn simulation failed'),undefined,'error');
      };
      worker.on('message',message);
      worker.once('error',error=>finish(error,undefined,'error'));worker.once('exit',code=>{if(!done)finish(new Error('Simulation worker exited without a result: '+code),undefined,'error');});
      signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>finish(new Error('Bounded native simulation deadline exhausted'),undefined,'timeout'),timeoutMs);
      // Cover cancellation between the initial guard and listener attachment.
      if(signal?.aborted)abort();
    });
  });
}

export async function runTurnSimulation(input,options={}){return runWorkerSimulation(input,{...options,batch:false});}

/** One worker is the default. Optional concurrency is bounded to two actual
 * worker_threads and is experimental: startup can outweigh CPU parallelism. */
export async function runTurnSimulationBatch(input,{concurrency=1,timeoutMs=3500,signal,workerFactory}={}){
  const parsed=simulationBatchCoreSchema.parse(input);
  check([1,2].includes(concurrency),'Batch worker concurrency must be 1 or 2');
  check(new Set(parsed.cases.map(entry=>entry.id)).size===parsed.cases.length,'Batch case IDs must be unique');
  if(concurrency===1||parsed.cases.length===1)return runWorkerSimulation(parsed,{timeoutMs,signal,workerFactory,batch:true});
  check(Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=3500,'Simulation budget must be1-3500ms');
  check(!signal?.aborted,'Simulation cancelled before execution');
  const controller=new AbortController(),abort=()=>controller.abort(),deadline=Date.now()+timeoutMs;
  signal?.addEventListener('abort',abort,{once:true});
  const groups=Array.from({length:Math.min(concurrency,parsed.cases.length)},()=>[]);
  parsed.cases.forEach((entry,index)=>groups[index%groups.length].push(entry));
  try{
    const results=await Promise.all(groups.map(cases=>runWorkerSimulation({...parsed,cases},{timeoutMs:Math.max(1,deadline-Date.now()),signal:controller.signal,workerFactory,batch:true})));
    check(Date.now()<=deadline,'Bounded native simulation deadline exhausted');
    const byId=new Map(results.flatMap(result=>result.cases).map(entry=>[entry.id,entry]));
    return {cases:parsed.cases.map(entry=>byId.get(entry.id)),batch:{cases:parsed.cases.length,samples:results.reduce((sum,result)=>sum+result.batch.samples,0),normalizedPositions:groups.length,nativeSampleIsolation:true,workerConcurrency:groups.length}};
  }catch(error){controller.abort();throw error;}
  finally{signal?.removeEventListener('abort',abort);}
}
