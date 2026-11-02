import {championsDex,moveCapabilities} from './board.mjs';
import {legalReplacementPairs,replacementOptions,validateChoice} from '../showdown/choice-validation.mjs';

const key = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g,'');
const unique = values => [...new Set(values)];
const TARGETED = new Set(['normal','any','adjacentFoe','adjacentAlly','adjacentAllyOrSelf']);
const CONDITIONAL = new Set(['suckerpunch','counter','mirrorcoat','metalburst','comeuppance','focuspunch','firstimpression','lastresort','belch','dreameater','snore','fling','naturalgift','spitup','synchronoise','burnup','doubleshock','steelroller','upperhand']);
const PROTECT = new Set(['protect','detect','kingsshield','spikyshield','banefulbunker','obstruct','silktrap','burningbulwark']);
const DENIAL = new Set(['fakeout','taunt','encore','disable','spore','sleeppowder','hypnosis','yawn','thunderwave','willowisp','throatchop','psychicnoise','haze','clearsmog','quash','roar','whirlwind','dragontail','circlethrow','topsyturvy','imprison']);
const activeAbility = actor => actor?.raw?.abilitySuppressed === true ? '' : key(actor?.ability);
const hasVolatile = (actor,name) => !!actor?.volatiles?.[name];
const alive = actor => actor && actor.raw?.fainted !== true && actor.hp?.current !== 0;
const nativeRequest = legal => ({...legal,side:{...(legal?.side || {}),pokemon:legal?.pokemon || legal?.side?.pokemon || []}});
const abilityBypassed = actor => ['moldbreaker','teravolt','turboblaze'].includes(activeAbility(actor));

function grounded(ctx,actor) {
  if (ctx.field?.conditions?.gravity || hasVolatile(actor,'ingrain') || hasVolatile(actor,'smackdown') || key(actor.item) === 'ironball') return true;
  const species = championsDex.species.get(actor.species || '');
  if (!species.exists) return null;
  if (species.types.includes('Flying') || activeAbility(actor) === 'levitate' || key(actor.item) === 'airballoon' || hasVolatile(actor,'magnetrise') || hasVolatile(actor,'telekinesis')) return false;
  if (!actor.ability || !actor.itemKnown) return null;
  return true;
}

function effectiveMoveWeather(ctx,actor) {
  // Pinned Pokemon.effectiveWeather: Mega Sol on the current move user takes
  // precedence over field weather suppression and Utility Umbrella.
  if (activeAbility(actor) === 'megasol') return 'sunnyday';
  if (ctx.field?.weatherSuppressed === true || ctx.actors.some(value => value.slot && alive(value) && ['cloudnine','airlock'].includes(activeAbility(value)))) return '';
  const weather = key(ctx.field?.weather?.name || ctx.field?.weather);
  const itemActive = !ctx.field?.conditions?.magicroom && !hasVolatile(actor,'embargo') && activeAbility(actor) !== 'klutz';
  if (itemActive && key(actor.item) === 'utilityumbrella' && ['sunnyday','raindance','desolateland','primordialsea'].includes(weather)) return '';
  return weather;
}

function moveType(ctx,actor,move,warnings) {
  const ability = activeAbility(actor);
  if (ability === 'normalize') return 'Normal';
  if (move.type === 'Normal' && ['aerilate','pixilate','refrigerate','galvanize'].includes(ability)) return {aerilate:'Flying',pixilate:'Fairy',refrigerate:'Ice',galvanize:'Electric'}[ability];
  if (ability === 'liquidvoice' && move.flags.sound) return 'Water';
  if (move.id === 'weatherball') {
    const weather = effectiveMoveWeather(ctx,actor);
    return {raindance:'Water',primordialsea:'Water',sunnyday:'Fire',desolateland:'Fire',sandstorm:'Rock',hail:'Ice',snowscape:'Ice'}[weather] || 'Normal';
  }
  if (move.id === 'terrainpulse' && grounded(ctx,actor) === true) return {electricterrain:'Electric',grassyterrain:'Grass',mistyterrain:'Fairy',psychicterrain:'Psychic'}[key(ctx.field?.terrain?.name || ctx.field?.terrain)] || 'Normal';
  if (['terablast','judgment','multiattack','revelationdance','aurawheel','ragingbull','ivycudgel'].includes(move.id)) warnings.push(`${move.name}'s current type needs native verification before crediting its effect.`);
  return move.type;
}

function priorityMove(actor,move) {
  const ability = activeAbility(actor);
  return move.priority > 0 || ability === 'prankster' && move.category === 'Status' || ability === 'triage' && (!!move.heal || !!move.drain) ||
    ability === 'galewings' && move.type === 'Flying' && actor.hp?.max != null && actor.hp.current === actor.hp.max;
}

function firstTurnState(actor) {
  const lifecycle = actor.lifecycle;
  if (!lifecycle) return null;
  if (typeof lifecycle.fakeOutEligible === 'boolean') return lifecycle.fakeOutEligible;
  if (typeof lifecycle.firstTurn === 'boolean') return lifecycle.firstTurn;
  // The pinned native move checks activeMoveActions, which increments for the
  // selected move. activeTurns alone is a different lifecycle counter.
  if (Number.isInteger(lifecycle.activeMoveActions)) return lifecycle.activeMoveActions === 0;
  return null;
}

