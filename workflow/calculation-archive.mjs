// Lossless private calculation retention. Numerical evidence is never shortened
// or converted into a new conclusion; only large compact-simulation/range payloads
// receive a bounded encoding within the ordinary calculation file limit.
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {types} from 'node:util';

export const CALCULATION_ARCHIVE_RAW_LIMIT=8*1024*1024;
export const CALCULATION_PAYLOAD_LIMIT=508*1024;
const TOOLS=new Set(['calculate_damage','calculate_damage_range','calculate_speed','simulate_turn','simulate_turn_batch','simulate_choices']);
const HASH=/^[a-f0-9]{64}$/u,BASE64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const check=(ok,message)=>{if(!ok)throw Error(`Calculation archive: ${message}`);};
const sha=value=>createHash('sha256').update(value).digest('hex');

// Match retained JSON's omission of optional undefined object properties while
// rejecting accessors/proxies and non-JSON values before invoking them. Keys are
// sorted only for stable archive bytes; string contents remain exact.
function canonicalPayload(value){
  const seen=new Set();let nodes=0,bytes=0;
  const charge=text=>{bytes+=Buffer.byteLength(text);check(bytes<=CALCULATION_ARCHIVE_RAW_LIMIT,'uncompressed payload exceeds 8 MiB');return text;};
  function visit(v,depth){
    check(++nodes<=500000&&depth<=64,'payload traversal limit');
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||typeof v==='string')return charge(JSON.stringify(v));
    check(v&&typeof v==='object'&&!types.isProxy(v),'ordinary finite JSON payload required');
    const array=Array.isArray(v),proto=Object.getPrototypeOf(v);check(array||proto===Object.prototype||proto===null,'plain JSON payload required');
    check(!seen.has(v),'cyclic payload');seen.add(v);
    const keys=Reflect.ownKeys(v).filter(k=>!(array&&k==='length'));check(!array||keys.length===v.length,'dense payload arrays required');
    const rows=[];charge(array?'[]':'{}');
    for(const [index,k]of (array?keys:[...keys].sort((a,b)=>String(a).localeCompare(String(b)))).entries()){
      check(typeof k==='string'&&(!array||k===String(index)),'ordinary JSON payload keys required');
      const descriptor=Object.getOwnPropertyDescriptor(v,k);check(descriptor.enumerable&&Object.hasOwn(descriptor,'value'),'data-only payload required');
      if(!array&&descriptor.value===undefined)continue;
      if(rows.length)charge(',');
      const prefix=array?'':charge(JSON.stringify(k)+':');rows.push(prefix+visit(descriptor.value,depth+1));
    }
    seen.delete(v);return (array?'[':'{')+rows.join(',')+(array?']':'}');
  }
  return Buffer.from(visit(value,0),'utf8');
}

export function packCalculationPayload({tool,input,result}={}){
  check(TOOLS.has(tool),'unsupported tool');
  // Existing scalar/explicit-turn contracts retain their plain representation.
  if(!['simulate_choices','calculate_damage_range'].includes(tool))return {input,result};
  const raw=canonicalPayload({input,result});
  if(raw.length<=CALCULATION_PAYLOAD_LIMIT)return {input,result};
  const payloadArchive={schemaVersion:1,encoding:'gzip-base64-json-v1',tool,sha256:sha(raw),rawBytes:raw.length,data:gzipSync(raw,{level:9}).toString('base64')};
  const packed={payloadArchive};
  check(Buffer.byteLength(JSON.stringify(packed))<=CALCULATION_PAYLOAD_LIMIT,'compressed payload exceeds existing file budget');
  return packed;
}

export function unpackCalculationPayload({tool,input,result,payloadArchive,...rest}={}){
  check(TOOLS.has(tool),'unsupported tool');
  if(payloadArchive===undefined)return {input,result};
  check(['simulate_choices','calculate_damage_range'].includes(tool),'encoded payload is allowed only for simulate_choices or calculate_damage_range');
  check(input===undefined&&result===undefined,'archive cannot duplicate a plain payload');
  check(!Object.keys(rest).length,'archive decoder accepts only payload fields');
  const a=payloadArchive;
  check(a&&typeof a==='object'&&!Array.isArray(a)&&!types.isProxy(a)&&[Object.prototype,null].includes(Object.getPrototypeOf(a)),'plain archive required');
  const keys=Reflect.ownKeys(a);
  const allowed=['schemaVersion','encoding','tool','sha256','rawBytes','data'];
  check(keys.length===allowed.length&&keys.every(k=>allowed.includes(k)&&Object.getOwnPropertyDescriptor(a,k)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(a,k),'value')),'exact archive fields required');
  check(a.schemaVersion===1&&a.encoding==='gzip-base64-json-v1'&&a.tool===tool&&HASH.test(a.sha256),'archive identity differs');
  check(Number.isSafeInteger(a.rawBytes)&&a.rawBytes>CALCULATION_PAYLOAD_LIMIT&&a.rawBytes<=CALCULATION_ARCHIVE_RAW_LIMIT,'uncompressed byte bound differs');
  check(typeof a.data==='string'&&a.data.length<=CALCULATION_PAYLOAD_LIMIT&&a.data.length>0&&BASE64.test(a.data),'bounded canonical base64 required');
  check(Buffer.byteLength(JSON.stringify({payloadArchive:a}))<=CALCULATION_PAYLOAD_LIMIT,'compressed payload exceeds existing file budget');
  const compressed=Buffer.from(a.data,'base64');check(compressed.toString('base64')===a.data,'canonical base64 required');
  let raw;try{raw=gunzipSync(compressed,{maxOutputLength:CALCULATION_ARCHIVE_RAW_LIMIT});}catch{throw Error('Calculation archive: invalid or over-limit compressed payload');}
  check(raw.length===a.rawBytes&&sha(raw)===a.sha256,'uncompressed digest/byte count differs');
  let value;try{value=JSON.parse(raw.toString('utf8'));}catch{throw Error('Calculation archive: invalid JSON payload');}
  check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===2&&Object.hasOwn(value,'input')&&Object.hasOwn(value,'result'),'exact input/result payload required');
  check(canonicalPayload(value).equals(raw),'canonical JSON payload differs');
  return value;
}
