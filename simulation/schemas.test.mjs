import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as pure from './schemas.mjs';

const actions=[{type:'move',slot:1,target:1},{type:'move',slot:4}];
const branch=()=>({id:'declared',ourActions:structuredClone(actions),opposingActions:structuredClone(actions),gate:{targetId:'foe',beforeActionsOf:['foe']}});
const points=()=>({hp:0,atk:0,def:0,spa:0,spd:0,spe:0});
const mon=id=>({id,species:'Named species',nature:'Named nature',ability:'Named ability',item:'',moves:['One','Two','Three','Four'],statPoints:{}});
const position=()=>({mode:'opening',turn:1,ownSide:'p1',sides:['p1','p2'].map(side=>({id:side,active:[side+'a',side+'b'],pokemon:['a','b','c','d'].map(id=>mon(side+id))}))});
const core=()=>({position:position(),branches:[branch()],seeds:[[1,2,3,4]],hypotheses:['Explicit structural test assumptions.']});
const hypotheses=()=>({mode:'opening',label:'Explicit opposing assumptions.',opposing:{foe:{label:'Named spread.',hp:'full',statPoints:points()}},reserves:[]});
const source=()=>({teamId:'a'.repeat(64),room:'battle-gen9championsvgc2026regmcbo3-1',rqid:1,token:'b'.repeat(64),sessionId:'named-session'});

test('legacy public simulation schema exports are the exact pure singleton objects',async()=>{
  const [native,observed,mcp]=await Promise.all([import('./turn-simulator.mjs'),import('./observed-position.mjs'),import('./mcp-tools.mjs')]);
  for(const name of ['statPointsSchema','pokemonSnapshotSchema','positionSchema','deliveryObjectiveSchema','deliveryGateSchema','branchSchema','simulationCoreSchema','simulationCaseSchema','simulationBatchCoreSchema'])assert.equal(native[name],pure[name],name);
  for(const name of ['observedLifecycleSchema','observedFieldSchema','observedHypothesesSchema','observedBindingSchema','observedPositionInputSchema','observedSourceSchema'])assert.equal(observed[name],pure[name],name);
  for(const name of ['simulationRequestSchema','simulationToolSchema','simulationBatchRequestSchema','simulationBatchToolSchema'])assert.equal(mcp[name],pure[name],name);
  assert.equal(pure.observedSourceSchema,pure.observedPositionInputSchema);
});

test('pure schemas retain nested strictness, exact observed points and native point refinements',()=>{
  assert.deepEqual(pure.statPointsSchema.parse({hp:32,atk:32,spd:2}),{hp:32,atk:32,spd:2});
  for(const value of [{hp:33},{hp:32,atk:32,spd:3},{hp:1.5},{hp:1,unexpected:0}])assert.equal(pure.statPointsSchema.safeParse(value).success,false);
  const input=hypotheses();assert.equal(pure.observedHypothesesSchema.safeParse(input).success,true);
  for(const mutate of [value=>{delete value.opposing.foe.statPoints.spe;},value=>{value.opposing.foe.statPoints.hp=33;},value=>{value.opposing.foe.unexpected=true;},value=>{value.field={weather:{id:'raindance',remainingTurns:5,unexpected:true}};},value=>{value.opposing.foe.abilitySuppressed=true;}]){const value=structuredClone(input);mutate(value);assert.equal(pure.observedHypothesesSchema.safeParse(value).success,false);}
  assert.equal(pure.positionSchema.safeParse({...position(),unexpected:true}).success,false);
  const nested=position();nested.sides[0].pokemon[0].volatiles={healblock:{remainingTurns:2,sourceId:'foe',unexpected:true}};assert.equal(pure.positionSchema.safeParse(nested).success,false);
});

