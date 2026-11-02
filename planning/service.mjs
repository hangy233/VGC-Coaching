import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {planningSourceSchema,resolvePlanningSource,boundedSnapshot} from './source.mjs';
import {buildTurnFacts,championsDex,moveCapabilities} from './board.mjs';
import {buildCandidates,competingFakeOutWarnings,stagedPairDependencyWarnings} from './candidates.mjs';
import {buildRecipientEffects} from './recipient-effects.mjs';
import {analyzeNumerics} from './numerics.mjs';
import {projectDecisionView} from './decision-view.mjs';
import {projectCandidateEvidence} from './candidate-evidence.mjs';
import {prepareCandidateResearch} from './candidate-research.mjs';
import {boardDigest,digest,requestDigest} from './identity.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {inspectObservedPositionReadiness} from '../simulation/observed-position-readiness.mjs';
import {projectObservedReadinessCard} from '../simulation/observed-position-preparation.mjs';
import {publishedSheetDigest} from '../simulation/observed-position.mjs';
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const id=z.string().min(1).max(200),record=z.record(z.string(),z.unknown());
const points=z.strictObject(Object.fromEntries(['hp','atk','def','spa','spd','spe'].map(key=>[key,z.number().int().min(0).max(32).optional()]))).refine(p=>Object.values(p).reduce((a,b)=>a+b,0)<=66,'At most 66 native points');
const hypothesis=z.strictObject({id,label:z.string().min(1).max(500),pokemon:z.record(id,z.strictObject({nature:z.string().min(1).max(30).optional(),statPoints:points.optional(),ability:z.string().min(1).max(80).optional(),item:z.string().max(80).optional(),hp:z.union([z.number().int().min(1),z.strictObject({current:z.number().int().min(1),max:z.number().int().min(1).optional()})]).optional()})).refine(values=>Object.keys(values).length<=24,'At most 24 actor hypotheses').default({}),field:z.strictObject({weather:z.string().max(50).optional(),terrain:z.string().max(50).optional(),trickRoom:z.boolean().optional()}).optional()});
const objectiveSchema=z.strictObject({description:z.string().max(1000).optional(),requiredActors:z.array(id).max(4).default([]),preserve:z.array(id).max(6).default([]),targets:z.array(id).max(6).default([])});
export const turnBriefSchema=z.strictObject({request:planningSourceSchema,objective:objectiveSchema.default({requiredActors:[],preserve:[],targets:[]}),hypotheses:z.array(hypothesis).max(3).default([]),
  reconstructionHypotheses:record.optional(),
  candidates:z.array(z.strictObject({id,purpose:z.string().min(1).max(500),actions:z.array(record).min(1).max(2),requiredActors:z.array(id).max(4).default([])})).max(6).optional(),
  maxCandidates:z.number().int().min(1).max(6).default(4),maxCalls:z.number().int().min(0).max(48).default(16),budgetMs:z.number().int().min(100).max(5000).default(3500),retainEvidence:z.boolean().default(false),view:z.enum(['decision','compact','full']).default('compact')});
