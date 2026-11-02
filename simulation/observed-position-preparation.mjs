// Prospective preparation only. Invocations perform no I/O or dispatch. Importing
// the authoritative delivery schema retains its existing dependency fingerprint
// reads; module loading is not claimed to be filesystem-free.
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {z} from 'zod';
import {inspectObservedPositionReadiness,OBSERVED_POSITION_READINESS_MAX_BYTES} from './observed-position-readiness.mjs';
import {bindObservedActions,publishedSheetDigest} from './observed-position.mjs';
import {branchSchema,simulationToolSchema,simulationCoreSchema} from './schemas.mjs';
import {deliveryCheckSchema} from '../planning/delivery.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const jsonHash=value=>hash(JSON.stringify(value));
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const HASH=/^[a-f0-9]{64}$/;
const message=error=>{if(error==null||types.isProxy(error))return 'Preparation refused';try{return typeof error.message==='string'?error.message:'Preparation refused';}catch{return 'Preparation refused';}};
const own=(value,key)=>{
  if(value===null||typeof value!=='object'||types.isProxy(value))throw new TypeError('Ordinary report data required');
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(descriptor&&!Object.hasOwn(descriptor,'value'))throw new TypeError('Report accessors are unsupported');
  return descriptor?.value;
};

// Local bounded JSON copy for the authored preparation options and whitelisted
// report fields. No getters, Proxy traps, toJSON or caller callbacks are invoked.
function copyJson(value,maxBytes=OBSERVED_POSITION_READINESS_MAX_BYTES){
  let count=0,size=0;const ancestors=new Set();
  const charge=text=>{if((size+=Buffer.byteLength(text))>maxBytes)throw new TypeError('Preparation JSON exceeds byte limit');};
  const visit=(entry,depth)=>{
    if(depth>64||++count>100000)throw new TypeError('Preparation JSON exceeds depth/node limit');
    if(entry===null||typeof entry==='boolean'||typeof entry==='number'&&Number.isFinite(entry)){charge(JSON.stringify(entry));return entry;}
    if(typeof entry==='string'){if(Buffer.byteLength(entry)>maxBytes)throw new TypeError('Preparation string exceeds byte limit');charge(JSON.stringify(entry));return entry;}
    if(!entry||typeof entry!=='object'||types.isProxy(entry))throw new TypeError('Preparation requires ordinary finite JSON data');
    const array=Array.isArray(entry),prototype=Object.getPrototypeOf(entry);
    if(!array&&prototype!==Object.prototype&&prototype!==null||ancestors.has(entry))throw new TypeError('Preparation requires acyclic plain JSON data');
    const keys=Reflect.ownKeys(entry).filter(key=>!(array&&key==='length'));
    if(array&&(entry.length>100000||keys.length!==entry.length))throw new TypeError('Preparation requires dense JSON arrays');
    ancestors.add(entry);charge(array?'[]':'{}');const result=array?[]:{};
    for(const [index,key]of keys.entries()){
      if(typeof key!=='string'||Buffer.byteLength(key)>maxBytes)throw new TypeError('Preparation property name exceeds JSON limits');
      const descriptor=Object.getOwnPropertyDescriptor(entry,key);
      if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value')||array&&key!==String(index))throw new TypeError('Preparation requires ordinary JSON data properties');
      if(index)charge(',');if(!array)charge(JSON.stringify(key)+':');
      Object.defineProperty(result,key,{value:visit(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});
    }
    ancestors.delete(entry);return result;
  };
  return visit(value,0);
}

function excerpt(value,limit=144){
  const text=typeof value==='string'?value:String(value??'');let result='',used=0;
  for(const character of text){const n=Buffer.byteLength(character);if(used+n>limit)break;result+=character;used+=n;}
  return {text:result,truncated:result!==text,textSha256:hash(text)};
}
function shortPath(path){
  const values=Array.isArray(path)?path:[];return {path:values.map(value=>typeof value==='number'?value:excerpt(value,64).text),
    ...(values.some(value=>typeof value!=='number'&&excerpt(value,64).truncated)?{pathTruncated:true,pathJsonSha256:jsonHash(values)}:{})};
}
function shortIssue(row){
  return {category:excerpt(row.category,48).text,origin:excerpt(row.origin,64).text,...shortPath(row.path),message:excerpt(row.message)};
}

/** Bounded presentation of an actual inspector report, never its private built
 * team/position. Counts are [total rows, displayed rows, omitted rows]. Supplied
 * hypothesis rows and supported-ability rows are intentionally omitted/countable.
 * Byte-budget omissions always produce ready=false/status=over-budget. */
export function projectObservedReadinessCard(report,options={}){
  const checked=copyJson(options),maxBytes=own(checked,'maxBytes')??4096;
  if(Object.keys(checked).some(key=>key!=='maxBytes')||!Number.isInteger(maxBytes)||maxBytes<1024||maxBytes>32768)throw new RangeError('Readiness card maxBytes must be1024..32768');
  const keys=['kind','ready','binding','coverage','blockers','unevaluated','knownInputs','consumedObservationInputs','authoredRequirements','currentAbilitySupport','currentAbilityDiagnostic'];
  const selected={};for(const key of keys){const value=own(report,key);if(value!==undefined)selected[key]=value;}
  const data=copyJson(selected,4*OBSERVED_POSITION_READINESS_MAX_BYTES);
  if(data.kind!=='observed-position-readiness-v1')throw new TypeError('An observed-position readiness report is required');
  const all={blockers:data.blockers??[],unevaluated:data.unevaluated??[],knownInputs:data.knownInputs??[],consumedObservationInputs:data.consumedObservationInputs??[],
    authoredRequirements:data.authoredRequirements??[],currentAbilityFacts:data.currentAbilitySupport??[]};
  if(Object.values(all).some(value=>!Array.isArray(value)))throw new TypeError('Readiness report row arrays are required');
  const missing=all.authoredRequirements.filter(row=>row.status==='missing'),unsupported=all.currentAbilityFacts.filter(row=>row.listedSupported===false||row.unknown===true);
  const rows={blockers:all.blockers.map(shortIssue),unevaluated:all.unevaluated.map(row=>({check:excerpt(row.check,64).text,reason:excerpt(row.reason)})),
    missingAuthored:missing.map(row=>({...shortPath(row.path),reason:excerpt(row.reason,100)})),
    currentAbilityFacts:unsupported.map(row=>({pokemonId:excerpt(row.pokemonId,80),...(typeof row.ability==='string'?{ability:excerpt(row.ability,80)}:{}),
      ...(typeof row.listedSupported==='boolean'?{listedSupported:row.listedSupported}:{}),...(row.unknown?{unknown:true}:{}),appliesOnlyWhen:'current'})),
    knownInputs:all.knownInputs.map(row=>({...shortPath(row.path),...(HASH.test(row.jsonSha256??'')?{jsonSha256:row.jsonSha256}:{}),validation:excerpt(row.validation,64).text})),
    consumedObservationInputs:all.consumedObservationInputs.map(row=>({...shortPath(row.path),...(HASH.test(row.jsonSha256??'')?{jsonSha256:row.jsonSha256}:{}),validation:excerpt(row.validation,64).text}))};
  const binding=data.binding??{},hashes={};for(const key of ['inputJsonSha256','observedSourceSha256','opposingSheetSha256'])if(typeof binding[key]==='string'&&HASH.test(binding[key]))hashes[key]=binding[key];
  const first=all.blockers.find(row=>row.origin==='authoritative-builder-first-refusal');
  const reconstructable=data.ready===true&&data.coverage?.schema==='passed'&&data.coverage?.semantic==='passed'&&data.coverage?.semanticEnumerationComplete===true&&all.blockers.length===0&&
    all.unevaluated.every(row=>row.check==='native-reconstruction-and-branches');
  let overflow=false;
  const counts=()=>({blockers:[all.blockers.length,rows.blockers.length,all.blockers.length-rows.blockers.length],unevaluated:[all.unevaluated.length,rows.unevaluated.length,all.unevaluated.length-rows.unevaluated.length],
    missingAuthored:[missing.length,rows.missingAuthored.length,missing.length-rows.missingAuthored.length],authoredRequirements:[all.authoredRequirements.length,rows.missingAuthored.length,all.authoredRequirements.length-rows.missingAuthored.length],
    currentAbilityFacts:[all.currentAbilityFacts.length,rows.currentAbilityFacts.length,all.currentAbilityFacts.length-rows.currentAbilityFacts.length],knownInputs:[all.knownInputs.length,rows.knownInputs.length,all.knownInputs.length-rows.knownInputs.length],
    consumedObservationInputs:[all.consumedObservationInputs.length,rows.consumedObservationInputs.length,all.consumedObservationInputs.length-rows.consumedObservationInputs.length]});
  const render=()=>({kind:'observed-readiness-card-v1',ready:reconstructable&&!overflow,status:overflow?'over-budget':reconstructable?'reconstruction-ready':'blocked',hashes,
    hashLabels:{inputJsonSha256:'Exact JSON.stringify input order; not canonical',observedSourceSha256:'Consumed {action,board} input; not code'},
    sourceValidation:excerpt(binding.sourceValidation,64).text,coverage:{schema:data.coverage?.schema??'unevaluated',semantic:data.coverage?.semantic??'unevaluated',semanticEnumerationComplete:data.coverage?.semanticEnumerationComplete===true},
    ...(first?{firstSemanticRefusal:shortIssue(first)}:{}),currentAbilityApplicability:{requiredMode:'current',noModeInferred:data.currentAbilityDiagnostic?.noModeInferred===true,
      applicability:excerpt(data.currentAbilityDiagnostic?.applicability??'unevaluated',64).text,evaluation:excerpt(data.currentAbilityDiagnostic?.evaluation??'unevaluated',64).text},
    countsOrder:['total','displayed','omitted'],counts:counts(),...rows,
    caveats:['Authored-field inventory is advisory and incomplete. First semantic refusal leaves later guards unevaluated.','Ready means input reconstruction only; native/branch acceptance, freshness, effects and timing are unverified.','Missing paths and unsupported/unknown current abilities are shown; supplied hypotheses and known-supported ability rows are counted but omitted.']});
  let card=render();
  const dropOrder=['unevaluated','missingAuthored','currentAbilityFacts','knownInputs','consumedObservationInputs','blockers'];
  while(bytes(card)>maxBytes&&dropOrder.some(key=>rows[key].length)){
    overflow=true;rows[dropOrder.find(key=>rows[key].length)].pop();card=render();
  }
  if(bytes(card)>maxBytes){
    overflow=true;for(const values of Object.values(rows))values.length=0;
    card={kind:'observed-readiness-card-v1',ready:false,status:'over-budget',hashes,
      ...(first?{firstRefusal:{category:excerpt(first.category,48).text,messageTextSha256:hash(String(first.message??''))}}:{}),
      countsOrder:['total','displayed','omitted'],counts:counts(),
      caveat:'Full card exceeds budget. Reconstruction remains uncredited; inventory is advisory, first refusal is incomplete, and native acceptance is unverified.'};
  }
  if(bytes(card)>maxBytes)throw new RangeError('Essential readiness-card metadata exceeds maxBytes');
  return card;
}

export const observedSimulationPreparationOptionsSchema=z.strictObject({name:z.enum(['simulate_turn','battle_check_plan']),ourActions:branchSchema.shape.ourActions,
  branches:z.array(branchSchema.omit({ourActions:true})).min(1).max(3),seeds:simulationCoreSchema.shape.seeds,
  budgetMs:deliveryCheckSchema.shape.budgetMs.removeDefault(),expectedInputSha256:z.string().regex(HASH).optional(),objective:deliveryCheckSchema.shape.objective});
const blocked=(report,issues=[])=>{
  const projected=issues.length?{...report,ready:false,blockers:[...report.blockers,...issues.map(issue=>({category:'invalid-preparation',origin:'preparation-validator',path:issue.path??[],message:issue.message}))]}:report;
  return {status:'blocked',compiled:false,card:projectObservedReadinessCard(projected),issues,dispatches:0};
};

/** Compile two supported observed tool calls only. All actions/hypotheses/gates/
 * branches/seeds are explicit. The caller must separately enforce source/deadline
 * freshness and actual transport timeouts. An observed MCP call will revalidate
 * source and may write team-owned evidence; this function does neither. */
export function compileObservedSimulation(input,options){
  const readiness=inspectObservedPositionReadiness(input);
  if(!readiness.ready)return blocked(readiness);
  let authored;
  try{authored=copyJson(options);}catch(error){return blocked(readiness,[{path:[],message:message(error)}]);}
  const parsed=observedSimulationPreparationOptionsSchema.safeParse(authored);
  if(!parsed.success)return blocked(readiness,parsed.error.issues.map(({path,code,message})=>({path,code,message})));
  if(!Object.hasOwn(authored,'budgetMs'))return blocked(readiness,[{path:['budgetMs'],message:'An explicit1..3500ms compiler budget is required; schema defaults are not adopted.'}]);
  if(authored.expectedInputSha256!==undefined&&authored.expectedInputSha256!==readiness.binding.inputJsonSha256)return blocked(readiness,[{path:['expectedInputSha256'],message:'Exact input JSON binding changed.'}]);
  if(authored.name==='simulate_turn'&&authored.objective!==undefined)return blocked(readiness,[{path:['objective'],message:'simulate_turn goals belong in authored branch gates; top-level objective is unsupported.'}]);
  try{
    const exact=copyJson(input);if(jsonHash(exact)!==readiness.binding.inputJsonSha256)throw new Error('Input changed after readiness inspection');
    if(new Set(authored.branches.map(branch=>branch.id)).size!==authored.branches.length)throw new Error('Branch IDs must be unique');
    if(new Set(authored.seeds.map(seed=>JSON.stringify(seed))).size!==authored.seeds.length)throw new Error('Seeds must be explicit unique samples');
    const expected=exact.expected,observed=exact.observed;
    const actions=observed.actions.filter(action=>action.room===expected.room&&action.rqid===expected.rqid&&action.token===expected.token);
    if(actions.length!==1)throw new Error('Exact consumed request is no longer unique');
    const bound=bindObservedActions(authored.ourActions,readiness.reconstruction),legal=actions[0].legalActions;
    validateChoice({...legal,side:{...(legal.side??{}),pokemon:legal.pokemon}},bound);
    const source={sessionId:observed.sessionId,teamId:expected.teamId,room:expected.room,rqid:expected.rqid,token:expected.token,opposingSheetSha256:publishedSheetDigest(exact.opposingSheet)};
    const request={kind:'observed',source,hypotheses:structuredClone(exact.hypotheses),branches:authored.branches.map(branch=>({...structuredClone(branch),ourActions:structuredClone(bound)})),seeds:structuredClone(authored.seeds)};
    const args=authored.name==='simulate_turn'?{request,evidenceContext:{teamId:source.teamId,roomId:canonicalEvidenceRoom(source.room),turn:readiness.reconstruction.position.turn}}:
      {request,budgetMs:authored.budgetMs,...(authored.objective!==undefined?{objective:structuredClone(authored.objective)}:{})};
    // Validate with actual exports, retaining the authored request rather than
    // adopting parsed defaults or silently completing hypotheses/goals.
    (authored.name==='simulate_turn'?simulationToolSchema:deliveryCheckSchema).parse(args);
    const card=projectObservedReadinessCard(readiness);if(!card.ready)return {status:'blocked',compiled:false,card,issues:[],dispatches:0};
    return {status:'prepared',compiled:true,card,call:{name:authored.name,arguments:args},callOptions:{timeoutMs:authored.budgetMs},
      receipt:{kind:'pure-observed-simulation-preparation',inputJsonSha256:readiness.binding.inputJsonSha256,observedSourceSha256:readiness.binding.observedSourceSha256,
        sourceJsonSha256:jsonHash(source),authoredPreparationJsonSha256:jsonHash(authored),authoredOurActionsJsonSha256:jsonHash(authored.ourActions),boundOurActionsJsonSha256:jsonHash(bound),
        requestJsonSha256:jsonHash(request),nativeArgumentsJsonSha256:jsonHash(args),budgetMs:authored.budgetMs,
        budgetScope:authored.name==='simulate_turn'?'Call-option timeoutMs only; simulate_turn has no budgetMs argument':'Native budgetMs plus call-option timeoutMs; caller enforces transport deadline',
        nativeAcceptance:false,sourceFreshness:false,evidenceWritten:false,dispatches:0,
        limitations:['Preparation validates reconstruction, own pair and native schema only; opposing legality, semantic gate/state support and native acceptance remain future checks.','Canonical evidence metadata is derived from validated facts. Offline reuse must explicitly validate/remove evidence-only context and retain authored and adapted hashes.','No batch route, action/hypothesis selection, cutoff relaxation or control authority is supplied.']}};
  }catch(error){return blocked(readiness,[{path:[],message:message(error)}]);}
}
