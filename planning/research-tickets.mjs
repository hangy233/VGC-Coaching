import {createHash} from 'node:crypto';
import {analyzeNumerics} from './numerics.mjs';
import {requestDigest} from './identity.mjs';
import {simulationToolSchema,simulationBatchToolSchema} from '../simulation/mcp-tools.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';

const CONTRACT='champions-prepared-research-v1';
const MAX_INPUT_BYTES=512*1024;
const check=(ok,message)=>{if(!ok)throw new Error(`Prepared research: ${message}`);};
const copy=value=>structuredClone(value);
const canonical=value=>value===undefined?null:Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const semanticSource=source=>Object.fromEntries(Object.entries(source??{}).filter(([key])=>!['observedAt','liveFreshness'].includes(key)));
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const entry of Object.values(value))freeze(entry);Object.freeze(value);}return value;}
function boundedCopy(value,label,maxBytes=MAX_INPUT_BYTES){
  let serialized;try{serialized=JSON.stringify(value);}catch{throw new Error(`Prepared research: ${label} must be serializable`);}
  check(typeof serialized==='string'&&Buffer.byteLength(serialized)<=maxBytes,`${label} exceeds bounded serialized input`);
  return JSON.parse(serialized);
}
function bindingOf({ctx,source,hypotheses=[],runtimeVersion}={}){
  check(ctx&&Array.isArray(ctx.actors)&&ctx.actors.length<=24,'bounded normalized turn facts are required');
  check(source&&typeof source==='object'&&!Array.isArray(source)&&/^[a-f0-9]{64}$/u.test(source.boardHash??''),'exact planning source board hash is required');
  check(['bound-observed-turn','explicit-hypothetical-snapshot'].includes(source.kind),'identified observed or explicitly hypothetical planning source is required');
  if(source.kind==='bound-observed-turn'){
    check(typeof source.sessionId==='string'&&source.sessionId.length>=1&&source.sessionId.length<=200,'observed source session is required');
    for(const key of ['teamId','requestDigest','opposingSheetSha256'])check(/^[a-f0-9]{64}$/u.test(source[key]??''),`observed source ${key} is required`);
    check(typeof source.room==='string'&&/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*(?:-[a-z0-9]+pw)?$/u.test(source.room),'observed source room is required');
    check(Number.isInteger(source.rqid)&&source.rqid>=0,'observed source rqid is required');
  }else check(typeof source.label==='string'&&source.label.length>=1&&source.label.length<=500,'explicit hypothetical source label is required');
  check(typeof runtimeVersion==='string'&&runtimeVersion.length>=1&&runtimeVersion.length<=200,'known calculator runtime/build version is required');
  check(Array.isArray(hypotheses)&&hypotheses.length<=3,'at most three explicit numerical hypotheses are supported');
  // Bind all normalized facts, including HP, form, current field, legality and
  // raw lifecycle state. Observed clock timestamps do not change mechanics.
  return {contract:CONTRACT,source:boundedCopy(semanticSource(source),'source'),
    contextHash:digest(boundedCopy(ctx,'turn facts')),hypotheses:boundedCopy(hypotheses,'hypotheses'),runtimeVersion};
}
function ticketId(binding,name,args){return `research-${digest({binding,name,args}).slice(0,24)}`;}
function simulationInput(value,binding,ctx){
  check(value&&typeof value==='object'&&!Array.isArray(value),'authored simulation ticket must be an object');
  check(typeof value.id==='string'&&value.id.length>=1&&value.id.length<=200,'authored simulation ID is required');
  check(typeof value.label==='string'&&value.label.length>=1&&value.label.length<=500,'authored simulation label is required');
  check(['simulate_turn','simulate_turn_batch'].includes(value.name??'simulate_turn'),'only native simulation tools may be prepared');
  const name=value.name??'simulate_turn',schema=name==='simulate_turn_batch'?simulationBatchToolSchema:simulationToolSchema;
  const args=schema.parse(boundedCopy(value.args,'authored simulation'));
  if(args.request.kind==='observed'){
    const request=args.request.source,source=binding.source;
    check(source.kind==='bound-observed-turn','observed simulation requires an observed planning source');
    for(const key of ['sessionId','teamId','room','rqid'])check(request[key]===source[key],`simulation source ${key} changed`);
    check(requestDigest({...request,boardHash:source.boardHash})===source.requestDigest,'simulation request token/binding changed');
    // The planning digest covers the raw published sheet. Native simulation
    // uses its authoritative canonical sheet digest; the two scopes differ.
    if(request.opposingSheetSha256!==undefined)check(request.opposingSheetSha256===(source.publishedOpposingSheetSha256??source.opposingSheetSha256),'simulation opposing sheet changed');
    check(args.evidenceContext?.teamId===source.teamId&&args.evidenceContext?.roomId===canonicalEvidenceRoom(source.room),'observed simulation requires matching canonical team-owned evidence');
    check(args.evidenceContext?.turn===undefined||args.evidenceContext.turn===ctx.turn,'simulation evidence turn changed');
  }else{
    check(binding.source.kind==='explicit-hypothetical-snapshot','an explicit native scenario cannot claim an observed planning source');
    check(args.request.position.turn===ctx.turn&&args.request.position.ownSide===ctx.ownSide,'explicit simulation turn/own side changed');
  }
  return {name,args,descriptor:{kind:'paired-simulation',authoredId:value.id,label:value.label,
    scope:args.request.kind==='observed'?'Authored paired actions; native observed adapter must still verify reconstruction and freshness':'Explicit hypothetical native position; current-state equivalence and opponent intent are not established'}};
}

