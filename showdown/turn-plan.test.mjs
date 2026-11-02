import test from 'node:test';
import assert from 'node:assert/strict';
import {createTurnPlanMemory,validateTurnPlan,projectTurnPlan,turnPlanSchema,turnPlanInputSchema,TURN_PLAN_MAX_BYTES,validatePreviewPlan,previewPlanSchema,previewPlanInputSchema} from './turn-plan.mjs';

const teamId='a'.repeat(64),room='battle-gen9championsvgc2026regmcbo3-2002';
const chosenPair=[{type:'move',slot:1,target:1},{type:'move',slot:2}];
const plan={objective:'Remove the weather setter before exposing our reserve.',priorityThreat:'Opposing weather setter',preserveIds:['pokemon-poli'],chosenPair,fallback:[{type:'move',slot:4},{type:'move',slot:4}],opposingPair:['Protect the setter','Attack our support'],opposingAlternative:['Switch the setter','Attack our attacker'],risk:'Protect may deny the removal.',unverified:['Opposing Speed investment'],evidenceRefs:[],nextTurnCondition:'Reassess the weather and remaining speed control.'};
const bound={teamId,room,rqid:7,revision:2,turn:3};

test('preview plans bind only the same explicit four-slot order and preserve every authored claim',()=>{
  const actions=[{type:'team',order:[6,2,4,1]}],intent={objective:'Open with the selected support and pressure.',risk:'If control is contested retain the independent pressure.',preserveIds:['selected-reserve'],nextTurnCondition:'Convert control into the next reserve action.',unverified:['Opposing selected four remain unknown.']};
  const before=structuredClone({intent,actions}),plan=validatePreviewPlan(intent,{actions});
  assert.deepEqual(plan,{...intent,chosenTeamOrder:actions[0].order});assert.deepEqual({intent,actions},before);
  assert(previewPlanInputSchema.safeParse(intent).success);assert(!previewPlanSchema.safeParse(intent).success);
  assert.deepEqual(validatePreviewPlan(plan),plan);
  assert.throws(()=>validatePreviewPlan({...intent,chosenTeamOrder:[1,2,4,6]},{actions}),/differs/);
  for(const invalid of [[{type:'move',slot:1},{type:'move',slot:1}],[{type:'team',order:[1,1,2,3]}],[{type:'team',order:[1,2,3]}]])assert.throws(()=>validatePreviewPlan(intent,{actions:invalid}));
  for(const extra of [{chosenTeamOrder:undefined},{accepted:true},{capturedAt:1},{chosenPair:actions}])assert.throws(()=>validatePreviewPlan({...intent,...extra},{actions}));
});

test('preview intent remains bounded after expansion and never carries an old order into the next request',()=>{
  const actions=[{type:'team',order:[1,2,3,4]}],intent={objective:'界'.repeat(180),risk:'界'.repeat(180),preserveIds:Array(6).fill('界'.repeat(80)),nextTurnCondition:'界'.repeat(180),unverified:Array(4).fill('界'.repeat(100))};
  assert.throws(()=>validatePreviewPlan(intent,{actions}),/2048/);
  const memory=createTurnPlanMemory({now:()=>42}),previewPlan={objective:'Use the authored opening.',risk:'Control remains contested.',nextTurnCondition:'Retain the independent cleanup route.'};
  const record=memory.recordPreview({...bound,turn:0,previewPlan,actions,stage:'staged'});
  assert.deepEqual(memory.snapshot(bound).previewPlan,record.previewPlan);assert.equal(record.recordedAt,42);assert.equal(record.intentStatus,'staged');
  const carried=memory.snapshot({...bound,rqid:8});assert.equal(carried.kind,'carried-preview-intent');assert(!Object.hasOwn(carried,'chosenTeamOrder'));assert(!Object.hasOwn(carried,'chosenPair'));assert.equal(carried.requiresFreshDecision,true);
});

