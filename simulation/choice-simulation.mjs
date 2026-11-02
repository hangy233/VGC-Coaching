// Compact authored choices; native owned history supplies state. No control,
// opponent action selection, stat formula or second resolution engine lives here.
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {simulationChoicesToolSchema,legacySimulationChoicesToolSchema} from './choice-schemas.mjs';
import {applyChoiceStateOverrides} from './choice-state.mjs';
import {generateSpreadCandidates} from './spread-candidates.mjs';
import {buildObservedPosition,bindObservedActions} from './observed-position.mjs';
import {buildApproximateObservedPosition} from './approximate-position.mjs';
import {applyKnownNativeHistory} from './history-state.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {loadMetricsTeam} from '../metrics/import.mjs';
import {callLocalSession} from '../showdown/local-bridge.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {digest} from '../planning/identity.mjs';
import {sanitizeResponse} from '../showdown/operator-response.mjs';
import {summarizeChoiceSamples} from './choice-ranges.mjs';
import {enumerateSpreadDomain} from './spread-range.mjs';
import {presentSingleChoiceOutcome} from './choice-presentation.mjs';
import {registeredSpeciesKey} from './registered-identity.mjs';

const {Teams,Dex}=createRequire(import.meta.url)('pokemon-showdown'),dex=Dex.mod('champions');
const clone=value=>structuredClone(value),key=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]/gu,'');
const base=species=>registeredSpeciesKey(species,dex),check=(ok,message)=>{if(!ok)throw Error(message);};
const unwrap=reply=>{check(reply?.ok!==false&&!reply?.isError,reply?.error??'Native simulation source unavailable');return reply?.result??reply;};
const namedSet=(sheet,species)=>{const rows=sheet.filter(p=>base(p.species)===base(species));check(rows.length===1,'Registered species identity is missing or ambiguous');return rows[0];};

function exactSource(context,input){
  const {source,analysis}=input,observed=context?.observed;
  check(context?.kind==='owned-simulation-context-v1'&&context.choiceAuthority===false,'Owned native simulation context unavailable');
  check(/^[a-f0-9]{64}$/u.test(context.semanticSha256??''),'Native semantic simulation source hash unavailable');
  check(['sessionId','teamId','room','rqid','token'].every(k=>context.source?.[k]===source[k]),'Native simulation source identity differs');
  check(observed?.sessionId===source.sessionId&&(!observed.teamSha256||observed.teamSha256===source.teamId),'Native simulation session/team differs');
  check(context.assembly?.kind==='mechanical-choice-state-v1'&&['sessionId','teamId','room','rqid','token'].every(k=>context.assembly.binding?.[k]===source[k]),'Mechanical assembly source differs');
  if(analysis==='frozen')check(context.liveFreshness===false&&context.freezeId===input.freezeId&&Number.isFinite(context.frozenAt),'Exact frozen pre-choice snapshot unavailable');
  else{
    check(context.liveFreshness===true,'Current simulation source is not fresh');
    const rows=observed.actions?.filter(a=>a.room===source.room&&a.rqid===source.rqid&&a.token===source.token);
    check(rows?.length===1&&rows[0].kind==='turn'&&rows[0].actionable!==false&&!['sent','uncertain','accepted','execution-observed'].includes(rows[0].submissionStatus),'Current simulation request is stale or reserved');
    check(!observed.controlPolicy?.pending?.some(p=>p.token===source.token&&p.attempted),'Current simulation request has a send reservation');
  }
  const boards=observed.boards?.filter(b=>b.room===source.room&&b.request?.rqid===source.rqid);
  check(boards?.length===1,'Exact simulation board unavailable');
  return boards[0];
}

function originalCutoff(context,input,deadline){
  // Frozen work has its own bounded read-only budget; the retained snapshot's
  // historical action deadline never grants current choice authority.
  if(input.analysis==='frozen')return deadline;
  const observed=context.observed,board=observed.boards.find(b=>b.room===input.source.room);
  const records=[...(observed.timing?.requests??[]),...(observed.controlPolicy?.pending??[])].filter(r=>r.token===input.source.token);
  return Math.min(deadline,...records.flatMap(r=>['cutoffAt','hardDeadlineAt'].map(k=>r[k]).filter(Number.isFinite)),...(Number.isFinite(board.clock?.deadlineAt)?[board.clock.deadlineAt]:[]));
}

