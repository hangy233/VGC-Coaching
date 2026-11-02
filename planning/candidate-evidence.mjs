// Pure presentation over existing receipts. This module neither calculates nor
// dispatches research, chooses a pair, or supplies a battle-control guard.
import {isDeepStrictEqual as same} from 'node:util';
import {digest,requestDigest} from './identity.mjs';

const copy=value=>structuredClone(value);
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const name=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]/gu,'');
const text=value=>typeof value==='string'&&value.length>0&&value.length<=200;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const list=value=>Array.isArray(value)?value:[];
const strings=value=>Array.isArray(value)&&value.length<=32&&value.every(row=>typeof row==='string'&&row.length<=1000);
const identityKeys=['kind','sessionId','teamId','room','rqid','boardHash','requestDigest','opposingSheetSha256','publishedOpposingSheetSha256'];
const sourceIdentity=source=>Object.fromEntries(identityKeys.filter(key=>source?.[key]!==undefined).map(key=>[key,copy(source[key])]));
const validSource=source=>hash(source?.boardHash)&&hash(source?.opposingSheetSha256)&&(
  source.kind==='explicit-hypothetical-snapshot'||source.kind==='bound-observed-turn'&&text(source.sessionId)&&hash(source.teamId)&&text(source.room)&&
  Number.isSafeInteger(source.rqid)&&source.rqid>=0&&hash(source.requestDigest));
const bound=(row,source)=>row?.source===undefined||same(sourceIdentity(row.source),sourceIdentity(source));
const current=actor=>actor&&actor.hp?.current!==0&&actor.raw?.fainted!==true;
const selected=actor=>actor?.selected===true||actor?.selected==='selected';
const exactHP=hp=>Number.isInteger(hp?.current)&&hp.current>0&&['server-own-exact','exact','actual','scenario-actual'].includes(hp.precision);
const unavailable=(claim,reason,extra={})=>({claim,status:'unavailable',reason,...extra});
const actionValid=action=>object(action)&&(
  action.type==='move'&&Object.keys(action).every(key=>['type','slot','target','mega'].includes(key))&&Number.isInteger(action.slot)&&action.slot>=1&&action.slot<=4&&
    (action.target===undefined||[-2,-1,1,2].includes(action.target))&&(action.mega===undefined||typeof action.mega==='boolean')||
  action.type==='switch'&&Object.keys(action).every(key=>['type','slot','pokemonId'].includes(key))&&
    (Number.isInteger(action.slot)&&action.slot>=1&&action.slot<=6&&action.pokemonId===undefined||text(action.pokemonId)&&action.slot===undefined)||
  action.type==='pass'&&Object.keys(action).length===1);

function actionContext(candidate,actors,legalActions){
  return candidate.actions.map((action,index)=>{
    const matches=actors.filter(actor=>actor.own===true&&actor.slot===index+1&&current(actor));
    const actor=matches.length===1?matches[0]:null;
    // actor.moves merges set/history/request information; it is not slot order.
    const move=action.type==='move'?legalActions?.active?.[index]?.moves?.[action.slot-1]:null;
    const moveName=typeof move==='string'?move:move?.id??move?.move??move?.name;
    let targets=[];
    if(action.type==='move'&&Number.isInteger(action.target))targets=actors.filter(value=>current(value)&&value.own===(action.target<0)&&value.slot===Math.abs(action.target));
    else if(action.type==='move'&&['allAdjacentFoes','allAdjacent'].includes(move?.target))targets=actors.filter(value=>current(value)&&value.slot&&value.id!==actor?.id&&(move.target==='allAdjacent'||!value.own));
    return {actor,action,move:text(moveName)?moveName:null,targets};
  });
}

function knownSnapshotMatches(actor,options,species,scenarioId){
  if(!actor||name(actor.species)!==name(species)||!object(options))return false;
  if(scenarioId==='observed'&&(!actor.nature||!actor.statPoints||!actor.ability||actor.itemKnown!==true))return false;
  for(const key of ['nature','ability'])if(actor[key]&&name(actor[key])!==name(options[key]))return false;
  if(actor.itemKnown===true&&name(actor.item)!==name(options.item))return false;
  if(actor.statPoints&&!same(actor.statPoints,options.evs))return false;
  if(actor.boosts&&!same(actor.boosts,options.boosts))return false;
  if(name(actor.status)!==name(options.status))return false;
  return !exactHP(actor.hp)||options.curHP===actor.hp.current;
}

