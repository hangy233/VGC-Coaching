import test from 'node:test';
import assert from 'node:assert/strict';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import {projectCodexToolSchema,projectCodexToolDefinition,CODEX_TOOL_DESCRIPTION_BYTES,CODEX_TOOL_ARGUMENT_SCHEMA_MARKER} from './codex-tool-schema.mjs';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';
import {MODEL_TOOL_NAMES,modelToolDefinition} from '../showdown/model-owned-tools.mjs';
import {modelToolDefinitions} from './model-tool-cycle.mjs';

const tuple=()=>({type:'array',items:Array.from({length:4},()=>({type:'integer',minimum:0,maximum:65535})),minItems:4,maxItems:4,additionalItems:false});

function recoveredDescriptionSchema(definition){
  const start=definition.description.indexOf(CODEX_TOOL_ARGUMENT_SCHEMA_MARKER);
  assert.notEqual(start,-1);assert.ok(definition.description.endsWith('\n```'));
  return JSON.parse(definition.description.slice(start+CODEX_TOOL_ARGUMENT_SCHEMA_MARKER.length,-4));
}

test('simulation descriptions retain the complete native authorable schema without changing native definitions',()=>{
  for(const name of ['simulate_turn','battle_check_plan']){
    const properties={
      hypotheses:{oneOf:[
        {type:'object',properties:{mode:{const:'opening'},opposing:{type:'object',additionalProperties:{type:'object'}}},required:['mode','opposing']},
        {type:'object',properties:{mode:{const:'current'}},required:['mode']},
      ]},
      seeds:{type:'array',items:tuple(),minItems:1,maxItems:3},
      gate:{anyOf:[{type:'object',required:['targetId']},{type:'object',required:['requiredActionsBy']}]},
    };
    const inputSchema={$schema:'http://json-schema.org/draft-07/schema#',type:'object',properties:{request:{oneOf:[{type:'object',properties,required:['hypotheses','seeds','gate']}]}}};
    const native={name,description:'Exact authored simulation only.',inputSchema},before=structuredClone(native),result=projectCodexToolDefinition(native);
    assert.deepEqual(native,before);assert.equal(result.schemaDescriptionIncluded,true);assert.equal(result.fixedHomogeneousTuples,1);
    assert.deepEqual(recoveredDescriptionSchema(result.definition),before.inputSchema);
    assert.ok(result.definition.description.startsWith(before.description+CODEX_TOOL_ARGUMENT_SCHEMA_MARKER));
    assert.equal(Array.isArray(result.definition.inputSchema.properties.request.oneOf[0].properties.seeds.items.items),false);
    result.definition.inputSchema.properties.request.oneOf[0].required.push('other');assert.deepEqual(native,before);
  }
});

test('other tools retain their descriptions and no schema text or arguments are invented',()=>{
  for(const name of ['get_pokemon','get_move','get_ability','get_movepool','calculate_damage','calculate_speed','simulate_turn_extra']){
    const native={name,description:'Native description.',inputSchema:{type:'object',properties:{value:{type:'string'}}}},before=structuredClone(native),result=projectCodexToolDefinition(native);
    assert.equal(result.schemaDescriptionIncluded,false);assert.deepEqual(result.definition,before);assert.deepEqual(native,before);
  }
});

test('schema descriptions remain complete at the bound and fail rather than truncate oversized native schemas',()=>{
  const make=size=>({name:'simulate_turn',description:'Native.',inputSchema:{type:'object',properties:{value:{type:'string',description:'x'.repeat(size)}}}});
  const overhead=Buffer.byteLength(projectCodexToolDefinition(make(0)).definition.description),limit=make(CODEX_TOOL_DESCRIPTION_BYTES-overhead);
  const before=structuredClone(limit),result=projectCodexToolDefinition(limit);
  assert.equal(Buffer.byteLength(result.definition.description),CODEX_TOOL_DESCRIPTION_BYTES);assert.deepEqual(recoveredDescriptionSchema(result.definition),limit.inputSchema);assert.deepEqual(limit,before);
  const excessive=make(CODEX_TOOL_DESCRIPTION_BYTES-overhead+1),original=structuredClone(excessive);
  assert.throws(()=>projectCodexToolDefinition(excessive),error=>error instanceof RangeError&&error.code==='invalid_model_tools');assert.deepEqual(excessive,original);
  assert.throws(()=>projectCodexToolDefinition({name:'get_move',description:'é'.repeat(CODEX_TOOL_DESCRIPTION_BYTES/2+1),inputSchema:{type:'object'}}),{code:'invalid_model_tools'});
});

