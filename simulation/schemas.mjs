// Pure simulation/observed input contracts. Importing this module loads only
// Zod; native mechanics, source readers, workers and retention stay elsewhere.
import {z} from 'zod';

const stats=['hp','atk','def','spa','spd','spe'],stages=['atk','def','spa','spd','spe','accuracy','evasion'];
const id=z.string().min(1).max(100),point=z.number().int().min(0).max(32);
export const statPointsSchema=z.strictObject(Object.fromEntries(stats.map(stat=>[stat,point.optional()]))).refine(points=>Object.values(points).reduce((sum,value)=>sum+value,0)<=66,'At most66 native stat points');
const boostsSchema=z.strictObject(Object.fromEntries(stages.map(stat=>[stat,z.number().int().min(-6).max(6)])));
const lifecycleSchema=z.strictObject({activeTurns:z.number().int().min(0).max(10000),activeMoveActions:z.number().int().min(0).max(10000),protectCounter:z.union([0,3,9,27,81,243,729].map(value=>z.literal(value))),choiceLock:z.union([z.literal(false),z.string().min(1).max(80)]),lastMove:z.union([z.literal(false),z.string().min(1).max(80)]),unburdenVolatile:z.boolean().optional()});
const duration=z.strictObject({remainingTurns:z.number().int().min(1).max(8)});
const confusionState=z.strictObject({remainingActions:z.number().int().min(1).max(5)});
const nativeData=z.record(z.string().min(1).max(100),z.json());
export const nativeEffectSchema=z.strictObject({state:nativeData.optional(),sourceId:id.optional(),sourceMove:z.string().min(1).max(80).optional()});
const nativeEffects=z.record(z.string().min(1).max(100),nativeEffectSchema);
export const stateAssumptionSchema=z.strictObject({path:z.string().min(1).max(300),reason:z.string().min(1).max(2000),selected:z.json().optional(),origin:z.string().max(300).optional()});
const nativePokemonState=z.strictObject({baseAbility:z.string().min(1).max(80).optional(),statusState:nativeData.optional(),volatiles:nativeEffects.optional(),abilitySuppressed:z.boolean().optional(),timesAttacked:z.number().int().min(0).max(10000).optional(),lastMoveTargetLoc:z.number().int().min(-4).max(4).optional(),moveLastTurnResult:z.union([z.boolean(),z.null()]).optional()});
export const pokemonSnapshotSchema=z.strictObject({
  id,controlPokemonId:id.optional(),species:z.string().min(1).max(80),nature:z.string().min(1).max(30),ability:z.string().min(1).max(80),item:z.string().max(80),
  moves:z.array(z.string().min(1).max(80)).min(1).max(4),statPoints:statPointsSchema,
  hp:z.union([z.literal('full'),z.literal('observed-high'),z.literal('observed-low'),z.number().int().min(0).max(10000)]).optional(),status:z.enum(['','brn','par','psn','tox','slp','frz']).optional(),boosts:boostsSchema.optional(),
  pp:z.array(z.number().int().min(0).max(100)).min(1).max(4).optional(),lifecycle:lifecycleSchema.optional(),nativeState:nativePokemonState.optional(),
  observedHp:z.strictObject({current:z.number().int().min(0),max:z.number().int().min(1).nullable(),precision:z.enum(['server-display','server-own-exact'])}).optional(),
  volatiles:z.strictObject({healblock:z.strictObject({remainingTurns:z.number().int().min(1).max(2),sourceId:id}).optional(),encore:z.strictObject({remainingTurns:z.number().int().min(1).max(3),move:z.string().min(1).max(80)}).optional(),confusion:confusionState.optional()}).optional(),
});
const tailwindDuration=z.strictObject({remainingTurns:z.number().int().min(1).max(4)});
const toxicSpikesLayers=z.strictObject({layers:z.union([z.literal(1),z.literal(2)])});
const conditionsSchema=z.strictObject({...Object.fromEntries(['reflect','lightscreen','auroraveil'].map(name=>[name,duration.optional()])),tailwind:tailwindDuration.optional(),toxicspikes:toxicSpikesLayers.optional()});
export const positionSchema=z.strictObject({
  mode:z.enum(['opening','current']),turn:z.number().int().min(1).max(10000),ownSide:z.enum(['p1','p2']),
  sides:z.array(z.strictObject({id:z.enum(['p1','p2']),active:z.array(id).length(2),pokemon:z.array(pokemonSnapshotSchema).length(4),conditions:conditionsSchema.optional(),nativeConditions:nativeEffects.optional(),nativeState:z.strictObject({totalFainted:z.number().int().min(0).max(100).optional()}).optional(),megaUsed:z.boolean().optional()})).length(2),
  field:z.strictObject({weather:z.strictObject({id:z.enum(['raindance','sunnyday','sandstorm','snow']),remainingTurns:z.number().int().min(1).max(8)}).optional(),terrain:z.strictObject({id:z.enum(['grassyterrain','psychicterrain','electricterrain','mistyterrain']),remainingTurns:z.number().int().min(1).max(8)}).optional(),trickRoom:z.strictObject({remainingTurns:z.number().int().min(1).max(5)}).optional()}).optional(),
  nativeField:z.strictObject({conditions:nativeEffects.optional()}).optional(),nativeState:z.strictObject({lastMove:z.union([z.string().min(1).max(80),z.literal(false)]).optional()}).optional(),stateAssumptions:z.array(stateAssumptionSchema).max(1000).optional(),
});
const actionSchema=z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('move'),slot:z.number().int().min(1).max(4),target:z.union([-2,-1,1,2].map(value=>z.literal(value))).optional(),mega:z.boolean().optional(),sourceMoveId:z.string().min(1).max(80).optional()}),
  z.strictObject({type:z.literal('switch'),slot:z.number().int().min(1).max(4).optional(),pokemonId:id.optional()}).refine(value=>(value.slot!==undefined)!==(value.pokemonId!==undefined),'Exactly one switch identity'),
  z.strictObject({type:z.literal('pass')}),
]);
export const deliveryObjectiveSchema=z.strictObject({requiredActionsBy:z.array(id).min(1).max(2),survive:z.array(id).min(1).max(4).optional(),field:z.strictObject({trickRoom:z.boolean().optional(),weather:z.enum(['raindance','sunnyday','sandstorm','snow']).optional(),terrain:z.enum(['grassyterrain','psychicterrain','electricterrain','mistyterrain']).optional()}).refine(value=>Object.keys(value).length>0,'At least one field goal required').optional()});
const removalGateSchema=z.strictObject({targetId:id,beforeActionsOf:z.array(id).min(1).max(4),requiredActionsBy:z.array(id).max(4).default([])});
export const deliveryGateSchema=deliveryObjectiveSchema.extend({kind:z.literal('delivery')});
export const replacementActionSchema=z.union([actionSchema.options[1],actionSchema.options[2]]);
export const replacementPairSchema=z.array(replacementActionSchema).length(2);
export const continuationSchema=z.strictObject({ourActions:replacementPairSchema.optional(),opposingActions:replacementPairSchema.optional()}).refine(value=>value.ourActions!==undefined||value.opposingActions!==undefined,'At least one replacement side required').describe('Cover exactly the sides requesting replacement. A numeric switch slot belongs to the native replacement menu at this boundary; stable Pokemon identities avoid party-order ambiguity.');
export const branchSchema=z.strictObject({id:z.string().min(1).max(80),ourActions:z.array(actionSchema).length(2),opposingActions:z.array(actionSchema).length(2),continuations:z.array(continuationSchema).max(4).optional(),gate:z.union([removalGateSchema,deliveryGateSchema])});
export const simulationCoreSchema=z.strictObject({position:positionSchema,branches:z.array(branchSchema).min(1).max(3),seeds:z.array(z.tuple([z.number().int().min(0).max(65535),z.number().int().min(0).max(65535),z.number().int().min(0).max(65535),z.number().int().min(0).max(65535)])).min(1).max(3),hypotheses:z.array(z.string().min(1).max(1000)).min(1).max(40)});
export const simulationCaseSchema=z.strictObject({id:z.string().min(1).max(80),branches:simulationCoreSchema.shape.branches,seeds:simulationCoreSchema.shape.seeds});
export const simulationBatchCoreSchema=z.strictObject({position:positionSchema,hypotheses:simulationCoreSchema.shape.hypotheses,cases:z.array(simulationCaseSchema).min(1).max(3)});

