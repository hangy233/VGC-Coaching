// Bounded representative hypotheses, not a stat calculator or action planner.
// All numerical evidence comes from the caller's actual MCP dispatcher.
import {types} from 'node:util';
import {z} from 'zod';
import {digest} from '../planning/identity.mjs';
import {verifySpreadAttackerHpIrrelevance} from './spread-observations.mjs';

const STATS=['hp','atk','def','spa','spd','spe'],HASH=/^[a-f0-9]{64}$/u;
const NATURES=['Hardy','Lonely','Brave','Adamant','Naughty','Bold','Docile','Relaxed','Impish','Lax','Timid','Hasty','Serious','Jolly','Naive','Modest','Mild','Quiet','Bashful','Rash','Calm','Gentle','Sassy','Careful','Quirky'];
const name=z.string().min(1).max(100),hash=z.string().regex(HASH),jsonObject=z.record(z.string(),z.unknown());
export const spreadCandidatePointsSchema=z.strictObject(Object.fromEntries(STATS.map(stat=>[stat,z.number().int().min(0).max(32)]))).refine(value=>Object.values(value).reduce((sum,n)=>sum+n,0)===66,'Representative profiles allocate exactly66 legal M-C points');
const common={id:name,sourceSha256:hash,currentForme:name,input:jsonObject};
const speedVerification=z.strictObject({identityVerified:z.boolean(),bothExecuted:z.boolean(),samePriority:z.boolean(),forcedOrder:z.boolean(),conditionsKnown:z.boolean(),abilityItemKnown:z.boolean()});
const damageVerification=z.strictObject({identityVerified:z.boolean(),directMoveDamage:z.boolean(),conditionsKnown:z.boolean(),allOtherInvestmentsKnown:z.boolean(),exactHp:z.boolean(),roundedHp:z.boolean(),crit:z.boolean(),multihit:z.boolean(),uncapped:z.boolean(),additionalHpChanges:z.boolean(),attackerHpIrrelevant:z.boolean().optional()});
export const spreadCandidateObservationSchema=z.discriminatedUnion('kind',[
  z.strictObject({...common,kind:z.literal('move-order'),candidateIndex:z.number().int().min(0).max(1),beforeIndex:z.number().int().min(0).max(1),verification:speedVerification}),
  z.strictObject({...common,kind:z.literal('damage'),candidateRole:z.enum(['attacker','defender']),amount:z.number().int().min(0),verification:damageVerification}),
]);
export const spreadCandidatesInputSchema=z.strictObject({
  source:z.object({teamId:hash,sessionId:name,parentId:name,gameId:name,sourceSha256:hash}).passthrough(),
  publishedSet:z.strictObject({species:name,nature:z.enum(NATURES).nullable().optional(),ability:name,item:z.string().max(100),moves:z.array(name).length(4)}),
  currentForme:name,conditions:jsonObject,
  relevantMoves:z.array(z.strictObject({name,category:z.enum(['Physical','Special','Status'])})).max(4),
  observations:z.array(spreadCandidateObservationSchema).max(8).default([]),
  candidateSpreads:z.array(z.strictObject({nature:z.enum(NATURES),statPoints:z.strictObject(Object.fromEntries(STATS.map(stat=>[stat,z.number().int().min(0).max(32)]))).refine(points=>Object.values(points).reduce((sum,n)=>sum+n,0)<=66,'At most66 total legal points')})).min(1).max(32).optional(),
  poolLimit:z.number().int().min(1).max(32).default(16),maxCalls:z.number().int().min(0).max(256).default(128),
});
const key=value=>String(value).toLowerCase().replace(/[^a-z0-9]/gu,'');
const clone=value=>structuredClone(value);
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const cacheEntries=new WeakSet();