function selectedReserves(board,sheet,branches,assembly){
  const foe=board.sides.find(s=>s.id!==board.ownSide),count=foe.unrevealedSelected;
  check(Number.isInteger(count)&&count>=0&&count<=2,'Unrevealed selection count unavailable');
  const observed=new Set(foe.pokemon.map(p=>base(p.species))),selected=[];
  const authoredSpecies=action=>{
    if(action.type!=='switch')return null;
    if(action.species)return namedSet(sheet,action.species);
    if(action.pokemonId){
      const actor=foe.pokemon.find(p=>p.id===action.pokemonId);if(actor)return namedSet(sheet,actor.species);
      const rows=sheet.filter(set=>action.pokemonId===`hypothetical-${digest({side:foe.id,species:base(set.species)}).slice(0,24)}`);
      check(rows.length===1,'Authored opposing switch identity is unavailable or ambiguous');return rows[0];
    }
    return null;
  };
  const authored=branches.flatMap(b=>[...b.opposingActions,...(b.continuations??[]).flatMap(step=>step.opposingActions??[])]).map(authoredSpecies).filter(Boolean);
  for(const registered of authored){
    if(!observed.has(base(registered.species))&&!selected.some(p=>base(p.species)===base(registered.species)))selected.push(registered);
  }
  check(selected.length<=count,'Authored branches require incompatible unseen reserve selections');
  // The remaining registry order is deterministic bookkeeping, not a forecast
  // of the opponent's selected four or a recommendation to switch.
  const omittedUnsupportedSelectionSpecies=[];
  for(const set of [...sheet].sort((a,b)=>key(a.species).localeCompare(key(b.species))))if(selected.length<count&&!observed.has(base(set.species))&&!selected.some(p=>base(p.species)===base(set.species)))selected.push(set);
  check(selected.length===count,'Registered opposing reserve candidates unavailable');
  return selected.map(set=>{
    const proof=assembly.facts?.reserveEligibility?.find(row=>base(row.species)===base(set.species));
    const freshnessProven=proof?.eligible===true&&proof.notSelectionEvidence===true&&proof.conditionalOn==='selected-unrevealed-and-never-entered';
    const initial={hp:'full',status:'',boosts:Object.fromEntries(['atk','def','spa','spd','spe','accuracy','evasion'].map(k=>[k,0])),pp:set.moves.map(name=>{const m=dex.moves.get(name);return dex.data.Scripts.calculatePP.call({gen:9},m,m.noPPBoosts?0:3);}),lifecycle:{activeTurns:0,activeMoveActions:0,protectCounter:0,choiceLock:false,lastMove:false},volatiles:{},ability:set.ability,item:set.item??'',abilitySuppressed:false};
    const state=freshnessProven?Object.fromEntries(['hp','status','boosts','pp','lifecycle','volatiles','ability','item','abilitySuppressed'].filter(k=>proof[k]!==undefined).map(k=>[k,clone(proof[k])])):initial;
    return {id:`hypothetical-${digest({side:foe.id,species:base(set.species)}).slice(0,24)}`,species:set.species,set,state,freshnessAssumed:!freshnessProven,omittedUnsupportedSelectionSpecies,origin:freshnessProven?proof.origin??'complete-native-history-never-entered':'conditional-unseen-reserve-state',selection:authored.some(p=>base(p.species)===base(set.species))?'authored-switch-selection-hypothesis':'deterministic-registry-filler-selection-hypothesis'};
  });
}

function authoredRelevantMoves(board,sheet,branches){
  const foe=board.sides.find(s=>s.id!==board.ownSide),result=new Map();
  for(const branch of branches)for(const [index,action]of branch.opposingActions.entries())if(action.type==='move'){
    const actor=foe.pokemon.find(p=>p.id===foe.active[index]?.pokemon);check(actor,'Authored opposing actor unavailable');
    const set=namedSet(sheet,actor.species),move=dex.moves.get(set.moves[action.slot-1]);check(move.exists,'Authored opposing move is not registered');
    const moves=result.get(actor.id)??[];if(!moves.some(m=>key(m.name)===move.id))moves.push({name:move.name,category:move.category});result.set(actor.id,moves);
  }
  return result;
}

function durationVariants(board,baseHypotheses,index){
  const result=clone(baseHypotheses),assumptions=[],range=(value,path,max=8)=>{
    const r=value?.remainingTurns;if(!(r&&Number.isInteger(r.min)&&Number.isInteger(r.max)&&r.min>=1&&r.max<=max&&r.min<=r.max))return null;
    const chosen=index===1?r.max:r.min;
    if(r.min!==r.max)assumptions.push(`${path}: ${chosen} remaining turns is the ${index===1?'maximum':'minimum'} observed range endpoint (${r.min}..${r.max}); combinations are not exhaustive.`);
    return {remainingTurns:chosen};
  };
  for(const [field,c]of [['weather',board.field?.weather],['terrain',board.field?.terrain],['trickRoom',board.field?.conditions?.trickroom]])if(c){
    const duration=range(c,field,field==='trickRoom'?5:8);if(duration){result.field??={};result.field[field]={...(field==='trickRoom'?{}:{id:key(c.name)==='snowscape'?'snow':key(c.name)}),...duration};}
  }
  for(const side of board.sides)for(const [name,c]of Object.entries(side.conditions??{})){
    if(!['reflect','lightscreen','auroraveil','tailwind','toxicspikes'].includes(name))continue;
    result.sideConditions??={};result.sideConditions[side.id]??={};
    if(name==='toxicspikes'){
      if(Number.isInteger(c?.layers)&&c.layers>=1&&c.layers<=2)result.sideConditions[side.id][name]={layers:c.layers};
    }else {const duration=range(c,`${side.id}.${name}`);if(duration)result.sideConditions[side.id][name]=duration;}
  }
  for(const side of board.sides)for(const actor of side.pokemon??[]){
    const confusion=actor.volatiles?.confusion;if(!confusion)continue;
    const r=confusion.remainingActions;
    if(!(r&&Number.isInteger(r.min)&&Number.isInteger(r.max)&&r.min>=1&&r.max<=5&&r.min<=r.max))continue;
    const value=index===1?r.max:r.min,group=side.id===board.ownSide?'own':'opposing';
    check(result[group]?.[actor.id],'Known confused actor state unavailable');
    result[group][actor.id].volatiles??={};result[group][actor.id].volatiles.confusion={remainingActions:value};
    if(r.min!==r.max)assumptions.push(`${actor.id}: confusion counter ${value} is the ${index===1?'upper':'lower'} audited hidden-counter endpoint (${r.min}..${r.max}), not an observed exact duration or probability.`);
  }
  return {hypotheses:result,assumptions};
}

