// CLI 0.166 accepts homogeneous array items but not draft-07 tuple items.
// Rewrite only a provably equivalent fixed-length homogeneous tuple. Native
// MCP schemas and tool arguments are unchanged by this presentation adapter.
import {isDeepStrictEqual} from 'node:util';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const maps=['properties','patternProperties','$defs','definitions','dependentSchemas'];
const singles=['additionalProperties','additionalItems','contains','not','if','then','else','propertyNames','unevaluatedProperties','unevaluatedItems'];
const arrays=['oneOf','anyOf','allOf','prefixItems'];
export const CODEX_TOOL_DESCRIPTION_BYTES=96*1024;
export const CODEX_TOOL_ARGUMENT_SCHEMA_MARKER='\n\nComplete model-authored argument JSON Schema (authoritative protocol; supply your own argument values):\n```json\n';
const completeSchemaTools=new Set(['simulate_turn','battle_check_plan']);

// CLI 0.166's model-facing TypeScript rendering can replace a large schema's
// child fields with `unknown`. Preserve the complete authorable native schema
// as protocol text as well. This supplies no argument values or tactical plan.
export function projectCodexToolDefinition(definition){
  const projected=projectCodexToolSchema(definition.inputSchema);
  const schemaDescriptionIncluded=completeSchemaTools.has(definition.name);
  const description=schemaDescriptionIncluded
    ? definition.description+CODEX_TOOL_ARGUMENT_SCHEMA_MARKER+JSON.stringify(definition.inputSchema)+'\n```'
    : definition.description;
  if(typeof description!=='string'||Buffer.byteLength(description)>CODEX_TOOL_DESCRIPTION_BYTES){
    const error=new RangeError('Projected model tool description exceeds its byte limit');
    error.code='invalid_model_tools';throw error;
  }
  return {definition:{...definition,description,inputSchema:projected.schema},
    fixedHomogeneousTuples:projected.fixedHomogeneousTuples,schemaDescriptionIncluded};
}

export function projectCodexToolSchema(schema){
  const result=structuredClone(schema);let fixedHomogeneousTuples=0;
  function visit(node){
    if(!object(node))return;
    if(node.$schema!==undefined&&!/^https?:\/\/json-schema\.org\/draft-0[467]\/schema#?$/u.test(node.$schema))return;
    for(const key of maps)if(object(node[key]))for(const child of Object.values(node[key]))visit(child);
    for(const key of singles)visit(node[key]);
    for(const key of arrays)if(Array.isArray(node[key]))for(const child of node[key])visit(child);
    if(Array.isArray(node.items)){
      const tuple=node.items,n=tuple.length;
      // Equivalence depends on all these constraints. Heterogeneous, optional
      // or open-ended tuples are preserved rather than loosened or guessed.
      if(node.type==='array'&&n>0&&node.minItems===n&&node.maxItems===n&&node.additionalItems===false&&
        tuple.every(item=>isDeepStrictEqual(item,tuple[0]))){
        node.items=tuple[0];delete node.additionalItems;fixedHomogeneousTuples++;
        visit(node.items);
      }else for(const child of tuple)visit(child);
    }else visit(node.items);
  }
  visit(result);
  return {schema:result,fixedHomogeneousTuples};
}
