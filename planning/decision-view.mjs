// A display projection only. The complete bound report stays available to the
// operator/checker; omitting a fact never turns it into a verified claim.
import {projectCandidateEvidence,projectCandidateCommandEvidence} from './candidate-evidence.mjs';
import {isDeepStrictEqual} from 'node:util';
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const short = (value,limit=160) => typeof value==='string' ? value.slice(0,limit) : value;
const sourceKeys = ['kind','sessionId','teamId','room','rqid','boardHash','requestDigest','opposingSheetSha256','publishedOpposingSheetSha256','liveFreshness'];
const cautionRank=value=>/redirection|recipient|immun|blocked|cannot|unavailable|denied|conditional|eligibility|first.turn/iu.test(value)?0:/unverified|unknown|exposed|survival/iu.test(value)?1:2;
/** Essential current-recipient mechanics, independent of ranked advice caps. */
export function projectRecipientEffects(report){
  const card=report?.recipientEffects,source=report?.source,hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value),id=value=>typeof value==='string'&&value.length>0&&value.length<=200;
  if(report?.status!=='advisory'||card?.kind!=='current-recipient-effects'||card.scope!=='current-type-immunity-only'||!Array.isArray(card.blocked)||!card.blocked.length||card.blocked.length>16||
    !hash(source?.boardHash)||card.source?.boardHash!==source.boardHash||['requestDigest','opposingSheetSha256'].some(name=>source[name]!==undefined&&(!hash(source[name])||card.source[name]!==source[name])))return;
  if(!card.blocked.every(row=>row.code==='CURRENT_TARGET_TYPE_IMMUNITY'&&id(row.actorId)&&[1,2].includes(row.actorSlot)&&Number.isInteger(row.moveSlot)&&row.moveSlot>=1&&row.moveSlot<=4&&id(row.move)&&[1,2].includes(row.targetSlot)&&id(row.targetId)&&id(row.targetSpecies)&&id(row.moveType)&&id(row.reason))||
    !Array.isArray(card.readRecipients)||card.readRecipients.length>18||!card.readRecipients.every(row=>id(row.id)&&id(row.species)))return;
  return structuredClone(card);
}
/** Small source-bound operator caution, separate from optional ranked advice. */
export function projectControlDeliveryWarnings(report){
  const rows=report?.controlDeliveryWarnings,source=report?.source,id=value=>typeof value==='string'&&value.length>0&&value.length<=200;
  if(report?.status!=='advisory'||!Array.isArray(rows)||!rows.length||rows.length>2||!id(source?.room)||!Number.isSafeInteger(source?.rqid)||
    !/^[a-f0-9]{64}$/.test(source?.boardHash??'')||!/^[a-f0-9]{64}$/.test(source?.requestDigest??''))return;
  const eligible=value=>value==='eligible'||value==='unknown';
  if(!rows.every(row=>row.code==='COMPETING_FAKE_OUT'&&id(row.actorId)&&eligible(row.firstTurnEligibility)&&Array.isArray(row.opposing)&&row.opposing.length>=1&&row.opposing.length<=2&&
    row.opposing.every(foe=>id(foe.actorId)&&eligible(foe.firstTurnEligibility))))return;
  return {kind:'competing-fake-out',status:'possible-unchecked',source:Object.fromEntries(['room','rqid','boardHash','requestDigest'].map(key=>[key,source[key]])),
    actors:rows.map(row=>({actorId:row.actorId,firstTurnEligibility:row.firstTurnEligibility,opposing:row.opposing.map(foe=>({actorId:foe.actorId,firstTurnEligibility:foe.firstTurnEligibility}))})),
    check:'Fake Out may stop ours, freeing its partner. Material denial needs actual MCP order/delivery checks or useful failed-denial recovery; partner Protect/reserve alone is insufficient.',
    limits:'Current active forms. No move order, damage, denial, safe entry or choice proved.'};
}
/** Essential, separately projected factual exposure cards. Every pair remains
 * tied to an exact candidate and source; optional advice trimming must not turn
 * an absent card into an all-clear. This never supplies an opposing choice. */
