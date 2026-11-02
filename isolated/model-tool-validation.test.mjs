import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelToolArgumentValidator} from './model-tool-validation.mjs';
import {modelToolDefinition,MODEL_TOOL_NAMES} from '../showdown/model-owned-tools.mjs';
import {modelToolDefinitions} from './model-tool-cycle.mjs';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';
import {fixture} from '../simulation/observed-position.fixtures.mjs';

test('actual advertised simulation schemas reject the observed malformed shape and accept complete model-authored protocol inputs',{timeout:15000},async()=>{
  const sdk=await connectOfflineNumericClient();
  try{
    const native=await sdk.client.listTools(),catalog=native.tools.filter(tool=>MODEL_TOOL_NAMES.includes(tool.name)&&
      (tool.name!=='battle_check_plan'||tool.annotations?.readOnlyHint===true)).map(modelToolDefinition);
    const definitions=modelToolDefinitions(catalog.filter(tool=>tool.name!=='simulate_choices'));
    const validate=createModelToolArgumentValidator(definitions),bad={request:{kind:'observed',hypotheses:[],branches:[{id:'candidate',ourActions:[],opposingActions:[]}],seeds:[1]}},before=structuredClone(bad);
    const error=validate('simulate_turn',bad);assert.equal(error.isError,true);assert.equal(error.structuredContent.backendCalled,false);
    assert.deepEqual(error.structuredContent.expectedSchema,definitions.find(tool=>tool.name==='simulate_turn').inputSchema);
    assert.match(error.content[0].text,/hypotheses|must be object/u);assert.deepEqual(bad,before);
    const source=fixture(),pair=[{type:'move',slot:1,target:1},{type:'move',slot:4}],good={request:{kind:'observed',hypotheses:structuredClone(source.hypotheses),
      branches:[{id:'candidate',ourActions:pair,opposingActions:pair,gate:{kind:'delivery',requiredActionsBy:['own1']}}],seeds:[[1,2,3,4]]}};
    const untouched=structuredClone(good);assert.equal(validate('simulate_turn',good),null);assert.deepEqual(good,untouched);
    for(const mutate of [value=>{value.request.seeds=[1];},value=>{delete value.request.branches[0].gate;},value=>{value.request.hypotheses=[];}]){
      const changed=structuredClone(good);mutate(changed);assert.equal(validate('simulate_turn',changed).isError,true);
    }
    const compactDefinitions=modelToolDefinitions(catalog),validateCompact=createModelToolArgumentValidator(compactDefinitions);
    assert(compactDefinitions.some(tool=>tool.name==='simulate_choices'));assert(!compactDefinitions.some(tool=>tool.name==='simulate_turn'));
    const pivot={ourActions:pair,opposingActions:pair,continuations:[{ourActions:[{type:'switch',species:'Politoed'},{type:'pass'}]}]};
    assert.equal(validateCompact('simulate_choices',pivot),null,'Actual advertised model schema exposes authored pivot entrants');
    const malformed=structuredClone(pivot);malformed.continuations[0].ourActions[0]={type:'move',slot:4};
    assert.equal(validateCompact('simulate_choices',malformed).isError,true,'A continuation cannot issue a new move');
    const tooMany=structuredClone(pivot);tooMany.continuations=Array.from({length:5},()=>structuredClone(pivot.continuations[0]));
    assert.equal(validateCompact('simulate_choices',tooMany).isError,true);
  }finally{await sdk.close();}
});

test('validation never invents required fields or permits unknown tools',()=>{
  const validate=createModelToolArgumentValidator([{name:'get_pokemon',inputSchema:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}}]);
  const args={};assert.equal(validate('get_pokemon',args).isError,true);assert.deepEqual(args,{});
  assert.equal(validate('get_pokemon',{name:'Golisopod'}),null);assert.equal(validate('get_pokemon',{name:'Golisopod',token:'forbidden'}).isError,true);
  assert.throws(()=>validate('battle_start',{}),/Unknown/u);
});
