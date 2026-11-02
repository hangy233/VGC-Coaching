// Pure prompt encoding. Only the two explicitly archived history arrays may lose
// oldest entries; current evidence, choices and unknown fields are never pruned.
import {isDeepStrictEqual} from 'node:util';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';

const KIND='lossless-columnar-context',VERSION=1;
const DECODE='Restore operations in reverse order at their original paths. Rows inherit defaults; columns name ordered cells; absent=[row,column] omits a property; dictionaries map column indexes to ordered values. Missing, null, false and unknown remain distinct. No rows or choices are ranked.';
const INPUT_NODES=Math.floor(MAX_CONTEXT_BYTES/2)+1024;
const LIMITS=Object.freeze({depth:40,nodes:INPUT_NODES,text:MAX_CONTEXT_BYTES,array:INPUT_NODES,rows:2048,columns:256,operations:256,evaluations:4096,pathBytes:2048,workNodes:INPUT_NODES});
const UNSAFE=new Set(['__proto__','prototype','constructor']);
const READABLE=new Set(['legalOptions','referenceMenu','referenceMenus','optionRefs','matchupSkill']);
const HISTORY=[
  {path:['strategicMemory','claims','lastGameAdaptations'],limit:3,reason:'old agent claims'},
  {path:['strategicMemory','facts','recentEvents'],limit:8,reason:'archived raw events'},
];
const own=(value,key)=>Object.hasOwn(value,key);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const set=(value,key,data)=>Object.defineProperty(value,key,{value:data,enumerable:true,writable:true,configurable:true});
const byteLength=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const check=(condition,message)=>{if(!condition){const error=new Error(message);error.code='ISOLATED_CONTEXT_ENCODING_INVALID';throw error;}};
const same=(left,right)=>isDeepStrictEqual(left,right);

// Inspect descriptors rather than invoking input getters/toJSON. The work and
// expansion budgets also apply to hostile decode input and repeated defaults.
function cloneJson(value,budget={nodes:0,text:0},depth=0,ancestors=new Set()) {
  check(++budget.nodes<=(budget.maxNodes??LIMITS.nodes)&&depth<=LIMITS.depth,'Context traversal bound exceeded');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string'){budget.text+=Buffer.byteLength(value,'utf8');check(budget.text<=LIMITS.text,'Context text exceeds the explicit8MiB input bound');return value;}
  if(typeof value==='number'){check(Number.isFinite(value)&&!Object.is(value,-0),'Context contains a non-JSON number');return value;}
  check(record(value)||Array.isArray(value),'Context contains a non-JSON value');
  check(!ancestors.has(value),'Context contains a cycle');ancestors.add(value);
  const keys=Reflect.ownKeys(value),array=Array.isArray(value);
  check(!array||value.length<=LIMITS.array,'Context array bound exceeded');
  check(keys.every(key=>typeof key==='string'),'Context contains symbol fields');
  const result=array?[]:{};
  if(array)check(keys.length===value.length+1&&keys.at(-1)==='length'&&keys.slice(0,-1).every((key,index)=>key===String(index)),'Context contains sparse or extended arrays');
  for(const key of keys){
    if(array&&key==='length')continue;
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    check(descriptor?.enumerable&&own(descriptor,'value'),'Context contains non-data fields');
    budget.text+=Buffer.byteLength(key,'utf8');check(budget.text<=LIMITS.text,'Context text exceeds the explicit8MiB input bound');
    set(result,key,cloneJson(descriptor.value,budget,depth+1,ancestors));
  }
  ancestors.delete(value);return result;
}

function safePath(path) {
  return Array.isArray(path)&&path.length>0&&path.length<=LIMITS.depth&&byteLength(path)<=LIMITS.pathBytes&&path.every(part=>typeof part==='string'?!UNSAFE.has(part):Number.isSafeInteger(part)&&part>=0&&part<LIMITS.array)&&path[0]!=='contextEncoding';
}
function atPath(root,path) {
  let value=root;
  for(const part of path){
    check(Array.isArray(value)?Number.isSafeInteger(part)&&part>=0&&part<value.length:record(value)&&typeof part==='string','Invalid context encoding path container');
    check(own(value,part),'Missing context encoding path');value=value[part];
  }
  return value;
}
const exactKeys=(value,allowed,required=allowed)=>record(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>own(value,key));