function knownBlock(ctx,actor,target,move,warnings) {
  const type = moveType(ctx,actor,move,warnings), species = championsDex.species.get(target.species || '');
  const ability = activeAbility(target), bypass = abilityBypassed(actor) || move.ignoreAbility === true;
  const damage = move.category !== 'Status', hostile = actor.side !== target.side;
  if (!target.ability || !target.itemKnown) warnings.push(`Unrevealed ability or item for ${target.id} can change move eligibility.`);
  const weatherSuppressed = ctx.actors.some(value => value.slot && alive(value) && ['cloudnine','airlock'].includes(activeAbility(value)));
  const weather = key(ctx.field?.weather?.name || ctx.field?.weather);
  if (damage && !weatherSuppressed && (weather === 'desolateland' && type === 'Water' || weather === 'primordialsea' && type === 'Fire')) return 'Current extreme weather prevents this damaging move';
  if (!species.exists) warnings.push(`Unknown current typing for ${target.id}; immunity eligibility needs verification.`);
  const ignoreType = move.ignoreImmunity === true || move.ignoreImmunity?.[type] === true || move.id === 'thousandarrows' ||
    ['Normal','Fighting'].includes(type) && (['scrappy','mindseye'].includes(activeAbility(actor)) || hasVolatile(target,'foresight')) || type === 'Psychic' && hasVolatile(target,'miracleeye');
  let types = species.types || [];
  if (type === 'Ground' && grounded(ctx,target) === true) types = types.filter(value => value !== 'Flying');
  if ((damage || move.id === 'thunderwave') && !ignoreType && species.exists && !championsDex.getImmunity(type,types)) return `${target.species} is currently type-immune to ${type}`;
  if (!bypass && (damage || move.id === 'thunderwave')) {
    const immunity = {Ground:['levitate','eartheater'],Water:['waterabsorb','dryskin','stormdrain'],Electric:['voltabsorb','lightningrod','motordrive'],Fire:['flashfire','wellbakedbody'],Grass:['sapsipper']};
    const airborneBypass = type === 'Ground' && ability === 'levitate' && (grounded(ctx,target) === true || move.id === 'thousandarrows');
    if ((immunity[type] || []).includes(ability) && !airborneBypass) return `${target.ability} blocks this move's type`;
    if (move.flags.sound && ability === 'soundproof') return 'Soundproof blocks this sound move';
    if (move.flags.bullet && ability === 'bulletproof') return 'Bulletproof blocks this move';
  }
  if (damage && type === 'Ground' && key(target.item) === 'airballoon' && grounded(ctx,target) !== true && move.id !== 'thousandarrows') return 'Air Balloon blocks Ground damage';
  if (hostile && priorityMove(actor,move)) {
    const blockers = ctx.actors.filter(foe => !foe.own && foe.slot && alive(foe) && ['armortail','queenlymajesty','dazzling'].includes(activeAbility(foe)));
    if (!bypass && blockers.length) return `${blockers[0].ability} currently protects the opposing side from this priority move`;
    if (key(ctx.field?.terrain?.name || ctx.field?.terrain) === 'psychicterrain') {
      const onGround = grounded(ctx,target);
      if (onGround === true) return 'Psychic Terrain currently blocks priority against this grounded target';
      if (onGround === null) warnings.push(`Psychic Terrain priority eligibility for ${target.id} is unresolved because grounding is unknown.`);
    }
    if (activeAbility(actor) === 'prankster' && move.category === 'Status' && species.types?.includes('Dark')) return 'Dark typing blocks this opposing Prankster status move';
  }
  if (move.flags.powder && (species.types?.includes('Grass') || key(target.item) === 'safetygoggles' || !bypass && ability === 'overcoat')) return 'Known powder immunity blocks this move';
  if (move.status && target.status) return 'An existing major status prevents the intended new status';
  if (move.status === 'par' && species.types?.includes('Electric')) return 'Electric typing prevents paralysis';
  if (move.status === 'brn' && species.types?.includes('Fire')) return 'Fire typing prevents burn';
  if (move.status === 'slp' && !bypass && ['insomnia','vitalspirit','sweetveil'].includes(ability)) return `${target.ability} prevents sleep`;
  if (move.status && hostile) {
    const terrain = key(ctx.field?.terrain?.name || ctx.field?.terrain);
    if (terrain === 'mistyterrain' || terrain === 'electricterrain' && move.status === 'slp') {
      const onGround = grounded(ctx,target);
      if (onGround === true) return 'Current terrain prevents the intended status on this grounded target';
      if (onGround === null) warnings.push(`Terrain status eligibility for ${target.id} is unresolved because grounding is unknown.`);
    }
    if (move.status === 'slp' && !bypass && ctx.actors.some(value => value.side === target.side && value.slot && alive(value) && activeAbility(value) === 'sweetveil')) return 'Active Sweet Veil prevents sleep on this side';
  }
  if (move.id === 'fakeout' && !bypass && ['innerfocus','shielddust'].includes(ability)) return `${target.ability} prevents Fake Out denial`;
  if (hostile && move.category === 'Status' && !bypass && ability === 'goodasgold') return 'Good as Gold blocks this opposing status move';
  if (hostile && TARGETED.has(move.target) && !['stalwart','propellertail'].includes(activeAbility(actor)) && !move.tracksTarget) {
    const redirectors = ctx.actors.filter(foe => foe.side === target.side && foe.slot && foe.id !== target.id && alive(foe));
    const typeRedirect = redirectors.find(foe => type === 'Electric' && activeAbility(foe) === 'lightningrod' || type === 'Water' && activeAbility(foe) === 'stormdrain');
    if (typeRedirect && !bypass) return `${typeRedirect.ability} redirects this move into its own immunity`;
    const powderImmune = championsDex.species.get(actor.species || '').types?.includes('Grass') || key(actor.item) === 'safetygoggles' || activeAbility(actor) === 'overcoat';
    const observedRedirect = redirectors.find(foe => hasVolatile(foe,'followme') || hasVolatile(foe,'ragepowder') && !powderImmune);
    if (observedRedirect) {
      const reason = knownBlock({...ctx,actors:ctx.actors.filter(foe => foe.id !== target.id)},actor,observedRedirect,move,warnings);
      if (reason) return `Observed redirection leads to an ineligible recipient: ${reason}`;
      warnings.push(`Observed redirection changes the recipient to ${observedRedirect.id}; original target pressure is not established.`);
    }
  }
  if (move.flags.sound && hasVolatile(actor,'throatchop')) return 'Throat Chop currently denies this sound move';
  if (move.drain && (hasVolatile(actor,'healblock') || hasVolatile(actor,'psychicnoise'))) return 'Observed healing prevention denies this draining move';
  return null;
}

