// Legal finite spread domains and native damage envelopes. This module counts
// allocations and selects full legal witnesses; it contains no stat/damage formula.
import {types} from 'node:util';
import {z} from 'zod';
import {digest} from '../planning/identity.mjs';

export const SPREAD_STATS=Object.freeze(['hp','atk','def','spa','spd','spe']);
export const SPREAD_NATURES=Object.freeze(['Hardy','Lonely','Brave','Adamant','Naughty','Bold','Docile','Relaxed','Impish','Lax','Timid','Hasty','Serious','Jolly','Naive','Modest','Mild','Quiet','Bashful','Rash','Calm','Gentle','Sassy','Careful','Quirky']);
const nature=z.enum(SPREAD_NATURES),point=z.number().int().min(0).max(32),label=z.string().min(1).max(240),integer=z.number().int();
const exactPoints=z.strictObject(Object.fromEntries(SPREAD_STATS.map(k=>[k,point]))).refine(p=>Object.values(p).reduce((a,b)=>a+b,0)<=66,'Champions permits at most 66 total stat points');
const pointRange=z.union([point,z.strictObject({min:point,max:point}).refine(r=>r.min<=r.max,'Point range is contradictory')]);
const candidateSchema=z.strictObject({id:z.string().min(1).max(80).optional(),label:label.optional(),nature,statPoints:exactPoints});
export const spreadDomainSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('ranges'),label,natures:z.array(nature).min(1).max(25),statPoints:z.strictObject(Object.fromEntries(SPREAD_STATS.map(k=>[k,pointRange]))),total:z.strictObject({min:integer.min(0).max(66),max:integer.min(0).max(66)}).refine(r=>r.min<=r.max,'Total range is contradictory').default({min:0,max:66})}),
  z.strictObject({kind:z.literal('candidates'),label,candidates:z.array(candidateSchema).min(1).max(256)}),
]);
const roleOptions=z.strictObject({ability:z.string().min(1).max(80),item:z.string().max(80),status:z.enum(['','brn','par','psn','tox','slp','frz']).default(''),boosts:z.strictObject(Object.fromEntries(['atk','def','spa','spd','spe'].map(k=>[k,integer.min(-6).max(6).optional()]))).default({}),abilityOn:z.boolean().optional(),boostedStat:z.enum(['atk','def','spa','spd','spe','auto']).optional(),alliesFainted:integer.min(0).max(5).optional()});
const hpSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('full')}),
  z.strictObject({kind:z.literal('values'),values:z.array(integer.min(1).max(10000)).min(1).max(64)}),
  z.strictObject({kind:z.literal('range'),min:integer.min(1).max(10000),max:integer.min(1).max(10000)}).refine(r=>r.min<=r.max,'HP range is contradictory'),
]);
const sideSchema=z.strictObject(Object.fromEntries(['isReflect','isLightScreen','isAuroraVeil','isHelpingHand','isFlowerGift','isFriendGuard','isBattery','isPowerSpot','isSteelySpirit','isCharge','isTailwind','isProtected','isSeeded','isForesight'].map(k=>[k,z.boolean().optional()]))).extend({isSwitching:z.enum(['out','in']).optional()});
const fieldSchema=z.strictObject({gameType:z.enum(['Singles','Doubles']).default('Doubles'),weather:z.string().max(80).default(''),terrain:z.string().max(80).default(''),...Object.fromEntries(['isGravity','isMagicRoom','isWonderRoom','isAuraBreak','isFairyAura','isDarkAura','isBeadsOfRuin','isSwordOfRuin','isTabletsOfRuin','isVesselOfRuin'].map(k=>[k,z.boolean().optional()])),attackerSide:sideSchema.optional(),defenderSide:sideSchema.optional()});
export const damageRangeToolSchema=z.strictObject({gen:z.literal(0).default(0),attacker:z.string().min(1).max(80),defender:z.string().min(1).max(80),move:z.string().min(1).max(80),attackerOptions:roleOptions,defenderOptions:roleOptions,attackerDomain:spreadDomainSchema,defenderDomain:spreadDomainSchema,
  attackerHP:hpSchema.default({kind:'full'}),defenderHP:hpSchema.default({kind:'full'}),
  moveOptions:z.strictObject({isCrit:z.boolean().optional(),hits:integer.min(1).max(10).optional(),timesUsed:integer.min(1).max(10).optional(),timesUsedWithMetronome:integer.min(1).max(10).optional()}).default({}),field:fieldSchema.default({gameType:'Doubles',weather:'',terrain:''}),
  work:z.strictObject({maxCalculations:integer.min(1).max(2048).default(2048),concurrency:integer.min(1).max(6).default(4),requireExhaustive:z.boolean().default(false)}).default({maxCalculations:2048,concurrency:4,requireExhaustive:false}),
  evidenceContext:z.strictObject({teamId:z.string().regex(/^[a-f0-9]{64}$/u),roomId:z.string().regex(/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/u),turn:integer.min(0).max(10000).optional()}).optional(),
});
const clone=structuredClone,check=(ok,message)=>{if(!ok)throw Error(`Spread range: ${message}`);};
function json(value){
  const seen=new Set();let nodes=0,bytes=0;
  function visit(v,depth){
    check(depth<=48&&++nodes<=50000,'input traversal limit');
    if(v===null||typeof v==='boolean'||typeof v==='string'||typeof v==='number'&&Number.isFinite(v)){bytes+=Buffer.byteLength(JSON.stringify(v));check(bytes<=512*1024,'input exceeds 512 KiB');return v;}
    check(v&&typeof v==='object'&&!types.isProxy(v),'ordinary finite JSON required');const array=Array.isArray(v),proto=Object.getPrototypeOf(v);check(array||proto===Object.prototype||proto===null,'plain JSON required');check(!seen.has(v),'cyclic input');seen.add(v);
    const keys=Reflect.ownKeys(v).filter(k=>!(array&&k==='length'));check(!array||keys.length===v.length,'dense array required');const out=array?[]:{};
    for(const [i,k]of keys.entries()){check(typeof k==='string'&&(!array||k===String(i)),'ordinary keys required');const d=Object.getOwnPropertyDescriptor(v,k);check(d.enumerable&&Object.hasOwn(d,'value'),'data-only input required');if(!array&&d.value===undefined)continue;bytes+=Buffer.byteLength(k)+4;check(bytes<=512*1024,'input exceeds 512 KiB');Object.defineProperty(out,k,{value:visit(d.value,depth+1),enumerable:true,writable:true,configurable:true});}
    seen.delete(v);return out;
  }return visit(value,0);
}
const unique=(values,message)=>check(new Set(values).size===values.length,message);
function prepareDomain(value,publishedNature){
  const declared=spreadDomainSchema.parse(json(value));
  if(publishedNature!==undefined)check(SPREAD_NATURES.includes(publishedNature),'unknown published nature');
  if(declared.kind==='candidates'){
    unique(declared.candidates.map(c=>digest([c.nature,c.statPoints])),'duplicate explicit spread');
    const ids=declared.candidates.filter(c=>c.id).map(c=>c.id);unique(ids,'duplicate explicit candidate ID');
    const effective=declared.candidates.filter(c=>publishedNature===undefined||c.nature===publishedNature);check(effective.length>0,'published nature contradicts every candidate');
    return {declared,count:BigInt(effective.length),declaredCount:BigInt(declared.candidates.length),excludedNatures:[...new Set(declared.candidates.filter(c=>!effective.includes(c)).map(c=>c.nature))],at:rank=>clone(effective[Number(rank)])};
  }
  unique(declared.natures,'duplicate nature in range');
  const natures=declared.natures.filter(n=>publishedNature===undefined||n===publishedNature);check(natures.length>0,'published nature contradicts the nature domain');
  const bounds=Object.fromEntries(SPREAD_STATS.map(s=>[s,typeof declared.statPoints[s]==='number'?{min:declared.statPoints[s],max:declared.statPoints[s]}:declared.statPoints[s]]));
  const counter=order=>{
    const memo=new Map();
    function count(index,sum){
      if(sum>declared.total.max)return 0n;if(index===order.length)return sum>=declared.total.min?1n:0n;
      const k=index+':'+sum;if(memo.has(k))return memo.get(k);let total=0n;const r=bounds[order[index]];for(let p=r.min;p<=r.max;p++)total+=count(index+1,sum+p);memo.set(k,total);return total;
    }return count;
  };
  const count=counter(SPREAD_STATS),pointCount=count(0,0);check(pointCount>0n,'point ranges contain no allocation within the legal total');
  const at=rank=>{
    check(rank>=0n&&rank<pointCount*BigInt(natures.length),'candidate rank outside domain');const chosenNature=natures[Number(rank/pointCount)];let rest=rank%pointCount,sum=0;const points={};
    for(const [i,stat]of SPREAD_STATS.entries())for(let p=bounds[stat].min;p<=bounds[stat].max;p++){const ways=count(i+1,sum+p);if(rest<ways){points[stat]=p;sum+=p;break;}rest-=ways;}
    return {nature:chosenNature,statPoints:points};
  };
  const rankOf=(chosenNature,points)=>{let rank=BigInt(natures.indexOf(chosenNature))*pointCount,sum=0;for(const [i,s]of SPREAD_STATS.entries()){for(let p=bounds[s].min;p<points[s];p++)rank+=count(i+1,sum+p);sum+=points[s];}return rank;};
  const corner=(order,direction,chosenNature)=>{
    const countOther=counter(order),points={};let sum=0;
    for(const [i,s]of order.entries()){const r=bounds[s],values=Array.from({length:r.max-r.min+1},(_,j)=>r.min+j);if(direction==='high')values.reverse();const chosen=values.find(p=>countOther(i+1,sum+p)>0n);check(chosen!==undefined,'feasible endpoint unavailable');points[s]=chosen;sum+=chosen;}
    return rankOf(chosenNature,points);
  };
  return {declared,count:pointCount*BigInt(natures.length),declaredCount:pointCount*BigInt(declared.natures.length),excludedNatures:declared.natures.filter(n=>!natures.includes(n)),at,corner,natures};
}
function representativeRanks(domain,limit,priorityStats){
  if(domain.count<=BigInt(limit))return Array.from({length:Number(domain.count)},(_,i)=>BigInt(i));
  const ranks=[],seen=new Set(),add=rank=>{if(ranks.length<limit&&!seen.has(String(rank))){seen.add(String(rank));ranks.push(rank);}};
  if(domain.corner){
    const priorities=priorityStats??['atk','spa','spe','hp','def','spd'];check(priorities.length===6&&new Set(priorities).size===6&&priorities.every(s=>SPREAD_STATS.includes(s)),'priorityStats must order all six stats');
    for(const [i,order]of [priorities,['hp','def','spd','atk','spa','spe'],['hp','spd','def','spa','atk','spe']].entries())add(domain.corner(order,'high',domain.natures[i%domain.natures.length]));
    for(const n of domain.natures){add(domain.corner(SPREAD_STATS,'low',n));for(const s of SPREAD_STATS){const order=[s,...SPREAD_STATS.filter(k=>k!==s)];add(domain.corner(order,'high',n));add(domain.corner(order,'low',n));}}
  }
  add(0n);add(domain.count-1n);for(let i=1;i<=limit*2&&ranks.length<limit;i++)add((domain.count-1n)*BigInt(i)/BigInt(limit*2));
  return ranks;
}
/** Shared data-only helper for compact spread worlds. Each returned point vector
 * is legal as a whole. Its endpoints are witnesses, never inferred extrema. */