function numericContextMatches(check,report,scenarioId,numericContext){
  const context=check?.inputContext;
  return context?.kind==='planning-numeric-context-v1'&&object(report.field)&&Array.isArray(numericContext?.sides)&&Array.isArray(numericContext.hypotheses)&&
    context.inputSha256===digest({tool:check.tool,input:check.input})&&context.fieldSha256===digest(report.field)&&
    context.sidesSha256===digest(numericContext.sides)&&context.hypothesesSha256===digest(numericContext.hypotheses)&&context.scenarioId===scenarioId;
}

function numericRow(row,index,report,actors,checks,contexts,canCredit,numericContext){
  const base={claim:'damage-range',scenarioId:row.scenarioId,attackerId:row.attackerId,defenderId:row.defenderId,move:row.move,route:row.route,
    ref:{kind:'damage-row',index,checkId:row.checkId??null}};
  const refuse=reason=>({...base,status:'unavailable',reason});
  if(!canCredit||!bound(row,report.source))return refuse('Source is stale, unvalidated or mixed.');
  const matches=checks.filter(check=>check.id===row.checkId);
  if(matches.length!==1)return refuse('Exact parent calculator check is missing or ambiguous.');
  const check=matches[0],input=check.input,result=check.result;
  if(!numericContextMatches(check,report,row.scenarioId,numericContext))return refuse('Exact numerical input, field, side conditions or scenario context is unbound or changed.');
  if(row.status!=='complete'||check.status!=='complete'||check.tool!=='calculate_damage'||!bound(check,report.source)||!bound(result,report.source)||
    input?.gen!==0||result?.gen!==0||!Array.isArray(row.range)||row.range.length!==2||!row.range.every(Number.isFinite)||!same(row.range,result.range)||
    !same(row.attackerHP,result.attackerHP??null)||!same(row.defenderHP,result.defenderHP??null)||
    !object(check.receipt)||check.receipt.checkId!==check.id||!same(row.receipt,check.receipt)||!same(check.receipt.calculationRef,result.calculationRef??null))return refuse('Incomplete, contradictory or unsupported parent calculator evidence.');
  const scenario=list(report.order).filter(value=>value.scenarioId===row.scenarioId&&bound(value,report.source));
  if(!text(row.scenarioId)||!strings(row.assumptions)||!strings(row.warnings)||scenario.length!==1||!strings(scenario[0].assumptions)||
    row.scenarioId!=='observed'&&(!scenario[0].assumptions.length||!row.assumptions.length||!scenario[0].assumptions.every(value=>row.assumptions.includes(value))))return refuse('Exact scenario or explicit assumptions are unavailable.');
  const attacker=actors.find(actor=>actor.id===row.attackerId),defender=actors.find(actor=>actor.id===row.defenderId);
  if(name(input.move)!==name(row.move)||!knownSnapshotMatches(attacker,input.attackerOptions,input.attacker,row.scenarioId)||
    !knownSnapshotMatches(defender,input.defenderOptions,input.defender,row.scenarioId))return refuse('Calculator inputs do not match these exact current actors, forms or known assumptions.');
  const acting=contexts.find(context=>context.actor?.id===row.attackerId);
  if(attacker.own&&(!acting||acting.action.type!=='move'||!acting.move||name(acting.move)!==name(row.move)||!acting.targets.some(actor=>actor.id===row.defenderId)))return refuse('Range does not bind to the selected move slot and recipient.');
  if(contexts.some(context=>context.action.mega&&(context.actor?.id===attacker.id||context.actor?.id===defender.id)))return refuse('Selected Mega changes this actor; current-form inputs do not establish post-Mega damage.');
  if(contexts.some(context=>context.action.type==='switch'&&context.actor?.id===defender.id))return refuse('Selected switch changes the recipient; outgoing-actor damage is not entrant evidence.');
  return {...base,status:'supported',range:copy(row.range),assumptions:row.assumptions.length,warnings:row.warnings.length,
    scope:'snapshot-range-only',delivery:'unavailable'};
}