const statNames=['hp','atk','def','spa','spd','spe'];
const boostNames=['atk','def','spa','spd','spe','accuracy','evasion'];
const exactPoints=z.strictObject(Object.fromEntries(statNames.map(name=>[name,z.number().int().min(0).max(32)])))
  .refine(value=>Object.values(value).reduce((sum,n)=>sum+n,0)<=66,'Native point total exceeds 66');
export const observedBoostsSchema=z.strictObject(Object.fromEntries(boostNames.map(name=>[name,z.number().int().min(-6).max(6)])));
export const observedLifecycleSchema=z.strictObject({
  activeTurns:z.number().int().min(0).max(10000),
  activeMoveActions:z.number().int().min(0).max(10000),
  protectCounter:z.union([0,3,9,27,81,243,729].map(n=>z.literal(n))),
  choiceLock:z.union([z.literal(false),z.string().min(1)]),
  lastMove:z.union([z.literal(false),z.string().min(1)]),
  unburdenVolatile:z.boolean().optional(),
});
export const observedPpSchema=z.array(z.number().int().min(0).max(64)).length(4);
export const observedVolatileSchema=z.strictObject({healblock:z.strictObject({remainingTurns:z.number().int().min(1).max(2),sourceId:z.string().min(1)}).optional(),encore:z.strictObject({remainingTurns:z.number().int().min(1).max(3),move:z.string().min(1).max(80)}).optional(),confusion:confusionState.optional()});
const stateFields={
  label:z.string().min(1).max(500),
  nature:z.string().min(1).max(30).optional(),
  hp:z.union([z.literal('full'),z.literal('observed-high'),z.literal('observed-low'),z.number().int().min(0)]),
  ability:z.string().min(1).optional(),item:z.string().optional(),
  abilitySuppressed:z.literal(false).optional(),
  status:z.enum(['','brn','par','psn','tox','slp','frz']).optional(),boosts:observedBoostsSchema.optional(),
  pp:observedPpSchema.optional(),lifecycle:observedLifecycleSchema.optional(),volatiles:observedVolatileSchema.optional(),
};
const foeHypothesis=z.strictObject({...stateFields,statPoints:exactPoints});
const durationSchema=z.strictObject({remainingTurns:z.number().int().min(1).max(8)});
export const observedFieldSchema=z.strictObject({
  weather:z.strictObject({id:z.enum(['raindance','sunnyday','sandstorm','snow']),remainingTurns:z.number().int().min(1).max(8)}).optional(),
  terrain:z.strictObject({id:z.enum(['grassyterrain','psychicterrain','electricterrain','mistyterrain']),remainingTurns:z.number().int().min(1).max(8)}).optional(),
  trickRoom:z.strictObject({remainingTurns:z.number().int().min(1).max(5)}).optional(),
});
export const observedSideConditionsSchema=z.strictObject({reflect:durationSchema.optional(),lightscreen:durationSchema.optional(),auroraveil:durationSchema.optional(),tailwind:tailwindDuration.optional(),toxicspikes:toxicSpikesLayers.optional()});
const currentObservedHypothesesSchema=z.strictObject({
  mode:z.literal('current'),label:z.string().min(1).max(500),
  opposing:z.record(z.string().min(1),foeHypothesis),
  reserves:z.array(foeHypothesis.extend({id:z.string().min(1),species:z.string().min(1)})).max(2),
  own:z.record(z.string().min(1),z.strictObject({label:z.string().min(1).max(500),lifecycle:observedLifecycleSchema.optional(),pp:observedPpSchema.optional(),boosts:observedBoostsSchema.optional(),volatiles:observedVolatileSchema.optional()})).default({}),
  field:observedFieldSchema.optional(),
  sideConditions:z.strictObject({p1:observedSideConditionsSchema.optional(),p2:observedSideConditionsSchema.optional()}).optional(),
  sideMegaUsed:z.strictObject({p1:z.boolean().optional(),p2:z.boolean().optional()}).optional(),
});
// Match buildObservedPosition's existing opening reconstruction contract:
// native entry effects establish field/Mega history and pristine state. Current
// overrides are not meaningful in this mode and must not be silently ignored.
const openingFoeHypothesis=z.strictObject({
  label:stateFields.label,nature:stateFields.nature,hp:z.literal('full',{error:'opening HP hypothesis must be full'}),statPoints:exactPoints,
});
const openingObservedHypothesesSchema=z.strictObject({
  mode:z.literal('opening'),label:z.string().min(1).max(500),
  opposing:z.record(z.string().min(1),openingFoeHypothesis),
  reserves:z.array(openingFoeHypothesis.extend({id:z.string().min(1),species:z.string().min(1)})).max(2),
  own:z.strictObject({}).default({}),
});
export const observedHypothesesSchema=z.discriminatedUnion('mode',[openingObservedHypothesesSchema,currentObservedHypothesesSchema]);
export const observedBindingSchema=z.strictObject({teamId:z.string().regex(/^[a-f0-9]{64}$/),room:z.string().min(1),rqid:z.number().int().min(0),token:z.string().regex(/^[a-f0-9]{64}$/),opposingSheetSha256:z.string().regex(/^[a-f0-9]{64}$/).optional()});
export const observedSheetSchema=z.object({species:z.string().min(1),nature:z.string().min(1).nullable().optional(),ability:z.string().min(1),item:z.string(),moves:z.array(z.string().min(1)).length(4),level:z.number().optional()}).passthrough();
export const observedPositionInputSchema=z.strictObject({
  observed:z.object({actions:z.array(z.unknown()),boards:z.array(z.unknown()),sessionId:z.string().optional(),observedAt:z.number().optional(),revision:z.number().optional()}).passthrough(),
  teamText:z.string().min(1),opposingSheet:z.array(observedSheetSchema).length(6),
  hypotheses:observedHypothesesSchema,expected:observedBindingSchema,
});
// Alias for the MCP wrapper: a retained compact observation, not a Battle.
export const observedSourceSchema=observedPositionInputSchema;