const unique=values=>[...new Set(values)];
function reconstructionReadiness(input,hypotheses,source,{sourceRevalidated=false,snapshot=false,reason}={}){
  const binding={source:structuredClone(source),sourceRevalidated,sourceScope:snapshot?'caller-owned-exact-snapshot':source.kind==='bound-observed-turn'?'read-and-revalidated-planning-source':'explicit-hypothetical-planning'};
  if(!input)return {kind:'observed-readiness-card-v1',ready:false,status:'unavailable',...binding,
    reason:reason??'No exact observed builder input is available. Explicit hypothetical planning does not establish an observed reconstruction context.'};
  const report=inspectObservedPositionReadiness({...structuredClone(input),...(hypotheses!==undefined?{hypotheses:structuredClone(hypotheses)}:{})});
  const card=projectObservedReadinessCard(report);
  return {...card,...binding,...(!sourceRevalidated&&!snapshot?{ready:false,status:'stale-source',reason:'Planning source changed; captured reconstruction diagnostics cannot endorse current readiness.'}:{})};
}
function exactSnapshotInput(input,{board,legalActions,ownTeam,opponentSheet,source}){
  if(!input||source?.kind!=='bound-observed-turn')return false;
  try{
    const expected=input.expected,observed=input.observed;
    if(observed.sessionId!==source.sessionId||['teamId','room','rqid'].some(key=>expected[key]!==source[key])||
      requestDigest({...expected,sessionId:observed.sessionId,boardHash:source.boardHash})!==source.requestDigest)return false;
    const actions=observed.actions.filter(action=>action.room===expected.room&&action.rqid===expected.rqid&&action.token===expected.token);
    const boards=observed.boards.filter(value=>value.room===expected.room&&value.request?.rqid===expected.rqid);
    return actions.length===1&&boards.length===1&&boardDigest(boards[0],actions[0].legalActions)===boardDigest(board,legalActions)&&
      digest(input.opposingSheet)===digest(opponentSheet)&&digest(input.opposingSheet)===source.opposingSheetSha256&&
      (source.publishedOpposingSheetSha256===undefined||publishedSheetDigest(input.opposingSheet)===source.publishedOpposingSheetSha256)&&
      Teams.pack(Teams.import(input.teamText))===Teams.pack(ownTeam);
  }catch{return false;}
}
function active(ctx,own){return ctx.actors.filter(actor=>actor.own===own&&actor.slot!==null&&actor.raw?.fainted!==true);}
function fieldChanges(ctx){
  const changes=[];
  for(const actor of ctx.actors){
    if(actor.selected==='not-in-current-request')continue;
    const item=championsDex.items.get(actor.item??''),forms=typeof item.megaStone==='string'?[item.megaStone]:Object.values(item.megaStone??{});
    const side=ctx.sides.find(side=>side.id===actor.side);
    if(side?.megaUsed!==true)for(const form of forms){const species=championsDex.species.get(form);if(!species.exists||species.name===actor.species)continue;
      changes.push({actorId:actor.id,kind:'possible-mega',form:species.name,abilities:Object.values(species.abilities),selection:actor.selected,verified:false,limitation:'Eligibility, evolution choice, activation order and resulting field require an authored scenario/native check.'});}
    if(actor.slot===null&&actor.capabilities.some(cap=>['weather','terrain','priority-block'].includes(cap)))changes.push({actorId:actor.id,kind:'possible-entry-effect',capabilities:actor.capabilities,selection:actor.selected,verified:false,limitation:'Registered presence does not establish an opposing selected reserve or a switch.'});
  }
  return changes;
}
function makePriorities(ctx,numerics){
  const rows=[],required=new Set([...ctx.objective.requiredActors,...ctx.objective.preserve]);
  for(const threat of numerics.threats??[])rows.push({tier:required.has(threat.targetId)?1:2,actorId:threat.sourceId,targetId:threat.targetId,reason:required.has(threat.targetId)?'Threat reaches a declared required/preserved actor':'Numerical threat under supplied scenario',evidence:'conditional-calculation',detail:threat});
  for(const foe of active(ctx,false)){
    const mechanisms=foe.capabilities.filter(c=>['denial','setup','speed-control','redirection','weather','terrain','recovery'].includes(c));
    if(mechanisms.length)rows.push({tier:2,actorId:foe.id,reason:'Can deny or enable consequential progress if an eligible action resolves',mechanisms,evidence:'capability-only'});
    if(ctx.objective.targets.includes(foe.id))rows.push({tier:1,actorId:foe.id,reason:'Declared obstacle in the model-authored win plan',evidence:'model-objective'});
  }
  return rows.sort((a,b)=>a.tier-b.tier).slice(0,16);
}
function answerRoutes(ctx,candidates,numerics){
  const ref=(row,opposingActorId)=>({opposingActorId,scenarioId:row.scenarioId,move:row.move,route:row.route,status:row.status,checkId:row.checkId??null});
  return ctx.actors.map(actor=>({actorId:actor.id,capabilities:actor.capabilities,
    outgoingChecks:numerics.damage.filter(row=>row.attackerId===actor.id).map(row=>ref(row,row.defenderId)),
    incomingChecks:numerics.damage.filter(row=>row.defenderId===actor.id).map(row=>ref(row,row.attackerId)),
    routes:candidates.flatMap(candidate=>candidate.actions.flatMap((action,index)=>{
      const current=ctx.actors.find(a=>a.own&&a.slot===index+1),recipient=action.type==='switch'?ctx.actors.find(a=>a.own&&(action.pokemonId===a.id||action.slot===a.raw?.requestIndex)):null;
      if(current?.id!==actor.id&&recipient?.id!==actor.id)return [];
      return [{candidateId:candidate.id,purpose:candidate.purpose,role:recipient?.id===actor.id?'switch-recipient':action.type==='switch'?'departing-actor':'acting-actor',required:candidate.requiredActors.includes(actor.id),delivery:'unchecked'}];
    })),counterStatus:'conditional-answer-routes-only',limitation:'Check references describe supplied scenarios; neither move access nor a range makes this Pokemon a proven counter.'}));
}
function pairDependencies(ctx,candidates){
  return candidates.flatMap(candidate=>{
    const warnings=stagedPairDependencyWarnings(ctx,candidate.actions,{requiredActors:unique([...(ctx.objective.requiredActors??[]),...(candidate.heuristic===false?candidate.requiredActors??[]:[])]),preserveIds:ctx.objective.preserve??[]});
    return warnings.length?[{candidateId:candidate.id,actions:structuredClone(candidate.actions),warnings}]:[];
  });
}
/** Pure qualitative preparation for a caller-owned frozen snapshot. This does
 * not read the client or establish freshness; the operator must revalidate the
 * source and selected complete pair through its existing stage/send path. */