test('fixed homogeneous tuple projection preserves exact accepted values and leaves its native schema unchanged',()=>{
  const native={type:'object',properties:{seed:tuple()},required:['seed'],additionalProperties:false},before=structuredClone(native),projected=projectCodexToolSchema(native);
  assert.equal(projected.fixedHomogeneousTuples,1);assert.deepEqual(native,before);
  assert.deepEqual(projected.schema,{type:'object',properties:{seed:{type:'array',items:{type:'integer',minimum:0,maximum:65535},minItems:4,maxItems:4}},required:['seed'],additionalProperties:false});
  const validator=new AjvJsonSchemaValidator(),oldAccepts=validator.getValidator(native),newAccepts=validator.getValidator(projected.schema);
  const values=[null,'not-array',0,{},[],[0],[0,0,0],[0,0,0,0,0]];
  for(let mask=0;mask<16;mask++)values.push(Array.from({length:4},(_,index)=>mask&(1<<index)?65535:0));
  for(const bad of [-1,65536,0.5,'0',null,{},true])for(let index=0;index<4;index++){const seed=[1,2,3,4];seed[index]=bad;values.push(seed);}
  for(const seed of values)assert.equal(newAccepts({seed}).valid,oldAccepts({seed}).valid,JSON.stringify(seed));
  assert.equal(newAccepts({seed:[1,2,3,4]}).valid,true);assert.equal(newAccepts({seed:[1,2,3,4],other:true}).valid,false);
});

test('heterogeneous, optional, open and extended tuples remain unchanged rather than gaining new inputs',()=>{
  for(const change of [
    node=>{node.items[3]={type:'string'};},node=>{node.minItems=3;},node=>{delete node.maxItems;},
    node=>{node.additionalItems=true;},node=>{delete node.additionalItems;},node=>{node.additionalItems={type:'integer'};},
    node=>{node.maxItems=5;},node=>{node.type='object';},node=>{node.items=[];node.minItems=0;node.maxItems=0;},
  ]){const native=tuple();change(native);const before=structuredClone(native),projected=projectCodexToolSchema(native);assert.equal(projected.fixedHomogeneousTuples,0);assert.deepEqual(projected.schema,before);assert.deepEqual(native,before);}
});

test('newer or unknown schema dialects remain native while supported tuple dialects project',()=>{
  for(const dialect of ['https://json-schema.org/draft/2020-12/schema','https://json-schema.org/draft/2019-09/schema','https://schema.invalid/future']){
    const native={$schema:dialect,...tuple()},before=structuredClone(native),projected=projectCodexToolSchema(native);assert.equal(projected.fixedHomogeneousTuples,0);assert.deepEqual(projected.schema,before);assert.deepEqual(native,before);
  }
  for(const dialect of ['http://json-schema.org/draft-04/schema#','http://json-schema.org/draft-06/schema#','http://json-schema.org/draft-07/schema#']){
    const projected=projectCodexToolSchema({$schema:dialect,...tuple()});assert.equal(projected.fixedHomogeneousTuples,1);assert.equal(projected.schema.$schema,dialect);
  }
});

test('projection recurses through actual schema positions and local definitions',()=>{
  const maps=['properties','patternProperties','$defs','definitions','dependentSchemas'],singles=['additionalProperties','additionalItems','contains','not','if','then','else','propertyNames','unevaluatedProperties','unevaluatedItems'],arrays=['oneOf','anyOf','allOf','prefixItems'];
  const native={type:'object'};
  for(const key of maps)native[key]={seed:tuple()};for(const key of singles)native[key]=tuple();for(const key of arrays)native[key]=[tuple()];native.items=tuple();
  const before=structuredClone(native),projected=projectCodexToolSchema(native);assert.equal(projected.fixedHomogeneousTuples,maps.length+singles.length+arrays.length+1);assert.deepEqual(native,before);
  for(const key of maps)assert.equal(Array.isArray(projected.schema[key].seed.items),false);for(const key of singles)assert.equal(Array.isArray(projected.schema[key].items),false);for(const key of arrays)assert.equal(Array.isArray(projected.schema[key][0].items),false);assert.equal(Array.isArray(projected.schema.items.items),false);
});

