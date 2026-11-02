import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {planningSourceSchema,resolvePlanningSource} from './source.mjs';
import {buildTurnFacts} from './board.mjs';
import {turnBriefSchema} from './service.mjs';
import {simulationToolSchema,simulationBatchToolSchema} from '../simulation/mcp-tools.mjs';
import {createResearchCatalog,projectResearchCatalog,resolveResearchTickets} from './research-tickets.mjs';
import {registerPlanningNumericCache,planningNumericCacheGeneration} from './numeric-cache.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {branchSchema} from '../simulation/schemas.mjs';
import {digest} from './identity.mjs';
import {compileObservedSimulation,observedSimulationPreparationOptionsSchema,projectObservedReadinessCard} from '../simulation/observed-position-preparation.mjs';
import {inspectObservedPositionReadiness} from '../simulation/observed-position-readiness.mjs';
import {bindObservedActions} from '../simulation/observed-position.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {projectCheckEligibility} from '../showdown/check-eligibility.mjs';

const selectorFields=['kind','scenarioId','attackerId','defenderId','move','route','authoredId'];
export const researchFocusSchema=z.array(z.strictObject(Object.fromEntries(selectorFields.map(key=>[key,z.string().min(1).max(200).optional()])))
  .refine(value=>Object.keys(value).length>0,'A focus selector requires an exact question field')).min(1).max(4);
const simulation=z.strictObject({id:z.string().min(1).max(200),label:z.string().min(1).max(500),name:z.enum(['simulate_turn','simulate_turn_batch']).default('simulate_turn'),
  args:z.union([simulationToolSchema,simulationBatchToolSchema])}).superRefine((value,ctx)=>{
    const parsed=(value.name==='simulate_turn_batch'?simulationBatchToolSchema:simulationToolSchema).safeParse(value.args);
    if(!parsed.success)ctx.addIssue({code:'custom',path:['args'],message:'Simulation tool name and request shape must match exactly'});
  });
// The source, locked team and repeated own pair are mechanical fields. This
// shorthand still requires every hypothesis, opposing branch and seed from the
// author. It compiles into the existing exact-input catalog, never a new runner.
const authoredGateSchema=z.union(branchSchema.shape.gate.options.map(schema=>{
  const field=schema.shape.requiredActionsBy;
  return field instanceof z.ZodDefault?schema.extend({requiredActionsBy:field.removeDefault().optional()}):schema;
}));
export const observedSimulationPlanSchema=observedSimulationPreparationOptionsSchema
  .omit({name:true,budgetMs:true,expectedInputSha256:true,objective:true})
  .extend({id:z.string().min(1).max(200),label:z.string().min(1).max(500),
    branches:z.array(branchSchema.omit({ourActions:true}).extend({gate:authoredGateSchema})).min(1).max(3)});
export const researchPreparationOptionsSchema=z.strictObject({hypotheses:turnBriefSchema.shape.hypotheses,
  reconstructionHypotheses:z.record(z.string(),z.unknown()).optional(),
  observedSimulations:z.array(observedSimulationPlanSchema).max(3).default([]),
  simulationRequests:z.array(simulation).max(3).default([]),focus:researchFocusSchema.optional(),retainEvidence:z.boolean().default(false)});
const budget=z.number().int().min(100).max(5000).default(2000);
export const researchPrepareSchema=researchPreparationOptionsSchema.extend({request:planningSourceSchema,budgetMs:budget});
const researchSelectionSchema=z.strictObject({catalogId:z.string().regex(/^catalog-[a-f0-9]{24}$/u),ids:z.array(z.string().regex(/^research-[a-f0-9]{24}$/u)).min(1).max(4)
  .refine(ids=>new Set(ids).size===ids.length,'Research IDs must be unique'),budgetMs:budget});
export const researchRunSchema=researchSelectionSchema.extend({includeNativeResults:z.literal(true).optional().describe('Retain complete actual registered native results instead of the advisory projection; no execution or source guard is bypassed.')});
export const researchResolveSchema=researchSelectionSchema.extend({actions:branchSchema.shape.ourActions,includeNativeInputs:z.literal(true).optional().describe('Return the exact selected catalog-native arguments read-only; no numerical tool or action runs.')});
const check=(ok,message)=>{if(!ok)throw new Error(`Prepared checks: ${message}`);};
const copy=value=>structuredClone(value);
const exactJsonHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const workspaceKey=value=>{const path=resolve(value??process.cwd());return process.platform==='win32'?path.toLowerCase():path;};
const fail=(reason,code)=>Object.assign(new Error(reason),{researchCode:code});