function orderRows(report,actors,checks,contexts,canCredit,numericContext){
  return list(report.order).slice(0,4).map((row,index)=>{
    const ref={kind:'order-row',index,scenarioId:row.scenarioId,checkId:row.checkId??null};
    const missing=reason=>unavailable('equal-priority-order',reason,{scenarioId:row.scenarioId,ref});
    if(!canCredit||!bound(row,report.source))return missing('Source is stale, unvalidated or mixed.');
    if(contexts.some(context=>context.action.mega||context.action.type==='switch'))return missing('Selected form or entry transition is not resolved by current-state Speed.');
    const matches=checks.filter(check=>check.id===row.checkId),check=matches.length===1?matches[0]:null;
    if(!numericContextMatches(check,report,row.scenarioId,numericContext))return missing('Exact numerical input, field, side conditions or scenario context is unbound or changed.');
    if(row.status!=='complete'||check?.status!=='complete'||check.tool!=='calculate_speed'||check.input?.gen!==0||check.result?.gen!==0||
      !bound(check,report.source)||!Array.isArray(row.groups)||!Array.isArray(row.pokemon)||!same(row.groups,check.result.order)||!same(row.pokemon,check.result.pokemon)||!same(row.field,check.input.field)||
      !same(row.receipt,check.receipt)||check.receipt?.checkId!==check.id||!same(check.receipt.calculationRef,check.result.calculationRef??null)||
      !strings(row.assumptions)||!strings(row.warnings)||row.scenarioId!=='observed'&&!row.assumptions.length)return missing('Exact complete parent Speed result or assumptions are unavailable.');
    const inputs=list(check.input.pokemon);
    if(!inputs.length||inputs.some(input=>{
      const actor=actors.find(actor=>actor.id===input.label);
      return !actor||name(actor.species)!==name(input.species)||actor.nature&&name(actor.nature)!==name(input.nature)||
        actor.ability&&name(actor.ability)!==name(input.ability)||actor.itemKnown===true&&name(actor.item)!==name(input.item)||actor.statPoints&&!same(actor.statPoints,input.statPoints);
    }))return missing('Speed actor identity, form or known inputs differ.');
    return {claim:'equal-priority-order',status:'supported',scenarioId:row.scenarioId,assumptions:row.assumptions.length,warnings:row.warnings.length,
      missingActors:list(row.unavailable).length,scope:'listed-equal-priority-only',delivery:'unavailable',ref};
  });
}