function lockMove(actor,requestActive) {
  const raw = requestActive?.lockedMove ?? actor.raw?.lockedMove ?? actor.lifecycle?.choiceLockedMove ?? actor.lifecycle?.choiceLock ?? actor.volatiles?.choicelock?.move ?? actor.volatiles?.choicelock?.moveId;
  return raw ? key(typeof raw === 'object' ? raw.id || raw.move : raw) : null;
}

function optionsFor(ctx,request,index,blocked,{mega=false,transition=false}={}) {
  const actor = ctx.actors.find(value => value.own && value.slot === index + 1 && value.selected === 'selected');
  if (!actor) return [];
  if (!alive(actor)) return [{action:{type:'pass'},kind:'pass',actor,warnings:[]}];
  const foes = ctx.actors.filter(value => !value.own && value.slot && alive(value));
  const ally = ctx.actors.find(value => value.own && value.slot === 2 - index && alive(value));
  const result = [], current = request.active?.[index], locked = lockMove(actor,current);
  for (const [moveIndex,legal] of (current?.moves || []).entries()) {
    if (!legal || legal.disabled || legal.pp === 0) continue;
    const move = championsDex.moves.get(legal.id || legal.move || legal.name || '');
    if (!move.exists || locked && move.id !== locked) continue;
    const warnings = [];
    if (legal.pp == null) warnings.push(`${actor.id}: ${move.name} PP is unknown.`);
    if (move.id === 'fakeout') {
      const first = firstTurnState(actor);
      if (first === false) {blocked.push({actorId:actor.id,move:move.name,reason:'Fake Out first-turn eligibility is known false'});continue;}
      if (first === null) warnings.push(`${actor.id}: Fake Out first-turn eligibility is unknown; denial cannot yet be credited.`);
    }
    if (CONDITIONAL.has(move.id)) warnings.push(`${move.name} has conditional success; its activation requirement is unverified.`);
    if (move.selfdestruct || ['explosion','selfdestruct','mistyexplosion','finalgambit'].includes(move.id)) {blocked.push({actorId:actor.id,move:move.name,reason:'Automatic candidates do not invent a purposeful sacrifice payoff'});continue;}
    if (move.category === 'Status' && hasVolatile(actor,'taunt')) {blocked.push({actorId:actor.id,move:move.name,reason:'Taunt currently denies this status move'});continue;}
    const targetKind = legal.target || move.target;
    let targets = [null];
    if (TARGETED.has(targetKind)) targets = targetKind === 'adjacentAlly' ? ally ? [ally] : [] : targetKind === 'adjacentAllyOrSelf' ? [actor,...(ally ? [ally] : [])] : foes;
    const damage = move.category !== 'Status';
    if (damage && ['self','adjacentAlly','adjacentAllyOrSelf','allySide','allyTeam'].includes(targetKind)) continue;
    for (const target of targets) {
      const optionWarnings = [...warnings];
      const recipients = target ? [target] : ['allAdjacentFoes','allAdjacent','all','randomNormal'].includes(targetKind) ? foes : [];
      const blocks = recipients.map(recipient => ({recipient,reason:knownBlock(ctx,actor,recipient,move,optionWarnings)}));
      if (!transition) {
        for (const block of blocks.filter(block => block.reason)) blocked.push({actorId:actor.id,move:move.name,targetId:block.recipient.id,reason:block.reason});
        if (target && blocks[0]?.reason || !target && damage && (!recipients.length || blocks.every(block => block.reason))) continue;
        if (!target && blocks.some(block => block.reason)) optionWarnings.push('This spread move cannot affect every current foe; only eligible recipients offer progress.');
      } else if (blocks.some(block => block.reason)) optionWarnings.push(`Current-form eligibility is unresolved after the selected own Mega: ${unique(blocks.filter(block=>block.reason).map(block=>block.reason)).join('; ')}.`);
      if (damage && ['allAdjacent','all'].includes(targetKind)) optionWarnings.push('This move can hit the partner; partner immunity or protection requires a separate check.');
      if (target && !target.own && ['normal','any','adjacentFoe'].includes(targetKind)) {
        const redirects = foes.filter(foe => foe.id !== target.id && (foe.moves.some(name => ['followme','ragepowder'].includes(championsDex.moves.get(name).id)) || ['stormdrain','lightningrod'].includes(activeAbility(foe))));
        if (redirects.length) optionWarnings.push(`Plausible redirection from ${redirects.map(foe => foe.id).join(', ')} can change this recipient; delivery is unverified.`);
        // Existing observed redirection is an eligibility issue, not proof the
        // opposing user will choose redirection again on the next turn.
        const redirector = redirects.find(foe => hasVolatile(foe,'followme') || hasVolatile(foe,'ragepowder'));
        if (redirector) optionWarnings.push(`Observed redirection on ${redirector.id} must be resolved at execution.`);
      }
      let kind = PROTECT.has(move.id) ? 'protect' : DENIAL.has(move.id) || move.status ? 'denial' : damage ? 'attack' : 'support';
      if (['encore','disable'].includes(move.id)) optionWarnings.push(`${move.name} needs an eligible prior move; that dependency is not established by legal selection.`);
      // Unknown status filler is not evidence of useful partner progress.
      if (kind === 'support' && !moveCapabilities(move).some(value => ['setup','speed-control','weather','terrain','recovery','redirection'].includes(value)) && move.id !== 'helpinghand') continue;
      const action = {type:'move',slot:moveIndex + 1,...(target ? {target:target.own ? -target.slot : target.slot} : {}),...(mega?{mega:true}:{})};
      // These are current eligible recipients only, not successful effects.
      // A selected form transition or observed redirection cannot inherit this
      // current-form recipient claim.
      const recipientIds = transition || optionWarnings.some(warning=>warning.startsWith('Observed redirection changes the recipient')) ? [] :
        blocks.filter(block=>!block.reason&&!block.recipient.own).map(block=>block.recipient.id);
      result.push({action,kind,actor,move,recipientIds,warnings:optionWarnings,currentFormBlocked:transition&&blocks.some(block=>block.reason)});
    }
  }
  for (const replacement of (mega?[]:replacementOptions(request)).filter(value => value.forSlots.includes(index + 1))) {
    const reserve = ctx.actors.filter(value => value.own && value.selected === 'selected' && value.raw?.requestIndex === replacement.slot && !value.slot && alive(value));
    if (reserve.length !== 1) continue;
    result.push({action:{type:'switch',slot:replacement.slot},kind:'switch',actor,entrant:reserve[0],warnings:[`Entry for ${reserve[0].id} is unverified against both foes' plausible incoming actions; switching is not established safe.`]});
  }
  return result;
}