export function projectPairDependencies(report){
  const rows=report?.pairDependencies,source=report?.source,id=value=>typeof value==='string'&&value.length>0&&value.length<=200;
  const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),names=value=>Array.isArray(value)&&value.length<=8&&value.every(id);
  if(report?.status!=='advisory'||!Array.isArray(rows)||!rows.length||rows.length>6||!Array.isArray(report.candidates)||!id(source?.room)||!Number.isSafeInteger(source?.rqid)||source.rqid<0||!hash(source.boardHash)||
    source.requestDigest!==undefined&&!hash(source.requestDigest)||source.sessionId!==undefined&&!id(source.sessionId)||source.teamId!==undefined&&!hash(source.teamId)||source.opposingSheetSha256!==undefined&&!hash(source.opposingSheetSha256))return;
  const allowedRoles=new Set(['sole-progress','setup-actor','required-actor','preserved-actor','switch-recipient','paired-progress']);
  const validAction=action=>action&&typeof action==='object'&&(
    action.type==='move'&&Object.keys(action).every(key=>['type','slot','target','mega'].includes(key))&&Number.isInteger(action.slot)&&action.slot>=1&&action.slot<=4&&(action.target===undefined||[-2,-1,1,2].includes(action.target))&&(action.mega===undefined||typeof action.mega==='boolean')||
    action.type==='switch'&&Object.keys(action).every(key=>['type','slot','pokemonId'].includes(key))&&((Number.isInteger(action.slot)&&action.slot>=1&&action.slot<=6&&action.pokemonId===undefined)||(id(action.pokemonId)&&action.slot===undefined))||
    action.type==='pass'&&Object.keys(action).length===1);
  const validWarning=row=>row?.code==='PAIR_ACTOR_EXPOSURE'&&id(row.actorId)&&Array.isArray(row.roles)&&row.roles.length>=1&&row.roles.length<=5&&row.roles.every(role=>allowedRoles.has(role))&&
    (row.selectedMove===undefined||id(row.selectedMove))&&['protect','switch','move','pass'].includes(row.partnerAction)&&
    Array.isArray(row.opposing)&&row.opposing.length>=1&&row.opposing.length<=2&&row.opposing.every(foe=>foe&&id(foe.actorId)&&names(foe.damageMoves)&&names(foe.denialMoves)&&(foe.damageMoves.length||foe.denialMoves.length))&&
    Array.isArray(row.pairedSupport)&&row.pairedSupport.length<=2&&row.pairedSupport.every(support=>support&&id(support.actorId)&&support.move==='Helping Hand'&&id(support.partnerActorId)&&support.actorId!==support.partnerActorId&&row.opposing.some(foe=>foe.actorId===support.partnerActorId&&foe.damageMoves.length))&&
    row.goals&&Object.keys(row.goals).length>=1&&Object.keys(row.goals).every(key=>['requiredActionsBy','survive'].includes(key))&&Object.values(row.goals).every(value=>Array.isArray(value)&&value.length>=1&&value.length<=2&&value.every(id));
  if(new Set(rows.map(row=>row?.candidateId)).size!==rows.length||!rows.every(row=>row&&id(row.candidateId)&&Array.isArray(row.actions)&&row.actions.length===2&&row.actions.every(validAction)&&Array.isArray(row.warnings)&&row.warnings.length>=1&&row.warnings.length<=4&&row.warnings.every(validWarning)&&
    report.candidates.filter(candidate=>candidate?.id===row.candidateId&&JSON.stringify(candidate.actions)===JSON.stringify(row.actions)).length===1))return;
  const candidates=rows.map(row=>({candidateId:row.candidateId,actions:structuredClone(row.actions),warnings:row.warnings.map(warning=>({code:warning.code,actorId:warning.actorId,roles:[...warning.roles],
    ...(warning.selectedMove===undefined?{}:{selectedMove:warning.selectedMove}),partnerAction:warning.partnerAction,
    opposing:warning.opposing.map(foe=>({actorId:foe.actorId,damageMoves:[...foe.damageMoves],denialMoves:[...foe.denialMoves]})),
    pairedSupport:warning.pairedSupport.map(support=>({actorId:support.actorId,move:support.move,partnerActorId:support.partnerActorId})),
    goals:Object.fromEntries(Object.entries(warning.goals).map(([key,value])=>[key,[...value]]))}))}));
  return {kind:'pair-dependencies',status:'possible-unchecked',source:Object.fromEntries(['sessionId','teamId','room','rqid','boardHash','requestDigest','opposingSheetSha256'].filter(key=>source[key]!==undefined).map(key=>[key,source[key]])),
    candidates,researchRequired:false,materiality:'author-assessment-required',
    check:'If the payoff materially needs this action or survival, check that named dependency, revise, or identify useful failed-action recovery. Ordinary chip, intentional trades and necessary gambles do not require numerical research solely because this card exists.',
    limits:'Published move access only; no opposing choice, targeting, order, damage, survival or usefulness is established. Selected protection covers only its actor; an absent trigger is never an all-clear.'};
}
function candidateView(candidate,comparison){
  const warnings=[...(candidate.warnings??[])].sort((first,second)=>cautionRank(first)-cautionRank(second)).slice(0,2);
  const index=comparison?.candidates?.findIndex(row=>row.candidateId===candidate.id&&isDeepStrictEqual(row.actions,candidate.actions))??-1;
  const evidence=index>=0?projectCandidateCommandEvidence(comparison.candidates[index],{candidateIndex:index}):undefined;
  return {id:candidate.id,purpose:short(candidate.purpose,100),actions:structuredClone(candidate.actions),heuristic:candidate.heuristic===true,delivery:'unchecked',...(evidence?{evidence}:{}),warnings:warnings.map(value=>short(value,160)),warningTextTruncations:warnings.filter(value=>value.length>160).length};
}
/** Small diagnostic projection; the complete bounded readiness card remains in
 * the full brief. Never copy the private reconstruction or builder input. */
