// All registered numeric callbacks, including nested range/history work, pass
// through this boundary. The native session owns counters, never this process.
import {AsyncLocalStorage} from 'node:async_hooks';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {callLocalSession} from '../showdown/local-bridge.mjs';
import {digest} from './identity.mjs';

export const researchContextSchema=z.strictObject({
  source:z.strictObject({sessionId:z.string().min(1).max(100),teamId:z.string().regex(/^[a-f0-9]{64}$/u),room:z.string().min(1).max(160),rqid:z.number().int().min(0),token:z.string().regex(/^[a-f0-9]{64}$/u)}),
  analysis:z.enum(['current','frozen']),freezeId:z.string().uuid().optional(),
}).refine(value=>value.analysis==='frozen'?value.freezeId!==undefined:value.freezeId===undefined,'freezeId belongs only to frozen research');
const NUMERIC=new Set(['calculate_damage','calculate_damage_range','calculate_speed']);
const SIMULATION=new Set(['simulate_turn','simulate_turn_batch']);
const BOUNDED=new Set([...NUMERIC,...SIMULATION]);
const inherited=new AsyncLocalStorage();
const failed=(reason,budget,receipt)=>({isError:true,structuredContent:{kind:receipt?'research-budget-status':'research-budget-unavailable',reason,choiceAuthority:false,...(budget?{budget}: {}),...(receipt?{status:receipt.status,...(receipt.reservationId?{reservationId:receipt.reservationId}:{}),backendAllowed:false}:{})},content:[{type:'text',text:reason}]});
const decorate=(result,receipt)=>({...result,researchBudget:{status:receipt.status,reservationId:receipt.reservationId,budget:receipt.budget,choiceAuthority:false,...(receipt.resultSha256?{resultSha256:receipt.resultSha256}:{})}});
const unwrap=reply=>{if(reply?.ok!==true||!reply.result)throw Error('Native research budget source unavailable');return reply.result;};

/** Only source assembly may supply this context. It confers no action authority. */
export function withResearchContext(context,work){return inherited.run(researchContextSchema.parse(context),work);}
export function createResearchBudgetToolClient(client,{workspace,call=callLocalSession,descriptorExists=existsSync}={}){
  const descriptor=join(workspace,'cache','showdown-session.json');
  const rpc=async(op,args,extra)=>{const {researchContext,...fields}=args;return unwrap(await call(descriptor,{id:randomUUID(),op,...fields,...(researchContext??{})},{timeoutMs:750,...(extra?.signal?{signal:extra.signal}:{})}));};
  const idle=async extra=>{
    if(!descriptorExists(descriptor))return true;
    const state=await rpc('status',{},extra);
    // A missing/unknown server status is never evidence of an idle client.
    return state.awaitingSet===false&&state.searchPending===false&&state.search&&Array.isArray(state.search.searching)&&!state.search.searching.length&&state.search.games&&Object.keys(state.search.games).length===0&&Array.isArray(state.rooms)&&state.rooms.every(room=>room.ended===true);
  };
  const wrap=(name,handler)=>async(input,extra={})=>{
    const {researchContext:supplied,...args}=input,context=supplied??inherited.getStore();
    if(extra.signal?.aborted)return failed('Research cancelled before reservation');
    // A disconnected offline SDK has no battle quota and makes no live claim.
    if(!descriptorExists(descriptor))return handler(args,extra);
    if(!context){try{if(await idle(extra))return await handler(args,extra);}catch{}return failed('Active battle numeric research requires an exact host-bound researchContext');}
    const category=NUMERIC.has(name)?'calculator':'simulation';
    if(category==='calculator'&&args.gen!==0)return failed('Active numerical research requires native gen:0');
    if(category==='simulation'&&(name==='simulate_turn_batch'||args.request?.branches?.length!==1||args.request?.seeds?.length!==1))return failed('Active battle simulation admits exactly one branch and one seed; batches are offline only');
    let binding,reservation;
    try{
      binding=researchContextSchema.parse(context);
      reservation=await rpc('research-reserve',{researchContext:binding,category,requestSha256:digest({name,args})},extra);
      if(reservation.status==='reused')return decorate(structuredClone(reservation.result),reservation);
      if(reservation.status!=='reserved')return failed(`Native per-turn research budget: ${reservation.reason??reservation.status}`,reservation.budget,reservation);
    }catch{return failed('Native research reservation/source validation failed');}
    let result,error;
    try{
      if(extra.signal?.aborted)throw Error('Research cancelled after reservation');
      result=await inherited.run(binding,()=>handler(args,extra));
    }catch(cause){error=cause;}
    // Once reserved, failed, cancelled or uncertain backend work is spent. A
    // settlement failure never retries/refunds or starts another callback.
    let settled;
    const nativeFailed=!!error||result?.isError===true||result?.ok===false||result?.structuredContent?.ok===false;
    try{settled=await rpc('research-settle',{researchContext:binding,category,requestSha256:digest({name,args}),reservationId:reservation.reservationId,failed:nativeFailed,...(!nativeFailed?{result}:{})},{});}catch{}
    if(error)throw error;
    if(!settled)return failed('Numeric work completed but its native budget/source settlement is unavailable');
    return decorate(result,{...settled,reservationId:reservation.reservationId});
  };
  return {
    runtimeVersion:client.runtimeVersion,
    registerTool(name,options,handler){
      if(!BOUNDED.has(name))return client.registerTool(name,options,handler);
      const schema=options.inputSchema.extend({researchContext:researchContextSchema.optional()});
      return client.registerTool(name,{...options,inputSchema:schema},wrap(name,handler));
    },
    tool(name,shape,handler){return BOUNDED.has(name)?client.tool(name,{...shape,researchContext:researchContextSchema.optional()},wrap(name,handler)):client.tool(name,shape,handler);},
    callTool:(...args)=>client.callTool(...args),capabilities:()=>client.capabilities(),
  };
}