/** Small advisory pairs. Every emitted pair passes the maintained choice validator. */
function incomingFakeOutUsers(ctx,target) {
  const move=championsDex.moves.get('fakeout');
  // knownBlock is expressed from the acting side's perspective. Reverse only
  // that perspective; a reserve ability never supplies active protection.
  const incoming={...ctx,actors:ctx.actors.map(actor=>({...actor,own:!actor.own}))};
  return ctx.actors.filter(foe=>!foe.own&&foe.slot&&alive(foe)&&foe.moves.some(name=>championsDex.moves.get(name).id==='fakeout')&&firstTurnState(foe)!==false&&
    !knownBlock(incoming,foe,target,move,[])).map(foe=>({actorId:foe.id,firstTurnEligibility:firstTurnState(foe)===true?'eligible':'unknown'}));
}

/** Capability-only dependency warning, independent of candidate ranking. No
 * order, numerical outcome, opposing choice or useful recovery is inferred. */
export function competingFakeOutWarnings(ctx) {
  const request=nativeRequest(ctx?.legalActions);
  if(request.teamPreview||request.forceSwitch||request.active?.length!==2)return [];
  return ctx.actors.filter(actor=>actor.own&&actor.slot&&alive(actor)).flatMap(actor=>{
    const ownOptions=optionsFor(ctx,request,actor.slot-1,[]);
    if(!ownOptions.some(option=>option.move?.id==='fakeout'))return [];
    const opposing=incomingFakeOutUsers(ctx,actor);
    if(!opposing.length)return [];
    return [{code:'COMPETING_FAKE_OUT',actorId:actor.id,firstTurnEligibility:firstTurnState(actor)===true?'eligible':'unknown',opposing}];
  });
}

/** Inspect only the authored pair. No ranking, action generation, numerical
 * order, failed-hit payoff or guaranteed opposing action is inferred. */
export function stagedPairFakeOutWarnings(ctx,actions) {
  const request=nativeRequest(ctx?.legalActions);
  if(request.teamPreview||request.forceSwitch||request.active?.length!==2)return [];
  const canonical=validateChoice(request,actions).actions;
  const selected=canonical.map((action,index)=>{
    const actor=ctx.actors.find(value=>value.own&&value.slot===index+1&&value.selected==='selected'&&alive(value));
    if(!actor||action.type!=='move')return null;
    const legal=request.active[index]?.moves?.[action.slot-1],move=championsDex.moves.get(legal?.id||legal?.move||legal?.name||'');
    return move.exists?{actor,move,action}:null;
  });
  if(selected.some(value=>!value))return [];
  const protect=selected.filter(value=>PROTECT.has(value.move.id));
  if(protect.length!==1)return [];
  const attack=selected.find(value=>value!==protect[0]);
  if(attack.move.category==='Status'||priorityMove(attack.actor,attack.move))return [];
  const hostile=TARGETED.has(attack.move.target)?attack.action.target>0:['allAdjacentFoes','allAdjacent','all','randomNormal'].includes(attack.move.target);
  if(!hostile)return [];
  const opposing=incomingFakeOutUsers(ctx,attack.actor);
  return opposing.length?[{code:'STAGED_SOLE_ATTACK_FAKE_OUT',actorId:attack.actor.id,move:attack.move.name,protectingActorId:protect[0].actor.id,opposing}]:[];
}

/** Factual dependencies of this exact pair, independent of ranking. Move access
 * names possible exposure; it does not predict targeting, order or damage.
 * Two hostile attacks offer an opt-in question for each exposed actor; they do
 * not declare either action necessary or make research compulsory. */