test('const, default, enum, examples and arbitrary data are never traversed as schemas',()=>{
  const native={type:'object',properties:{payload:{type:'object',const:tuple(),default:tuple(),enum:[tuple()]}},const:{schemaLike:tuple()},default:tuple(),enum:[tuple()],examples:[tuple()],example:tuple(),annotation:{properties:{seed:tuple()}}},before=structuredClone(native),projected=projectCodexToolSchema(native);
  assert.equal(projected.fixedHomogeneousTuples,0);assert.deepEqual(projected.schema,before);assert.deepEqual(native,before);
});

test('actual native legacy eight-tool catalog needs exactly two equivalent tuple projections and stays unmodified',{timeout:15000},async()=>{
  const connection=await connectOfflineNumericClient();
  try{
    const catalog=await connection.client.listTools(),native=structuredClone(catalog),authorable=catalog.tools.filter(tool=>MODEL_TOOL_NAMES.includes(tool.name)&&!['simulate_choices','calculate_damage_range'].includes(tool.name)&&
      (tool.name!=='battle_check_plan'||tool.annotations?.readOnlyHint===true)).map(modelToolDefinition),definitions=modelToolDefinitions(authorable),before=structuredClone(definitions);
    assert.equal(definitions.length,8);const projected=definitions.map(tool=>({name:tool.name,...projectCodexToolSchema(tool.inputSchema)}));
    assert.equal(projected.reduce((count,row)=>count+row.fixedHomogeneousTuples,0),2);
    assert.deepEqual(projected.filter(row=>row.fixedHomogeneousTuples).map(row=>row.name).sort(),['battle_check_plan','simulate_turn']);
    const complete=definitions.map(projectCodexToolDefinition);
    assert.deepEqual(complete.filter(row=>row.schemaDescriptionIncluded).map(row=>row.definition.name).sort(),['battle_check_plan','simulate_turn']);
    for(const row of complete){
      const original=before.find(tool=>tool.name===row.definition.name);
      if(row.schemaDescriptionIncluded)assert.deepEqual(recoveredDescriptionSchema(row.definition),original.inputSchema);
      else assert.equal(row.definition.description,original.description);
      assert.ok(Buffer.byteLength(row.definition.description)<=CODEX_TOOL_DESCRIPTION_BYTES);
    }
    assert.deepEqual(definitions,before);assert.deepEqual(catalog,native);
    for(const row of projected){const original=definitions.find(tool=>tool.name===row.name).inputSchema;if(!row.fixedHomogeneousTuples)assert.deepEqual(row.schema,original);}
  }finally{await connection.close();}
});

test('actual current compact eight-tool catalog includes ranges and excludes legacy simulation tuples',{timeout:15000},async()=>{
  const connection=await connectOfflineNumericClient();
  try{
    const catalog=await connection.client.listTools(),native=structuredClone(catalog),authorable=catalog.tools.filter(tool=>MODEL_TOOL_NAMES.includes(tool.name)&&
      (tool.name!=='battle_check_plan'||tool.annotations?.readOnlyHint===true)).map(modelToolDefinition),definitions=modelToolDefinitions(authorable),before=structuredClone(definitions);
    assert.deepEqual(definitions.map(tool=>tool.name).sort(),['get_pokemon','get_move','get_ability','get_movepool','calculate_damage','calculate_damage_range','calculate_speed','simulate_choices'].sort());
    const projected=definitions.map(projectCodexToolDefinition);
    assert.equal(projected.reduce((count,row)=>count+row.fixedHomogeneousTuples,0),0);
    assert.equal(projected.some(row=>row.schemaDescriptionIncluded),false);
    for(const row of projected){
      const original=before.find(tool=>tool.name===row.definition.name);
      assert.deepEqual(row.definition.inputSchema,original.inputSchema);
      assert.equal(row.definition.description,original.description);
    }
    assert.deepEqual(definitions,before);assert.deepEqual(catalog,native);
  }finally{await connection.close();}
});
