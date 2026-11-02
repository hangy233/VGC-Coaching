// Pure observed-state adapter. No network, battle control, damage or Speed math.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {z} from 'zod';
import {validateOwnReservePpSnapshot} from '../showdown/battle-state.mjs';
import {registeredSpeciesKey} from './registered-identity.mjs';
import {observedBoostsSchema as boostsSchema,observedVolatileSchema as volatileSchema,observedSideConditionsSchema as sideConditionsSchema,observedSheetSchema as sheetSchema,observedPpSchema as ppSchema,observedFieldSchema,observedLifecycleSchema,observedPositionInputSchema} from './schemas.mjs';
export {observedLifecycleSchema,observedFieldSchema,observedHypothesesSchema,observedBindingSchema,observedPositionInputSchema,observedSourceSchema} from './schemas.mjs';

const require=createRequire(import.meta.url);
const {Teams,TeamValidator,Dex}=require('pokemon-showdown');
const dex=Dex.mod('champions');
const FORMAT='gen9championsvgc2026regmc';
const statNames=['hp','atk','def','spa','spd','spe'];
const boostNames=['atk','def','spa','spd','spe','accuracy','evasion'];
export const supportedObservedCurrentAbilities=new Set(dex.abilities.all().filter(ability=>ability.exists).map(ability=>ability.id));
const id=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]/g,'');
const check=(ok,message)=>{if(!ok)throw new Error(`Observed position: ${message}`);};
const copy=value=>structuredClone(value);


/** Bind own live request switch slots to stable identities before native reorder. */
export function bindObservedActions(actions,built,{replacement=false}={}){
  check(Array.isArray(actions)&&actions.length===2,'complete own pair required for identity binding');
  const order=built?.provenance?.ownRequestOrder;
  check(Array.isArray(order)&&order.length===4,'bound fresh own request order required');
  return actions.map((action,index)=>{
    check(action&&typeof action==='object','structured own action required');
    if(action.type==='move'){
      const side=built.position?.sides?.find(s=>s.id===built.position.ownSide),actorId=side?.active[index];
      const menu=built.provenance.ownMoveMenus?.find(row=>row.pokemonId===actorId),entry=menu?.slots?.find(row=>row.sourceSlot===action.slot);
      return entry?{...copy(action),...(Number.isInteger(entry.nativeSlot)?{slot:entry.nativeSlot}:{}),sourceMoveId:id(entry.move)}:copy(action);
    }
    if(action.type!=='switch')return copy(action);
    check((action.slot!==undefined)!==(action.pokemonId!==undefined),'choose one switch slot or stable identity');
    // A continuation's numeric slot belongs to the native replacement request
    // reached during this simulated turn, after earlier switches reordered it.
    // Initial actions still bind against the fresh frozen control-source menu.
    if(replacement&&action.slot!==undefined){check(Number.isInteger(action.slot)&&action.slot>=1&&action.slot<=4,'integer native replacement slot required');return copy(action);}
    let matches;
    if(action.slot!==undefined){check(Number.isInteger(action.slot),'integer fresh switch slot required');matches=order.filter(p=>p.requestIndex===action.slot);}
    else matches=order.filter(p=>p.snapshotId===action.pokemonId||p.controlPokemonId===action.pokemonId);
    check(matches.length===1,'own switch identity is unavailable or ambiguous in fresh request');
    return {type:'switch',pokemonId:matches[0].controlPokemonId};
  });
}