/** Associate every authored material branch with one explicitly supplied pair.
 * This validates without rewriting a request, completing a branch or executing
 * a numerical tool. Plain damage/Speed calls do not make a paired-action claim. */
export function validateResearchPairCalls(calls,actions,{normalizeOwnActions=value=>value}={}){
  const pair=branchSchema.shape.ourActions.parse(normalizeOwnActions(actions));
  check(Array.isArray(calls),'selected native calls are required');
  const samePair=(value,label)=>{
    const normalized=normalizeOwnActions(value),parsed=branchSchema.shape.ourActions.safeParse(normalized);
    check(parsed.success&&isDeepStrictEqual(normalized,pair),`${label} ourActions differs from the exact supplied complete pair`);
  };
  const branches=(values,label)=>{
    check(Array.isArray(values)&&values.length>0,`${label} requires complete authored branches`);
    for(const [index,branch] of values.entries())samePair(branch?.ourActions,`${label} branch ${index+1}`);
  };
  for(const [index,call] of calls.entries()){
    const label=`selected ${call?.name??'unknown'} call ${index+1}`;
    if(call?.name==='simulate_turn')branches(call.args?.request?.branches,label);
    if(call?.name==='simulate_turn_batch'){
      const cases=call.args?.request?.cases;
      check(Array.isArray(cases)&&cases.length>0,`${label} requires complete authored cases`);
      for(const [caseIndex,entry] of cases.entries())branches(entry?.branches,`${label} case ${caseIndex+1}`);
    }
    if(call?.name==='battle_check_plan'){
      branches(call.args?.request?.branches,label);
      if(call.args?.candidates!==undefined){
        check(Array.isArray(call.args.candidates)&&call.args.candidates.length>0,`${label} requires complete authored candidates`);
        for(const [candidateIndex,candidate] of call.args.candidates.entries())samePair(candidate?.ourActions,`${label} candidate ${candidateIndex+1}`);
      }
    }
  }
}
const timerScope=({budgetMs,signal,now})=>{
  let deadline=now()+budgetMs,timer;const controller=new AbortController();let rejectTimer;
  const abort=()=>{controller.abort();rejectTimer?.(fail('Calculation request cancelled; no unfinished result is evidence','aborted'));};
  const expired=new Promise((_,reject)=>{rejectTimer=reject;});
  const expire=()=>{controller.abort();rejectTimer(fail('Shared check deadline elapsed; unfinished results remain unknown','deadline'));};
  const arm=()=>{clearTimeout(timer);if(now()>=deadline)expire();else timer=setTimeout(expire,deadline-now());};arm();
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  // A caller can discover cancellation before the first guarded operation.
  expired.catch(()=>{});
  return {get deadline(){return deadline;},signal:controller.signal,remaining:()=>Math.max(0,deadline-now()),
    narrow(absoluteDeadline){
      if(Number.isFinite(absoluteDeadline)&&absoluteDeadline<deadline){deadline=absoluteDeadline;arm();}
      return deadline;
    },
    async guard(task){
      if(controller.signal.aborted)throw fail('Check request cancelled or deadline elapsed','aborted');
      if(now()>=deadline)throw fail('Shared check deadline elapsed','deadline');
      return Promise.race([Promise.resolve().then(()=>{
        if(controller.signal.aborted)throw fail('Check request cancelled before dispatch','aborted');
        if(now()>=deadline)throw fail('Shared check deadline elapsed before dispatch','deadline');
        return task();
      }),expired]);
    },
    close(){clearTimeout(timer);signal?.removeEventListener('abort',abort);},
  };
};
function parseReply(reply){
  if(reply?.isError)throw fail((reply.content??[]).filter(value=>value.type==='text').map(value=>value.text).join('\n')||'Registered native tool refused input','refused');
  if(reply?.structuredContent&&typeof reply.structuredContent==='object')return reply.structuredContent;
  for(const item of reply?.content??[])if(item.type==='text'){try{const value=JSON.parse(item.text);if(value&&typeof value==='object')return value;}catch{}}
  throw fail('Registered native tool returned no structured result','refused');
}
function projectResult(name,result){
  if(name==='calculate_damage'){
    check(result.gen===0&&Array.isArray(result.range)&&result.range.length===2&&result.range.every(Number.isFinite),'damage reply lacks a native gen:0 range');
    const fields=['gen','range','percent','attackerHP','defenderHP','description','calculationRef'];
    return {...Object.fromEntries(fields.filter(key=>Object.hasOwn(result,key)).map(key=>[key,copy(result[key])])),
      projection:{kind:'native-damage-range',omittedKeys:Object.keys(result).filter(key=>!fields.includes(key)),scope:'Exact independent native range; paired delivery/removal is unverified'}};
  }
  if(name==='calculate_speed'){
    check(result.gen===0&&Array.isArray(result.pokemon)&&Array.isArray(result.order),'Speed reply lacks native gen:0 entries/order');
    const fields=['index','label','species','rawSpeed','effectiveSpeed','actionSpeed','effectiveWeather','abilitySuppressed','itemSuppressed','abilityState','orderingWarnings'];
    return {...copy(result),pokemon:result.pokemon.map(value=>Object.fromEntries(fields.filter(key=>Object.hasOwn(value,key)).map(key=>[key,copy(value[key])]))),
      projection:{kind:'native-speed-order',omittedPokemonKeys:[...new Set(result.pokemon.flatMap(value=>Object.keys(value).filter(key=>!fields.includes(key))))],scope:'Native equal-priority Speed snapshots; all original assumptions, warnings and limitations remain'}};
  }
  // Simulator receipts already distinguish sampled results and unsupported
  // boundaries. Preserve them whole rather than inventing a summary that could
  // conceal a denial, counterexample or reconstruction limitation.
  return copy(result);
}
function damageHPMismatch(ticket,result,current){
  const exact=hp=>Number.isInteger(hp?.current)&&hp.current>0&&['server-own-exact','exact','actual','scenario-actual'].includes(hp.precision);
  for(const question of ticket.questions){
    if(question.kind!=='damage-range')continue;
    for(const [actorId,replyHP] of [[question.attackerId,result.attackerHP],[question.defenderId,result.defenderHP]]){
      const actor=current.ctx.actors.find(value=>value.id===actorId),patch=current.hypotheses.find(value=>value.id===question.scenarioId)?.pokemon?.[actorId];
      const hp=patch&&Object.hasOwn(patch,'hp')?{...(typeof patch.hp==='number'?{current:patch.hp}:patch.hp),precision:'scenario-actual'}:actor?.hp;
      if(exact(hp)&&(replyHP?.current!==hp.current||Number.isInteger(hp.max)&&replyHP?.max!==hp.max))return true;
    }
  }
  return false;
}

