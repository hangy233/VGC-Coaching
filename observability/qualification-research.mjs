// Private saved-position MCP subprocess authority. It never opens a live session
// descriptor, grants a battle action, or makes a current-source freshness claim.
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {digest} from '../planning/identity.mjs';
import {researchContextSchema} from '../planning/research-budget.mjs';

export const QUALIFICATION_RESEARCH_ENV='VGC_SAVED_QUALIFICATION_ONLY';
export const QUALIFICATION_SETUP_TOOL='qualification_register_saved_research';
const HASH=z.string().regex(/^[a-f0-9]{64}$/u);
export const qualificationResearchCaseSchema=z.strictObject({
  caseId:z.string().uuid(),contexts:z.array(researchContextSchema).min(1).max(2),turn:z.number().int().min(0),
  kind:z.enum(['preview','turn','switch']),sourceSha256:HASH,factsSha256:HASH,
  deadlineAt:z.number().int().positive(),
});
const need=(ok,message)=>{if(!ok)throw Error(message);};
const scopeKey=context=>digest(context);
const LIMITS=Object.freeze({calculator:3,simulation:1});
const MAX_CASES=16,MAX_RESULT_BYTES=8*1024*1024;

export function registerQualificationResearchSetup(server,authority){
  server.registerTool(QUALIFICATION_SETUP_TOOL,{description:'Private host-only registration of verified historical qualification source; never a battle-model tool.',inputSchema:qualificationResearchCaseSchema,
    annotations:{readOnlyHint:true,destructiveHint:false}},async input=>{
    try{const result=authority.register(input);return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};}
    catch{return {isError:true,content:[{type:'text',text:'Saved qualification case registration refused'}]};}
  });
}

/** The connector supplies only already-verified saved case bindings. This local
 * ledger exercises the same callback cap, not native live-session ownership. */