test('defaults, XOR switch refinement, delivery goals and historical different limits remain unchanged',()=>{
  const input=hypotheses(),parsed=pure.observedHypothesesSchema.parse(input);assert.deepEqual(parsed.own,{});assert.equal(Object.hasOwn(input,'own'),false);
  assert.deepEqual(pure.branchSchema.parse(branch()).gate.requiredActionsBy,[]);
  const switched=branch();switched.ourActions[0]={type:'switch',slot:4};assert.equal(pure.branchSchema.safeParse(switched).success,true);
  for(const action of [{type:'switch'},{type:'switch',slot:4,pokemonId:'reserve'}]){const value=branch();value.ourActions[0]=action;assert.equal(pure.branchSchema.safeParse(value).success,false);}
  assert.equal(pure.deliveryObjectiveSchema.safeParse({requiredActionsBy:['actor'],field:{}}).success,false);
  assert.equal(pure.deliveryGateSchema.safeParse({kind:'delivery',requiredActionsBy:['actor'],survive:['reserve']}).success,true);
  const native=mon('actor');native.pp=[65,1,1,1];assert.equal(pure.pokemonSnapshotSchema.safeParse(native).success,true);
  const observed=hypotheses();observed.opposing.foe.pp=[65,1,1,1];assert.equal(pure.observedHypothesesSchema.safeParse(observed).success,false);
  const lifecycle={activeTurns:0,activeMoveActions:0,protectCounter:0,choiceLock:'x'.repeat(81),lastMove:false};
  assert.equal(pure.observedLifecycleSchema.safeParse(lifecycle).success,true);native.lifecycle=lifecycle;assert.equal(pure.pokemonSnapshotSchema.safeParse(native).success,false);
});

test('opening/current authoring schemas expose the same mode-specific restrictions as native reconstruction',()=>{
 const opening=hypotheses(),pristine=pure.observedHypothesesSchema.parse(opening);assert.equal(pristine.mode,'opening');assert.deepEqual(pristine.own,{});
 for(const key of ['field','sideConditions','sideMegaUsed']){const changed=hypotheses();changed[key]={};assert.equal(pure.observedHypothesesSchema.safeParse(changed).success,false,`${key} cannot override native opening entry effects`);}
 const own=hypotheses();own.own={actor:{label:'A current lifecycle override is not an opening input.'}};assert.equal(pure.observedHypothesesSchema.safeParse(own).success,false);
 const state={ability:'Named ability',item:'',status:'',boosts:{atk:0,def:0,spa:0,spd:0,spe:0,accuracy:0,evasion:0},pp:[1,1,1,1],lifecycle:{activeTurns:0,activeMoveActions:0,protectCounter:0,choiceLock:false,lastMove:false},volatiles:{},abilitySuppressed:false};
 for(const [key,value]of Object.entries(state)){
  const changed=hypotheses();changed.opposing.foe[key]=structuredClone(value);assert.equal(pure.observedHypothesesSchema.safeParse(changed).success,false,`opening opposing ${key}`);
  const reserve=hypotheses();reserve.reserves=[{...reserve.opposing.foe,id:'reserve',species:'Named species',[key]:structuredClone(value)}];assert.equal(pure.observedHypothesesSchema.safeParse(reserve).success,false,`opening reserve ${key}`);
 }
 for(const hp of ['observed-high',0,1]){const changed=hypotheses();changed.opposing.foe.hp=hp;assert.equal(pure.observedHypothesesSchema.safeParse(changed).success,false,'Opening HP must be explicitly full');}
 const current={...hypotheses(),mode:'current',own:{actor:{label:'Explicit current state.',pp:[1,1,1,1],lifecycle:state.lifecycle}},field:{weather:{id:'sandstorm',remainingTurns:2}},sideConditions:{p1:{reflect:{remainingTurns:2}}},sideMegaUsed:{p1:false,p2:true}};
 Object.assign(current.opposing.foe,state);current.reserves=[{...current.opposing.foe,id:'reserve',species:'Named species',hp:1}];
 assert.deepEqual(pure.observedHypothesesSchema.parse(current),current,'Current field, Mega and lifecycle hypotheses remain representable without rewriting');
});