/** Prepare exact registered-tool inputs once, without running a calculator,
 * predicting opposing actions, or creating control authority. The caller owns
 * this small immutable catalog and its lifetime; no global/disk cache exists. */
export async function createResearchCatalog({ctx,source,hypotheses=[],runtimeVersion,simulationRequests=[],focus=[],maxTickets=64}={}){
  const binding=bindingOf({ctx,source,hypotheses,runtimeVersion});
  check(Number.isInteger(maxTickets)&&maxTickets>=1&&maxTickets<=128,'ticket limit must be 1–128');
  check(Array.isArray(simulationRequests)&&simulationRequests.length<=3,'at most three authored simulation tickets are supported');
  check(Array.isArray(focus)&&focus.length<=4&&focus.every(value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length>=1&&Object.entries(value).every(([key,value])=>['kind','scenarioId','attackerId','defenderId','move','route','authoredId'].includes(key)&&typeof value==='string'&&value.length>=1&&value.length<=200)),'focus must contain at most four nonempty exact question selectors');
  // The maintained analysis function is the sole numerical input builder. A
  // zero call budget and absent handler guarantee preparation performs no
  // damage/Speed arithmetic and cannot dispatch a calculator.
  const prepared=await analyzeNumerics(ctx,{hypotheses,maxCalls:0,budgetMs:0});
  const tickets=[],byId=new Map(),unavailable=[];
  const add=(name,args,descriptor)=>{
    const id=ticketId(binding,name,args),existing=byId.get(id);
    if(existing){existing.questions.push(descriptor);return;}
    const ticket={id,name,args:copy(args),questions:[descriptor]};byId.set(id,ticket);tickets.push(ticket);
  };
  for(const row of prepared.order){
    if(row.checkId){const entry=prepared.checks.find(check=>check.id===row.checkId);add(entry.tool,entry.input,{kind:'move-order',scenarioId:row.scenarioId,label:row.label,
      actorIds:entry.input.pokemon.map(actor=>actor.label),assumptions:copy(row.assumptions),warnings:copy(row.warnings),
      missingActors:copy(row.unavailable),scope:'Equal-priority current Speed only; delivery, priority changes and future field transitions remain unchecked'});}
    else unavailable.push({kind:'move-order',scenarioId:row.scenarioId,reasons:[...row.warnings,...row.unavailable.flatMap(actor=>actor.reasons.map(reason=>`${actor.actorId}: ${reason}`))]});
  }
  for(const row of prepared.damage){
    const descriptor={kind:'damage-range',scenarioId:row.scenarioId,attackerId:row.attackerId,defenderId:row.defenderId,move:row.move,route:row.route,
      assumptions:copy(row.assumptions),warnings:copy(row.warnings),scope:'Independent native damage range; no joint removal or delivery guarantee'};
    if(row.checkId){const entry=prepared.checks.find(check=>check.id===row.checkId);add(entry.tool,entry.input,descriptor);}
    else unavailable.push({...descriptor,reasons:copy(row.warnings)});
  }
  const usedSimulationIds=new Set();
  for(const value of simulationRequests){check(!usedSimulationIds.has(value.id),'authored simulation IDs must be unique');usedSimulationIds.add(value.id);const entry=simulationInput(value,binding,ctx);add(entry.name,entry.args,entry.descriptor);}
  const matches=(question,selector)=>Object.entries(selector).every(([key,value])=>question[key]===value);
  const focused=focus.map(question=>{
    const available=tickets.filter(ticket=>ticket.questions.some(value=>matches(value,question))),missing=unavailable.filter(value=>matches(value,question));
    const status=available.length===1&&missing.length===0?'ready':available.length>1||available.length&&missing.length?'ambiguous':missing.length?'unavailable':'missing';
    return {question:copy(question),status,ids:available.map(ticket=>ticket.id),unavailableQuestions:missing.length,
      ...(missing.length?{reasons:[...new Set(missing.flatMap(value=>value.reasons??value.warnings??[]))]}:{})};
  });
  const focusedIds=new Set(focused.flatMap(value=>value.ids)),eligible=focus.length?tickets.filter(ticket=>focusedIds.has(ticket.id)):tickets;
  const selected=eligible.slice(0,maxTickets),warnings=prepared.warnings.filter(warning=>!/MCP callTool unavailable/.test(warning));
  // A source binding identifies a board, not a particular prepared menu. An
  // authored simulation, label or cap changes the catalog even when its first
  // numerical ticket is identical or that simulation falls beyond the cap.
  const preparation={maxTickets,focus:copy(focus),hash:digest({tickets,unavailable,warnings})};
  const catalog={schemaVersion:1,kind:'champions-research-catalog',contract:CONTRACT,
    catalogId:`catalog-${digest({binding,preparation}).slice(0,24)}`,binding,preparation,tickets:selected,unavailable,warnings,
    focus:focused,...(focused.length&&focused.every(value=>value.status==='ready')&&[...focusedIds].every(id=>selected.some(ticket=>ticket.id===id))?{selectedIds:[...focusedIds]}:{}),
    coverage:{preparedTickets:tickets.length,availableTickets:selected.length,omittedTickets:tickets.length-selected.length,unavailableQuestions:unavailable.length,
      calculationsRun:0,explicitHypotheses:hypotheses.length,sourceFreshness:'caller must revalidate exact current source before dispatch'}};
  catalog.integrity=digest(catalog);
  return freeze(catalog);
}