test('compact plans require a complete structured pair, exact authored actions and bounded private prose',()=>{
  assert.deepEqual(validateTurnPlan(plan,{actions:chosenPair}),plan);
  assert.throws(()=>validateTurnPlan({...plan,chosenPair:[chosenPair[0]]}),/complete paired/);
  assert.throws(()=>validateTurnPlan(plan,{actions:[{type:'move',slot:4},{type:'move',slot:4}]}),/differs/);
  for(const extra of [{token:'b'.repeat(64)},{controllerLease:'b'.repeat(64)},{password:'secret'},{accepted:true},{cutoffAt:123}])assert.throws(()=>validateTurnPlan({...plan,...extra}),/Unrecognized/);
  for(const objective of ['https://private.example/secret','b'.repeat(64),'hello\u0000world'])assert.throws(()=>validateTurnPlan({...plan,objective}));
  assert.throws(()=>validateTurnPlan({...plan,chosenPair:[{type:'switch',slot:3,pokemonId:'pokemon-three'},{type:'pass'}]}));
  assert.throws(()=>validateTurnPlan({...plan,chosenPair:[{type:'pass'},{type:'team',order:[1,2,3,4]}]}));
  assert.throws(()=>validateTurnPlan({...plan,objective:'界'.repeat(180),priorityThreat:'界'.repeat(120),risk:'界'.repeat(180),nextTurnCondition:'界'.repeat(180),preserveIds:Array(6).fill('界'.repeat(80)),unverified:Array(4).fill('界'.repeat(100))}),/2048/);
  assert(Buffer.byteLength(JSON.stringify(plan),'utf8')<TURN_PLAN_MAX_BYTES);
});

test('only an omitted pair derives from the exact explicit actions without changing authored inputs',()=>{
  const actions=[{type:'switch',pokemonId:'pokemon-reserve'},{type:'move',slot:2,target:1,mega:false}],short={objective:'Use the explicit pair to retain the next answer.'};
  const original=structuredClone({actions,short}),expanded=validateTurnPlan(short,{actions});
  assert.deepEqual(expanded,{...short,chosenPair:actions});assert.deepEqual({actions,short},original);
  assert.equal(turnPlanInputSchema.safeParse(short).success,true);assert.equal(turnPlanSchema.safeParse(short).success,false);
  assert.equal(turnPlanSchema.safeParse(expanded).success,true);expanded.chosenPair[0].pokemonId='changed';assert.equal(actions[0].pokemonId,'pokemon-reserve');
  for(const chosenPair of [undefined,null,[],[actions[0]]]){
    assert.throws(()=>validateTurnPlan({...short,chosenPair},{actions}));
    assert.equal(turnPlanInputSchema.safeParse({...short,chosenPair}).success,false);
  }
  for(const value of [short,null,[],{...short,unknown:true}])assert.throws(()=>validateTurnPlan(value));
  for(const invalid of [null,[],[actions[0]],[{type:'move',slot:99},{type:'pass'}],[{type:'pass',extra:true},{type:'pass'}]])assert.throws(()=>validateTurnPlan(short,{actions:invalid}));
  assert.throws(()=>projectTurnPlan(short,{carryOnly:true}));
});

test('the byte limit applies after expansion, and compact/full intent retain identical stored hashes',()=>{
  const short={objective:'界'.repeat(180),priorityThreat:'界'.repeat(120),risk:'界'.repeat(180),nextTurnCondition:'界'.repeat(175)};
  assert(Buffer.byteLength(JSON.stringify(short),'utf8')<=TURN_PLAN_MAX_BYTES);
  assert(Buffer.byteLength(JSON.stringify({...short,chosenPair}),'utf8')>TURN_PLAN_MAX_BYTES);
  assert.equal(turnPlanInputSchema.safeParse(short).success,true);assert.throws(()=>validateTurnPlan(short,{actions:chosenPair}),/2048/);
  const compact={objective:'Protect the next attacking window.'},full={...compact,chosenPair},memory=createTurnPlanMemory();
  const first=memory.record({...bound,plan:compact,actions:chosenPair,stage:'staged'}),second=memory.record({...bound,plan:full,actions:chosenPair,stage:'sent'});
  assert.equal(first.planHash,second.planHash);assert.equal(second.unchanged,true);assert.deepEqual(second.plan,full);
});

test('new requests carry only strategic intent, never old actions, evidence, threat predictions or outcome claims',()=>{
  const memory=createTurnPlanMemory();memory.record({...bound,plan,actions:chosenPair,stage:'staged'});
  const current=memory.snapshot(bound);assert.equal(current.kind,'current-request');assert.equal(current.intentStatus,'staged');assert.equal(current.observations.length,0);
  const carried=memory.snapshot({...bound,rqid:8,revision:3});
  assert.deepEqual(carried,{kind:'carried-intent',fromTurn:3,objective:plan.objective,preserveIds:plan.preserveIds,nextTurnCondition:plan.nextTurnCondition,requiresFreshDecision:true});
  assert.deepEqual(projectTurnPlan(plan,{carryOnly:true}),{objective:plan.objective,preserveIds:plan.preserveIds,nextTurnCondition:plan.nextTurnCondition});
  assert.equal(memory.snapshot({...bound,teamId:'b'.repeat(64)}),null);
  assert.equal(memory.snapshot({...bound,room:'battle-gen9championsvgc2026regmcbo3-2003'}),null);
});