// Reject executable/hostile values before Zod, hashing or serialization. Bounds
// include the complete source and templates, with no silent field truncation.
function jsonSnapshot(value){
  let nodes=0,bytes=0;const ancestors=new Set(),limit=512*1024;
  const charge=text=>{if((bytes+=Buffer.byteLength(text))>limit)throw new TypeError('Spread input exceeds512KiB');};
  const visit=(entry,depth)=>{
    if(depth>48||++nodes>20000)throw new TypeError('Spread input exceeds traversal bound');
    if(entry===null||typeof entry==='boolean'||typeof entry==='number'&&Number.isFinite(entry)){charge(JSON.stringify(entry));return entry;}
    if(typeof entry==='string'){if(Buffer.byteLength(entry)>limit)throw new TypeError('Spread string exceeds bound');charge(JSON.stringify(entry));return entry;}
    if(!entry||typeof entry!=='object'||types.isProxy(entry))throw new TypeError('Spread input requires ordinary finite JSON');
    const array=Array.isArray(entry),prototype=Object.getPrototypeOf(entry);
    if(!array&&prototype!==Object.prototype&&prototype!==null||ancestors.has(entry))throw new TypeError('Spread input requires acyclic plain JSON');
    const keys=Reflect.ownKeys(entry).filter(k=>!(array&&k==='length'));
    if(array&&(entry.length>20000||keys.length!==entry.length))throw new TypeError('Spread arrays must be dense');
    const result=array?[]:{};ancestors.add(entry);charge(array?'[]':'{}');
    for(const [index,k]of keys.entries()){
      if(typeof k!=='string'||Buffer.byteLength(k)>limit)throw new TypeError('Spread property exceeds bound');
      const descriptor=Object.getOwnPropertyDescriptor(entry,k);
      if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value')||array&&k!==String(index))throw new TypeError('Spread values must be ordinary data properties');
      if(index)charge(',');if(!array)charge(JSON.stringify(k)+':');
      Object.defineProperty(result,k,{value:visit(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});
    }
    ancestors.delete(entry);return result;
  };
  return visit(value,0);
}

function profiles(input){
  if(input.candidateSpreads){
    if(input.publishedSet.nature&&input.candidateSpreads.some(c=>c.nature!==input.publishedSet.nature))throw new Error('Declared range conflicts with the published nature');
    const all=[...new Map(input.candidateSpreads.map(c=>[digest(c),c])).values()].map((candidate,index)=>({
      id:'declared-range-'+(index+1),family:'declared-range',nature:candidate.nature,statPoints:clone(candidate.statPoints),
      provenance:{natureSource:input.publishedSet.nature?'published-known':'explicit-ranged-hypothesis'},
      knownUnknowns:['Declared legal spread witness remains a hypothesis, not a revealed investment or exhaustive domain.'],checks:[]}));
    return {all,pool:all.slice(0,input.poolLimit),families:['declared-range']};
  }
  const physical=input.relevantMoves.some(move=>move.category==='Physical'),special=input.relevantMoves.some(move=>move.category==='Special');
  const points=(patch)=>Object.fromEntries(STATS.map(stat=>[stat,patch[stat]??0]));
  const families=[
    ['balanced',points({hp:11,atk:11,def:11,spa:11,spd:11,spe:11}),['Serious']],
    ['physical-bulk',points({hp:32,def:32,spd:2}),['Serious','Bold','Relaxed']],
    ['special-bulk',points({hp:32,def:2,spd:32}),['Serious','Calm','Sassy']],
    ['mixed-bulk',points({hp:32,def:16,spd:16,spe:2}),['Serious','Bold','Calm']],
    ['speed-bulk',points({hp:32,def:2,spe:32}),['Serious','Timid','Jolly']],
    ['zero-speed-bulk',points({hp:32,def:17,spd:17}),['Serious','Relaxed','Sassy']],
  ];
  if(physical)families.push(['physical-speed',points({hp:2,atk:32,spe:32}),['Serious','Adamant','Jolly']],['physical-hp',points({hp:32,atk:32,spe:2}),['Serious','Adamant','Brave']]);
  if(special)families.push(['special-speed',points({hp:2,spa:32,spe:32}),['Serious','Modest','Timid']],['special-hp',points({hp:32,spa:32,spe:2}),['Serious','Modest','Quiet']]);
  if(physical&&special)families.push(['mixed-offense-speed',points({hp:2,atk:16,spa:16,spe:32}),['Serious','Naive','Hasty']]);
  const all=[];
  // Round-robin nature variants so a cap does not spend the entire pool on one
  // family. No family is called likely, optimal, exhaustive or a revealed set.
  for(let n=0;n<3;n++)for(const [family,statPoints,natures]of families){
    const nature=input.publishedSet.nature??natures[n];if(!nature||input.publishedSet.nature&&n>0)continue;
    spreadCandidatePointsSchema.parse(statPoints);
    all.push({id:`spread-${all.length+1}`,family,species:input.currentForme,nature,statPoints:clone(statPoints),
      provenance:{kind:'representative-stat-hypothesis',natureSource:input.publishedSet.nature?'published-known':'explicit-representative-hypothesis',relevance:{physical,special},sourceSha256:input.source.sourceSha256,publishedSetSha256:digest(input.publishedSet)},
      knownUnknowns:['Allocation is hypothetical; this bounded profile family is not the set of all legal spreads.',...(input.publishedSet.nature?[]:['Nature is unknown; the representative nature is not an observed fact.']),'Hidden exact HP and rounded-health-compatible HP variants are not inferred.'],checks:[]});
  }
  return {all,pool:all.slice(0,input.poolLimit),families:families.map(([family])=>family)};
}
const exactPoints=value=>value&&typeof value==='object'&&!Array.isArray(value)&&STATS.every(stat=>Number.isInteger(value[stat])&&value[stat]>=0&&value[stat]<=32)&&Object.keys(value).every(stat=>STATS.includes(stat))&&Object.values(value).reduce((sum,n)=>sum+n,0)<=66;
const completeBoosts=value=>value&&['atk','def','spa','spd','spe'].every(stat=>Number.isInteger(value[stat])&&value[stat]>=-6&&value[stat]<=6);
const damageConditionalAbilities=new Set(['flashfire','electromorphosis','plus','minus','stakeout','slowstart','protean','libero']);
const unsupportedMoveHistory=new Set(['ragefist','furycutter','rollout','iceball','trumpcard','assurance','retaliate','payback','revenge','avalanche','pursuit','lashout','boltbeak','fishiousrend','ficklebeam','present','magnitude','naturalgift']);
function usableObservation(observation,input){
  const ignored=[];const v=observation.verification,args=observation.input;
  if(observation.sourceSha256!==input.source.sourceSha256)ignored.push('observation-source-mismatch');
  if(observation.currentForme!==input.currentForme)ignored.push('historical-current-forme-mismatch');
  if(args.gen!==0)ignored.push('native-gen0-required');
  if(observation.kind==='move-order'){
    for(const flag of ['identityVerified','bothExecuted','samePriority','conditionsKnown','abilityItemKnown'])if(v[flag]!==true)ignored.push(`unverified-${flag}`);
    if(v.forcedOrder!==false)ignored.push('forced-or-unknown-order');
    if(!Array.isArray(args.pokemon)||args.pokemon.length!==2||!args.field||!['weather','terrain','trickRoom','magicRoom','weatherSuppressed'].every(field=>Object.hasOwn(args.field,field))||
      !['','Sun','Rain','Sand','Snow','Harsh Sunshine','Heavy Rain','Strong Winds'].includes(args.field.weather)||!['','Electric','Grassy','Misty','Psychic'].includes(args.field.terrain)||
      !['trickRoom','magicRoom','weatherSuppressed'].every(field=>typeof args.field[field]==='boolean'))ignored.push('incomplete-speed-template');
    else for(const [index,p]of args.pokemon.entries()){
      if(!p||typeof p.label!=='string'||!p.label||typeof p.species!=='string'||typeof p.ability!=='string'||typeof p.item!=='string'||typeof p.status!=='string'||typeof p.tailwind!=='boolean'||typeof p.abilitySuppressed!=='boolean'||typeof p.itemSuppressed!=='boolean'||!completeBoosts(p.boosts))ignored.push('unknown-speed-condition');
      const ability=key(p?.ability);
      if(ability==='unburden'&&typeof p.unburdenActive!=='boolean')ignored.push('unknown-unburden-activation');
      if(ability==='slowstart'&&typeof p.slowStartActive!=='boolean')ignored.push('unknown-slow-start-activation');
      // Speed's native snapshot recomputes the boosted stat; it cannot accept
      // the exact earlier activation stat. Do not infer that history here.
      if(['protosynthesis','quarkdrive'].includes(ability))ignored.push('unsupported-speed-activation-stat-history');
      if(index===observation.candidateIndex){if(p?.species!==input.currentForme||Object.hasOwn(p,'nature')||Object.hasOwn(p,'statPoints'))ignored.push('candidate-template-overrides-spread-or-forme');}
      else if(typeof p?.nature!=='string'||!exactPoints(p?.statPoints))ignored.push('counterpart-investment-unknown');
    }
    if(Array.isArray(args.pokemon)&&args.pokemon.length===2&&args.pokemon[0]?.label===args.pokemon[1]?.label)ignored.push('ambiguous-speed-labels');
  }else{
    for(const flag of ['identityVerified','directMoveDamage','conditionsKnown','allOtherInvestmentsKnown','exactHp','uncapped'])if(v[flag]!==true)ignored.push(`unverified-${flag}`);
    for(const flag of ['roundedHp','crit','multihit','additionalHpChanges'])if(v[flag]!==false)ignored.push(`ambiguous-${flag}`);
    if(typeof args.attacker!=='string'||typeof args.defender!=='string'||typeof args.move!=='string'||!args.field||args.field.gameType!=='Doubles'||typeof args.field.weather!=='string'||typeof args.field.terrain!=='string'||args.moveOptions?.isCrit!==false||args.moveOptions?.hits!==1)ignored.push('incomplete-single-hit-damage-conditions');
    if(observation.candidateRole==='attacker'&&!input.publishedSet.moves.some(move=>key(move)===key(args.move)))ignored.push('candidate-attack-not-in-published-moves');
    if(unsupportedMoveHistory.has(key(args.move)))ignored.push('unsupported-damage-move-history');
    const hpIrrelevant=v.attackerHpIrrelevant===true&&verifySpreadAttackerHpIrrelevance(args).supported;
    if(v.attackerHpIrrelevant===true&&!hpIrrelevant)ignored.push('attacker-HP-independence-not-proven');
    for(const role of ['attacker','defender']){
      const p=args[role+'Options'];
      if(!p||typeof p.ability!=='string'||typeof p.item!=='string'||typeof p.status!=='string'||!completeBoosts(p.boosts)||!(Number.isInteger(p.curHP)&&p.curHP>0)&&!(role==='attacker'&&p.curHP===undefined&&hpIrrelevant))ignored.push('unknown-damage-condition-or-exact-hp');
      const ability=key(p?.ability);
      if(damageConditionalAbilities.has(ability)&&typeof p.abilityOn!=='boolean')ignored.push('unknown-damage-ability-activation');
      if(['protosynthesis','quarkdrive'].includes(ability)&&(typeof p.abilityOn!=='boolean'||!['atk','def','spa','spd','spe'].includes(p.boostedStat)))ignored.push('unknown-damage-activation-stat-history');
      if(ability==='download'||ability==='windrider'&&args.field?.[role+'Side']?.isTailwind===true||['intimidate','intrepidsword','dauntlessshield'].includes(ability)&&p?.abilityOn===true)ignored.push('unsupported-reapplied-entry-ability');
      if(role==='attacker'&&key(p?.item)==='metronome'&&!Number.isInteger(args.moveOptions?.timesUsedWithMetronome))ignored.push('unknown-metronome-history');
      if(role==='attacker'&&key(args.move)==='lastrespects'&&!Number.isInteger(p?.alliesFainted))ignored.push('unknown-allies-fainted-history');
      if(role===observation.candidateRole){if(args[role]!==input.currentForme||p&&('nature'in p||'evs'in p))ignored.push('candidate-template-overrides-spread-or-forme');}
      else if(typeof p?.nature!=='string'||!exactPoints(p?.evs))ignored.push('counterpart-investment-unknown');
    }
  }
  return [...new Set(ignored)];
}
function nativeArguments(observation,candidate){
  const args=clone(observation.input);
  if(observation.kind==='move-order')Object.assign(args.pokemon[observation.candidateIndex],{species:candidate.species,nature:candidate.nature,statPoints:clone(candidate.statPoints)});
  else Object.assign(args[observation.candidateRole+'Options'],{nature:candidate.nature,evs:clone(candidate.statPoints)});
  return args;
}
function parsedReply(reply){
  if(!reply||reply.isError||reply.ok===false)throw new Error('MCP refused or returned no result');
  if(reply.structuredContent)return reply.structuredContent;
  for(const entry of reply.content??[])if(entry.type==='text'){try{const result=JSON.parse(entry.text);if(result&&typeof result==='object')return result;}catch{}}
  // Direct structured results support caller-owned already-decoded MCP routes.
  if(reply.gen===0)return reply;
  throw new Error('No structured numerical MCP result');
}
function compatible(observation,args,result){
  if(result.gen!==0)throw new Error('Numerical result is not native gen0');
  if(observation.kind==='move-order'){
    if(result.format!=='gen9championsvgc2026regmc'||!Array.isArray(result.pokemon)||result.pokemon.length!==2)throw new Error('Speed result identity is unavailable');
    const rows=args.pokemon.map((p,index)=>result.pokemon.find(row=>row.index===index&&row.label===p.label&&row.species===p.species));
    if(rows.some((row,index)=>!row||!Number.isFinite(row.actionSpeed)||!Array.isArray(row.orderingWarnings)||row.orderingWarnings.length||row.nature!==args.pokemon[index].nature||digest(row.statPoints)!==digest(args.pokemon[index].statPoints)))throw new Error('Speed order has unsupported or incomplete modifiers');
    // Native actionSpeed already includes Trick Room. Equality stays possible;
    // this code never derives a Pokémon stat or assumes a tie winner.
    return rows[observation.beforeIndex].actionSpeed>=rows[1-observation.beforeIndex].actionSpeed;
  }
  if(result.contractVersion!=='champions-damage-v2'||!Array.isArray(result.damage)||!result.damage.length||!result.damage.every(n=>Number.isInteger(n)&&n>=0))throw new Error('Single-hit native damage rolls unavailable');
  return result.damage.includes(observation.amount);
}

/** The dispatcher must forward to actual calculate_speed/calculate_damage MCP.
 * Callback injection is not an actual-SDK receipt or qualification brand; the
 * production caller retains that independent proof. No internal calculator or
 * fallback formula is present. deadlineAt is the caller's original deadline. */
export async function generateSpreadCandidates(value,{call,cache,signal,deadlineAt,now=Date.now,concurrency=6,numericPolicy='allow-new-calls'}={}){
  const input=spreadCandidatesInputSchema.parse(jsonSnapshot(value));
  if(!Number.isFinite(deadlineAt)||typeof now!=='function'||!Number.isFinite(now()))throw new TypeError('An original absolute deadline and finite clock are required');
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>6)throw new RangeError('Spread concurrency must be1..6');
  if(!['allow-new-calls','cache-only'].includes(numericPolicy))throw new TypeError('Explicit spread numeric policy required');
  if(input.relevantMoves.some(move=>!input.publishedSet.moves.some(published=>key(published)===key(move.name))))throw new TypeError('Relevant moves must belong to the supplied published set');
  if(new Set(input.relevantMoves.map(move=>key(move.name))).size!==input.relevantMoves.length)throw new TypeError('Relevant move metadata must be unique');
  const generated=profiles(input),sourceHash=digest(input.source),inputHash=digest(input),ignoredConstraints=[],observations=[];
  for(const observation of input.observations){const reasons=usableObservation(observation,input);if(reasons.length)ignoredConstraints.push({id:observation.id,reasons});else observations.push(observation);}
  if(new Set(input.observations.map(o=>o.id)).size!==input.observations.length)throw new TypeError('Observation IDs must be unique');
  const runtime=typeof call?.runtimeVersion==='string'&&call.runtimeVersion?call.runtimeVersion:null;
  const memo=cache instanceof Map&&runtime?cache:new Map(),records=[],jobs=[],inflight=new Map();let attempted=0,cached=0,completed=0,maxActive=0,active=0,stopped=false;
  while(memo.size>256)memo.delete(memo.keys().next().value);
  const fetch=async(tool,args)=>{
    const recordKey=digest({contract:'spread-candidates-v1',inputHash,sourceHash,currentForme:input.currentForme,conditions:input.conditions,tool,args,runtime});
    if(inflight.has(recordKey))return inflight.get(recordKey);
    const task=(async()=>{
      const record={id:`numeric-${records.length+1}`,tool,input:clone(args),inputSha256:digest(args),sourceSha256:input.source.sourceSha256,status:'unavailable',cached:false,
        ...(tool==='calculate_damage'&&args.attackerOptions?.curHP===undefined?{hpSemantics:'Unknown actual attacker HP is omitted. Its native calculator default is irrelevant only under the validated fixed-power/ability/item template; it is not an observed HP fact.'}:{})};records.push(record);
      if(signal?.aborted||stopped||now()>=deadlineAt){record.reason=signal?.aborted?'aborted':'deadline';return record;}
      const previous=memo.get(recordKey);
      if(previous&&cacheEntries.has(previous)&&previous.key===recordKey&&previous.resultSha256===digest(previous.result)&&previous.sourceHash===sourceHash){record.result=clone(previous.result);record.resultSha256=previous.resultSha256;record.rawReplySha256=previous.rawReplySha256;record.receipt=clone(previous.receipt);record.status='complete';record.cached=true;cached++;return record;}
      // Operational admission is deliberately outside inputHash: an exact
      // branded result from an allowed earlier check remains usable here.
      // A miss never launches work or excludes an untested hypothesis.
      if(numericPolicy==='cache-only'){record.reason='model-first-new-inference-deferred';return record;}
      if(signal?.aborted||stopped||now()>=deadlineAt||typeof call!=='function'||attempted>=input.maxCalls){record.reason=signal?.aborted?'aborted':now()>=deadlineAt?'deadline':typeof call!=='function'?'actual-mcp-dispatcher-unavailable':'call-bound';return record;}
      const controller=new AbortController(),abort=()=>controller.abort();let timer;signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      attempted++;active++;maxActive=Math.max(maxActive,active);record.startedAt=now();
      try{
        const remaining=deadlineAt-now();
        const reply=await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted||now()>=deadlineAt)throw new Error('Original deadline or cancellation before dispatch');return call(tool,clone(args),{source:clone(input.source),signal:controller.signal,deadlineAt,timeoutMs:Math.max(1,Math.floor(deadlineAt-now()))});}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Original deadline exhausted'));},Math.max(1,remaining));controller.signal.addEventListener('abort',()=>reject(new Error('Cancelled research')),{once:true});})]);
        if(controller.signal.aborted||now()>=deadlineAt)throw new Error('Late or cancelled numerical result');
        const raw=jsonSnapshot(reply);record.rawReplySha256=digest(raw);record.nativeReply=raw;
        const result=jsonSnapshot(parsedReply(raw));
        if(result.calculationRef&&(result.calculationRef.tool!==tool||result.calculationRef.teamId!==input.source.teamId||!HASH.test(result.calculationRef.sha256??'')))throw new Error('MCP receipt identity mismatch');
        record.result=result;record.resultSha256=digest(result);record.receipt=result.calculationRef?clone(result.calculationRef):null;record.status='complete';completed++;
        const entry=freeze({key:recordKey,sourceHash,result:clone(result),resultSha256:record.resultSha256,rawReplySha256:record.rawReplySha256,receipt:clone(record.receipt)});cacheEntries.add(entry);memo.set(recordKey,entry);while(memo.size>256)memo.delete(memo.keys().next().value);
      }catch{record.reason=signal?.aborted?'aborted':now()>=deadlineAt?'deadline':'MCP-refused-or-unsupported-result';record.mayCompleteLate=controller.signal.aborted;}
      finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);record.finishedAt=now();active--;if(now()>=deadlineAt||signal?.aborted)stopped=true;}
      return record;
    })();inflight.set(recordKey,task);return task;
  };
  for(const candidate of generated.pool)for(const observation of observations)jobs.push(async()=>{
    const args=nativeArguments(observation,candidate),tool=observation.kind==='move-order'?'calculate_speed':'calculate_damage',record=await fetch(tool,args),assessment={observationId:observation.id,recordId:record.id,status:'unavailable'};
    if(record.status==='complete')try{assessment.compatible=compatible(observation,args,record.result);assessment.status=assessment.compatible?'compatible-including-possible-tie':'excluded-by-observation';}catch{assessment.reason='native-result-incomplete-or-unsupported';}
    else assessment.reason=record.reason;
    candidate.checks.push(assessment);
  });
  let next=0;await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},async()=>{while(next<jobs.length)await jobs[next++]();}));
  const candidates=generated.pool.filter(candidate=>!candidate.checks.some(check=>check.status==='excluded-by-observation'));
  return {schemaVersion:1,kind:'representative-spread-candidates-v1',status:!candidates.length?'contradiction-or-unavailable':observations.length&&generated.pool.every(c=>c.checks.every(check=>check.compatible!==undefined))?'filtered-representative-pool':'representative-pool-partially-or-not-filtered',
    binding:{inputSha256:inputHash,sourceSha256:input.source.sourceSha256,fullSourceSha256:sourceHash,publishedSetSha256:digest(input.publishedSet),conditionsSha256:digest(input.conditions),currentForme:input.currentForme},
    candidates,rejected:generated.pool.filter(candidate=>!candidates.includes(candidate)),records,ignoredConstraints,
    coverage:{families:generated.families,generated:generated.all.length,evaluatedPool:generated.pool.length,poolLimit:input.poolLimit,omittedByPoolBound:generated.all.length-generated.pool.length,surviving:candidates.length,plannedCalls:jobs.length,maxCalls:input.maxCalls,attemptedCalls:attempted,completedCalls:completed,cachedCalls:cached,deferredCalls:records.filter(record=>record.reason==='model-first-new-inference-deferred').length,numericPolicy,maxConcurrentCalls:maxActive,usableObservations:observations.length,ignoredObservations:ignoredConstraints.length,deadlineExhausted:now()>=deadlineAt,aborted:signal?.aborted===true,exhaustive:false},
    provenance:{numerics:'injected MCP dispatcher only; no internal stat/damage formula',actualSdkReceiptVerified:false,sourceValidation:'caller-bound supplied snapshots; no independent source fetch',runtimeVersion:runtime,crossInvocationCacheEnabled:cache instanceof Map&&runtime!==null},
    hiddenHpVariants:{supported:false,reason:'Rounded public HP and unknown exact/current/max HP are not converted into guessed values.'},
    limitations:['Every surviving spread remains a hypothesis; representative pool compatibility does not reveal an opponent allocation.','Zero survivors indicates contradiction or unavailable coverage within this bounded pool, not impossibility over all legal spreads.','No action, target, pair, branch, seed or gate was selected. No exhaustive damage, guaranteed knockout, live freshness or tactical success is established.','Ambiguous observations are ignored with reasons; missing numerical checks do not exclude a candidate.']};
}
