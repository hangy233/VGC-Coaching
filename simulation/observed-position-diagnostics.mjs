// Diagnostic presentation only: no state completion, calculation, retry or I/O.
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {inspectObservedPositionReadiness,OBSERVED_POSITION_READINESS_MAX_BYTES,OBSERVED_POSITION_READINESS_MAX_DEPTH,OBSERVED_POSITION_READINESS_MAX_NODES} from './observed-position-readiness.mjs';
import {observedPpSchema} from './schemas.mjs';
import {validateOwnReservePpSnapshot} from '../showdown/battle-state.mjs';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at=(value,path)=>path.reduce((entry,key)=>entry!==null&&typeof entry==='object'&&Object.hasOwn(entry,key)?entry[key]:undefined,value);

// The existing inspector keeps its bounded snapshot private. Make a separately
// bounded data-only copy for typed comparisons, and bind it to that exact hash.
// Never invoke caller getters, toJSON, Proxy traps or a callback to obtain facts.
function snapshot(value){
  let nodes=0,bytes=0;const ancestors=new Set();
  const charge=text=>{if((bytes+=Buffer.byteLength(text))>OBSERVED_POSITION_READINESS_MAX_BYTES)throw new TypeError('Diagnostic input exceeds byte limit');};
  const visit=(entry,depth)=>{
    if(depth>OBSERVED_POSITION_READINESS_MAX_DEPTH||++nodes>OBSERVED_POSITION_READINESS_MAX_NODES)throw new TypeError('Diagnostic input exceeds traversal limit');
    if(entry===null||typeof entry==='boolean'||typeof entry==='number'&&Number.isFinite(entry)){charge(JSON.stringify(entry));return entry;}
    if(typeof entry==='string'){if(Buffer.byteLength(entry)>OBSERVED_POSITION_READINESS_MAX_BYTES)throw new TypeError('Diagnostic input exceeds byte limit');charge(JSON.stringify(entry));return entry;}
    if(!entry||typeof entry!=='object'||types.isProxy(entry))throw new TypeError('Ordinary finite JSON data required');
    const array=Array.isArray(entry),prototype=Object.getPrototypeOf(entry);
    if(!array&&prototype!==Object.prototype&&prototype!==null||ancestors.has(entry))throw new TypeError('Acyclic plain JSON required');
    const keys=Reflect.ownKeys(entry).filter(key=>!(array&&key==='length'));
    if(array&&(entry.length>OBSERVED_POSITION_READINESS_MAX_NODES||keys.length!==entry.length))throw new TypeError('Dense JSON arrays required');
    ancestors.add(entry);charge(array?'[]':'{}');const result=array?[]:{};
    for(const [index,key]of keys.entries()){
      if(typeof key!=='string'||Buffer.byteLength(key)>OBSERVED_POSITION_READINESS_MAX_BYTES)throw new TypeError('Ordinary bounded property names required');
      const descriptor=Object.getOwnPropertyDescriptor(entry,key);
      if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value')||array&&key!==String(index))throw new TypeError('Ordinary JSON data properties required');
      if(index)charge(',');if(!array)charge(JSON.stringify(key)+':');
      Object.defineProperty(result,key,{value:visit(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});
    }
    ancestors.delete(entry);return result;
  };
  return visit(value,0);
}

function collectOwnPp(input,add){
  if(input?.hypotheses?.mode!=='current')return {status:'not-applicable',reason:'Only an explicitly authored current mode compares current PP.'};
  const expected=input.expected,actions=Array.isArray(input.observed?.actions)?input.observed.actions:[],boards=Array.isArray(input.observed?.boards)?input.observed.boards:[];
  const matches=actions.map((value,index)=>({value,index})).filter(({value})=>value?.room===expected?.room&&value?.rqid===expected?.rqid&&value?.token===expected?.token);
  const bound=boards.map((value,index)=>({value,index})).filter(({value})=>value?.room===expected?.room&&value?.request?.rqid===expected?.rqid);
  if(matches.length!==1||bound.length!==1)return {status:'unevaluated',reason:'A unique supplied action/board binding is required.'};
  const {value:action,index:actionIndex}=matches[0],{value:board,index:boardIndex}=bound[0],legal=action.legalActions;
  const own=Array.isArray(board.sides)?board.sides.filter(side=>side?.id===board.ownSide):[];
  if(!['p1','p2'].includes(board.ownSide)||own.length!==1||!Array.isArray(own[0].pokemon)||own[0].pokemon.length!==4||!Array.isArray(own[0].active)||own[0].active.length!==2||
    !Array.isArray(legal?.pokemon)||legal.pokemon.length!==4||!Array.isArray(legal?.active)||legal.active.length!==2)return {status:'unevaluated',reason:'Complete supplied own request/active mapping is required.'};
  const side=own[0],activeIds=side.active.map(slot=>slot?.pokemon);
  if(new Set(activeIds).size!==2||new Set(side.pokemon.map(p=>p?.id)).size!==4||new Set(side.pokemon.map(p=>p?.requestIndex)).size!==4||side.active.some((slot,index)=>slot?.slot!=='ab'[index]))return {status:'unevaluated',reason:'Supplied own identities or active order are ambiguous.'};
  let compared=0;
  for(const [pokemonIndex,p]of side.pokemon.entries()){
    if(typeof p?.id!=='string'||!Number.isInteger(p.requestIndex)||p.requestIndex<1||p.requestIndex>4)continue;
    const activeIndex=activeIds.indexOf(p.id),entry=legal.pokemon[p.requestIndex-1],path=['hypotheses','own',p.id,'pp'],authored=at(input,path);
    if(!entry||Boolean(entry.active)!==(activeIndex>=0))continue;
    let actual,sourcePath,origin;
    if(activeIndex>=0){
      actual=legal.active[activeIndex]?.moves?.map(move=>move?.pp);
      sourcePath=['observed','actions',actionIndex,'legalActions','active',activeIndex,'moves'];origin='fresh-private-active-request';
    }else{
      try{
        const retained=validateOwnReservePpSnapshot({pokemon:p,requestEntry:entry,observation:board.ownPpObservation,rqid:board.request?.rqid});
        actual=retained?.pp;
      }catch{
        add({status:'unusable-source-evidence',code:'retained-own-pp-refused',origin:'shared-retained-PP-validator',path:['observed','boards',boardIndex,'sides',board.sides.indexOf(side),'pokemon',pokemonIndex,'ownPpSnapshot'],reason:'The shared retained-PP guard refused this claimed source. No PP is adopted and no cause is inferred from error text.'});
        continue;
      }
      sourcePath=['observed','boards',boardIndex,'sides',board.sides.indexOf(side),'pokemon',pokemonIndex,'ownPpSnapshot','pp'];origin='shared-validated-retained-private-request';
    }
    if(!observedPpSchema.safeParse(actual).success||authored===undefined||!observedPpSchema.safeParse(authored).success)continue;
    compared++;
    if(JSON.stringify(actual)!==JSON.stringify(authored))add({status:'conflict',code:'own-pp-conflicts-observation',origin:'exact-own-PP-comparison',path,sourcePath,sourceKind:origin,
      conflictingIndices:actual.flatMap((pp,index)=>pp===authored[index]?[]:[index]),observedValueSha256:sha(actual),authoredValueSha256:sha(authored),
      reason:'Authored PP differs from the supplied private request evidence. Neither array was changed.'});
  }
  return {status:'evaluated-advisory-subset',compared,sourceValidation:'supplied binding only; this comparison does not validate the complete position'};
}

/** Collect simultaneous diagnostic paths without repairing an input. The
 * existing authoritative builder alone determines reconstruction readiness.
 * Complete schema issues, the maintained missing-field inventory, and direct
 * own-PP conflicts are aggregated. Later semantic guards remain first-refusal
 * only: this is deliberately not a second reconstruction validator. */
export function collectObservedPositionDiagnostics(value,options={}){
  const readiness=inspectObservedPositionReadiness(value,options),diagnostics=[],seen=new Set();
  const add=row=>{const key=JSON.stringify([row.status,row.code,row.path]);if(!seen.has(key)){seen.add(key);diagnostics.push(row);}};
  for(const row of readiness.blockers)if(row.origin==='authoritative-schema')add({status:row.category==='missing-hypothesis'?'missing':'invalid',code:row.code,origin:row.origin,path:[...row.path],reason:row.message});
  for(const row of readiness.authoredRequirements??[])if(row.status==='missing')add({status:'missing',code:'authored-field-required',origin:'maintained-authored-requirement-inventory',path:[...row.path],reason:row.reason});
  let pp={status:'unevaluated',reason:'No exact bounded snapshot was available.'};
  if(readiness.binding&&!readiness.blockers.some(row=>['bounded-options','expected-input-binding'].includes(row.origin))){
    try{
      const input=snapshot(value);
      pp=sha(input)===readiness.binding.inputJsonSha256?collectOwnPp(input,add):{status:'unevaluated',reason:'Input changed after the authoritative inspection.'};
    }catch{pp={status:'unevaluated',reason:'No unchanged bounded data-only snapshot was available.'};}
  }
  const first=readiness.blockers.find(row=>row.origin==='authoritative-builder-first-refusal');
  return {schemaVersion:1,kind:'observed-position-diagnostics-v1',ready:readiness.ready===true,status:readiness.status,
    ...(readiness.binding?{binding:{inputJsonSha256:readiness.binding.inputJsonSha256,inputBytes:readiness.binding.inputBytes,sourceValidation:readiness.binding.sourceValidation,
      ...(readiness.binding.observedSourceSha256?{observedSourceSha256:readiness.binding.observedSourceSha256}:{}),...(readiness.binding.opposingSheetSha256?{opposingSheetSha256:readiness.binding.opposingSheetSha256}:{})}}:{}),
    diagnostics,counts:{missing:diagnostics.filter(row=>row.status==='missing').length,conflicting:diagnostics.filter(row=>row.status==='conflict').length,invalid:diagnostics.filter(row=>row.status==='invalid').length,unusableSourceEvidence:diagnostics.filter(row=>row.status==='unusable-source-evidence').length},
    ...(first?{authoritativeFirstRefusal:{message:first.message,origin:first.origin}}:{}),
    inputRefusals:readiness.blockers.filter(row=>!['authoritative-schema','authoritative-builder-first-refusal'].includes(row.origin)).map(row=>({origin:row.origin,path:row.path,reason:row.message})),
    coverage:{schema:readiness.coverage.schema,allSchemaIssuesRetained:readiness.coverage.allSchemaIssuesRetained===true,missingAuthoredInventory:'maintained advisory subset',ownPp:pp,
      semantic:readiness.coverage.semantic,semanticEnumerationComplete:readiness.coverage.semanticEnumerationComplete===true,allMissingAndConflictingFieldsEnumerated:false,calculationsRun:0},
    limitations:['Diagnostics do not supply, replace or choose any fact, hypothesis, action, branch, seed or gate.','No error message is parsed to infer a repair. The unchanged authoritative first refusal is presentation only.','All listed paths refer to this exact input. Field/condition durations and other later semantic conflicts are not fully enumerated.','Ready means the unchanged builder reconstructed this input only; native acceptance, live freshness, action execution and timing remain unverified.']};
}