function restoreTable(table,budget) {
  check(exactKeys(table,['defaults','columns','rows','absent','dictionaries'],['defaults','columns','rows']),'Invalid context table fields');
  check(record(table.defaults)&&Array.isArray(table.columns)&&table.columns.length<=LIMITS.columns&&table.columns.every(key=>typeof key==='string')&&new Set(table.columns).size===table.columns.length,'Invalid context table columns');
  check(table.columns.every(key=>!own(table.defaults,key))&&Array.isArray(table.rows)&&table.rows.length>0&&table.rows.length<=LIMITS.rows,'Invalid context table defaults or rows');
  const absent=new Set();
  check(!own(table,'absent')||Array.isArray(table.absent),'Invalid absent context cells');
  for(const coordinate of table.absent??[]){
    check(Array.isArray(coordinate)&&coordinate.length===2&&Number.isSafeInteger(coordinate[0])&&Number.isSafeInteger(coordinate[1])&&coordinate[0]>=0&&coordinate[0]<table.rows.length&&coordinate[1]>=0&&coordinate[1]<table.columns.length,'Invalid absent context coordinate');
    const id=`${coordinate[0]}:${coordinate[1]}`;check(!absent.has(id),'Duplicate absent context coordinate');absent.add(id);
  }
  check(!own(table,'dictionaries')||record(table.dictionaries),'Invalid context dictionaries');
  for(const [column,values]of Object.entries(table.dictionaries??{}))check(/^(?:0|[1-9][0-9]*)$/u.test(column)&&Number(column)<table.columns.length&&Array.isArray(values)&&values.length>0,'Invalid context dictionary column');
  return table.rows.map((cells,rowIndex)=>{
    check(Array.isArray(cells)&&cells.length===table.columns.length,'Invalid context table row');
    const row=cloneJson(table.defaults,budget);
    for(const [columnIndex,key]of table.columns.entries()){
      if(absent.has(`${rowIndex}:${columnIndex}`)){check(cells[columnIndex]===null,'Absent context cell must use a null placeholder');continue;}
      let value=cells[columnIndex];
      if(own(table.dictionaries??{},columnIndex)){
        const dictionary=table.dictionaries[columnIndex];check(Number.isSafeInteger(value)&&value>=0&&value<dictionary.length,'Invalid context dictionary index');value=dictionary[value];
      }
      set(row,key,cloneJson(value,budget));
    }
    return row;
  });
}

/** Decode only manifest-declared paths, never marker-shaped ordinary data. */
export function restoreContextPayload(encoded) {
  const result=cloneJson(encoded);
  if(!record(result)||!record(result.contextEncoding)||result.contextEncoding.kind!==KIND)return result;
  const manifest=result.contextEncoding;
  check(exactKeys(manifest,['kind','version','decode','operations','originalContextEncoding'],['kind','version','decode','operations'])&&manifest.version===VERSION&&manifest.decode===DECODE,'Unsupported context encoding manifest');
  check(Array.isArray(manifest.operations)&&manifest.operations.length>0&&manifest.operations.length<=LIMITS.operations,'Invalid context encoding operations');
  const seen=new Set(),paths=[];
  for(const path of manifest.operations){
    check(safePath(path),'Unsafe context encoding path');
    const id=JSON.stringify(path);check(!seen.has(id),'Duplicate context encoding path');seen.add(id);
    // A child is encoded before its parent, and is therefore restored later.
    check(!paths.some(previous=>previous.length<path.length&&previous.every((part,index)=>part===path[index])),'Context encoding operation order is invalid');paths.push(path);
  }
  delete result.contextEncoding;
  const budget={nodes:0,text:0,maxNodes:LIMITS.workNodes};
  for(const path of [...paths].reverse()){
    const parent=path.length===1?result:atPath(result,path.slice(0,-1)),key=path.at(-1);
    check(Array.isArray(parent)?Number.isSafeInteger(key)&&key>=0&&key<parent.length:record(parent)&&typeof key==='string','Invalid context encoding parent');
    check(own(parent,key),'Missing context encoding table');set(parent,key,restoreTable(parent[key],budget));
  }
  if(own(manifest,'originalContextEncoding'))set(result,'contextEncoding',manifest.originalContextEncoding);
  return cloneJson(result);
}