/** Resolve IDs only against their original source, facts, hypotheses and loaded
 * calculator runtime. Return read-only requests for the existing executor; this
 * function never invokes tools, stages a fallback or sends a battle choice. */
export function resolveResearchTickets(catalog,{ids,current}={}){
  check(catalog?.kind==='champions-research-catalog'&&catalog.contract===CONTRACT,'unsupported catalog');
  const {integrity,...payload}=catalog;check(integrity===digest(payload),'catalog was modified');
  const binding=bindingOf(current);check(digest(binding)===digest(catalog.binding),'catalog is stale or belongs to different source, facts, hypotheses or runtime');
  check(Array.isArray(ids)&&ids.length>=1&&ids.length<=4&&ids.every(id=>typeof id==='string'),'select one to four research IDs');
  check(new Set(ids).size===ids.length,'research IDs must be unique');
  return ids.map(id=>{
    const matches=catalog.tickets.filter(ticket=>ticket.id===id);check(matches.length===1,'unknown research ID');
    const ticket=matches[0];check(ticket.id===ticketId(binding,ticket.name,ticket.args),'ticket inputs were modified');
    return {name:ticket.name,args:copy(ticket.args)};
  });
}

/** Compact public menu. Full native inputs stay in the caller-owned catalog;
 * assumptions and omitted counts remain visible and are never marked checked. */
