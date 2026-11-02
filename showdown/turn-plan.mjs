import {createHash} from 'node:crypto';
import {z} from 'zod';

export const TURN_PLAN_MAX_BYTES=2048;
const safeText=max=>z.string().trim().min(1).max(max).refine(value=>!/[\u0000-\u001f\u007f]|https?:\/\/|\b[a-f0-9]{64}\b/iu.test(value),'Plan text must omit control characters, URLs and opaque tokens');
const action=z.discriminatedUnion('type',[
  z.object({type:z.literal('move'),slot:z.number().int().min(1).max(4),target:z.union([z.literal(-2),z.literal(-1),z.literal(1),z.literal(2)]).optional(),mega:z.boolean().optional()}).strict(),
  z.object({type:z.literal('switch'),slot:z.number().int().min(1).max(6).optional(),pokemonId:safeText(80).optional()}).strict().refine(value=>(value.slot!==undefined)!==(value.pokemonId!==undefined),'Choose exactly one switch slot or stable pokemonId'),
  z.object({type:z.literal('pass')}).strict(),
  z.object({type:z.literal('team'),order:z.array(z.number().int().min(1).max(6)).min(1).max(6)}).strict(),
]);
const pair=z.array(action).min(1).max(2).refine(value=>value[0]?.type==='team'?value.length===1:value.length===2&&value.every(item=>item.type!=='team'),'Supply the complete paired choice');
const sourceHash=z.string().regex(/^[a-f0-9]{64}$/u);
const recipientBindingFields={actorId:safeText(200),moveSlot:z.number().int().min(1).max(4),targetSlot:z.number().int().min(1).max(2),currentTargetId:safeText(200),
  source:z.strictObject({boardHash:sourceHash,requestDigest:sourceHash,opposingSheetSha256:sourceHash})};
export const recipientReadsSchema=z.array(z.strictObject({...recipientBindingFields,
  expected:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('switch'),recipientId:safeText(200)}),z.strictObject({kind:z.literal('form'),species:safeText(100)}),z.strictObject({kind:z.literal('redirection'),recipientId:safeText(200),move:z.enum(['Follow Me','Rage Powder'])})]),
  acknowledgeCurrentImmunity:z.literal(true)})).max(2);
export const ineffectiveActionsSchema=z.array(z.strictObject({...recipientBindingFields,
  source:z.strictObject({boardHash:sourceHash,requestDigest:sourceHash,opposingSheetSha256:sourceHash.optional()}),
  acknowledgeNoCurrentEffect:z.literal(true),independentActorId:safeText(200),purpose:safeText(120)})).max(2);