function columnar(rows,work) {
  if(!rows.length||rows.length>LIMITS.rows||!rows.every(record))return null;
  const keys=[...new Set(rows.flatMap(row=>Object.keys(row)))];
  if(keys.length>LIMITS.columns)return null;
  const defaults={},columns=[],absent=[];
  for(const key of keys){
    if(rows.every(row=>own(row,key)&&same(row[key],rows[0][key])))set(defaults,key,rows[0][key]);else columns.push(key);
  }
  const cells=rows.map((row,rowIndex)=>columns.map((key,columnIndex)=>{
    if(own(row,key))return row[key];absent.push([rowIndex,columnIndex]);return null;
  }));
  let table={defaults,columns,rows:cells,...(absent.length?{absent}:{})};
  for(let columnIndex=0;columnIndex<columns.length&&work.evaluations<LIMITS.evaluations;columnIndex++){
    work.evaluations++;
    const values=[],indexes=new Map();
    const mapped=cells.map((row,rowIndex)=>{
      if(!own(rows[rowIndex],columns[columnIndex]))return null;
      const serialized=JSON.stringify(row[columnIndex]);
      if(!indexes.has(serialized)){indexes.set(serialized,values.length);values.push(row[columnIndex]);}
      return indexes.get(serialized);
    });
    if(values.length>=rows.length||!values.length)continue;
    const candidate={...table,dictionaries:{...table.dictionaries,[columnIndex]:values},rows:table.rows.map((row,index)=>row.map((cell,column)=>column===columnIndex?mapped[index]:cell))};
    if(byteLength(candidate)<byteLength(table))table=candidate;
  }
  return table;
}

function encodeLosslessly(source) {
  const result=cloneJson(source),operations=[],work={evaluations:0};
  function visit(value,path,readable=false) {
    if(readable||path.some(part=>typeof part==='string'&&UNSAFE.has(part))||path[0]==='contextEncoding')return value;
    if(Array.isArray(value)){
      for(let index=0;index<value.length;index++)value[index]=visit(value[index],[...path,index]);
      if(operations.length>=LIMITS.operations||work.evaluations>=LIMITS.evaluations||!safePath(path))return value;
      work.evaluations++;const table=columnar(value,work);
      if(table&&byteLength(table)+byteLength(path)+1<byteLength(value)){operations.push(path);return table;}
    }else if(record(value))for(const key of Object.keys(value))set(value,key,visit(value[key],[...path,key],READABLE.has(key)));
    return value;
  }
  visit(result,[]);
  if(!operations.length)return {payload:result,operations:0,evaluations:work.evaluations,adopted:false,reason:'no-smaller-tables'};
  const manifest={kind:KIND,version:VERSION,decode:DECODE,operations,...(own(source,'contextEncoding')?{originalContextEncoding:result.contextEncoding}:{})};
  set(result,'contextEncoding',manifest);
  if(byteLength(result)>=byteLength(source))return {payload:cloneJson(source),operations:0,evaluations:work.evaluations,adopted:false,reason:'manifest-not-smaller'};
  check(same(restoreContextPayload(result),source),'Lossless context roundtrip failed');
  return {payload:result,operations:operations.length,evaluations:work.evaluations,adopted:true,reason:'smaller-and-roundtrip-verified'};
}

function metadataFor({originalPayloadBytes,finalPayloadBytes,options,stages,omittedHistory,reason,verified=true}) {
  const overhead=options.instructionBytes+options.schemaBytes,originalBytes=originalPayloadBytes===null?null:originalPayloadBytes+overhead,finalBytes=finalPayloadBytes===null?null:finalPayloadBytes+overhead;
  return {version:1,encodingVersion:VERSION,originalBytes,finalBytes,originalPayloadBytes,finalPayloadBytes,instructionBytes:options.instructionBytes,schemaBytes:options.schemaBytes,
    maxBytes:options.maxBytes,targetBytes:options.targetBytes,softCapBytes:options.targetBytes,hardCapBytes:options.maxBytes,targetExceeded:finalBytes===null||finalBytes>options.targetBytes,hardCapExceeded:finalBytes===null||finalBytes>options.maxBytes,
    compactionStages:stages,omittedHistory,lossless:omittedHistory.length===0,losslessRoundtripVerified:verified,...(reason?{reason}:{})};
}