test('observations remain separate, bounded, deduplicated and request-specific; intent cannot claim accepted or executed',()=>{
  let at=100;const memory=createTurnPlanMemory({now:()=>at++});
  assert.throws(()=>memory.record({...bound,plan,actions:chosenPair,stage:'accepted'}),/intent status/);
  const first=memory.record({...bound,plan,actions:chosenPair,stage:'staged'});
  const duplicate=memory.record({...bound,plan,actions:chosenPair,stage:'selected'});assert.equal(duplicate.unchanged,true);assert.equal(duplicate.planHash,first.planHash);
  assert.equal(memory.observe({...bound,rqid:99,status:'accepted'}),null);
  assert.throws(()=>memory.observe({...bound,status:'accepted',source:'agent-claim'}));
  memory.observe({...bound,status:'sent'});memory.observe({...bound,status:'execution-observed',type:'move',slot:1,executed:true});
  assert.equal(memory.observe({...bound,status:'sent'}),null);
  const current=memory.snapshot(bound);assert.equal(current.intentStatus,'staged');assert.deepEqual(current.observations.map(value=>value.status),['sent','execution-observed']);assert.equal(current.observations[1].slot,1);
  current.plan.objective='mutation';assert.equal(memory.snapshot(bound).plan.objective,plan.objective);
  assert(!JSON.stringify(memory.history()).includes('controllerLease'));assert(!JSON.stringify(memory.history()).includes('token'));
});

test('memory bounds history and permanently clears team-owned intent without disturbing another team',()=>{
  const memory=createTurnPlanMemory({maxHistory:2});
  memory.record({...bound,plan,actions:chosenPair});memory.record({...bound,rqid:8,revision:3,plan,actions:chosenPair});
  memory.record({...bound,teamId:'b'.repeat(64),plan,actions:chosenPair});assert.equal(memory.history().length,2);assert.equal(memory.history().some(value=>value.teamId===teamId&&value.rqid===7),false);
  memory.clearTeam(teamId);assert.equal(memory.snapshot({...bound,rqid:8,revision:3}),null);assert.equal(memory.history().length,1);memory.clear();assert.equal(memory.history().length,0);
});

test('controller invalidation hides same-request actions, and observed room renames preserve bounded strategic memory',()=>{
  const memory=createTurnPlanMemory();memory.record({...bound,plan,actions:chosenPair,stage:'staged'});
  memory.invalidate();const invalid=memory.snapshot(bound);assert.equal(invalid.kind,'carried-intent');assert.equal(invalid.requiresFreshDecision,true);assert(!('plan' in invalid));
  const renamed='battle-gen9championsvgc2026regmcbo3-2004';memory.migrateRoom(room,renamed);assert.equal(memory.snapshot(bound),null);assert.equal(memory.snapshot({...bound,room:renamed}).objective,plan.objective);
  memory.record({...bound,room:renamed,plan,actions:chosenPair,stage:'selected'});assert.equal(memory.snapshot({...bound,room:renamed}).kind,'current-request');
  assert.equal(memory.snapshot({...bound,room:renamed}).intentStatus,'selected','Invalidated protection must not be restored merely by selecting the old pair');
});

test('same-plan intent stages progress monotonically but a genuinely revised pair starts at its own stage',()=>{
  const memory=createTurnPlanMemory();memory.record({...bound,plan,actions:chosenPair,stage:'staged'});memory.record({...bound,plan,actions:chosenPair,stage:'selected'});
  assert.equal(memory.snapshot(bound).intentStatus,'staged');assert.deepEqual(memory.snapshot(bound).observations,[]);
  const changedPair=[{type:'move',slot:3,target:1},{type:'move',slot:2}];
  memory.record({...bound,plan:{...plan,chosenPair:changedPair},actions:changedPair,stage:'selected'});assert.equal(memory.snapshot(bound).intentStatus,'selected');
});