/** Registration-owned ephemeral preparation, not another calculator or battle
 * controller. The existing team cleanup registry invalidates catalogs and any
 * pending preparation write; only actual registered handlers can execute IDs. */
export function createResearchService(options={}){
  const now=options.now??Date.now,cache=registerPlanningNumericCache({workspace:options.workspace,cache:options.researchCache??new Map()}),workspace=workspaceKey(options.workspace);
  let epoch=0;
  const sourceOptions=deadline=>({workspace:options.workspace,call:options.call,loadTeam:options.loadTeam,deadline});
  const runtime=()=>{const version=options.callTool?.runtimeVersion;check(typeof options.callTool==='function'&&typeof version==='string'&&version.length>0,'actual registered calculator runtime/build is unknown');return version;};
  const load=async(input,scope)=>{
    const loaded=await scope.guard(()=>resolvePlanningSource(input.request,sourceOptions(scope.deadline)));
    if(Number.isFinite(loaded.planningCutoffAt))scope.narrow(loaded.planningCutoffAt-5000);
    check(scope.remaining()>0&&!scope.signal.aborted,'observed request is inside the existing five-second commit reserve');
    const ctx=buildTurnFacts({...loaded});
    ctx.calculationEvidenceScope=input.retainEvidence?{kind:'retained',teamId:loaded.source.teamId,roomId:canonicalEvidenceRoom(loaded.source.room),turn:ctx.turn}:{kind:'unretained'};
    return {loaded,ctx,current:{ctx,source:loaded.source,hypotheses:input.hypotheses,runtimeVersion:runtime()}};
  };
  const bounded=()=>{while(cache.size>2)cache.delete(cache.keys().next().value);};bounded();
  const refused=(input,reason,status='refused')=>({kind:'champions-check-results',catalogId:input.catalogId,ids:copy(input.ids),status,
    entries:input.ids.map(id=>({id,status,reason})),coverage:{selected:input.ids.length,completed:0,calculationsRun:0}});
  const select=async(input,entry,scope,generation,selectionEpoch)=>{
    const {loaded,ctx,current}=await load(entry.input,scope);
    const calls=resolveResearchTickets(entry.catalog,{ids:input.ids,current}).map(call=>{
      const evidence=entry.input.retainEvidence&&['calculate_damage','calculate_speed'].includes(call.name)?
        {evidenceContext:{teamId:loaded.source.teamId,roomId:canonicalEvidenceRoom(loaded.source.room),turn:ctx.turn}}:{};
      return {...call,args:{...call.args,...evidence}};
    });
    if(input.actions!==undefined){
      let normalizeOwnActions;
      if(entry.input.observedSimulations?.length&&calls.some(call=>['simulate_turn','simulate_turn_batch','battle_check_plan'].includes(call.name))){
        const readiness=inspectObservedPositionReadiness({...loaded.observedPositionInput,hypotheses:entry.input.reconstructionHypotheses});
        check(readiness.ready,'observed reconstruction is no longer ready for pair association');
        // Compare the same legal mechanics (including omitted vs explicit
        // mega:false), then bind switches to current stable identities. The
        // retained authored/native requests and their hashes stay unchanged.
        normalizeOwnActions=actions=>bindObservedActions(validateChoice({...loaded.legalActions,
          side:{...(loaded.legalActions.side??{}),pokemon:loaded.legalActions.pokemon??loaded.legalActions.side?.pokemon}},actions).actions,readiness.reconstruction);
      }
      validateResearchPairCalls(calls,input.actions,{normalizeOwnActions});
    }
    check(await scope.guard(()=>loaded.revalidate()),'source changed before dispatch');
    check(scope.remaining()>0&&!scope.signal.aborted,'selection deadline elapsed after source revalidation; no resolved inputs remain current');
    check(cache.get(input.catalogId)===entry&&planningNumericCacheGeneration(cache)===generation&&selectionEpoch===epoch,'team cleanup or service reset invalidated this catalog before dispatch');
    const inputBinding={sha256:digest({catalogId:input.catalogId,ids:input.ids,binding:entry.catalog.binding,calls}),callsSha256:digest(calls),source:copy(entry.catalog.binding.source)};
    return {loaded,ctx,current,calls,inputBinding};
  };
  return {
    async prepare(raw,{signal}={}){
      const input=researchPrepareSchema.parse(raw);runtime();
      check(!input.retainEvidence||input.request.kind==='observed','retained numerical evidence requires an actual observed source');
      check(input.simulationRequests.length+input.observedSimulations.length<=3,'at most three total authored simulation questions are supported');
      check(!input.observedSimulations.length||input.request.kind==='observed','observed simulation shorthand requires an actual bound observed source');
      const scope=timerScope({budgetMs:input.budgetMs,signal,now}),generation=planningNumericCacheGeneration(cache),preparedEpoch=epoch;
      try{
        const {loaded,ctx,current}=await load(input,scope);
        // Exact damage/order focus intentionally selects no authored simulation.
        // Do not reconstruct a whole turn (or demand its PP/reserve/lifecycle
        // hypotheses) just to prepare those independently supported inputs.
        const independentFocusOnly=input.focus?.length>0&&input.focus.every(selector=>['damage-range','move-order'].includes(selector.kind));
        const simulationRequests=[...input.simulationRequests],receipts=[],compiledInputs=[];let reconstructionReadiness,blocked=false;
        if(!independentFocusOnly&&(input.observedSimulations.length||input.reconstructionHypotheses!==undefined)){
          check(loaded.observedPositionInput,'exact observed reconstruction input is unavailable');
          const observedInput={...loaded.observedPositionInput,...(input.reconstructionHypotheses!==undefined?{hypotheses:input.reconstructionHypotheses}:{})};
          reconstructionReadiness=projectObservedReadinessCard(inspectObservedPositionReadiness(observedInput));
          for(const plan of input.observedSimulations){
            const {id,label,...options}=plan;
            const prepared=await scope.guard(()=>compileObservedSimulation(observedInput,{...options,name:'simulate_turn',budgetMs:Math.min(3500,Math.floor(scope.remaining()))}));
            reconstructionReadiness=prepared.card;
            if(!prepared.compiled){blocked=true;break;}
            simulationRequests.push({id,label,name:prepared.call.name,args:prepared.call.arguments});receipts.push({id,...prepared.receipt});
            compiledInputs.push({id,name:prepared.call.name,args:copy(prepared.call.arguments)});
          }
        }
        if(blocked){
          // A whole-turn converter may need PP, selected reserves or lifecycle
          // facts which an independent current damage/Speed question does not.
          // Offer the existing strict numerical builders in a separate catalog;
          // never substitute them for the requested material simulation or
          // select a favorable question automatically. Keep all caller-supplied
          // numerical hypotheses, including their unknowns, exactly unchanged.
          const independentFocus=(input.focus??[]).filter(selector=>['damage-range','move-order'].includes(selector.kind));
          const independentInput={...copy(input),observedSimulations:[],simulationRequests:[]};
          if(independentFocus.length)independentInput.focus=copy(independentFocus);else delete independentInput.focus;
          const independentCatalog=await scope.guard(()=>createResearchCatalog({...current,focus:independentFocus,maxTickets:128}));
          const independentChecks=projectResearchCatalog(independentCatalog,{maxBytes:3840});
          check(await scope.guard(()=>loaded.revalidate()),'source changed during blocked preparation');
          check(scope.remaining()>0&&!scope.signal.aborted,'preparation deadline elapsed');
          check(planningNumericCacheGeneration(cache)===generation&&preparedEpoch===epoch,'team cleanup or service reset invalidated preparation');
          const available=independentChecks.tickets?.length>0&&independentChecks.status!=='full-menu-required';
          if(available){
            cache.delete(independentCatalog.catalogId);cache.set(independentCatalog.catalogId,{catalog:independentCatalog,input:independentInput,
              ownerTeamId:loaded.cacheTeamId??loaded.source.teamId??null,ownerWorkspace:workspace});bounded();
          }
          return {kind:'champions-research-menu',status:'blocked',focusReady:false,reconstructionReadiness,
            coverage:{calculationsRun:0,preparedTickets:0,availableTickets:0,sourceRevalidated:true},
            independentChecks:{...independentChecks,status:available?'prepared-independent':'unavailable',stored:available,requiresExplicitSelection:true,
              requestedSimulationStatus:'blocked'},
            reason:'The requested observed simulation was not compiled. Separately listed independent damage/Speed inputs may be selected explicitly; they do not answer the blocked paired-turn question.'};
        }
        const catalog=await scope.guard(()=>createResearchCatalog({...current,simulationRequests,focus:input.focus??[],maxTickets:128}));
        for(const receipt of receipts){
          const compiled=compiledInputs.find(row=>row.id===receipt.id),expected=simulationToolSchema.parse(compiled.args);
          const tickets=catalog.tickets.filter(row=>row.name===compiled.name&&row.questions.some(question=>question.authoredId===receipt.id));
          // A focus selector may intentionally omit this authored question. Its
          // receipt remains prospective, without claiming a stored native ID.
          if(!tickets.length){receipt.catalogInputStatus='omitted-by-focus';continue;}
          check(tickets.length===1&&isDeepStrictEqual(tickets[0].args,expected),'compiled inputs differ from authoritative catalog normalization');
          receipt.catalogInputStatus='stored';receipt.catalogNativeArgumentsJsonSha256=exactJsonHash(tickets[0].args);
          receipt.nativeNormalization={kind:'authoritative-simulation-schema-parse',changed:!isDeepStrictEqual(compiled.args,tickets[0].args),
            scope:'Compiler input remains separately retained; native schema defaults belong to normalized catalog inputs, not newly authored facts.'};
        }
        check(await scope.guard(()=>loaded.revalidate()),'source changed during preparation; no catalog was stored');
        check(scope.remaining()>0&&!scope.signal.aborted,'preparation deadline elapsed; no catalog was stored');
        check(planningNumericCacheGeneration(cache)===generation&&preparedEpoch===epoch,'team cleanup or service reset invalidated preparation; no catalog was stored');
        const menu=projectResearchCatalog(catalog,{maxBytes:independentFocusOnly?3840:4096,includeSource:true}),displayedIds=new Set(menu.tickets?.map(ticket=>ticket.id)??[]);
        const simulationTickets=catalog.tickets.filter(ticket=>displayedIds.has(ticket.id)&&['simulate_turn','simulate_turn_batch'].includes(ticket.name));
        const simulationCaseEligibility=simulationTickets.length?projectCheckEligibility(simulationTickets.map(({name,args})=>({name,args})),
          {legalActions:loaded.legalActions,source:catalog.binding.source,checkIds:simulationTickets.map(ticket=>ticket.id),catalogId:catalog.catalogId}):undefined;
        check(scope.remaining()>0&&!scope.signal.aborted,'preparation deadline elapsed during projection; no catalog was stored');
        cache.delete(catalog.catalogId);cache.set(catalog.catalogId,{catalog,input:copy(input),
          ...(compiledInputs.length?{observedPreparationInputs:compiledInputs}:{}),ownerTeamId:loaded.cacheTeamId??loaded.source.teamId??null,ownerWorkspace:workspace});bounded();
        return {...menu,...(simulationCaseEligibility?{simulationCaseEligibility}:{}),...(reconstructionReadiness?{reconstructionReadiness}:{}),
          ...(independentFocusOnly?{selectionScope:{kind:'independent-numerical-focus',unselectedObservedSimulations:input.observedSimulations.length,wholeTurnReconstruction:'not-requested-by-focus'}}:{}),
          ...(receipts.length?{observedPreparation:{kind:'compiled-observed-research',receipts,dispatches:0,sourceRevalidated:true,
            scope:'Exact inputs compiled into the existing catalog; native branch acceptance, evidence writing and control remain unperformed.'}}:{})};
      }finally{scope.close();}
    },
    async resolve(raw,{signal}={}){
      const input=researchResolveSchema.parse(raw),entry=cache.get(input.catalogId);
      if(!entry)return {...refused(input,'Catalog absent, cleaned up or evicted; prepare the current board again'),kind:'champions-check-resolution'};
      const scope=timerScope({budgetMs:input.budgetMs,signal,now}),generation=planningNumericCacheGeneration(cache),selectionEpoch=epoch;
      try{
        const {calls,inputBinding,loaded}=await select(input,entry,scope,generation,selectionEpoch);
        const simulationCaseEligibility=projectCheckEligibility(calls,{legalActions:loaded.legalActions,source:inputBinding.source,checkIds:input.ids,catalogId:input.catalogId});
        const nativeInputs=input.includeNativeInputs?{calls:copy(calls)}:{};
        check(scope.remaining()>0&&!scope.signal.aborted,'selection deadline elapsed during projection; no resolved inputs remain current');
        return {kind:'champions-check-resolution',catalogId:input.catalogId,ids:copy(input.ids),status:'resolved',inputBinding,
          simulationCaseEligibility,...nativeInputs,
          entries:calls.map((call,index)=>({id:input.ids[index],name:call.name,status:'resolved'})),
          coverage:{selected:input.ids.length,completed:0,calculationsRun:0,sourceRevalidated:true},
          scope:'Exact prepared native inputs resolved and associated with the supplied pair. No numerical tool or battle choice was dispatched.'};
      }catch(error){return {...refused(input,String(error.message??error),error.researchCode==='deadline'||error.researchCode==='aborted'?'unknown':'refused'),kind:'champions-check-resolution'};}
      finally{scope.close();}
    },
    async run(raw,{signal}={}){
      const input=researchRunSchema.parse(raw),entry=cache.get(input.catalogId);
      if(!entry)return refused(input,'Catalog absent, cleaned up or evicted; prepare the current board again');
      const scope=timerScope({budgetMs:input.budgetMs,signal,now}),generation=planningNumericCacheGeneration(cache),runEpoch=epoch;let loaded,calls,current,inputBinding;
      try{
        ({loaded,calls,current,inputBinding}=await select(input,entry,scope,generation,runEpoch));
      }catch(error){scope.close();return refused(input,String(error.message??error),error.researchCode==='deadline'||error.researchCode==='aborted'?'unknown':'refused');}
      const sourceRevalidationReserveMs=entry.input.request.kind==='observed'?750:0;
      const calculationDeadline=scope.deadline-sourceRevalidationReserveMs;
      if(calculationDeadline-now()<(sourceRevalidationReserveMs?100:1)){scope.close();return refused(input,'Insufficient numerical time after the bounded source-revalidation reserve; preserve the staged pair');}
      const calculations=timerScope({budgetMs:calculationDeadline-now(),signal:scope.signal,now});calculations.narrow(calculationDeadline);
      let attempted=0;
      try{
        const entries=await Promise.all(calls.map(async(call,index)=>{
          const id=input.ids[index],name=call.name,remaining=calculations.remaining();
          if(remaining<=0||calculations.signal.aborted)return {id,name,status:'unknown',reason:'Shared numerical deadline reached before dispatch'};
          try{
            const result=await calculations.guard(async()=>{attempted++;return parseReply(await options.callTool(name,call.args,{timeoutMs:Math.max(1,calculations.remaining()),signal:calculations.signal}));});
            if(calculations.remaining()<=0||calculations.signal.aborted)return {id,name,status:'late',reason:'Native result arrived after the shared numerical deadline; not adopted as evidence'};
            const ticket=entry.catalog.tickets.find(value=>value.id===id);
            if(name==='calculate_damage'&&damageHPMismatch(ticket,result,current))return {id,name,status:'unverified',reason:'Native actual HP differs from the bound exact source/hypothesis; no current-HP removal claim is supported',result:input.includeNativeResults?copy(result):projectResult(name,result)};
            const projected=projectResult(name,result);
            return {id,name,status:'complete',result:input.includeNativeResults?copy(result):projected};
          }catch(error){return {id,name,status:calculations.signal.aborted||calculations.remaining()<=0||error.researchCode==='deadline'||error.researchCode==='aborted'?'unknown':'refused',reason:String(error.message??error)};}
        }));
        let fresh=false;
        if(scope.remaining()>0&&!scope.signal.aborted){try{fresh=await scope.guard(()=>loaded.revalidate());}catch{}}
        if(scope.remaining()<=0||scope.signal.aborted)fresh=false;
        const invalidated=cache.get(input.catalogId)!==entry||planningNumericCacheGeneration(cache)!==generation||runEpoch!==epoch;
        if(!fresh||invalidated)for(const result of entries)if(result.status==='complete'){
          result.status='unverified';result.reason=invalidated?'Team cleanup invalidated the catalog during calculation':'Source could not be revalidated after calculation';
        }
        if(fresh&&!invalidated){cache.delete(input.catalogId);cache.set(input.catalogId,entry);bounded();}
        return {kind:'champions-check-results',catalogId:input.catalogId,ids:copy(input.ids),inputBinding,status:entries.every(value=>value.status==='complete')?'complete':'partial',entries,
          coverage:{selected:input.ids.length,completed:entries.filter(value=>value.status==='complete').length,calculationsRun:attempted,sourceRevalidated:fresh&&!invalidated},
          deadlines:{effectiveDeadlineAt:scope.deadline,calculationDeadlineAt:calculationDeadline,commitReserveMs:5000,sourceRevalidationReserveMs},
          scope:'Actual registered native results only. No chosen action, battle submission, opponent prediction or automatic missing-input fallback.'};
      }finally{calculations.close();scope.close();}
    },
    clear(){epoch++;cache.clear();},
  };
}