export function stagedPairDependencyWarnings(ctx,actions,{requiredActors=ctx?.objective?.requiredActors??[],preserveIds=ctx?.objective?.preserve??[]}={}) {
  const request=nativeRequest(ctx?.legalActions);
  if(request.teamPreview||request.forceSwitch||request.active?.length!==2)return [];
  const canonical=validateChoice(request,actions).actions;
  const selected=canonical.map((action,index)=>{
    const actor=ctx.actors.find(value=>value.own&&value.slot===index+1&&value.selected==='selected'&&alive(value));
    if(!actor)return null;
    const legal=action.type==='move'?request.active[index]?.moves?.[action.slot-1]:null;
    const move=legal?championsDex.moves.get(legal.id||legal.move||legal.name||''):null;
    const entrant=action.type==='switch'?ctx.actors.find(value=>value.own&&value.selected==='selected'&&!value.slot&&alive(value)&&
      (action.pokemonId===value.id||Number.isInteger(action.slot)&&action.slot===value.raw?.requestIndex)):null;
    return {actor,action,move:move?.exists?move:null,entrant};
  });
  if(selected.some(value=>!value))return [];
  const foes=ctx.actors.filter(foe=>!foe.own&&foe.slot&&alive(foe));
  const hostile=entry=>entry.move&&entry.move.category!=='Status'&&(TARGETED.has(entry.move.target)?entry.action.target>0:['allAdjacentFoes','allAdjacent','all','randomNormal'].includes(entry.move.target));
  const progress=selected.filter(hostile),required=new Set(requiredActors),preserved=new Set(preserveIds),rows=[];
  const incoming={...ctx,actors:ctx.actors.map(actor=>({...actor,own:!actor.own}))};
  for(const [index,entry] of selected.entries()){
    const partner=selected[1-index],protect=entry.move&&PROTECT.has(entry.move.id),roles=[];
    if(protect)continue; // Selected protection never becomes an exposed-actor claim.
    const recipient=entry.entrant??entry.actor;
    if(entry.action.type==='switch'){
      if(!entry.entrant)continue; // Never guess the reserve's current identity.
      roles.push('switch-recipient');
      if(preserved.has(recipient.id))roles.push('preserved-actor');
    }else{
      if(required.has(entry.actor.id))roles.push('required-actor');
      if(preserved.has(entry.actor.id))roles.push('preserved-actor');
      if(entry.move&&moveCapabilities(entry.move).some(value=>['setup','speed-control','weather','terrain'].includes(value)))roles.push('setup-actor');
      if(progress.length===1&&progress[0]===entry&&(partner.move&&PROTECT.has(partner.move.id)||partner.action.type==='switch'))roles.push('sole-progress');
      if(!roles.length&&progress.length===2&&progress.includes(entry))roles.push('paired-progress');
    }
    if(!roles.length)continue;
    const needsAction=roles.some(role=>['required-actor','setup-actor','sole-progress','paired-progress'].includes(role));
    const opposing=foes.flatMap(foe=>{
      const damageMoves=[],denialMoves=[];
      for(const name of foe.moves??[]){
        const move=championsDex.moves.get(name);
        if(!move.exists||!['normal','any','adjacentFoe','allAdjacentFoes','allAdjacent','all','randomNormal'].includes(move.target))continue;
        const damage=move.category!=='Status',denial=DENIAL.has(move.id)||!!move.status;
        if(!damage&&(!needsAction||!denial))continue;
        // A selected Mega or entry can change the target's eligibility. Do not
        // transplant a current-form immunity into that unresolved transition.
        if(entry.action.type!=='switch'&&!entry.action.mega&&knownBlock(incoming,foe,recipient,move,[]))continue;
        if(move.id==='fakeout'&&firstTurnState(foe)===false)continue;
        if(damage)damageMoves.push(move.name);
        if(needsAction&&denial)denialMoves.push(move.name);
      }
      return damageMoves.length||denialMoves.length?[{actorId:foe.id,damageMoves:unique(damageMoves),denialMoves:unique(denialMoves)}]:[];
    });
    if(!opposing.length)continue;
    const pairedSupport=foes.flatMap(foe=>foe.moves?.some(name=>championsDex.moves.get(name).id==='helpinghand')?
      opposing.filter(other=>other.actorId!==foe.id&&other.damageMoves.length).map(other=>({actorId:foe.id,move:'Helping Hand',partnerActorId:other.actorId})):[]);
    const goals={...(entry.entrant?{requiredActionsBy:[entry.actor.id]}:needsAction?{requiredActionsBy:[entry.actor.id]}:{}),
      ...(entry.entrant||preserved.has(recipient.id)?{survive:[recipient.id]}:{})};
    rows.push({code:'PAIR_ACTOR_EXPOSURE',actorId:recipient.id,roles,...(entry.move?{selectedMove:entry.move.name}:{}),
      partnerAction:partner.move&&PROTECT.has(partner.move.id)?'protect':partner.action.type,opposing,pairedSupport,goals});
  }
  return rows;
}

const progressOption = option => ['attack','denial','support'].includes(option.kind);

function objectiveIdentities(ctx) {
  const ids=(values,test)=>(Array.isArray(values)?values:[]).filter(id=>ctx.actors.some(actor=>actor.id===id&&test(actor)));
  const own=actor=>actor.own&&actor.selected==='selected'&&alive(actor),foe=actor=>!actor.own&&actor.slot&&alive(actor);
  return {targets:unique(ids(ctx.objective?.targets,foe)),preserve:unique(ids(ctx.objective?.preserve,own)),requiredActors:unique(ids(ctx.objective?.requiredActors,own))};
}

// Relevance joins named move access/current state to a possible denial route.
// It never assumes the opponent selects that move or the denial acts in time.
function denialRelevant(option,target) {
  const move=option.move;if(!move||!target)return false;
  const moves=(target.moves??[]).map(name=>championsDex.moves.get(name)).filter(value=>value.exists);
  if(['encore','disable'].includes(move.id)||move.id==='fakeout'&&firstTurnState(option.actor)!==true)return false;
  if(['haze','clearsmog','topsyturvy'].includes(move.id))return Object.values(target.boosts??{}).some(value=>value>0);
  if(move.id==='taunt')return moves.some(value=>value.category==='Status');
  if(move.id==='throatchop')return moves.some(value=>value.flags.sound);
  if(move.id==='psychicnoise')return moves.some(value=>moveCapabilities(value).includes('recovery'));
  if(move.status==='brn')return moves.some(value=>value.category==='Physical');
  if(move.id==='imprison')return moves.some(value=>option.actor.moves?.some(name=>championsDex.moves.get(name).id===value.id));
  return DENIAL.has(move.id)||!!move.status;
}