function registeredKey(species){
  return registeredSpeciesKey(species,dex);
}
function setFor(species,sets){
  const matches=sets.filter(set=>registeredKey(set.species)===registeredKey(species));
  check(matches.length===1,`registered set is missing or ambiguous for ${species}`);
  return matches[0];
}
function canonicalAbility(value){const result=dex.abilities.get(value);check(result.exists,`unknown ability ${value}`);return result.name;}
function canonicalItem(value){if(!value)return '';const result=dex.items.get(value);check(result.exists,`unknown item ${value}`);return result.name;}
function canonicalMoves(moves){return moves.map(value=>{const move=dex.moves.get(value);check(move.exists,`unknown move ${value}`);return move.name;});}
function plainSet(set,points){return {species:dex.species.get(set.species).name,nature:set.nature,ability:canonicalAbility(set.ability),item:canonicalItem(set.item),moves:canonicalMoves(set.moves),statPoints:points};}
function hypothesizedSet(set,hypothesis,name){
  const nature=hypothesis?.nature??set.nature;
  check(typeof nature==='string'&&dex.natures.get(nature).exists,`${name} opposing nature is unknown; a labeled candidate is required`);
  check(!set.nature||hypothesis?.nature===undefined||id(set.nature)===id(hypothesis.nature),`${name} nature hypothesis conflicts with published nature`);
  return {...set,nature:dex.natures.get(nature).name};
}
export function publishedSheetDigest(sheet){
  const canonical=z.array(sheetSchema).length(6).parse(sheet).map(set=>({...plainSet(set,undefined),level:set.level??50}));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
function exactOwnSets(teamText,teamId){
  const team=Teams.import(teamText);
  check(team?.length===6,'the exact locked six are required');
  const problems=new TeamValidator(FORMAT).validateTeam(team);
  check(!problems?.length,`locked team is invalid: ${problems?.join('; ')}`);
  const digest=createHash('sha256').update(Teams.pack(team)).digest('hex');
  check(digest===teamId,'locked team packed hash does not match expected teamId');
  return team;
}
function boostsFrom(value,hypothesis,name){
  const unknown=boostNames.filter(key=>!Number.isInteger(value?.[key]));
  check(!unknown.length||hypothesis?.boosts,`${name} has unknown boosts (${unknown.join(',')}); explicit hypothesis required`);
  const result={};
  for(const key of boostNames){
    const known=value?.[key],supplied=hypothesis?.boosts?.[key];
    check(!Number.isInteger(known)||supplied===undefined||known===supplied,`${name} hypothesis conflicts with observed ${key} boost`);
    result[key]=Number.isInteger(known)?known:supplied;
  }
  return boostsSchema.parse(result);
}
function currentVolatiles(value,hypothesis,name){
  const keys=Object.keys(value??{});
  check(keys.every(key=>['healblock','encore','confusion'].includes(key)),`${name} has unsupported volatile ${keys.find(key=>!['healblock','encore','confusion'].includes(key))}`);
  const supplied=hypothesis?.volatiles??{};
  check(Object.keys(supplied).every(key=>keys.includes(key)),`${name} hypothesis adds an unobserved volatile`);
  check(!keys.includes('healblock')||supplied.healblock,`${name} Heal Block duration/source require explicit hypothesis`);
  if(keys.includes('encore')){check(supplied.encore,`${name} Encore move/duration require explicit evidence or hypothesis`);const known=value.encore;
    check(!known.move||id(known.move)===id(supplied.encore.move),`${name} Encore move hypothesis conflicts with observation`);
    if(known.remainingTurns)duration(known,supplied.encore,`${name} Encore`);}
  if(keys.includes('confusion')){
    const n=supplied.confusion?.remainingActions,range=value.confusion?.remainingActions;
    check(Number.isInteger(n)&&n>=1&&n<=5,`${name} confusion action counter requires an explicit bounded hypothesis`);
    if(range)check(Number.isInteger(range.min)&&Number.isInteger(range.max)&&range.min>=1&&range.max<=5&&range.min<=range.max&&n>=range.min&&n<=range.max,`${name} confusion action-counter hypothesis conflicts with observation`);
  }
  return volatileSchema.parse(supplied);
}
function duration(condition,provided,name){
  const range=condition?.remainingTurns;
  const known=range&&range.min===range.max?range.min:null;
  const n=provided?.remainingTurns??known;
  check(Number.isInteger(n),`${name} remaining duration is unknown; explicit hypothesis required`);
  if(range){check(n>=range.min&&n<=range.max,`${name} duration hypothesis conflicts with observation`);}
  return n;
}
function currentField(board,hypotheses){
  const source=board.field;
  check(source&&Object.hasOwn(source,'weather')&&Object.hasOwn(source,'terrain')&&source.conditions,'complete observed field required');
  const result={},given=hypotheses.field??{};
  for(const key of ['weather','terrain']){
    const condition=source[key];
    check(condition||!given[key],`${key} hypothesis adds an unobserved field`);
    if(!condition)continue;
    const canonical=id(condition.name),mapped=canonical==='snowscape'?'snow':canonical;
    const allowed=key==='weather'?['raindance','sunnyday','sandstorm','snow']:['grassyterrain','psychicterrain','electricterrain','mistyterrain'];
    check(allowed.includes(mapped),`unsupported ${key} ${condition.name}`);
    check(!given[key]||given[key].id===mapped,`${key} hypothesis conflicts with observed identity`);
    result[key]={id:mapped,remainingTurns:duration(condition,given[key],key)};
  }
  const fieldKeys=Object.keys(source.conditions);
  check(fieldKeys.every(key=>key==='trickroom'),`unsupported field condition ${fieldKeys.find(key=>key!=='trickroom')}`);
  check(source.conditions.trickroom||!given.trickRoom,'Trick Room hypothesis adds an unobserved field');
  if(source.conditions.trickroom)result.trickRoom={remainingTurns:duration(source.conditions.trickroom,given.trickRoom,'Trick Room')};
  return observedFieldSchema.parse(result);
}
function currentConditions(side,hypotheses){
  const values=side.conditions??{},given=hypotheses.sideConditions?.[side.id]??{},result={};
  const supported=['reflect','lightscreen','auroraveil','tailwind','toxicspikes'];
  check(Object.keys(values).every(key=>supported.includes(key)),`${side.id} has unsupported side condition`);
  check(Object.keys(given).every(key=>Object.hasOwn(values,key)),`${side.id} hypothesis adds an unobserved side condition`);
  for(const [key,value]of Object.entries(values)){
    if(key==='toxicspikes'){
      check([1,2].includes(value?.layers),`${side.id} Toxic Spikes exact observed layers are unavailable or unsupported`);
      check(!given[key]||given[key].layers===value.layers,`${side.id} Toxic Spikes layer hypothesis conflicts with observation`);
      result[key]={layers:value.layers};
    }else result[key]={remainingTurns:duration(value,given[key],`${side.id} ${key}`)};
  }
  return sideConditionsSchema.parse(result);
}
function lifecycle(hypothesis,name,observed){
  check(hypothesis?.lifecycle,`${name} activeTurns/Protect/choice/lastMove lifecycle is not observed; explicit evidence or hypothesis required`);
  if(typeof observed?.unburdenVolatile==='boolean')check(hypothesis.lifecycle.unburdenVolatile===observed.unburdenVolatile,`${name} Unburden volatile hypothesis conflicts with known native history`);
  return observedLifecycleSchema.parse(hypothesis.lifecycle);
}
function controlId(requestEntry){
  check(typeof requestEntry?.ident==='string'&&typeof requestEntry.details==='string','fresh own request identity required');
  return `pokemon-${createHash('sha256').update(JSON.stringify([requestEntry.ident,requestEntry.details])).digest('hex').slice(0,24)}`;
}
function observedHpFor(p){
  check(Number.isInteger(p.hp?.current)&&p.hp.current>=0&&
    (p.hp.max===null||Number.isInteger(p.hp.max)&&p.hp.max>0)&&
    ['server-own-exact','server-display'].includes(p.hp.precision),`${p.id} observed HP/precision is missing or unsupported`);
  return {current:p.hp.current,max:p.hp.max,precision:p.hp.precision};
}
function ownPokemon(p,requestEntry,activeIndex,set,hypothesis,mode,legal,board,ppFacts){
  const base=plainSet(set,Object.fromEntries(statNames.map(key=>[key,set.evs?.[key]??0])));
  const result={id:p.id,controlPokemonId:controlId(requestEntry),...base};
  check(registeredKey(requestEntry.details.split(',')[0])===registeredKey(p.species),'own board and fresh legal request identity disagree');
  const condition=/^(\d+)\/(\d+)(?:\s|$)/u.exec(requestEntry.condition??'');
  if(condition)check(p.hp?.current===Number(condition[1])&&p.hp?.max===Number(condition[2]),'Own exact HP conflicts with the fresh private request');
  else if(/^(?:0)(?:\s|$)/u.test(requestEntry.condition??''))check(p.hp?.current===0,'Own fainted HP conflicts with the fresh private request');
  if(p.ability&&requestEntry.ability)check(id(p.ability)===id(requestEntry.ability),'Own current ability conflicts with the fresh private request');
  check(requestEntry.moves?.length===4&&requestEntry.moves.every((move,index)=>id(move)===id(base.moves[index])),'own request moves differ from the exact locked set');
  if(mode==='opening')return result;
  check(p.abilitySuppressed===false,`${p.id} ability suppression is unknown or active`);
  check(p.hp?.precision==='server-own-exact'&&Number.isInteger(p.hp.current),`${p.id} exact own HP required`);
  const privateStatus=condition?String(requestEntry.condition).split(/\s+/u)[1]??'':p.status??'';
  check(['','brn','par','psn','tox','slp','frz'].includes(privateStatus),`${p.id} unknown native status ${privateStatus}`);
  if(p.status)check(p.status===privateStatus,'Own current status conflicts with the fresh private request');
  const ability=canonicalAbility(requestEntry.ability??p.ability);
  const species=dex.species.get(p.species);
  const baseAbility=species.isMega?Object.values(species.abilities)[0]:set.ability;
  check(supportedObservedCurrentAbilities.has(id(ability)),`${p.id} unsupported stateful/current ability ${ability}`);
  if(id(ability)==='unburden')check(typeof hypothesis?.lifecycle?.unburdenVolatile==='boolean',`${p.id} Unburden volatile history is unknown; exact activation/reset evidence required`);
  const retained=activeIndex<0?validateOwnReservePpSnapshot({pokemon:p,requestEntry,observation:board.ownPpObservation,rqid:board.request?.rqid,authoredPp:hypothesis?.pp}):null;
  const pp=activeIndex>=0?legal.active?.[activeIndex]?.moves?.map(move=>move.pp):retained?.pp??hypothesis?.pp;
  check(pp,`${p.id} reserve PP is unknown; explicit hypothesis required`);
  if((activeIndex>=0||retained)&&hypothesis?.pp)check(JSON.stringify(pp)===JSON.stringify(hypothesis.pp),`${p.id} PP hypothesis conflicts with ${retained?'retained private request':'fresh request'}`);
  if(retained)ppFacts.push({pokemonId:p.id,...retained.provenance});
  return {...result,species:species.name,ability,item:canonicalItem(requestEntry.item),hp:p.hp.current,observedHp:observedHpFor(p),status:privateStatus,
    boosts:boostsFrom(p.boosts,hypothesis,p.id),pp:ppSchema.parse(pp),lifecycle:lifecycle(hypothesis,p.id,p),volatiles:currentVolatiles(p.volatiles,hypothesis,p.id),...(id(ability)!==id(baseAbility)?{nativeState:{baseAbility:canonicalAbility(baseAbility)}}:{})};
}
/** Positive actual Mega events establish use; absence establishes nothing. */
export function hasObservedMegaUse(side){return side?.pokemon?.some(p=>p.mega===true)===true;}

function foePokemon(p,set,hypothesis,mode){
  check(hypothesis,`${p.id} explicit opposing investment/HP hypothesis required`);
  const base=plainSet(hypothesizedSet(set,hypothesis,p.id),hypothesis.statPoints),result={id:p.id,...base};
  if(mode==='opening'){check(hypothesis.hp==='full',`${p.id} opening HP hypothesis must be full`);return result;}
  check(p.fainted!==true||hypothesis.hp===0,`${p.id} fainted observation requires zero HP hypothesis`);
  check(p.fainted===true||hypothesis.hp!==0,`${p.id} live observation cannot have zero HP hypothesis`);
  check(p.abilitySuppressed===false||p.abilitySuppressed!==true&&hypothesis.abilitySuppressed===false,`${p.id} ability suppression is unknown or active; explicit false hypothesis required`);
  const species=dex.species.get(p.species),ability=hypothesis.ability??p.ability;
  const baseAbility=species.isMega?Object.values(species.abilities)[0]:set.ability;
  check(ability,`${p.id} current ability is unknown; explicit hypothesis required`);
  check(supportedObservedCurrentAbilities.has(id(ability)),`${p.id} unsupported stateful/current ability ${ability}`);
  if(id(ability)==='unburden')check(typeof hypothesis?.lifecycle?.unburdenVolatile==='boolean',`${p.id} Unburden volatile history is unknown; exact activation/reset evidence required`);
  check(!p.ability||id(p.ability)===id(ability),`${p.id} ability hypothesis conflicts with observation`);
  check(p.itemKnown||hypothesis.item!==undefined,`${p.id} current item is unknown; explicit hypothesis required`);
  if(p.itemKnown&&hypothesis.item!==undefined)check(id(p.item)===id(hypothesis.item),`${p.id} item hypothesis conflicts with observation`);
  const status=p.status??'';
  check(['','brn','par','psn','tox','slp','frz'].includes(status),`${p.id} unknown native status ${status}`);
  check(hypothesis.status===undefined||hypothesis.status===status,`${p.id} status hypothesis conflicts with observation`);
  check(hypothesis.pp,`${p.id} PP/history require explicit hypothesis`);
  return {...result,species:species.name,ability:canonicalAbility(ability),item:canonicalItem(p.itemKnown?p.item:hypothesis.item),hp:hypothesis.hp,observedHp:observedHpFor(p),status,
    boosts:boostsFrom(p.boosts,hypothesis,p.id),pp:ppSchema.parse(hypothesis.pp),lifecycle:lifecycle(hypothesis,p.id,p),volatiles:currentVolatiles(p.volatiles,hypothesis,p.id),...(id(ability)!==id(baseAbility)?{nativeState:{baseAbility:canonicalAbility(baseAbility)}}:{})};
}

/** Bind one complete observed turn to native-engine snapshot inputs, without I/O. */
export function buildObservedPosition(input){
  const {observed,teamText,opposingSheet,hypotheses,expected}=observedPositionInputSchema.parse(input);
  const ownSets=exactOwnSets(teamText,expected.teamId);
  check(!observed.teamSha256||observed.teamSha256===expected.teamId,'observation belongs to another locked team');
  const matches=observed.actions.filter(action=>action.room===expected.room&&action.rqid===expected.rqid&&action.token===expected.token);
  check(matches.length===1,'exact room/rqid/token is not uniquely present in observation');
  const action=matches[0];
  check(action.kind==='turn'&&action.actionable!==false&&!['sent','uncertain'].includes(action.submissionStatus),'source request is not an unsubmitted start-of-turn pair');
  const boards=observed.boards.filter(board=>board.room===expected.room&&board.request?.rqid===expected.rqid);
  check(boards.length===1,'matching board/request is missing or ambiguous');
  const board=boards[0],legal=action.legalActions;
  check(legal&&!legal.teamPreview&&!legal.forceSwitch&&legal.active?.length===2&&legal.pokemon?.length===4,'fresh complete four-Pokemon legal turn required');
  check(Number.isInteger(board.turn)&&board.turn>=1&&!board.request?.wait&&!board.request?.forceSwitch,'unsupported partial/forced request');
  check(['p1','p2'].includes(board.ownSide),'own side identity required');
  const own=board.sides?.find(side=>side.id===board.ownSide),foe=board.sides?.find(side=>side.id!==board.ownSide);
  check(own&&foe&&board.sides.length===2,'exactly two observed sides required');
  const sheetDigest=publishedSheetDigest(opposingSheet),published=observed.opponentSheets?.[foe.id];
  check(published||expected.opposingSheetSha256,'published opposing sheet binding is required');
  if(published)check(publishedSheetDigest(published)===sheetDigest,'supplied opposing sheet conflicts with actual published sheet');
  if(expected.opposingSheetSha256)check(expected.opposingSheetSha256===sheetDigest,'supplied opposing sheet conflicts with retained sheet digest');
  const ownIds=new Set(own.pokemon.map(p=>p.id)),foeIds=new Set(foe.pokemon.map(p=>p.id));
  check(own.pokemon.length===4&&ownIds.size===4,'selected own four are incomplete or ambiguous');
  check(new Set(own.pokemon.map(p=>p.requestIndex)).size===4,'own requestIndex mapping is duplicated/ambiguous');
  check(new Set(own.pokemon.map(p=>registeredKey(p.species))).size===4,'own observed species mapping is duplicated/ambiguous');
  check(foeIds.size===foe.pokemon.length,'duplicate opposing identity');
  check(new Set(foe.pokemon.map(p=>registeredKey(p.species))).size===foe.pokemon.length,'opposing observed species mapping is duplicated/ambiguous');
  check(Object.keys(hypotheses.opposing).every(key=>foeIds.has(key)),'opposing hypothesis is not bound to an observed identity');
  check(Object.keys(hypotheses.own).every(key=>ownIds.has(key)),'own history hypothesis is not bound to selected own four');
  const activeIds=side=>{
    check(side.active?.length===2&&side.active[0].slot==='a'&&side.active[1].slot==='b','complete ordered active slots required');
    const actors=side.active.map(slot=>side.pokemon.find(p=>p.id===slot.pokemon));check(actors.every(Boolean)&&new Set(actors.map(p=>p.id)).size===2,'active identity is missing or ambiguous');
    const dead=actors.filter(p=>p.fainted===true&&p.hp?.current===0),live=actors.filter(p=>p.fainted!==true&&p.hp?.current>0);
    const lone=dead.length===1&&live.length===1&&side.unrevealedSelected===0&&side.pokemon.length===4&&side.pokemon.filter(p=>!actors.includes(p)).every(p=>p.fainted===true&&p.hp?.current===0);
    // Native doubles keeps a fainted active identity when no replacement is
    // alive. Own slots additionally require the exact private party to confirm
    // every faint and active order, so an authored pass cannot mask a live slot.
    const ownLone=side.id!==own.id||actors.every((p,index)=>p.requestIndex===index+1)&&side.pokemon.every(p=>{
      const request=legal.pokemon[p.requestIndex-1];return request&&Boolean(request.active)===actors.includes(p)&&/ fnt$/u.test(request.condition??'')===(p.fainted===true&&p.hp?.current===0);
    });
    check(live.length===2||hypotheses.mode==='current'&&lone&&ownLone,'active identity is missing/fainted/zero HP or requires a healthy/unseen replacement');
    return actors.map(p=>p.id);
  };
  const ourActive=activeIds(own),theirActive=activeIds(foe),mode=hypotheses.mode;
  if(mode==='opening'){
    check(board.turn===1,'opening reconstruction requires first turn');
    check(!(board.recentEvents?.lines??[]).some(line=>/^\|(move|cant|faint)\|/.test(line)),'opening source contains already-executed actions');
    check(!hypotheses.field&&!hypotheses.sideConditions&&!hypotheses.sideMegaUsed,'opening field/Mega history is established by native entry effects');
    check(!Object.keys(hypotheses.own).length,'opening does not accept current own lifecycle overrides');
    for(const candidate of [...Object.values(hypotheses.opposing),...hypotheses.reserves])check(!['ability','item','status','boosts','pp','lifecycle','volatiles','abilitySuppressed'].some(key=>candidate[key]!==undefined),'opening cannot silently ignore current-state overrides');
    check(own.pokemon.every(p=>p.hp?.current===p.hp?.max&&!p.status&&!p.mega),'opening own four must be fresh/full/base form');
    check(foe.pokemon.every(p=>p.hp?.current===100&&p.hp?.max===100&&!p.status&&!p.mega),'opening foes must be fresh full/base-form observations');
    check(foe.pokemon.length===2&&foe.unrevealedSelected===2,'opening requires exactly two observed foes and two explicitly hypothetical reserves');
  }
  const ppFacts=[],megaUseFacts=[];
  const ourPokemon=own.pokemon.map(p=>{
    check(Number.isInteger(p.requestIndex)&&p.requestIndex>=1&&p.requestIndex<=4,'own fresh requestIndex required');
    const requestEntry=legal.pokemon[p.requestIndex-1];
    check(Boolean(requestEntry.active)===ourActive.includes(p.id),'own active slot disagrees with fresh request');
    return ownPokemon(p,requestEntry,ourActive.indexOf(p.id),setFor(p.species,ownSets),hypotheses.own[p.id],mode,legal,board,ppFacts);
  });
  const theirPokemon=foe.pokemon.map(p=>foePokemon(p,setFor(p.species,opposingSheet),hypotheses.opposing[p.id],mode));
  check(Number.isInteger(foe.unrevealedSelected)&&foe.unrevealedSelected===hypotheses.reserves.length,'explicit hypothetical reserve count must match unrevealed selected count');
  for(const reserve of hypotheses.reserves){
    check(!['observed-high','observed-low'].includes(reserve.hp),`${reserve.hp} HP requires an observed opponent display; unavailable for unseen reserves`);
    check(!ownIds.has(reserve.id)&&!foeIds.has(reserve.id),'hypothetical reserve ID collides with observed identity');
    foeIds.add(reserve.id);
    const set=hypothesizedSet(setFor(reserve.species,opposingSheet),reserve,reserve.id);
    check(!theirPokemon.some(p=>registeredKey(p.species)===registeredKey(set.species)),'hypothetical reserve duplicates a selected species');
    if(mode==='opening'){check(reserve.hp==='full','opening hypothetical reserve HP must be full');theirPokemon.push({id:reserve.id,...plainSet(set,reserve.statPoints)});}
    else{
      check(reserve.status!==undefined&&reserve.boosts&&reserve.pp&&reserve.lifecycle&&reserve.volatiles,'current hypothetical reserve requires explicit status/boosts/PP/lifecycle/volatiles');
      check(supportedObservedCurrentAbilities.has(id(reserve.ability??set.ability)),`${reserve.id} unsupported stateful/current ability`);
      theirPokemon.push({id:reserve.id,...plainSet(set,reserve.statPoints),hp:reserve.hp,status:reserve.status,boosts:reserve.boosts,pp:reserve.pp,lifecycle:reserve.lifecycle,volatiles:reserve.volatiles,
        ...(reserve.ability?{ability:canonicalAbility(reserve.ability)}:{}),...(reserve.item!==undefined?{item:canonicalItem(reserve.item)}:{})});
    }
  }
  check(theirPokemon.length===4,'exactly four explicit selected opposing candidates required');
  const sides=[{id:own.id,active:ourActive,pokemon:ourPokemon},{id:foe.id,active:theirActive,pokemon:theirPokemon}].sort((a,b)=>a.id.localeCompare(b.id));
  if(mode==='current')for(const side of sides){
    const source=board.sides.find(value=>value.id===side.id);
    const positive=hasObservedMegaUse(source),authored=hypotheses.sideMegaUsed?.[side.id];
    check(!positive||authored!==false,'Mega-used false conflicts with observed current Mega');
    check(positive||typeof authored==='boolean',`current side Mega-use history for ${side.id} requires explicit known/candidate value`);
    side.megaUsed=positive?true:authored;
    megaUseFacts.push({sideId:side.id,value:side.megaUsed,source:positive?'observed-mega-event':'authored-hypothesis',...(positive?{pokemonIds:source.pokemon.filter(p=>p.mega===true).map(p=>p.id)}:{})});
    side.conditions=currentConditions(source,hypotheses);
  }
  const position={mode,turn:board.turn,ownSide:own.id,sides,...(mode==='current'?{field:currentField(board,hypotheses)}:{})};
  const assumptions=observedHypothesisLabels(hypotheses);
  return {position,provenance:{kind:'bound-observed-native-turn-position',teamId:expected.teamId,room:expected.room,rqid:expected.rqid,token:expected.token,sessionId:observed.sessionId??null,revision:observed.revision??null,observedAt:observed.observedAt??board.observedAt??null,
    opposingSheetSha256:sheetDigest,...(ppFacts.length?{retainedOwnPp:ppFacts}:{}),...(megaUseFacts.length?{megaUse:megaUseFacts}:{}),ownRequestOrder:own.pokemon.map(p=>({requestIndex:p.requestIndex,snapshotId:p.id,controlPokemonId:ourPokemon.find(candidate=>candidate.id===p.id).controlPokemonId})).sort((a,b)=>a.requestIndex-b.requestIndex),hpObservations:Object.fromEntries(board.sides.flatMap(side=>side.pokemon.map(p=>[p.id,copy(p.hp)]))),sourceSha256:createHash('sha256').update(JSON.stringify({action,board})).digest('hex'),
    limitations:['A retained matching observation is not proof of current server freshness.','Opposing investments, exact current HP and unrevealed selected reserves remain labeled hypotheses.','The adapter does not simulate or establish damage, Speed, action delivery, acceptance or a guaranteed knockout.']},assumptions};
}

/** Exact nonnumerical labels retained by the observed native translator. */
export function observedHypothesisLabels(hypotheses){
  return [hypotheses.label,...Object.entries(hypotheses.opposing).flatMap(([key,h])=>[`${key}: ${h.label}`,...(h.hp==='observed-high'?[`${key}: observed-high requests the upper native-renderer-compatible public-display HP hypothesis; exact opposing HP remains unknown and low-HP mechanics can differ.`]:[])]),...hypotheses.reserves.map(h=>`${h.id}: hypothetical selected reserve ${h.species}; ${h.label}`),...Object.entries(hypotheses.own).map(([key,h])=>`${key}: ${h.label}`)];
}