function deliverySourceMatches(source,planning){
  if(planning?.kind!=='bound-observed-turn'||!object(source)||!hash(source.token))return false;
  return ['sessionId','teamId','room','rqid'].every(key=>same(source[key],planning[key]))&&requestDigest({...source,boardHash:planning.boardHash})===planning.requestDigest;
}
function boundAction(action,source){
  if(action.type!=='switch')return action;
  const matches=list(source?.ownRequestOrder).filter(row=>action.slot!==undefined?row.requestIndex===action.slot:row.controlPokemonId===action.pokemonId||row.snapshotId===action.pokemonId);
  return matches.length===1?{type:'switch',pokemonId:matches[0].controlPokemonId}:null;
}
function controlIdentity(actorId,source){
  const matches=list(source?.ownRequestOrder).filter(row=>row.controlPokemonId===actorId||row.snapshotId===actorId);
  return matches.length===1?matches[0].controlPokemonId:null;
}
function deliverySamples(report,candidate,contexts,canCredit){
  const output=[],allEnvelopes=list(report.deliveryEvidence),envelopes=allEnvelopes.slice(0,12);
  const coverage={envelopes:0,validatedEnvelopes:0,invalidEnvelopes:0,expectedSamples:0,validatedSamples:0};
  const invalid=()=>{coverage.invalidEnvelopes++;};
  if(allEnvelopes.length>12)return {samples:[],coverage:{...coverage,invalidEnvelopes:1,omittedEnvelopes:allEnvelopes.length-12}};
  for(const [evidenceIndex,envelope] of envelopes.entries()){
    if(envelope?.candidateId!==candidate.id)continue;
    coverage.envelopes++;
    const result=envelope?.result;
    if(!canCredit||!same(envelope.actions,candidate.actions)||!validSource(envelope.source)||
      !same(sourceIdentity(envelope.source),sourceIdentity(report.source))||result?.coverage?.sampleOnly!==true||result.coverage.suppliedOpposingBranchesOnly!==true||
      !deliverySourceMatches(result.source,report.source)){invalid();continue;}
    const entries=list(result.checkedCandidates).filter(entry=>entry.id===candidate.id&&entry.checked===true&&same(entry.ourActions,candidate.actions)&&
      deliverySourceMatches(entry.source,report.source));
    if(entries.length!==1){invalid();continue;}
    const entry=entries[0],branches=list(entry.branches);
    coverage.expectedSamples+=branches.length*list(entry.seeds).length;
    if(!branches.length||branches.length>3||new Set(branches.map(branch=>branch.id)).size!==branches.length||!Array.isArray(entry.seeds)||
      !entry.seeds.length||entry.seeds.length>8||!entry.seeds.every(seed=>Array.isArray(seed)&&seed.length===4&&seed.every(Number.isSafeInteger))||
      new Set(entry.seeds.map(seed=>JSON.stringify(seed))).size!==entry.seeds.length||!same(entry.seeds,result.seeds)||entry.hypotheses===undefined||!same(entry.hypotheses,result.hypotheses)){
      invalid();continue;
    }
    const pending=[];let envelopeValid=true;
    for(const [branchIndex,branch] of branches.entries()){
      const samples=list(branch.samples);
      if(!text(branch.id)||!Array.isArray(branch.opposingActions)||branch.opposingActions.length!==2||!branch.opposingActions.every(actionValid)||
        samples.length!==entry.seeds.length||!object(branch.objective)||!Array.isArray(branch.objective.requiredActionsBy)||!branch.objective.requiredActionsBy.length||
        new Set(branch.objective.requiredActionsBy).size!==branch.objective.requiredActionsBy.length){envelopeValid=false;break;}
      const seen=new Set();
      for(const [sampleIndex,sample] of samples.entries()){
        const key=JSON.stringify(sample.seed);
        if(seen.has(key)||!entry.seeds.some(seed=>same(seed,sample.seed))||sample.sampleOnly!==true||!['next-turn','forced-replacement','battle-ended'].includes(sample.boundary)||
          !Array.isArray(sample.pendingActions)||sample.noPendingContinuation!==(sample.pendingActions.length===0)||!Array.isArray(sample.requiredActions)||!Array.isArray(sample.surviveGoals)||!Array.isArray(sample.fieldGoals)||
          !same(sample.requiredActions.map(goal=>goal.id),branch.objective.requiredActionsBy)||!same(sample.surviveGoals.map(goal=>goal.id),branch.objective.survive??[])||
          !same(sample.fieldGoals.map(goal=>goal.name),Object.keys(branch.objective.field??{}))||
          !sample.fieldGoals.every(goal=>same(goal.expected,branch.objective.field?.[goal.name]))||
          ![...sample.requiredActions,...sample.surviveGoals,...sample.fieldGoals].every(goal=>['passed','failed','unknown'].includes(goal.status))||
          sample.passed!==(sample.pendingActions.length===0&&[...sample.requiredActions,...sample.surviveGoals,...sample.fieldGoals].every(goal=>goal.status==='passed'))||
          !Array.isArray(sample.actionAttempts)||sample.actionAttempts.length!==contexts.length||
          new Set(sample.actionAttempts.map(attempt=>attempt.id)).size!==sample.actionAttempts.length){envelopeValid=false;break;}
        seen.add(key);
        const attempts=contexts.map(context=>{
          const matches=sample.actionAttempts.filter(attempt=>controlIdentity(attempt.id,entry.source)===context.actor?.id);
          const attempt=matches.length===1?matches[0]:null;
          return attempt&&same(attempt.authored,boundAction(context.action,entry.source))&&typeof attempt.faintedBeforeAction==='boolean'&&
            typeof attempt.pendingAtBoundary==='boolean'&&Array.isArray(attempt.denials)?attempt:null;
        });
        if(attempts.some(attempt=>!attempt)){envelopeValid=false;break;}
        const ref={kind:'checked-delivery-sample',evidenceIndex,branchIndex,sampleIndex,branchId:branch.id,seed:copy(sample.seed),
          hypothesesSha256:digest(entry.hypotheses)};
        const goals=[];
        for(const goal of sample.requiredActions){
          const actorId=controlIdentity(goal.id,entry.source),contextIndex=contexts.findIndex(row=>row.actor?.id===actorId),context=contexts[contextIndex],attempt=attempts[contextIndex];
          if(!context||!same(goal.authored,boundAction(context.action,entry.source))||!same(attempt?.authored,goal.authored)||
            !Array.isArray(goal.denials)||typeof goal.pendingAtBoundary!=='boolean'){envelopeValid=false;break;}
          const switchAction=context.action.type==='switch'?boundAction(context.action,entry.source):null;
          const entrantId=controlIdentity(goal.entrantId,entry.source);
          const delivered=goal.status==='passed'&&attempt.faintedBeforeAction===false&&attempt.pendingAtBoundary===false&&goal.pendingAtBoundary===false&&
            Array.isArray(goal.denials)&&!goal.denials.length&&Array.isArray(attempt.denials)&&!attempt.denials.length&&
            (context.action.type==='move'&&goal.nativeMoveResult===true&&attempt.nativeMoveResult===true&&name(goal.attemptedMove)===name(context.move)||
              switchAction&&entrantId===switchAction.pokemonId&&controlIdentity(attempt.entrantId,entry.source)===entrantId);
          goals.push({claim:'action-delivery',actorId,status:delivered?'supported':goal.status==='failed'?'denied':'unavailable',
            ...(switchAction&&delivered?{entrantId}:{}),...(typeof goal.reason==='string'?{reason:goal.reason}:{}),scope:'supplied-branch-and-seed-only',ref});
        }
        if(!envelopeValid)break;
        const survival=sample.surviveGoals.filter(goal=>['passed','failed','unknown'].includes(goal.status)).map(goal=>{
          return {claim:'boundary-survival',actorId:controlIdentity(goal.id,entry.source)??goal.id,status:goal.status==='passed'&&goal.aliveAtBoundary===true&&sample.boundary!=='forced-replacement'?'supported':
            goal.status==='failed'&&goal.aliveAtBoundary===false?'denied':'unavailable',
            ...(typeof goal.reason==='string'?{reason:goal.reason}:{}),scope:'supplied-branch-and-seed-boundary-only',ref};
        });
        const entrySurvival=goals.filter(goal=>goal.status==='supported'&&goal.entrantId).flatMap(goal=>{
          const matches=sample.surviveGoals.filter(survive=>controlIdentity(survive.id,entry.source)===goal.entrantId);
          const survive=matches.length===1?matches[0]:null;
          if(!survive||survive.status!=='passed'||survive.aliveAtBoundary!==true||survive.activeAtBoundary!==true||sample.boundary==='forced-replacement'||sample.noPendingContinuation!==true)return [];
          return [{claim:'entry-survival',actorId:goal.entrantId,status:'supported',scope:'supplied-branch-and-seed-completed-boundary-only',ref}];
        });
        const fields=sample.fieldGoals.filter(goal=>['passed','failed','unknown'].includes(goal.status)&&same(goal.expected,branch.objective.field?.[goal.name])).map(goal=>({
          claim:'established-field-at-boundary',name:goal.name,expected:copy(goal.expected),actual:copy(goal.actual),status:goal.status==='passed'&&
            goal.matchedAtBoundary===true&&goal.establishedByRequiredAction===true&&sample.boundary!=='forced-replacement'&&same(goal.actual,goal.expected)&&list(goal.evidence).length>0&&
            goals.some(goal=>goal.status==='supported')?'supported':goal.status==='failed'&&goal.matchedAtBoundary===false?'denied':'unavailable',ref}));
        pending.push({goals,survival,entrySurvival,fields,boundary:sample.boundary,noPendingContinuation:sample.noPendingContinuation,ref});
      }
      if(!envelopeValid)break;
    }
    if(!envelopeValid||pending.length!==branches.length*entry.seeds.length){invalid();continue;}
    coverage.validatedEnvelopes++;coverage.validatedSamples+=pending.length;output.push(...pending);
  }
  // A malformed declared case must not disappear and promote the remaining
  // favorable subset. The exact supplied coverage is adopted as one envelope.
  return {samples:coverage.invalidEnvelopes?[]:output,coverage};
}