const common={branches:z.array(branchSchema).min(1).max(3),seeds:simulationCoreSchema.shape.seeds};
export const simulationRequestSchema=z.discriminatedUnion('kind',[
  simulationCoreSchema.extend({kind:z.literal('explicit')}),
  z.strictObject({kind:z.literal('observed'),source:observedBindingSchema.extend({sessionId:z.string().min(1)}),hypotheses:observedHypothesesSchema,...common}),
]);
const evidenceContextSchema=z.strictObject({teamId:z.string().regex(/^[a-f0-9]{64}$/),roomId:z.string().regex(/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/),turn:z.number().int().min(0).max(10000).optional()}).optional();
export const simulationToolSchema=z.strictObject({request:simulationRequestSchema,evidenceContext:evidenceContextSchema});
export const simulationBatchRequestSchema=z.discriminatedUnion('kind',[
  simulationBatchCoreSchema.extend({kind:z.literal('explicit')}),
  z.strictObject({kind:z.literal('observed'),source:observedBindingSchema.extend({sessionId:z.string().min(1)}),hypotheses:observedHypothesesSchema,cases:z.array(simulationCaseSchema).min(1).max(3)}),
]);
export const simulationBatchToolSchema=z.strictObject({request:simulationBatchRequestSchema,evidenceContext:evidenceContextSchema});