export function createDecisionBriefFromSnapshot({board,legalActions,ownTeam,opponentSheet,source,objective={requiredActors:[],preserve:[],targets:[]},observedPositionInput,reconstructionHypotheses}={}){
  boundedSnapshot(board,legalActions);
  if(!source?.boardHash||source.boardHash!==boardDigest(board,legalActions))throw new Error('Inline planning snapshot/source binding mismatch');
  objective=objectiveSchema.parse(objective);
  const ctx=buildTurnFacts({board,legalActions,ownTeam,opponentSheet,objective}),generated=buildCandidates(ctx,{maxCandidates:3});
  const numerics={damage:[],checks:[],order:[],threats:[]},changes=fieldChanges(ctx);
  const exactInput=exactSnapshotInput(observedPositionInput,{board,legalActions,ownTeam,opponentSheet,source});
  const report={schemaVersion:1,kind:'champions-turn-brief',briefId:randomUUID(),status:'advisory',source:structuredClone(source),objective:structuredClone(objective),
    actors:ctx.actors,field:ctx.field,fieldTransitions:changes,resources:ctx.resources,order:[],orderEvidence:ctx.orderEvidence,threats:[],numericContext:{sides:ctx.sides,hypotheses:[]},
    reconstructionReadiness:reconstructionReadiness(exactInput?observedPositionInput:undefined,reconstructionHypotheses,source,{snapshot:true,
      reason:observedPositionInput?'Supplied observed builder input does not match this exact snapshot/source/team/sheet.':'No exact observed builder input was supplied for this caller-owned snapshot.'}),
    priorities:makePriorities(ctx,numerics),controlDeliveryWarnings:competingFakeOutWarnings(ctx),recipientEffects:buildRecipientEffects(ctx,{source}),pairDependencies:pairDependencies(ctx,generated.candidates),answerRoutes:answerRoutes(ctx,generated.candidates,numerics),candidates:generated.candidates,numericChecks:{damage:[],checks:[]},
    warnings:[...ctx.warnings,...generated.warnings.map(message=>({code:'CANDIDATE_LIMIT',message})),{code:'INLINE_REVALIDATION_REQUIRED',message:'Qualitative preparation uses the caller snapshot. Revalidate source, legality and deadline before staging or sending.'},
      {code:'NUMERICS_NOT_REQUESTED',message:'No numerical damage or Speed check was performed; move order, removal and safety remain unverified.'},...(changes.length?[{code:'RESOLUTION_FIELD_CAN_CHANGE',message:'Possible switch or Mega transitions can change the field before actions resolve.'}]:[])],
    coverage:{candidates:generated.coverage,numerics:{attemptedCalls:0,completedCalls:0,completedDamage:0,budgetExhausted:false,callLimitReached:false},sourceRevalidated:false,priorityIsHeuristic:true,registeredOpponentsAreNotSelections:true},
    limitations:['Pure zero-numeric advice; caller-owned source binding is not an independent freshness read.','Complete legal candidates require explicit selection and final operator revalidation.']};
  report.candidateEvidence=projectCandidateEvidence(report,{legalActions:ctx.legalActions});
  return report;
}
export async function createTurnBrief(raw,{workspace,callTool,call,loadTeam,numericCache,prepareChecks,signal,now=Date.now}={}){
  const started=now();
  if(signal?.aborted)throw new Error('Turn brief cancelled');
  if(Buffer.byteLength(JSON.stringify(raw))>512*1024)throw new Error('Complete planning input exceeds bounded snapshot size');
  const input=turnBriefSchema.parse(raw),deadline=started+input.budgetMs;
  const loaded=await resolvePlanningSource(input.request,{workspace,call,loadTeam,deadline});
  const readiness=reconstructionReadiness(loaded.observedPositionInput,input.reconstructionHypotheses,loaded.source,{sourceRevalidated:true});
  const ctx=buildTurnFacts({...loaded,objective:input.objective});
  for(const value of [...input.objective.requiredActors,...input.objective.preserve])if(!ctx.actors.some(actor=>actor.id===value&&actor.own&&actor.selected==='selected'))throw new Error('Required/preserved actors must be identified selected own Pokemon');
  for(const value of input.objective.targets)if(!ctx.actors.some(actor=>actor.id===value&&!actor.own))throw new Error('Objective target is not a known opposing identity');
  let candidates,generated;
  if(input.candidates){
    const seen=new Set();candidates=input.candidates.map(candidate=>{if(seen.has(candidate.id))throw new Error('Candidate IDs must be unique');seen.add(candidate.id);
      const validated=validateChoice({...ctx.legalActions,side:{pokemon:ctx.legalActions.pokemon}},candidate.actions);
      for(const actor of candidate.requiredActors)if(!active(ctx,true).some(value=>value.id===actor))throw new Error('Candidate required actor must be currently active');
      return {...candidate,actions:validated.actions,heuristic:false,warnings:['Authored pair legality checked; action delivery and resulting board remain unchecked.']};});
    generated={coverage:{source:'model-authored',generated:candidates.length},warnings:[]};
  }else{generated=buildCandidates(ctx,{maxCandidates:input.maxCandidates});candidates=generated.candidates;}
  const changes=fieldChanges(ctx),warnings=[...ctx.warnings,...generated.warnings.map(message=>({code:'CANDIDATE_LIMIT',message}))];
  if(changes.length)warnings.push({code:'RESOLUTION_FIELD_CAN_CHANGE',message:'Current-state order/damage does not resolve possible switch or Mega field transitions.'});
  const remaining=Math.max(0,Math.min(deadline-now()-(input.request.kind==='observed'?750:0),loaded.planningCutoffAt===null||loaded.planningCutoffAt===undefined?Infinity:loaded.planningCutoffAt-now()-5000));
  if(input.retainEvidence&&input.request.kind!=='observed')throw new Error('Retained calculation evidence requires an actual bound observed source');
  const invoke=Object.assign(async(name,args,options)=>{
    if(typeof callTool!=='function')throw new Error('Registered numerical MCP handlers unavailable');
    const evidence=input.retainEvidence?{teamId:loaded.source.teamId,roomId:loaded.source.room.replace(/-[a-z0-9]+pw$/,''),turn:ctx.turn}:undefined;
    return callTool(name,{...args,...(evidence?{evidenceContext:evidence}:{})},options);
  },{runtimeVersion:callTool?.runtimeVersion??null});
  ctx.calculatorRuntimeVersion=invoke.runtimeVersion;
  const cacheWorkspace=resolve(workspace??process.cwd());ctx.calculationCacheWorkspace=process.platform==='win32'?cacheWorkspace.toLowerCase():cacheWorkspace;
  ctx.calculationCacheOwnerTeamId=loaded.cacheTeamId??loaded.source.teamId??null;
  // A retained receipt belongs to its original team/game/turn. Reusing equal
  // mechanics must not skip a newly requested evidence write or relabel an old
  // receipt as current-context evidence.
  ctx.calculationEvidenceScope=input.retainEvidence?{kind:'retained',teamId:loaded.source.teamId,roomId:loaded.source.room.replace(/-[a-z0-9]+pw$/,''),turn:ctx.turn}:{kind:'unretained'};
  const numerics=await analyzeNumerics(ctx,{hypotheses:input.hypotheses,maxCalls:remaining>0?input.maxCalls:0,budgetMs:Math.max(1,remaining),callTool:invoke,cache:numericCache instanceof Map?numericCache:new Map()});
  // Preparation creates references through the existing catalog only. It runs
  // inside this same brief budget and leaves time for the final source check.
  // No unknown investment, paired reply, numerical result or choice is filled.
  const candidateBudget=Math.floor(Math.max(0,Math.min(250,deadline-now()-100,
    loaded.planningCutoffAt==null?Infinity:loaded.planningCutoffAt-now()-5000)));
  const dependencies=pairDependencies(ctx,candidates);
  const candidateResearch=await prepareCandidateResearch({status:'advisory',source:loaded.source,objective:input.objective,actors:ctx.actors,candidates,
    numericChecks:{damage:numerics.damage,checks:numerics.checks},numericContext:{sides:ctx.sides,hypotheses:input.hypotheses},field:ctx.field,
    order:numerics.order,coverage:{sourceRevalidated:true},pairDependencies:dependencies},
    {legalActions:ctx.legalActions,prepareChecks,request:input.request,hypotheses:input.hypotheses,budgetMs:candidateBudget,signal});
  const sourceValid=await loaded.revalidate();
  if(signal?.aborted)throw new Error('Turn brief cancelled');
  const report={schemaVersion:1,kind:'champions-turn-brief',briefId:randomUUID(),status:sourceValid?'advisory':'stale-source',source:loaded.source,
    reconstructionReadiness:sourceValid?readiness:{...readiness,ready:false,status:'stale-source',sourceRevalidated:false,reason:'Planning source changed after inspection; captured reconstruction readiness is uncredited.'},
    objective:input.objective,actors:ctx.actors.map(({raw,lifecycle,pp,volatiles,...actor})=>({...actor,lifecycleKnown:lifecycle!==null})),
    field:ctx.field,fieldTransitions:changes,resources:ctx.resources,order:numerics.order,orderEvidence:ctx.orderEvidence,
    threats:numerics.threats,priorities:makePriorities(ctx,numerics),controlDeliveryWarnings:competingFakeOutWarnings(ctx),...(sourceValid?{recipientEffects:buildRecipientEffects(ctx,{source:loaded.source})}:{}),pairDependencies:sourceValid?dependencies:[],answerRoutes:answerRoutes(ctx,candidates,numerics),
    candidates:sourceValid?candidates:[],numericChecks:{damage:numerics.damage,checks:numerics.checks},numericContext:{sides:ctx.sides,hypotheses:input.hypotheses},
    ...(sourceValid?{candidateResearch}:{}),
    warnings:[...warnings,...(numerics.warnings??[]).map(message=>({code:'NUMERICAL_LIMIT',message})),...(!sourceValid?[{code:'STALE_SOURCE',message:'The source request/board changed during analysis. No candidate is eligible for submission.'}]:[])],
    coverage:{candidates:generated.coverage,numerics:numerics.coverage,sourceRevalidated:sourceValid,durationMs:now()-started,registeredOpponentsAreNotSelections:true,priorityIsHeuristic:true},
    nextSteps:['Choose the required actor and one useful complete pair.','Check material delivery/removal dependencies using battle_check_plan or supported atomic simulation/choice.','Submit the explicitly selected pair through the existing leased operator; advice alone establishes no submission.'],
    limitations:['Priorities are provisional rules plus the declared model objective, not win probabilities or opponent predictions.','Available moves and numerical ranges do not establish action delivery through both opponents.','Named opposing spread/HP scenarios are hypothetical, not all legal investments.','Unverified or unsupported checks stay unresolved.','This read-only analysis never stages, sends, authenticates, searches, or changes the roster.']};
  report.candidateEvidence=projectCandidateEvidence(report,{legalActions:ctx.legalActions});
  if(input.view==='full')return report;
  if(input.view==='decision')return projectDecisionView(report,{legalActions:ctx.legalActions});
  return projectCompactTurnBrief(report);
}

