// Read-only presentation of existing authored checks. Native arguments remain
// separately owned by the caller/catalog; nothing here selects or executes one.
import {createHash} from 'node:crypto';
import {validateChoice} from './choice-validation.mjs';
import {simulationToolSchema,simulationBatchToolSchema} from '../simulation/mcp-tools.mjs';
import {branchSchema} from '../simulation/schemas.mjs';
import {requestDigest} from '../planning/identity.mjs';

const copy=structuredClone;
const simulation=name=>['simulate_turn','simulate_turn_batch'].includes(name);
const check=(ok,message)=>{if(!ok)throw new TypeError(`Check eligibility: ${message}`);};
const bytes=value=>Buffer.byteLength(JSON.stringify(value));


const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const stable=value=>Array.isArray(value)?value.map(stable):plain(value)?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
export const checkInputSha256=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function pair(legal,actions){check(Array.isArray(actions)&&actions.length===2,'Case eligibility requires both complete doubles actions');branchSchema.shape.ourActions.parse(actions);return validateChoice({...legal,side:{pokemon:legal.pokemon}},actions).choice;}
function casesOf(name,args){return name==='simulate_turn_batch'?args.request.cases:[{branches:args.request.branches,seeds:args.request.seeds}];}
const normalizedCase=entry=>({...entry,branches:entry.branches.map(branch=>branchSchema.parse(branch))});
function uniqueScenarios(cases){
  check(new Set(cases.map((entry,index)=>entry.id??index)).size===cases.length,'Simulation case IDs must be unique');
  for(const entry of cases){check(new Set(entry.branches.map(branch=>branch.id)).size===entry.branches.length,'Unique simulation branch IDs required');check(new Set(entry.seeds.map(seed=>JSON.stringify(seed))).size===entry.seeds.length,'Simulation seeds must be unique explicit samples');}
}

export function describeSimulationCaseEligibility(call,{legalActions}={}){
  check(plain(call)&&simulation(call.name)&&plain(call.args),'An actual simulation tool call is required');
  (call.name==='simulate_turn_batch'?simulationBatchToolSchema:simulationToolSchema).parse(call.args);
  check(plain(legalActions),'Current legal actions are required for canonical case eligibility');
  const cases=casesOf(call.name,call.args);uniqueScenarios(cases);
  const inputSha256=checkInputSha256(call.args);
  return cases.map(entry=>{
    const normalized=normalizedCase(entry),pairs=normalized.branches.map(branch=>{
      const choice=pair(legalActions,branch.ourActions);
      return {branchId:branch.id,choice,actions:validateChoice({...legalActions,side:{pokemon:legalActions.pokemon}},branch.ourActions).actions};
    }),unique=new Map(pairs.map(value=>[value.choice,value])),kinds=new Set(normalized.branches.map(branch=>branch.gate.kind==='delivery'?'delivery':'removal'));
    const eligibility=unique.size!==1?'ineligible-mixed-pairs':kinds.size!==1?'ineligible-mixed-gates':kinds.has('delivery')?'supporting-delivery-only':'removal-predicate';
    const canonicalPair=unique.size===1?{choice:pairs[0].choice,actions:structuredClone(pairs[0].actions)}:null;
    return {...(entry.id===undefined?{}:{caseId:entry.id}),eligibility,removalPredicateEligible:eligibility==='removal-predicate',canonicalPositivePair:eligibility==='removal-predicate'?canonicalPair:null,canonicalPair,branchPairs:pairs,inputSha256,caseSha256:checkInputSha256(entry),requiredGoalsSha256:checkInputSha256(normalized.branches.map(branch=>({id:branch.id,gate:branch.gate}))),sourceKind:call.args.request.kind,requestSource:structuredClone(call.args.request.source??null)};
  });
}

/** Raw supplied checks use their exact array indices. Catalog projections use
 * ticket IDs instead: those positions are not a future checks command's order.
 * Classification is syntax/identity only, never freshness or result evidence. */