/** Agent intent only. Request bindings and observed outcomes are server-owned. */
const turnPlanFields={
  objective:safeText(180),priorityThreat:safeText(120).optional(),preserveIds:z.array(safeText(80)).max(6).optional(),
  chosenPair:pair,fallback:pair.optional(),opposingPair:z.array(safeText(120)).max(2).optional(),opposingAlternative:z.array(safeText(120)).max(2).optional(),
  risk:safeText(180).optional(),unverified:z.array(safeText(100)).max(4).optional(),evidenceRefs:z.array(z.string().uuid()).max(10).optional(),nextTurnCondition:safeText(180).optional(),recipientReads:recipientReadsSchema.optional(),ineffectiveActions:ineffectiveActionsSchema.optional(),
};
const checkPlanBytes=(value,context)=>{if(Buffer.byteLength(JSON.stringify(value),'utf8')>TURN_PLAN_MAX_BYTES)context.addIssue({code:'custom',message:'Turn plan exceeds 2048 UTF-8 bytes'});};
// Stored/projected intent always contains the complete pair. The authored input
// may omit it only when the operation supplies its explicit control actions.
export const turnPlanSchema=z.object(turnPlanFields).strict().superRefine(checkPlanBytes);
export const turnPlanInputSchema=z.object({...turnPlanFields,chosenPair:pair.optional()}).strict().superRefine((value,context)=>{
  checkPlanBytes(value,context);
  if(Object.hasOwn(value,'chosenPair')&&value.chosenPair===undefined)context.addIssue({code:'custom',message:'chosenPair must be omitted or contain the complete pair'});
});
const clone=value=>structuredClone(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(first,second)=>JSON.stringify(first)===JSON.stringify(second);

export function validateTurnPlan(value,{actions}={}){
  const authoredPair=actions===undefined?undefined:pair.parse(actions);
  const omitted=value!==null&&typeof value==='object'&&!Array.isArray(value)&&!Object.hasOwn(value,'chosenPair');
  const plan=turnPlanSchema.parse(omitted&&authoredPair!==undefined?{...value,chosenPair:authoredPair}:value);
  if(authoredPair!==undefined&&!same(plan.chosenPair,authoredPair))throw new Error('Turn plan chosenPair differs from the authored control actions');
  return plan;
}

// Preview intent has its own field and stored order. It cannot masquerade as
// a battle-turn plan or obtain an order from carried state or a later choice.
const previewOrder=z.array(z.number().int().min(1).max(6)).length(4).refine(value=>new Set(value).size===4,'Preview requires four unique registered slots');
const previewActions=z.array(z.strictObject({type:z.literal('team'),order:previewOrder})).length(1);
const previewFields={objective:turnPlanFields.objective,risk:turnPlanFields.risk,preserveIds:turnPlanFields.preserveIds,
  nextTurnCondition:turnPlanFields.nextTurnCondition,unverified:turnPlanFields.unverified,chosenTeamOrder:previewOrder};
const checkPreviewBytes=(value,context)=>{if(Buffer.byteLength(JSON.stringify(value),'utf8')>TURN_PLAN_MAX_BYTES)context.addIssue({code:'custom',message:'Preview plan exceeds 2048 UTF-8 bytes'});};
export const previewPlanSchema=z.strictObject(previewFields).superRefine(checkPreviewBytes);
export const previewPlanInputSchema=z.strictObject({...previewFields,chosenTeamOrder:previewOrder.optional()}).superRefine((value,context)=>{
  checkPreviewBytes(value,context);
  if(Object.hasOwn(value,'chosenTeamOrder')&&value.chosenTeamOrder===undefined)context.addIssue({code:'custom',message:'chosenTeamOrder must be omitted or contain the exact four-slot order'});
});
export function validatePreviewPlan(value,{actions}={}){
  const order=actions===undefined?undefined:previewActions.parse(actions)[0].order;
  const omitted=value!==null&&typeof value==='object'&&!Array.isArray(value)&&!Object.hasOwn(value,'chosenTeamOrder');
  const plan=previewPlanSchema.parse(omitted&&order!==undefined?{...value,chosenTeamOrder:order}:value);
  if(order!==undefined&&!same(plan.chosenTeamOrder,order))throw new Error('Preview plan chosenTeamOrder differs from the same authored preview actions');
  return plan;
}
export function projectTurnPlan(value,{carryOnly=false}={}){
  const plan=validateTurnPlan(value);
  return carryOnly?{objective:plan.objective,...(plan.preserveIds?.length?{preserveIds:clone(plan.preserveIds)}:{}),...(plan.nextTurnCondition?{nextTurnCondition:plan.nextTurnCondition}:{})}:clone(plan);
}

const binding=z.object({teamId:z.string().regex(/^[a-f0-9]{64}$/u),room:z.string().regex(/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*(?:-[a-z0-9]+pw)?$/u),rqid:z.number().int().min(0),revision:z.number().int().min(0),turn:z.number().int().min(0)}).strict();
const canonicalRoom=value=>value.replace(/-[a-z0-9]+pw$/u,'');
export function validateTurnPlanBinding(value){const clean=binding.parse(value);return {...clean,room:canonicalRoom(clean.room)};}
const key=value=>JSON.stringify([value.teamId,canonicalRoom(value.room),value.rqid,value.revision]);
const observation=z.object({status:z.enum(['sent','accepted','rejected','execution-observed','resolution-observed','server-defaulted','inactivity']),source:z.literal('observed-control-event'),selectionSource:z.enum(['operator','fallback','emergency-default']).optional(),actions:pair.optional(),type:z.enum(['move','cant','switch']).optional(),slot:z.number().int().min(1).max(2).optional(),executed:z.boolean().optional()}).strict();
export const turnPlanResolutionSchema=observation.extend({at:z.number().finite(),planHash:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const turnPlanMetaSchema=z.object({planHash:z.string().regex(/^[a-f0-9]{64}$/u),intentStatus:z.enum(['selected','staged','sent'])}).strict();

/** Bounded ephemeral memory; it never carries actions or evidence to a new request. */
export function createTurnPlanMemory({maxHistory=12,now=Date.now}={}){
  if(!Number.isInteger(maxHistory)||maxHistory<1||maxHistory>50)throw new Error('Turn plan history bound must be 1–50');
  const records=new Map();
  return {
    recordPreview({teamId,room,rqid,revision,turn,previewPlan,actions,stage='selected'}){
      if(!['selected','staged','sent'].includes(stage))throw new Error('Agent intent status must be selected, staged or sent');
      const bound=validateTurnPlanBinding({teamId,room,rqid,revision,turn}),clean=validatePreviewPlan(previewPlan,{actions}),id=key(bound),existing=records.get(id),planHash=digest(clean);
      if(existing?.previewPlan&&existing.planHash===planHash){
        const rank={selected:0,staged:1,sent:2};if(existing.invalidated||rank[stage]>rank[existing.intentStatus])existing.intentStatus=stage;
        existing.invalidated=false;existing.updatedAt=now();return {...clone(existing),unchanged:true};
      }
      const record={...bound,previewPlan:clean,planHash,intentStatus:stage,recordedAt:now(),updatedAt:now(),observations:[],claimLimitation:'Authored preview intent only; no opposing selection, server acceptance or execution is established.'};
      records.delete(id);records.set(id,record);while(records.size>maxHistory)records.delete(records.keys().next().value);
      return {...clone(record),unchanged:false};
    },
    record({teamId,room,rqid,revision,turn,plan,actions,stage='selected'}){
      if(!['selected','staged','sent'].includes(stage))throw new Error('Agent intent status must be selected, staged or sent');
      const bound=validateTurnPlanBinding({teamId,room,rqid,revision,turn});
      const clean=validateTurnPlan(plan,{actions}),id=key(bound),existing=records.get(id),planHash=digest(clean);
      if(existing&&existing.planHash===planHash){
        const rank={selected:0,staged:1,sent:2};
        // Selecting the same staged pair for sending does not undo its actual
        // staging. A controller invalidation did clear that protection, so a
        // later fresh selection starts again at its supplied intent stage.
        if(existing.invalidated||rank[stage]>rank[existing.intentStatus])existing.intentStatus=stage;
        existing.invalidated=false;existing.updatedAt=now();return {...clone(existing),unchanged:true};
      }
      const record={...bound,plan:clean,planHash,intentStatus:stage,recordedAt:now(),updatedAt:now(),observations:[],claimLimitation:'Intent and predictions do not establish server acceptance, execution or opposing intent.'};
      records.delete(id);records.set(id,record);while(records.size>maxHistory)records.delete(records.keys().next().value);
      return {...clone(record),unchanged:false};
    },
    observe({teamId,room,rqid,revision,status,source='observed-control-event',selectionSource,actions,type,slot,executed}){
      const id=key({teamId,room,rqid,revision}),record=records.get(id);if(!record)return null;
      const entry=observation.parse({status,source,...(selectionSource===undefined?{}:{selectionSource}),...(actions===undefined?{}:{actions}),...(type===undefined?{}:{type}),...(slot===undefined?{}:{slot}),...(executed===undefined?{}:{executed})});
      if(record.observations.some(prior=>same({...prior,at:undefined},{...entry,at:undefined})))return null;
      record.observations.push({...entry,at:now()});record.observations=record.observations.slice(-8);record.updatedAt=now();return clone(record);
    },
    snapshot({teamId,room,rqid,revision}){
      room=canonicalRoom(room);const current=records.get(key({teamId,room,rqid,revision}));
      if(current?.previewPlan&&!current.invalidated)return {kind:'current-preview-request',previewPlan:clone(current.previewPlan),intentStatus:current.intentStatus,observations:clone(current.observations),claimLimitation:current.claimLimitation};
      if(current&&!current.invalidated)return {kind:'current-request',plan:clone(current.plan),intentStatus:current.intentStatus,observations:clone(current.observations),claimLimitation:current.claimLimitation};
      const prior=[...records.values()].reverse().find(value=>value.teamId===teamId&&value.room===room);
      if(prior?.previewPlan){const {chosenTeamOrder,...intent}=clone(prior.previewPlan);return {kind:'carried-preview-intent',fromTurn:prior.turn,...intent,requiresFreshDecision:true};}
      return prior?{kind:'carried-intent',fromTurn:prior.turn,...projectTurnPlan(prior.plan,{carryOnly:true}),requiresFreshDecision:true}:null;
    },
    history(){return clone([...records.values()]);},
    invalidate(binding){
      if(binding!==undefined){const value=records.get(key({...binding,room:canonicalRoom(binding.room)}));if(value)value.invalidated=true;return;}
      for(const value of records.values())value.invalidated=true;
    },
    migrateRoom(oldRoom,newRoom){
      oldRoom=canonicalRoom(oldRoom);newRoom=canonicalRoom(newRoom);
      for(const [id,value] of [...records])if(value.room===oldRoom){records.delete(id);value.room=newRoom;records.set(key(value),value);}
    },
    clearTeam(teamId){for(const [id,value] of records)if(value.teamId===teamId)records.delete(id);},
    clear(){records.clear();},
  };
}
