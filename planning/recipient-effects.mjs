// A qualitative native-Dex fact, not a damage calculator or an action selector.
// Only established current type immunity is audited. Missing/dynamic state never
// becomes an immunity verdict or an assertion that a move will take effect.
import {championsDex} from './board.mjs';
import {recipientReadsSchema,ineffectiveActionsSchema} from '../showdown/turn-plan.mjs';
const key=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]/g,'');
const alive=actor=>actor&&actor.raw?.fainted!==true&&actor.hp?.current!==0;
const ability=actor=>actor?.raw?.abilitySuppressed===true?'':key(actor?.ability);
const volatile=(actor,name)=>!!actor?.volatiles?.[name];
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const sourceKeys=['kind','sessionId','teamId','room','rqid','boardHash','requestDigest','opposingSheetSha256'];
const targeted=new Set(['normal','any','adjacentFoe']);
const changedTyping=actor=>['typechange','typeadd','transform','roost','terastallize'].some(name=>volatile(actor,name))||
  actor?.raw?.terastallized||actor?.raw?.teraType||actor?.raw?.types||actor?.raw?.typeOverride;
function currentType(ctx,actor,move){
  if(!actor?.ability||changedTyping(actor)||volatile(actor,'electrify')||ctx.field?.conditions?.iondeluge||move.onModifyType||['struggle','hiddenpower','naturalgift','terablast','judgment','multiattack','revelationdance','aurawheel','ragingbull','ivycudgel','weatherball','terrainpulse'].includes(move.id))return null;
  const active=ability(actor);
  if(active==='normalize')return 'Normal';
  if(move.type==='Normal'&&['aerilate','pixilate','refrigerate','galvanize'].includes(active))return {aerilate:'Flying',pixilate:'Fairy',refrigerate:'Ice',galvanize:'Electric'}[active];
  if(active==='liquidvoice'&&move.flags.sound)return 'Water';
  return move.type;
}
function recipientUnresolved(ctx,actor,target,move,type){
  if(move.tracksTarget||['stalwart','propellertail'].includes(ability(actor)))return false;
  const others=ctx.actors.filter(value=>value.side===target.side&&value.id!==target.id&&value.slot&&alive(value));
  const powderImmune=championsDex.species.get(actor.species??'').types?.includes('Grass')||key(actor.item)==='safetygoggles'||ability(actor)==='overcoat';
  if(others.some(value=>volatile(value,'followme')||volatile(value,'ragepowder')&&!powderImmune))return true;
  if(!['moldbreaker','teravolt','turboblaze'].includes(ability(actor))&&!move.ignoreAbility&&others.some(value=>type==='Electric'&&ability(value)==='lightningrod'||type==='Water'&&ability(value)==='stormdrain'))return true;
  return false;
}
function immunity(ctx,actor,target,move){
  if(!move.exists||move.category==='Status'||move.flags.futuremove||!targeted.has(move.target)||changedTyping(target))return null;
  const type=currentType(ctx,actor,move),species=championsDex.species.get(target.species??'');
  if(!type||!species.exists||recipientUnresolved(ctx,actor,target,move,type))return null;
  // Ring Target can remove type immunity. Item activation/suppression is not
  // proved here, so its presence makes this narrow verdict unresolved.
  if(key(target.item)==='ringtarget')return null;
  if(move.ignoreImmunity===true||move.ignoreImmunity?.[type]===true||move.id==='thousandarrows'||
    ['Normal','Fighting'].includes(type)&&(['scrappy','mindseye'].includes(ability(actor))||volatile(target,'foresight'))||type==='Psychic'&&volatile(target,'miracleeye'))return null;
  let types=species.types;
  if(type==='Ground'&&types.includes('Flying')){
    // Current observed grounding can remove Flying's type immunity. Unknown
    // grounding never authorizes a hard block using the nominal species type.
    if(ctx.field?.conditions?.gravity||volatile(target,'ingrain')||volatile(target,'smackdown')||key(target.item)==='ironball')types=types.filter(value=>value!=='Flying');
    else if(volatile(target,'roost'))return null;
  }
  return championsDex.getImmunity(type,types)?null:{moveType:type,reason:`${target.species} is currently type-immune to ${type}`};
}
function row(ctx,actor,moveSlot,target){
  const legal=ctx.legalActions?.active?.[actor.slot-1]?.moves?.[moveSlot-1];
  if(!legal||legal.disabled||legal.pp===0||!targeted.has(legal.target))return null;
  const move=championsDex.moves.get(legal.id||legal.move||legal.name||''),blocked=immunity(ctx,actor,target,move);
  return blocked?{code:'CURRENT_TARGET_TYPE_IMMUNITY',actorId:actor.id,actorSlot:actor.slot,moveSlot,move:move.name,targetSlot:target.slot,targetId:target.id,targetSpecies:target.species,...blocked}:null;
}
export function buildRecipientEffects(ctx,{source={}}={}){
  const blocked=[];
  if(!ctx.legalActions?.teamPreview&&!ctx.legalActions?.forceSwitch)for(const actor of ctx.actors.filter(value=>value.own&&value.slot&&alive(value))){
    for(let slot=1;slot<=Math.min(4,ctx.legalActions?.active?.[actor.slot-1]?.moves?.length??0);slot++)for(const target of ctx.actors.filter(value=>!value.own&&value.slot&&alive(value))){
      const result=row(ctx,actor,slot,target);if(result)blocked.push(result);
    }
  }
  return {kind:'current-recipient-effects',scope:'current-type-immunity-only',source:Object.fromEntries(sourceKeys.filter(name=>source[name]!==undefined).map(name=>[name,source[name]])),blocked,
    readRecipients:ctx.actors.filter(value=>!value.own&&!value.slot&&alive(value)).map(value=>({id:value.id,species:value.species})),
    limits:'Current occupants and established move types only. An absent block is not successful delivery, damage, safety or a useful choice. Future form/type effects remain unresolved and need checked hypotheses when material. recipientReads express switch, form or redirection predictions; ineffectiveActions acknowledge no current effect and an authored independent purpose. Neither proves usefulness.'};
}
/** Validate authored metadata as well as both selected actions. Reads authorize
 * only this exact current pair/context; they establish no opposing action. */