export function createQualificationResearchAuthority({now=Date.now}={}){
  const cases=new Map(),bindings=new Map(),reservations=new Map();
  const provenance={quotaScope:'offline-saved-source-case',liveQuotaExercised:false,liveDescriptorAccessed:false,choiceAuthority:false,liveFreshness:false};
  const budget=row=>({calculatorsUsed:row.calculators.length,calculatorsRemaining:3-row.calculators.length,simulationsUsed:row.simulation?1:0,simulationsRemaining:row.simulation?0:1,limits:{...LIMITS}});
  const view=(row,status,fields={})=>({kind:'offline-qualification-research-budget-v1',status,budget:budget(row),...provenance,...fields});
  const current=command=>{
    const context=researchContextSchema.parse({source:command.source,analysis:command.analysis,...(command.freezeId===undefined?{}:{freezeId:command.freezeId})});
    const row=cases.get(bindings.get(scopeKey(context)));
    need(row&&row.spec.contexts.some(value=>digest(value)===digest(context)),'Unregistered saved research source');
    return {row,context};
  };
  const register=input=>{
    const spec=qualificationResearchCaseSchema.parse(input),at=now();
    need(spec.deadlineAt>at&&spec.deadlineAt-at<=40000,'Original saved-case deadline is unavailable');
    need(spec.contexts.every(value=>digest(value.source)===digest(spec.contexts[0].source))&&new Set(spec.contexts.map(scopeKey)).size===spec.contexts.length,'One exact saved source and distinct modes required');
    const existing=cases.get(spec.caseId);
    if(existing){need(digest(existing.spec)===digest(spec),'Saved case cannot change or refresh its deadline');return view(existing,'registered',{caseId:spec.caseId,sourceSha256:spec.sourceSha256,factsSha256:spec.factsSha256,turn:spec.turn,kind:spec.kind});}
    need(cases.size<MAX_CASES,'Saved qualification case bound exceeded');
    for(const context of spec.contexts){const prior=cases.get(bindings.get(scopeKey(context)));
      need(!prior||!prior.calculators.some(r=>r.status==='pending')&&prior.simulation?.status!=='pending','Prior saved-case native work is unsettled');}
    const row={spec:structuredClone(spec),calculators:[],simulation:null};
    cases.set(spec.caseId,row);for(const context of spec.contexts)bindings.set(scopeKey(context),spec.caseId);
    return view(row,'registered',{caseId:spec.caseId,sourceSha256:spec.sourceSha256,factsSha256:spec.factsSha256,turn:spec.turn,kind:spec.kind});
  };
  const call=async(_descriptor,command,extra={})=>{
    try{
      if(command.op==='status')throw Error('Qualification callbacks require an explicitly registered saved source');
      need(['research-reserve','research-settle','research-status'].includes(command.op),'Offline authority accepts no battle operations');
      const {row,context}=current(command),spec=row.spec;
      if(command.op==='research-status')return {ok:true,result:view(row,'status')};
      need(['calculator','simulation'].includes(command.category)&&HASH.safeParse(command.requestSha256).success,'Exact research category and input hash required');
      const binding=digest({context,category:command.category,requestSha256:command.requestSha256});
      if(command.op==='research-reserve'){
        need(!extra.signal?.aborted&&now()<spec.deadlineAt,'Original saved-case research deadline elapsed or cancelled');
        need(command.category!=='simulation'||spec.kind==='turn','Saved simulation requires a normal turn');
        const prior=command.category==='simulation'?row.simulation:row.calculators.find(r=>r.binding===binding&&['pending','completed'].includes(r.status));
        if(prior){
          if(prior.binding===binding&&prior.status==='pending')return {ok:true,result:view(row,'pending',{reservationId:prior.id,backendAllowed:false})};
          if(prior.binding===binding&&prior.status==='completed')return {ok:true,result:view(row,'reused',{reservationId:prior.id,backendAllowed:false,result:structuredClone(prior.result),resultSha256:prior.resultSha256})};
          return {ok:true,result:view(row,'budget-used',{backendAllowed:false,reason:'simulation-trajectory-used'})};
        }
        if(command.category==='calculator'&&row.calculators.length>=3)return {ok:true,result:view(row,'budget-used',{backendAllowed:false,reason:'calculator-invocations-used'})};
        const reservation={id:randomUUID(),caseId:spec.caseId,binding,status:'pending',cancelled:false};
        if(extra.signal){const abort=()=>{reservation.cancelled=true;};extra.signal.addEventListener('abort',abort,{once:true});reservation.detach=()=>extra.signal.removeEventListener('abort',abort);}
        reservations.set(reservation.id,reservation);
        if(command.category==='simulation')row.simulation=reservation;else row.calculators.push(reservation);
        return {ok:true,result:view(row,'reserved',{reservationId:reservation.id,backendAllowed:true})};
      }
      // Settlement is allowed after the deadline solely to retire already spent
      // work. Late or cancelled success cannot become a reusable result.
      const reservation=reservations.get(command.reservationId);
      need(reservation?.caseId===spec.caseId&&reservation.binding===binding,'Saved research settlement binding differs');
      need(typeof command.failed==='boolean'&&(command.failed?command.result===undefined:command.result!==undefined),'Explicit complete research outcome required');
      const late=now()>=spec.deadlineAt,failed=command.failed||late||reservation.cancelled;
      if(reservation.status!=='pending'){
        need(reservation.status===(failed?'failed':'completed')&&(failed||reservation.resultSha256===digest(command.result)),'Saved reservation already settled differently');
        return {ok:true,result:view(row,reservation.status,{reservationId:reservation.id,alreadySettled:true,spent:true})};
      }
      const text=failed?null:JSON.stringify(command.result);
      need(failed||typeof text==='string','Complete serializable result required');
      if(failed||Buffer.byteLength(text)>MAX_RESULT_BYTES){reservation.detach?.();reservation.status='failed';return {ok:true,result:view(row,'failed',{reservationId:reservation.id,spent:true,...(late?{reason:'original-deadline-elapsed'}:{})})};}
      need(command.result?.isError!==true&&command.result?.ok!==false&&command.result?.structuredContent?.ok!==false,'Error results require failed settlement');
      reservation.detach?.();reservation.status='completed';reservation.result=JSON.parse(text);reservation.resultSha256=digest(reservation.result);
      return {ok:true,result:view(row,'completed',{reservationId:reservation.id,spent:true,resultSha256:reservation.resultSha256})};
    }catch(error){return {ok:false,error:error.message};}
  };
  return Object.freeze({register,call,descriptorExists:()=>true,status:()=>({...provenance,cases:cases.size,reservations:reservations.size})});
}