export function projectResearchCatalog(catalog,{maxTickets=24,maxUnavailable=8,maxBytes=4096,includeSource=false}={}){
  check(catalog?.kind==='champions-research-catalog','unsupported catalog');
  check(Number.isInteger(maxTickets)&&maxTickets>=0&&maxTickets<=128&&Number.isInteger(maxUnavailable)&&maxUnavailable>=0&&maxUnavailable<=64,'invalid projection bounds');
  check(Number.isInteger(maxBytes)&&maxBytes>=1024&&maxBytes<=32768,'menu byte budget must be 1024–32768');
  let ticketCount=Math.min(maxTickets,catalog.tickets.length),unavailableCount=Math.min(maxUnavailable,catalog.unavailable.length);
  const project=()=>{
    const notes=[],note=value=>{let index=notes.indexOf(value);if(index<0){index=notes.length;notes.push(value);}return index;};
    const refs=values=>values?.length?values.map(note):undefined;
    const question=value=>{
      const result=Object.fromEntries(['kind','scenarioId','attackerId','defenderId','move','route','actorIds','authoredId','label'].filter(key=>value[key]!==undefined&&!(key==='label'&&value.scenarioId)).map(key=>[key,copy(value[key])]));
      if(value.assumptions?.length)result.assumptions=refs(value.assumptions);
      if(value.warnings?.length)result.warnings=refs(value.warnings);
      if(value.reasons?.length)result.reasons=refs(value.reasons);
      if(value.missingActors?.length)result.missingActors=value.missingActors.map(actor=>({actorId:actor.actorId,reasons:refs(actor.reasons)}));
      if(value.kind==='paired-simulation')result.scope=value.scope;
      return result;
    };
    const tickets=catalog.tickets.slice(0,ticketCount).map(({id,name,questions})=>({id,name,questions:questions.map(question)}));
    const unavailable=catalog.unavailable.slice(0,unavailableCount).map(question);
    const scenarioIds=new Set([...tickets.flatMap(ticket=>ticket.questions),...unavailable].map(value=>value.scenarioId).filter(Boolean));
    const kinds=['damage-range','move-order','paired-simulation'];
    const count=(rows,kind)=>rows.reduce((sum,row)=>sum+(row.questions??[row]).filter(value=>value.kind===kind).length,0);
    const checkRouting={kind:'independent-snapshot-check-routes',inputOnly:true,independentOfTurnReconstruction:['damage-range','move-order'],
      questions:Object.fromEntries(kinds.map(kind=>[kind,{displayed:count(tickets,kind),hidden:count(catalog.tickets,kind)-count(tickets,kind),unavailable:count(catalog.unavailable,kind)}])),
      scope:'Ranges and listed-actor equal-priority order are independent questions. Neither proves paired delivery/removal or future form/field transitions.'};
    return {kind:'champions-research-menu',catalogId:catalog.catalogId,...(includeSource?{source:copy(catalog.binding.source)}:{}),tickets,unavailable,focusReady:Boolean(catalog.selectedIds?.length),checkRouting,
      focus:catalog.focus.map(({reasons,...value})=>({...copy(value),...(reasons?.length?{reasons:refs(reasons)}:{})})),
      ...(catalog.selectedIds?{selectedIds:copy(catalog.selectedIds)}:{}),
      scenarios:[...scenarioIds].map(id=>({id,label:id==='observed'?'Observed inputs; missing investments unknown':catalog.binding.hypotheses.find(value=>value.id===id)?.label??id})),
      notes,warnings:copy(catalog.warnings),
      coverage:{...catalog.coverage,displayedTickets:tickets.length,hiddenAvailableTickets:catalog.tickets.length-tickets.length,
        hiddenUnavailableQuestions:catalog.unavailable.length-unavailable.length},
      use:'Select 1–4 IDs through the bounded calculation operation. No calculations have run. Order checks cover equal-priority Speed; ranges do not prove joint removal/delivery. Material removal still needs an authored paired simulation. Warning/assumption/reason numbers index notes.'};
  };
  let result=project();
  while(Buffer.byteLength(JSON.stringify(result))>maxBytes&&(unavailableCount>0||ticketCount>0)){
    if(unavailableCount>0)unavailableCount--;else ticketCount--;
    result=project();
  }
  if(Buffer.byteLength(JSON.stringify(result))>maxBytes)return {kind:'champions-research-menu',catalogId:catalog.catalogId,...(includeSource?{source:copy(catalog.binding.source)}:{}),status:'full-menu-required',focusReady:false,
    coverage:result.coverage,reason:'Essential source warnings exceed this byte budget; no partial check is shown as ready.'};
  return result;
}