export function projectCheckEligibility(calls,{legalActions,source,checkIds,catalogId,maxBytes=4096}={}){
  check(Number.isInteger(maxBytes)&&maxBytes>=1024&&maxBytes<=16384,'byte budget must be 1024–16384');
  check(Array.isArray(calls)&&calls.length>=1&&calls.length<=4,'one to four actual supplied checks are required');
  if(bytes(calls)>512*1024)return {kind:'simulation-case-eligibility-v1',status:'input-too-large',complete:false,checks:[],coverage:{checks:calls.length,displayedChecks:0,omittedChecks:calls.length,calculationsRun:0},reason:'Native arguments exceed the 512 KiB projection input bound; no selector is advertised.'};
  check(source===undefined||source&&typeof source==='object'&&!Array.isArray(source)&&bytes(source)<=4096,'bounded exact source binding required');
  check(checkIds===undefined||Array.isArray(checkIds)&&checkIds.length===calls.length&&new Set(checkIds).size===checkIds.length&&checkIds.every(id=>typeof id==='string'&&id.length>=1&&id.length<=200),'check IDs must uniquely match the supplied checks');
  check(catalogId===undefined||/^catalog-[a-f0-9]{24}$/u.test(catalogId)&&checkIds!==undefined,'catalog mode requires its actual catalog and ticket IDs');
  const indexScope=catalogId===undefined?'supplied-checks-array':'catalog-ticket-ids';
  const rows=calls.map((call,index)=>{
    check(call&&typeof call==='object'&&typeof call.name==='string'&&call.args&&typeof call.args==='object'&&!Array.isArray(call.args),'actual named native arguments required');
    const inputSha256=checkInputSha256(call.args),base={...(catalogId===undefined?{checkIndex:index}:{}),...(checkIds?{checkId:checkIds[index]}:{}),name:call.name,inputSha256};
    if(!simulation(call.name))return {...base,status:'not-a-simulation',role:['calculate_damage','calculate_speed'].includes(call.name)?'supporting-numerical-only':'ineligible-tool',cases:[]};
    const request=call.args.request,sourceInput=request?.kind==='observed'?{kind:request.kind,source:request.source}:request?.kind==='explicit'?{kind:request.kind,position:request.position}:null;
    const nativeSource={sourceKind:request?.kind??null,sourceSha256:checkInputSha256(sourceInput),...(request?.kind==='observed'?{requestSource:copy(request.source)}:{})};
    try{
      if(source?.kind==='bound-observed-turn'){
        check(request?.kind==='observed','an observed context cannot endorse an explicit scenario');
        for(const key of ['sessionId','teamId','room','rqid','token'])if(source[key]!==undefined)check(request.source?.[key]===source[key],`native source ${key} differs from the supplied context`);
        if(source.requestDigest!==undefined)check(requestDigest({...request.source,boardHash:source.boardHash})===source.requestDigest,'native request token differs from the supplied source');
        if(request.source?.opposingSheetSha256!==undefined)check(request.source.opposingSheetSha256===(source.publishedOpposingSheetSha256??source.opposingSheetSha256),'native published sheet differs from the supplied context');
      }else if(source?.kind==='explicit-hypothetical-snapshot')check(request?.kind==='explicit','a hypothetical context cannot endorse an observed request');
      const descriptors=describeSimulationCaseEligibility(call,{legalActions});
      return {...base,...nativeSource,status:'classified',cases:descriptors.map(descriptor=>{
        const homogeneous=descriptor.eligibility==='removal-predicate'||descriptor.eligibility==='supporting-delivery-only';
        const caseRef={...(descriptor.caseId===undefined?{}:{caseId:descriptor.caseId})};
        return {...caseRef,role:descriptor.eligibility,removalPredicateEligible:descriptor.removalPredicateEligible,
          canonicalPositivePair:copy(descriptor.canonicalPositivePair),...(descriptor.eligibility==='supporting-delivery-only'?{canonicalPair:copy(descriptor.canonicalPair)}:{}),
          branchPairs:copy(descriptor.branchPairs),caseSha256:descriptor.caseSha256,requiredGoalsSha256:descriptor.requiredGoalsSha256,
          ...(catalogId===undefined?{
            ...(descriptor.removalPredicateEligible?{simulationCheck:{index,...caseRef}}:{}),
            ...(homogeneous?{falseBranchCheck:{index,...caseRef,inputSha256}}:{}),
          }:{catalogCaseRef:{catalogId,checkId:checkIds[index],...caseRef},allowedUses:{removalPredicate:descriptor.removalPredicateEligible,falseMaterialCase:homogeneous}}),
        };
      })};
    }catch(error){return {...base,...nativeSource,status:'unavailable',reason:String(error.message??error),cases:[]};}
  });
  const totalCases=calls.reduce((n,call)=>n+(call.name==='simulate_turn_batch'?(call.args.request?.cases?.length??0):call.name==='simulate_turn'?1:0),0);
  const card={kind:'simulation-case-eligibility-v1',indexScope,...(catalogId?{catalogId}:{}),...(source?{source:copy(source),sourceBindingSha256:checkInputSha256(source)}:{}),
    inputHashScope:'Canonical complete native tool arguments; exact arguments remain separately retained without rewriting.',
    sourceFreshness:'Not established by this projection; the owning preparation/resolution must revalidate its source.',
    status:rows.some(row=>row.status==='unavailable')?'incomplete':'classified',complete:rows.every(row=>row.status!=='unavailable'),checks:rows,
    coverage:{checks:calls.length,cases:totalCases,displayedChecks:rows.length,omittedChecks:0,calculationsRun:0},
    limits:'Eligibility is not a sampled pass, materiality or usefulness judgment. False selection still requires exact authored ifFalseActions and complete clean qualifying material evidence. Catalog references do not supply a checks-array index.'};
  if(bytes(card)<=maxBytes)return card;
  return {kind:card.kind,status:'over-budget',complete:false,indexScope,...(catalogId?{catalogId}:{}),...(source?{sourceBindingSha256:card.sourceBindingSha256}:{}),
    fullProjectionSha256:checkInputSha256(card),checks:[],coverage:{checks:calls.length,cases:totalCases,displayedChecks:0,omittedChecks:calls.length,calculationsRun:0},
    reason:'Complete eligibility facts exceed this byte budget. No partial case or selector is advertised; exact native arguments remain separately retained.'};
}
