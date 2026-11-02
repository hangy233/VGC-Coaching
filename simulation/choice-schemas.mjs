// Compact author contract. Every state/source/assumption field belongs to the
// native tool, not to the model selecting the two sides' action branches.
import {z} from 'zod';
import {observedBindingSchema} from './schemas.mjs';
import {spreadDomainSchema} from './spread-range.mjs';
export const simulationChoiceActionSchema=z.discriminatedUnion('type',[
 z.strictObject({type:z.literal('move'),slot:z.number().int().min(1).max(4),target:z.union([-2,-1,1,2].map(n=>z.literal(n))).optional(),mega:z.boolean().optional()}),
 z.strictObject({type:z.literal('switch'),slot:z.number().int().min(1).max(4).optional(),pokemonId:z.string().min(1).max(100).optional(),species:z.string().min(1).max(80).optional()})
  .refine(v=>['slot','pokemonId','species'].filter(k=>v[k]!==undefined).length===1,'One switch identity required'),
 z.strictObject({type:z.literal('pass')}),
]);
export const simulationChoicePairSchema=z.array(simulationChoiceActionSchema).length(2);
const replacementPair=z.array(z.union([simulationChoiceActionSchema.options[1],simulationChoiceActionSchema.options[2]])).length(2);
export const simulationChoiceContinuationSchema=z.strictObject({ourActions:replacementPair.optional(),opposingActions:replacementPair.optional()}).refine(value=>value.ourActions!==undefined||value.opposingActions!==undefined,'At least one replacement side required').describe('Supply only sides listed in the actual native replacement request; omit a nonrequesting side. Prefer species or stable Pokemon identities. Numeric switch slots refer to that replacement menu, after earlier switches, rather than the original turn party order.');
const continuations=z.array(simulationChoiceContinuationSchema).max(4).optional();
export const legacySimulationChoicesAuthorSchema=z.strictObject({
 ourActions:simulationChoicePairSchema,opposingActions:simulationChoicePairSchema,
 continuations,
 alternatives:z.array(z.strictObject({id:z.string().min(1).max(80).optional(),ourActions:simulationChoicePairSchema,opposingActions:simulationChoicePairSchema,continuations})).max(2).optional(),
 spreadRanges:z.array(z.strictObject({pokemonId:z.string().min(1).max(100),domain:spreadDomainSchema})).max(6).optional(),
});
export const simulationChoicesAuthorSchema=legacySimulationChoicesAuthorSchema.omit({alternatives:true});
const privateFields={
 source:observedBindingSchema.extend({sessionId:z.string().min(1)}),
 analysis:z.enum(['current','frozen']).default('current'),freezeId:z.string().uuid().optional(),
 evidenceContext:z.strictObject({teamId:z.string().regex(/^[a-f0-9]{64}$/u),roomId:z.string().regex(/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/u),turn:z.number().int().min(0).max(10000).optional()}).optional(),
};
export const simulationChoicesToolSchema=simulationChoicesAuthorSchema.extend(privateFields);
export const legacySimulationChoicesToolSchema=legacySimulationChoicesAuthorSchema.extend(privateFields);