function pairAlignment(ctx,options,objective) {
  const pressure=options.filter(option=>option.move&&(option.move.category!=='Status'||option.kind==='denial')).map(option=>{
    const possibleRecipientIds=option.recipientIds??[],damage=option.move.category!=='Status';
    const activationUnverified=CONDITIONAL.has(option.move.id)||['encore','disable'].includes(option.move.id)||option.move.id==='fakeout'&&firstTurnState(option.actor)!==true;
    const denialRelevantTo=possibleRecipientIds.filter(id=>denialRelevant(option,ctx.actors.find(actor=>actor.id===id)));
    return {actorId:option.actor.id,move:option.move.name,possibleRecipientIds,
      targetIds:possibleRecipientIds.filter(id=>damage&&!activationUnverified||denialRelevantTo.includes(id)),damage,denialRelevantTo,activationUnverified};
  });
  const acting=options.filter(progressOption).map(option=>option.actor.id),protectedOrWithdrawn=options.filter(option=>['protect','switch'].includes(option.kind)).map(option=>option.actor.id);
  const targetIds=unique(pressure.flatMap(row=>row.targetIds));
  const capabilities=unique(options.flatMap(option=>option.move?moveCapabilities(option.move):option.kind==='switch'?['switch']:[])).sort();
  const supportForRequired=options.flatMap((option,index)=>{
    const partner=options[1-index];if(!partner||!objective.requiredActors.includes(partner.actor.id)||!progressOption(partner))return [];
    const support=option.move&&(option.move.id==='helpinghand'&&partner.move?.category!=='Status'||moveCapabilities(option.move).some(value=>['redirection','speed-control'].includes(value)));
    const denial=pressure.some(row=>row.actorId===option.actor.id&&row.denialRelevantTo.length);
    return support||denial?[partner.actor.id]:[];
  });
  return {scope:'qualitative-current-capabilities',pressure,capabilities,supportForRequired:unique(supportForRequired),
    declaredTargetsPressured:objective.targets.filter(id=>targetIds.includes(id)),
    declaredActorsActing:objective.requiredActors.filter(id=>acting.includes(id)),
    declaredActorsProtectedOrWithdrawn:objective.preserve.filter(id=>protectedOrWithdrawn.includes(id)),
    unmet:{targets:objective.targets.filter(id=>!targetIds.includes(id)),requiredActors:objective.requiredActors.filter(id=>!acting.includes(id)),preserve:objective.preserve.filter(id=>!protectedOrWithdrawn.includes(id))},
    deliveryVerified:false};
}

