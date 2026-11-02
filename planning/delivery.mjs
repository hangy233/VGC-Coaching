// Read-only orchestration: every resolution comes from the injected MCP tool.
// No native engine invocation, independent arithmetic, generated opposing pair,
// battle submission, or candidate selection is performed here.
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {simulationRequestSchema} from '../simulation/mcp-tools.mjs';
import {branchSchema,deliveryObjectiveSchema} from '../simulation/turn-simulator.mjs';
import {bindObservedActions} from '../simulation/observed-position.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';

export {deliveryObjectiveSchema};
export const deliveryCandidateSchema=z.strictObject({id:z.string().min(1).max(80),label:z.string().min(1).max(500).optional(),ourActions:branchSchema.shape.ourActions});
export const deliveryCheckSchema=z.strictObject({request:simulationRequestSchema,candidates:z.array(deliveryCandidateSchema).min(1).max(3).optional(),objective:deliveryObjectiveSchema.optional(),budgetMs:z.number().int().min(1).max(3500).default(3500)});
const copy=value=>structuredClone(value);
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const same=isDeepStrictEqual;
const objectiveOf=gate=>deliveryObjectiveSchema.parse({requiredActionsBy:gate.requiredActionsBy,...(gate.survive?{survive:gate.survive}:{}),...(gate.field?{field:gate.field}:{})});
const compactEvents=events=>(events??[]).slice(0,12).map(({type,actorId,targetId,sourceId,move,raw})=>({type,actorId,targetId,...(sourceId?{sourceId}:{}),...(move?{move}:{}),raw}));
const unwrap=reply=>{
  check(reply?.ok!==false&&!reply?.isError,(reply?.content?.find(item=>item.type==='text')?.text??'simulate_turn refused or failed').slice(0,500));
  const result=reply?.structuredContent??reply?.result??reply;
  check(result&&typeof result==='object'&&!Array.isArray(result),'simulate_turn returned no structured evidence');
  return result;
};
async function boundedCall(callTool,name,args,timeoutMs){
  const controller=new AbortController();let timer;
  try{return await Promise.race([Promise.resolve().then(()=>callTool(name,args,{timeoutMs,signal:controller.signal})),new Promise((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Delivery check budget exhausted; outcome unknown'));},timeoutMs);})]);}
  finally{clearTimeout(timer);}
}
function exactEvidence(result,request){
  check(result.engine?.gen===0&&result.engine?.format==='gen9championsvgc2026regmc','Unsupported native simulator result');
  check(same(result.submittedBranches,request.branches),'Simulator evidence belongs to different submitted paired actions or goals');
  check(Array.isArray(result.testedBranches)&&result.testedBranches.length===request.branches.length,'Missing normalized tested branch evidence');
  let ownSide;
  if(request.kind==='observed'){
    for(const key of ['teamId','room','rqid','token','sessionId'])check(result.source?.[key]===request.source[key],'Observed simulator source identity changed');
    const ids=result.source?.ownRequestOrder?.map(entry=>entry.snapshotId),matches=result.samples?.[0]?.start?.sides?.filter(side=>ids?.length===4&&side.pokemon.length===4&&side.pokemon.every(pokemon=>ids.includes(pokemon.id)));
    check(matches?.length===1,'Observed simulator own side is unavailable or ambiguous');ownSide=matches[0].id;
  }else{check(result.source?.kind==='explicit-offline-snapshot','Explicit simulator source missing');ownSide=request.position.ownSide;}
  const tested=request.branches.map(branch=>({...branch,ourActions:request.kind==='observed'?bindObservedActions(branch.ourActions,{provenance:result.source}):branch.ourActions}));
  check(same(result.testedBranches,tested),'Simulator tested a different own pair, opposing pair, or objective');
  check(Array.isArray(result.samples)&&result.samples.length===request.branches.length*request.seeds.length,'Missing native branch/seed coverage');
  const seen=new Set();
  for(const sample of result.samples){
    const branch=tested.find(branch=>branch.id===sample.branchId),key=sample.branchId+JSON.stringify(sample.seed);
    check(branch&&request.seeds.some(seed=>same(sample.seed,seed))&&!seen.has(key),'Unexpected or duplicated native branch/seed evidence');seen.add(key);
    check(sample.accepted?.[ownSide]?.accepted===true,'Own paired choice has no native acceptance evidence');
    const own=sample.start?.sides?.find(side=>side.id===ownSide);check(own?.pokemon?.length===4&&own.active?.length===2,'Native starting own identities are missing');
    const canonical=branch.ourActions.map(action=>{
      if(action.type==='move')return {type:'move',slot:action.slot,...(action.target===undefined?{}:{target:action.target}),...(action.mega?{mega:true}:{})};
      if(action.type!=='switch'||action.slot!==undefined)return action;
      const snapshotId=request.kind==='observed'?result.source.ownRequestOrder.find(entry=>entry.controlPokemonId===action.pokemonId||entry.snapshotId===action.pokemonId)?.snapshotId:request.position.sides.find(side=>side.id===ownSide).pokemon.find(pokemon=>pokemon.id===action.pokemonId||pokemon.controlPokemonId===action.pokemonId)?.id;
      const slot=own.pokemon.findIndex(pokemon=>pokemon.id===snapshotId)+1;check(slot>0,'Authored switch recipient is missing from native starting side');return {type:'switch',slot};
    });
    check(same(sample.accepted[ownSide].actions,canonical),'Native accepted own pair differs from the exact candidate');
    check(sample.gate?.kind==='delivery'&&same(objectiveOf(sample.gate),objectiveOf(branch.gate)),'Delivery evidence lacks the requested actor/field goals');
    check(Array.isArray(sample.gate.requiredActions)&&same(sample.gate.requiredActions.map(goal=>goal.id),branch.gate.requiredActionsBy)&&Array.isArray(sample.gate.surviveGoals)&&Array.isArray(sample.gate.fieldGoals),'Malformed delivery goal evidence');
    check(same(sample.gate.surviveGoals.map(goal=>goal.id),branch.gate.survive??[])&&same(sample.gate.fieldGoals.map(goal=>goal.name),Object.keys(branch.gate.field??{})),'Native survival or field coverage differs from the objective');
    check([...sample.gate.requiredActions,...sample.gate.surviveGoals,...sample.gate.fieldGoals].every(goal=>['passed','failed','unknown'].includes(goal.status)),'Native goal has no supported outcome status');
    check(['next-turn','forced-replacement','battle-ended'].includes(sample.boundary)&&Array.isArray(sample.pendingActions)&&sample.noPendingContinuation===(sample.pendingActions.length===0),'Unsupported or inconsistent native boundary');
    check(typeof sample.gate.passed==='boolean'&&Array.isArray(sample.actionOutcomes),'Missing native delivery outcomes');
    for(const goal of sample.gate.requiredActions){
      const index=own.active.indexOf(goal.id),outcome=sample.actionOutcomes.find(action=>action.id===goal.id);
      check(index>=0&&same(outcome?.authored,branch.ourActions[index])&&same(goal.authored,outcome.authored),'Required action evidence belongs to another actor or paired action');
      if(goal.status==='passed'){
        check(!outcome.faintedBeforeAction&&!outcome.pendingAtBoundary&&goal.denials?.length===0,'Fainted, pending or denied actor cannot establish action delivery');
        if(goal.authored.type==='move')check(goal.nativeMoveResult===true&&typeof goal.attemptedMove==='string'&&outcome.resolution?.nativeMoveResult===true&&outcome.resolution.denials.length===0,'Required move lacks a completed native effect');
        else if(goal.authored.type==='switch')check(typeof goal.entrantId==='string'&&goal.entrantId===outcome.resolution?.entrantId&&sample.events?.some(event=>event.type==='switch'&&event.actorId===goal.entrantId),'Required switch lacks its authored native entrant');
        else check(false,'Pass cannot prove required action delivery');
      }
    }
    check(sample.gate.passed===(sample.pendingActions.length===0&&[...sample.gate.requiredActions,...sample.gate.surviveGoals,...sample.gate.fieldGoals].every(goal=>goal.status==='passed')),'Aggregate delivery gate disagrees with native goal coverage');
  }
  return ownSide;
}

/** Check explicitly authored candidates; never choose, submit, or predict. */
export async function checkDelivery(input,{callTool}={}){
  const {request,candidates,objective,budgetMs}=deliveryCheckSchema.parse(input);
  check(typeof callTool==='function','An actual injected MCP callTool is required');
  check(new Set(request.branches.map(branch=>branch.id)).size===request.branches.length,'Branch IDs must be unique');
  check(new Set(request.seeds.map(seed=>JSON.stringify(seed))).size===request.seeds.length,'Seeds must be unique explicit samples');
  if(candidates)check(new Set(candidates.map(candidate=>candidate.id)).size===candidates.length,'Candidate IDs must be unique');
  const planCandidates=candidates?candidates.map(candidate=>({...candidate,branches:request.branches})):request.branches.map(branch=>({id:branch.id,ourActions:branch.ourActions,branches:[branch]}));
  const checkedCandidates=[],uncoveredRequiredActors=[],sampledAdverseBranches=[],unknowns=[],deadline=Date.now()+budgetMs;
  const prepared=new Map(),preparationErrors=new Map(),batchResults=new Map();let batchError,batchArrivedAt;
  for(const candidate of planCandidates){
    try{
      const branches=candidate.branches.map(branch=>{const goals=objective??(branch.gate.kind==='delivery'?objectiveOf(branch.gate):branch.gate.requiredActionsBy.length?{requiredActionsBy:branch.gate.requiredActionsBy}:null);check(goals,'An explicit required-actor objective is unavailable');return {...branch,ourActions:copy(candidate.ourActions),gate:{kind:'delivery',...copy(goals)}};});
      prepared.set(candidate.id,simulationRequestSchema.parse({...request,branches}));
    }catch(error){preparationErrors.set(candidate.id,error);}
  }
  const batch=planCandidates.length>1;
  if(batch&&prepared.size){
    try{
      const {branches:_branches,seeds:_seeds,...source}=request;
      const cases=[...prepared].map(([id,tested])=>({id,branches:tested.branches,seeds:tested.seeds}));
      const remaining=deadline-Date.now();check(remaining>0,'Delivery check budget exhausted before this batch');
      const args={request:{...source,cases},...(request.kind==='observed'?{evidenceContext:{teamId:request.source.teamId,roomId:canonicalEvidenceRoom(request.source.room)}}:{})};
      const result=unwrap(await boundedCall(callTool,'simulate_turn_batch',args,remaining));batchArrivedAt=Date.now();
      check(Array.isArray(result.cases)&&result.cases.length===cases.length&&new Set(result.cases.map(entry=>entry.id)).size===cases.length&&result.cases.every(entry=>prepared.has(entry.id)),'Simulator batch case coverage or identity changed');
      for(const entry of result.cases)batchResults.set(entry.id,entry.result);
    }catch(error){batchError=error;}
  }
  for(const candidate of planCandidates){
    const entry={id:candidate.id,...(candidate.label?{label:candidate.label}:{}),ourActions:copy(candidate.ourActions),status:'unknown',checked:false,branches:[],sampleOnly:true};checkedCandidates.push(entry);
    let testedRequest;
    try{
      if(preparationErrors.has(candidate.id))throw preparationErrors.get(candidate.id);
      testedRequest=prepared.get(candidate.id);let result,arrivedAt;
      if(batch){if(batchError)throw batchError;check(batchResults.has(candidate.id),'Simulator batch candidate evidence missing');result=batchResults.get(candidate.id);arrivedAt=batchArrivedAt;}
      else{
        const remaining=deadline-Date.now();check(remaining>0,'Delivery check budget exhausted before this candidate');
        const args={request:testedRequest,...(request.kind==='observed'?{evidenceContext:{teamId:request.source.teamId,roomId:canonicalEvidenceRoom(request.source.room)}}:{})};
        result=unwrap(await boundedCall(callTool,'simulate_turn',args,remaining));arrivedAt=Date.now();
      }
      if(arrivedAt>deadline)entry.lateEvidence={credited:false,validation:'Arrived after the research budget; no goal is promoted',source:copy(result.source??null),...(result.calculationRef?{calculationRef:copy(result.calculationRef)}:{}),reportedSamples:(result.samples??[]).map(sample=>({branchId:sample.branchId,seed:copy(sample.seed),reportedGatePassed:sample.gate?.passed??null,boundary:sample.boundary,sampleOnly:true}))};
      check(arrivedAt<=deadline,'Delivery result arrived after the bounded research deadline');
      const ownSide=exactEvidence(result,testedRequest);
      entry.checked=true;entry.source=copy(result.source);entry.hypotheses=copy(result.hypotheses??request.hypotheses);entry.seeds=copy(request.seeds);if(result.calculationRef)entry.calculationRef=copy(result.calculationRef);
      for(const branch of testedRequest.branches){
        const branchResult={id:branch.id,opposingActions:copy(branch.opposingActions),objective:objectiveOf(branch.gate),samples:[]};entry.branches.push(branchResult);
        for(const sample of result.samples.filter(sample=>sample.branchId===branch.id)){
          const required=sample.gate.requiredActions.map(goal=>({...copy(goal),effectEvents:compactEvents(goal.effectEvents),denials:compactEvents(goal.denials)}));
          const ownIds=new Set(sample.start?.sides?.find(side=>side.id===ownSide)?.pokemon?.map(pokemon=>pokemon.id));
          const actionAttempts=sample.actionOutcomes.filter(action=>ownIds.has(action.id)).map(action=>({id:action.id,authored:copy(action.authored),attemptedMove:action.attemptedMove,faintedBeforeAction:!!action.faintedBeforeAction,pendingAtBoundary:!!action.pendingAtBoundary,nativeMoveResult:action.resolution?.nativeMoveResult??null,entrantId:action.resolution?.entrantId??null,denials:compactEvents(action.denied)}));
          const summarized={seed:copy(sample.seed),passed:sample.gate.passed,cleanSample:sample.gate.cleanSample===true,requiredActions:required,actionAttempts,surviveGoals:copy(sample.gate.surviveGoals),fieldGoals:sample.gate.fieldGoals.map(goal=>({...copy(goal),evidence:compactEvents(goal.evidence)})),boundary:sample.boundary,pendingActions:copy(sample.pendingActions),noPendingContinuation:sample.noPendingContinuation,hpHypotheses:copy(sample.hpHypotheses??[]),sampleOnly:true};
          branchResult.samples.push(summarized);
          for(const goal of required.filter(goal=>goal.status!=='passed'))uncoveredRequiredActors.push({candidateId:candidate.id,branchId:branch.id,seed:copy(sample.seed),actorId:goal.id,status:goal.status,reason:goal.reason});
          for(const action of actionAttempts.filter(action=>action.attemptedMove==='Protect'&&!branch.gate.requiredActionsBy.includes(action.id)))for(const actorId of branch.gate.requiredActionsBy)uncoveredRequiredActors.push({candidateId:candidate.id,branchId:branch.id,seed:copy(sample.seed),actorId,status:'warning',reason:`Protect by ${action.id} does not establish protection or delivery for ${actorId}`});
          const risks=sample.stochastic??{};
          const adverse={candidateId:candidate.id,branchId:branch.id,seed:copy(sample.seed),failedGoals:[...required,...summarized.surviveGoals,...summarized.fieldGoals].filter(goal=>goal.status!=='passed').map(goal=>({id:goal.id??goal.name,status:goal.status,reason:goal.reason})),denials:compactEvents(actionAttempts.flatMap(action=>action.denials)),criticalEvents:compactEvents(risks.criticalEvents),missEvents:compactEvents(risks.missEvents),actionDenialEvents:compactEvents(risks.actionDenialEvents),secondaryEvents:compactEvents(risks.potentialSecondaryEvents),randomOrderEvents:compactEvents(risks.randomOrderEvents),possibleMoveOrderTies:copy(risks.possibleMoveOrderTies??[]),boundary:sample.boundary};
          if(!sample.gate.passed||!sample.gate.cleanSample||!sample.noPendingContinuation)sampledAdverseBranches.push(adverse);
          for(const goal of [...required,...summarized.surviveGoals,...summarized.fieldGoals].filter(goal=>goal.status==='unknown'))unknowns.push({candidateId:candidate.id,branchId:branch.id,seed:copy(sample.seed),goal:goal.id??goal.name,reason:goal.reason});
        }
      }
      const all=entry.branches.flatMap(branch=>branch.samples);entry.status=all.some(sample=>[...sample.requiredActions,...sample.surviveGoals,...sample.fieldGoals].some(goal=>goal.status==='failed'))?'sampled-failure':all.every(sample=>sample.passed)?'sampled-pass':'unknown';
    }catch(error){entry.reason=error?.message??'Delivery check unavailable';entry.status=/budget exhausted|research deadline/.test(entry.reason)?'unknown':'refused';unknowns.push({candidateId:candidate.id,reason:entry.reason,coverage:'No validated simulator evidence for this candidate'});}
  }
  return {checkedCandidates,uncoveredRequiredActors,sampledAdverseBranches,unknowns,source:copy(request.kind==='observed'?request.source:{kind:'explicit-offline-snapshot',liveFreshness:false}),hypotheses:copy(request.hypotheses),seeds:copy(request.seeds),coverage:{requestedCandidates:planCandidates.length,checkedCandidates:checkedCandidates.filter(candidate=>candidate.checked).length,batched:batch,suppliedOpposingBranchesOnly:true,sampleOnly:true},limitations:['Checks only supplied opposing paired actions and seeds under labeled hypotheses. Finite samples establish no guarantee, prediction, probability, or candidate selection.','Attempts, native effects, denial, survival and field state are separate facts. Protect on another actor does not cover a required actor. Preexisting field state alone proves no delivered setup.','Stops at the first native replacement boundary. Pending actions, unexecuted residuals, field expiry, later turns and unsupported state remain unknown. No action is submitted.']};
}
