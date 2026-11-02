import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {packCalculationPayload,unpackCalculationPayload,CALCULATION_ARCHIVE_RAW_LIMIT,CALCULATION_PAYLOAD_LIMIT} from './calculation-archive.mjs';

const clone=value=>structuredClone(value),tool='simulate_choices';
const large=()=>({input:{assembly:{history:Array.from({length:4000},(_,i)=>({id:i,known:'actual owned fixture',sourceSha256:'a'.repeat(64),life:{activeTurns:3,activeMoveActions:2,choiceLock:false,lastMove:'Protect'}}))}},result:{events:[{type:'move',raw:'|move|p2a: Foe|Protect|p2a: Foe'}],description:'Verbatim raw MCP text\nwith Unicode: Ω and Pokémon.'}});

test('small payloads and other tool contracts keep their original plain representation',()=>{
  const input={x:1},result={y:'unchanged'};
  assert.deepEqual(packCalculationPayload({tool,input,result}),{input,result});
  for(const name of ['calculate_damage','calculate_speed','simulate_turn','simulate_turn_batch']){const value=large();assert.deepEqual(packCalculationPayload({tool:name,...value}),value);}
});

test('large compact simulation payload is lossless, deterministic and fits the unchanged stored budget',t=>{
  const original=large(),before=clone(original),packed=packCalculationPayload({tool,...original});
  assert(packed.payloadArchive);assert(!Object.hasOwn(packed,'input'));assert(!Object.hasOwn(packed,'result'));
  assert(Buffer.byteLength(JSON.stringify(packed))<CALCULATION_PAYLOAD_LIMIT);assert.equal(packed.payloadArchive.rawBytes,Buffer.byteLength(JSON.stringify(original)));
  assert.deepEqual(unpackCalculationPayload({tool,...packed}),original);assert.deepEqual(original,before);assert.deepEqual(packCalculationPayload({tool,...original}),packed);
  t.diagnostic(`Lossless archive fixture: ${packed.payloadArchive.rawBytes} raw bytes; ${Buffer.byteLength(JSON.stringify(packed))} stored bytes.`);
});

test('large ranged-damage evaluations keep every private native result under the same lossless archive bounds',()=>{
  const original=large(),packed=packCalculationPayload({tool:'calculate_damage_range',...original});
  assert(packed.payloadArchive);assert.equal(packed.payloadArchive.tool,'calculate_damage_range');
  assert.deepEqual(unpackCalculationPayload({tool:'calculate_damage_range',...packed}),original);
  assert.throws(()=>unpackCalculationPayload({tool:'simulate_choices',...packed}),/identity/u);
});

test('archive corruption, changed identity, mixed payloads and invalid base64 are refused',()=>{
  const packed=packCalculationPayload({tool,...large()});
  for(const mutate of [a=>a.sha256='f'.repeat(64),a=>a.rawBytes--,a=>a.tool='calculate_speed',a=>a.encoding='unknown',a=>a.extra=true,a=>a.data=a.data.slice(1),a=>a.data+='\n']){const changed=clone(packed);mutate(changed.payloadArchive);assert.throws(()=>unpackCalculationPayload({tool,...changed}),/Calculation archive/u);}
  assert.throws(()=>unpackCalculationPayload({tool:'simulate_turn',...packed}),/only for simulate_choices/u);
  assert.throws(()=>unpackCalculationPayload({tool,...packed,input:{}}),/duplicate/u);
});

test('expanded output is capped at 8 MiB and incompressible payloads retain the stored cap',()=>{
  assert.throws(()=>packCalculationPayload({tool,input:{large:'x'.repeat(CALCULATION_ARCHIVE_RAW_LIMIT)},result:{}}),/8 MiB/u);
  assert.throws(()=>packCalculationPayload({tool,input:{large:randomBytes(600*1024).toString('base64')},result:{}}),/existing file budget/u);
  const data=gzipSync(Buffer.from('x'.repeat(CALCULATION_ARCHIVE_RAW_LIMIT+1))).toString('base64');
  assert.throws(()=>unpackCalculationPayload({tool,payloadArchive:{schemaVersion:1,encoding:'gzip-base64-json-v1',tool,sha256:'a'.repeat(64),rawBytes:CALCULATION_ARCHIVE_RAW_LIMIT,data}}),/over-limit/u);
});

test('valid gzip is insufficient without canonical exact input/result JSON',()=>{
  const raw=Buffer.from(JSON.stringify({input:{text:'x'.repeat(CALCULATION_PAYLOAD_LIMIT)},result:{},extra:'not allowed'}));
  const payloadArchive={schemaVersion:1,encoding:'gzip-base64-json-v1',tool,sha256:createHash('sha256').update(raw).digest('hex'),rawBytes:raw.length,data:gzipSync(raw).toString('base64')};
  assert.throws(()=>unpackCalculationPayload({tool,payloadArchive}),/exact input\/result/u);
});

test('private payload traversal rejects getters and proxies without invoking them',()=>{
  let invoked=0;const input={};Object.defineProperty(input,'x',{enumerable:true,get(){invoked++;throw Error('getter');}});
  assert.throws(()=>packCalculationPayload({tool,input,result:{}}),/data-only/u);
  assert.throws(()=>packCalculationPayload({tool,input:new Proxy({},{ownKeys(){invoked++;throw Error('proxy');}}),result:{}}),/ordinary finite/u);assert.equal(invoked,0);
});