export function buildCandidates(ctx,{maxCandidates = 4} = {}) {
  const warnings = ['Generated candidates are qualitative suggestions; numerical delivery, damage, Speed, and outcomes remain unverified.'], blocked = [];
  const request = nativeRequest(ctx?.legalActions), limit = Number.isInteger(maxCandidates) ? Math.max(0,Math.min(6,maxCandidates)) : 4;
  const coverage = {requestKind:request.teamPreview ? 'preview' : request.forceSwitch ? 'forced-switch' : 'turn',generated:0,purposes:[],missingPurposes:[],legalPairsChecked:0,knownBlockedOptions:blocked,requiredActorExposure:[],heuristicOnly:true};
  const candidates = [], seen = new Set(), seeds=[], objective=objectiveIdentities(ctx);
  const megaWarning='Optional own Mega: post-Mega form, typing, ability, field effects and action delivery remain unresolved; no effect, survival or resource payoff is established.';
  if (request.active?.some(active => active.canMegaEvo)) warnings.push(megaWarning);
  const emit = (purpose,options,actions = options.map(option => option.action)) => {
    if (candidates.length >= limit) return false;
    let validated;
    try {coverage.legalPairsChecked++;validated = validateChoice(request,actions).actions;} catch {return false;}
    const identity = JSON.stringify(validated);
    if (seen.has(identity)) return false;
    seen.add(identity);
    const requiredActors = unique(options.filter(option => ['attack','denial','support'].includes(option.kind)).map(option => option.actor.id));
    const candidateWarnings = options.flatMap(option => option.warnings || []);
    if(validated.some(action=>action.mega))candidateWarnings.push(megaWarning);
    const twoFoes = ctx.actors.filter(actor => !actor.own && actor.slot && alive(actor)).length === 2;
    for (const id of requiredActors) if (twoFoes) {
      candidateWarnings.push(`Required actor ${id} remains exposed to both foes; partner Protect or switching alone does not establish its action delivery.`);
      coverage.requiredActorExposure.push({actorId:id,purpose,code:'TWO_FOE_DELIVERY_UNCHECKED'});
    }
    candidates.push({id:`candidate-${candidates.length + 1}`,purpose,actions:validated,requiredActors,warnings:unique(candidateWarnings),heuristic:true,
      ...(options.length===2?{qualitativeAlignment:pairAlignment(ctx,options,objective)}:{})});
    if(options.length===2)seeds.push({purpose,options});
    return true;
  };
  if (request.teamPreview) warnings.push('Preview candidates require an authored selected-four game plan; no arbitrary team order was generated.');
  else if (request.forceSwitch) {
    for (const actions of legalReplacementPairs(request)) {
      const destinations = actions.flatMap(action => action.type === 'switch' ? ctx.actors.filter(actor => actor.own && actor.selected === 'selected' && actor.raw?.requestIndex === action.slot) : []);
      if (destinations.length !== actions.filter(action => action.type === 'switch').length) continue;
      emit('forced-replacement',[],actions);
    }
    if (!candidates.length) warnings.push('No complete supported forced replacement pair is available from identified selected actors.');
    else for (const candidate of candidates) candidate.warnings.push('Forced entry survival and pending attacks are unverified; a legal replacement is not established safe.');
  } else if (Array.isArray(request.active) && request.active.length === 2) {
    const progress = progressOption;
    // A damaging move can also deny an effect. Its secondary capability must
    // not erase the complete two-damage route from purpose coverage.
    const damaging = option => !!option.move && option.move.category !== 'Status';
    const useful = option => damaging(option) || option.kind === 'support';
    // Only typed identities already present in these current facts order the
    // menu. Objective prose and prior chosen actions are never interpreted.
    const options = [0,1].map(index => optionsFor(ctx,request,index,blocked));
    const pairedSupport = (first,second) => [first,second].every((option,index,pair) => {
      const partner = pair[1 - index];
      if (option.move?.id === 'helpinghand') return !!partner.move && partner.move.category !== 'Status';
      if (['followme','ragepowder','spotlight'].includes(option.move?.id)) return !['protect','switch','pass'].includes(partner.kind) && !['followme','ragepowder','spotlight','helpinghand'].includes(partner.move?.id);
      return true;
    });
    const schemes = [
      ['attack-pressure',(first,second) => damaging(first) && damaging(second)],
      ['denial-plus-progress',(first,second) => first.kind === 'denial' && useful(second) || second.kind === 'denial' && useful(first)],
      ['protect-plus-progress',(first,second) => first.kind === 'protect' && progress(second) || second.kind === 'protect' && progress(first)],
      ['switch-plus-progress',(first,second) => first.kind === 'switch' && progress(second) || second.kind === 'switch' && progress(first)],
      ['control-plus-progress',(first,second) => first.kind === 'support' && progress(second) || second.kind === 'support' && progress(first)],
    ];
    const pool=options[0].flatMap(first=>options[1].filter(second=>pairedSupport(first,second)).map(second=>{
      const pair=[first,second];return {pair,alignment:pairAlignment(ctx,pair,objective)};
    }));
    const rank=entry=>{
      const value=entry.alignment,pressure=value.pressure,target=new Set(objective.targets);
      const covered=unique(candidates.flatMap(candidate=>candidate.qualitativeAlignment?.capabilities??[]));
      const uncertainty=entry.pair.flatMap(option=>option.warnings??[]).filter(warning=>/conditional success|eligibility is unknown|eligible prior move|Observed redirection changes/.test(warning)).length;
      return [value.declaredActorsActing.length,value.declaredActorsProtectedOrWithdrawn.length,value.declaredTargetsPressured.length,
        pressure.reduce((sum,row)=>sum+row.targetIds.filter(id=>target.has(id)&&(row.damage||row.denialRelevantTo.includes(id))).length,0),
        value.supportForRequired.length,unique(pressure.flatMap(row=>row.targetIds)).length,
        value.capabilities.filter(capability=>!covered.includes(capability)).length,-uncertainty,
        pressure.reduce((sum,row)=>sum+row.denialRelevantTo.length,0)];
    };
    const semantic=entry=>entry.pair.map(option=>`${option.actor.id}:${option.kind}:${option.move?.id??option.entrant?.id??''}:${option.action.target??''}`).join('|');
    const compare=(first,second)=>{
      const a=rank(first),b=rank(second);for(let index=0;index<a.length;index++)if(a[index]!==b[index])return b[index]-a[index];
      return semantic(first).localeCompare(semantic(second));
    };
    if(objective.preserve.length)schemes.sort((first,second)=>{
      const a=pool.filter(entry=>first[1](...entry.pair)).sort(compare)[0],b=pool.filter(entry=>second[1](...entry.pair)).sort(compare)[0];
      if(!a||!b)return Number(!a)-Number(!b);
      // A named actor required to act must not lose its only pressure merely
      // because its self-protection sorted before the complete pair.
      return b.alignment.declaredActorsActing.length-a.alignment.declaredActorsActing.length||b.alignment.declaredActorsProtectedOrWithdrawn.length-a.alignment.declaredActorsProtectedOrWithdrawn.length;
    });
    coverage.selection={policy:'complete-pair-objective-capability-v1',objective,
      limitations:['Capability and current-recipient coverage are qualitative; they do not establish removal, denial, action delivery, safety or opposing choices.',
        'Only typed current actor identities are interpreted; objective prose and numerical damage or Speed are not ranked.',
        'Self-protection and withdrawal are preservation routes; required action participation takes precedence when these conflict.',
        'Equal qualitative routes use deterministic move-identity ties; capability diversity does not estimate tactical value.']};
    for (const [purpose,test] of schemes) {
      let found = false;
      for(const entry of pool.filter(entry=>test(...entry.pair)).sort(compare))if(emit(purpose,entry.pair)){found=true;break;}
      if (!found) coverage.missingPurposes.push(purpose);
    }
    // Preserve available purpose representatives first, then spend only the
    // remaining slots on complete alternatives. No variant selects a strategy.
    if(candidates.length<limit){
      const originalSeeds=[...seeds],variantPairs=new Map();
      const canMega=index=>Boolean(request.active[index]?.canMegaEvo)&&ctx.sides?.find(side=>side.id===ctx.ownSide)?.megaUsed!==true&&
        !championsDex.species.get(ctx.actors.find(actor=>actor.own&&actor.slot===index+1)?.species??'').isMega;
      const transitionOptions=[0,1].map(index=>optionsFor(ctx,request,index,[],{transition:true}));
      const megaOptions=[0,1].map(index=>canMega(index)?optionsFor(ctx,request,index,[],{mega:true,transition:true}):[]);
      const consider=(pair,seed,seedIndex)=>{
        if(!pairedSupport(...pair)||!pair.some(option=>option.move&&option.move.category!=='Status'))return;
        const changes=pair.map((option,index)=>({move:option.action.type==='move'&&seed.options[index].action.type==='move'&&option.action.slot!==seed.options[index].action.slot,
          target:option.action.target!==seed.options[index].action.target}));
        const moveChanges=changes.filter(change=>change.move).length,targetChanges=changes.filter(change=>change.target).length,mega=pair.some(option=>option.action.mega);
        if(!mega&&!moveChanges&&!targetChanges)return;
        // Prefer an alternate already-supported move on the same complete
        // target/pair before current-blocked or more distant form hypotheses.
        const identity=JSON.stringify(pair.map(option=>option.action)),prior=variantPairs.get(identity),variant={pair,seedIndex,mega,moveChanges,targetChanges,currentBlocked:pair.some(option=>option.currentFormBlocked)};
        if(!prior||Number(moveChanges!==1)<Number(prior.moveChanges!==1)||moveChanges===prior.moveChanges&&targetChanges<prior.targetChanges)variantPairs.set(identity,variant);
      };
      for(const [seedIndex,seed]of originalSeeds.entries()){
        for(const index of [0,1])for(const option of options[index])if(option.move&&option.move.category!=='Status'){
          const pair=[...seed.options];pair[index]=option;consider(pair,seed,seedIndex);
        }
        for(const index of [0,1])for(const option of megaOptions[index])if(option.move&&option.move.category!=='Status'){
          for(const partner of transitionOptions[1-index]){const pair=[];pair[index]=option;pair[1-index]=partner;
            const scheme=schemes.find(([purpose])=>purpose===seed.purpose);if(scheme?.[1](...pair))consider(pair,seed,seedIndex);
          }
        }
      }
      // A current-form block can leave no base representative at all. Keep
      // that fact, but do not transplant it through an optional own Mega or
      // its possible field change into the partner's eligibility.
      for(const [schemeIndex,[purpose,test]]of schemes.entries())if(!originalSeeds.some(seed=>seed.purpose===purpose)){
        for(const index of [0,1])for(const option of megaOptions[index])if(option.move&&option.move.category!=='Status'){
          for(const partner of transitionOptions[1-index]){const pair=[];pair[index]=option;pair[1-index]=partner;
            if(test(...pair))consider(pair,{purpose,options:pair},originalSeeds.length+schemeIndex);
          }
        }
      }
      const baseCount=candidates.length,variants=[...variantPairs.values()],variantCount=variants.length;
      while(candidates.length<limit&&variants.length){
        const has=(index,test)=>candidates.some(candidate=>test(candidate.actions[index]));
        const novelty=variant=>variant.pair.reduce((value,option,index)=>{
          const action=option.action;if(action.type!=='move')return value;
          value.moves+=Number(!has(index,prior=>prior.type==='move'&&prior.slot===action.slot));
          value.forms+=Number(Boolean(action.mega)&&!has(index,prior=>prior.mega));
          value.targets+=Number(action.target>0&&!has(index,prior=>prior.type==='move'&&prior.target===action.target));
          return value;
        },{moves:0,forms:0,targets:0});
        const targetPattern=pair=>pair.every(damaging)?pair.every(option=>option.action.target>0)?
          pair[0].action.target===pair[1].action.target?'focus':'split':
          pair.some(option=>['allAdjacentFoes','allAdjacent','all'].includes(option.move.target))?'spread':null:null;
        const newPattern=variant=>{
          const pattern=targetPattern(variant.pair);
          return pattern&&!seeds.some(seed=>targetPattern(seed.options)===pattern)?1:0;
        };
        const breadth=variant=>unique(variant.pair.flatMap(option=>option.move?moveCapabilities(option.move):[])).length;
        // Reserve scarce variations for a new form and an uncovered complete
        // damage-target pattern before marginal move novelty. Otherwise a new
        // support move can consume the only slot for a focused two-actor route.
        // Capability breadth is a qualitative tie only, never a payoff claim.
        variants.sort((a,b)=>{const first=novelty(a),second=novelty(b);return Number(a.currentBlocked)-Number(b.currentBlocked)||
          second.forms-first.forms||newPattern(b)-newPattern(a)||second.moves-first.moves||breadth(b)-breadth(a)||
          Number(a.moveChanges!==1)-Number(b.moveChanges!==1)||
          (first.moves||first.forms?a.targetChanges:0)-(second.moves||second.forms?b.targetChanges:0)||
          second.targets-first.targets||a.targetChanges-b.targetChanges||a.seedIndex-b.seedIndex;});
        const variant=variants.shift();emit(variant.mega?'optional-mega-variation':'move-target-variation',variant.pair);
      }
      coverage.variants={considered:variantCount,generated:candidates.length-baseCount,postMegaEffectsVerified:false};
    }
    if (!candidates.length) warnings.push('No useful complete pair could be supported from the current facts and legal request; supply authored candidates or more observations.');
  } else warnings.push('A current actionable doubles legal request is required for generated candidates.');
  coverage.generated = candidates.length; coverage.purposes = unique(candidates.map(candidate => candidate.purpose));
  coverage.requiredActorExposure = coverage.requiredActorExposure.filter((value,index,array) => array.findIndex(other => other.actorId === value.actorId && other.purpose === value.purpose) === index);
  return {candidates,coverage,warnings};
}