export function validateSelectedRecipientEffects(ctx,actions,reads,{source={},ineffectiveActions}={}){
  const parsed=reads===undefined?[]:recipientReadsSchema.parse(reads),acknowledgements=ineffectiveActions===undefined?[]:ineffectiveActionsSchema.parse(ineffectiveActions),selected=[];
  for(const [index,action]of actions.entries()){
    if(action.type!=='move'||![1,2].includes(action.target))continue;
    const actor=ctx.actors.find(value=>value.own&&value.slot===index+1&&alive(value));
    const target=ctx.actors.find(value=>!value.own&&value.slot===action.target&&alive(value));
    if(!actor||!target){if([...parsed,...acknowledgements].some(read=>read.actorId===actor?.id||read.targetSlot===action.target))throw new Error('Recipient read current actor/target identity is unavailable');continue;}
    const partner=actions[1-index],partnerMove=partner?.type==='move'?championsDex.moves.get(ctx.legalActions?.active?.[1-index]?.moves?.[partner.slot-1]?.id||ctx.legalActions?.active?.[1-index]?.moves?.[partner.slot-1]?.move||''):null;
    const pairedTypeChange=partnerMove&&(
      partnerMove.id==='electrify'&&partner.target===-(index+1)||partnerMove.id==='iondeluge'||
      ['soak','magicpowder','forestscurse','trickortreat'].includes(partnerMove.id)&&partner.target===action.target);
    const blocked=action.mega||pairedTypeChange?null:row(ctx,actor,action.slot,target);
    selected.push({actor,target,action,blocked});
  }
  const used=new Set();
  for(const read of parsed){
    if(!['boardHash','requestDigest','opposingSheetSha256'].every(name=>hash(source[name])&&source[name]===read.source[name]))throw new Error('Recipient read source changed; never rebind a stale read');
    const selectedAction=selected.find(value=>value.actor.id===read.actorId&&value.action.slot===read.moveSlot&&value.action.target===read.targetSlot&&value.target.id===read.currentTargetId);
    if(!selectedAction||!selectedAction.blocked)throw new Error('Recipient read differs from the selected action/current immune recipient');
    const {actor,target,action}=selectedAction,move=championsDex.moves.get(ctx.legalActions.active[actor.slot-1].moves[action.slot-1].id||ctx.legalActions.active[actor.slot-1].moves[action.slot-1].move||'');
    let expected;
    if(read.expected.kind==='switch'){
      expected=ctx.actors.find(value=>!value.own&&!value.slot&&alive(value)&&value.id===read.expected.recipientId);
      if(!expected)throw new Error('Recipient switch read must name an actual opposing reserve/sheet identity');
    }else if(read.expected.kind==='form'){
      const item=championsDex.items.get(target.item??''),forms=typeof item.megaStone==='string'?[item.megaStone]:Object.values(item.megaStone??{}),form=championsDex.species.get(read.expected.species);
      if(!form.exists||!forms.includes(form.name)||form.baseSpecies!==championsDex.species.get(target.species??'').baseSpecies||form.name===target.species||ctx.sides?.find(side=>side.id===target.side)?.megaUsed===true)throw new Error('Recipient form read must name the current recipient’s published possible Mega form');
      expected={...target,species:form.name};
    }else{
      expected=ctx.actors.find(value=>!value.own&&value.slot&&value.id!==target.id&&alive(value)&&value.id===read.expected.recipientId);
      const powderImmune=championsDex.species.get(actor.species??'').types?.includes('Grass')||key(actor.item)==='safetygoggles'||ability(actor)==='overcoat';
      if(!expected||!expected.moves?.some(name=>key(name)===key(read.expected.move))||move.tracksTarget||['stalwart','propellertail'].includes(ability(actor))||read.expected.move==='Rage Powder'&&powderImmune)throw new Error('Recipient redirection read must name an eligible current opposing redirector with the published move');
    }
    if(immunity(ctx,actor,expected,move))throw new Error('Recipient read still names a type-immune intended recipient');
    const identity=`${read.actorId}:${read.moveSlot}:${read.targetSlot}`;
    if(used.has(identity))throw new Error('Duplicate recipient read for one selected action');used.add(identity);
  }
  const acknowledged=[];
  for(const acknowledgement of acknowledgements){
    if(!['boardHash','requestDigest'].every(name=>hash(source[name])&&source[name]===acknowledgement.source[name])||
      (source.opposingSheetSha256===undefined?acknowledgement.source.opposingSheetSha256!==undefined:!hash(source.opposingSheetSha256)||source.opposingSheetSha256!==acknowledgement.source.opposingSheetSha256))throw new Error('Ineffective-action acknowledgement source changed; never rebind');
    const selectedAction=selected.find(value=>value.actor.id===acknowledgement.actorId&&value.action.slot===acknowledgement.moveSlot&&value.action.target===acknowledgement.targetSlot&&value.target.id===acknowledgement.currentTargetId);
    if(!selectedAction||!selectedAction.blocked)throw new Error('Ineffective-action acknowledgement differs from the selected action/current immune recipient');
    const partnerIndex=2-selectedAction.actor.slot,partner=ctx.actors.find(value=>value.own&&value.slot===partnerIndex+1);
    if(!partner||partner.id!==acknowledgement.independentActorId||!actions[partnerIndex])throw new Error('Ineffective-action acknowledgement must name the exact other current actor and selected action');
    const identity=`${acknowledgement.actorId}:${acknowledgement.moveSlot}:${acknowledgement.targetSlot}`;
    if(used.has(identity))throw new Error('Duplicate or conflicting recipient read/ineffective-action acknowledgement');used.add(identity);
    acknowledged.push({...structuredClone(acknowledgement),status:'acknowledged-no-current-effect',independentAction:structuredClone(actions[partnerIndex]),independentEffectVerified:false,usefulnessVerified:false,forcednessVerified:false});
  }
  for(const {blocked}of selected)if(blocked&&!used.has(`${blocked.actorId}:${blocked.moveSlot}:${blocked.targetSlot}`))throw new Error(`${blocked.reason}; select a different pair or supply an explicit source-bound recipient read or no-effect acknowledgement`);
  return {scope:'current-type-immunity-only',reads:structuredClone(parsed),ineffectiveActions:acknowledged,blocked:selected.flatMap(value=>value.blocked?[value.blocked]:[]),futureEffectsVerified:false};
}