function readinessView(report){
  const card=report.reconstructionReadiness;
  if(card?.kind!=='observed-readiness-card-v1')return;
  const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
  const bound=hash(report.source?.boardHash)&&card.source&&sourceKeys.every(key=>card.source[key]===report.source?.[key]);
  if(!bound)return {kind:card.kind,ready:false,status:'unavailable',reason:'Readiness source does not match this brief.'};
  const text=(value,limit)=>typeof value==='string'?short(value,limit):undefined;
  const hashes=Object.fromEntries(['inputJsonSha256','observedSourceSha256','opposingSheetSha256'].filter(key=>hash(card.hashes?.[key])).map(key=>[key,card.hashes[key]]));
  const missing=Array.isArray(card.missingAuthored)?card.missingAuthored:[],abilities=Array.isArray(card.currentAbilityFacts)?card.currentAbilityFacts:[];
  const first=card.firstSemanticRefusal,counts={};
  for(const key of ['blockers','unevaluated','missingAuthored','authoredRequirements','currentAbilityFacts','knownInputs','consumedObservationInputs']){
    const count=card.counts?.[key];if(Array.isArray(count)&&count.length===3&&count.every(value=>Number.isSafeInteger(value)&&value>=0))counts[key]=[...count];
  }
  const result={kind:card.kind,ready:report.status==='advisory'&&card.ready===true&&card.status==='reconstruction-ready',status:report.status==='advisory'?text(card.status,40):'stale-source',hashes,
    source:Object.fromEntries(sourceKeys.filter(key=>report.source[key]!==undefined).map(key=>[key,report.source[key]])),
    sourceRevalidated:card.sourceRevalidated===true,sourceScope:text(card.sourceScope,64),
    ...(typeof card.reason==='string'?{reason:text(card.reason,160)}:{}),
    currentAbilityApplicability:{requiredMode:'current',noModeInferred:card.currentAbilityApplicability?.noModeInferred===true,
      applicability:text(card.currentAbilityApplicability?.applicability,64),evaluation:text(card.currentAbilityApplicability?.evaluation,64)},
    ...(first?{firstSemanticRefusal:{category:text(first.category,48),message:text(first.message?.text,144)}}:{}),
    missingAuthored:missing.slice(0,2).map(row=>({path:Array.isArray(row.path)?row.path.slice(0,10).map(key=>typeof key==='number'?key:text(key,64)):[]})),
    currentAbilityFacts:abilities.slice(0,2).map(row=>({pokemonId:text(row.pokemonId?.text,80),ability:text(row.ability?.text,80),
      ...(typeof row.listedSupported==='boolean'?{listedSupported:row.listedSupported}:{}),...(row.unknown===true?{unknown:true}:{}),appliesOnlyWhen:'current'})),
    fullCardCounts:counts,projection:{missingAuthoredOmitted:(counts.missingAuthored?.[0]??missing.length)-Math.min(2,missing.length),
      currentAbilityFactsOmitted:(counts.currentAbilityFacts?.[0]??abilities.length)-Math.min(2,abilities.length)},
    scope:'Input reconstruction only; no live freshness, native acceptance or effects proved. Full diagnostics remain in the full brief.'};
  return result;
}
export function projectDecisionView(report,{maxBytes=4096,legalActions}={}) {
  if(!Number.isInteger(maxBytes)||maxBytes<2048)throw new RangeError('Decision view budget must be at least 2048 bytes');
  const allCandidates=report.status==='advisory'?report.candidates??[]:[];
  const completeDamage=report.numericChecks?.damage?.filter(row=>row.status==='complete')??[];
  const allOrder=report.order??[],allThreats=report.threats??[],allPriorities=report.priorities??[],allWarnings=report.warnings??[];
  const warningCodes=[...new Set(allWarnings.map(row=>row.code))];
  const allBlocked=report.coverage?.candidates?.knownBlockedOptions??[];
  const objective=report.objective??{};
  const expectedComparison=legalActions?projectCandidateEvidence(report,{legalActions}):undefined;
  const comparison=expectedComparison?.status==='advisory'&&isDeepStrictEqual(expectedComparison,report.candidateEvidence)?expectedComparison:undefined;
  const reconstructionReadiness=readinessView(report);
  const view={schemaVersion:1,kind:'champions-turn-decision',briefId:report.briefId,status:report.status,
    source:Object.fromEntries(sourceKeys.filter(key=>report.source?.[key]!==undefined).map(key=>[key,report.source[key]])),
    ...(reconstructionReadiness?{reconstructionReadiness}:{}),
    objective:{description:short(objective.description,180),requiredActors:(objective.requiredActors??[]).slice(0,2),preserve:(objective.preserve??[]).slice(0,2),targets:(objective.targets??[]).slice(0,2)},
    candidates:allCandidates.slice(0,3).map(candidate=>candidateView(candidate,comparison)),
    priorities:allPriorities.slice(0,2).map(row=>({tier:row.tier,actorId:row.actorId,targetId:row.targetId,evidence:row.evidence,mechanisms:row.mechanisms?.slice(0,4),reason:short(row.reason,100)})),
    knownBlockedOptions:allBlocked.slice(0,2).map(row=>({actorId:row.actorId,move:row.move,targetId:row.targetId,reason:short(row.reason,120)})),
    threats:allThreats.slice(0,2).map(row=>({sourceId:row.sourceId,targetId:row.targetId,move:row.move,scenarioId:row.scenarioId,range:row.range,hp:row.hp,speedRelation:row.speedRelation,delivery:'unverified',checkId:row.receipt?.checkId})),
    order:allOrder.slice(0,2).map(row=>({scenarioId:row.scenarioId,status:row.status,groups:row.groups?.map(group=>({labels:group.labels,tie:group.tie})),checkId:row.checkId})),
    criticalUnknowns:{actionDelivery:'Unchecked through both opposing actions; a legal pair or range is not a knockout or safety proof.',
      opposingInvestments:'Unrevealed opposing investments remain unknown; named scenarios are conditional.',
      numericalChecks:(report.coverage?.numerics?.attemptedCalls??0)===0?'none-performed-or-only-cached; inspect references before relying on numbers':'partial-conditional-checks; omitted or unsupported checks remain unknown',
      unavailableDamage:report.numericChecks?.unavailableCount??(report.numericChecks?.damage??[]).filter(row=>row.status!=='complete').length,
      unavailableOrder:allOrder.filter(row=>row.status!=='complete'||row.unavailable?.length).length,
      sourceRevalidated:report.coverage?.sourceRevalidated===true,
      warningCodes:warningCodes.slice(0,8).map(value=>short(value,48)),
      fieldTransitionCount:report.fieldTransitions?.length??0},
    coverage:{numericCalls:report.coverage?.numerics?.attemptedCalls??0,completedDamage:completeDamage.length,budgetExhausted:report.coverage?.numerics?.budgetExhausted===true,callLimitReached:report.coverage?.numerics?.callLimitReached===true},
    ...(comparison?{candidateEvidence:{kind:comparison.kind,sourceRef:'source',coverage:comparison.coverage,limits:comparison.limits}}:{}),
    viewCoverage:{mode:'decision',maxBytes,fullViewAvailable:true,compactViewAvailable:true,omitted:{},meaning:'Advisory candidates require explicit selection. Full assumptions, evidence, warnings and actor details remain in richer views.'}};
  const update=()=>{view.viewCoverage.omitted={candidates:allCandidates.length-view.candidates.length,priorities:allPriorities.length-view.priorities.length,threats:allThreats.length-view.threats.length,orderScenarios:allOrder.length-view.order.length,
    objectiveActorReferences:['requiredActors','preserve','targets'].reduce((sum,key)=>sum+(objective[key]?.length??0)-view.objective[key].length,0),knownBlockedOptions:allBlocked.length-view.knownBlockedOptions.length,damageRows:report.numericChecks?.damage?.length??0,warningMessages:allWarnings.length,warningCodes:warningCodes.length-view.criticalUnknowns.warningCodes.length,
    candidateWarnings:allCandidates.reduce((sum,candidate)=>sum+(candidate.warnings?.length??0),0)-view.candidates.reduce((sum,candidate)=>sum+(candidate.warnings?.length??0),0),
    warningTextTruncations:view.candidates.reduce((sum,candidate)=>sum+(candidate.warnings?candidate.warningTextTruncations??0:0),0)+warningCodes.slice(0,8).filter(value=>typeof value==='string'&&value.length>48).length+view.knownBlockedOptions.filter((row,index)=>(allBlocked[index]?.reason?.length??0)>120).length,
    actorCards:report.actors?.length??0,candidateEvidenceRows:(comparison?.candidates.length??0)-view.candidates.filter(candidate=>candidate.evidence).length,
    reconstructionReadinessRows:reconstructionReadiness?(reconstructionReadiness.projection?.missingAuthoredOmitted??0)+(reconstructionReadiness.projection?.currentAbilityFactsOmitted??0):0};};
  update();
  // Stable trimming keeps binding/unknowns and each retained pair intact. IDs
  // and complete actions are never truncated to satisfy the display budget.
  for(const key of ['order','threats','priorities'])while(bytes(view)>maxBytes&&view[key].length){view[key].pop();update();}
  // The exact comparison also lives with the essential operator cue/full
  // receipt. Do not lose a complete legal pair merely to duplicate that card.
  if(bytes(view)>maxBytes&&view.candidateEvidence){delete view.candidateEvidence;for(const candidate of view.candidates)delete candidate.evidence;update();}
  while(bytes(view)>maxBytes&&view.knownBlockedOptions.length>1){view.knownBlockedOptions.pop();update();}
  while(bytes(view)>maxBytes&&view.candidates.length>1){view.candidates.pop();update();}
  if(bytes(view)>maxBytes){for(const candidate of view.candidates){delete candidate.purpose;delete candidate.warnings;delete candidate.warningTextTruncations;}delete view.objective.description;update();}
  while(bytes(view)>maxBytes&&['requiredActors','preserve','targets'].some(key=>view.objective[key].length)){
    const key=['targets','preserve','requiredActors'].find(key=>view.objective[key].length);view.objective[key].pop();update();
  }
  if(bytes(view)>maxBytes){view.candidates=[];update();}
  if(bytes(view)>maxBytes){view.knownBlockedOptions=[];update();}
  if(bytes(view)>maxBytes)throw new Error('Decision source binding exceeds the bounded display budget; request compact/full view');
  return view;
}