function summarizeClaims(claim,actorId,samples,key){
  const perSample=samples.map(sample=>list(sample[key]).filter(row=>row.actorId===actorId)),claims=perSample.flat();
  if(!claims.length)return {actorId,status:'unavailable'};
  const uncheckedSamples=perSample.filter(rows=>rows.length!==1).length;
  return {actorId,status:claims.some(row=>row.status==='denied')?'denied':!uncheckedSamples&&claims.every(row=>row.status==='supported')?'supported':'unavailable',
    scope:'supplied-samples-only',...(uncheckedSamples?{uncheckedSamples}:{}),samples:claims.map(({status,ref})=>({status,ref}))};
}

/** Source-bound comparison of at most three existing complete plans. Numerical
 * rows are joined through their exact parent check, current actor/form, named
 * assumptions and the authoritative move slot. Raw ranges never prove payoff.
 * Optional deliveryEvidence: [{source,candidateId,actions,result:checkDeliveryResult}].
 * Only observed delivery receipts with the exact request token digest join;
 * explicit offline summaries lack sufficient planning-board binding here. */
export function projectCandidateEvidence(report={}, {maxCandidates=3,maxBytes=4096,legalActions=report.legalActions,numericContext=report.numericContext}={}){
  if(!Number.isInteger(maxCandidates)||maxCandidates<1||maxCandidates>3)throw new RangeError('Candidate evidence supports one to three plans');
  if(!Number.isInteger(maxBytes)||maxBytes<2048)throw new RangeError('Candidate evidence budget must be at least 2048 bytes');
  const actors=list(report.actors).slice(0,24),checks=list(report.numericChecks?.checks).slice(0,512),damage=list(report.numericChecks?.damage).slice(0,512),allCandidates=list(report.candidates);
  const sourceOK=validSource(report.source),advisory=report.status==='advisory'&&sourceOK,canCredit=advisory&&report.coverage?.sourceRevalidated===true;
  const card={kind:'candidate-evidence-comparison-v1',source:sourceOK?sourceIdentity(report.source):null,status:advisory?'advisory':'unavailable',
    sourceRevalidated:canCredit,candidates:[],coverage:{inputCandidates:allCandidates.length,compared:0,omittedCandidates:0,rejectedCandidates:0,
      omittedInputRows:Math.max(0,list(report.actors).length-24)+Math.max(0,list(report.numericChecks?.checks).length-512)+Math.max(0,list(report.numericChecks?.damage).length-512),
      omittedProjectionRows:0,ranking:'none',fullEvidenceRequired:true},
    limits:'Refs address exact parent report rows, including omitted assumptions/warnings and supplied branches/seeds. Ranges do not prove delivery, removal, survival or continuation. Samples prove no guarantee. No ranking or control approval.'};
  const objective=report.objective??{},preserved=list(objective.preserve).slice(0,6),required=list(objective.requiredActors).slice(0,4),targets=list(objective.targets).slice(0,6);
  for(const candidate of allCandidates.slice(0,6)){
    if(card.candidates.length>=maxCandidates)break;
    if(!advisory||!text(candidate?.id)||allCandidates.filter(row=>row?.id===candidate.id).length!==1||!bound(candidate,report.source)||
      !Array.isArray(candidate.actions)||candidate.actions.length!==2||!candidate.actions.every(actionValid)){card.coverage.rejectedCandidates++;continue;}
    const contexts=actionContext(candidate,actors,legalActions),delivery=deliverySamples(report,candidate,contexts,canCredit),samples=delivery.samples;
    const dependencies=list(report.pairDependencies).filter(row=>row.candidateId===candidate.id&&same(row.actions,candidate.actions)&&bound(row,report.source));
    const exposures=dependencies.length===1?list(dependencies[0].warnings).filter(row=>row.code==='PAIR_ACTOR_EXPOSURE').slice(0,4):[];
    const relevant=damage.map((row,index)=>({row,index})).filter(({row})=>contexts.some(context=>context.actor?.id===row.attackerId&&context.action.type==='move'&&
      context.move&&name(context.move)===name(row.move)&&context.targets.some(actor=>actor.id===row.defenderId))||preserved.includes(row.defenderId));
    const requiredIds=[...new Set([...required,...list(candidate.requiredActors)])].filter(text).slice(0,4);
    const mechanical=relevant.slice(0,4).map(({row,index})=>numericRow(row,index,report,actors,checks,contexts,canCredit,numericContext));
    const actionDelivery=requiredIds.map(actorId=>summarizeClaims('action-delivery',actorId,samples,'goals'));
    const preservation=preserved.map(actorId=>summarizeClaims('boundary-survival',actorId,samples,'survival'));
    const targetRemoval=targets.map(targetId=>({targetId,status:'unavailable'}));
    const reserves=actors.filter(actor=>actor.own===true&&!actor.slot&&selected(actor)&&current(actor));
    const continuation={status:'unavailable',selectedReserves:reserves.map(actor=>{const {actorId,...entrySurvival}=summarizeClaims('entry-survival',actor.id,samples,'entrySurvival');
      const {actorId:boundaryActorId,...boundarySurvival}=summarizeClaims('boundary-survival',actor.id,samples,'survival');
      return {actorId,entrySurvival,...(boundarySurvival.samples?{boundarySurvival}:{}),continuation:'unavailable'};})};
    const pendingQuestions=mechanical.filter(row=>row.status==='unavailable').map(row=>({kind:'damage-range',scenarioId:row.scenarioId,attackerId:row.attackerId,defenderId:row.defenderId,move:row.move,route:row.route}));
    for(const context of contexts.filter(row=>row.move&&row.action.type==='move'))for(const target of context.targets.filter(actor=>!actor.own)){
      if(!relevant.some(({row})=>row.attackerId===context.actor?.id&&row.defenderId===target.id&&name(row.move)===name(context.move)))
        pendingQuestions.push({kind:'damage-range',scenarioId:'observed',attackerId:context.actor?.id,defenderId:target.id,move:context.move,route:'active'});
    }
    if(actionDelivery.some(row=>row.status==='unavailable')||preservation.some(row=>row.status==='unavailable'))pendingQuestions.push({kind:'paired-delivery',requiredActionsBy:requiredIds,survive:preserved,authoredBranchesRequired:true});
    if(targets.length)pendingQuestions.push({kind:'target-removal',targets:copy(targets)});
    card.candidates.push({candidateId:candidate.id,actions:copy(candidate.actions),
      objectiveFit:{status:'declared-only',requiredSelected:required.filter(actorId=>contexts.some(context=>context.actor?.id===actorId&&context.action.type!=='pass')),
        requiredAbsent:required.filter(actorId=>!contexts.some(context=>context.actor?.id===actorId&&context.action.type!=='pass')),
        targeted:targets.filter(targetId=>contexts.some(context=>context.targets.some(actor=>actor.id===targetId))),effect:'unavailable'},
      currentExposure:{status:exposures.length?'supported':'unavailable',scope:'capability-only',actors:exposures.map(row=>({actorId:row.actorId,roles:copy(row.roles)})),
        ...(exposures.length?{ref:{kind:'pair-dependencies',candidateId:candidate.id}}:{})},
      payoff:{status:actionDelivery.some(row=>row.status==='denied')?'denied':'unavailable',mechanical,actionDelivery,targetRemoval,
        ...(samples.some(sample=>sample.fields.length)?{fieldState:samples.flatMap(sample=>sample.fields)}:{})},
      ...(delivery.coverage.envelopes||delivery.coverage.invalidEnvelopes?{deliveryCoverage:delivery.coverage}:{}),
      preservation,continuation,order:orderRows(report,actors,checks,contexts,canCredit,numericContext),pendingQuestions,
      fieldTransitions:list(report.fieldTransitions).length,
      omitted:Object.fromEntries(Object.entries({damageRows:Math.max(0,relevant.length-mechanical.length),dependencyWarnings:Math.max(0,(dependencies.length===1?list(dependencies[0].warnings).length:0)-exposures.length),
        orderRows:Math.max(0,list(report.order).length-4),deliveryEnvelopes:Math.max(0,list(report.deliveryEvidence).length-12)}).filter(([,value])=>value>0))});
  }
  card.coverage.compared=card.candidates.length;
  card.coverage.omittedCandidates=allCandidates.length-card.candidates.length-card.coverage.rejectedCandidates;
  // Trim only display facts. Complete identities, pairs and source are never
  // shortened. An omitted supported fact cannot become an affirmative claim.
  for(const candidate of [...card.candidates].reverse()){
    for(const array of [candidate.order,candidate.payoff.mechanical,candidate.currentExposure.actors]){
      while(bytes(card)>maxBytes&&array.length){array.pop();candidate.omitted.displayRows=(candidate.omitted.displayRows??0)+1;card.coverage.omittedProjectionRows++;}
    }
    while(bytes(card)>maxBytes&&candidate.pendingQuestions.length>1){
      const index=candidate.pendingQuestions.findLastIndex(value=>value.kind!=='paired-delivery');
      candidate.pendingQuestions.splice(index>=0?index:candidate.pendingQuestions.length-1,1);
      candidate.omitted.questions=(candidate.omitted.questions??0)+1;card.coverage.omittedProjectionRows++;
    }
    // The exact dependency ref remains even if compact actor details are cut.
  }
  while(bytes(card)>maxBytes&&card.candidates.length){card.candidates.pop();card.coverage.compared--;card.coverage.omittedCandidates++;}
  if(bytes(card)>maxBytes)throw new Error('Candidate evidence source binding exceeds the display budget');
  return card;
}

