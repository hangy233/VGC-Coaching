// Prospective, unused presentation helper. No I/O, native work or action selection.
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {buildObservedPosition,supportedObservedCurrentAbilities,hasObservedMegaUse} from './observed-position.mjs';
import {validateOwnReservePpSnapshot} from '../showdown/battle-state.mjs';
import {observedPositionInputSchema,observedBoostsSchema} from './schemas.mjs';

export const OBSERVED_POSITION_READINESS_MAX_BYTES=512*1024;
export const OBSERVED_POSITION_READINESS_MAX_DEPTH=64;
export const OBSERVED_POSITION_READINESS_MAX_NODES=20000;
const CONTRACT='observed-position-readiness-v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const at=(value,path)=>path.reduce((current,key)=>current!==null&&typeof current==='object'&&Object.hasOwn(current,key)?current[key]:undefined,value);
const id=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]/g,'');
const messageOf=error=>{
  if(error===null||error===undefined||types.isProxy(error))return 'Validation refused without an ordinary Error message';
  try{return typeof error.message==='string'?error.message:'Validation refused without an ordinary Error message';}
  catch{return 'Validation refused without an ordinary Error message';}
};

// Reject non-JSON inputs without invoking getters/toJSON, and bound traversal
// before serialization. The builder receives this exact JSON value, not a draft
// completed with placeholders or the schema's defaulted parse result.
function snapshot(value){
  let nodes=0,bytes=0;const ancestors=new Set();
  const charge=text=>{bytes+=Buffer.byteLength(text);if(bytes>OBSERVED_POSITION_READINESS_MAX_BYTES)throw new TypeError('Input exceeds512KiB JSON limit');};
  const visit=(entry,depth)=>{
    if(depth>OBSERVED_POSITION_READINESS_MAX_DEPTH||++nodes>OBSERVED_POSITION_READINESS_MAX_NODES)throw new TypeError('Input exceeds JSON depth/node limit');
    if(entry===null||typeof entry==='boolean'){charge(JSON.stringify(entry));return entry;}
    if(typeof entry==='string'){if(Buffer.byteLength(entry)>OBSERVED_POSITION_READINESS_MAX_BYTES)throw new TypeError('Input exceeds512KiB JSON limit');charge(JSON.stringify(entry));return entry;}
    if(typeof entry==='number'&&Number.isFinite(entry)){charge(JSON.stringify(entry));return entry;}
    if(!entry||typeof entry!=='object')throw new TypeError('Input must contain only finite JSON values');
    if(types.isProxy(entry))throw new TypeError('Input must not contain Proxy values');
    const array=Array.isArray(entry),prototype=Object.getPrototypeOf(entry);
    if(!array&&prototype!==Object.prototype&&prototype!==null)throw new TypeError('Input must contain only plain JSON objects');
    if(ancestors.has(entry))throw new TypeError('Input must not contain a JSON cycle');
    ancestors.add(entry);const result=array?[]:{};
    const keys=Reflect.ownKeys(entry).filter(key=>!(array&&key==='length'));
    if(array&&(entry.length>OBSERVED_POSITION_READINESS_MAX_NODES||keys.length!==entry.length))throw new TypeError('Input must contain dense JSON arrays');
    charge(array?'[]':'{}');
    for(const [index,key]of keys.entries()){
      if(typeof key!=='string')throw new TypeError('Input must contain ordinary JSON data properties');
      if(Buffer.byteLength(key)>OBSERVED_POSITION_READINESS_MAX_BYTES)throw new TypeError('Property name exceeds512KiB JSON limit');
      const descriptor=Object.getOwnPropertyDescriptor(entry,key);
      if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value')||array&&key!==String(index))throw new TypeError('Input must contain ordinary JSON data properties');
      if(index)charge(',');if(!array)charge(JSON.stringify(key)+':');
      Object.defineProperty(result,key,{value:visit(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});
    }
    ancestors.delete(entry);return result;
  };
  const input=visit(value,0),json=JSON.stringify(input);
  return {input,json,bytes:Buffer.byteLength(json),sha256:hash(json)};
}

function category(message,input,source){
  if(/ability suppression is unknown or active/.test(message)){
    const board=source.board?.value,foe=Array.isArray(board?.sides)?board.sides.find(side=>side?.id!==board.ownSide):null;
    const pokemon=Array.isArray(foe?.pokemon)?foe.pokemon.find(p=>typeof p?.id==='string'&&message.startsWith(`Observed position: ${p.id} ability suppression`)):null;
    if(pokemon&&pokemon.abilitySuppressed!==true&&pokemon.abilitySuppressed!==false&&at(input,['hypotheses','opposing',pokemon.id,'abilitySuppressed'])===undefined)return 'missing-hypothesis';
    return 'unsupported-mechanic';
  }
  if(/unsupported (?:stateful\/current ability|volatile|status\/counter|side condition|field condition|weather|terrain)|copied\/stale\/unmodeled current ability|ability suppression is unknown or active/.test(message))return 'unsupported-mechanic';
  if(/explicit.*hypothesis|require explicit|explicit hypothetical reserve count|exactly four explicit selected opposing|current side Mega-use history/.test(message))return 'missing-hypothesis';
  if(/team|token|sheet|room|rqid|source request|matching board|legal turn|partial\/forced request|observed sides|identity|requestIndex|request moves|own board|active slot|own fresh/.test(message))return 'invalid-source';
  return 'invalid-input';
}

function sourceSummary(input){
  const expected=input?.expected,observed=input?.observed;
  const actions=Array.isArray(observed?.actions)?observed.actions:[],boards=Array.isArray(observed?.boards)?observed.boards:[];
  const matches=actions.map((value,index)=>({value,index})).filter(({value})=>value?.room===expected?.room&&value?.rqid===expected?.rqid&&value?.token===expected?.token);
  const matchingBoards=boards.map((value,index)=>({value,index})).filter(({value})=>value?.room===expected?.room&&value?.request?.rqid===expected?.rqid);
  return {action:matches.length===1?matches[0]:null,board:matchingBoards.length===1?matchingBoards[0]:null,
    claimed:{...(expected&&typeof expected==='object'?{expected:structuredClone(expected)}:{}),...(typeof observed?.sessionId==='string'?{sessionId:observed.sessionId}:{}),
      ...(typeof observed?.teamSha256==='string'?{observedTeamSha256:observed.teamSha256}:{}),matchingActions:matches.length,matchingBoards:matchingBoards.length}};
}

function presentation(input,source){
  const known=[];
  for(const [path,origin]of [[['teamText'],'supplied locked six'],[['opposingSheet'],'supplied published sheet'],[['observed','actions'],'supplied request observations'],[['observed','boards'],'supplied board observations']]){
    const value=at(input,path);if(value!==undefined)known.push({path,origin,jsonSha256:hash(JSON.stringify(value)),validation:path[0]==='observed'?'supplied-container-binding-only':'unverified-until-authoritative-build'});
  }
  const requirements=[],requireField=(path,reason)=>requirements.push({path,reason,status:at(input,path)===undefined?'missing':'supplied-not-yet-validated'});
  for(const key of ['mode','label','opposing','reserves'])requireField(['hypotheses',key],'authoritative hypotheses schema');
  const board=source.board?.value,action=source.action?.value,mode=input?.hypotheses?.mode;
  const own=Array.isArray(board?.sides)?board.sides.find(side=>side?.id===board.ownSide):null;
  const foe=Array.isArray(board?.sides)?board.sides.find(side=>side?.id!==board.ownSide):null;
  const ownPokemon=Array.isArray(own?.pokemon)?own.pokemon:[],foePokemon=Array.isArray(foe?.pokemon)?foe.pokemon:[];
  const abilities=[];
  for(const p of foePokemon)if(typeof p?.id==='string'){
    const path=['hypotheses','opposing',p.id];
    for(const key of ['label','statPoints','hp'])requireField([...path,key],'explicit observed-foe hypothesis; no investment/HP inference');
    if(mode==='current'){
      for(const key of ['pp','lifecycle'])requireField([...path,key],'current opposing PP/history is not supplied by the sheet');
      if(!p.ability)requireField([...path,'ability'],'current opposing ability is not observed');
      if(!p.itemKnown)requireField([...path,'item'],'current opposing item is not known');
      if(p.abilitySuppressed!==false&&p.abilitySuppressed!==true)requireField([...path,'abilitySuppressed'],'unknown current opposing suppression requires explicit false evidence/hypothesis');
    }
  }
  if(mode==='current'){
    for(const side of [own,foe])if(side){
      if(hasObservedMegaUse(side))known.push({path:['observed','boards',source.board.index,'sides',board.sides.indexOf(side)],origin:'positive observed Mega-use event',validation:'positive-event-only'});
      else requireField(['hypotheses','sideMegaUsed',side.id],'unobserved Mega-use history requires an explicit value; absence is not false');
    }
    const activeIds=Array.isArray(own?.active)?own.active.map(value=>value?.pokemon):[];
    for(const p of ownPokemon)if(typeof p?.id==='string'){
      const path=['hypotheses','own',p.id];requireField([...path,'lifecycle'],'current own lifecycle is not observed');
      if(!activeIds.includes(p.id)){
        let retained=null;
        try{retained=validateOwnReservePpSnapshot({pokemon:p,requestEntry:action?.legalActions?.pokemon?.[p.requestIndex-1],observation:board.ownPpObservation,rqid:board.request?.rqid,authoredPp:at(input,[...path,'pp'])});}catch{}
        if(retained)known.push({path:['observed','boards',source.board.index,'sides',board.sides.indexOf(own),'pokemon',ownPokemon.indexOf(p),'ownPpSnapshot'],origin:'verified private request PP through clean observed exit to bench',validation:'shared-retained-PP-validator-passed'});
        else requireField([...path,'pp'],'own reserve PP requires explicit evidence/hypothesis');
      }
    }
    for(const [side,pokemon]of [[own,ownPokemon],[foe,foePokemon]])for(const p of pokemon){
      if(typeof p?.id!=='string')continue;
      const path=['hypotheses',side===own?'own':'opposing',p.id];
      if(Object.keys(observedBoostsSchema.shape).some(key=>!Number.isInteger(p.boosts?.[key])))requireField([...path,'boosts'],'unknown observed boosts require an explicit hypothesis');
      if(p.volatiles?.healblock)requireField([...path,'volatiles','healblock'],'Heal Block duration/source require an explicit hypothesis');
    }
    for(const [index,reserve]of (Array.isArray(input?.hypotheses?.reserves)?input.hypotheses.reserves:[]).entries()){
      for(const key of ['status','boosts','pp','lifecycle','volatiles'])requireField(['hypotheses','reserves',index,key],'current hypothetical reserve state must be explicit');
    }
  }
  // These facts are conditional diagnostics when no mode was authored. Their
  // availability never supplies a mode or authorizes the current-mode builder.
  if(mode!=='opening')for(const [side,pokemon]of [[own,ownPokemon],[foe,foePokemon]])for(const p of pokemon){
    if(typeof p?.id!=='string')continue;
    const requestEntry=side===own&&Number.isInteger(p.requestIndex)?action?.legalActions?.pokemon?.[p.requestIndex-1]:null;
    const ability=side===own?(requestEntry?.ability??p.ability):(at(input,['hypotheses','opposing',p.id,'ability'])??p.ability);
    abilities.push({pokemonId:p.id,appliesOnlyWhen:'current',...(typeof ability==='string'?{ability,listedSupported:supportedObservedCurrentAbilities.has(id(ability))}:{unknown:true}),
      scope:'Native ability catalog existence only; this is not a simulation support whitelist or a choice-admission decision.'});
  }
  return {knownInputs:known,authoredRequirements:requirements,
    ...(Number.isInteger(foe?.unrevealedSelected)?{reserveSelection:{expectedUnrevealedSelected:foe.unrevealedSelected,
      ...(Array.isArray(input?.hypotheses?.reserves)?{suppliedHypotheticalReserves:input.hypotheses.reserves.length}:{}),selection:'Caller must explicitly identify each hypothetical reserve; empty is not an inferred selection.'}}:{}),
    currentAbilitySupport:abilities,currentAbilityDiagnostic:{requiredMode:'current',noModeInferred:true,
      applicability:mode==='current'?'applicable':mode==='opening'?'not-applicable-opening':mode===undefined?'conditional-mode-not-authored':'conditional-mode-invalid',
      evaluation:mode==='opening'?'not-evaluated':source.action&&source.board?'native-catalog-membership-only':'unevaluated-source-mapping'},
    scope:'Paths reference this exact input snapshot. The requirement inventory is an advisory subset, not a complete second reconstruction validator; field/side-condition durations, conflicts and later semantic checks remain authoritative-builder work.'};
}

/** Inspect an exact complete or incomplete builder input, without constructing
 * missing state. Only a successful buildObservedPosition on this same snapshot
 * earns ready=true. Semantic refusals remain first-refusal-only until the
 * existing builder exposes shared structured diagnostics. No live freshness,
 * native execution, branch legality or usefulness is certified here. */
export function inspectObservedPositionReadiness(value,options={}){
  const report={schemaVersion:1,kind:CONTRACT,ready:false,status:'blocked',readinessScope:'Exact-state reconstruction only. This is not a move support gate; menu-legal choices can use explicit conditional native state.',blockers:[],unevaluated:[],
    coverage:{schema:'unevaluated',semantic:'unevaluated',semanticEnumerationComplete:false,calculationsRun:0},
    limits:{inputBytes:OBSERVED_POSITION_READINESS_MAX_BYTES,depth:OBSERVED_POSITION_READINESS_MAX_DEPTH,nodes:OBSERVED_POSITION_READINESS_MAX_NODES},
    semantics:'Prospective pure input inspection only. Selecting a future Mega action does not change the current species/ability being reconstructed. Opening mode must satisfy its actual existing builder rules.'};
  let expectedInputSha256;
  try{
    const checked=snapshot(options).input;
    if(checked===null||typeof checked!=='object'||Array.isArray(checked)||Object.keys(checked).some(key=>key!=='expectedInputSha256'))throw new TypeError('Only the optional expectedInputSha256 data property is accepted');
    expectedInputSha256=at(checked,['expectedInputSha256']);
  }catch(error){
    report.blockers.push({category:'invalid-input',origin:'bounded-options',path:[],message:messageOf(error)});
    report.unevaluated.push({check:'schema-and-reconstruction',reason:'Inspection options were not bounded ordinary JSON data.'});return report;
  }
  let saved;
  try{saved=snapshot(value);}catch(error){
    report.blockers.push({category:'invalid-input',origin:'bounded-JSON',path:[],message:messageOf(error)});
    report.unevaluated.push({check:'schema-and-reconstruction',reason:'No bounded plain JSON snapshot was available.'});return report;
  }
  const {input}=saved,source=sourceSummary(input);
  report.binding={inputJsonSha256:saved.sha256,inputBytes:saved.bytes,inputHashSemantics:'SHA-256 of exact JSON.stringify(snapshot) property order; not canonical JSON',sourceValidation:'unverified',...source.claimed};
  Object.assign(report,presentation(input,source));
  if(expectedInputSha256!==undefined&&(typeof expectedInputSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedInputSha256)||expectedInputSha256!==saved.sha256)){
    report.blockers.push({category:'invalid-source',origin:'expected-input-binding',path:[],message:'Expected input JSON SHA-256 does not match this exact snapshot.'});
    report.unevaluated.push({check:'schema-and-reconstruction',reason:'Caller input binding changed or is malformed.'});return report;
  }
  const parsed=observedPositionInputSchema.safeParse(input);
  if(!parsed.success){
    report.coverage.schema='failed';
    for(const issue of parsed.error.issues){
      const hypothesis=issue.path[0]==='hypotheses';
      report.blockers.push({category:hypothesis?(at(input,issue.path)===undefined?'missing-hypothesis':'invalid-hypothesis'):'invalid-source',
        origin:'authoritative-schema',path:[...issue.path],code:issue.code,message:issue.message});
    }
    report.coverage.allSchemaIssuesRetained=true;
    report.unevaluated.push({check:'authoritative-semantic-reconstruction',reason:'Schema failed; no placeholders were supplied to reach later checks.'});return report;
  }
  report.coverage.schema='passed';
  try{
    const reconstruction=buildObservedPosition(input);
    report.ready=true;report.status='ready';report.reconstruction=reconstruction;
    report.coverage.semantic='passed';report.coverage.semanticEnumerationComplete=true;
    report.binding.sourceValidation='authoritative-builder-passed';report.binding.observedSourceSha256=reconstruction.provenance.sourceSha256;
    report.binding.observedSourceHashSemantics='SHA-256 of JSON.stringify({action,board}); consumed observation input, not executable source';
    report.binding.opposingSheetSha256=reconstruction.provenance.opposingSheetSha256;
    for(const row of report.knownInputs)if(row.path[0]!=='observed')row.validation='authoritative-builder-passed';
    report.consumedObservationInputs=[{path:['observed','actions',source.action.index],jsonSha256:hash(JSON.stringify(source.action.value)),validation:'authoritative-builder-passed'},
      {path:['observed','boards',source.board.index],jsonSha256:hash(JSON.stringify(source.board.value)),validation:'authoritative-builder-passed'}];
  }catch(error){
    const message=messageOf(error);
    report.coverage.semantic='first-refusal';
    report.blockers.push({category:category(message,input,source),origin:'authoritative-builder-first-refusal',path:[],message,
      classification:'Advisory message-and-input classification; the unchanged authoritative refusal is retained verbatim.'});
    report.unevaluated.push({check:'remaining-semantic-checks',reason:'The existing builder throws at its first refusal. All later semantic blockers are unknown; this report does not enumerate or certify them.'});
  }
  report.unevaluated.push({check:'native-reconstruction-and-branches',reason:'No engine, paired-action validator or numerical transport was invoked; successful input construction is not native acceptance or timing evidence.'});
  return report;
}