function ownActions(actions,board,legal){
  const side=board.sides.find(s=>s.id===board.ownSide);
  return actions.map(a=>{
    if(a.type!=='switch')return clone(a);
    if(a.species){const rows=side.pokemon.filter(p=>base(p.species)===base(a.species));check(rows.length===1,'Own named switch is unavailable or ambiguous');return {type:'switch',slot:rows[0].requestIndex};}
    if(a.pokemonId){const rows=side.pokemon.filter(p=>p.id===a.pokemonId);if(rows.length===1)return {type:'switch',slot:rows[0].requestIndex};}
    return clone(a);
  });
}

function opposingActions(actions,side){
  return actions.map(a=>{
    if(a.type!=='switch')return clone(a);
    const rows=a.species?side.pokemon.filter(p=>base(p.species)===base(a.species)):a.pokemonId?side.pokemon.filter(p=>p.id===a.pokemonId||p.controlPokemonId===a.pokemonId):side.pokemon.filter((_p,i)=>i+1===a.slot);
    check(rows.length===1,'Opposing switch candidate identity is unavailable or ambiguous');return {type:'switch',pokemonId:rows[0].id};
  });
}

function safeReason(value,secrets,limit=500){
  const cleaned=sanitizeResponse({text:String(value??'Native simulation unavailable').slice(0,8192)},{redactValues:secrets}).text;
  return cleaned.replace(/https?:\/\/[^\s<>"']+/giu,'[redacted-url]').replace(/\b[A-Za-z]:\\[^\s<>"']+/gu,'[redacted-path]').replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/gu,'[redacted-secret]')
    .replace(/\b(?:password|authorization|credential|token|sessionId)\s*[:=]\s*[^\s,;]+/giu,'[redacted-secret]').replace(/[\x00-\x1f\x7f]+/gu,' ').slice(0,limit);
}
function refusalReason(reply,secrets){
  const clean=sanitizeResponse(reply,{redactValues:secrets}),structured=clean?.structuredContent;
  for(const value of [structured?.reason,structured?.error,clean?.reason,clean?.error])if(typeof value==='string'&&value.trim())return safeReason(value,secrets,320);
  for(const block of (clean?.content??[]).slice(0,4))if(block.type==='text'&&typeof block.text==='string'&&block.text.trim()){
    let parsed;try{parsed=JSON.parse(block.text);}catch{}
    const reason=parsed?.reason??parsed?.error??parsed?.message;
    return safeReason(typeof reason==='string'?reason:block.text,secrets,320);
  }
  return 'Native MCP returned an error without a textual reason';
}
function nativeResult(reply){
  check(reply&&!reply.isError&&reply.ok!==false&&reply.structuredContent?.ok!==false,'Registered native simulation refused the assembled world');
  if(reply.structuredContent)return reply.structuredContent;
  if(reply.samples)return reply;
  for(const block of reply.content??[])if(block.type==='text')try{const value=JSON.parse(block.text);if(value.samples)return value;}catch{}
  throw Error('Registered native simulation result unavailable');
}

function compactNative(result,core){
  check(Array.isArray(result.samples)&&result.samples.length===core.branches.length,'Native simulation sample coverage differs');
  check(result.samples.every((sample,index)=>sample.branchId===core.branches[index].id&&digest(sample.seed)===digest(core.seeds[0])),'Native simulation sample identity differs');
  check(result.samples.every(sample=>digest(sample.start)===digest(result.samples[0].start)),'Native branch start states differ');
  // Engine/set metadata and each world's initial state occur only once. Samples
  // retain ordered resolution and boundary state, without the internal gate.
  return {initialState:clone(result.samples[0].start),samples:result.samples.map(s=>({branchId:s.branchId,seed:s.seed,accepted:s.accepted,...(s.openingEvents?.length?{openingEvents:s.openingEvents}:{}),initializationEvents:s.initializationEvents,stateCoverage:s.stateCoverage,events:s.events,eventView:s.eventView,final:s.final,boundary:s.boundary,turnComplete:s.turnComplete,replacementRequest:s.replacementRequest,replacementDecisions:s.replacementDecisions,unusedContinuations:s.unusedContinuations,pendingActions:s.pendingActions,pendingPhases:s.pendingPhases,noPendingContinuation:s.noPendingContinuation,stochastic:s.stochastic,hpHypotheses:s.hpHypotheses,actionOutcomes:s.actionOutcomes}))};
}

/** The injected dispatcher must invoke the actual registered battle MCP tools.
 * The facade itself does not mint an SDK/qualification brand for that callback. */
export async function executeSimulationChoices(args,{workspace,call=callLocalSession,loadTeam=loadMetricsTeam,callTool,recordEvidence,signal,deadlineAt,cache,now=Date.now,researchPolicy='single-outcome'}={}){
  let input,nativeRefusals,sourceCapture,sourceChoicesValidated=false,normalized=[],nativeCalls=[],candidatePools,stage='source',deadline=now()+3500,controller=new AbortController(),timer;
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const bounded=async(work,limit=deadline-now())=>{
    check(!controller.signal.aborted,'Simulation choices cancelled');check(now()<deadline,'Original simulation deadline exhausted');
    let clock,cancel;try{return await Promise.race([Promise.resolve().then(()=>{check(!controller.signal.aborted&&now()<deadline,'Simulation cancelled or original deadline exhausted before dispatch');return work();}),new Promise((_resolve,reject)=>{clock=setTimeout(()=>reject(Error('Bounded simulation work expired')),Math.max(1,Math.min(limit,deadline-now())));cancel=()=>reject(Error('Simulation choices cancelled'));controller.signal.addEventListener('abort',cancel,{once:true});})]);}finally{clearTimeout(clock);controller.signal.removeEventListener('abort',cancel);}
  };
  try{
    check(['single-outcome','offline-multi'].includes(researchPolicy),'Unknown simulation research policy');
    const single=researchPolicy==='single-outcome',worldCount=single?1:3;
    input=(single?simulationChoicesToolSchema:legacySimulationChoicesToolSchema).parse(args);check(input.analysis==='frozen'?!!input.freezeId:input.freezeId===undefined,'freezeId is required only for frozen analysis');
    canonicalEvidenceRoom(input.source.room);check(input.evidenceContext&&input.evidenceContext.teamId===input.source.teamId&&input.evidenceContext.roomId===canonicalEvidenceRoom(input.source.room),'Matching private team-owned evidence context required');
    check(typeof callTool==='function','Actual registered simulation MCP dispatcher unavailable');check(typeof recordEvidence==='function','Private simulator evidence writer unavailable');
    if(Number.isFinite(deadlineAt))deadline=Math.min(deadline,deadlineAt);check(deadline>now(),'Original simulation deadline exhausted');
    const descriptor=join(workspace,'cache','showdown-session.json');
    const read=()=>bounded(async()=>unwrap(await call(descriptor,{id:randomUUID(),op:'simulation-context',source:clone(input.source),mode:input.analysis,...(input.freezeId?{freezeId:input.freezeId}:{})},{timeoutMs:Math.max(1,Math.min(750,deadline-now())),signal:controller.signal})),750);
    const [context,own]=await Promise.all([read(),bounded(()=>loadTeam({workspace,teamId:input.source.teamId}),750)]);
    const board=exactSource(context,input);deadline=originalCutoff(context,input,deadline);check(deadline>now(),'Original action deadline exhausted');
    sourceCapture={kind:'private-owned-choice-input-v1',context:clone(context),contextJson:JSON.stringify(context),contextSha256:digest(context),ownTeamText:Teams.export(own.team),ownTeamSha256:input.source.teamId};
    timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-now()));
    const observed=applyChoiceStateOverrides({observed:context.observed,assembly:context.assembly}),sheet=context.opposingSheet;
    const assembledBoard=observed.boards.find(board=>board.room===input.source.room&&board.request?.rqid===input.source.rqid);
    check(Array.isArray(sheet)&&sheet.length===6,'Published registered six unavailable');
    const branches=[{id:'primary',ourActions:input.ourActions,opposingActions:input.opposingActions,...(input.continuations?{continuations:input.continuations}:{})},...(input.alternatives??[]).map((b,i)=>({...b,id:b.id??`alternative-${i+1}`}))];
    check(new Set(branches.map(b=>b.id)).size===branches.length,'Authored branch IDs must be unique');
    const actualLegal=context.observed.actions.find(a=>a.room===input.source.room&&a.rqid===input.source.rqid&&a.token===input.source.token)?.legalActions;
    check(actualLegal,'Fresh own clickable menu unavailable');
    for(const branch of branches)validateChoice({...actualLegal,side:{pokemon:actualLegal.pokemon}},ownActions(branch.ourActions,board,actualLegal));
    sourceChoicesValidated=true;
    const reserves=selectedReserves(board,sheet,branches,context.assembly),foe=board.sides.find(s=>s.id!==board.ownSide),relevant=authoredRelevantMoves(board,sheet,branches),pools=new Map();
    const rangeInputs=new Map((input.spreadRanges??[]).map(row=>[row.pokemonId,row.domain])),rangeCoverage=[];
    check(rangeInputs.size===(input.spreadRanges?.length??0),'Duplicate opposing spread domain');
    check([...rangeInputs.keys()].every(id=>[...foe.pokemon,...reserves].some(actor=>actor.id===id)),'Spread ranges must name an observed or authored-hypothetical opposing actor');
    const inferencePolicy=single?'cache-only':'allow-new-calls';
    const inferenceCall=Object.assign((name,args,options)=>callTool(name,{...args,...(single?{researchContext:{source:clone(input.source),analysis:input.analysis,...(input.freezeId?{freezeId:input.freezeId}:{})}}:{})},options),
      {runtimeVersion:callTool.runtimeVersion??null});
    stage='candidates';
    for(const actor of [...foe.pokemon,...reserves]){
      const set=namedSet(sheet,actor.species),source={teamId:input.source.teamId,sessionId:input.source.sessionId,parentId:board.parentId??input.source.room,gameId:input.source.room,sourceSha256:context.assembly.binding.sourceSha256};
      const moves=relevant.get(actor.id)??[],physical=moves.some(m=>m.category==='Physical'),domain=rangeInputs.get(actor.id);
      const declared=domain?enumerateSpreadDomain(domain,{publishedNature:set.nature??undefined,maxCandidates:3,priorityStats:physical?['atk','spe','hp','def','spd','spa']:['spa','spe','hp','def','spd','atk']}):null;
      if(declared)rangeCoverage.push({pokemonId:actor.id,...clone(declared.coverage),label:declared.label,domainSha256:declared.domainSha256});
      const pool=await generateSpreadCandidates({source,publishedSet:{species:set.species,nature:set.nature??null,ability:set.ability,item:set.item??'',moves:set.moves},currentForme:actor.species,conditions:{field:board.field,sideConditions:foe.conditions??{}},relevantMoves:moves,observations:context.assembly.facts?.spreadObservations?.[actor.id]??[],poolLimit:32,maxCalls:128,
        ...(declared?{candidateSpreads:declared.candidates.map(c=>({nature:c.nature,statPoints:c.statPoints}))}:{})},{call:inferenceCall,cache,signal:controller.signal,deadlineAt:deadline,now,numericPolicy:inferencePolicy});
      pools.set(actor.id,pool);
      if(declared)Object.assign(rangeCoverage.find(row=>row.pokemonId===actor.id),{evaluatedWitnesses:pool.coverage.evaluatedPool,historySurvivors:pool.candidates.length,excludedBySupportedHistory:pool.rejected.length});
      check(pool.candidates.length>0,'No supported representative spread candidate remains');
    }
    stage='reconstruction';
    const worlds=[];candidatePools=pools;
    for(let index=0;index<worldCount;index++){
      const varied=durationVariants(assembledBoard,context.assembly.hypotheses,index),hypotheses=varied.hypotheses,assumptions=[...varied.assumptions],profiles=[];
      if(reserves[0]?.omittedUnsupportedSelectionSpecies.length)assumptions.push(`Unseen default selection coverage excludes ${reserves[0].omittedUnsupportedSelectionSpecies.join(', ')} because their current abilities are outside the supported reconstruction scope.`);
      hypotheses.label=`Native assembled current state; representative world ${index+1}; hidden allocations, exact opposing HP and unseen selection remain hypotheses.`;hypotheses.reserves=[];
      for(const actor of [...foe.pokemon,...reserves]){
        const pool=pools.get(actor.id),moves=relevant.get(actor.id)??[],physical=moves.some(m=>m.category==='Physical'),special=moves.some(m=>m.category==='Special');
        const family=index===1?'physical-bulk':index===2?'special-bulk':physical&&special?'mixed-offense-speed':physical?'physical-speed':special?'special-speed':'speed-bulk';
        const preferredNature=index===1?'Bold':index===2?'Calm':physical&&special?'Naive':physical?'Jolly':'Timid';
        const candidate=rangeInputs.has(actor.id)?pool.candidates[index%pool.candidates.length]:pool.candidates.find(c=>c.family===family&&c.nature===preferredNature)??pool.candidates.find(c=>c.family===family)??pool.candidates[0];
        const fields={statPoints:clone(candidate.statPoints),...(namedSet(sheet,actor.species).nature?{}:{nature:candidate.nature})};
        const reserve=reserves.find(r=>r.id===actor.id);
        if(reserve){hypotheses.reserves.push({id:reserve.id,species:reserve.species,...clone(reserve.state),...fields,label:`${reserve.selection}; ${candidate.family} representative allocation; freshness conditional on never-entered complete history.`});assumptions.push(`${reserve.id}: ${reserve.species} is a ${reserve.selection}; never asserted to be a revealed selection.`);}
        else {check(hypotheses.opposing?.[actor.id],'Known opposing state fragment unavailable');hypotheses.opposing[actor.id]={...hypotheses.opposing[actor.id],...fields,hp:actor.fainted?0:index===1?'observed-low':'observed-high',label:`Known state plus ${candidate.family} representative hidden allocation; exact HP unknown, ${index===1?'lower':'upper'} native-compatible display endpoint only.`};}
        profiles.push({id:actor.id,species:actor.species,family:candidate.family,nature:candidate.nature,statPoints:clone(candidate.statPoints),natureSource:candidate.provenance.natureSource,checks:clone(candidate.checks)});
      }
      const {sessionId,...expected}=input.source,builderInput={observed,teamText:Teams.export(own.team),opposingSheet:sheet,hypotheses,expected};
      let built;
      try{built=buildObservedPosition(builderInput);}
      catch(error){built=buildApproximateObservedPosition(builderInput,{reason:String(error.message??error)});}
      built=applyKnownNativeHistory(built,context.assembly);
      const uncertainReserves=reserves.filter(r=>r.freshnessAssumed);
      if(uncertainReserves.length){built.position.stateAssumptions??=[];for(const r of uncertainReserves)built.position.stateAssumptions.push({path:`${foe.id}.${r.id}.freshness`,reason:'Freshness and selection of this unrevealed reserve are conditional hypotheses, not proved native history.',selected:'full native-initial state',origin:'conditional-unseen-reserve-state'});}
      check(input.evidenceContext.turn===undefined||input.evidenceContext.turn===built.position.turn,'Evidence turn differs from native source');
      const legal=context.observed.actions.find(a=>a.room===input.source.room&&a.rqid===input.source.rqid&&a.token===input.source.token)?.legalActions;
      check(legal,'Fresh own action menu unavailable');
      const ownSide=built.position.sides.find(s=>s.id===built.position.ownSide),opposing=built.position.sides.find(s=>s.id!==built.position.ownSide);
      const tested=branches.map(branch=>{
        const our=ownActions(branch.ourActions,board,legal);validateChoice({...legal,side:{pokemon:legal.pokemon}},our);
        const continuations=branch.continuations?.map(step=>({
          ...(step.ourActions?{ourActions:bindObservedActions(ownActions(step.ourActions,board,legal),built,{replacement:true})}:{}),
          ...(step.opposingActions?{opposingActions:opposingActions(step.opposingActions,opposing)}:{}),
        }));
        return {id:branch.id,ourActions:bindObservedActions(our,built),opposingActions:opposingActions(branch.opposingActions,opposing),...(continuations?{continuations}:{}),gate:{kind:'delivery',requiredActionsBy:clone(ownSide.active)}};
      });
      const bytes=createHash('sha256').update(JSON.stringify({source:context.semanticSha256,index})).digest(),seed=[0,2,4,6].map(offset=>bytes.readUInt16BE(offset));
      const core={position:built.position,branches:tested,seeds:[seed],hypotheses:built.assumptions};
      normalized.push({id:`world-${index+1}`,core,hypotheses,provenance:built.provenance});worlds.push({id:`world-${index+1}`,profiles,assumptions:[...built.assumptions,...assumptions],stateAssumptions:clone(built.position.stateAssumptions??[])});
    }
    const reconcile=async()=>{const fresh=await read();exactSource(fresh,input);check(fresh.semanticSha256===context.semanticSha256,'Native simulation facts changed during research');deadline=originalCutoff(fresh,input,deadline);check(deadline>now(),'Original action deadline exhausted during reconciliation');clearTimeout(timer);timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-now()));};
    await reconcile();stage='engine';
    const secrets=[input.source.sessionId,input.source.token,input.freezeId].filter(Boolean);nativeRefusals=[];
    // The ordinary path remains one actual MCP call per world. A refused batch
    // establishes no branch's outcome. Isolate each unchanged authored branch
    // only in those worlds, under the same source and original shared budget.
    const dispatch=async(world,tested,mode)=>{
      const args={request:{kind:'explicit',...clone(world.core),branches:clone(tested)},...(single?{researchContext:{source:clone(input.source),analysis:input.analysis,...(input.freezeId?{freezeId:input.freezeId}:{})}}:{})},entry={worldId:world.id,branchIds:tested.map(b=>b.id),mode,input:args};
      try{
        const reply=await bounded(()=>{entry.startedAt=now();nativeCalls.push(entry);return callTool('simulate_turn',clone(args),{signal:controller.signal,deadlineAt:deadline,timeoutMs:Math.max(1,deadline-now())});});
        entry.settledAt=now();entry.result=clone(reply);return reply;
      }catch(error){if(entry.startedAt!==undefined){entry.settledAt=now();entry.error={name:error?.name??'Error',message:String(error?.message??error)};}throw error;}
    };
    const parse=(entry,world,tested,isolated=false)=>{
      try{if(entry.status==='rejected')throw entry.reason;const native=nativeResult(entry.value);return {native,compact:compactNative(native,{...world.core,branches:tested})};}
      catch(error){const refusal={worldId:world.id,branchIds:tested.map(branch=>safeReason(branch.id,secrets,80)),classification:'native-world-state-or-execution-unavailable',sourceChoicesValidated,
        branchAttribution:isolated?'isolated-authored-branch-native-call':'whole-world-call; individual failing branch not established',untrustedDiagnostic:true,
        reason:entry.status==='fulfilled'&&entry.value?.isError?refusalReason(entry.value,secrets):safeReason(error?.message??error,secrets,320),
        reasonSource:entry.status==='fulfilled'?'native-mcp-return':'native-callback-rejection',...(entry.status==='fulfilled'?{nativeResponseSha256:digest(entry.value)}:{})};
        nativeRefusals.push(refusal);return {refusal};}
    };
    const results=await Promise.allSettled(normalized.map(world=>dispatch(world,world.core.branches,'complete-authored-world')));
    const complete=results.map((entry,index)=>parse(entry,normalized[index],normalized[index].core.branches)),native=complete.map(row=>row.native??null);
    const failed=normalized.flatMap((world,index)=>!complete[index].native&&world.core.branches.length>1?[{world,index}]:[]),isolated=new Map();
    if(failed.length){
      // A changed/reserved source invalidates the entire research operation;
      // it must not be mistaken for an unsupported alternative.
      await reconcile();stage='engine';
      const pending=failed.flatMap(({world,index})=>world.core.branches.map(branch=>({world,index,branch})));
      const replies=await Promise.allSettled(pending.map(({world,branch})=>dispatch(world,[branch],'isolated-authored-branch')));
      pending.forEach(({world,index,branch},i)=>{if(!isolated.has(index))isolated.set(index,new Map());isolated.get(index).set(branch.id,parse(replies[i],world,[branch],true));});
    }
    const resolved=normalized.map((world,index)=>{
      if(complete[index].native)return {...complete[index].compact,branchResults:world.core.branches.map(branch=>({branchId:branch.id,status:'returned'}))};
      const outcomes=world.core.branches.map(branch=>({branch,outcome:isolated.get(index)?.get(branch.id)??complete[index]})),returned=outcomes.filter(row=>row.outcome.native);
      check(returned.every(row=>digest(row.outcome.compact.initialState)===digest(returned[0].outcome.compact.initialState)),'Isolated native branch start states differ');
      return {...(returned.length?{initialState:clone(returned[0].outcome.compact.initialState)}:{}),samples:returned.flatMap(row=>row.outcome.compact.samples),
        branchResults:outcomes.map(({branch,outcome})=>outcome.native?{branchId:branch.id,status:'returned'}:{branchId:branch.id,status:'unavailable',reason:outcome.refusal.reason,reasonSource:outcome.refusal.reasonSource})};
    });
    const actual=complete.flatMap(row=>row.native?[row.native]:[]).concat([...isolated.values()].flatMap(rows=>[...rows.values()].flatMap(row=>row.native?[row.native]:[]))),sampleCount=resolved.reduce((sum,world)=>sum+world.samples.length,0);
    if(!sampleCount)throw Error(`Registered native simulation unavailable: ${nativeRefusals[0]?.worldId}: ${nativeRefusals[0]?.reason}`);
    await reconcile();check(!controller.signal.aborted&&now()<deadline,'Late or cancelled native simulation result');
    check(actual.every(result=>digest(result.engine)===digest(actual[0].engine)),'Registered native engine identity differs between worlds');
    const source={kind:input.analysis==='frozen'?'owned-frozen-pre-choice-analysis':'owned-current-choice-analysis',analysis:input.analysis,sessionId:input.source.sessionId,teamId:input.source.teamId,room:input.source.room,rqid:input.source.rqid,sourceSha256:context.semanticSha256,...(input.freezeId?{freezeId:input.freezeId,frozenAt:context.frozenAt}:{}),liveFreshness:input.analysis==='current',choiceAuthority:false,sourceChoicesValidated,legalityScope:'Own authored pairs checked against the supplied source menu; opposing hypotheses checked by native worlds.'};
    const completeBranchCoverage=sampleCount===worldCount*branches.length,allSamples=resolved.flatMap(world=>world.samples);
    const result={kind:'native-choice-simulation-v1',researchOutcome:completeBranchCoverage?'returned':'partial',source,engine:clone(actual[0].engine),branches:branches.map(b=>({id:b.id,ourActions:clone(b.ourActions),opposingActions:clone(b.opposingActions),...(b.continuations?{continuations:clone(b.continuations)}:{})})),worlds:worlds.map((world,index)=>({...world,...resolved[index]})),coverage:{worlds:worldCount,branches:branches.length,seedsPerWorld:1,samples:sampleCount,requestedSamples:worldCount*branches.length,completeBranchCoverage,unavailableBranchSamples:worldCount*branches.length-sampleCount,
      branchCoverage:branches.map(branch=>({branchId:branch.id,returnedWorlds:resolved.flatMap((world,index)=>world.branchResults.some(row=>row.branchId===branch.id&&row.status==='returned')?[worlds[index].id]:[]),unavailableWorlds:resolved.flatMap((world,index)=>world.branchResults.some(row=>row.branchId===branch.id&&row.status==='unavailable')?[worlds[index].id]:[])})),
      completedTurnSamples:allSamples.filter(sample=>sample.turnComplete).length,pausedReplacementSamples:allSamples.filter(sample=>sample.boundary==='forced-replacement').length,completeStateReconstruction:allSamples.every(sample=>sample.stateCoverage?.complete===true),approximateSamples:allSamples.filter(sample=>sample.stateCoverage?.approximate===true).length,stateCoverageUnavailableSamples:allSamples.filter(sample=>!sample.stateCoverage).length,
      representativeOnly:true,exhaustive:false,koProbability:false,tacticalGoalEvaluated:false,actionsSelectedBy:'model',stateAssembledBy:'native-owned-history',sdkQualificationClaimed:false},...(nativeRefusals.length?{nativeRefusals}:{}),limitations:['Finite representative worlds are assumptions, not probabilities, revealed opposing sets, guaranteed knockouts or tactical approval.','Public opposing HP uses only the native observed-high directive; exact HP and low-HP behavior remain uncertain.','Unseen reserves are explicitly hypothetical selections. Field range endpoints do not exhaust simultaneous combinations.','Native replacements continue only with explicit authored continuation pairs; otherwise the paused turn and pending work remain visible. No entrant or pending action is invented.']};
    if(!completeBranchCoverage)result.limitations.push('Some authored branch/world pairs are unavailable. Returned samples and ranges cover only the explicitly returned pairs; missing alternatives remain unknown and do not establish comparison or qualification success.');
    result.turnRanges=summarizeChoiceSamples(result.worlds);
    result.spreadRangeCoverage=rangeCoverage;
    const inferenceActors=[...pools].map(([id,pool])=>({id,status:pool.status,usableObservations:pool.coverage.usableObservations,ignoredObservations:pool.coverage.ignoredObservations,
      newNumericCalls:pool.coverage.attemptedCalls,cachedNumericChecks:pool.coverage.cachedCalls,deferredNumericChecks:pool.coverage.deferredCalls,excludedCandidates:pool.rejected.length}));
    result.inference={policy:inferencePolicy,modelFirst:single,newNumericCalls:inferenceActors.reduce((n,row)=>n+row.newNumericCalls,0),cachedNumericChecks:inferenceActors.reduce((n,row)=>n+row.cachedNumericChecks,0),
      deferredNumericChecks:inferenceActors.reduce((n,row)=>n+row.deferredNumericChecks,0),actors:inferenceActors,
      scope:'Only supplied supported observations over the bounded candidate pool. Missing/deferred checks do not establish history compatibility; remaining investments and exact HP stay hypotheses.'};
    result.limitations.push('Spread-range coverage describes each declared domain witness enumeration separately; joint actors, HP endpoints and random outcomes are still bounded nonexhaustive samples.');
    result.limitations[1]='Public opposing HP includes native-renderer-compatible low/high endpoint hypotheses. Intermediate HP thresholds and full spread/RNG domains are not exhausted.';
    const presented=single?presentSingleChoiceOutcome(result):result;
    if(single&&nativeCalls[0]?.result?.researchBudget)presented.researchBudget=clone(nativeCalls[0].result.researchBudget);
    stage='evidence';presented.calculationRef=await bounded(()=>recordEvidence({tool:'simulate_choices',input:{request:clone(input),source,sourceCapture,assembly:clone(context.assembly),candidatePools:Object.fromEntries([...pools].map(([id,pool])=>[id,clone(pool)])),normalized,nativeCalls:clone(nativeCalls),researchPolicy},result:{...clone(presented),detailedResult:clone(result),nativeResults:clone(native)},context:input.evidenceContext}));
    check(!controller.signal.aborted&&now()<deadline,'Late or cancelled simulation evidence result');
    return presented;
  }catch(error){
    const result={kind:'simulation-choices-unavailable',researchOutcome:'unavailable',reason:safeReason(error.message??error,[input?.source?.sessionId,input?.source?.token,input?.freezeId].filter(Boolean)),stage,sourceChoicesValidated,failureScope:sourceChoicesValidated?'world-state-or-research-unavailable':'source-menu-or-request-validation',retry:false,copyRepair:false,choiceAuthority:false,liveFreshness:false,
      ...(nativeRefusals?.length?{nativeRefusals}:{})};
    // Retain reproducible private source, even when no numeric sample exists.
    // This is optional diagnostic work within the SAME original deadline.
    if(sourceCapture&&input?.evidenceContext&&stage!=='evidence'&&!controller.signal.aborted&&now()<deadline){
      try{result.calculationRef=await bounded(()=>recordEvidence({tool:'simulate_choices',input:{request:clone(input),sourceCapture,
        ...(candidatePools?{candidatePools:Object.fromEntries([...candidatePools].map(([id,pool])=>[id,clone(pool)]))}:{}),normalized:clone(normalized),...(nativeCalls.length?{nativeCalls:clone(nativeCalls)}:{})},result:clone(result),context:input.evidenceContext}),Math.min(250,deadline-now()));}
      catch{result.diagnosticPreservation={preserved:false,reason:'bounded-private-evidence-unavailable'};}
    }
    return result;
  }
  finally{clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort);}
}