/** Deterministic bounded encoding, followed only when necessary by archive trim. */
export function compactContextPayload(payload,{maxBytes=MAX_CONTEXT_BYTES,targetBytes=24000,instructionBytes=0,schemaBytes=0}={}) {
  const options={maxBytes,targetBytes,instructionBytes,schemaBytes};
  for(const [key,value]of Object.entries(options))if(!Number.isSafeInteger(value)||value<0)throw new TypeError(`${key} must be a nonnegative safe integer`);
  if(!Number.isSafeInteger(instructionBytes+schemaBytes))throw new TypeError('Context overhead exceeds the safe integer range');
  let source,originalPayloadBytes;
  try{
    source=cloneJson(payload);check(record(source),'Context payload must be an object');
    check(!record(source.contextEncoding)||source.contextEncoding.kind!==KIND,'Reserved contextEncoding input must be restored before compaction');
    originalPayloadBytes=byteLength(source);
  }catch(error){
    return {payload,metadata:metadataFor({originalPayloadBytes:null,finalPayloadBytes:null,options,stages:[],omittedHistory:[],reason:error.message,verified:false}),fits:false};
  }
  const overhead=instructionBytes+schemaBytes,stages=[],omittedHistory=[];
  let projected=source;
  function recompact(label) {
    const beforeBytes=byteLength(source)+overhead;
    try{
      const encoded=encodeLosslessly(source);projected=encoded.payload;
      stages.push({stage:label,beforeBytes,afterBytes:byteLength(projected)+overhead,adopted:encoded.adopted,operations:encoded.operations,evaluations:encoded.evaluations,reason:encoded.reason});
    }catch(error){projected=cloneJson(source);stages.push({stage:label,beforeBytes,afterBytes:beforeBytes,adopted:false,operations:0,reason:error.message});}
  }
  if(originalPayloadBytes+overhead>Math.min(targetBytes,maxBytes))recompact('lossless');
  let coverageKey=null,pruneBlocked=null;
  function disclose() {
    if(!own(source,'contextCoverage'))set(source,'contextCoverage',{});
    if(!record(source.contextCoverage)){pruneBlocked='Existing contextCoverage is not an object; protected value prevents archive disclosure';return false;}
    if(coverageKey===null){
      coverageKey='boundedContextCompaction';let suffix=0;
      while(own(source.contextCoverage,coverageKey)&&suffix<16)coverageKey=`boundedContextCompaction${++suffix}`;
      if(own(source.contextCoverage,coverageKey)){pruneBlocked='Protected contextCoverage fields prevent bounded archive disclosure';return false;}
    }
    set(source.contextCoverage,coverageKey,{version:VERSION,omittedHistory:omittedHistory.map(row=>({...row})),historyCoverage:'Partial archived history. Missing history is unknown coverage, never negative evidence. Current top-level events and protected facts are retained.'});
    return true;
  }
  for(const history of HISTORY){
    for(let removed=0;removed<history.limit&&byteLength(projected)+overhead>maxBytes;removed++){
      let rows;try{rows=atPath(source,history.path);}catch{break;}
      if(!Array.isArray(rows)||!rows.length)break;
      // Check disclosure before removing anything, preserving non-object or
      // unexpectedly occupied coverage fields rather than overwriting facts.
      if(!disclose())break;
      rows.shift();const path=history.path.join('.'),entry=omittedHistory.find(row=>row.path===path);
      if(entry)entry.count++;else omittedHistory.push({path,count:1,order:'oldest-first',reason:history.reason});
      disclose();recompact(`archive-prune-${omittedHistory.reduce((sum,row)=>sum+row.count,0)}`);
    }
    if(pruneBlocked||byteLength(projected)+overhead<=maxBytes)break;
  }
  const finalPayloadBytes=byteLength(projected),fits=finalPayloadBytes+overhead<=maxBytes;
  const metadata=metadataFor({originalPayloadBytes,finalPayloadBytes,options,stages,omittedHistory,reason:fits?undefined:pruneBlocked??'Protected context still exceeds the hard byte limit'});
  return {payload:projected,metadata,fits};
}