test('request wrappers preserve case/branch/seed caps, evidence boundaries and intentional passthrough fields',()=>{
  const explicit={request:{kind:'explicit',...core()}};assert.equal(pure.simulationToolSchema.safeParse(explicit).success,true);
  const batch={request:{kind:'explicit',position:position(),hypotheses:core().hypotheses,cases:[{id:'one',branches:[branch()],seeds:[[1,2,3,4]]}]}};
  assert.equal(pure.simulationBatchToolSchema.safeParse(batch).success,true);
  const tooMany=structuredClone(batch);tooMany.request.cases=Array.from({length:4},(_,index)=>({...tooMany.request.cases[0],id:String(index)}));assert.equal(pure.simulationBatchToolSchema.safeParse(tooMany).success,false);
  for(const seeds of [[],[[1,2,3]],[[1,2,3,65536]],Array.from({length:4},()=>[1,2,3,4])])assert.equal(pure.simulationCoreSchema.safeParse({...core(),seeds}).success,false);
  assert.equal(pure.simulationCoreSchema.safeParse({...core(),branches:Array.from({length:4},branch)}).success,false);
  const observed={request:{kind:'observed',source:source(),hypotheses:hypotheses(),branches:[branch()],seeds:[[1,2,3,4]]}};
  assert.equal(pure.simulationToolSchema.safeParse(observed).success,true);
  assert.equal(pure.simulationToolSchema.safeParse({...observed,unknown:true}).success,false);
  const retained={...explicit,evidenceContext:{teamId:'a'.repeat(64),roomId:source().room,turn:1}};assert.equal(pure.simulationToolSchema.safeParse(retained).success,true);
  retained.evidenceContext.roomId+='-privatepw';assert.equal(pure.simulationToolSchema.safeParse(retained).success,false);
  assert.equal(pure.observedBindingSchema.safeParse({...source(),sessionId:undefined}).success,false,'Source binding itself does not accept sessionId');
  const {sessionId,...binding}=source(),sheet={species:'One',nature:'Two',ability:'Three',item:'',moves:['a','b','c','d'],futurePublishedField:'preserved'};
  const adapter={observed:{actions:[],boards:[],futureObservationField:'preserved'},teamText:'Named team',opposingSheet:Array.from({length:6},()=>({...sheet})),hypotheses:hypotheses(),expected:binding};
  const parsed=pure.observedPositionInputSchema.parse(adapter);assert.equal(parsed.observed.futureObservationField,'preserved');assert.equal(parsed.opposingSheet[0].futurePublishedField,'preserved');
});

test('a fresh pure-schema import resolves only Zod and reads no native data or workers',()=>{
  const url=new URL('./schemas.mjs',import.meta.url).href;
  const script=`
    import {registerHooks,syncBuiltinESMExports,createRequire} from 'node:module';
    import fs from 'node:fs';
    import workers from 'node:worker_threads';
    const target=process.argv[1],resolved=[],nativeReads=[];let workerCreations=0;
    const native=file=>/pokemon-showdown|[\\/]metrics[\\/]|[\\/]showdown[\\/]|[\\/]dist[\\/]|[\\/]simulation[\\/](?!schemas\\.mjs)/.test(String(file).replaceAll('\\\\','/'));
    const read=fs.readFileSync;fs.readFileSync=function(file,...args){if(native(file))nativeReads.push(String(file));return read.call(this,file,...args);};
    const readAsync=fs.promises.readFile;fs.promises.readFile=async function(file,...args){if(native(file))nativeReads.push(String(file));return readAsync.call(this,file,...args);};
    workers.Worker=class {constructor(){workerCreations++;throw new Error('Pure schemas cannot create workers');}};syncBuiltinESMExports();
    registerHooks({resolve(specifier,context,next){const result=next(specifier,context);resolved.push(result.url);if(result.url!==target&&!result.url.includes('/node_modules/zod/'))throw new Error('Unexpected schema dependency: '+result.url);return result;}});
    const schema=await import(target);schema.branchSchema.parse({id:'b',ourActions:[{type:'pass'},{type:'pass'}],opposingActions:[{type:'pass'},{type:'pass'}],gate:{targetId:'foe',beforeActionsOf:['foe']}});
    const nativeCache=Object.keys(createRequire(import.meta.url).cache).filter(file=>/pokemon-showdown|[\\/]metrics[\\/]|[\\/]showdown[\\/]/.test(file));
    console.log(JSON.stringify({resolved,nativeReads,workerCreations,nativeCache}));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','--eval',script,url],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||result.error?.message);const trace=JSON.parse(result.stdout.trim());
  assert(trace.resolved.includes(url));assert(trace.resolved.every(item=>item===url||item.includes('/node_modules/zod/')));assert.deepEqual(trace.nativeReads,[]);assert.deepEqual(trace.nativeCache,[]);assert.equal(trace.workerCreations,0);
});