/** Display only. The operator retains the complete report before this removes
 * parent native inputs and raw context needed for evidence verification. */
export function projectCompactTurnBrief(report){
  const numerics=report.numericChecks;
  // Every omitted numerical row is counted. Unchecked rows are never relabeled
  // safe; actual completed ranges/assumptions and critical warnings remain.
  const complete=numerics.damage.filter(row=>row.status==='complete');
  const unavailable=numerics.damage.filter(row=>row.status!=='complete');
  const compactOrder=({originalConditions,events,...observation})=>({...observation,originalConditions:originalConditions?{baseline:originalConditions.baseline,trickRoom:originalConditions.trickRoom}:undefined});
  return {...report,numericContext:undefined,actors:report.actors.map(actor=>({id:actor.id,own:actor.own,side:actor.side,slot:actor.slot,species:actor.species,selected:actor.selected,hp:actor.hp,status:actor.status,boosts:actor.boosts,ability:actor.ability,item:actor.item,capabilities:actor.capabilities,moves:actor.moves})),
    orderEvidence:{...report.orderEvidence,sourceLines:undefined,observations:report.orderEvidence?.observations?.map(compactOrder)},
    order:report.order.map(row=>({...row,pokemon:row.pokemon?.map(pokemon=>({label:pokemon.label,effectiveSpeed:pokemon.effectiveSpeed,actionSpeed:pokemon.actionSpeed,orderingWarnings:pokemon.orderingWarnings})),observedConstraints:undefined,observedConstraintsRef:'orderEvidence.observations',receipt:row.receipt})),
    answerRoutes:report.answerRoutes.map(({actorId,routes,outgoingChecks,incomingChecks})=>({actorId,routes,outgoingChecks:outgoingChecks.filter(check=>check.status==='complete'),incomingChecks:incomingChecks.filter(check=>check.status==='complete'),uncheckedOutgoingCount:outgoingChecks.filter(check=>check.status!=='complete').length,uncheckedIncomingCount:incomingChecks.filter(check=>check.status!=='complete').length})),
    numericChecks:{damage:complete,unavailableCount:unavailable.length,unavailableReasons:unique(unavailable.flatMap(row=>row.warnings??[])),checks:numerics.checks.map(({result,input,...check})=>check)},
    viewCoverage:{mode:'compact',completeRangesRetained:complete.length,uncheckedRowsOmitted:unavailable.length,fullViewAvailable:true,omitted:'Repeated raw calculator payloads, full stat snapshots and unchecked per-move/answer references; their counts and reasons remain. Order observations appear once. Use view:full with the same labeled assumptions when needed.'}};
}