/** Compact row API; parent source/coverage/limits must travel with these rows. */
export function projectCandidateEvidenceRows(report,options){return projectCandidateEvidence(report,options).candidates;}

/** Join alongside an existing candidate command without repeating its pair.
 * The source/limits/coverage on the parent comparison remain mandatory. */
export function projectCandidateCommandEvidence(row,{candidateIndex}={}){
  if(!object(row)||!text(row.candidateId)||!Array.isArray(row.actions))return;
  const counts=rows=>Object.fromEntries(['supported','denied','unavailable'].map(status=>[status,list(rows).filter(value=>value.status===status).length]));
  const mechanics=list(row.payoff?.mechanical),usable=mechanics.filter(value=>value.status==='supported'),questions=list(row.pendingQuestions);
  const reserves=list(row.continuation?.selectedReserves);
  return {ref:{kind:'candidate-evidence-row',...(Number.isInteger(candidateIndex)&&candidateIndex>=0?{index:candidateIndex}:{candidateId:row.candidateId})},
    payoff:row.payoff?.status??'unavailable',delivery:counts(row.payoff?.actionDelivery),removal:counts(row.payoff?.targetRemoval),
    exposure:row.currentExposure?.status??'unavailable',preservation:counts(row.preservation),
    continuation:{status:'unavailable',selectedReserves:reserves.length,entryUnknown:reserves.filter(value=>value.entrySurvival?.status==='unavailable').length},
    checks:usable.slice(0,2).map(value=>copy(value.ref)),
    ...(questions.length?{question:copy(questions.find(value=>value.kind==='paired-delivery')??questions[0])}:{}),
    omitted:{mechanical:mechanics.length-Math.min(2,usable.length),order:list(row.order).length,questions:Math.max(0,questions.length-1),
      dependencyDetails:list(row.currentExposure?.actors).length,sampleDetails:list(row.payoff?.actionDelivery).reduce((sum,value)=>sum+list(value.samples).length,0)}};
}