export function enumerateSpreadDomain(value,{publishedNature,maxCandidates=16,priorityStats}={}){
  check(Number.isInteger(maxCandidates)&&maxCandidates>=1&&maxCandidates<=256,'maxCandidates must be 1..256');
  const domain=prepareDomain(value,publishedNature),ranks=representativeRanks(domain,maxCandidates,priorityStats);
  return {kind:'legal-spread-domain-witnesses-v1',label:domain.declared.label,candidates:ranks.map((rank,i)=>{const c=domain.at(rank);return {...c,id:c.id??`range-${i+1}`,label:c.label??`${domain.declared.label}; legal representative witness ${i+1}`,rank:String(rank)};}),
    coverage:{legalCount:String(domain.count),declaredLegalCount:String(domain.declaredCount),returned:ranks.length,exhaustive:BigInt(ranks.length)===domain.count,excludedNatures:domain.excludedNatures,publishedNature:publishedNature??null,selection:'feasible whole-allocation endpoints and bounded ranks; not marginal stat combinations'},domainSha256:digest(domain.declared)};
}
function hpDomain(hp){if(hp.kind==='full')return {count:1n,at:()=>null};if(hp.kind==='values'){unique(hp.values,'duplicate current HP value');return {count:BigInt(hp.values.length),at:i=>hp.values[Number(i)]};}return {count:BigInt(hp.max-hp.min+1),at:i=>hp.min+Number(i)};}
function safeReason(value){return String(value??'Native calculation unavailable').slice(0,4096).replace(/https?:\/\/[^\s<>"']+/giu,'[redacted-url]').replace(/\b[A-Za-z]:\\[^\s<>"']+/gu,'[redacted-path]').replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/gu,'[redacted-secret]').replace(/\b(?:password|authorization|credential|token|sessionId)\s*[:=]\s*[^\s,;]+/giu,'[redacted-secret]').replace(/[\x00-\x1f\x7f]+/gu,' ').slice(0,240);}
function decode(reply){
  if(!reply||reply.isError||reply.ok===false||reply.structuredContent?.ok===false){let reason=reply?.structuredContent?.reason??reply?.structuredContent?.error??reply?.error;for(const b of (reply?.content??[]).slice(0,4))if(!reason&&b.type==='text'&&typeof b.text==='string')reason=b.text;throw Error('Spread range: '+safeReason(reason??'registered calculate_damage refused a candidate'));}
  if(reply.structuredContent)return reply.structuredContent;if(reply.gen===0)return reply;for(const b of reply.content??[])if(b.type==='text')try{return JSON.parse(b.text);}catch{}throw Error('Spread range: native structured damage result unavailable');
}
function validateNative(value){check(value?.gen===0&&value.contractVersion==='champions-damage-v2'&&Array.isArray(value.range)&&value.range.length===2&&value.range.every(n=>Number.isInteger(n)&&n>=0)&&value.range[0]<=value.range[1],'native damage-v2 range unavailable');for(const role of ['attackerHP','defenderHP'])check(value[role]?.unit==='actual-hp'&&Number.isInteger(value[role].current)&&Number.isInteger(value[role].max)&&value[role].current>0&&value[role].current<=value[role].max,'native HP dependency metadata unavailable');}
/** Execute only the actual registered calculator. No direct import/fallback. */
export async function executeDamageRange(args,{callTool,signal,deadlineAt,now=Date.now,recordEvidence}={}){
  const input=damageRangeToolSchema.parse(json(args));check(typeof callTool==='function','actual registered damage dispatcher required');const deadline=Math.min(now()+3500,Number.isFinite(deadlineAt)?deadlineAt:Infinity);check(now()<deadline&&!signal?.aborted,'original deadline/cancellation before range');
  const a=prepareDomain(input.attackerDomain),d=prepareDomain(input.defenderDomain),ah=hpDomain(input.attackerHP),dh=hpDomain(input.defenderHP),total=a.count*d.count*ah.count*dh.count,budget=input.work.maxCalculations;
  check(!input.work.requireExhaustive||total<=BigInt(budget),'complete finite domain exceeds the declared calculation bound');
  const ar=representativeRanks(a,Math.min(256,budget)),dr=representativeRanks(d,Math.min(256,budget)),planned=[],seen=new Set();
  const add=(ai,di,ahi,dhi)=>{if(planned.length>=budget)return;const rank=((ai*d.count+di)*ah.count+ahi)*dh.count+dhi;if(seen.has(String(rank)))return;seen.add(String(rank));planned.push({rank,ai,di,ahi,dhi});};
  if(total<=BigInt(budget))for(let ai=0n;ai<a.count;ai++)for(let di=0n;di<d.count;di++)for(let ahi=0n;ahi<ah.count;ahi++)for(let dhi=0n;dhi<dh.count;dhi++)add(ai,di,ahi,dhi);
  else{
    // Cross feasible full-vector endpoints. A partial plan is expressly a set
    // of samples; no monotonicity or irrelevant-stat reduction is assumed.
    const hpPairs=[[0n,0n],[ah.count-1n,dh.count-1n],[0n,dh.count-1n],[ah.count-1n,0n]];
    for(let diagonal=0;planned.length<budget&&diagonal<ar.length+dr.length;diagonal++)for(let i=0;i<ar.length&&planned.length<budget;i++){const j=diagonal-i;if(j>=0&&j<dr.length)for(const [ahi,dhi]of hpPairs)add(ar[i],dr[j],ahi,dhi);}
    for(let i=0;planned.length<budget&&i<budget*2;i++){let rank=(total-1n)*BigInt(i)/BigInt(budget*2);const dhi=rank%dh.count;rank/=dh.count;const ahi=rank%ah.count;rank/=ah.count;const di=rank%d.count,ai=rank/d.count;add(ai,di,ahi,dhi);}
  }
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();let timer=setTimeout(abort,Math.max(1,deadline-now()));const records=[],nativeRecords=[];let next=0;
  try{
    await Promise.all(Array.from({length:Math.min(input.work.concurrency,planned.length)},async()=>{while(next<planned.length&&!controller.signal.aborted&&now()<deadline){const world=planned[next++],attacker=a.at(world.ai),defender=d.at(world.di),attackerHP=ah.at(world.ahi),defenderHP=dh.at(world.dhi);
      const witness={attacker:{candidateId:attacker.id??`rank-${world.ai}`,label:attacker.label??input.attackerDomain.label,nature:attacker.nature,statPoints:clone(attacker.statPoints),hp:attackerHP??'full'},defender:{candidateId:defender.id??`rank-${world.di}`,label:defender.label??input.defenderDomain.label,nature:defender.nature,statPoints:clone(defender.statPoints),hp:defenderHP??'full'}},arguments_={gen:0,attacker:input.attacker,defender:input.defender,move:input.move,attackerOptions:{...clone(input.attackerOptions),nature:attacker.nature,evs:clone(attacker.statPoints),...(attackerHP===null?{}:{curHP:attackerHP})},defenderOptions:{...clone(input.defenderOptions),nature:defender.nature,evs:clone(defender.statPoints),...(defenderHP===null?{}:{curHP:defenderHP})},moveOptions:clone(input.moveOptions),field:clone(input.field)};
      const record={id:`assignment-${world.rank}`,rank:String(world.rank),witness,inputSha256:digest(arguments_),status:'unavailable',dispatched:false,startedAt:now()};records.push(record);let cancel;
      try{
        const reply=await Promise.race([Promise.resolve().then(()=>{check(!controller.signal.aborted&&now()<deadline,'original deadline/cancellation before native dispatch');record.dispatched=true;return callTool('calculate_damage',clone(arguments_),{signal:controller.signal,deadlineAt:deadline,timeoutMs:Math.max(1,deadline-now())});}),new Promise((_,reject)=>{cancel=()=>reject(Error('original range deadline or cancellation'));controller.signal.addEventListener('abort',cancel,{once:true});})]);
        check(!controller.signal.aborted&&now()<deadline,'late native damage result');nativeRecords.push({id:record.id,input:arguments_,result:clone(reply)});const value=decode(reply);validateNative(value);
        check((attackerHP===null?value.attackerHP.current===value.attackerHP.max:value.attackerHP.current===attackerHP)&&(defenderHP===null?value.defenderHP.current===value.defenderHP.max:value.defenderHP.current===defenderHP),'native HP does not match this whole-allocation witness');
        Object.assign(record,{status:'complete',range:clone(value.range),attackerHP:clone(value.attackerHP),defenderHP:clone(value.defenderHP),resultSha256:digest(reply),...(value.calculationRef?{calculationRef:clone(value.calculationRef)}:{})});
      }catch(error){record.reason=safeReason(error.message??error);}finally{record.finishedAt=now();controller.signal.removeEventListener('abort',cancel);}
    }}));
    records.sort((x,y)=>BigInt(x.rank)<BigInt(y.rank)?-1:1);const completed=records.filter(r=>r.status==='complete'),exhaustive=BigInt(completed.length)===total;
    const min=completed.reduce((best,r)=>!best||r.range[0]<best.range[0]?r:best,null),max=completed.reduce((best,r)=>!best||r.range[1]>best.range[1]?r:best,null),publicRecords=[],publicIds=new Set();
    const expose=record=>{if(record&&publicRecords.length<16&&!publicIds.has(record.id)){publicIds.add(record.id);publicRecords.push(record);}};
    expose(min);expose(max);expose(records.find(r=>r.status!=='complete'));
    if(records.length<=16)for(const record of records)expose(record);
    else for(let i=0;i<32&&publicRecords.length<16;i++)expose(records[Math.floor((records.length-1)*i/31)]);
    publicRecords.sort((x,y)=>BigInt(x.rank)<BigInt(y.rank)?-1:1);const evaluationSha256=digest(records);
    const result={kind:'champions-damage-range-v1',status:!completed.length?'unavailable':exhaustive?'complete-finite-domain':'partial-candidate-envelope',gen:0,domainLabels:{attacker:input.attackerDomain.label,defender:input.defenderDomain.label},
      damageRange:min?{min:min.range[0],max:max.range[1],unit:'actual-hp',scope:exhaustive?'all-declared-finite-assignments':'evaluated-legal-witnesses-only',minimumWitness:clone(min),maximumWitness:clone(max)}:null,
      coverage:{attackerLegalSpreads:String(a.count),defenderLegalSpreads:String(d.count),declaredAssignments:String(total),planned:planned.length,attempted:records.length,dispatched:records.filter(r=>r.dispatched).length,completed:completed.length,unavailable:records.length-completed.length,unevaluated:String(total-BigInt(records.length)),exhaustive,conservativeForDeclaredDomain:exhaustive,originalDeadlineExhausted:now()>=deadline,cancelled:signal?.aborted===true,selection:'full finite enumeration when bounded, otherwise feasible endpoint witnesses; no monotonic assumption',evaluationSha256,publicRecords:publicRecords.length,omittedPublicRecords:records.length-publicRecords.length},records:publicRecords,
      provenance:{numerics:'actual registered calculate_damage gen0 callback only; no independent stat/damage formula',sdkQualificationClaimed:false},
      limitations:['Every witness retains a complete jointly legal point allocation and nature; no extrema are assembled from incompatible marginal stats. Legality here concerns the stat-point domain; a damage snapshot does not validate an entire team or movepool.','Partial envelopes are sampled ranges and are not lower/upper bounds over unevaluated spreads. No probability or guaranteed knockout is inferred.','HP inputs are explicit full-health or actual-HP hypotheses. HP-dependent moves/items/abilities use each candidate’s native maximum and current HP together; incompatible HP or unsupported native states remain unavailable.','Known ability/item/boost/status/field and conditional activation inputs are fixed as supplied. This tool does not infer missing battle history, investments, weather duration or a target’s exact hidden HP.']};
    if(input.evidenceContext&&completed.length){
      check(typeof recordEvidence==='function','team-owned range evidence writer unavailable');let cancel;
      try{result.calculationRef=await Promise.race([Promise.resolve().then(()=>{check(!controller.signal.aborted&&now()<deadline,'original deadline/cancellation before evidence write');return recordEvidence({tool:'calculate_damage_range',input:{request:input,evaluations:records,nativeCalculations:nativeRecords},result:clone(result),context:input.evidenceContext});}),new Promise((_,reject)=>{cancel=()=>reject(Error('Spread range: original deadline/cancellation during evidence write'));controller.signal.addEventListener('abort',cancel,{once:true});if(controller.signal.aborted)cancel();})]);check(!controller.signal.aborted&&now()<deadline,'late range evidence result');}
      finally{controller.signal.removeEventListener('abort',cancel);}
    }
    return result;
  }finally{clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort);}
}
export function registerDamageRangeTools(server,options={}){
  server.registerTool('calculate_damage_range',{description:'Calculate native Champions damage ranges over labeled finite nature/stat-point domains. In an active battle, the outer range request and every nested calculate_damage invocation share the combined three-calculator limit for that turn; select work bounds within the remaining allowance. Offline analysis supports up to 2048 native evaluations within the original 3.5-second budget. Full enumeration only when completed, otherwise explicitly partial endpoint witnesses. Public records are capped at16 including extrema; team-owned evidence retains every evaluation and native reply. Current/max HP dependencies stay coupled to each full allocation. Calls only registered calculate_damage gen0; no stat or damage fallback. No battle control or knockout guarantee.',inputSchema:damageRangeToolSchema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true}},async(args,extra)=>{try{const result=await executeDamageRange(args,{...options,signal:extra?.signal??options.signal});return {...(result.status==='unavailable'?{isError:true}:{}),structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};}catch(error){return {isError:true,content:[{type:'text',text:String(error.message??error).slice(0,500)}]};}});
}