export function registerSimulationChoicesTool(server,options={}){
  const handler=async(args,extra)=>{
    const result=await executeSimulationChoices(args,{...options,signal:extra?.signal??options.signal});return {...(result.kind==='simulation-choices-unavailable'?{isError:true}:{}),structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
  };
  server.registerTool('simulate_choices',{description:'Resolve exactly one model-authored own/opposing paired action outcome against native current or frozen pre-choice facts. No alternatives or automatic extra worlds. One deterministic representative hidden-state hypothesis and one seed are explicit, not a range or probability. Optional continuations finish that same trajectory through native replacement requests; no entrant is selected automatically. Returns one end board, ordered events, pending work and structured uncertainty once; full native detail is private. Current and frozen spread-history filtering uses only exact source/runtime-compatible cached checks and launches zero new numeric callbacks; unchecked candidates remain labeled hypotheses. Detailed offline filtering is a separate explicit workflow. Per battle turn main and frozen work share one trajectory and three combined numeric MCP invocations. A changed pair cannot obtain a second trajectory; exact completed input may reuse its source-validated cached result. Missing state remains conditional. No choices are sent and frozen analysis grants no current authority.',inputSchema:simulationChoicesToolSchema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true}},options.wrapHandler?options.wrapHandler(handler):handler);
}
